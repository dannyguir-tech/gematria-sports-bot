// Offline regression tests for the pure VTCore block of voltrak-steroids.user.js. Run: node --test test/
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../voltrak-steroids.user.js', import.meta.url), 'utf8');
const V = new Function(src.slice(src.indexOf('/* CORE START'), src.indexOf('/* CORE END */')) + '\nreturn VTCore;')();

const MIN = 60000, T0 = Date.UTC(2026, 9, 20, 12, 0, 30); // alert 30s into a minute
const candle = (min, o, h, l, c, v = 1) => ({t: Math.floor(T0 / MIN) * MIN + min * MIN, o, h, l, c, v});
const rng = seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

test('parseAlert reads the labelled contract and call fields', () => {
  const ca = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const a = V.parseAlert('Dog Coin ($DOG)\nMC\n$24.5K\nAge\n12m 30s\nBonding Curve\nNot migrated\nCA: ' + ca + '\n#1 holder: 3.2%\nCluster 1: 12.5%\nTotal Holders: 1,204');
  assert.equal(a.mint, ca);
  assert.equal(a.callMc, 24500);
  assert.equal(a.ageSeconds, 750);
  assert.equal(a.migrated, false);
  assert.deepEqual(a.clusters, [12.5]);
  assert.equal(a.holders, 1204);
});

// Six real buyers and six real sellers, plus 20 same-transaction wash round trips that dwarf them.
function washTape(now) {
  const t0 = now - 50000, trades = [];
  for (let i = 0; i < 6; i++) trades.push({at: t0 + i * 1000, side: 'buy', usd: 100, amount: 1000, wallet: 'R' + i, hash: 'r' + i, ex: 'pump'});
  for (let i = 0; i < 6; i++) trades.push({at: t0 + 7000 + i * 1000, side: 'sell', usd: 50, amount: 500, wallet: 'S' + i, hash: 's' + i, ex: 'pump'});
  for (let i = 0; i < 20; i++) trades.push({at: t0 + i * 2000, side: 'buy', usd: 200, amount: 2000, wallet: 'B' + i % 3, hash: 'w' + i, ex: 'pump'},
    {at: t0 + i * 2000, side: 'sell', usd: 200, amount: 2000, wallet: 'B' + i % 3, hash: 'w' + i, ex: 'pump'});
  return {trades, since: t0 - 1000};
}

test('botFlow separates organic flow from wash and arbitrage legs', () => {
  const now = T0, {trades} = washTape(now);
  trades.push({at: now - 1000, side: 'buy', usd: 300, amount: 10, wallet: 'A', hash: 'arb', ex: 'pump'}, {at: now - 1000, side: 'sell', usd: 310, amount: 10, wallet: 'A', hash: 'arb', ex: 'pump_amm'});
  const vb = V.botFlow(trades, now - 300000, now);
  assert.equal(vb.arb, 1);
  assert.equal(vb.orgN, 12);
  assert.ok(vb.organic.every(t => /^[RS]/.test(t.wallet)));
  assert.equal(vb.orgShare.toFixed(1), (100 * 600 / 900).toFixed(1));
});

test('assess reads the gauge from organic flow and flags heavy bot volume', () => {
  const now = T0, {trades, since} = washTape(now), vb = V.botFlow(trades, now - 300000, now);
  const raw = V.assess(null, null, now, '', null, V.liveView(trades, null, now, now, since));
  const org = V.assess(null, null, now, '', null, V.liveView(trades, null, now, now, since, vb));
  assert.ok(Math.abs(raw.share - 50) < 5, 'wash trades drag the unfiltered gauge to ~50%');
  assert.equal(org.share.toFixed(1), '66.7');
  assert.match(org.basis, /organic/);
  assert.ok(org.flags.some(f => /Bot-like trades are 9\d%/.test(f)));
});

