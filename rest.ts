// GitHub REST v3, the subset the suite exercises: repositories, git refs,
// branches, commits, contents, labels, issues, comments, pull requests
// and squash merges — all backed by the store's git objects, so what
// REST writes, git and GraphQL read back.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_ID, VIEWER_LOGIN, allocCommentId, ancestorsOf, branchTip, buildTree, createRepo, deleteRepo,
  flattenTree, getObject, getRepo, makeCommit, mergeBase, nowIso, parseCommit, parseTree,
  peekIso, reposOf, resolveRef, storeObject, type IssueRec, type PullRec, type Repo,
} from './store.ts';
import { hasToken, originOf, readJsonBody, sendError, sendJson } from './http.ts';

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL };

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: `repo-${repo.dbId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER_ID },
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    fork: false,
    archived: false,
  };
}

function labelJson(name: string, color: string): Record<string, unknown> {
  return { id: name.length * 7919 + name.charCodeAt(0), name, color, default: false };
}

function issueJson(repo: Repo, rec: IssueRec): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + rec.number,
    node_id: `issue-${repo.dbId}-${rec.number}`,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    labels: rec.labels.map((n) => labelJson(n, repo.labels.get(n)?.color ?? 'ededed')),
    user: { login: repo.owner, id: VIEWER_ID },
    comments: rec.comments.length,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    pull_request: undefined,
  };
}

function pullJson(repo: Repo, rec: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, rec.headRef) ?? '';
  const baseSha = branchTip(repo, rec.baseRef) ?? '';
  return {
    id: repo.dbId * 100000 + rec.number,
    node_id: `pr-${repo.dbId}-${rec.number}`,
    number: rec.number,
    state: rec.state,
    title: rec.title,
    body: rec.body,
    head: { ref: rec.headRef, sha: headSha, label: `${repo.owner}:${rec.headRef}` },
    base: { ref: rec.baseRef, sha: baseSha, label: `${repo.owner}:${rec.baseRef}` },
    merged: rec.merged,
    merged_at: rec.mergedAt,
    merge_commit_sha: rec.mergeCommitSha,
    user: { login: repo.owner, id: VIEWER_ID },
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
}

/** Paginate a list the GitHub way: per_page honoured, Link rel="next" only. */
function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const q = ctx.url.searchParams;
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const next = new URL(ctx.url.pathname, originOf(ctx.req));
    for (const [k, v] of q.entries()) next.searchParams.set(k, v);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    ctx.res.setHeader('link', `<${next.toString()}>; rel="next"`);
  }
  return slice;
}

/** Find a repo for a route, answering 401/404 exactly as the checks expect. */
function routeRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = getRepo(owner, name);
  if (!repo) {
    if (!hasToken(ctx.req) && getRepo(VIEWER_LOGIN, name)) {
      sendError(ctx.res, 401, 'Requires authentication');
      return null;
    }
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  if (repo.isPrivate && !hasToken(ctx.req)) {
    sendError(ctx.res, 401, 'Requires authentication');
    return null;
  }
  return repo;
}

function identParts(line: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!m) return { name: line, email: '', date: peekIso() };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace('.000Z', 'Z') };
}

function commitJson(sha: string): Record<string, unknown> {
  const obj = getObject(sha);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const author = identParts(info?.authorLine ?? '');
  const committer = identParts(info?.committerLine ?? '');
  return {
    sha,
    commit: {
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '' },
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
    parents: (info?.parents ?? []).map((p) => ({ sha: p })),
  };
}

export async function handleRest(ctx: Ctx, segments: string[]): Promise<boolean> {
  const { req, res, url } = ctx;
  const method = req.method ?? 'GET';
  // segments: ['api', 'v3', ...rest]
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== 'GET') { sendError(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues?q={query}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: 'forge-1.0.0', verifiable_password_authentication: false });
    return true;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
    return true;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
      const name = String(body.value.name ?? '');
      if (name === '') { sendError(res, 422, 'Validation Failed: name is required'); return true; }
      if (getRepo(VIEWER_LOGIN, name)) { sendError(res, 422, 'Validation Failed: name already exists on this account'); return true; }
      const repo = createRepo(VIEWER_LOGIN, name, body.value.private === true, String(body.value.description ?? ''));
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const mine = reposOf(VIEWER_LOGIN).map(repoJson);
      sendJson(res, 200, paginate(ctx, mine));
      return true;
    }
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        const repo = routeRepo(ctx, owner, name);
        if (repo) sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const repo = routeRepo(ctx, owner, name);
        if (!repo) return true;
        const body = await readJsonBody(req);
        if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        if (typeof body.value.description === 'string') repo.description = body.value.description;
        if (typeof body.value.name === 'string' && body.value.name !== '') repo.name = body.value.name;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        const repo = routeRepo(ctx, owner, name);
        if (!repo) return true;
        deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': 'forge-del' });
        res.end();
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    const repo = routeRepo(ctx, owner, name);
    if (!repo) return true;

    // POST /repos/{o}/{r}/git/refs
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
      const ref = String(body.value.ref ?? '');
      const sha = String(body.value.sha ?? '');
      if (!/^refs\/(heads|tags)\//.test(ref) || !/^[0-9a-f]{40}$/i.test(sha)) {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      if (repo.refs.has(ref)) { sendError(res, 422, 'Validation Failed: Reference already exists'); return true; }
      repo.refs.set(ref, sha.toLowerCase());
      sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      sendJson(res, 200, paginate(ctx, list));
      return true;
    }

    // GET /repos/{o}/{r}/branches/{branch}
    if (tail[0] === 'branches' && tail.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(tail[1]);
      const sha = branchTip(repo, branch);
      if (!sha) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length >= 3 && method === 'GET') {
      const ref = tail.slice(2).map(decodeURIComponent).join('/');
      const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
      if (!sha) { sendError(res, 404, 'Not Found'); return true; }
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      sendJson(res, 200, { ref: full, object: { sha, type: 'commit' } });
      return true;
    }

    // GET /repos/{o}/{r}/commits?sha=<branch>
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const refParam = url.searchParams.get('sha');
      const tip = refParam ? resolveRef(repo, refParam) : branchTip(repo, repo.defaultBranch);
      if (!tip) { sendJson(res, 200, []); return true; }
      const list = ancestorsOf(tip).map(commitJson);
      sendJson(res, 200, paginate(ctx, list));
      return true;
    }

    // Contents: /repos/{o}/{r}/contents/{path...}
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map(decodeURIComponent).join('/');
      await handleContents(ctx, repo, path);
      return true;
    }

    // Labels
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return true; }
        const lname = String(body.value.name ?? '');
        const color = String(body.value.color ?? 'ededed');
        if (lname === '') { sendError(res, 422, 'Validation Failed'); return true; }
        if (repo.labels.has(lname)) { sendError(res, 422, 'Validation Failed: already exists'); return true; }
        repo.labels.set(lname, { name: lname, color });
        sendJson(res, 201, labelJson(lname, color));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(l.name, l.color)));
        return true;
      }
    }

    // Issues
    if (tail[0] === 'issues') {
      await handleIssues(ctx, repo, tail.slice(1));
      return true;
    }

    // Pull requests
    if (tail[0] === 'pulls') {
      await handlePulls(ctx, repo, tail.slice(1));
      return true;
    }
  }

  sendError(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

async function handleContents(ctx: Ctx, repo: Repo, path: string): Promise<void> {
  const { req, res, url } = ctx;
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (!tip) { sendError(res, 404, 'Not Found'); return; }
    const commit = getObject(tip);
    if (!commit || commit.type !== 'commit') { sendError(res, 404, 'Not Found'); return; }
    const files = flattenTree(parseCommit(commit.data).tree);
    if (path !== '' && files.has(path)) {
      const entry = files.get(path) as { sha: string; mode: string };
      const blob = getObject(entry.sha);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: entry.sha,
        size: data.length,
        name: path.split('/').pop(),
        path,
      });
      return;
    }
    // Directory listing: the root, or any prefix that has entries under it.
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, { type: string; sha: string }>();
    for (const [p, v] of files) {
      if (!p.startsWith(prefix)) continue;
      const restPath = p.slice(prefix.length);
      const seg = restPath.split('/')[0];
      if (restPath.includes('/')) {
        if (!entries.has(seg)) {
          // Find the subtree sha by walking the tree.
          entries.set(seg, { type: 'dir', sha: subtreeSha(parseCommit(commit.data).tree, prefix + seg) ?? v.sha });
        }
      } else {
        entries.set(seg, { type: 'file', sha: v.sha });
      }
    }
    if (path === '' || entries.size > 0) {
      const list = [...entries.entries()].map(([n, e]) => ({
        type: e.type, name: n, path: prefix + n, sha: e.sha, size: 0,
      }));
      sendJson(res, 200, list);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = await readJsonBody(req);
    if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
    const message = String(body.value.message ?? (method === 'PUT' ? 'Add file' : 'Delete file'));
    const branch = String(body.value.branch ?? repo.defaultBranch);
    const tip = branchTip(repo, branch);
    const files = new Map<string, { sha: string; mode: string }>();
    if (tip) {
      const commit = getObject(tip);
      if (commit && commit.type === 'commit') {
        for (const [p, v] of flattenTree(parseCommit(commit.data).tree)) files.set(p, v);
      }
    }
    const current = files.get(path);

    if (method === 'PUT') {
      const givenSha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
      if (current && givenSha === undefined) { sendError(res, 409, 'Conflict: file already exists'); return; }
      if (current && givenSha !== undefined && givenSha.toLowerCase() !== current.sha) {
        sendError(res, 409, 'Conflict: sha does not match');
        return;
      }
      if (!current && givenSha !== undefined) { sendError(res, 404, 'Not Found'); return; }
      const data = Buffer.from(String(body.value.content ?? ''), 'base64');
      const blobSha = storeObject('blob', data);
      files.set(path, { sha: blobSha, mode: '100644' });
      const tree = buildTree(files);
      const commitSha = makeCommit(tree, tip ? [tip] : [], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(res, current ? 200 : 201, {
        content: {
          type: 'file', encoding: 'base64', sha: blobSha, size: data.length,
          name: path.split('/').pop(), path,
        },
        commit: { sha: commitSha, message },
      });
      return;
    }

    // DELETE
    if (!current) { sendError(res, 404, 'Not Found'); return; }
    const givenSha = String(body.value.sha ?? '');
    if (givenSha.toLowerCase() !== current.sha) { sendError(res, 409, 'Conflict: sha does not match'); return; }
    files.delete(path);
    const tree = buildTree(files);
    const commitSha = makeCommit(tree, tip ? [tip] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
    return;
  }

  sendError(res, 404, 'Not Found');
}

function subtreeSha(treeSha: string, dirPath: string): string | null {
  let cur = treeSha;
  for (const seg of dirPath.split('/').filter((s) => s !== '')) {
    const obj = getObject(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return null;
    cur = entry.sha;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Issues and comments
// ---------------------------------------------------------------------------

async function handleIssues(ctx: Ctx, repo: Repo, tail: string[]): Promise<void> {
  const { req, res, url } = ctx;
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      const labels = Array.isArray(body.value.labels) ? body.value.labels.map(String) : [];
      for (const l of labels) {
        if (!repo.labels.has(l)) { sendError(res, 422, `Validation Failed: label "${l}" does not exist`); return; }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const ts = nowIso();
      const rec: IssueRec = {
        number,
        title: String(body.value.title ?? ''),
        body: String(body.value.body ?? ''),
        state: 'open',
        labels,
        createdAt: ts,
        updatedAt: ts,
        comments: [],
        isPull: false,
      };
      repo.items.set(number, rec);
      sendJson(res, 201, issueJson(repo, rec));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort');
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.items.values()].filter((i): i is IssueRec => !i.isPull);
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      if (sort === 'created' && direction === 'asc') { /* already ascending */ }
      else if (sort === 'created' && direction === 'desc') list.reverse();
      else if (sort === null) list.sort((a, b) => a.number - b.number);
      sendJson(res, 200, paginate(ctx, list.map((i) => issueJson(repo, i))));
      return;
    }
  }

  const num = Number(tail[0]);
  const rec = Number.isInteger(num) ? repo.items.get(num) : undefined;

  if (tail.length === 1 && rec && !rec.isPull) {
    if (method === 'GET') { sendJson(res, 200, issueJson(repo, rec)); return; }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      if (body.value.state === 'closed' || body.value.state === 'open') rec.state = body.value.state;
      if (typeof body.value.title === 'string') rec.title = body.value.title;
      if (typeof body.value.body === 'string') rec.body = body.value.body;
      rec.updatedAt = nowIso();
      sendJson(res, 200, issueJson(repo, rec));
      return;
    }
  }

  if (tail.length === 2 && tail[1] === 'comments' && rec && !rec.isPull) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      const comment = { id: allocCommentId(), body: String(body.value.body ?? ''), createdAt: nowIso() };
      rec.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: repo.owner, id: VIEWER_ID } });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, paginate(ctx, rec.comments.map((c) => ({
        id: c.id, body: c.body, created_at: c.createdAt, user: { login: repo.owner, id: VIEWER_ID },
      }))));
      return;
    }
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Longest common subsequence over lines (files in the suite are small).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}

async function handlePulls(ctx: Ctx, repo: Repo, tail: string[]): Promise<void> {
  const { req, res, url } = ctx;
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      const head = String(body.value.head ?? '');
      const base = String(body.value.base ?? '');
      if (!branchTip(repo, head) || !branchTip(repo, base)) {
        sendError(res, 422, 'Validation Failed: head or base branch does not exist');
        return;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const ts = nowIso();
      const rec: PullRec = {
        number,
        title: String(body.value.title ?? ''),
        body: String(body.value.body ?? ''),
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: ts,
        updatedAt: ts,
        comments: [],
        isPull: true,
      };
      repo.items.set(number, rec);
      sendJson(res, 201, pullJson(repo, rec));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.items.values()].filter((i): i is PullRec => i.isPull);
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      sendJson(res, 200, paginate(ctx, list.map((p) => pullJson(repo, p))));
      return;
    }
  }

  const num = Number(tail[0]);
  const rec = Number.isInteger(num) ? repo.items.get(num) : undefined;

  if (tail.length === 1) {
    if (!rec || !rec.isPull) { sendError(res, 404, 'Not Found'); return; }
    if (method === 'GET') { sendJson(res, 200, pullJson(repo, rec)); return; }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      if (body.value.state === 'closed' || body.value.state === 'open') {
        if (!rec.merged) rec.state = body.value.state;
      }
      if (typeof body.value.title === 'string') rec.title = body.value.title;
      if (typeof body.value.body === 'string') rec.body = body.value.body;
      rec.updatedAt = nowIso();
      sendJson(res, 200, pullJson(repo, rec));
      return;
    }
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!rec || !rec.isPull) { sendError(res, 404, 'Not Found'); return; }
    sendJson(res, 200, paginate(ctx, pullFiles(repo, rec)));
    return;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!rec || !rec.isPull) { sendError(res, 404, 'Not Found'); return; }
    const body = await readJsonBody(req);
    if (!body.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
    const result = mergePull(repo, rec);
    if (!result.ok) { sendError(res, result.status, result.message); return; }
    sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(res, 404, 'Not Found');
}

/** The changed-file list of a pull request: merge-base tree vs head tree. */
export function pullFiles(repo: Repo, rec: PullRec): Record<string, unknown>[] {
  const headTip = branchTip(repo, rec.headRef);
  const baseTip = branchTip(repo, rec.baseRef);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(headTip, baseTip) ?? baseTip;
  const fromTree = treeFiles(base);
  const toTree = treeFiles(headTip);
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...fromTree.keys(), ...toTree.keys()]);
  for (const p of [...paths].sort()) {
    const before = fromTree.get(p);
    const after = toTree.get(p);
    if (before && after && before.sha === after.sha) continue;
    const oldText = before ? (getObject(before.sha)?.data.toString('utf8') ?? '') : '';
    const newText = after ? (getObject(after.sha)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    out.push({
      filename: p,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: after?.sha ?? before?.sha ?? '',
    });
  }
  return out;
}

function treeFiles(commitSha: string): Map<string, { sha: string; mode: string }> {
  const obj = getObject(commitSha);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(parseCommit(obj.data).tree);
}

/** The three-way merged tree for a pull request, or the conflict that stops it. */
export function computeMergedTree(repo: Repo, rec: PullRec): { ok: true; tree: string; baseTip: string } | { ok: false; status: number; message: string } {
  const headTip = branchTip(repo, rec.headRef);
  const baseTip = branchTip(repo, rec.baseRef);
  if (!headTip || !baseTip) return { ok: false, status: 405, message: 'Head or base branch is missing' };
  const base = mergeBase(headTip, baseTip);
  const baseFiles = base ? treeFiles(base) : new Map<string, { sha: string; mode: string }>();
  const ourFiles = treeFiles(baseTip);
  const theirFiles = treeFiles(headTip);

  const merged = new Map(ourFiles);
  const paths = new Set([...baseFiles.keys(), ...theirFiles.keys()]);
  for (const p of paths) {
    const b = baseFiles.get(p)?.sha;
    const o = ourFiles.get(p)?.sha;
    const t = theirFiles.get(p)?.sha;
    if (o === t) continue; // both sides agree
    if (b === o) {
      // Only the head changed it: take the head's version (or its deletion).
      if (t === undefined) merged.delete(p);
      else merged.set(p, theirFiles.get(p) as { sha: string; mode: string });
      continue;
    }
    if (b === t) continue; // only the base moved: keep ours
    return { ok: false, status: 405, message: 'Merge conflict: the pull request cannot be merged automatically' };
  }
  return { ok: true, tree: buildTree(merged), baseTip };
}

/** Squash-merge a pull request into its base branch, three-way at path level. */
export function mergePull(repo: Repo, rec: PullRec): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (rec.merged) return { ok: false, status: 409, message: 'Pull Request is already merged' };
  if (rec.state !== 'open') return { ok: false, status: 405, message: 'Pull Request is not open' };
  const plan = computeMergedTree(repo, rec);
  if (!plan.ok) return plan;
  const message = `${rec.title}\n\n${rec.body}`.trim();
  const sha = makeCommit(plan.tree, [plan.baseTip], message === '' ? rec.title : message);
  repo.refs.set(`refs/heads/${rec.baseRef}`, sha);
  rec.merged = true;
  rec.state = 'closed';
  rec.mergedAt = nowIso();
  rec.mergeCommitSha = sha;
  rec.updatedAt = rec.mergedAt;
  return { ok: true, sha };
}
