// The forge's whole state: an in-memory git object store plus the
// repository / issue / pull-request records the APIs serve. One process,
// no disk, no outside service. Everything derives from the calls the
// suite makes, in the order it makes them.
//
// Time: the trial hands the process a fixed opening time
// (MAKEFUN_TRIAL_NOW). The forge runs a logical clock from there — one
// second per recorded event — so timestamps are stable, ordered, and
// identical between two runs of the same instance.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The token owner's login, as the suite's fixed scenario names it. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

const bootIso = process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00.000Z';
const bootMs = Date.parse(bootIso);
let tick = 0;

/** The next logical timestamp, ISO 8601 with a Z suffix. */
export function nowIso(): string {
  tick += 1;
  return new Date(bootMs + tick * 1000).toISOString().replace('.000Z', 'Z');
}

/** The current logical timestamp without advancing the clock. */
export function peekIso(): string {
  return new Date(bootMs + tick * 1000).toISOString().replace('.000Z', 'Z');
}

/** Seconds since the epoch at the current logical time (for git objects). */
export function nowEpoch(): number {
  return Math.floor(bootMs / 1000) + tick;
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  /** The object's content, without the "<type> <len>\0" header. */
  data: Buffer;
}

const objects = new Map<string, GitObject>();

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function storeObject(type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

export function getObject(sha: string): GitObject | undefined {
  return objects.get(sha);
}

export function hasObject(sha: string): boolean {
  return objects.has(sha);
}

export function allObjectShas(): string[] {
  return [...objects.keys()];
}

// ---------------------------------------------------------------------------
// Trees and commits
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // "100644", "100755", "120000", "40000" for subtrees
  name: string;
  sha: string;
}

/** Parse a tree object's content into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

/** Serialise tree entries (sorted the git way) into a stored tree object. */
export function writeTree(entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return storeObject('tree', Buffer.concat(parts));
}

/** Flatten a tree (recursively) into path -> {sha, mode}. */
export function flattenTree(treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const obj = getObject(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(e.sha, path, out);
    else out.set(path, { sha: e.sha, mode: e.mode });
  }
  return out;
}

/** Rebuild nested trees from a flat path -> {sha, mode} map; returns the root tree sha. */
export function buildTree(files: Map<string, { sha: string; mode: string }>): string {
  interface Node { dirs: Map<string, Node>; files: TreeEntry[] }
  const root: Node = { dirs: new Map(), files: [] };
  for (const [path, v] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      let next = node.dirs.get(segs[i]);
      if (!next) { next = { dirs: new Map(), files: [] }; node.dirs.set(segs[i], next); }
      node = next;
    }
    node.files.push({ mode: v.mode, name: segs[segs.length - 1], sha: v.sha });
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: emit(sub) });
    return writeTree(entries);
  };
  return emit(root);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

/** The forge's own identity for the commits it creates (contents, merges). */
export function forgeIdent(): string {
  return `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${nowEpoch()} +0000`;
}

export function makeCommit(tree: string, parents: string[], message: string, ident?: string): string {
  const who = ident ?? forgeIdent();
  let head = `tree ${tree}\n`;
  for (const p of parents) head += `parent ${p}\n`;
  head += `author ${who}\ncommitter ${who}\n`;
  return storeObject('commit', Buffer.from(`${head}\n${message}`, 'utf8'));
}

/** All ancestors of a commit (including itself), nearest first by insertion order. */
export function ancestorsOf(sha: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [sha];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(cur);
    if (!obj || obj.type !== 'commit') continue;
    order.push(cur);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return order;
}

export function isAncestor(maybeAncestor: string, ofSha: string): boolean {
  return ancestorsOf(ofSha).includes(maybeAncestor);
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(a: string, b: string): string | null {
  const ancB = new Set(ancestorsOf(b));
  for (const candidate of ancestorsOf(a)) if (ancB.has(candidate)) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// Pack primitives shared by upload-pack / receive-pack
// ---------------------------------------------------------------------------

export function zlibInflate(data: Buffer): Buffer {
  return inflateSync(data);
}

export function zlibDeflate(data: Buffer): Buffer {
  return deflateSync(data);
}

// ---------------------------------------------------------------------------
// Repositories, issues, pull requests
// ---------------------------------------------------------------------------

export interface Label { name: string; color: string }

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: { id: number; body: string; createdAt: string }[];
  isPull: false;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  comments: { id: number; body: string; createdAt: string }[];
  isPull: true;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name ("refs/heads/main") -> commit sha. */
  refs: Map<string, string>;
  /** Symbolic refs, e.g. HEAD -> refs/heads/main. */
  symrefs: Map<string, string>;
  labels: Map<string, Label>;
  /** Issues and pull requests share one per-repo number sequence. */
  items: Map<number, IssueRec | PullRec>;
  nextNumber: number;
  createdAt: string;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextCommentId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    dbId: nextRepoId,
    owner,
    name,
    isPrivate,
    description,
    defaultBranch: 'main',
    refs: new Map(),
    symrefs: new Map([['HEAD', 'refs/heads/main']]),
    labels: new Map(),
    items: new Map(),
    nextNumber: 1,
    createdAt: nowIso(),
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function reposOf(owner: string): Repo[] {
  return [...repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.dbId - b.dbId);
}

export function allocCommentId(): number {
  const id = nextCommentId;
  nextCommentId += 1;
  return id;
}

/** A stable, opaque global id for GraphQL (never the bare database id). */
export function nodeId(kind: string, dbId: number): string {
  return Buffer.from(`${kind}:${dbId}`, 'utf8').toString('base64');
}

export function parseNodeId(id: string): { kind: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.lastIndexOf(':');
    if (at < 0) return null;
    const dbId = Number(text.slice(at + 1));
    if (!Number.isInteger(dbId)) return null;
    return { kind: text.slice(0, at), dbId };
  } catch {
    return null;
  }
}

/** Branch tip for a branch name, following the repo's refs. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Resolve a ref-ish (branch name, ref name, or sha) to a commit sha. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (hasObject(ref) && getObject(ref)?.type === 'commit') return ref;
  return undefined;
}