test('assess falls back to GMGN rollup when organic flow is too thin', () => {
  const now = T0, few = [{at: now - 5000, side: 'buy', usd: 50, amount: 1, wallet: 'X', hash: 'x', ex: 'pump'}];
  const stat = {at: now, price: 2e-5, m1: {buys: 20, sells: 10, buyUsd: 700, sellUsd: 300, priceAgo: 1e-5}, m5: {}};
  const a = V.assess(null, null, now, '', null, V.liveView(few, stat, now, now, now - 10000, V.botFlow(few, now - 300000, now)));
  assert.equal(a.basis, 'GMGN 1m $ volume');
  assert.equal(Math.round(a.share), 70);
  assert.equal(Math.round(a.momentum), 100);
});

test('assess ignores a token_stat price-then that is nowhere near the price', () => {
  const now = T0, stat = {at: now, price: 2e-5, m1: {buys: 20, sells: 10, buyUsd: 700, sellUsd: 300, priceAgo: 12.5}, m5: {}};
  const a = V.assess(null, null, now, '', null, V.liveView([], stat, now, now, now - 10000));
  assert.equal(a.momentum, null);
});

test('scoreCall: stop before target inside one candle; gap fills at the open', () => {
  const cs = [candle(0, 1, 1, 1, 1), candle(1, 1, 2.5, 0.4, 1)];
  assert.equal(V.scoreCall(cs, T0).outcome, 'loss');
  const gap = V.scoreCall([candle(0, 1, 1, 1, 1), candle(1, 0.3, 0.35, 0.2, 0.25)], T0);
  assert.equal(Math.round(gap.ret), -70);
});

test('scoreCall trailing exit uses only earlier highs', () => {
  // +80% high in minute 1; minute 2 falls to +20%: 30% below the 1.8 peak is 1.26, so it sells there (+26%).
  const cs = [candle(0, 1, 1, 1, 1), candle(1, 1, 1.8, 1, 1.7), candle(2, 1.7, 1.7, 1.2, 1.3), candle(3, 1.3, 2.2, 1.3, 2.1)];
  const trailed = V.scoreCall(cs, T0, {trail: {arm: 50, drop: 30}}), plain = V.scoreCall(cs, T0);
  assert.equal(trailed.outcome, 'exit');
  assert.equal(Math.round(trailed.ret), 26);
  assert.equal(plain.outcome, 'win');
  // One candle that spikes to +80% and falls back cannot trail itself out: its own high is not yet "earlier".
  const spike = [candle(0, 1, 1, 1, 1), candle(1, 1, 1.8, 1.1, 1.15)];
  assert.equal(V.scoreCall(spike, T0, {trail: {arm: 50, drop: 30}}).outcome, 'open');
});

test('preAlert gives the pre-alert close and a run-up only when the cache reaches back', () => {
  const cs = [candle(-14, 1, 1.1, 1, 1.1), candle(-5, 1.5, 2, 1.5, 2), candle(-1, 2, 2.6, 2, 2.5), candle(0, 2.5, 3, 2.5, 3)];
  const p = V.preAlert(cs, T0, true);
  assert.equal(p.close, 2.5);
  assert.equal(Math.round(p.runUp15), 150);
  assert.equal(V.preAlert(cs, T0, false).runUp15, null);
  assert.deepEqual(V.preAlert([candle(0, 1, 1, 1, 1)], T0, true), {close: null, runUp15: null});
});

test('tFor matches t tables', () => {
  assert.ok(Math.abs(V.zFor(0.025) - 1.96) < 1e-3);
  assert.ok(Math.abs(V.tFor(0.025, 10) - 2.228) < 0.01);
  assert.ok(Math.abs(V.tFor(0.0005, 14) - 4.140) < 0.03);
});

function fakeItems(r, n, planted) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const mv = r() * 40 - 5, win = r() < (planted && mv >= 25 ? 0.1 : 0.3);
    items.push({call: {clusters: [r() * 40], holders: 100 + r() * 1500, bots: r() * 600, fresh: r() * 600, topHolder: r() * 8, callMc: 5000 + r() * 80000, ageSeconds: r() * 7200,
      experienced: Math.floor(r() * 8), snipers: Math.floor(r() * 3), migrated: r() < 0.3, messageAt: T0 + r() * 864e5, entryMove: mv, runUp15: r() * 300 - 20},
    score: {outcome: win ? 'win' : 'loss', ret: win ? 100 : -50, peakPct: 0, peakMin: 0, r5: 0, r15: 0, r60: 0}});
  }
  return items;
}

