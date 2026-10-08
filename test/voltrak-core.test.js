// Offline regression tests for VTCore (the pure functions between CORE START/END in the userscript).
// Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'voltrak-steroids.user.js'), 'utf8');
const core = source.slice(source.indexOf('/* CORE START'), source.indexOf('/* CORE END */'));
const VTCore = new Function(core + '\nreturn VTCore;')();

const MINT = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
const OTHER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const ALERT = [
  'Bonk Clone ($BONKC)',
  'Dev Wallet', OTHER,
  'CA', MINT,
  'MC', '$45.2K',
  'Age', '1h 5m',
  'Bonding Curve', 'Not migrated (78%)',
  'Volume (5M)', '$12.3K',
  'Top Holders', '#1 holder: 6.2%',
  'Clusters', 'Cluster 1: 22.5%', 'Cluster 2: 8%',
  'Wallets', 'Total Holders: 1,234', 'Fresh Wallets: 300', 'Sniper Wallets: 4',
].join('\n');

test('parseAlert prefers the labelled CA over an earlier address', () => {
  const a = VTCore.parseAlert(ALERT);
  assert.equal(a.mint, MINT);
  assert.equal(a.name, 'Bonk Clone');
  assert.equal(a.symbol, 'BONKC');
  assert.equal(a.callMc, 45200);
  assert.equal(a.ageSeconds, 3900);
  assert.equal(a.migrated, false);
  assert.equal(a.volume5m, 12300);
  assert.equal(a.topHolder, 6.2);
  assert.deepEqual(a.clusters, [22.5, 8]);
  assert.equal(a.holders, 1234);
  assert.equal(a.fresh, 300);
});

// A real VolTrak alert, as alertText() reads it from Discord (emoji are <img>, so they are absent from the text).
const REAL_ALERT = ['apeonsamsung ($samsung)', 'CA', '467xn5zKySHTWNohRyuu3rsf9TyxAYCdNyjEq9u3wCwt', 'CA', '467xn5zKySHTWNohRyuu3rsf9TyxAYCdNyjEq9u3wCwt',
  'MC', '$12.94K', 'Age', '5m', 'Bonding Curve', ' Not Migrated', 'Volume (5M)', 'N/A — still on bonding curve, check pump.fun for real-time volume',
  'Top Holder', '#1 holder: 4.2%', 'Top 3 Clusters', 'Cluster 1 : 30.53%Warning Extremely High', 'Wallet Analytics',
  ' Total Holders: 215 Experienced Traders: 4 Bots/High-Risk: 85 Fresh Wallets: 72 Sniper Wallets: 0',
  'Disclaimer', 'Automated volume alert only. Not financial advice or an endorsement. DYOR. Trade at your own risk.'].join('\n');

test('parseAlert reads a real VolTrak alert', () => {
  const a = VTCore.parseAlert(REAL_ALERT);
  assert.equal(a.mint, '467xn5zKySHTWNohRyuu3rsf9TyxAYCdNyjEq9u3wCwt');
  assert.deepEqual([a.name, a.symbol, a.callMc, a.ageSeconds, a.migrated, a.volume5m], ['apeonsamsung', 'samsung', 12940, 300, false, null]);
  assert.deepEqual([a.topHolder, a.clusters, a.holders, a.experienced, a.bots, a.fresh, a.snipers], [4.2, [30.53], 215, 4, 85, 72, 0]);
  const r = VTCore.assess(a, null, Date.now(), '');
  assert.ok(r.reasons.includes('33% fresh-wallet and 40% bot/high-risk labels of 215 holders at call; categories can overlap'));
  assert.ok(r.flags.some(x => /cluster/.test(x)) && !r.flags.some(x => /top holder/.test(x)));
});

test('parseAlert falls back to the first address and keeps single-unit ages', () => {
  const a = VTCore.parseAlert('Coin ($C)\nContract\n' + MINT + '\nAge\n12m');
  assert.equal(a.mint, MINT);
  assert.equal(a.ageSeconds, 720);
  assert.equal(VTCore.parseAlert('Coin ($C)\n' + MINT).mint, MINT);
  assert.equal(VTCore.parseAlert('no title\n' + MINT), null);
});

