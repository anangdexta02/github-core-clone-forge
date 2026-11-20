// Shared HTTP plumbing for the forge's surfaces: JSON answers with the
// headers the suite checks on every reply, body reading, and the bearer
// token rule (the token in MAKEFUN_SHOP_TOKEN is the viewer's).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** A non-empty, unique-per-process request id. */
export function requestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16)}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read a request body to a Buffer (empty for bodyless requests). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export type BodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false };

/**
 * Parse a JSON request body. An empty body reads as {}. A body that is
 * not valid JSON is a 400 in the making: {ok:false}.
 */
export async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true, value: {} };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the request carries the trial's bearer token. */
export function hasToken(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${TOKEN}`;
}

/** True when the request carries any Authorization header at all. */
export function hasAnyAuth(req: IncomingMessage): boolean {
  return typeof req.headers.authorization === 'string' && req.headers.authorization !== '';
}

/** The request's own origin, for absolute pagination links. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}
