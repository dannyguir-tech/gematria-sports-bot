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
// in ~50% of 200-call reports and ~92% of 400-call ones: the price of not crowning noise.
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

// ---- 4.4.1: defects found by the review of 4.4 ----
test('position(latest): a new buy after the bag was sold is a new position', () => {
  const t = (side, usd, amount, at) => ({side, usd, amount, price: usd / amount, at});
  // Bought $100 at 1e-5 and sold all for $200; later bought $100 at 2.4e-5; price now 2.1e-5 (down 12.5%).
  const rows = [t('buy', 100, 1e7, 1000), t('sell', 200, 1e7, 60000), t('buy', 100, 100 / 2.4e-5, 700000)];
  const now = V.position(rows, 2.1e-5, true);
  assert.equal(now.entryAt, 700000);
  assert.equal(now.usdIn, 100);
  assert.equal(now.usdOut, 0);
  assert.ok(Math.abs(now.pnl + 12.5) < 1e-6 && Math.abs(now.mark + 12.5) < 1e-6, 'pnl ' + now.pnl);
  assert.ok(now.open && now.heldFrac === 1 && !now.partial);
  // Same rows in any order (the feed is newest first); a buy and its sale in one second is not a new entry.
  assert.equal(V.position([...rows].reverse(), 2.1e-5, true).entryAt, 700000);
  const flip = V.position([t('sell', 120, 1e7, 5000), t('buy', 100, 1e7, 5000)], 1e-5, true);
  assert.ok(!flip.open && Math.abs(flip.pnl - 20) < 1e-9 && flip.entryAt === 5000, 'pnl ' + flip.pnl);
  // The last 0.8% of a bag is still part of the trade it came from.
  const moon = V.position([t('buy', 100, 1e6, 1000), t('sell', 150, 992000, 2000), t('sell', 40, 8000, 3000)], 1e-4, true);
  assert.ok(!moon.open && Math.abs(moon.pnl - 90) < 1e-9, 'pnl ' + moon.pnl);
  // Without `latest` (the report) both round trips add up as before.
  assert.equal(V.position(rows, 2.1e-5).usdIn, 200);
});
test('position: a sale of tokens bought elsewhere is not profit', () => {
  const t = (side, usd, amount, at) => ({side, usd, amount, price: usd / amount, at});
  // $100 buy never seen; the tab saw a $20 add and then everything sold for $110 (really -8%).
  const over = V.position([t('buy', 20, 2e5, 1000), t('sell', 110, 1.2e6, 9000)], 1e-4);
  assert.equal(over.partial, true);
  assert.ok(!over.open && over.usdIn === 20 && Math.abs(over.usdOut - 110 / 6) < 1e-9, 'only the seen sixth of the sale counts');
  assert.ok(Math.abs(over.pnl - (110 / 6 / 20 - 1) * 100) < 1e-9 && over.pnl < 0, 'pnl ' + over.pnl);
  // An old bag sold before a new buy: the sale is not part of the new position, which is still open.
  const old = V.position([t('sell', 100, 1e6, 1000), t('buy', 50, 1e6, 2000)], 5e-5);
  assert.ok(old.open && old.usdOut === 0 && old.pnl === 0 && !old.partial && old.n === 1);
  // A sale of exactly what was bought is not partial.
  assert.equal(V.position([t('buy', 20, 1e6, 1000), t('sell', 15, 1e6, 5000)], 9e-5).partial, false);
});
test('pricePath: fee-only rows and a lone dust trade are not a price', () => {
  const A = Date.UTC(2026, 9, 20, 12, 0, 20), row = (s, sol, amount) => ({at: A + s * 1000, sol, amount});
  // A swap paid in USDC shows only its fee as SOL (0.001 for 1e7 tokens): 1000x too cheap. A 0.03 SOL trade alone at +10s.
  const p = V.pricePath([row(-5, 1, 1e7), row(-4, 0.001, 1e7), row(2, 1.5, 1e7), row(3, 0.001, 1e7), row(10, 0.03, 1e5), row(40, 1.5, 1e7)], A);
  assert.ok(Math.abs(p.pre - 1e-7) < 1e-12, 'pre ' + p.pre);
  assert.equal(Math.round(p.pct[2]), 50);
  assert.equal(Math.round(p.pct[10]), 50, 'under 0.05 SOL in the 3 seconds: the last real price carries forward, got ' + p.pct[10]);
});
test('botFlow: a held earlier buy cannot take the sell of a 10-second round trip', () => {
  const rows = [], add = (at, side, usd, wallet, hash) => rows.push({at, side, usd, amount: usd / 2e-5, price: 2e-5, wallet, hash, ex: 'pump'});
  add(T0, 'buy', 100, 'BOT', 'hold');
  for (let i = 1; i <= 5; i++) { add(T0 + i * 45000, 'buy', 100, 'BOT', 'b' + i); add(T0 + i * 45000 + 2000, 'sell', 100, 'BOT', 's' + i); }
  for (let i = 0; i < 4; i++) add(T0 + 10000 + i * 30000, 'buy', 40, 'p' + i, 'p' + i);
  const vb = V.botFlow(rows, T0 - 1000, T0 + 300000);
  assert.equal(vb.byRule.fastTrip, 10);
  assert.equal(vb.byRule.slowTrip, 0);
  assert.equal(vb.buyers, 4);
  assert.ok(vb.botShare > 75 && vb.possibleShare === 0, vb.botShare + ' / ' + vb.possibleShare);
});
test('botFlow: slow flat trips keep their mirror partners, and a trading-app wallet is not "possible"', () => {
  const rows = [], add = (at, side, amount, wallet, hash, usd = amount * 2e-5) => rows.push({at, side, usd, amount, price: usd / amount, wallet, hash, ex: 'pump'});
  // A ring of one-use wallets: A buys, B sells the same size 1s later, A sells 30s later, C buys the same size 1s after.
  for (let i = 0; i < 5; i++) { const t = T0 + i * 40000, n = 5e6 + i * 1e5;
    add(t, 'buy', n, 'A' + i, 'a' + i); add(t + 1000, 'sell', n, 'B' + i, 'b' + i); add(t + 30000, 'sell', n, 'A' + i, 'c' + i); add(t + 31000, 'buy', n, 'C' + i, 'd' + i); }
  const ring = V.botFlow(rows, T0 - 1000, T0 + 300000);
  assert.equal(ring.byRule.slowTrip, 10);
  assert.equal(ring.byRule.mirror, 10);
  assert.equal(Math.round(ring.possibleTradeShare), 100);
  // A wallet GMGN tags as a trading app buys $100 and sells $99 20s later: a person, counted as app volume.
  const app = [{at: T0, side: 'buy', usd: 100, amount: 5e6, wallet: 'AX', hash: 'x1', ex: 'pump'}, {at: T0 + 20000, side: 'sell', usd: 99, amount: 5e6, wallet: 'AX', hash: 'x2', ex: 'pump'}];
  const prof = new Map([['AX', {wallet: 'AX', tags: ['axiom'], eventTags: [], tt: 2, bought: 5e6, sold: 5e6}]]);
  const vb = V.botFlow(app, T0 - 1000, T0 + 60000, V.VB, prof);
  assert.equal(vb.byRule.slowTrip, 0);
  assert.equal(Math.round(vb.appShare), 100);
  // The same trip 2s apart is still a counted bot, app tag or not.
  app[1].at = T0 + 2000;
  assert.equal(V.botFlow(app, T0 - 1000, T0 + 60000, V.VB, prof).byRule.fastTrip, 2);
});
test('backtestReport: a small bucket that happens to hold no winner does not stand out', () => {
  // 120 calls, 10 winners, nothing related to anything; the 16 calls with a 25%+ move into entry hold no winner.
  const r = rng(9), items = fakeItems(r, 120, false);
  items.forEach((it, i) => { it.call.entryMove = i < 16 ? 30 : 5 + r() * 10; const win = i >= 16 && i < 26; it.score = {...it.score, outcome: win ? 'win' : 'loss', ret: win ? 100 : -50}; });
  const row = V.backtestReport(items, 5).features.find(f => f.name === 'Move into entry').rows.find(x => x.label === '≥25%');
  assert.equal(row.n, 16);
  assert.equal(row.standsOut, null, 't ' + row.t + ' vs bar ' + row.bar);
  // Winners that are rare overall: the starred tables stay quiet on data with no effect.
  let flagged = 0;
  for (let k = 0; k < 150; k++) {
    const it = fakeItems(r, 200, false);
    it.forEach(x => { const win = r() < 0.05; x.score = {...x.score, outcome: win ? 'win' : 'loss', ret: win ? 100 : -50}; });
    if (V.backtestReport(it, 5).features.some(f => f.primary && f.rows.some(x => x.standsOut))) flagged++;
  }
  assert.ok(flagged / 150 < 0.06, 'starred false-find rate with 5% winners: ' + flagged / 150);
});

