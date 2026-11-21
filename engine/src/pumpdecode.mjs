// Decode Pumpfun events from transactions (logs "Program data:" and self-CPI event instructions).
// Layouts are from memory of the Pumpfun IDL: only the fixed prefix is read. VERIFY with `backfill --check`
// against a block explorer before trusting real-data results.
import { createHash } from 'node:crypto';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// Pumpfun's mint authority: touched by create transactions only, so its history lists launches.
export const PUMP_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

const disc = name => createHash('sha256').update('event:' + name).digest().subarray(0, 8);
export const DISC = { trade: disc('TradeEvent'), create: disc('CreateEvent') };
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex'); // Anchor emit_cpi! instruction prefix

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
export function b58decode(str) {
  let n = 0n; for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const lead = str.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), n > 0n ? Buffer.from(hex, 'hex') : Buffer.alloc(0)]);
}

class Reader {
  constructor(b) { this.b = b; this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new Error('short'); }
  pk() { this.need(32); const v = b58encode(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { this.need(8); const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  bool() { this.need(1); return this.b[this.o++] !== 0; }
  str() { this.need(4); const n = this.b.readUInt32LE(this.o); this.o += 4; this.need(n); const v = this.b.subarray(this.o, this.o + n).toString('utf8'); this.o += n; return v; }
}

export function decodeEvent(buf) {
  if (buf.length < 8) return null;
  const d = buf.subarray(0, 8), r = new Reader(buf.subarray(8));
  try {
    if (d.equals(DISC.trade)) {
      const mint = r.pk(), sol = r.u64(), tok = r.u64(), isBuy = r.bool(), user = r.pk(), ts = r.i64();
      const vSol = r.u64(), vTok = r.u64();
      return { kind: 'trade', mint, user, side: isBuy ? 'buy' : 'sell', sol: Number(sol) / 1e9, tokens: Number(tok) / 1e6,
        ts: Number(ts) * 1000, vSol: Number(vSol) / 1e9, vTok: Number(vTok) / 1e6 };
    }
    if (d.equals(DISC.create)) {
      const name = r.str(), symbol = r.str(), uri = r.str(), mint = r.pk(), bondingCurve = r.pk(), user = r.pk();
      return { kind: 'create', name, symbol, uri, mint, bondingCurve, user };
    }
  } catch { return null; }
  return null;
}

// All Pumpfun events in a getTransaction (encoding "json") result, in order.
export function eventsFromTx(tx) {
  const out = [];
  for (const line of tx?.meta?.logMessages || []) {
    const m = /^Program data: (.+)$/.exec(line);
    if (m) { const e = decodeEvent(Buffer.from(m[1], 'base64')); if (e) out.push(e); }
  }
  for (const group of tx?.meta?.innerInstructions || []) for (const ix of group.instructions || []) {
    if (!ix.data) continue;
    let b; try { b = b58decode(ix.data); } catch { continue; }
    if (b.length > 16 && b.subarray(0, 8).equals(EVENT_IX_TAG)) { const e = decodeEvent(b.subarray(8)); if (e) out.push(e); }
  }
  // The same event can appear in both places; keep one copy.
  const seen = new Set();
  return out.filter(e => { const k = JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Encoders, used by tests and the fake RPC (same layout as the decoder).
export function encodeTrade(e) {
  const b = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8); let o = 0;
  DISC.trade.copy(b, o); o += 8; b58decode(e.mint).copy(b, o); o += 32;
  b.writeBigUInt64LE(BigInt(Math.round(e.sol * 1e9)), o); o += 8; b.writeBigUInt64LE(BigInt(Math.round(e.tokens * 1e6)), o); o += 8;
  b[o++] = e.side === 'buy' ? 1 : 0; b58decode(e.user).copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(Math.floor(e.ts / 1000)), o); o += 8;
  b.writeBigUInt64LE(BigInt(Math.round(e.vSol * 1e9)), o); o += 8; b.writeBigUInt64LE(BigInt(Math.round(e.vTok * 1e6)), o);
  return b;
}
export function encodeCreate(e) {
  const s = x => { const v = Buffer.from(x, 'utf8'), l = Buffer.alloc(4); l.writeUInt32LE(v.length); return Buffer.concat([l, v]); };
  return Buffer.concat([DISC.create, s(e.name), s(e.symbol), s(e.uri), b58decode(e.mint), b58decode(e.bondingCurve), b58decode(e.user)]);
}