test('parseAlert does not strip a "CA" prefix that belongs to the address', () => {
  const caMint = 'CAbcdEFGhijkLMNopqrsTUVwxyz123456789ABCDEFG';
  assert.equal(VTCore.parseAlert('Coin ($C)\n' + caMint).mint, caMint);
});

test('mintFromURL handles referral prefixes and rejects other paths', () => {
  assert.equal(VTCore.mintFromURL('https://gmgn.ai/sol/token/' + MINT), MINT);
  assert.equal(VTCore.mintFromURL('https://gmgn.ai/sol/token/ref123_' + MINT + '?tab=1'), MINT);
  assert.equal(VTCore.mintFromURL('https://gmgn.ai/eth/token/' + MINT), null);
});

const pool = (pairAddress, dexId, liquidity, buys, sells, extra = {}) => ({
  chainId: 'solana', pairAddress, dexId, priceUsd: '0.0001', baseToken: {address: MINT},
  liquidity: {usd: liquidity}, txns: {m5: {buys, sells}}, volume: {m5: buys * 10, h1: buys * 100},
  priceChange: {m5: 5}, marketCap: 50000, fdv: 50000, pairCreatedAt: 1000, ...extra,
});

test('selectPair leaves a dead bonding-curve pool after migration', () => {
  const curve = pool('curve', 'pumpfun', 0, 0, 0);
  const amm = pool('amm', 'pumpswap', 40000, 30, 10);
  assert.equal(VTCore.selectPair([curve, amm], MINT, 'curve').pairAddress, 'amm');
});

test('selectPair keeps the pinned pool while it is at least half as deep', () => {
  const a = pool('a', 'raydium', 30000, 1, 1), b = pool('b', 'pumpswap', 50000, 1, 1);
  assert.equal(VTCore.selectPair([a, b], MINT, 'a').pairAddress, 'a');
  assert.equal(VTCore.selectPair([a, b], MINT, null).pairAddress, 'b');
  assert.equal(VTCore.selectPair([pool('x', 'd', 1, 1, 1, {chainId: 'base'})], MINT), null);
});

test('normalize sums flow across pools and falls back to FDV for market cap', () => {
  const a = pool('a', 'pumpswap', 40000, 30, 10, {marketCap: undefined, fdv: 61000});
  const b = pool('b', 'raydium', 5000, 5, 5, {pairCreatedAt: 500});
  const s = VTCore.normalize(a, 123, [a, b]);
  assert.equal(s.pair, 'a');
  assert.equal(s.pools, 2);
  assert.equal(s.buys5m, 35);
  assert.equal(s.sells5m, 15);
  assert.equal(s.liquidity, 45000);
  assert.equal(s.marketCap, 61000);
  assert.equal(s.pairCreatedAt, 500);
  assert.equal(VTCore.normalize(a, 1).pools, 1);
});

const NOW = Date.parse('2026-10-07T12:00:00Z');
const trade = (secondsAgo, side, usd, wallet) => ({attributes: {
  block_timestamp: new Date(NOW - secondsAgo * 1000).toISOString(), kind: side, volume_in_usd: String(usd), tx_from_address: wallet,
  from_token_address: side === 'sell' ? MINT : 'So11111111111111111111111111111111111111112',
  to_token_address: side === 'buy' ? MINT : 'So11111111111111111111111111111111111111112'}});

test('tradeFlow builds 1m/5m buys, sells, USD and unique wallets', () => {
  const f = VTCore.tradeFlow([trade(5, 'buy', 100, 'w1'), trade(20, 'buy', 50, 'w1'), trade(40, 'sell', 30, 'w2'), trade(200, 'sell', 500, 'w3')], MINT, NOW);
  assert.deepEqual([f.m1.buys, f.m1.sells, f.m1.buyUsd, f.m1.sellUsd, f.m1.wallets], [2, 1, 150, 30, 2]);
  assert.deepEqual([f.m5.buys, f.m5.sells, f.m5.wallets], [2, 2, 3]);
  assert.equal(f.lastTradeAt, NOW - 5000);
  assert.equal(f.m1.complete, true);
});

