import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyOut, sellOut, applyBuy, applySell, fillReserves, PADS } from '../src/curve.mjs';
import { makeTracker } from '../src/features.mjs';
import { decide, safetyVetoes, DEFAULT_PARAMS, FILTERS } from '../src/rules.mjs';
import { simulateTrade, POLICIES, DEFAULT_COSTS } from '../src/sim.mjs';
import { runPortfolio, score, fullBacktest, rng, scanCoin } from '../src/backtest.mjs';
import { fakeDataset, fakeCoin } from '../src/fake.mjs';
import { validateCoin } from '../src/data.mjs';

const MIN = 60_000, T0 = Date.UTC(2026, 9, 1);
const cfg = PADS.pump;

// Build a coin from a list of [minute, side, sol-or-token-fraction, wallet] with exact curve reserves.
function coinFrom(steps, extra = {}) {
  let r = { vSol: cfg.vSol0, vTok: cfg.vTok0 }; const hold = new Map(), trades = [];
  for (const [m, side, amt, wallet = 'w' + trades.length] of steps) {
    const t = T0 + m * MIN;
    if (side === 'buy') { const n = applyBuy(r, amt, cfg.fee); r = n; hold.set(wallet, (hold.get(wallet) || 0) + n.out); trades.push({ t, wallet, side, sol: amt, tokens: n.out, vSol: n.vSol, vTok: n.vTok }); }
    else { const tok = (hold.get(wallet) || 0) * amt, n = applySell(r, tok, cfg.fee); r = n; hold.set(wallet, (hold.get(wallet) || 0) - tok); trades.push({ t, wallet, side, sol: n.out, tokens: tok, vSol: n.vSol, vTok: n.vTok }); }
  }
  return { mint: 'm', pad: 'pump', creator: 'dev', createdAt: T0, provenance: true, mintInfo: { mintAuthority: null, freezeAuthority: null, extensions: [] }, trades, ...extra };
}

test('curve: buy then sell of the same tokens loses about two fees, never profits', () => {
  const tok = buyOut(30, cfg.vTok0, 1, 0.01), r = applyBuy({ vSol: 30, vTok: cfg.vTok0 }, 1, 0.01);
  const back = sellOut(r.vSol, r.vTok, tok, 0.01);
  assert.ok(back < 1 && back > 0.97, String(back));
});

test('curve: fillReserves rebuilds reserves that match the exact trade path', () => {
  const c = coinFrom([[1, 'buy', 2, 'a'], [2, 'buy', 1, 'b'], [3, 'sell', 0.5, 'a']]);
  const exact = c.trades.map(t => [t.vSol, t.vTok]);
  for (const t of c.trades) { delete t.vSol; delete t.vTok; }
  fillReserves(c);
  c.trades.forEach((t, i) => { assert.ok(Math.abs(t.vSol - exact[i][0]) < 1e-9); assert.ok(Math.abs(t.vTok - exact[i][1]) < 1e-3); });
});

test('features: no lookahead (later trades never change features at an earlier time)', () => {
  const coins = fakeDataset({ n: 30, days: 1, seed: 3 });
  for (const c of coins) {
    const t = c.createdAt + 10 * MIN;
    const full = makeTracker(c).featuresAt(t);
    const cut = { ...c, trades: c.trades.filter(x => x.t <= t) };
    const part = makeTracker(cut).featuresAt(t);
    assert.deepEqual(part, full);
  }
});

test('features: top 10, dev share, bundle share and organic share', () => {
  const c = coinFrom([[0, 'buy', 3, 'dev'], [0, 'buy', 2, 'x1'], [1, 'buy', 1, 'a'], [2, 'buy', 1, 'x1'], [3, 'sell', 1, 'x1']],
    { funding: { x1: 'dev', a: 'cex1' } });
  c.trades[0].slot = c.trades[1].slot = 100; c.createdSlot = 100; c.trades.slice(2).forEach((t, i) => (t.slot = 200 + i));
  const f = makeTracker(c).featuresAt(T0 + 5 * MIN);
  assert.ok(f.devShare > 0.05 && f.devShare < 0.15);
  assert.ok(f.bundleShare > f.devShare);           // dev + x1 bought in the creation slot
  assert.ok(f.organicShare < 1);                   // x1 is dev-funded and bought and sold
  assert.equal(f.holders, 2);                      // x1 sold out
});

test('rules: safety vetoes cannot be switched off', () => {
  const c = coinFrom([[0, 'buy', 1]], { mintInfo: { freezeAuthority: 'x', extensions: ['transferHook'] }, pad: 'other' });
  const v = safetyVetoes(c);
  assert.deepEqual(v, ['launchpad', 'freezeAuthority', 'ext:transferHook']);
  const all = new Set(FILTERS.map(f => f[0]));
  assert.equal(decide({}, c, DEFAULT_PARAMS, all).buy, false);
});