// ---- 4.4.2: found by the review of 4.4.1 ----
test('position: the result does not depend on the order the fills arrived in', () => {
  const t = (side, usd, amount, at) => ({side, usd, amount, price: usd / amount, at});
  // $30 buy of 300,000; two sells in the same second that together exceed the bag the tab saw.
  const rows = [t('buy', 30, 3e5, 2000), t('sell', 75, 5e5, 7000), t('sell', 20, 4e5, 7000)], perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const latest of [false, true]) {
    const out = new Set(perms.map(p => { const r = V.position(p.map(i => rows[i]), 1e-4, latest); return [r.usdOut, r.pnl, r.n, r.last, r.partial].join('|'); }));
    assert.equal(out.size, 1, [...out].join('  vs  '));
  }
  // A sale after the bag is gone is not counted, also when float sums leave a remainder.
  const a = V.position([t('buy', 41, 410035, 3000), t('sell', 150, 1230106, 20000), t('sell', 70, 700000, 95000)], 1e-4);
  assert.ok(a.n === 2 && a.last === 20000 && a.partial, 'n ' + a.n + ' last ' + a.last);
  const b = V.position([t('buy', 10, 100000.1, 1000), t('buy', 20, 200000.2, 2000), t('sell', 33, 300000.3, 9000), t('sell', 15, 150000, 60000)], 1e-4);
  assert.ok(b.n === 3 && b.last === 9000 && !b.open && Math.abs(b.pnl - 10) < 1e-9, 'n ' + b.n + ' last ' + b.last + ' pnl ' + b.pnl);
});