test('tradeFlow reads side from token direction and marks capped windows partial', () => {
  const t = trade(5, 'buy', 10, 'w');
  t.attributes.kind = 'sell'; // direction fields win over a pool-relative kind
  assert.equal(VTCore.tradeFlow([t], MINT, NOW).m1.buys, 1);
  const capped = Array.from({length: 300}, (_, i) => trade(i / 4, 'buy', 1, 'w' + i)); // spans ~75s
  assert.equal(VTCore.tradeFlow(capped, MINT, NOW).m1.complete, true);
  assert.equal(VTCore.tradeFlow(capped, MINT, NOW).m5.complete, false);
});

test('gtPool prefers the DEX Screener pool, then any pool with this base token', () => {
  const json = {data: [
    {attributes: {address: 'p1'}, relationships: {base_token: {data: {id: 'solana_other'}}}},
    {attributes: {address: 'p2'}, relationships: {base_token: {data: {id: 'solana_' + MINT}}}},
    {attributes: {address: 'p3'}, relationships: {base_token: {data: {id: 'solana_' + MINT}}}},
  ]};
  assert.equal(VTCore.gtPool(json, MINT, 'p3'), 'p3');
  assert.equal(VTCore.gtPool(json, MINT, 'zz'), 'p2');
  assert.equal(VTCore.gtPool({data: []}, MINT), null);
});

test('assess: call-time flags no longer hide the live state', () => {
  const call = VTCore.parseAlert(ALERT);
  const s = VTCore.normalize(pool('a', 'pumpswap', 40000, 30, 10), NOW - 1000);
  const a = VTCore.assess(call, s, NOW, '');
  assert.equal(a.state, 'WATCH BUY SETUP');
  assert.equal(a.basis, 'DEX Screener 5m swap count');
  assert.equal(a.risks.length, 0);
  assert.ok(a.flags.some(x => /cluster/.test(x)) && a.flags.some(x => /top holder/.test(x)));
});

test('assess: real data problems still force CAUTION', () => {
  const thin = VTCore.normalize(pool('a', 'pumpswap', 40000, 3, 1), NOW);
  assert.equal(VTCore.assess(null, thin, NOW, '').state, 'CAUTION');
  const dry = VTCore.normalize(pool('a', 'pumpswap', 0, 30, 10), NOW);
  assert.equal(VTCore.assess(null, dry, NOW, '').state, 'CAUTION');
  assert.equal(VTCore.assess(null, null, NOW, '').state, 'UNKNOWN');
  assert.equal(VTCore.assess(null, thin, NOW + 31000, '').state, 'UNKNOWN');
});

test('assess: fresh 1m trade flow drives the gauge in USD', () => {
  const s = VTCore.normalize(pool('a', 'pumpswap', 40000, 30, 10, {priceChange: {m5: -3}}), NOW);
  const rows = [...Array(4)].map((_, i) => trade(i * 5, 'buy', 10, 'b' + i)).concat([...Array(8)].map((_, i) => trade(i * 5, 'sell', 50, 's' + i)));
  const flow = VTCore.tradeFlow(rows, MINT, NOW);
  const a = VTCore.assess(null, s, NOW, '', flow);
  assert.equal(a.basis, 'GeckoTerminal 1m $ volume');
  assert.equal(Math.round(a.share), 9);
  assert.equal(a.state, 'FADE / REVIEW EXIT');
  assert.ok(!a.missing.includes('1m trade flow unavailable'));
  assert.ok(VTCore.assess(null, s, NOW + 40000, '', flow).missing.includes('1m trade flow unavailable'));
});

// GMGN page websocket frames, shaped like the token_activity / token_stat messages GMGN sends.
const activity = (secondsAgo, e, au, m, extra = {}) => ({a: MINT, e, m, au: String(au), qa: '0.1', ba: '1000', pu: '0.0000131', t: Math.round((NOW - secondsAgo * 1000) / 1000), h: 'tx' + m + secondsAgo, ex: 'pump', ...extra});
const STAT = {a: MINT, p: '0.0000131', p1m: '0.0000125', p5m: '0.0000140', b1m: 31, s1m: 9, bv1m: '1500', sv1m: '300', v1m: '1800', b5m: 120, s5m: 80, bv5m: '6000', sv5m: '4000', v5m: '10000'};

