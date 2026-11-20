// MCP over streamable HTTP: the modern server/discover negotiation,
// tools/list and tools/call for the six forge tools the suite drives.
// The tools act on the same store as REST and git, so an issue opened
// here is the same issue REST reads back. Stateless: no session id is
// handed out, and every answer is one JSON body.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN, branchTip, createRepo, getRepo, nowIso,
  type IssueRec, type PullRec, type Repo,
} from './store.ts';
import { mergePull } from './rest.ts';
import { hasToken, readBody } from './http.ts';

const PROTOCOL = '2026-07-28';
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const TOOL_LIST = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: {
    type: 'object',
    properties: t.properties,
    required: t.required,
  },
}));

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}

function issueJson(repo: Repo, rec: IssueRec): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + rec.number,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    labels: rec.labels.map((name) => ({ name })),
  };
}

function pullJson(repo: Repo, rec: PullRec): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + rec.number,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    merged: rec.merged,
    head: { ref: rec.headRef, sha: branchTip(repo, rec.headRef) ?? '' },
    base: { ref: rec.baseRef, sha: branchTip(repo, rec.baseRef) ?? '' },
  };
}

type RpcResult = { kind: 'result'; value: unknown } | { kind: 'error'; code: number; message: string } | { kind: 'toolError'; message: string };

function toolResult(value: unknown): RpcResult {
  return { kind: 'result', value: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } };
}

function callTool(name: string, args: Record<string, unknown>): RpcResult {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { kind: 'error', code: -32602, message: `unknown tool: ${name}` };
  for (const req of def.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { kind: 'error', code: -32602, message: `missing required argument: ${req}` };
    }
  }
  const str = (v: unknown) => String(v ?? '');
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = str(args.name);
        if (getRepo(VIEWER_LOGIN, repoName)) return { kind: 'toolError', message: `repository ${repoName} already exists` };
        const repo = createRepo(VIEWER_LOGIN, repoName, args.private === true, str(args.description));
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        const repo = getRepo(str(args.owner), str(args.repo));
        if (!repo) return { kind: 'toolError', message: 'repository not found' };
        return toolResult(repoJson(repo));
      }
      case 'create_issue': {
        const repo = getRepo(str(args.owner), str(args.repo));
        if (!repo) return { kind: 'toolError', message: 'repository not found' };
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const ts = nowIso();
        const rec: IssueRec = {
          number, title: str(args.title), body: str(args.body), state: 'open',
          labels: [], createdAt: ts, updatedAt: ts, comments: [], isPull: false,
        };
        repo.items.set(number, rec);
        return toolResult(issueJson(repo, rec));
      }
      case 'list_issues': {
        const repo = getRepo(str(args.owner), str(args.repo));
        if (!repo) return { kind: 'toolError', message: 'repository not found' };
        const state = str(args.state ?? 'open');
        let list = [...repo.items.values()].filter((i): i is IssueRec => !i.isPull);
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        list.sort((a, b) => a.number - b.number);
        return toolResult(list.map((i) => issueJson(repo, i)));
      }
      case 'create_pull_request': {
        const repo = getRepo(str(args.owner), str(args.repo));
        if (!repo) return { kind: 'toolError', message: 'repository not found' };
        const head = str(args.head);
        const base = str(args.base);
        if (!branchTip(repo, head) || !branchTip(repo, base)) {
          return { kind: 'toolError', message: 'head or base branch does not exist' };
        }
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const ts = nowIso();
        const rec: PullRec = {
          number, title: str(args.title), body: str(args.body), state: 'open',
          headRef: head, baseRef: base, merged: false, mergedAt: null, mergeCommitSha: null,
          createdAt: ts, updatedAt: ts, comments: [], isPull: true,
        };
        repo.items.set(number, rec);
        return toolResult(pullJson(repo, rec));
      }
      case 'merge_pull_request': {
        const repo = getRepo(str(args.owner), str(args.repo));
        if (!repo) return { kind: 'toolError', message: 'repository not found' };
        const rec = repo.items.get(Number(args.pull_number));
        if (!rec || !rec.isPull) return { kind: 'toolError', message: 'pull request not found' };
        const result = mergePull(repo, rec);
        if (!result.ok) return { kind: 'toolError', message: result.message };
        return toolResult(pullJson(repo, rec));
      }
      default:
        return { kind: 'error', code: -32602, message: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { kind: 'toolError', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end();
    return;
  }
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } }));
    return;
  }
  if (!hasToken(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } }));
    return;
  }

  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const replies: unknown[] = [];
  for (const entry of entries) {
    const rpc = (entry ?? {}) as Record<string, unknown>;
    const id = 'id' in rpc ? rpc.id : undefined;
    const rpcMethod = String(rpc.method ?? '');
    const params = (rpc.params ?? {}) as Record<string, unknown>;

    if (id === undefined) continue; // a notification: no reply

    if (rpcMethod === 'server/discover') {
      replies.push({
        jsonrpc: '2.0', id,
        result: {
          resultType: 'complete',
          supportedVersions: [PROTOCOL, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      });
      continue;
    }
    if (rpcMethod === 'initialize') {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL;
      replies.push({
        jsonrpc: '2.0', id,
        result: { protocolVersion: offered, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      });
      continue;
    }
    if (rpcMethod === 'ping') {
      replies.push({ jsonrpc: '2.0', id, result: {} });
      continue;
    }
    if (rpcMethod === 'tools/list') {
      replies.push({ jsonrpc: '2.0', id, result: { tools: TOOL_LIST } });
      continue;
    }
    if (rpcMethod === 'tools/call') {
      const toolName = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(toolName, args);
      if (outcome.kind === 'error') {
        replies.push({ jsonrpc: '2.0', id, error: { code: outcome.code, message: outcome.message } });
      } else if (outcome.kind === 'toolError') {
        replies.push({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: outcome.message }], isError: true },
        });
      } else {
        replies.push({ jsonrpc: '2.0', id, result: outcome.value });
      }
      continue;
    }
    replies.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${rpcMethod}` } });
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0] ?? null));
}