// ---- 4.9: the add-on rules (tape checks, stealth bundles, adjusted grade, verdict, monitor) ----
const SOLP = 150, tb = (side, sol, wallet, at, usd = sol * SOLP) => ({side, sol, usd, wallet, at, hash: wallet + at});
test('roundSol: button sizes are round, with or without an app fee taken off', () => {
  for (const s of [0.01, 0.05, 0.1, 0.099, 0.0985, 0.25, 0.4925, 0.5, 1, 0.99, 2, 4.95, 10]) assert.equal(V.roundSol(s), true, String(s));
  for (const s of [0.0937, 0.1234, 0.0667, 0.777, 1.13, 0.004]) assert.equal(V.roundSol(s), false, String(s));
});
test('tapeTraps: same-size buys are odd sizes from many wallets, never people pressing the same button', () => {
  const now = T0, people = [];
  // 40 buys from 40 people using 0.1 / 0.5 / 1 SOL buttons (some apps take 1% off), 12 sells
  for (let i = 0; i < 40; i++) people.push(tb('buy', [0.1, 0.5, 1][i % 3] * (i % 2 ? 0.99 : 1), 'p' + i, now - 200000 + i * 4000));
  for (let i = 0; i < 12; i++) people.push(tb('sell', 0.3, 's' + i, now - 150000 + i * 9000));
  const plain = V.tapeTraps(people, now);
  assert.equal(plain.clone, null, 'preset sizes are not clones');
  assert.equal(plain.zeroSell, false);
  // six wallets buying 0.0937 SOL (about $14) within 1%
  const bots = [...people]; for (let i = 0; i < 6; i++) bots.push(tb('buy', 0.0937 * (1 + i * 0.001), 'bot' + i, now - 60000 + i * 5000));
  const c = V.tapeTraps(bots, now).clone;
  assert.ok(c && c.count === 6 && c.wallets === 6 && Math.abs(c.sol - 0.0937) < 0.001, JSON.stringify(c));
  // the same six buys from one wallet are one trader, not a ring
  const one = [...people]; for (let i = 0; i < 6; i++) one.push(tb('buy', 0.0937, 'solo', now - 60000 + i * 5000));
  assert.equal(V.tapeTraps(one, now).clone, null);
  // a full tape with almost no sells, and one wallet behind the last minute's buying
  const green = []; for (let i = 0; i < 44; i++) green.push(tb('buy', 0.2, 'g' + i, now - 58000 + i * 1200)); green.push(tb('buy', 30, 'whale', now - 5000));
  const g = V.tapeTraps(green, now);
  assert.equal(g.zeroSell, true);
  assert.ok(g.top1.share > 76 && g.top1.share < 79, 'whale share ' + g.top1.share);
  assert.equal(V.tapeTraps(green.slice(0, 25), now).zeroSell, false, 'the first trades of a launch are nearly all buys: not flagged under 40 trades');
  assert.equal(V.tapeTraps([], now).top1, null);
});
const holder = (i, pct, o = {}) => ({address: 'H' + i, addr_type: 0, amount_percentage: pct / 100, maker_token_tags: [], total_trade: 4, avg_cost: 1e-5, native_transfer: {timestamp: 1700000000 + i * 86400, name: null}, open_timestamp: 1760000000 + i * 600, ...o});
test('stealthScan: wallets funded together count; one ordinary signature alone does not', () => {
  // 30 ordinary holders: every bag a different size, funded days apart, bought minutes apart
  const plain = Array.from({length: 30}, (_, i) => holder(i, 2.4 - i * 0.07));
  const s0 = V.stealthScan(plain, 2e-5, 1e9);
  assert.equal(s0.stealthPct, 0);
  assert.equal(s0.wallets, 0);
  assert.ok(Math.abs(s0.floor.mult - 2) < 1e-9 && /top-12/.test(s0.floor.basis) && s0.floor.mc === 1e4);
  // five of them funded inside the same 10 minutes
  const fund = plain.map((h, i) => i >= 10 && i < 15 ? {...h, native_transfer: {timestamp: 1750000000 + i * 60, name: 'Binance 2'}} : h), s1 = V.stealthScan(fund, 2e-5, 1e9);
  assert.equal(s1.wallets, 5);
  assert.ok(Math.abs(s1.stealthPct - [10, 11, 12, 13, 14].reduce((t, i) => t + 2.4 - i * 0.07, 0)) < 1e-9, 'pct ' + s1.stealthPct);
  assert.match(s1.kind, /5w funded together \(Binance 2\)/);
  // six equal bags alone (people pressing the same button at the same price): not stealth
  const equal = plain.map((h, i) => i >= 20 && i < 26 ? {...h, amount_percentage: 0.0061} : h), s2 = V.stealthScan(equal, 2e-5, 1e9);
  assert.equal(s2.det.equal.n, 6);
  assert.equal(s2.stealthPct, 0);
  // the same six also bought in the same second: two signatures, counted
  const both = equal.map((h, i) => i >= 20 && i < 26 ? {...h, open_timestamp: 1765000000} : h), s3 = V.stealthScan(both, 2e-5, 1e9);
  assert.equal(s3.wallets, 6);
  assert.ok(Math.abs(s3.stealthPct - 3.66) < 1e-9);
  // wallets GMGN already tagged are the insider bag, not stealth; smart money is counted from their tags
  const tagged = fund.map((h, i) => i === 10 ? {...h, maker_token_tags: ['bundler']} : i === 0 ? {...h, tags: ['smart_degen'], history_bought_amount: 100, history_sold_amount: 85} : i === 1 ? {...h, tags: ['renowned'], history_bought_amount: 100, history_sold_amount: 55} : i === 2 ? {...h, tags: ['not_smart', 'kolibri_fan']} : h);
  const s4 = V.stealthScan(tagged, 2e-5, 1e9);
  assert.equal(s4.wallets, 4);
  assert.deepEqual(s4.smart, {holding: 1, dumping: 1}, 'sold 85% = dumping, sold 55% = still holding, look-alike tags are not smart money');
  assert.ok(Math.abs(s4.taggedPct - 1.7) < 1e-9);
  assert.equal(V.stealthScan([], 1, 1), null);
});
const scoreIn = o => ({exit: {wallets: 0, pct: 0, coordinated: false}, devSellingNow: false, insiderHold: 12, devPct: 2, devSold: false, launches: 2, sameDev: false, funderSeen: 0, top10: 20, bundlerPct: 8, sniperPct: 3, cluster: {n: 0},
  launchBuyers: 1, platformRate: 40, freshRate: 10, smart: 0, holderGrowth: 2, volMc: 2, botShare: 5, botTrades: 10, orgShare: 60, orgN: 40, retention: 55, profitShare: 10, moveSinceCall: 5, exitCost: 4, conf: {}, ...o});
