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
