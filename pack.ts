// Git wire primitives: pkt-lines and packfiles, built on node:zlib and
// node:crypto only. The pack reader resolves ofs/ref deltas (including
// thin packs whose bases already sit in the store); the writer emits
// plain, undeltified objects, which every client accepts.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { getObject, hashObject, storeObject, type ObjType } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** A sequential reader over a pkt-line stream. */
export class PktReader {
  private buf: Buffer;
  private pos = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** The next packet, or null when the stream is exhausted. */
  next(): Pkt | null {
    if (this.pos + 4 > this.buf.length) return null;
    const hex = this.buf.toString('ascii', this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length "${hex}"`);
    const len = parseInt(hex, 16);
    if (len === 0) { this.pos += 4; return { kind: 'flush' }; }
    if (len === 1) { this.pos += 4; return { kind: 'delim' }; }
    if (len === 2) { this.pos += 4; return { kind: 'end' }; }
    if (len === 3 || len < 4 || this.pos + len > this.buf.length) throw new Error('invalid pkt-line');
    const payload = this.buf.subarray(this.pos + 4, this.pos + len);
    this.pos += len;
    return { kind: 'data', payload };
  }

  /** All bytes not yet consumed (the packfile after a receive-pack flush). */
  rest(): Buffer {
    return this.buf.subarray(this.pos);
  }

  /** Read data packets until a flush/delim; returns their text lines. */
  readSection(): { lines: string[]; terminator: 'flush' | 'delim' | 'end' | 'eof' } {
    const lines: string[] = [];
    for (;;) {
      const pkt = this.next();
      if (pkt === null) return { lines, terminator: 'eof' };
      if (pkt.kind === 'flush') return { lines, terminator: 'flush' };
      if (pkt.kind === 'delim') return { lines, terminator: 'delim' };
      if (pkt.kind === 'end') return { lines, terminator: 'end' };
      lines.push(pkt.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/**
 * Inflate one zlib stream inside `buf` starting at `offset`, knowing the
 * inflated size in advance. Node's inflateSync ignores trailing bytes,
 * so the stream's end is the smallest prefix that inflates to exactly
 * `expectedSize` bytes — found by binary search.
 */
function inflateExact(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  const tryLen = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(offset, offset + len));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  // Bracket the stream's end by doubling from a size guess, then bisect
  // inside the bracket for the smallest prefix that inflates fully.
  const remaining = buf.length - offset;
  let hi = Math.min(remaining, Math.max(64, expectedSize + 16));
  while (tryLen(hi) === null) {
    if (hi >= remaining) throw new Error('corrupt zlib stream in pack');
    hi = Math.min(remaining, hi * 2);
  }
  let lo = Math.max(1, Math.floor(hi / 2));
  if (tryLen(lo) !== null) {
    // The end sits inside the first bracket already: bisect [1, lo].
    let a = 1;
    let b = lo;
    while (a < b) {
      const mid = Math.floor((a + b) / 2);
      if (tryLen(mid) !== null) b = mid;
      else a = mid + 1;
    }
    const data = tryLen(a);
    if (data === null) throw new Error('corrupt zlib stream in pack');
    return { data, next: offset + a };
  }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tryLen(mid) !== null) hi = mid;
    else lo = mid;
  }
  const data = tryLen(hi);
  if (data === null) throw new Error('corrupt zlib stream in pack');
  return { data, next: offset + hi };
}

/** Apply a git delta (copy/insert instruction stream) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { off += delta[pos] * 2 ** (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size += delta[pos] * 2 ** (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      written += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (written !== dstSize || result.length !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackEntry {
  sha: string;
  type: ObjType;
  data: Buffer;
}

/**
 * Parse a packfile and store every object it carries. Bases for deltas
 * come from the pack itself or, for thin packs, from the store. Returns
 * the entries in pack order.
 */
export function ingestPack(pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum mismatch');

  let pos = 12;
  const pending: { type: ObjType; data: Buffer }[] = [];
  const byOffset = new Map<number, PackEntry>();
  const entries: PackEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    const entryOffset = pos;
    let byte = pack[pos];
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }

    if (typeCode === 6) {
      // OFS_DELTA: a negative-offset varint names the base entry.
      let b = pack[pos];
      pos += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos];
        pos += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const { data, next } = inflateExact(pack, pos, size);
      pos = next;
      const baseEntry = byOffset.get(entryOffset - back);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const full = applyDelta(baseEntry.data, data);
      const sha = storeObject(baseEntry.type, full);
      const entry = { sha, type: baseEntry.type, data: full };
      byOffset.set(entryOffset, entry);
      entries.push(entry);
      continue;
    }

    if (typeCode === 7) {
      // REF_DELTA: a 20-byte base id names the base object.
      const baseSha = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const { data, next } = inflateExact(pack, pos, size);
      pos = next;
      let baseEntry = entries.find((e) => e.sha === baseSha);
      if (!baseEntry) {
        const stored = getObject(baseSha);
        if (!stored) throw new Error('ref-delta base is unknown');
        baseEntry = { sha: baseSha, type: stored.type, data: stored.data };
      }
      const full = applyDelta(baseEntry.data, data);
      const sha = storeObject(baseEntry.type, full);
      const entry = { sha, type: baseEntry.type, data: full };
      byOffset.set(entryOffset, entry);
      entries.push(entry);
      continue;
    }

    const type = TYPE_CODES[typeCode];
    if (!type) throw new Error(`unknown pack object type ${typeCode}`);
    const { data, next } = inflateExact(pack, pos, size);
    pos = next;
    const sha = storeObject(type, data);
    const entry = { sha, type, data };
    byOffset.set(entryOffset, entry);
    entries.push(entry);
    void pending;
  }
  return entries;
}

/** Build a packfile holding the given objects, plain (no deltas). */
export function buildPack(shas: string[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(shas.length, 8);
  parts.push(head);
  for (const sha of shas) {
    const obj = getObject(sha);
    if (!obj) throw new Error(`cannot pack unknown object ${sha}`);
    const code = CODE_BY_TYPE[obj.type];
    let size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size = Math.floor(size / 128);
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The sha an object WOULD have, without storing it (delta bookkeeping). */
export function wouldHash(type: ObjType, data: Buffer): string {
  return hashObject(type, data);
}