test('adjustScore: a holding bundle is RISKY, not AVOID and not CLEAN; missing data never counts as good data', () => {
  // insiders 40%, top 10 46%, nobody selling, organic buy share 60%, first buyers holding 55%
  const x = scoreIn({insiderHold: 40, top10: 46}), base = V.scoreCoin(x), adj = V.adjustScore(base, x, {});
  assert.equal(base.grade, 'AVOID');
  assert.equal(adj.grade, 'RISKY');
  assert.equal(adj.holding, true);
  assert.equal(adj.risk, -2, 'insider bag and top 10 capped at -1 each');
  assert.equal(adj.baseGrade, 'AVOID');
  assert.equal(base.checks.find(k => k.key === 'insiders').pts, -3, 'the base score object is not changed');
  // the same coin with the organic buy share unknown, 40%, or 100% from three trades: no waiver (4.8 treated unknown as 56%)
  for (const o of [{orgShare: null}, {orgShare: 40}, {orgShare: 100, orgN: 3}]) { const y = scoreIn({insiderHold: 40, top10: 46, ...o}), a = V.adjustScore(V.scoreCoin(y), y, {}); assert.equal(a.holding, false); assert.equal(a.grade, 'AVOID', JSON.stringify(o)); }
  // a dev sale on the live feed in the last minutes counts as selling, with or without a chain key
  assert.equal(V.adjustScore(base, x, {devExitRecent: true}).holding, false);
  // insiders selling now: no waiver either
  const sell = scoreIn({insiderHold: 40, top10: 46, exit: {wallets: 2, pct: 2.1, coordinated: false}});
  assert.equal(V.adjustScore(V.scoreCoin(sell), sell, {}).grade, 'AVOID');
  // untagged stealth bundles are added to the bag when it is not a holding bundle
  const st = scoreIn({insiderHold: 12, orgShare: 40}), a2 = V.adjustScore(V.scoreCoin(st), st, {stealth: {stealthPct: 16, smart: {holding: 0, dumping: 0}}});
  assert.equal(a2.checks.find(k => k.key === 'insiders').pts, -2, '12% + 16% = 28% is the 25%+ band');
  assert.equal(a2.total, 28);
});
test('adjustScore: chasing is monotonic, DS adds a point, tape traps are a penalty and not a hard stop', () => {
  const entry = move => { const x = scoreIn({moveSinceCall: move}); return V.adjustScore(V.scoreCoin(x), x, {}).checks.find(k => k.key === 'move').pts; };
  assert.deepEqual([20, 50, 90, 150].map(entry), [0, -1, -2, -2], '+90% must not score worse than +150%');
  const dev = (o, ctx = {}) => { const y = scoreIn({devPct: 0, ...o}); return V.adjustScore(V.scoreCoin(y), y, ctx).checks.find(k => k.key === 'dev'); };
  assert.equal(dev({devSoldAgoMin: 45}).pts, 1);
  assert.match(dev({devSoldAgoMin: 45}).value, /DS/);
  assert.equal(dev({devSoldAgoMin: 5}).pts, 0, 'a dump five minutes ago earns nothing');
  assert.equal(dev({}).pts, 0, 'sale time unknown: no bonus');
  assert.equal(dev({devSoldAgoMin: 45}, {devExitRecent: true}).pts, 0);
  assert.ok(dev({devSoldAgoMin: 45, devSellingNow: true}).pts <= 0);
  // a dev whose earlier coins mostly rugged
  const rg = scoreIn({}), ra = V.adjustScore(V.scoreCoin(rg), rg, {rugRatio: 0.9});
  assert.equal(ra.checks.find(k => k.key === 'launches').pts, -2);
  assert.equal(ra.grade, 'RISKY');
  const x = scoreIn({}), clone = V.adjustScore(V.scoreCoin(x), x, {traps: {clone: {count: 6, wallets: 6, sol: 0.0937, usd: 14}, zeroSell: false, buys: 30, sells: 9}});
  assert.equal(clone.checks.find(k => k.key === 'organic').pts, -2);
  assert.match(clone.checks.find(k => k.key === 'organic').value, /^60% · 6 same-size buys/, 'the real organic share stays visible');
  assert.equal(clone.demand, V.scoreCoin(x).demand - 3, 'organic buys go from +1 to -2');
  assert.equal(clone.hard.length, 0, 'no hard stop: the verdict bar says stay away, the grade follows the points');
  const zero = V.adjustScore(V.scoreCoin(x), x, {traps: {clone: null, zeroSell: true, buys: 28, sells: 1}});
  assert.equal(zero.checks.find(k => k.key === 'organic').pts, -1);
  assert.equal(zero.grade, 'CLEAN', 'a fresh launch with few sells yet is not graded down to RISKY by that alone');
  // volume/MC 15x with few bots is not held against the coin; with 40% bot trades it is
  const vm = bots => { const y = scoreIn({volMc: 15, botTrades: bots}); return V.adjustScore(V.scoreCoin(y), y, {}).checks.find(k => k.key === 'volmc').pts; };
  assert.deepEqual([vm(10), vm(40), vm(null)], [0, -1, -1], 'forgiven only when the bot share is known and low');
});
test('verdict: dump, avoid, wait and buy in that order', () => {
  const base = {grade: 'CLEAN', share: 64, move: 10, coordinated: false, smart: {holding: 1, dumping: 0}, top1: null, clone: null, zeroSell: false, rugRatio: 0.1, curvePct: 40, migrated: false, floor: {mult: 1.4, mc: 20000, basis: 'top holders avg'}, holding: false, total: 12};
  assert.equal(V.verdict(base).mode, 'buy');
  assert.equal(V.verdict({...base, grade: 'RISKY'}).mode, 'wait');
  assert.equal(V.verdict({...base, grade: 'RISKY', holding: true, total: 33}).mode, 'buy');
  assert.equal(V.verdict({...base, share: 57}).mode, 'wait');
  assert.equal(V.verdict({...base, share: 52}).title, 'WAIT — do not chase');
  assert.equal(V.verdict({...base, move: 45}).mode, 'wait');
  assert.equal(V.verdict({...base, curvePct: 90}).mode, 'wait');
  assert.equal(V.verdict({...base, zeroSell: true, buys: 30, sells: 1}).mode, 'wait');
  assert.equal(V.verdict({...base, grade: 'AVOID'}).mode, 'avoid');
  assert.equal(V.verdict({...base, top1: {share: 70, usd: 900, total: 1280}}).mode, 'wait', 'one big buyer is a reason to wait, not an alarm');
  assert.equal(V.verdict({...base, caution: 'No positive indexed liquidity'}).mode, 'wait');
  assert.equal(V.verdict({...base, weakShare: true}).mode, 'wait');
  assert.equal(V.verdict({...base, rugRatio: 0.6}).mode, 'avoid');
  assert.equal(V.verdict({...base, clone: {count: 6, wallets: 6}}).mode, 'avoid');
  assert.equal(V.verdict({...base, move: 120}).mode, 'avoid');
  assert.equal(V.verdict({...base, coordinated: true}).mode, 'dump');
  assert.equal(V.verdict({...base, grade: 'AVOID', smart: {holding: 1, dumping: 3}}).mode, 'dump');
  assert.equal(V.verdict({...base, smart: {holding: 1, dumping: 2}}).mode, 'buy', 'two wallets taking profit is not a dump');
  assert.equal(V.verdict({grade: null, share: null}).mode, 'scan');
  assert.equal(V.verdict({...base, share: null}).mode, 'wait');
});
test('monNorm: "address" is the token on GMGN and the pool on Photon; GMGN shares are fractions', () => {
  const M1 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', P1 = '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT';
  const g = V.monNorm({address: M1, symbol: 'DOG', market_cap: '26000', top_10_holder_rate: 0.21, bundler_rate: 0.008, creator_hold_rate: 0, holder_count: 412, smart_degen_count: 2, dev: {rug_ratio: 0.1, cto_flag: 1}}, 'gmgn-http');
  assert.ok(g.mint === M1 && g.pool === null && g.mc === 26000 && Math.abs(g.top10 - 21) < 1e-9 && Math.abs(g.bundler - 0.8) < 1e-9 && g.dev === 0 && g.cto === true && g.rug === 0.1);
  const p = V.monNorm({address: P1, tokenAddress: M1, symbol: 'DOG', mc: 26000, top10: 21, bundler: 12}, 'photon-ws');
  assert.ok(p.mint === M1 && p.pool === P1 && p.top10 === 21 && p.bundler === 12);
  const poolOnly = V.monNorm({address: P1, liquidity: 9000}, 'photon-ws');
  assert.ok(poolOnly.pool === P1 && poolOnly.mint === null);
  assert.equal(V.monNorm({address: M1, amount_percentage: 0.02}, 'gmgn-ws'), null, 'a holder row is not a coin');
  assert.equal(V.monNorm({address: 'So11111111111111111111111111111111111111112', market_cap: 1}, 'gmgn-ws'), null);
  assert.equal(V.monNorm([1, 2], 'gmgn-ws'), null);
});
test('monEval: waking needs a fresh rise; an unknown market cap is never a starting point', () => {
  const now = T0, snaps = pts => pts.map(([ago, mc]) => ({t: now - ago * 1000, mc}));
  const flat = V.monEval({snaps: snaps([[120, 20000], [60, 20100], [5, 20050]])}, now);
  assert.equal(flat.wake, false);
  const up = V.monEval({snaps: snaps([[90, 20000], [45, 22000], [5, 26000]])}, now);
  assert.ok(up.wake && up.velPct > 15 && Math.round(up.gain) === 30, JSON.stringify(up));
  // the same rise seen 5 minutes ago and nothing since: stale, not waking
  assert.equal(V.monEval({snaps: snaps([[390, 20000], [345, 22000], [305, 26000]])}, now).wake, false);
  // pumped earlier, sliding now: +30% off the low but falling 12%/min
  assert.equal(V.monEval({snaps: snaps([[300, 20000], [200, 34000], [50, 29000], [5, 26000]])}, now).wake, false);
  // one snapshot, or none with a market cap: no velocity, no gain, not waking
  const one = V.monEval({snaps: snaps([[3, 50000]])}, now); assert.ok(!one.wake && one.velPct === null && one.gain === null);
  assert.equal(V.monEval({snaps: []}, now).wake, false);
  // DEX Screener 5m flow: 50 trades, 70% buys, volume 18% of market cap; half of that is ordinary activity
  assert.equal(V.monEval({snaps: snaps([[3, 50000]]), buys5m: 35, sells5m: 15, vol5m: 9000}, now).wake, true);
  assert.equal(V.monEval({snaps: snaps([[3, 50000]]), buys5m: 21, sells5m: 9, vol5m: 5000}, now).wake, false);
  assert.equal(V.monPass({mc: 26000, pad: 'pump', top10: 60}), false);
  assert.equal(V.monPass({mc: 26000, pad: 'pump'}), true, 'figures that are not known do not fail the filter');
  assert.equal(V.monPass({mc: 26000}), false, 'a coin whose launchpad is not known is not listed');
  assert.equal(V.monPass({mc: 26000, pad: 'other'}), false);
  assert.equal(V.monPass({mc: 0, pad: 'pump'}), false);
});
test('monStats: flagged coins against the control sample', () => {
  const log = [{kind: 'wake', r10: 20, r30: -10}, {kind: 'wake', r10: -30, r30: null}, {kind: 'wake', r10: 60}, {kind: 'ctl', r10: -5, r30: -20}, {kind: 'ctl', r10: null}];
  const s = V.monStats(log);
  assert.deepEqual([s.wake.seen, s.wake[10].n, s.wake[10].median, Math.round(s.wake[10].up), Math.round(s.wake[10].big), s.wake[30].n], [3, 3, 20, 67, 33, 1]);
  assert.deepEqual([s.ctl.seen, s.ctl[10].n, s.ctl[10].median, s.ctl[30].median], [2, 1, -5, -20]);
  assert.equal(V.monStats([]).wake[10].median, null);
});
test('backtestReport: the 4.9 tables read what was saved with the call', () => {
  const r = rng(4), items = fakeItems(r, 120, false);
  items.forEach((it, i) => { it.call.gm = {v: 2, code: 0, x49: {verdict: ['buy', 'wait', 'avoid', 'dump'][i % 4], code: i % 3, holding: i % 2 === 0, stealth: i % 20, smartNet: (i % 3) - 1, clone: i % 5 === 0, top1: 30 + i % 50}}; });
  const rep = V.backtestReport(items, 5), f = n => rep.features.find(x => x.name === n);
  assert.deepEqual(f('Verdict at the call (4.9 rules)').rows.map(x => [x.label, x.n]), [['buy', 30], ['wait', 30], ['avoid', 30], ['dump', 30]]);
  assert.equal(f('Verdict at the call (4.9 rules)').primary, true);
  assert.deepEqual(f('Adjusted grade at the call (4.9 rules)').rows.map(x => x.label), ['clean', 'risky', 'avoid']);
  assert.deepEqual(f('Smart money holding minus dumping').rows.map(x => x.label), ['<0', '0–1', '≥1']);
  assert.deepEqual(f('Same-size buys at the call').rows.map(x => [x.label, x.n]), [['no', 96], ['yes', 24]]);
});
test('gmBase: a saved score the 4.3 rules could not have produced is recognised', () => {
  const x = scoreIn({insiderHold: 41, top10: 46}), s = V.scoreCoin(x), rec = o => ({v: 2, grade: s.grade, hard: [], insiderHold: 41, top10: 46, devPct: 2, bundlerPct: 8, smart: 0, volMc: 2, move: 5, checks: Object.fromEntries(s.checks.map(k => [k.key, k.status === 'na' ? null : k.pts])), ...o});
  assert.equal(V.gmBase(rec({})), true, 'what 4.4 and 4.9 save');
  assert.equal(V.gmBase(rec({checks: {...rec({}).checks, insiders: 0, top10: 0}})), false, '4.8 "holding bundle": 41% insiders scored 0');
  assert.equal(V.gmBase(rec({devPct: 0, checks: {...rec({}).checks, dev: 1}})), false, '4.8.4 DS point');
  assert.equal(V.gmBase(rec({smart: 4, checks: {...rec({}).checks, smart: -2}})), false);
  assert.equal(V.gmBase(rec({hard: ['Inorganic tape: Clone buys (8x ~$16 (8w))']})), false);
  assert.equal(V.gmBase(rec({checks: {...rec({}).checks, organic: -2}})), false);
  assert.equal(V.gmBase(rec({insiderHold: 15, checks: {...rec({}).checks, insiders: 0}})), true, 'a number stored on a band edge is not judged (rounding)');
  assert.equal(V.gmBase({v: 1, checks: {insiders: 9}}), true, 'older records are not judged');
  assert.equal(V.gmBase(null), true);
  // the backtest's 4.3 table leaves an altered record out
  const items = fakeItems(rng(8), 40, false); items.forEach((it, i) => { it.call.gm = i < 10 ? rec({code: 0, checks: {...rec({}).checks, insiders: 0}}) : rec({code: 2}); });
  const row = V.backtestReport(items, 5).features.find(f => f.name === 'Live grade at the call (4.3 rules)').rows;
  assert.deepEqual(row.map(r => [r.label, r.n]), [['avoid', 30], ['unknown', 10]]);
});