test('gmgnFrame accepts flat items and items wrapped in d', () => {
  const flat = VTCore.gmgnFrame(JSON.stringify({channel: 'token_activity', data: [activity(1, 'buy', 10, 'w1')]}));
  assert.equal(flat.channel, 'token_activity');
  assert.equal(VTCore.gmgnTrade(flat.items[0]).side, 'buy');
  const wrapped = VTCore.gmgnFrame({channel: 'token_activity', data: [{t: 'activity', ts: 1, d: activity(2, 'sell', 5, 'w2')}]});
  const trade = VTCore.gmgnTrade(wrapped.items[0]);
  assert.deepEqual([trade.side, trade.usd, trade.wallet, trade.mint, trade.at], ['sell', 5, 'w2', MINT, Math.round((NOW - 2000) / 1000) * 1000]);
  assert.equal(VTCore.gmgnFrame('not json'), null);
  assert.equal(VTCore.gmgnFrame('{"data":[]}'), null);
  assert.equal(VTCore.gmgnTrade({e: 'add', t: 1}), null);
});

test('gmgnStat reads GMGN rolling windows', () => {
  const st = VTCore.gmgnStat(STAT, NOW);
  assert.deepEqual([st.mint, st.price, st.m1.buys, st.m1.sells, st.m1.buyUsd, st.m1.sellUsd, st.m1.priceAgo], [MINT, 0.0000131, 31, 9, 1500, 300, 0.0000125]);
  assert.deepEqual([st.m5.buys, st.m5.sells, st.m5.volume, st.h1.buys], [120, 80, 10000, null]);
});

test('liveView: windows are complete only after listening that long; pump MC = price × 1B', () => {
  const trades = [activity(5, 'buy', 10, 'w1'), activity(30, 'sell', 4, 'w2')].map(VTCore.gmgnTrade);
  const early = VTCore.liveView(trades, null, NOW, NOW, NOW - 40000);
  assert.equal(early.flow.m1.complete, false);
  assert.equal(early.last.wallet, 'w1');
  assert.ok(Math.abs(early.marketCap - 13100) < 1e-6);
  const settled = VTCore.liveView(trades, null, NOW, NOW, NOW - 61000);
  assert.deepEqual([settled.flow.m1.complete, settled.flow.m5.complete, settled.flow.m1.wallets], [true, false, 2]);
  assert.equal(VTCore.liveView([], null, 0, NOW, NOW), null);
});

test('assess: GMGN token_stat drives the gauge without any DEX snapshot', () => {
  const live = VTCore.liveView([activity(2, 'buy', 50, 'w1')].map(VTCore.gmgnTrade), VTCore.gmgnStat(STAT, NOW - 1000), NOW - 1000, NOW, NOW - 5000);
  const call = VTCore.parseAlert(REAL_ALERT);
  const a = VTCore.assess(call, null, NOW, '', null, live);
  assert.equal(a.basis, 'GMGN 1m $ volume');
  assert.equal(Math.round(a.share), 83);
  assert.equal(a.state, 'WATCH BUY SETUP');
  assert.ok(a.reasons.includes('1m price change +4.8%'));
  assert.ok(a.reasons.some(r => r.startsWith('+1.2% market-cap change since alert (live price × 1B supply)')));
  assert.ok(a.missing.includes('No DEX Screener pool yet: liquidity unknown'));
  assert.ok(!a.missing.includes('1m trade flow unavailable'));
  // Stale live data falls back to UNKNOWN when nothing else is fresh.
  assert.equal(VTCore.assess(call, null, NOW + 20000, '', null, live).state, 'UNKNOWN');
});

test('assess: thin GMGN 1m falls back to GMGN 5m, which flags a weak sample', () => {
  const stat = VTCore.gmgnStat({...STAT, b1m: 2, s1m: 1, b5m: 12, s5m: 4}, NOW);
  const a = VTCore.assess(null, null, NOW, '', null, VTCore.liveView([], stat, NOW, NOW, NOW));
  assert.equal(a.basis, 'GMGN 5m $ volume');
  assert.equal(a.state, 'CAUTION');
});

