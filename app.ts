// The forge's server: one process answering git smart HTTP, REST v3,
// GraphQL v4 and MCP over a single in-memory store. main.ts owns the
// lifecycle (bind an ephemeral port, register, wait for done); this
// file owns the routing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGitHttp } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { hasToken, sendError, sendJson } from './http.ts';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://entry');

        // The env's boot probe: no token, called twice.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3. The trial's token names the viewer; without it, 401.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!hasToken(req)) {
            // One carve-out the checks assert precisely: reading a
            // private repo with no token is the 401; other no-token
            // calls are refused the same way.
            sendError(res, 401, 'Requires authentication');
            return;
          }
          const segments = path.split('/').filter((s) => s !== '');
          await handleRest({ req, res, url }, segments);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          await handleGraphQL(req, res);
          return;
        }

        // MCP over streamable HTTP.
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch) {
          await handleGitHttp(req, res, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), gitMatch[3]);
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      }
    })();
  });
}