// ---- 4.9.3: only Pumpfun, Bonk and Stonk.fun ----
test('detectPad: Pumpfun, Bonk and Stonk.fun pass; everything else is other or unknown', () => {
  const M = s => '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZR' + s;
  assert.equal(V.detectPad({}, M('pump'), ''), 'pump');
  assert.equal(V.detectPad({dexId: 'pumpswap'}, M('pump'), ''), 'pump', 'a migrated pump.fun coin is still pump');
  assert.equal(V.detectPad({dexId: 'raydium-launchlab'}, M('bonk'), ''), 'bonk', 'letsbonk vanity mint');
  assert.equal(V.detectPad({dexId: 'raydium'}, M('bonk'), ''), 'bonk', 'a migrated bonk coin is still bonk');
  for (const lp of ['bonkers', 'letsbonk', 'bonk.fun']) assert.equal(V.detectPad({launchpad: lp}, M('uJos'), ''), 'bonk', lp);
  assert.equal(V.detectPad({launchpad: 'BONK'}, M('uJos'), ''), null, 'a coin named BONK is not the launchpad');
  assert.equal(V.detectPad({launchpad: 'stonk.fun'}, M('uJos'), ''), 'stonk');
  assert.equal(V.detectPad({launchpad: 'bags'}, M('bonk'), ''), 'other');
  assert.equal(V.detectPad({dexId: 'raydium'}, M('uJos'), ''), null);
  assert.deepEqual([...V.ALLOWED_PADS].sort(), ['bonk', 'pump', 'stonk']);
});
test('verdict: a dump warning comes before the launchpad skip; the skip is its own mode', () => {
  const v = {grade: 'CLEAN', share: 64, move: 10, smart: {holding: 0, dumping: 0}, badPad: 'raydium'};
  assert.equal(V.verdict(v).mode, 'skip');
  assert.equal(V.verdict({...v, coordinated: true}).mode, 'dump');
  assert.equal(V.verdict({...v, badPad: null}).mode, 'buy', 'without the skip the trading rules decide');
});