// Backtest: 1m candles around an alert at T (aligned to a minute + 20s).
const T = Date.parse('2026-10-07T12:00:20Z'), M0 = Date.parse('2026-10-07T12:00:00Z');
const k = (minute, o, h, l, c, v = 10) => [(M0 + minute * 60000) / 1000, o, h, l, c, v];

test('candles sorts GeckoTerminal rows and drops broken ones; mergeCandles keeps the busier pool per minute', () => {
  const cs = VTCore.candles([k(2, 1, 1, 1, 1), k(0, 1, 1, 1, 1), [null, 1, 1, 1, 1, 1], k(1, 0, 1, 1, 1)]);
  assert.deepEqual(cs.map(x => x.t), [M0, M0 + 120000]);
  const merged = VTCore.mergeCandles([VTCore.candles([k(0, 1, 1, 1, 1, 5), k(1, 2, 2, 2, 2, 50)]), VTCore.candles([k(1, 3, 3, 3, 3, 80), k(2, 4, 4, 4, 4, 1)])]);
  assert.deepEqual(merged.map(x => x.c), [1, 3, 4]);
});

test('scoreCall: entry at the alert minute close, target hit first is a win', () => {
  const cs = VTCore.candles([k(0, 1, 5, 0.1, 1), k(1, 1, 1.5, 0.9, 1.4), k(3, 1.4, 2.2, 1.3, 2.1), k(70, 2, 2, 0.4, 0.5)]);
  const s = VTCore.scoreCall(cs, T, {tp: 100, sl: -50});
  assert.equal(s.entry, 1);
  assert.deepEqual([s.outcome, s.ret, s.outcomeMin.toFixed(2)], ['win', 100, '2.67']);
  assert.ok(Math.abs(s.peakPct - 120) < 1e-9); // the alert minute's own high (5) is ignored
  assert.ok(Math.abs(s.r5 - 110) < 1e-9);
  assert.ok(Math.abs(s.r60 - 110) < 1e-9);
  assert.ok(Math.abs(s.rEnd + 50) < 1e-9);
});

test('scoreCall: stop and target in one candle count as a loss; a gap fills at the open', () => {
  const both = VTCore.scoreCall(VTCore.candles([k(0, 1, 1, 1, 1), k(1, 1, 3, 0.4, 2)]), T, {tp: 100, sl: -50});
  assert.deepEqual([both.outcome, both.ret], ['loss', -50]);
  const gap = VTCore.scoreCall(VTCore.candles([k(0, 1, 1, 1, 1), k(1, 0.2, 0.25, 0.1, 0.1)]), T, {tp: 100, sl: -50});
  assert.equal(gap.outcome, 'loss');
  assert.ok(Math.abs(gap.ret + 80) < 1e-9);
});

test('scoreCall: neither hit is open at the horizon; no trades near the alert is unscored', () => {
  const open = VTCore.scoreCall(VTCore.candles([k(0, 1, 1, 1, 1), k(10, 1, 1.3, 0.8, 1.2)]), T, {tp: 100, sl: -50, horizon: 120});
  assert.deepEqual([open.outcome, Math.round(open.ret)], ['open', 20]);
  assert.equal(VTCore.scoreCall(VTCore.candles([k(9, 1, 1, 1, 1)]), T).status, 'no-trades');
  const next = VTCore.scoreCall(VTCore.candles([k(2, 2, 2, 2, 2)]), T);
  assert.equal(next.entry, 2); // no candle in the alert minute: next traded minute's open
});

