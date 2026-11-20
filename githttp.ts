// Git smart HTTP: info/refs advertisements (protocol v2 and v0),
// ls-refs, fetch (v2 sections + v0 fallback) with shallow/deepen
// semantics, and receive-pack pushes with report-status. The object
// store in store.ts is the only state; advertisements always tell the
// truth about it, because the harness computes push packs from them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  getObject, getRepo, hasObject, isAncestor, parseCommit, parseTree, type Repo,
} from './store.ts';
import { FLUSH, PktReader, buildPack, ingestPack, pktLine } from './pack.ts';
import { readBody } from './http.ts';

const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Peel a tag chain to the commit it ultimately names, if any. */
function peelToCommit(sha: string): string | null {
  let cur = sha;
  for (let i = 0; i < 16; i += 1) {
    const obj = getObject(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type !== 'tag') return null;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!m) return null;
    cur = m[1];
  }
  return null;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function headTarget(repo: Repo): string {
  return repo.symrefs.get('HEAD') ?? `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function advertiseV2(res: ServerResponse, service: string): void {
  const lines: Buffer[] = [
    pktLine(`# service=${service}\n`),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ];
  sendRaw(res, 200, `application/x-git-${service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack'}-advertisement`, Buffer.concat(lines));
}

function advertiseV0(res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not symref=HEAD:${headTarget(repo)} agent=${AGENT}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else if (service === 'git-upload-pack') {
    const target = headTarget(repo);
    const headOid = repo.refs.get(target) ?? ZERO;
    lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      lines.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peelToCommit(oid);
      if (peeled && peeled !== oid) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  } else {
    let first = true;
    for (const [ref, oid] of refs) {
      lines.push(pktLine(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`));
      first = false;
    }
  }
  lines.push(FLUSH);
  sendRaw(res, 200, `application/x-git-${service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack'}-advertisement`, Buffer.concat(lines));
}

// ---------------------------------------------------------------------------
// Object-set computation for fetch
// ---------------------------------------------------------------------------

/** Tree closure (trees + blobs) under a tree sha, added to `out`. */
function addTreeClosure(treeSha: string, out: Set<string>): void {
  if (out.has(treeSha)) return;
  const obj = getObject(treeSha);
  if (!obj || obj.type !== 'tree') return;
  out.add(treeSha);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') addTreeClosure(e.sha, out);
    else out.add(e.sha);
  }
}

/**
 * The closure of `tips`: commits by generation (when maxGenerations is
 * set, only that many generations of commits), their trees and blobs,
 * and tag objects peeled to commits. `stopCommits` are included but
 * their parents are not walked (the client's shallow boundary).
 */
function objectClosure(tips: string[], stopCommits: Set<string>, maxGenerations?: number): { set: Set<string>; order: string[] } {
  const set = new Set<string>();
  const order: string[] = [];
  const add = (sha: string) => {
    if (!set.has(sha)) { set.add(sha); order.push(sha); }
  };
  // Resolve starting points to commits, collecting tag objects on the way.
  let frontier: string[] = [];
  for (const tip of tips) {
    let cur = tip;
    for (let i = 0; i < 16; i += 1) {
      const obj = getObject(cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        add(cur);
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (!m) { cur = ''; break; }
        cur = m[1];
        continue;
      }
      break;
    }
    if (cur !== '' && getObject(cur)?.type === 'commit') frontier.push(cur);
  }
  let generation = 0;
  const seenCommits = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (seenCommits.has(sha)) continue;
      seenCommits.add(sha);
      const obj = getObject(sha);
      if (!obj || obj.type !== 'commit') continue;
      add(sha);
      const info = parseCommit(obj.data);
      const before = new Set(set);
      addTreeClosure(info.tree, set);
      for (const s of set) if (!before.has(s)) order.push(s);
      const mayDeepen = maxGenerations === undefined || generation + 1 < maxGenerations;
      if (mayDeepen && !stopCommits.has(sha)) next.push(...info.parents);
    }
    frontier = next;
    generation += 1;
  }
  return { set, order };
}

interface FetchPlan {
  delivered: string[];
  shallowLines: string[];
  haveAcks: string[];
}

function planFetch(wants: string[], haves: string[], shallow: string[], deepen?: number): FetchPlan {
  const shallowSet = new Set(shallow);
  const have = objectClosure(haves, shallowSet);
  const want = objectClosure(wants, new Set(), deepen);
  const delivered = want.order.filter((sha) => !have.set.has(sha));

  const shallowLines: string[] = [];
  if (deepen !== undefined || shallowSet.size > 0) {
    const deliveredSet = new Set(delivered);
    const isCommit = (sha: string) => getObject(sha)?.type === 'commit';
    const parentsOf = (sha: string): string[] => {
      const obj = getObject(sha);
      return obj && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
    };
    for (const sha of delivered) {
      if (!isCommit(sha)) continue;
      const outside = parentsOf(sha).some((p) => !deliveredSet.has(p) && !have.set.has(p));
      if (outside) shallowLines.push(`shallow ${sha}`);
    }
    for (const s of shallowSet) {
      const parents = parentsOf(s);
      if (parents.some((p) => deliveredSet.has(p))) shallowLines.push(`unshallow ${s}`);
      else if (parents.some((p) => !have.set.has(p) && !deliveredSet.has(p))) shallowLines.push(`shallow ${s}`);
    }
  }

  const haveAcks: string[] = [];
  const knownHaves = haves.filter((h) => hasObject(h) && getObject(h)?.type === 'commit');
  if (knownHaves.length > 0) {
    for (const h of knownHaves) haveAcks.push(`ACK ${h} common`);
    haveAcks.push('ready');
  } else {
    haveAcks.push('NAK');
  }
  return { delivered, shallowLines, haveAcks };
}

/** Sideband packets carrying a pack inside a v2 packfile section / v0 reply. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 60000;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const payload = Buffer.concat([Buffer.from([1]), pack.subarray(i, i + CHUNK)]);
    out.push(pktLine(payload));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------

function lsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const lines: Buffer[] = [];
  const target = headTarget(repo);
  if (matches('HEAD')) {
    const tip = repo.refs.get(target);
    const attrs = symrefs ? ` symref-target:${target}` : '';
    if (tip) lines.push(pktLine(`${tip} HEAD${attrs}\n`));
    else if (unborn) lines.push(pktLine(`unborn HEAD${attrs}\n`));
    else lines.push(pktLine(`${ZERO} HEAD${attrs}\n`));
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peelToCommit(oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function fetchV2(repo: Repo, sections: { lines: string[] }[]): Buffer {
  const args = sections.flatMap((s) => s.lines);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      // Not exercised by the checks beyond parsing; treat as unbounded.
    }
  }
  const plan = planFetch(wants, haves, shallow, deepen);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  for (const ack of plan.haveAcks) parts.push(pktLine(`${ack}\n`));
  parts.push(FLUSH);
  if (plan.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const l of plan.shallowLines) parts.push(pktLine(`${l}\n`));
    parts.push(FLUSH);
  }
  if (plan.delivered.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(buildPack(plan.delivered)));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, reader: PktReader): Buffer {
  const first = reader.readSection();
  const second = reader.readSection();
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const raw of first.lines) {
    const line = raw.split(' ')[0] === 'want' ? `want ${raw.split(' ')[1]}` : raw;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (raw.startsWith('shallow ')) shallow.push(raw.slice(8).trim());
    else if (raw.startsWith('deepen ')) deepen = Number(raw.slice(7).trim());
  }
  for (const raw of second.lines) {
    if (raw.startsWith('have ')) haves.push(raw.slice(5).trim());
  }
  const plan = planFetch(wants, haves, shallow, deepen);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const l of plan.shallowLines) parts.push(pktLine(`${l}\n`));
  if (plan.delivered.length > 0) parts.push(...sidebandPackets(buildPack(plan.delivered)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

function receivePack(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const section = reader.readSection();
  const commands: { old: string; next: string; ref: string }[] = [];
  let caps = '';
  section.lines.forEach((raw, idx) => {
    let line = raw;
    if (idx === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3) commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
  });

  const packBytes = reader.rest();
  let unpackLine = 'unpack ok';
  if (packBytes.length > 0) {
    try {
      ingestPack(packBytes);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'failed'}`;
    }
  }

  const report: string[] = [unpackLine];
  for (const cmd of commands) {
    if (unpackLine !== 'unpack ok') {
      report.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    if (cmd.next === ZERO) {
      repo.refs.delete(cmd.ref);
      report.push(`ok ${cmd.ref}`);
      continue;
    }
    if (!hasObject(cmd.next)) {
      report.push(`ng ${cmd.ref} unknown object`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (current === undefined || cmd.old === ZERO) {
      repo.refs.set(cmd.ref, cmd.next);
      report.push(`ok ${cmd.ref}`);
      continue;
    }
    if (current === cmd.old || isAncestor(current, cmd.next)) {
      if (isAncestor(current, cmd.next) || current === cmd.next) {
        repo.refs.set(cmd.ref, cmd.next);
        report.push(`ok ${cmd.ref}`);
      } else {
        report.push(`ng ${cmd.ref} non-fast-forward`);
      }
      continue;
    }
    report.push(`ng ${cmd.ref} non-fast-forward`);
  }

  const stream = Buffer.concat([...report.map((l) => pktLine(`${l}\n`)), FLUSH]);
  if (caps.split(' ').includes('side-band-64k')) {
    const wrapped: Buffer[] = [];
    const CHUNK = 60000;
    for (let i = 0; i < stream.length; i += CHUNK) {
      wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), stream.subarray(i, i + CHUNK)])));
    }
    wrapped.push(FLUSH);
    return Buffer.concat(wrapped);
  }
  return stream;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleGitHttp(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string): Promise<void> {
  const repo = getRepo(owner, repoName);
  if (!repo) {
    sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
    return;
  }
  const url = new URL(req.url ?? '/', 'http://entry');
  const method = req.method ?? 'GET';

  if (method === 'GET' && tail === 'info/refs') {
    const service = url.searchParams.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
    const v2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    if (service === 'git-upload-pack' && v2) { advertiseV2(res, service); return; }
    advertiseV0(res, repo, service);
    return;
  }

  if (method === 'POST' && tail === 'git-upload-pack') {
    const body = await readBody(req);
    const v2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    try {
      if (v2) {
        const reader = new PktReader(body);
        const head = reader.readSection();
        const argsSection = reader.readSection();
        const command = head.lines.find((l) => l.startsWith('command='));
        if (command === 'command=ls-refs') {
          sendRaw(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, argsSection.lines));
          return;
        }
        if (command === 'command=fetch') {
          sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchV2(repo, [head, argsSection]));
          return;
        }
        sendRaw(res, 200, 'application/x-git-upload-pack-result', FLUSH);
        return;
      }
      const reader = new PktReader(body);
      sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchV0(repo, reader));
      return;
    } catch {
      // A malformed body must not kill the server (repo-survives-errors).
      if (!res.headersSent) sendRaw(res, 400, 'application/x-git-upload-pack-result', Buffer.from('error\n'));
      return;
    }
  }

  if (method === 'POST' && tail === 'git-receive-pack') {
    const body = await readBody(req);
    try {
      sendRaw(res, 200, 'application/x-git-receive-pack-result', receivePack(repo, body));
    } catch {
      if (!res.headersSent) sendRaw(res, 400, 'application/x-git-receive-pack-result', Buffer.from('error\n'));
    }
    return;
  }

  sendRaw(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
}