test('backtestReport rarely finds edges in data with none', () => {
  const r = rng(11);
  let false_ = 0;
  for (let k = 0; k < 200; k++) if (V.backtestReport(fakeItems(r, 200, false), 5).features.some(f => f.rows.some(x => x.standsOut))) false_++;
  assert.ok(false_ / 200 < 0.12, 'false-find rate ' + false_ / 200);
});

// Win rate 30% → 10% in the quarter of calls with the biggest move into entry. With ~40 buckets tested this is found
// in ~60% of 200-call reports and ~93% of 400-call ones: the price of not crowning noise.
test('backtestReport still finds a real planted effect at 400 calls', () => {
  const r = rng(5);
  let found = 0;
  for (let k = 0; k < 50; k++) {
    const f = V.backtestReport(fakeItems(r, 400, true), 5).features.find(x => x.name === 'Move into entry');
    if (f.rows.find(x => x.label === '≥25%')?.standsOut === 'below') found++;
  }
  assert.ok(found / 50 > 0.7, 'power ' + found / 50);
});

test('backtestReport labels boolean and hour buckets', () => {
  const rep = V.backtestReport(fakeItems(rng(3), 60, false), 0), names = n => rep.features.find(f => f.name === n).rows.map(r => r.label);
  assert.deepEqual(names('Migrated at call').sort(), ['no', 'yes']);
  assert.ok(names('Hour of call (UTC)').every(l => /^(<6:00|6:00–12:00|12:00–18:00|≥18:00)$/.test(l)));
});

// ---- 4.4 ----
test('pricePath: price N seconds after the alert, volume-weighted, on the candle scale', () => {
  const A = Date.UTC(2026, 9, 20, 12, 0, 20), row = (s, sol, amount) => ({at: A + s * 1000, sol, amount});
  // Pre-alert price 1e-7 SOL/token; +50% by 5s, +100% by 15s, minute closes at +80%. One dust trade with a huge tip is ignored by weight.
  const rows = [row(-8, 1, 1e7), row(-3, 1, 1e7), row(2, 1.2, 1e7), row(5, 1.5, 1e7), row(6, 0.001, 1e3), row(15, 2, 1e7), row(30, 1.9, 1e7), row(38, 1.8, 1e7), row(75, 1.7, 1e7)];
  const p = V.pricePath(rows, A);
  assert.equal(Math.round(p.pct[2]), 20);
  assert.ok(Math.abs(p.pct[5] - 50) < 1, 'dust trade barely moves the 5s price: ' + p.pct[5]);
  assert.equal(Math.round(p.pct[15]), 100);
  assert.equal(Math.round(p.pct[10]), 50, 'no trade at 10-13s: the last 15s carry forward');
  assert.ok(Math.abs(p.entry[5] - 1.5 / 1.8) < 0.01, 'fill vs the close of its own minute');
  assert.equal(V.pricePath([row(5, 1, 1e7)], A), null, 'no price before the alert');
});

test('scoreCall with a trade-level fill price keeps the candle path', () => {
  const cs = [candle(0, 1, 1.9, 1, 1.8), candle(1, 1.8, 2.1, 1.7, 2), candle(2, 2, 2.05, 0.6, 0.7)];
  const atClose = V.scoreCall(cs, T0), early = V.scoreCall(cs, T0, {delay: 5 / 60, entryPrice: 1.2});
  assert.equal(atClose.entry, 1.8);
  assert.equal(atClose.outcome, 'loss', 'bought the minute close at 1.8, stopped at 0.9');
  assert.equal(early.entry, 1.2);
  assert.equal(early.outcome, 'loss', '1.2 entry: 2.1 is short of the 2.4 target, the stop at 0.6 fills');
  assert.equal(V.scoreCall(cs, T0, {delay: 5 / 60, entryPrice: 1.04}).outcome, 'win', '1.04 entry: 2.1 clears the 2.08 target first');
});