test('sim: stop loss fires on the first trade below the stop', () => {
  const c = coinFrom([[0, 'buy', 10, 'a'], [5, 'sell', 1, 'a'], [6, 'buy', 0.1]]);
  const r = simulateTrade(c, T0 + 1 * MIN, 0.1, POLICIES.runner, { ...DEFAULT_COSTS, rugDrop: 0.99 });
  assert.equal(r.reason, 'stop'); assert.ok(r.ret < -0.25);
});

test('sim: take profit sells half, trailing stop sells the rest', () => {
  const steps = [[0, 'buy', 1, 'base']];
  for (let i = 1; i <= 20; i++) steps.push([i, 'buy', 1.5, 'b' + i]);       // price runs up
  for (let i = 21; i <= 30; i++) steps.push([i, 'sell', 1, 'b' + (i - 20)]); // then gives back
  const r = simulateTrade(coinFrom(steps), T0 + 0.5 * MIN, 0.1, POLICIES.runner, { ...DEFAULT_COSTS, rugDrop: 0.99 });
  assert.equal(r.reason, 'trail'); assert.equal(r.txs, 3); assert.ok(r.pnl > 0);
});

test('sim: a rug while holding counts as -100% of what is still held', () => {
  const c = coinFrom([[0, 'buy', 20, 'dev'], [1, 'buy', 1, 'a'], [3, 'sell', 1, 'dev']]);
  const r = simulateTrade(c, T0 + 2 * MIN, 0.1);
  assert.equal(r.reason, 'rug'); assert.ok(r.rug && r.rugSeen); assert.ok(r.ret <= -1);
});

test('sim: no trades after entry exits on the time rule at the last price', () => {
  const c = coinFrom([[0, 'buy', 1]]);
  const r = simulateTrade(c, T0 + 1 * MIN, 0.1);
  assert.equal(r.reason, 'quiet'); assert.equal(r.exitT, T0 + 61 * MIN);
});

test('portfolio: daily loss cap stops new entries for the rest of the day', () => {
  const losers = [];
  const coins = new Map();
  for (let i = 0; i < 6; i++) {
    const c = coinFrom([[0, 'buy', 20, 'dev'], [1, 'buy', 1, 'a'], [2, 'sell', 1, 'dev']], { mint: 'L' + i, createdAt: T0 + i * 10 * MIN });
    c.trades.forEach(t => (t.t += i * 10 * MIN)); coins.set(c.mint, c);
    losers.push({ mint: c.mint, t: c.createdAt + 1.5 * MIN });
  }
  const run = runPortfolio(losers, coins, POLICIES.runner, DEFAULT_COSTS, { bankroll: 10, sizeFrac: 0.05, maxTradesPerDay: 15, maxOpen: 10, dailyLossCap: 0.1, tzOffsetMin: 0 });
  assert.equal(run.trades.length, 2);               // 2 × −5% hits the 10% cap
  assert.equal(run.skipped.lossCap, 4);
  const s = score(run);
  assert.equal(s.greenDays, 0); assert.ok(s.worstDayPct <= -0.1);
});

test('end to end on fake data: deterministic and rules beat random coins', () => {
  const coins = fakeDataset({ n: 600, days: 7, seed: 11 });
  const a = fullBacktest(coins, { filterNames: ['top10'] }), b = fullBacktest(coins, { filterNames: ['top10'] });
  assert.deepEqual(a, b);
  assert.ok(a.signals > 0);
  assert.ok(a.styles.runner.avgDailyPct > a.baseline.runner.avgDailyPct);
  assert.ok(!a.styles.runner.trades || a.styles.runner.rugRate < 0.05);
});

test('scanCoin: switching a filter off never removes an entry and never delays it', () => {
  const coins = fakeDataset({ n: 200, days: 2, seed: 5 });
  for (const c of coins) {
    const [base, off] = scanCoin(c, DEFAULT_PARAMS, [null, new Set(['buyers'])]);
    if (base) { assert.ok(off); assert.ok(off.t <= base.t); }
  }
});

test('data: validation catches broken coins', () => {
  assert.deepEqual(validateCoin({ mint: 'x', createdAt: 1, trades: [{ t: 1, wallet: 'w', side: 'buy', sol: 1, tokens: 1 }] }), []);
  assert.deepEqual(validateCoin({ mint: 'x', createdAt: 1, trades: [{ t: 1, wallet: 'w', side: 'hodl', sol: 1, tokens: 1 }] }), ['trade']);
  assert.ok(validateCoin({}).length >= 2);
  assert.equal(typeof rng(1)(), 'number');
  assert.ok(fakeCoin(rng(1), 0, T0, 'honeypot').mintInfo.freezeAuthority);
});
