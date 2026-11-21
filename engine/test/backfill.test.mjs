import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { b58encode, b58decode, encodeTrade, encodeCreate, eventsFromTx, decodeEvent, PUMP_MINT_AUTHORITY } from '../src/pumpdecode.mjs';
import { makeRpc, listLaunches, samplePerDay, fetchCoin } from '../src/backfill.mjs';
import { fakeCoin } from '../src/fake.mjs';
import { rng, fullBacktest } from '../src/backtest.mjs';

const key = s => b58encode(createHash('sha256').update(s).digest());
const T0 = Date.UTC(2026, 9, 1);

test('base58 round trip and event round trip', () => {
  for (const s of ['a', 'b', 'zz']) { const k = key(s); assert.equal(b58encode(b58decode(k)), k); assert.equal(b58decode(k).length, 32); }
  const e = { mint: key('m'), user: key('u'), side: 'buy', sol: 1.25, tokens: 123456.5, ts: T0, vSol: 31.2, vTok: 1_030_000_000.25 };
  const d = decodeEvent(encodeTrade(e));
  assert.equal(d.kind, 'trade'); assert.equal(d.mint, e.mint); assert.equal(d.user, e.user); assert.equal(d.side, 'buy');
  assert.equal(d.sol, 1.25); assert.equal(d.tokens, 123456.5); assert.equal(d.vSol, 31.2);
  const c = decodeEvent(encodeCreate({ name: 'Dog', symbol: 'DOG', uri: 'ipfs://x', mint: key('m'), bondingCurve: key('bc'), user: key('dev') }));
  assert.equal(c.kind, 'create'); assert.equal(c.symbol, 'DOG'); assert.equal(c.bondingCurve, key('bc'));
  assert.equal(decodeEvent(Buffer.from('nonsense-nonsense')), null);
});

// A fake chain built from fake coins, served as a JSON-RPC endpoint.
function fakeChain(coins) {
  const txs = new Map(), byAddr = new Map(), add = (a, s) => (byAddr.get(a) || byAddr.set(a, []).get(a)).push(s);
  const launches = [];
  coins.forEach((c, ci) => {
    const mint = key('mint' + ci), bc = key('bc' + ci), dev = key(c.creator);
    const csig = key('create' + ci), cslot = Math.floor(c.createdAt / 400);
    const devBuy = c.trades[0];
    txs.set(csig, { slot: cslot, blockTime: Math.floor(c.createdAt / 1000), meta: { err: null, logMessages: [
      'Program data: ' + encodeCreate({ name: 'C' + ci, symbol: 'C' + ci, uri: '', mint, bondingCurve: bc, user: dev }).toString('base64'),
      'Program data: ' + encodeTrade({ ...devBuy, mint, user: dev, ts: devBuy.t }).toString('base64')] } });
    const cs = { signature: csig, slot: cslot, blockTime: Math.floor(c.createdAt / 1000), err: null, seq: 0 };
    add(PUMP_MINT_AUTHORITY, cs); launches.push({ mint, ci });
    c.trades.slice(1).forEach((t, ti) => {
      const sig = key(`t${ci}_${ti}`), data = encodeTrade({ ...t, mint, user: key(t.wallet), ts: t.t });
      const viaCpi = ti % 3 === 0; // some events only in the self-CPI instruction, like newer Pumpfun versions
      txs.set(sig, { slot: Math.floor(t.t / 400), blockTime: Math.floor(t.t / 1000), meta: { err: null,
        logMessages: viaCpi ? [] : ['Program data: ' + data.toString('base64')],
        innerInstructions: viaCpi ? [{ index: 0, instructions: [{ data: b58encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), data])) }] }] : [] } });
      add(bc, { signature: sig, slot: Math.floor(t.t / 400), blockTime: Math.floor(t.t / 1000), err: null, seq: ti + 1 });
    });
    add(bc, cs);
  });
  for (const list of byAddr.values()) list.sort((a, b) => b.slot - a.slot || b.seq - a.seq); // newest first, in-slot order kept
  let calls = 0, threw429 = false;
  const handle = (method, params) => {
    if (method === 'getTransaction') return txs.get(params[0]) || null;
    if (method === 'getAccountInfo') return { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } };
    if (method === 'getSignaturesForAddress') {
      const [addr, o] = params; let list = byAddr.get(addr) || [];
      if (o.before) list = list.slice(list.findIndex(s => s.signature === o.before) + 1);
      if (o.until) { const i = list.findIndex(s => s.signature === o.until); if (i >= 0) list = list.slice(0, i); }
      return list.slice(0, o.limit || 1000);
    }
    throw new Error('unknown ' + method);
  };
  const fetchImpl = async (url, { body }) => {
    calls++;
    if (!threw429 && calls === 3) { threw429 = true; return { status: 429, json: async () => ({}) }; }
    const { id, method, params } = JSON.parse(body);
    return { status: 200, json: async () => ({ jsonrpc: '2.0', id, result: handle(method, params) }) };
  };
  return { fetchImpl, launches, calls: () => calls };
}

test('backfill: fake chain → coins with the same trades, reserves and mint checks', async () => {
  const rand = rng(4);
  const src = ['runner', 'rug', 'dud'].map((type, i) => fakeCoin(rand, i, T0 + i * 3_600_000, type));
  const chain = fakeChain(src);
  const rpc = makeRpc('http://fake', { rps: 1000, fetchImpl: chain.fetchImpl });
  const launches = await listLaunches(rpc, { fromMs: T0 - 1, toMs: T0 + 86_400_000 });
  assert.equal(launches.length, 3);
  const picked = samplePerDay(launches, 10);
  for (let i = 0; i < picked.length; i++) {
    const coin = await fetchCoin(rpc, picked[i], { windowMin: 100000 });
    const s = src[i];
    assert.equal(coin.trades.length, s.trades.length, `coin ${i}`);
    coin.trades.forEach((t, k) => {
      assert.equal(t.side, s.trades[k].side);
      assert.ok(Math.abs(t.sol - s.trades[k].sol) < 1e-8);
      assert.ok(Math.abs(t.vSol - s.trades[k].vSol) < 1e-8);
    });
    assert.deepEqual(coin.mintInfo.extensions, []);
    assert.equal(coin.creator, key(s.creator));
  }
  assert.ok(chain.calls() > 3); // includes one 429 that was retried
});

test('backfill: window cuts trades after the holding window', async () => {
  const src = [fakeCoin(rng(9), 0, T0, 'runner')];
  const rpc = makeRpc('http://fake', { rps: 1000, fetchImpl: fakeChain(src).fetchImpl });
  const [l] = await listLaunches(rpc, { fromMs: T0 - 1, toMs: T0 + 86_400_000 });
  const coin = await fetchCoin(rpc, l, { windowMin: 30 });
  assert.ok(coin.trades.length > 0 && coin.trades.length < src[0].trades.length);
  assert.ok(coin.trades.every(t => t.t <= T0 + 30 * 60_000 + 1000));
  const r = fullBacktest([coin]);
  assert.equal(r.coins, 1);
});