test('wilson and backtestReport: buckets, ranges and "stands out" need enough calls', () => {
  const [lo, hi] = VTCore.wilson(5, 10);
  assert.ok(lo > 23 && lo < 24 && hi > 76 && hi < 77);
  const score = outcome => ({outcome, ret: outcome === 'win' ? 100 : -50, peakPct: outcome === 'win' ? 150 : 10, peakMin: outcome === 'win' ? 4 : 30, r5: 0, r15: 0, r60: 0});
  // 20 calls with a big cluster: all losses. 20 with a small cluster: 18 wins.
  const items = [...Array(20)].map(() => ({call: {clusters: [35], holders: 100, bots: 50}, score: score('loss')}))
    .concat([...Array(20)].map((_, i) => ({call: {clusters: [5], holders: 100, bots: 10}, score: score(i < 18 ? 'win' : 'loss')})));
  const rep = VTCore.backtestReport(items, 3);
  assert.equal(rep.all.n, 40);
  assert.equal(rep.all.winRate, 45);
  assert.equal(rep.all.ev, (18 * 100 + 22 * -50) / 40 - 3);
  const cluster = rep.features.find(f => f.name === 'Largest cluster').rows;
  assert.deepEqual(cluster.map(r => [r.label, r.n, r.standsOut]), [['<10%', 20, 'above'], ['≥30%', 20, 'below']]);
  const bots = rep.features.find(f => f.name === 'Bot/high-risk share').rows;
  assert.deepEqual(bots.map(r => r.label), ['<20%', '≥40%']);
  assert.equal(rep.features.find(f => f.name === 'Sniper wallets').rows[0].label, 'unknown');
  assert.equal(rep.timing.peakWithin5, 45);
  const small = VTCore.backtestReport(items.slice(0, 5).concat(items.slice(20, 25)), 0);
  assert.ok(small.features[0].rows.every(r => r.few && !r.standsOut));
});

test('ppEvent classifies PumpPortal messages; marketTape rolls 1/5/10/30m windows', () => {
  assert.deepEqual(VTCore.ppEvent('{"txType":"buy","solAmount":"1.5","traderPublicKey":"w1","mint":"m1"}'), {kind: 'trade', side: 'buy', sol: 1.5, wallet: 'w1', mint: 'm1'});
  assert.equal(VTCore.ppEvent({txType: 'create', mint: 'm'}).kind, 'create');
  assert.equal(VTCore.ppEvent({txType: 'migrate', mint: 'm'}).kind, 'migrate');
  assert.equal(VTCore.ppEvent({mint: 'm', pool: 'pump-amm', message: 'migration'}).kind, 'migrate');
  assert.equal(VTCore.ppEvent('{"message":"Successfully subscribed"}').kind, 'other');
  assert.equal(VTCore.ppEvent('nope').kind, 'other');
  const tape = VTCore.marketTape(), now = NOW;
  tape.add({kind: 'trade', sol: 2, wallet: 'a', mint: 'x'}, now - 20 * 60000);
  tape.add({kind: 'trade', sol: 1, wallet: 'b', mint: 'y'}, now - 3 * 60000);
  tape.add({kind: 'trade', sol: 1, wallet: 'b', mint: 'y'}, now - 30000);
  tape.add({kind: 'trade', sol: 1, wallet: 'c', mint: 'y'}, now - 10000);
  tape.add({kind: 'migrate'}, now - 8 * 60000);
  tape.add({kind: 'create'}, now - 5000);
  const w = tape.windows(now, now - 12 * 60000, 150);
  assert.deepEqual([w[1].trades, w[1].traders, w[1].tokens, w[1].creates, w[1].usd, w[1].complete], [2, 2, 1, 1, 300, true]);
  assert.deepEqual([w[5].trades, w[5].traders, w[10].migrations, w[10].complete], [3, 2, 1, true]);
  assert.deepEqual([w[30].trades, w[30].sol, w[30].traders, w[30].tokens, w[30].complete], [4, 5, 3, 2, false]);
  tape.prune(now + 25 * 60000);
  assert.equal(tape.windows(now + 25 * 60000, 0, null)[30].trades, 3);
});

test('initials and handoff keep their behaviour', () => {
  assert.equal(VTCore.initials(1, 0, 4, 0, 0).pct, 25);
  assert.equal(VTCore.initials(1, 1, 4).already, true);
  assert.equal(VTCore.initials(5, 0, 4).covered, false);
  const call = {id: '1', mint: MINT, messageAt: NOW};
  assert.equal(VTCore.handoff(call, {}, null, NOW + 1000), 'navigate');
  assert.equal(VTCore.handoff(call, {1: 1}, null, NOW), 'duplicate');
  assert.equal(VTCore.handoff(call, {}, MINT, NOW), 'already-open');
  assert.equal(VTCore.handoff(call, {}, null, NOW + 31000), 'old');
});