// ---- 4.9.4: Copy for AI and the AI pick log ----
const mintN = i => '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJo' + 'ABCDEFGHJK'[i] + 'pump'; // 44 characters
const aiRows = [0, 1, 2].map(i => ({mint: mintN(i), symbol: 'C' + i, pad: 'pump', mc: 40000 + i, liq: 9000, vol5m: 12000, holders: 150, top10: 18, bundler: 3, dev: 0.4, smart: i,
  ev: {buyShare: 61, velPct: 2.4, gain: 35, wake: i === 1, score: 5, absorbed: 'clean'}}));
test('aiPrompt: fixed instructions plus one line per coin with its mint', () => {
  const p = V.aiPrompt(aiRows, Date.UTC(2026, 10, 21, 9, 5));
  assert.ok(p.startsWith(V.AI_RULES));
  assert.match(p, /Coins at 2026-11-21 09:05 UTC \(3\)/);
  for (const w of aiRows) assert.ok(p.includes('mint=' + w.mint));
  assert.match(p, /2\. \$C1 .* waking=yes score=5\/10/);
  assert.equal(p.split('\n').length - 3, 3);
});
test('parsePicks: only mints from the copied list, at most 3, with the reason', () => {
  const made = '9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosZZZZ';
  const r = V.parsePicks(`Here you go:\nPICK ${mintN(1)} | steady buying, low top 10\nPICK ${made} | invented\n- ${mintN(0)}`, aiRows);
  assert.deepEqual(r.map(x => x.mint), [mintN(1), mintN(0)]);
  assert.equal(r[0].why, 'steady buying, low top 10');
  assert.deepEqual(V.parsePicks('NONE', aiRows), []);
  assert.equal(V.parsePicks(`PICK ${mintN(0)}\nPICK ${mintN(0)}`, aiRows).length, 1);
});
test('pickStats: 1 h and 4 h results for picks and the same-list comparison', () => {
  const s = V.pickStats([{kind: 'pick', r60: 20, r240: -90}, {kind: 'pick', r60: -10}, {kind: 'ctl', r60: 5, r240: null}]);
  assert.equal(s.pick.seen, 2); assert.equal(s.pick[60].n, 2); assert.equal(s.pick[60].median, 5); assert.equal(s.pick[60].up, 50);
  assert.equal(s.pick[240].rug, 100); assert.equal(s.ctl[240].n, 0); assert.equal(s.ctl[60].up, 100);
});
