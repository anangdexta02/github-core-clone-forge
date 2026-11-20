// GitHub GraphQL v4, the subset the suite's documents exercise: a small
// parser and executor over the same store the REST and git surfaces
// use, so state written on one surface reads back on the others.
// Global ids are opaque, stable base64 strings (never the bare
// database id); unknown fields answer HTTP 200 with an errors array
// naming the field, as GitHub does.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN, allocCommentId, branchTip, getRepo, nodeId, nowIso, parseNodeId, reposOf,
  type IssueRec, type PullRec, type Repo,
} from './store.ts';
import { computeMergedTree, mergePull, pullFiles } from './rest.ts';
import { hasToken, readBody, sendError, sendJson } from './http.ts';

// ---------------------------------------------------------------------------
// Lexer / parser (queries, mutations, aliases, arguments, inline fragments)
// ---------------------------------------------------------------------------

type Tok = { kind: 'name' | 'string' | 'number' | 'punct' | 'eof'; value: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { toks.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:$=!@|&'.includes(c)) { toks.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        toks.push({ kind: 'string', value: src.slice(i + 3, end < 0 ? src.length : end) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9.-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      toks.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

type AstValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: AstValue[] }
  | { kind: 'object'; fields: [string, AstValue][] };

interface AstField {
  name: string;
  alias: string | null;
  args: [string, AstValue][];
  selection: AstSelection[] | null;
}

type AstSelection =
  | { kind: 'field'; field: AstField }
  | { kind: 'inline'; typeCondition: string; selection: AstSelection[] };

interface AstOperation {
  op: 'query' | 'mutation';
  name: string | null;
  selection: AstSelection[];
}

class Parser {
  private toks: Tok[];
  private pos = 0;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  private peek(): Tok { return this.toks[this.pos]; }
  private next(): Tok { const t = this.toks[this.pos]; this.pos += 1; return t; }
  private expect(value: string): void {
    const t = this.next();
    if (t.value !== value) throw new Error(`expected "${value}", found "${t.value}"`);
  }
  private skip(value: string): boolean {
    if (this.peek().value === value) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): AstOperation[] {
    const ops: AstOperation[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.peek().value === '{') {
        ops.push({ op: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const kw = this.next();
      if (kw.value === 'fragment') {
        // Named fragments are not used by the suite's documents; parse and drop.
        this.next(); // name
        this.next(); // 'on'
        this.next(); // type
        this.parseSelectionSet();
        continue;
      }
      if (kw.value !== 'query' && kw.value !== 'mutation') throw new Error(`unexpected token "${kw.value}"`);
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.peek().value === '(') this.parseVarDefs();
      if (this.peek().value === '@') { this.next(); this.next(); }
      ops.push({ op: kw.value, name, selection: this.parseSelectionSet() });
    }
    return ops;
  }

  private parseVarDefs(): void {
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
      if (this.peek().value === '@') { this.next(); this.next(); }
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next(); // type name
    }
    this.skip('!');
  }

  private parseSelectionSet(): AstSelection[] {
    this.expect('{');
    const out: AstSelection[] = [];
    while (this.peek().value !== '}') out.push(this.parseSelection());
    this.expect('}');
    return out;
  }

  private parseSelection(): AstSelection {
    if (this.peek().value === '...') {
      this.next();
      const on = this.next();
      if (on.value !== 'on') throw new Error('only inline fragments are supported');
      const typeCondition = this.next().value;
      return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
    }
    let nameTok = this.next();
    if (nameTok.kind !== 'name') throw new Error(`expected a field name, found "${nameTok.value}"`);
    let alias: string | null = null;
    if (this.skip(':')) {
      alias = nameTok.value;
      nameTok = this.next();
    }
    const args: [string, AstValue][] = [];
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        const argName = this.next().value;
        this.expect(':');
        args.push([argName, this.parseValue()]);
      }
      this.expect(')');
    }
    let selection: AstSelection[] | null = null;
    if (this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', field: { name: nameTok.value, alias, args, selection } };
  }

  private parseValue(): AstValue {
    const t = this.peek();
    if (t.value === '$') { this.next(); return { kind: 'var', name: this.next().value }; }
    if (t.kind === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.kind === 'number') { this.next(); return { kind: 'number', value: Number(t.value) }; }
    if (t.value === '[') {
      this.next();
      const items: AstValue[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t.value === '{') {
      this.next();
      const fields: [string, AstValue][] = [];
      while (this.peek().value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields.push([key, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token "${t.value}"`);
  }
}

// ---------------------------------------------------------------------------
// Values and sources
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function coerce(value: AstValue, vars: Variables): unknown {
  switch (value.kind) {
    case 'var': return vars[value.name] ?? null;
    case 'string': return value.value;
    case 'number': return value.value;
    case 'bool': return value.value;
    case 'enum': return value.value;
    case 'null': return null;
    case 'list': return value.items.map((i) => coerce(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.fields) out[k] = coerce(v, vars);
      return out;
    }
  }
}

type Src =
  | { t: 'User'; login: string }
  | { t: 'Repository'; repo: Repo }
  | { t: 'Ref'; name: string }
  | { t: 'Issue'; repo: Repo; rec: IssueRec }
  | { t: 'PullRequest'; repo: Repo; rec: PullRec }
  | { t: 'IssueConnection'; items: Src[]; hasNext: boolean; endCursor: string | null }
  | { t: 'PullRequestConnection'; items: Src[] }
  | { t: 'PageInfo'; hasNext: boolean; endCursor: string | null }
  | { t: 'PRFiles'; paths: string[] }
  | { t: 'PRFile'; path: string }
  | { t: 'IssueComment'; idNum: number; body: string }
  | { t: '__Type'; name: string }
  | { t: '__Field'; name: string }
  | { t: '__EnumValue'; name: string }
  | { t: 'Payload'; wrap: string; repo?: Repo; rec?: IssueRec | PullRec; comment?: { idNum: number; body: string } };

function issueDbId(repo: Repo, rec: IssueRec | PullRec): number {
  return repo.dbId * 100000 + rec.number;
}

function findRepoByDbId(dbId: number): Repo | undefined {
  return reposOf(VIEWER_LOGIN).find((r) => r.dbId === dbId);
}

function resolveGlobalId(id: string): Src | null {
  const parsed = parseNodeId(id);
  if (!parsed) return null;
  if (parsed.kind === 'Repository') {
    const repo = findRepoByDbId(parsed.dbId);
    return repo ? { t: 'Repository', repo } : null;
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const repo = findRepoByDbId(Math.floor(parsed.dbId / 100000));
    if (!repo) return null;
    const rec = repo.items.get(parsed.dbId % 100000);
    if (!rec) return null;
    if (parsed.kind === 'Issue' && !rec.isPull) return { t: 'Issue', repo, rec };
    if (parsed.kind === 'PullRequest' && rec.isPull) return { t: 'PullRequest', repo, rec };
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema: field lists for introspection, resolvers for execution
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'repository', 'comments', 'labels', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION', 'MARKETPLACE', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

type Resolver = (src: never, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ t: 'User', login: VIEWER_LOGIN }),
    repository: (_s, args) => {
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? { t: 'Repository', repo } : null;
    },
    node: (_s, args) => resolveGlobalId(String(args.id ?? '')),
    __type: (_s, args) => ({ t: '__Type', name: String(args.name ?? '') }),
    __schema: () => null,
  },
  Mutation: {
    createIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = resolveGlobalId(String(input.repositoryId ?? ''));
      if (!target || target.t !== 'Repository') throw new Error('repository not found');
      const repo = target.repo;
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const ts = nowIso();
      const rec: IssueRec = {
        number, title: String(input.title ?? ''), body: String(input.body ?? ''),
        state: 'open', labels: [], createdAt: ts, updatedAt: ts, comments: [], isPull: false,
      };
      repo.items.set(number, rec);
      return { t: 'Payload', wrap: 'issue', repo, rec };
    },
    closeIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = resolveGlobalId(String(input.issueId ?? ''));
      if (!target || target.t !== 'Issue') throw new Error('issue not found');
      target.rec.state = 'closed';
      target.rec.updatedAt = nowIso();
      return { t: 'Payload', wrap: 'issue', repo: target.repo, rec: target.rec };
    },
    createPullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = resolveGlobalId(String(input.repositoryId ?? ''));
      if (!target || target.t !== 'Repository') throw new Error('repository not found');
      const repo = target.repo;
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const ts = nowIso();
      const rec: PullRec = {
        number, title: String(input.title ?? ''), body: '',
        state: 'open', headRef: String(input.headRefName ?? ''), baseRef: String(input.baseRefName ?? ''),
        merged: false, mergedAt: null, mergeCommitSha: null,
        createdAt: ts, updatedAt: ts, comments: [], isPull: true,
      };
      repo.items.set(number, rec);
      return { t: 'Payload', wrap: 'pullRequest', repo, rec };
    },
    mergePullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = resolveGlobalId(String(input.pullRequestId ?? ''));
      if (!target || target.t !== 'PullRequest') throw new Error('pull request not found');
      const result = mergePull(target.repo, target.rec);
      if (!result.ok) throw new Error(result.message);
      return { t: 'Payload', wrap: 'pullRequest', repo: target.repo, rec: target.rec };
    },
    addComment: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = resolveGlobalId(String(input.subjectId ?? ''));
      if (!target || (target.t !== 'Issue' && target.t !== 'PullRequest')) throw new Error('subject not found');
      const comment = { id: allocCommentId(), body: String(input.body ?? ''), createdAt: nowIso() };
      target.rec.comments.push(comment);
      return { t: 'Payload', wrap: 'commentEdge', comment: { idNum: comment.id, body: comment.body } };
    },
  },
  Payload: {
    issue: (s) => {
      const p = s as Extract<Src, { t: 'Payload' }>;
      return p.rec && !p.rec.isPull ? { t: 'Issue', repo: p.repo as Repo, rec: p.rec } : null;
    },
    pullRequest: (s) => {
      const p = s as Extract<Src, { t: 'Payload' }>;
      return p.rec && p.rec.isPull ? { t: 'PullRequest', repo: p.repo as Repo, rec: p.rec } : null;
    },
    commentEdge: (s) => {
      const p = s as Extract<Src, { t: 'Payload' }>;
      return p.comment ? { t: 'Payload', wrap: 'commentNode', comment: p.comment } : null;
    },
    node: (s) => {
      const p = s as Extract<Src, { t: 'Payload' }>;
      return p.comment ? { t: 'IssueComment', idNum: p.comment.idNum, body: p.comment.body } : null;
    },
  },
  User: {
    login: (s) => (s as Extract<Src, { t: 'User' }>).login,
    id: () => nodeId('User', 1000),
    name: () => VIEWER_LOGIN,
  },
  Repository: {
    id: (s) => nodeId('Repository', (s as Extract<Src, { t: 'Repository' }>).repo.dbId),
    databaseId: (s) => (s as Extract<Src, { t: 'Repository' }>).repo.dbId,
    name: (s) => (s as Extract<Src, { t: 'Repository' }>).repo.name,
    nameWithOwner: (s) => {
      const repo = (s as Extract<Src, { t: 'Repository' }>).repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (s) => ({ t: 'User', login: (s as Extract<Src, { t: 'Repository' }>).repo.owner }),
    defaultBranchRef: (s) => {
      const repo = (s as Extract<Src, { t: 'Repository' }>).repo;
      return branchTip(repo, repo.defaultBranch) ? { t: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (s) => (s as Extract<Src, { t: 'Repository' }>).repo.isPrivate,
    description: (s) => (s as Extract<Src, { t: 'Repository' }>).repo.description,
    issue: (s, args) => {
      const repo = (s as Extract<Src, { t: 'Repository' }>).repo;
      const rec = repo.items.get(Number(args.number));
      return rec && !rec.isPull ? { t: 'Issue', repo, rec } : null;
    },
    issues: (s, args) => {
      const repo = (s as Extract<Src, { t: 'Repository' }>).repo;
      let list = [...repo.items.values()].filter((i): i is IssueRec => !i.isPull);
      const states = args.states as unknown[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((x) => String(x).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'ASC');
      list.sort((a, b) => a.number - b.number);
      if (direction === 'DESC') list.reverse();
      const total = list.length;
      let start = 0;
      if (typeof args.after === 'string' && args.after !== '') {
        const cursor = Number(Buffer.from(args.after, 'base64').toString('utf8').replace('cursor:', ''));
        const idx = list.findIndex((i) => i.number === cursor);
        if (idx >= 0) start = idx + 1;
      }
      const first = typeof args.first === 'number' ? args.first : total;
      const page = list.slice(start, start + Math.max(0, first));
      const hasNext = start + page.length < total;
      const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1].number}`, 'utf8').toString('base64') : null;
      return {
        t: 'IssueConnection',
        items: page.map((rec) => ({ t: 'Issue', repo, rec })),
        hasNext,
        endCursor,
      };
    },
    pullRequest: (s, args) => {
      const repo = (s as Extract<Src, { t: 'Repository' }>).repo;
      const rec = repo.items.get(Number(args.number));
      return rec && rec.isPull ? { t: 'PullRequest', repo, rec } : null;
    },
    pullRequests: (s, args) => {
      const repo = (s as Extract<Src, { t: 'Repository' }>).repo;
      let list = [...repo.items.values()].filter((i): i is PullRec => i.isPull);
      list.sort((a, b) => a.number - b.number);
      const first = typeof args.first === 'number' ? args.first : list.length;
      list = list.slice(0, Math.max(0, first));
      return { t: 'PullRequestConnection', items: list.map((rec) => ({ t: 'PullRequest', repo, rec })) };
    },
  },
  Ref: {
    name: (s) => (s as Extract<Src, { t: 'Ref' }>).name,
  },
  Issue: {
    id: (s) => {
      const x = s as Extract<Src, { t: 'Issue' }>;
      return nodeId('Issue', issueDbId(x.repo, x.rec));
    },
    number: (s) => (s as Extract<Src, { t: 'Issue' }>).rec.number,
    title: (s) => (s as Extract<Src, { t: 'Issue' }>).rec.title,
    body: (s) => (s as Extract<Src, { t: 'Issue' }>).rec.body,
    state: (s) => (s as Extract<Src, { t: 'Issue' }>).rec.state.toUpperCase(),
    createdAt: (s) => (s as Extract<Src, { t: 'Issue' }>).rec.createdAt,
    updatedAt: (s) => (s as Extract<Src, { t: 'Issue' }>).rec.updatedAt,
  },
  PullRequest: {
    id: (s) => {
      const x = s as Extract<Src, { t: 'PullRequest' }>;
      return nodeId('PullRequest', issueDbId(x.repo, x.rec));
    },
    number: (s) => (s as Extract<Src, { t: 'PullRequest' }>).rec.number,
    title: (s) => (s as Extract<Src, { t: 'PullRequest' }>).rec.title,
    body: (s) => (s as Extract<Src, { t: 'PullRequest' }>).rec.body,
    state: (s) => {
      const rec = (s as Extract<Src, { t: 'PullRequest' }>).rec;
      return rec.merged ? 'MERGED' : rec.state.toUpperCase();
    },
    merged: (s) => (s as Extract<Src, { t: 'PullRequest' }>).rec.merged,
    headRefName: (s) => (s as Extract<Src, { t: 'PullRequest' }>).rec.headRef,
    baseRefName: (s) => (s as Extract<Src, { t: 'PullRequest' }>).rec.baseRef,
    mergeable: (s) => {
      const x = s as Extract<Src, { t: 'PullRequest' }>;
      if (x.rec.state !== 'open') return 'UNKNOWN';
      return computeMergedTree(x.repo, x.rec).ok ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (s, args) => {
      const x = s as Extract<Src, { t: 'PullRequest' }>;
      const first = typeof args.first === 'number' ? args.first : 100;
      const paths = pullFiles(x.repo, x.rec).map((f) => String(f.filename)).slice(0, Math.max(0, first));
      return { t: 'PRFiles', paths };
    },
    createdAt: (s) => (s as Extract<Src, { t: 'PullRequest' }>).rec.createdAt,
    updatedAt: (s) => (s as Extract<Src, { t: 'PullRequest' }>).rec.updatedAt,
  },
  IssueConnection: {
    nodes: (s) => (s as Extract<Src, { t: 'IssueConnection' }>).items,
    pageInfo: (s) => {
      const c = s as Extract<Src, { t: 'IssueConnection' }>;
      return { t: 'PageInfo', hasNext: c.hasNext, endCursor: c.endCursor };
    },
    totalCount: (s) => (s as Extract<Src, { t: 'IssueConnection' }>).items.length,
  },
  PullRequestConnection: {
    nodes: (s) => (s as Extract<Src, { t: 'PullRequestConnection' }>).items,
    totalCount: (s) => (s as Extract<Src, { t: 'PullRequestConnection' }>).items.length,
  },
  PageInfo: {
    hasNextPage: (s) => (s as Extract<Src, { t: 'PageInfo' }>).hasNext,
    hasPreviousPage: () => false,
    endCursor: (s) => (s as Extract<Src, { t: 'PageInfo' }>).endCursor,
    startCursor: (s) => (s as Extract<Src, { t: 'PageInfo' }>).endCursor,
  },
  PRFiles: {
    nodes: (s) => (s as Extract<Src, { t: 'PRFiles' }>).paths.map((path) => ({ t: 'PRFile', path })),
    totalCount: (s) => (s as Extract<Src, { t: 'PRFiles' }>).paths.length,
  },
  PRFile: {
    path: (s) => (s as Extract<Src, { t: 'PRFile' }>).path,
  },
  IssueComment: {
    id: (s) => nodeId('IssueComment', (s as Extract<Src, { t: 'IssueComment' }>).idNum),
    body: (s) => (s as Extract<Src, { t: 'IssueComment' }>).body,
  },
  __Type: {
    name: (s) => (s as Extract<Src, { t: '__Type' }>).name,
    kind: (s) => (TYPE_ENUMS[(s as Extract<Src, { t: '__Type' }>).name] ? 'ENUM' : 'OBJECT'),
    fields: (s) => (TYPE_FIELDS[(s as Extract<Src, { t: '__Type' }>).name] ?? []).map((name) => ({ t: '__Field', name })),
    enumValues: (s) => (TYPE_ENUMS[(s as Extract<Src, { t: '__Type' }>).name] ?? []).map((name) => ({ t: '__EnumValue', name })),
  },
  __Field: {
    name: (s) => (s as Extract<Src, { t: '__Field' }>).name,
  },
  __EnumValue: {
    name: (s) => (s as Extract<Src, { t: '__EnumValue' }>).name,
  },
};

// The response type name a source answers to (for inline fragments).
function typeNameOf(src: Src): string {
  return src.t;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecCtx {
  vars: Variables;
  errors: { message: string }[];
}

function execSet(typeName: string, src: Src | Record<string, never>, selections: AstSelection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if ((src as Src).t === sel.typeCondition || typeName === sel.typeCondition) {
        Object.assign(out, execSet(sel.typeCondition, src, sel.selection, ctx));
      }
      continue;
    }
    const field = sel.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of field.args) args[k] = coerce(v, ctx.vars);
    let value: unknown;
    try {
      value = resolver(src as never, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = complete(value, field.selection, ctx);
  }
  return out;
}

function complete(value: unknown, selection: AstSelection[] | null, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (!selection) return value;
  if (Array.isArray(value)) return value.map((v) => complete(v, selection, ctx));
  const src = value as Src;
  return execSet(src.t, src, selection, ctx);
}

function execute(doc: string, vars: Variables, operationName?: string): Record<string, unknown> {
  const ops = new Parser(doc).parseDocument();
  const op = (operationName ? ops.find((o) => o.name === operationName) : undefined) ?? ops[0];
  if (!op) return { errors: [{ message: 'no operation found in document' }] };
  const ctx: ExecCtx = { vars, errors: [] };
  const rootType = op.op === 'mutation' ? 'Mutation' : 'Query';
  const data = execSet(rootType, { t: rootType } as unknown as Src, op.selection, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!hasToken(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const query = String(e.query ?? '');
    const variables = (e.variables ?? {}) as Variables;
    try {
      return execute(query, variables, typeof e.operationName === 'string' ? e.operationName : undefined);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
