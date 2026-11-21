// Backfill past Pumpfun launches from a Solana RPC (Helius) into the engine's JSON Lines format.
// Bonk and Stonk.fun need their own decoders (not done yet: their event layouts must be confirmed first).
import { eventsFromTx, PUMP_MINT_AUTHORITY } from './pumpdecode.mjs';
import { rng } from './backtest.mjs';

const DAY = 86_400_000, MIN = 60_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// JSON-RPC client with a request-rate limit and retries on 429 / 5xx / network errors.
export function makeRpc(url, { rps = 8, fetchImpl = globalThis.fetch, maxRetries = 6, onStat = () => {} } = {}) {
  const gap = 1000 / rps; let next = 0, id = 0;
  return async function call(method, params) {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now(), at = Math.max(now, next); next = at + gap; if (at > now) await sleep(at - now);
      let res, body;
      try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
        body = res.status === 200 ? await res.json() : null;
      } catch (e) { res = { status: 0 }; }
      onStat(method, res.status);
      if (body && !body.error) return body.result;
      const retriable = !body || res.status === 429 || res.status >= 500 || res.status === 0 || body.error?.code === -32005;
      if (!retriable || attempt >= maxRetries) throw new Error(`${method} failed: ${res.status} ${body?.error?.message || ''}`.trim());
      await sleep(Math.min(30_000, 500 * 2 ** attempt));
    }
  };
}

// Launch signatures between fromMs and toMs (newest first from the chain, returned oldest first).
export async function listLaunches(rpc, { fromMs, toMs, max = Infinity, log = () => {} }) {
  const out = []; let before;
  while (out.length < max) {
    const page = await rpc('getSignaturesForAddress', [PUMP_MINT_AUTHORITY, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!page || !page.length) break;
    for (const s of page) {
      const t = (s.blockTime || 0) * 1000;
      if (!s.err && t >= fromMs && t < toMs) out.push({ signature: s.signature, t, slot: s.slot });
    }
    before = page[page.length - 1].signature;
    const oldest = (page[page.length - 1].blockTime || 0) * 1000;
    log(`launch list: ${out.length} (back to ${new Date(oldest).toISOString()})`);
    if (oldest < fromMs) break;
  }
  return out.reverse();
}

// Even sample per UTC day, seeded so a rerun picks the same coins.
export function samplePerDay(launches, perDay, seed = 1) {
  const rand = rng(seed), byDay = new Map();
  for (const l of launches) { const d = Math.floor(l.t / DAY); (byDay.get(d) || byDay.set(d, []).get(d)).push(l); }
  const out = [];
  for (const list of byDay.values()) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    out.push(...a.slice(0, perDay));
  }
  return out.sort((x, y) => x.t - y.t);
}

const TX_OPTS = { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' };
const EXT_MAP = { transferHook: 'transferHook', permanentDelegate: 'permanentDelegate', nonTransferable: 'nonTransferable',
  defaultAccountState: 'defaultAccountState', pausableConfig: 'pausable', pausable: 'pausable' };

export async function fetchCoin(rpc, launch, { windowMin = 360, concurrency = 4 } = {}) {
  const ctx = await rpc('getTransaction', [launch.signature, TX_OPTS]);
  const create = eventsFromTx(ctx).find(e => e.kind === 'create');
  if (!create) return { error: 'noCreateEvent', signature: launch.signature };
  const createdAt = (ctx.blockTime || launch.t / 1000) * 1000, end = createdAt + windowMin * MIN;

  // Bonding-curve history from now back to the launch (stops at the create signature).
  const sigs = []; let before;
  for (;;) {
    const page = await rpc('getSignaturesForAddress', [create.bondingCurve, { limit: 1000, until: launch.signature, ...(before ? { before } : {}) }]);
    if (!page || !page.length) break;
    sigs.push(...page); before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  const wanted = sigs.filter(s => !s.err && (s.blockTime || 0) * 1000 <= end).reverse();
  wanted.unshift({ signature: launch.signature, slot: ctx.slot, blockTime: ctx.blockTime }); // launch tx can hold the dev buy

  const txs = new Array(wanted.length); let k = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (k < wanted.length) { const i = k++; txs[i] = i === 0 ? ctx : await rpc('getTransaction', [wanted[i].signature, TX_OPTS]); }
  }));
  const trades = [];
  txs.forEach((tx, i) => {
    if (!tx) return;
    for (const e of eventsFromTx(tx)) if (e.kind === 'trade' && e.mint === create.mint) {
      trades.push({ t: (tx.blockTime || wanted[i].blockTime) * 1000, slot: tx.slot, wallet: e.user, side: e.side, sol: e.sol, tokens: e.tokens, vSol: e.vSol, vTok: e.vTok, sig: wanted[i].signature });
    }
  });

  let mintInfo = null;
  try {
    const acc = await rpc('getAccountInfo', [create.mint, { encoding: 'jsonParsed' }]);
    const info = acc?.value?.data?.parsed?.info;
    if (info) mintInfo = {
      mintAuthority: info.mintAuthority || null, freezeAuthority: info.freezeAuthority || null,
      program: acc.value.owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'token2022' : 'spl',
      extensions: (info.extensions || []).map(x => EXT_MAP[x.extension]).filter(Boolean),
      transferFeeBps: (info.extensions || []).find(x => x.extension === 'transferFeeConfig')?.state?.newerTransferFee?.transferFeeBasisPoints || 0,
    };
  } catch { /* leave null: the report counts coins without mint checks */ }

  return {
    mint: create.mint, pad: 'pump', name: create.name, symbol: create.symbol, creator: create.user,
    createdAt, createdSlot: ctx.slot, provenance: true, mintInfo, bondingCurve: create.bondingCurve,
    windowMin, txCount: wanted.length, trades,
  };
}