test('position: average entry, realised and marked profit', () => {
  const t = (side, usd, amount, at) => ({side, usd, amount, price: usd / amount, at});
  const open = V.position([t('buy', 20, 1e6, 1000), t('buy', 10, 4e5, 2000), t('sell', 12, 4e5, 3000)], 3e-5);
  assert.equal(open.entryAt, 1000);
  assert.ok(Math.abs(open.avg - 30 / 1.4e6) < 1e-12);
  assert.ok(open.open && Math.abs(open.heldFrac - 1e6 / 1.4e6) < 1e-9);
  assert.equal(Math.round(open.pnl), 40, '(12 received + 1e6 × 3e-5 left) / 30 paid');
  const closed = V.position([t('buy', 20, 1e6, 1000), t('sell', 15, 1e6, 5000)], 9e-5);
  assert.equal(closed.open, false);
  assert.equal(closed.pnl, -25);
  assert.equal(V.position([t('sell', 15, 1e6, 5000)], 1e-5), null, 'a sale with no buy seen is not a position');
});

test('backtestReport: primary hypotheses clear a lower bar than exploratory ones', () => {
  const rep = V.backtestReport(fakeItems(rng(21), 300, false), 5);
  assert.ok(rep.tested.primary > 0 && rep.tested.explore > rep.tested.primary);
  const bar = name => rep.features.find(f => f.name === name).rows.find(r => r.bar != null).bar;
  assert.ok(bar('Move into entry') < bar('Market cap at call'));
  assert.equal(rep.features.find(f => f.name === 'Move into entry').primary, true);
});

test('botFlow: counted share is a floor; one-use-wallet wash is "possible", real traders are neither', () => {
  const now = T0, t0 = now - 280000, rows = [], add = (at, side, usd, price, wallet, hash) => rows.push({at, side, usd, amount: usd / price, price, wallet, hash, ex: 'pump'});
  for (let i = 0; i < 10; i++) { add(t0 + i * 9000, 'buy', 150, 2e-5, 'WASH', 'w' + i); add(t0 + i * 9000, 'sell', 147, 1.96e-5, 'WASH', 'w' + i); }            // buy+sell in one transaction
  for (let i = 0; i < 10; i++) { add(t0 + i * 20000, 'buy', 100, 2e-5, 'once' + i, 'ob' + i); add(t0 + i * 20000 + 30000, 'sell', 99, 1.98e-5, 'once' + i, 'os' + i); } // flat, 30s, one wallet each
  for (let i = 0; i < 10; i++) add(t0 + i * 11000, 'buy', 80 + i, 2e-5, 'retail' + i, 'rb' + i);                                                                  // people buying
  add(t0 + 5000, 'buy', 300, 2e-5, 'flip', 'fb'); add(t0 + 8000, 'sell', 360, 2.4e-5, 'flip', 'fs');                                                               // a fast profitable flip
  const vb = V.botFlow(rows, t0 - 1000, now), kind = w => vb.flagged.filter(f => f.wallet === w).map(f => f.rule + (f.sure ? '' : '?'));
  assert.equal(vb.byRule.txWash, 20);
  assert.equal(vb.byRule.slowTrip, 20);
  assert.equal(vb.botTradeShare.toFixed(0), (100 * 20 / rows.length).toFixed(0), 'only the provable wash is counted');
  assert.equal(vb.possibleTradeShare.toFixed(0), (100 * 20 / rows.length).toFixed(0), 'the one-use wallets are reported as possible');
  assert.deepEqual(kind('flip'), []);
  assert.ok(vb.organic.some(t => t.wallet === 'once3'), 'possible trades stay in the organic flow');
  assert.ok(vb.organic.every(t => t.wallet !== 'WASH'));
});
