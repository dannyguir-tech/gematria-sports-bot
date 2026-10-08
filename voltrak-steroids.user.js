// ==UserScript==
// @name         VolTrak Steroids
// @namespace    voltrak-alert
// @version      3.3.0
// @description  VolTrak context + GMGN handoff + GMGN live trade feed (read-only), market-wide pump.fun activity and a call backtest. Analysis only; never submits trades.
// @match        https://discord.com/*
// @match        https://gmgn.ai/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      api.dexscreener.com
// @connect      api.geckoterminal.com
// @noframes
// @run-at       document-start
// ==/UserScript==

/* CORE START — pure functions, also used by offline regression tests. */
const VTCore = (() => {
  'use strict';
  const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, TRADE_CAP = 300;
  const number = v => v === null || v === undefined || v === '' ? null : Number.isFinite(+v) ? +v : null;
  function money(v) {
    const m = String(v || '').replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)\s*([KMB])?/i);
    return m ? +m[1] * ({K: 1e3, M: 1e6, B: 1e9}[(m[2] || '').toUpperCase()] || 1) : null;
  }
  function parseAlert(text) {
    const title = text.match(/^\s*([^\n]+?)\s*\(\$([^\n)]+)\)\s*$/m);
    if (!title) return null;
    const tail = text.slice(title.index + title[0].length);
    // Prefer an explicitly labelled contract so another address earlier in the alert is never taken as the mint.
    const labelled = tail.match(/(?:^|\n)\s*(?:CA|Contract(?:\s+Address)?|Mint|Token\s+Address)(?:\s*:\s*|\s+)([1-9A-HJ-NP-Za-km-z]{32,44})\b/i);
    const ca = labelled ? labelled[1] : tail.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/)?.[0];
    if (!ca) return null;
    const mc = tail.match(/(?:^|\n)\s*MC\s*\n\s*(\$[\d.,]+[KMB]?)/i);
    const age = tail.match(/(?:^|\n)\s*Age\s*\n\s*([^\n]+)/i);
    const ageParts = age ? Array.from(age[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) : [];
    const bond = tail.match(/(?:^|\n)\s*Bonding Curve\s*\n\s*([^\n]+)/i);
    const volume = tail.match(/(?:^|\n)\s*Volume\s*\(5M\)\s*\n\s*([^\n]+)/i);
    const holder = tail.match(/#1 holder:\s*([\d.]+)%/i);
    const clusters = Array.from(tail.matchAll(/Cluster\s+\d+\s*:\s*([\d.]+)%/gi), m => +m[1]);
    const count = label => { const m = tail.match(new RegExp(label + ':\\s*([\\d,]+)', 'i')); return m ? +m[1].replace(/,/g, '') : null; };
    const migrated = bond ? /not\s+migrated/i.test(bond[1]) ? false : /migrated/i.test(bond[1]) ? true : null : null;
    return {mint: ca, name: title[1].trim(), symbol: title[2].trim(), callMc: mc ? money(mc[1]) : null,
      ageSeconds: ageParts.length ? ageParts.reduce((t, m) => t + +m[1] * {s:1,m:60,h:3600,d:86400}[m[2].toLowerCase()], 0) : null,
      migrated, volume5m: volume && /\$/.test(volume[1]) ? money(volume[1]) : null,
      partialVolume: !!(volume && /since launch|younger/i.test(volume[1])),
      conflict: !!(migrated === true && volume && /still on bonding curve/i.test(volume[1])),
      topHolder: holder ? +holder[1] : null, clusters,
      holders: count('Total Holders'), experienced: count('Experienced Traders'),
      bots: count('Bots/High-Risk'), fresh: count('Fresh Wallets'), snipers: count('Sniper Wallets')};
  }
  function mintFromURL(value) {
    const m = String(value).match(/^https:\/\/gmgn\.ai\/sol\/token\/([^/?#]+)\/?(?:[?#].*)?$/);
    const id = m ? m[1].split('_').pop() : '';
    return MINT.test(id) ? id : null;
  }
  const gmgnURL = mint => { if (!MINT.test(mint)) throw Error('Invalid contract'); return 'https://gmgn.ai/sol/token/' + mint; };
  const poolsFor = (rows, mint) => (Array.isArray(rows) ? rows : []).filter(p => p?.chainId === 'solana' && p.baseToken?.address === mint && number(p.priceUsd) > 0);
  // Deepest pool wins. The previous pool is kept only while it is at least half as deep, so a token that migrates
  // off its bonding curve moves to the new pool instead of staying pinned to the dead one.
  function selectPair(rows, mint, pinned) {
    const eligible = poolsFor(rows, mint);
    if (!eligible.length) return null;
    const liq = p => number(p.liquidity?.usd) || 0, best = eligible.reduce((a, b) => liq(b) > liq(a) ? b : a);
    const pin = eligible.find(p => p.pairAddress === pinned);
    return pin && liq(pin) >= liq(best) / 2 ? pin : best;
  }
  // Price, market cap and pool identity come from the selected pool. Swap counts, volume and liquidity are summed
  // over every indexed pool for the token, so flow on a second pool is not missed.
  function normalize(p, at, rows) {
    if (!p) return null;
    const all = rows ? poolsFor(rows, p.baseToken?.address) : [], list = all.length ? all : [p];
    const sum = f => list.reduce((t, x) => { const v = f(x); return v == null ? t : (t ?? 0) + v; }, null);
    const created = list.map(x => number(x.pairCreatedAt)).filter(v => v > 0);
    return {at, pair: p.pairAddress, dex: p.dexId, pools: list.length, price: number(p.priceUsd),
      marketCap: number(p.marketCap) ?? number(p.fdv), fdv: number(p.fdv), liquidity: sum(x => number(x.liquidity?.usd)),
      buys5m: sum(x => number(x.txns?.m5?.buys)), sells5m: sum(x => number(x.txns?.m5?.sells)),
      volume5m: sum(x => number(x.volume?.m5)), volume1h: sum(x => number(x.volume?.h1)),
      priceChange5m: number(p.priceChange?.m5), pairCreatedAt: created.length ? Math.min(...created) : null,
      source: 'DEX Screener snapshot', sourceTime: null};
  }
  // GeckoTerminal token→pools response: the pool to read trades from when the DEX Screener pair id is unknown there.
  function gtPool(json, mint, preferred) {
    const rows = (Array.isArray(json?.data) ? json.data : []).filter(p => p?.attributes?.address);
    const base = rows.filter(p => p.relationships?.base_token?.data?.id === 'solana_' + mint);
    const list = base.length ? base : rows;
    return (list.find(p => p.attributes.address === preferred) || list[0])?.attributes.address || null;
  }
  // GeckoTerminal token→pools response → every pool whose base token is this mint, in GeckoTerminal's order.
  const gtPools = (json, mint) => (Array.isArray(json?.data) ? json.data : []).filter(p => p?.attributes?.address && p.relationships?.base_token?.data?.id === 'solana_' + mint).map(p => p.attributes.address);
  // Trades [{at, side, usd, wallet}] → 1m/5m buy/sell counts, USD and unique wallets. complete(ms) says whether
  // the source can be missing trades in that window.
  function windows(trades, now, complete) {
    const window = ms => {
      const w = trades.filter(t => now - t.at <= ms && t.at <= now + 5000), buys = w.filter(t => t.side === 'buy'), sells = w.filter(t => t.side === 'sell');
      const usd = list => list.reduce((s, t) => s + t.usd, 0);
      return {buys: buys.length, sells: sells.length, buyUsd: usd(buys), sellUsd: usd(sells),
        wallets: new Set(w.map(t => t.wallet).filter(Boolean)).size, complete: complete(ms)};
    };
    return {at: now, trades: trades.length, lastTradeAt: trades.length ? Math.max(...trades.map(t => t.at)) : null, m1: window(60000), m5: window(300000)};
  }
  // GeckoTerminal pool trades (latest ≤300 in 24h).
  function tradeFlow(rows, mint, now) {
    const trades = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const a = row?.attributes || row || {}, at = Date.parse(a.block_timestamp);
      const side = a.to_token_address === mint ? 'buy' : a.from_token_address === mint ? 'sell' : a.kind === 'buy' || a.kind === 'sell' ? a.kind : null;
      if (Number.isFinite(at) && side) trades.push({at, side, usd: number(a.volume_in_usd) || 0, wallet: a.tx_from_address || null});
    }
    const oldest = trades.reduce((m, t) => Math.min(m, t.at), Infinity);
    return windows(trades, now, ms => trades.length < TRADE_CAP || oldest <= now - ms);
  }
  // GMGN page websocket frame → {channel, items}. Items may be flat or carry their payload in `d`.
  function gmgnFrame(raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
    if (!msg || typeof msg.channel !== 'string') return null;
    const data = Array.isArray(msg.data) ? msg.data : msg.data && typeof msg.data === 'object' ? [msg.data] : [];
    return {channel: msg.channel, items: data.filter(x => x && typeof x === 'object').map(x => x.d && typeof x.d === 'object' && !Array.isArray(x.d) ? {...x, ...x.d} : x)};
  }
  const addrOf = x => x?.a || x?.address || x?.token_address || null;
  const millis = v => { const n = number(v); return n == null ? null : n < 1e12 ? n * 1000 : n; };
  // token_activity item → trade, or null for anything that is not a buy or sell.
  function gmgnTrade(x) {
    const side = {buy: 'buy', b: 'buy', sell: 'sell', s: 'sell'}[String(x?.e).toLowerCase()], at = millis(x?.t) ?? millis(x?.ts);
    if (!side || at == null) return null;
    return {at, side, usd: number(x.au) || 0, sol: number(x.qa), amount: number(x.ba), price: number(x.pu), wallet: x.m || null, hash: x.h || null, mint: addrOf(x), ex: x.ex || null};
  }
  // token_stat item → GMGN's own rolling windows (b/s = buy/sell count, bv/sv = buy/sell volume, v = volume, p = price then).
  function gmgnStat(x, at) {
    const w = k => ({buys: number(x['b' + k]), sells: number(x['s' + k]), buyUsd: number(x['bv' + k]), sellUsd: number(x['sv' + k]), volume: number(x['v' + k]), priceAgo: number(x['p' + k])});
    return {at, mint: addrOf(x), price: number(x.p) ?? number(x.pu) ?? number(x.price), m1: w('1m'), m5: w('5m'), h1: w('1h')};
  }
  // Live GMGN view for assess(): trades seen since the first live message (`since`) plus GMGN's token_stat rollup.
  function liveView(trades, stat, at, now, since) {
    if (!at) return null;
    const last = trades.reduce((a, b) => !a || b.at >= a.at ? b : a, null), price = stat?.price ?? last?.price ?? null;
    // pump.fun tokens have a fixed 1B supply, so market cap = price × 1e9.
    const marketCap = price > 0 && /pump/i.test(last?.ex || '') ? price * 1e9 : null;
    return {at, stat, flow: trades.length ? windows(trades, now, ms => since <= now - ms) : null, price, marketCap, last};
  }
  function assess(call, s, now, error, flow, live) {
    // risks block the state (CAUTION); flags are call-time review notes shown next to the live state.
    const reasons = [], risks = [], flags = [], missing = [];
    if (call?.conflict) risks.push('Alert has conflicting migration/volume fields');
    if (call?.clusters?.length && Math.max(...call.clusters) >= 20) flags.push('Reported largest cluster ≥20% (review flag, not a proven cutoff)');
    if (call?.topHolder >= 5) flags.push('Reported top holder ≥5% (review flag)');
    if (call?.holders > 0 && (call.fresh != null || call.bots != null)) reasons.push([call.fresh != null && Math.round(call.fresh/call.holders*100) + '% fresh-wallet', call.bots != null && Math.round(call.bots/call.holders*100) + '% bot/high-risk'].filter(Boolean).join(' and ') + ' labels of ' + call.holders + ' holders at call; categories can overlap');
    if (!call?.clusters?.length) missing.push('Call-time wallet clusters missing');
    const fresh = (x, ms) => !!x && now - x.at <= ms && x.at <= now + 1000;
    const L = fresh(live, 15000) ? live : null, st = L && fresh(L.stat, 15000) ? L.stat : null, lf = L?.flow || null;
    const f = fresh(flow, 30000) ? flow : null, dex = !error && fresh(s, 30000) ? s : null;
    if (!st && !lf && !f) missing.push('1m trade flow unavailable');
    if (!lf && !f) missing.push('Unique trading wallets unavailable');
    if (!dex && !st && !lf) {
      return {state:'UNKNOWN', side:'NO CURRENT SNAPSHOT', share:null, basis:null, risks, flags, missing,
        reasons:[error || (s ? 'Snapshot fetch is stale' : 'No live or indexed data yet'), ...reasons]};
    }
    if (error) missing.push(error);
    // Gauge source, best first: GMGN's own 1m rollup, live trades, GeckoTerminal 1m, GMGN 5m, DEX Screener 5m counts.
    const usdShare = (w, min) => w && (w.buys || 0) + (w.sells || 0) >= min && (w.buyUsd || 0) + (w.sellUsd || 0) > 0 ? 100 * (w.buyUsd || 0) / ((w.buyUsd || 0) + (w.sellUsd || 0)) : null;
    const dexWindow = dex && {buys: dex.buys5m, sells: dex.sells5m};
    const pick = [
      [st ? usdShare(st.m1, 10) : null, 'GMGN 1m $ volume', 1, st?.m1],
      [lf?.m1.complete ? usdShare(lf.m1, 10) : null, 'live 1m trades ($)', 1, lf?.m1],
      [f ? usdShare(f.m1, 10) : null, 'GeckoTerminal 1m $ volume', 1, f?.m1],
      [st ? usdShare(st.m5, 1) : null, 'GMGN 5m $ volume', 5, st?.m5],
      [dex && dex.buys5m >= 0 && dex.sells5m >= 0 && dex.buys5m + dex.sells5m > 0 ? 100 * dex.buys5m / (dex.buys5m + dex.sells5m) : null, 'DEX Screener 5m swap count', 5, dexWindow],
    ].find(o => o[0] != null);
    const share = pick ? pick[0] : null, basis = pick ? pick[1] : null;
    const side = share === null ? 'UNKNOWN' : share >= 60 ? 'BUY SIDE' : share <= 40 ? 'SELL SIDE' : 'MIXED';
    if (share != null) reasons.push(Math.round(share) + '% of ' + basis + ' is buys; not a win probability');
    if (pick?.[2] === 5 && (pick[3].buys || 0) + (pick[3].sells || 0) < 20) risks.push('Fewer than 20 swaps in the 5m window; weak sample');
    const price = L?.price ?? dex?.price ?? null, change = ago => price > 0 && ago > 0 ? (price/ago - 1) * 100 : null, pct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    const m1Change = change(st?.m1.priceAgo), m5Change = change(st?.m5.priceAgo) ?? dex?.priceChange5m ?? null;
    const momentum = pick?.[2] === 1 && m1Change != null ? m1Change : m5Change;
    if (m1Change != null) reasons.push('1m price change ' + pct(m1Change));
    if (m5Change != null) reasons.push('5m price change ' + pct(m5Change));
    if (lf) reasons.push('Live trades: ' + lf.m1.buys + ' buys / ' + lf.m1.sells + ' sells from ' + lf.m1.wallets + ' wallets in 1m' + (lf.m1.complete ? '' : ' (listening under 1m)'));
    else if (f) reasons.push('1m trades: ' + f.m1.buys + ' buys / ' + f.m1.sells + ' sells from ' + f.m1.wallets + ' wallets' + (f.m1.complete ? '' : ' (partial: feed returns latest 300)'));
    const lastAt = lf?.lastTradeAt ?? f?.lastTradeAt;
    if (lastAt) reasons.push('Last trade ' + Math.max(0, Math.round((now-lastAt)/1000)) + 's ago');
    const mc = L?.marketCap ?? dex?.marketCap;
    if (call?.callMc > 0 && mc > 0) {
      const move = (mc/call.callMc-1)*100;
      reasons.push(pct(move) + ' market-cap change since alert (' + (L?.marketCap ? 'live price × 1B supply' : 'provider definitions may differ') + ')');
      if (move > 30) flags.push('More than 30% above call MC: review entry timing');
    }
    if (dex) {
      if (dex.pairCreatedAt && now-dex.pairCreatedAt < 300000 && basis?.startsWith('DEX')) reasons.push('Pool younger than 5m: this window is partial');
      if (dex.liquidity == null) missing.push('Indexed liquidity missing');
      else if (dex.liquidity <= 0) risks.push('No positive indexed liquidity');
    } else missing.push('No DEX Screener pool yet: liquidity unknown');
    reasons.push(L ? 'Live from GMGN\'s own page feed' : (dex?.pools > 1 ? 'DEX flow summed over ' + dex.pools + ' indexed pools' : 'Single indexed pool') + '; upstream update delay is unknown');
    const state = risks.length ? 'CAUTION' : share === null ? 'UNKNOWN' : side === 'SELL SIDE' && momentum < 0 ? 'FADE / REVIEW EXIT' : side === 'BUY SIDE' && momentum > 0 ? 'WATCH BUY SETUP' : 'WAIT';
    return {state,side,share,basis,reasons,risks,flags,missing};
  }
  // ---- Backtest: score past calls from 1m candles ----
  // GeckoTerminal ohlcv_list rows [start s, open, high, low, close, volume] → ascending candles. Minutes without swaps are absent.
  function candles(list) {
    return (Array.isArray(list) ? list : []).map(r => ({t: millis(r?.[0]), o: number(r?.[1]), h: number(r?.[2]), l: number(r?.[3]), c: number(r?.[4]), v: number(r?.[5]) || 0}))
      .filter(k => k.t != null && k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0).sort((a, b) => a.t - b.t);
  }
  // One token's pools (bonding curve, then the AMM pool after graduation): per minute keep the busier pool's candle.
  function mergeCandles(lists) {
    const byMinute = new Map();
    for (const list of lists) for (const k of list) { const o = byMinute.get(k.t); if (!o || k.v > o.v) byMinute.set(k.t, k); }
    return [...byMinute.values()].sort((a, b) => a.t - b.t);
  }
  // Outcome of buying an alert at `at` (ms): target/stop in %, horizon in minutes.
  function scoreCall(cs, at, opt = {}) {
    const tp = opt.tp ?? 100, sl = opt.sl ?? -50, horizon = opt.horizon ?? 120;
    const minute = Math.floor(at / 60000) * 60000, end = at + horizon * 60000, i0 = cs.findIndex(k => k.t >= minute);
    if (i0 < 0 || cs[i0].t - at > 5 * 60000) return {status: 'no-trades'};
    // Entry: close of the alert's own minute, else the next traded minute's open. The alert minute's high/low are
    // skipped because they may come from before the alert.
    const own = cs[i0].t === minute, entry = own ? cs[i0].c : cs[i0].o, path = cs.slice(own ? i0 + 1 : i0).filter(k => k.t < end);
    const pct = p => (p / entry - 1) * 100, stop = entry * (1 + sl / 100), target = entry * (1 + tp / 100);
    let peak = entry, peakAt = at, trough = entry, outcome = 'open', ret = null, outcomeAt = null;
    for (const k of path) {
      if (k.h > peak) { peak = k.h; peakAt = k.t; }
      if (k.l < trough) trough = k.l;
      if (outcome !== 'open') continue;
      // Stop and target inside one candle count as the stop (the order is unknown); a gap through the stop fills at the open.
      if (k.l <= stop) { outcome = 'loss'; ret = pct(Math.min(stop, k.o)); outcomeAt = k.t; }
      else if (k.h >= target) { outcome = 'win'; ret = tp; outcomeAt = k.t; }
    }
    const priceAt = min => { let p = entry; for (const k of path) { if (k.t + 60000 <= at + min * 60000) p = k.c; else break; } return pct(p); };
    const rEnd = priceAt(horizon);
    return {status: 'scored', entry, outcome, ret: ret ?? rEnd, outcomeMin: outcomeAt == null ? null : (outcomeAt - at) / 60000,
      peakPct: pct(peak), peakMin: (peakAt - at) / 60000, troughPct: pct(trough), r5: priceAt(5), r15: priceAt(15), r60: priceAt(60), rEnd};
  }
  const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y), m = s.length >> 1; return !s.length ? null : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // 95% Wilson interval for a win rate, in %.
  function wilson(wins, n, z = 1.96) {
    if (!n) return [null, null];
    const p = wins / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [100 * Math.max(0, c - h), 100 * Math.min(1, c + h)];
  }
  function summarize(scores, cost = 0) {
    const n = scores.length, wins = scores.filter(s => s.outcome === 'win').length, losses = scores.filter(s => s.outcome === 'loss').length, [lo, hi] = wilson(wins, n);
    return {n, wins, losses, open: n - wins - losses, winRate: n ? 100 * wins / n : null, lo, hi,
      ev: n ? scores.reduce((t, s) => t + s.ret, 0) / n - cost : null, medianPeak: median(scores.map(s => s.peakPct))};
  }
  // Alert fields to split calls by: [name, value from the call, bucket edges, unit].
  const FEATURES = [
    ['Largest cluster', c => c.clusters?.length ? Math.max(...c.clusters) : null, [10, 20, 30], '%'],
    ['Bot/high-risk share', c => c.holders > 0 && c.bots != null ? 100 * c.bots / c.holders : null, [20, 40], '%'],
    ['Fresh-wallet share', c => c.holders > 0 && c.fresh != null ? 100 * c.fresh / c.holders : null, [20, 40], '%'],
    ['Top holder', c => c.topHolder, [3, 5], '%'],
    ['Market cap at call', c => c.callMc, [10000, 20000, 50000], '$'],
    ['Age at call', c => c.ageSeconds == null ? null : c.ageSeconds / 60, [5, 15, 60], 'm'],
    ['Holders', c => c.holders, [100, 300, 1000], ''],
    ['Experienced traders', c => c.experienced, [1, 5], ''],
    ['Sniper wallets', c => c.snipers, [1], ''],
  ];
  const edgeLabel = (v, unit) => unit === '$' ? '$' + (v >= 1000 ? v / 1000 + 'K' : v) : v + unit;
  function bucketOf(v, cuts, unit) {
    const i = cuts.findIndex(x => v < x);
    if (i === 0) return unit === '' && cuts[0] === 1 ? '0' : '<' + edgeLabel(cuts[0], unit);
    if (i < 0) return '≥' + edgeLabel(cuts[cuts.length - 1], unit);
    return edgeLabel(cuts[i - 1], unit) + '–' + edgeLabel(cuts[i], unit);
  }
  // items [{call, score}] (scored only) → baseline, per-field buckets and timing. A bucket "stands out" when it has at
  // least 15 calls and its whole 95% range sits above or below the baseline win rate.
  function backtestReport(items, cost = 0) {
    const scores = items.map(i => i.score), all = summarize(scores, cost);
    const features = FEATURES.map(([name, get, cuts, unit]) => {
      const order = [bucketOf(-Infinity, cuts, unit), ...cuts.map(x => bucketOf(x, cuts, unit)), 'unknown'], groups = new Map(order.map(l => [l, []]));
      for (const i of items) { const v = get(i.call); groups.get(v == null || !Number.isFinite(v) ? 'unknown' : bucketOf(v, cuts, unit)).push(i.score); }
      return {name, rows: order.map(label => ({label, ...summarize(groups.get(label), cost)})).filter(r => r.n)
        .map(r => ({...r, few: r.n < 15, standsOut: r.n >= 15 && all.n > 0 ? r.lo > all.winRate ? 'above' : r.hi < all.winRate ? 'below' : null : null}))};
    });
    const within = m => scores.length ? 100 * scores.filter(s => s.peakMin <= m).length / scores.length : null;
    return {all, features, timing: {r5: median(scores.map(s => s.r5)), r15: median(scores.map(s => s.r15)), r60: median(scores.map(s => s.r60)),
      peakMin: median(scores.map(s => s.peakMin)), peakWithin5: within(5), peakWithin15: within(15), peakWithin60: within(60)}};
  }
  // ---- Market-wide pump.fun activity (PumpPortal data socket) ----
  function ppEvent(raw) {
    let m;
    try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return {kind: 'other'}; }
    const type = String(m?.txType ?? m?.type ?? '').toLowerCase();
    if (type === 'buy' || type === 'sell') return {kind: 'trade', side: type, sol: number(m.solAmount) || 0, wallet: m.traderPublicKey || null, mint: m.mint || null};
    if (type === 'create') return {kind: 'create', mint: m.mint || null};
    if (/migrat/.test(type) || (!type && m?.mint && /migrat/i.test(JSON.stringify(m)))) return {kind: 'migrate', mint: m.mint || null};
    return {kind: 'other'};
  }
  // Rolling 1/5/10/30-minute totals from a stream of events. Windows longer than the listening time are marked partial.
  function marketTape() {
    const secs = new Map(), wallets = new Map(), mints = new Map();
    return {
      add(ev, now) {
        const s = Math.floor(now / 1000);
        if (!secs.has(s)) secs.set(s, {trades: 0, sol: 0, creates: 0, migrations: 0});
        const b = secs.get(s);
        if (ev.kind === 'trade') { b.trades++; b.sol += ev.sol || 0; if (ev.wallet) wallets.set(ev.wallet, now); if (ev.mint) mints.set(ev.mint, now); }
        else if (ev.kind === 'create') b.creates++;
        else if (ev.kind === 'migrate') b.migrations++;
      },
      windows(now, since, solUsd, mins = [1, 5, 10, 30]) {
        const out = {}, nowS = Math.floor(now / 1000);
        for (const m of mins) out[m] = {trades: 0, sol: 0, creates: 0, migrations: 0, traders: 0, tokens: 0, complete: since <= now - m * 60000};
        for (const [s, b] of secs) for (const m of mins) if (nowS - s < m * 60) { const o = out[m]; o.trades += b.trades; o.sol += b.sol; o.creates += b.creates; o.migrations += b.migrations; }
        for (const t of wallets.values()) for (const m of mins) if (now - t < m * 60000) out[m].traders++;
        for (const t of mints.values()) for (const m of mins) if (now - t < m * 60000) out[m].tokens++;
        for (const m of mins) out[m].usd = solUsd > 0 ? out[m].sol * solUsd : null;
        return out;
      },
      prune(now) {
        const cut = Math.floor(now / 1000) - 1800;
        for (const s of secs.keys()) if (s < cut) secs.delete(s);
        for (const map of [wallets, mints]) for (const [k, t] of map) if (now - t >= 1800000) map.delete(k);
      },
    };
  }
  function initials(cost, proceeds, bag, feePct=0, fixed=0) {
    if (![cost,proceeds,bag,feePct,fixed].every(Number.isFinite) || cost<0 || proceeds<0 || bag<0 || feePct<0 || feePct>=100 || fixed<0) return {error:'Enter non-negative amounts in one currency; fee must be below 100%.'};
    const need=Math.max(0,cost-proceeds);
    if (!need) return {need:0,pct:0,covered:true,already:true};
    const netAll=bag*(1-feePct/100)-fixed;
    if (netAll < need) return {need,pct:100,covered:false,shortfall:need-Math.max(0,netAll)};
    return {need,pct:Math.min(100,100*(need+fixed)/(bag*(1-feePct/100))),covered:true};
  }
  function handoff(call, receipts, current, now, maxAge=30000) {
    if (!call || !MINT.test(call.mint) || !call.id || !Number.isFinite(call.messageAt)) return 'invalid';
    if (receipts[call.id]) return 'duplicate';
    if (call.messageAt > now+5000 || now-call.messageAt > maxAge || call.historical) return 'old';
    return current === call.mint ? 'already-open' : 'navigate';
  }
  return {MINT,number,money,parseAlert,mintFromURL,gmgnURL,selectPair,normalize,gtPool,gtPools,tradeFlow,gmgnFrame,addrOf,gmgnTrade,gmgnStat,liveView,assess,
    candles,mergeCandles,scoreCall,wilson,summarize,backtestReport,ppEvent,marketTape,initials,handoff};
})();
/* CORE END */

// GMGN live feed: a read-only listener on the websocket GMGN's page opens itself (ws.gmgn.ai). It never sends on
// that socket and never changes a message; it only reads token_activity and token_stat frames.
const VTLive = (() => {
  const listeners = new Set(), pending = [], seen = new WeakSet();
  let attachedAt = 0;
  const emit = frame => { if (!listeners.size) { if (pending.push(frame) > 200) pending.shift(); return; } for (const fn of listeners) try { fn(frame); } catch (_) {} };
  const watch = ws => {
    if (!ws || seen.has(ws) || !/(^|\.)gmgn\.ai(:|\/|$)/.test(String(ws.url).replace(/^wss?:\/\//, ''))) return;
    seen.add(ws); attachedAt = attachedAt || Date.now();
    ws.addEventListener('message', e => {
      if (typeof e.data !== 'string' || !/"(token_activity|token_stat)"/.test(e.data)) return;
      const frame = VTCore.gmgnFrame(e.data);
      if (frame) emit(frame);
    });
  };
  if (location.hostname === 'gmgn.ai') {
    try {
      const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window, WS = page.WebSocket;
      // Sockets created from now on (we run at document-start, before GMGN's app code).
      page.WebSocket = new Proxy(WS, {construct(target, args, newTarget) { const ws = Reflect.construct(target, args, newTarget); try { watch(ws); } catch (_) {} return ws; }});
      // A socket opened before this ran is picked up the next time GMGN sends on it (e.g. a subscribe on token change).
      const send = WS.prototype.send;
      WS.prototype.send = function (...args) { try { watch(this); } catch (_) {} return send.apply(this, args); };
    } catch (_) {}
  }
  return {on(fn) { listeners.add(fn); pending.splice(0).forEach(emit); }, attachedAt: () => attachedAt};
})();

function start() {
  'use strict';
  if (window.top !== window.self) return;
  if (document.getElementById('vts-root')) return;
  if (document.getElementById('voltrak-ui')) {
    console.warn('[VolTrak Steroids] Old VolTrak script is still running. Disable v2 and reload before using v3.');
    GM_notification({title:'VolTrak: two versions enabled',text:'Disable the old VolTrak Call Alert script, then reload. Steroids has stopped.',timeout:15000});
    return;
  }
  const DISCORD=location.hostname==='discord.com', GMGN=location.hostname==='gmgn.ai';
  if (!DISCORD && !GMGN) return;
  // AUTHOR_ID (optional): VolTrak's Discord user/webhook ID, the number in its avatar URL /avatars/<id>/.
  // Set it to ignore anyone else who renames themselves "VolTrak". Empty = match by name only.
  const CHANNEL='1531866550968254514', AUTHOR='voltrak', AUTHOR_ID='', PREFIX='vts3.';
  const VERSION=typeof GM_info!=='undefined'?GM_info.script.version:'3.3.0';
  const DEX='https://api.dexscreener.com/tokens/v1/solana/', GT='https://api.geckoterminal.com/api/v2/networks/solana/';
  const CURRENT_MS=3000, TRACK_MS=10000, FLOW_MS=6000, RECEIVER_TTL=90000, LEAVE_GRACE=20000;
  const get=(k,d)=>GM_getValue(PREFIX+k,d), set=(k,v)=>GM_setValue(PREFIX+k,v);
  const hasLocks=!!navigator.locks;
  // Web Locks only coordinate tabs of one site. Without them, run unlocked (best effort) rather than not at all.
  const locked=(name,fn)=>hasLocks ? navigator.locks.request(PREFIX+name,fn) : Promise.resolve().then(fn);
  // Per-tab ID kept in sessionStorage, so the GMGN receiver keeps its role across its own reloads (loading a call).
  const newId=()=>crypto.randomUUID();
  let TAB=(()=>{try{return sessionStorage.getItem(PREFIX+'tab')||newId();}catch(_){return newId();}})();
  const saveTab=()=>{try{sessionStorage.setItem(PREFIX+'tab',TAB);}catch(_){}};saveTab();
  if(GMGN&&'BroadcastChannel' in window){
    // A duplicated tab copies sessionStorage; the newer copy takes a fresh ID.
    const bc=new BroadcastChannel(PREFIX+'tabs'), nonce=newId();
    bc.onmessage=e=>{const d=e.data||{};if(d.hello===TAB&&d.nonce!==nonce)bc.postMessage({taken:TAB,to:d.nonce});else if(d.taken===TAB&&d.to===nonce){TAB=newId();saveTab();}};
    bc.postMessage({hello:TAB,nonce});
  }
  // Discord is the only writer of `calls`; GMGN manual imports go to `manual`, so the two sites never overwrite each other.
  let callsCache=null;
  const calls=()=>callsCache||(callsCache=[...get('calls',[]),...get('manual',[])]), receiver=()=>get('receiver',null);
  const receiverAlive=r=>!!r&&(r.leaving?Date.now()-r.leaving<LEAVE_GRACE:Date.now()-r.at<RECEIVER_TTL);
  let note='', noteUntil=0;
  const notice=t=>{note=t;noteUntil=Date.now()+8000;};
  let status='Starting', current=VTCore.mintFromURL(location.href), fetchError='', polling=false;
  let snapshot=null, lastMint=current, lastResponse=0, lastTracked=0, dexPause=0, isReceiver=false;
  let flow=null, flowError='', flowing=false, lastFlow=0, flowPause=0, gtPools={};
  // GMGN live state for the token on screen: trades seen (deduped by tx), GMGN's token_stat rollup, first/last message time.
  let live=null;
  const resetLive=mint=>{live={mint,since:Date.now(),first:0,at:0,stat:null,trades:[],keys:new Set(),prunedAt:Date.now()};};resetLive(current);
  const tradeKey=t=>t.hash?t.hash+':'+t.side+':'+t.wallet+':'+t.amount:null;
  const liveFresh=()=>!!live&&live.mint===current&&Date.now()-live.at<20000;
  const liveNow=()=>live&&live.mint===current?VTCore.liveView(live.trades,live.stat,live.at,Date.now(),live.first||Infinity):null;
  let renderQueued=false;
  const soon=()=>{if(renderQueued)return;renderQueued=true;setTimeout(()=>{renderQueued=false;render();},250);};
  try{if(typeof GM_listValues==='function'&&!get('cleaned',false)){for(const k of GM_listValues())if(k.startsWith(PREFIX+'mint-alert.'))GM_deleteValue(k);set('cleaned',true);}}catch(_){}
  const root=document.createElement('section'); root.id='vts-root';
  root.innerHTML=`<style>
  #vts-root{--bg:#0f151c;--card:#16202b;--line:#263243;--text:#e8eef6;--muted:#8d9bac;--green:#3ecf8e;--red:#f06b6d;--amber:#f2c45a;--blue:#5b8def;position:fixed;right:16px;bottom:16px;width:360px;max-width:calc(100vw - 24px);z-index:2147483647;color:var(--text);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 10px 36px #000a;overflow:hidden}
  #vts-root *{box-sizing:border-box}#vts-root [hidden]{display:none!important}
  #vts-root header{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:grab;background:var(--card);border-bottom:1px solid var(--line)}
  #vts-root .title{font-weight:700}#vts-root .mini{flex:1;text-align:right;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #vts-root button,#vts-root input,#vts-root select{font:inherit;border:1px solid #33445a;border-radius:7px;background:#1b2735;color:var(--text);padding:6px 9px;max-width:100%}
  #vts-root button{cursor:pointer}#vts-root button:hover{background:#243447}#vts-root button.primary{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:600}#vts-root header button{padding:2px 9px}
  #vts-root .tabs{display:flex;background:var(--card);border-bottom:1px solid var(--line)}
  #vts-root .tabs button{flex:1;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--muted);padding:8px 4px;font-weight:600}
  #vts-root .tabs button.on{color:var(--text);border-bottom-color:var(--blue)}
  #vts-root .vts-body{padding:12px;max-height:min(72vh,640px);overflow:auto}
  #vts-root .status{display:flex;gap:7px;align-items:baseline;color:var(--muted);font-size:11.5px;margin-bottom:10px}
  #vts-root .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--muted)}#vts-root .dot.ok{background:var(--green)}#vts-root .dot.warn{background:var(--amber)}#vts-root .dot.bad{background:var(--red)}
  #vts-root .claim{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
  #vts-root .head{display:flex;gap:8px;align-items:flex-start}#vts-root h3{flex:1;margin:0;font-size:17px;line-height:1.25;word-break:break-word}
  #vts-root .chip{flex:none;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:#2a3442;white-space:nowrap}
  #vts-root .chip.buy{background:#123d2c;color:var(--green)}#vts-root .chip.sell{background:#40191b;color:var(--red)}#vts-root .chip.caution{background:#3d3214;color:var(--amber)}
  #vts-root .mint{color:var(--muted);font:11px ui-monospace,Menlo,monospace;margin:3px 0 12px;word-break:break-all}
  #vts-root .gaugehead{display:flex;justify-content:space-between;align-items:baseline}#vts-root .gaugehead b{font-size:22px}
  #vts-root .gauge{height:10px;position:relative;background:linear-gradient(90deg,var(--red),#55606e 50%,var(--green));border-radius:6px;margin:6px 0 3px}
  #vts-root .needle{height:18px;width:4px;background:#fff;border-radius:2px;position:absolute;top:-4px;margin-left:-2px;box-shadow:0 0 0 2px var(--bg)}
  #vts-root .scale{display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-size:10.5px}
  #vts-root .tiles{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:12px 0}
  #vts-root .tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 8px;min-width:0}
  #vts-root .tile span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  #vts-root .tile b{display:block;font-size:13.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#vts-root .tile i{font-style:normal}
  #vts-root .pos{color:var(--green)}#vts-root .neg{color:var(--red)}#vts-root .warnc{color:var(--amber)}#vts-root .muted{color:var(--muted)}
  #vts-root ul{margin:6px 0;padding-left:18px}#vts-root li{margin:3px 0}#vts-root .flags li{color:var(--amber)}#vts-root .flags li.risk{color:var(--red)}
  #vts-root .strip{display:flex;gap:4px 12px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin:8px 0;cursor:pointer}#vts-root .strip b{color:var(--text)}
  #vts-root .buttons{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
  #vts-root .note{color:var(--muted);font-size:11px;margin:6px 0}#vts-root p{margin:6px 0}
  #vts-root details{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}#vts-root summary{cursor:pointer;color:var(--muted);font-weight:600}
  #vts-root label{display:block;font-size:11.5px;color:var(--muted);margin:6px 0}#vts-root label.check{display:flex;gap:7px;align-items:center;color:var(--text);font-size:12.5px}
  #vts-root input,#vts-root select{width:100%}#vts-root input[type=checkbox]{width:auto;margin:0}
  #vts-root .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}#vts-root .grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  #vts-root h4{margin:14px 0 4px;font-size:13px}#vts-root .row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
  #vts-root .mkt{display:grid;grid-template-columns:minmax(0,1.35fr) repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:12px;margin:8px 0}
  #vts-root .mkt>*{padding:6px 6px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #vts-root .mkt .h{background:var(--card);color:var(--muted);font-weight:600}#vts-root .mkt .l{text-align:left;color:var(--muted)}
  </style>
  <header><span class="title">VolTrak</span><span class="mini" data-vts="mini"></span><button data-vts="collapse" title="Collapse">−</button></header>
  <nav class="tabs" data-vts="tabs"><button data-tab="live">Live</button><button data-tab="market">Market</button><button data-tab="calls">Calls</button><button data-tab="settings">Settings</button></nav>
  <div class="vts-body">
  <div class="status"><span class="dot" data-vts="dot"></span><span data-vts="status"></span></div>
  <section data-pane="live"><div data-vts="gmgn">
    <div class="claim"><button class="primary" data-vts="claim">Use this tab for calls</button><label class="check"><input data-vts="autoload" type="checkbox"> Auto-open new calls</label></div>
    <div class="head"><h3 data-vts="token">Open a Solana token</h3><span class="chip" data-vts="state">UNKNOWN</span></div>
    <div class="mint" data-vts="mint"></div>
    <div class="gaugehead"><span class="muted">Buy share</span><b data-vts="share">—</b></div>
    <div class="gauge"><span class="needle" data-vts="needle" hidden></span></div>
    <div class="scale"><span>Sellers</span><span data-vts="basis"></span><span>Buyers</span></div>
    <div class="tiles" data-vts="metrics"></div>
    <ul class="flags" data-vts="risks"></ul>
    <div class="strip" data-vts="market-strip" title="Open the Market tab"></div>
    <div class="buttons"><button data-vts="refresh">Refresh</button><button data-vts="copy">Copy CA</button></div>
    <p class="note" data-vts="feed"></p>
    <details><summary>Why this reading</summary><ul data-vts="reasons"></ul><p class="note" data-vts="missing"></p><p class="note">The gauge and state are context, not buy/sell orders or probabilities. The backtest in the Calls tab shows what has actually worked.</p></details>
    <details><summary>Recover initials (calculator)</summary><p class="note">GMGN has <b>Sell inits</b> in its Instant Trade tools; place the sale there. Enter all amounts in one currency.</p>
      <div class="grid2"><label>Total buy cost<input data-vts="cost" type="number" min="0" step="any"></label><label>Proceeds received<input data-vts="proceeds" type="number" min="0" step="any" value="0"></label><label>Remaining bag value<input data-vts="bag" type="number" min="0" step="any"></label><label>Fee/slippage %<input data-vts="fee" type="number" min="0" max="99" step="any" value="0"></label><label>Fixed sale cost<input data-vts="fixed" type="number" min="0" step="any" value="0"></label></div>
      <div class="buttons"><button data-vts="initials">Calculate</button></div><p data-vts="initials-result"></p><p class="note">Nothing is submitted by this script. Alt+I opens this calculator.</p></details>
  </div></section>
  <section data-pane="market" hidden>
    <div class="row"><b>pump.fun, market-wide</b><span class="note" data-vts="market-status"></span></div>
    <div class="mkt" data-vts="market"></div><p class="note" data-vts="market-note"></p>
  </section>
  <section data-pane="calls" hidden>
    <p data-vts="discord"><span data-vts="receiver"></span></p>
    <label>Saved calls<select data-vts="call-list"></select></label>
    <div class="buttons"><button data-vts="open">Open on GMGN</button><button data-vts="export">Export data</button></div>
    <label>Add a call: paste an alert or a contract<input data-vts="paste" placeholder="Contract or alert text"></label><div class="buttons"><button data-vts="import">Add</button></div>
    <h4>Backtest</h4><p class="note">Scroll back through the VolTrak channel first: every alert you scroll past is saved. Scoring pulls 2h of 1m candles per call from GeckoTerminal (about 7s per call).</p>
    <div class="grid"><label>Target %<input data-vts="bt-tp" type="number" min="1" step="any"></label><label>Stop loss %<input data-vts="bt-sl" type="number" min="1" max="99" step="any"></label><label>Costs %<input data-vts="bt-cost" type="number" min="0" step="any"></label></div>
    <div class="buttons"><button class="primary" data-vts="bt-run">Score calls</button><button data-vts="bt-report">Open report</button></div><p class="note" data-vts="bt-status"></p>
  </section>
  <section data-pane="settings" hidden>
    <label class="check"><input type="checkbox" data-vts="market-on"> Market feed (PumpPortal)</label>
    <label class="check"><input type="checkbox" data-vts="market-trades"> Include all pump.fun trades (volume, traders)</label>
    <label class="check"><input type="checkbox" data-vts="trades"> GeckoTerminal fallback trade feed</label>
    <label class="check"><input type="checkbox" data-vts="sound"> Voice alert on Discord</label>
    <h4>Data sources</h4>
    <p class="note">Live: GMGN's own page feed (token_activity, token_stat), read-only; nothing is sent on GMGN's connection. Fallbacks: DEX Screener snapshots and GeckoTerminal trades when the live feed is quiet.</p>
    <p class="note">Market: PumpPortal's public data socket (one connection, receiving GMGN tab only) for pump.fun launches, graduations and bonding-curve trades. PumpSwap trades after graduation are not in the free feed.</p>
    <p class="note">No private keys or trading endpoints. Alt+V hides the panel; drag the header to move it. Disable the old VolTrak script before using this one.</p>
  </section>
  </div>`;
  document.body.appendChild(root);
  const $=key=>root.querySelector('[data-vts="'+key+'"]');
  $('discord').hidden=!DISCORD; $('gmgn').hidden=!GMGN;
  // Tabs: Live is GMGN-only; the last tab used is remembered per site.
  const tabKey='tab.'+(GMGN?'gmgn':'discord');
  root.querySelector('[data-tab="live"]').hidden=!GMGN;
  function showTab(name){
    if(name==='live'&&!GMGN||!root.querySelector('[data-pane="'+name+'"]'))name=GMGN?'live':'calls';
    root.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('on',b.dataset.tab===name));
    root.querySelectorAll('[data-pane]').forEach(p=>p.hidden=p.dataset.pane!==name);set(tabKey,name);
  }
  root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
  showTab(get(tabKey,GMGN?'live':'calls'));
  $('market-strip').onclick=()=>showTab('market');
  $('autoload').checked=get('autoload',true); $('sound').checked=get('sound',true); $('trades').checked=get('trades',true);
  $('autoload').onchange=()=>set('autoload',$('autoload').checked);
  $('sound').onchange=()=>set('sound',$('sound').checked);
  $('trades').onchange=()=>{set('trades',$('trades').checked);flow=null;flowError='';render();};
  $('market-on').checked=get('marketOn',true); $('market-trades').checked=get('marketTrades',true);
  $('market-on').onchange=()=>{set('marketOn',$('market-on').checked);marketDisconnect();render();};
  $('market-trades').onchange=()=>{set('marketTrades',$('market-trades').checked);marketDisconnect();render();};
  {const o=get('bt.opt',{tp:100,sl:-50,cost:3});$('bt-tp').value=o.tp;$('bt-sl').value=Math.abs(o.sl);$('bt-cost').value=o.cost;}
  $('collapse').onclick=()=>{const b=root.querySelector('.vts-body'),hide=!b.hidden;b.hidden=hide;$('tabs').hidden=hide;$('collapse').textContent=hide?'+':'−';};
  let drag=null;
  root.querySelector('header').onpointerdown=e=>{if(e.target.closest('button'))return;const b=root.getBoundingClientRect();drag={x:e.clientX-b.left,y:e.clientY-b.top};e.currentTarget.setPointerCapture(e.pointerId);};
  root.querySelector('header').onpointermove=e=>{if(!drag)return;root.style.left=Math.max(0,Math.min(innerWidth-root.offsetWidth,e.clientX-drag.x))+'px';root.style.top=Math.max(0,Math.min(innerHeight-root.offsetHeight,e.clientY-drag.y))+'px';root.style.right='auto';root.style.bottom='auto';};
  root.querySelector('header').onpointerup=()=>{drag=null;};
  // e.code, not e.key: on macOS Option+V types "√", so e.key never equals "v".
  document.addEventListener('keydown',e=>{if(!e.altKey||e.ctrlKey||e.metaKey)return;if(e.code==='KeyV'){root.hidden=!root.hidden;e.preventDefault();}if(GMGN&&e.code==='KeyI'){root.hidden=false;root.querySelector('.vts-body').hidden=false;$('tabs').hidden=false;showTab('live');$('initials').closest('details').open=true;e.preventDefault();}});
  function listText(el,rows){el.replaceChildren(...rows.map(t=>{const li=document.createElement('li');li.textContent=t;return li;}));}
  const fmt=n=>n==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:1,notation:'compact'}).format(n);
  const usd=n=>n==null?'—':'$'+fmt(n);
  const ago=t=>t==null?'—':Math.max(0,Math.round((Date.now()-t)/1000))+'s ago';
  const freshFlow=()=>flow&&flow.mint===current&&Date.now()-flow.at<=30000?flow:null;
  let listSignature='';
  function render(){
    const all=calls().slice().sort((a,b)=>b.messageAt-a.messageAt), signature=all.map(c=>c.id).join('|');
    if(signature!==listSignature){const v=$('call-list').value;$('call-list').replaceChildren(...all.slice(0,100).map(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name+' · '+new Date(c.messageAt).toLocaleTimeString()+(c.historical?' · history':'');return o;}));if(all.some(c=>c.id===v))$('call-list').value=v;listSignature=signature;}
    renderMarket();renderBt();
    $('status').textContent=(Date.now()<noteUntil?note+' · ':'')+status+(hasLocks?'':' · Web Locks unavailable: tab coordination is best effort');
    if(DISCORD){
      const alive=receiverAlive(receiver());
      $('dot').className='dot '+(alive?'ok':'warn');
      $('receiver').textContent=alive?'✓ GMGN receiver connected: new calls open there automatically.':'No GMGN receiver: open a GMGN token page and press “Use this tab for calls”.';
      $('mini').textContent=alive?'receiver connected':'no GMGN receiver';$('mini').className='mini '+(alive?'pos':'warnc');
      return;
    }
    const now=Date.now(), c=all.find(x=>x.mint===current)||null, f=freshFlow(), L=liveNow(), a=VTCore.assess(c,snapshot,now,fetchError,f,L);
    const Lf=L&&now-L.at<=15000?L:null, st=Lf?.stat&&now-Lf.stat.at<=15000?Lf.stat:null, lf=Lf?.flow||null;
    $('dot').className='dot '+(Lf?'ok':snapshot||f?'warn':'bad');
    $('claim').textContent=isReceiver?'✓ This tab receives calls':'Use this tab for calls';$('claim').className=isReceiver?'':'primary';
    $('token').textContent=c?.name|| (current?'Token':'Open a Solana token');$('mint').textContent=current||'';
    $('feed').textContent='Sources: '+(Lf?'GMGN live ('+ago(Lf.at)+')':VTLive.attachedAt()?'GMGN live waiting for this token':'GMGN live not connected')+' · '+(snapshot?'DEX Screener ('+ago(snapshot.at)+')':'DEX Screener: no pool yet')+(get('trades',true)&&!Lf?' · '+(flowError||(f?'GeckoTerminal ('+ago(f.at)+')':'GeckoTerminal starting')):'');
    const tone=a.state==='WATCH BUY SETUP'?'buy':a.state==='FADE / REVIEW EXIT'?'sell':a.state==='CAUTION'?'caution':'', share=a.share==null?'—':Math.round(a.share)+'%';
    $('state').textContent=a.state;$('state').className='chip '+tone;
    $('share').textContent=share;$('share').className=a.share==null?'':a.share>=60?'pos':a.share<=40?'neg':'';
    $('needle').hidden=a.share==null;if(a.share!=null)$('needle').style.left=Math.max(0,Math.min(100,a.share))+'%';
    $('basis').textContent=a.basis||'no data yet';
    $('mini').textContent=current?a.state+(a.share==null?'':' · '+share+' buys'):'';$('mini').className='mini '+({buy:'pos',sell:'neg',caution:'warnc'}[tone]||'');
    const w1=st?.m1||lf?.m1||f?.m1, wallets=lf||f, part=w=>w.complete?'':'+', last=Lf?.last, mc=Lf?.marketCap??snapshot?.marketCap, move=mc>0&&c?.callMc>0?(mc/c.callMc-1)*100:null;
    const split=(x,y)=>[[x,'pos'],[' / ',''],[y,'neg']];
    const tiles=[['1m buys / sells',w1?split(w1.buys??'—',w1.sells??'—'):'—'],['1m buy $ / sell $',w1?split(usd(w1.buyUsd),usd(w1.sellUsd)):'—'],
      ['5m buys / sells',st?split(st.m5.buys??'—',st.m5.sells??'—'):snapshot?split(snapshot.buys5m??'—',snapshot.sells5m??'—'):'—'],['5m / 1h volume',st?usd(st.m5.volume)+' / '+usd(st.h1.volume):usd(snapshot?.volume5m)+' / '+usd(snapshot?.volume1h)],
      ['Wallets 1m / 5m',wallets?wallets.m1.wallets+part(wallets.m1)+' / '+wallets.m5.wallets+part(wallets.m5):'—'],['Last trade',last?[[last.side+' '+usd(last.usd),last.side==='buy'?'pos':'neg'],[' · '+ago(last.at),'muted']]:f?ago(f.lastTradeAt):'—'],
      ['Market cap',mc?[[usd(mc),''],...(move==null?[]:[[' '+(move>=0?'+':'')+move.toFixed(0)+'% vs call',move>=0?'pos':'neg']])]:'—'],['Call MC',usd(c?.callMc)],
      ['Liquidity',usd(snapshot?.liquidity)],['Main pool',snapshot?(snapshot.dex||'DEX')+(snapshot.pools>1?' +'+(snapshot.pools-1)+' more':''):'—'],
      ['At call',c?.migrated==null?'—':c.migrated?'Migrated':'Bonding curve'],['Largest cluster',c?.clusters?.length?Math.max(...c.clusters)+'%':'—']];
    $('metrics').replaceChildren(...tiles.map(([k,v])=>{
      const d=document.createElement('div'),l=document.createElement('span'),r=document.createElement('b');d.className='tile';l.textContent=k;
      if(Array.isArray(v))v.forEach(([t,cls])=>{const i=document.createElement('i');if(cls)i.className=cls;i.textContent=t;r.append(i);});else r.textContent=v;
      r.title=r.textContent;d.append(l,r);return d;}));
    const item=(t,cls)=>{const li=document.createElement('li');if(cls)li.className=cls;li.textContent=t;return li;};
    $('risks').replaceChildren(...a.risks.map(t=>item(t,'risk')),...a.flags.map(t=>item(t,'')));
    listText($('reasons'),a.reasons);$('missing').textContent=a.missing.length?'Missing: '+a.missing.join(' · '):'';
  }
  async function addCall(call){
    const key=call.manual?'manual':'calls', cap=call.manual?100:500;
    return locked('write.'+key,()=>{const all=get(key,[]);if(all.some(c=>c.id===call.id))return false;set(key,[call,...all].slice(0,cap));callsCache=null;return true;});
  }
  function announce(call){
    // Only Discord announces. No sound in GMGN and no repeated speech after navigation.
    if(!get('sound',true))return;
    try{const u=new SpeechSynthesisUtterance('VolTrak. '+call.name+'. Check Steroids.');u.rate=1.05;speechSynthesis.speak(u);}catch(_){}
  }
  function http(url){return new Promise(resolve=>GM_xmlhttpRequest({method:'GET',url,headers:{Accept:'application/json'},timeout:8000,onload:r=>{let data=null;if(r.status===200)try{data=JSON.parse(r.responseText);}catch(_){}resolve({status:r.status,data});},onerror:()=>resolve({status:0,data:null}),ontimeout:()=>resolve({status:0,data:null})}));}
  // Switch tokens inside GMGN's page (its Next.js router) instead of a full reload; reload if the router is missing or stalls.
  let kick=()=>{};
  function openToken(mint){
    const url=VTCore.gmgnURL(mint), from=location.href;
    let router=null;try{router=(typeof unsafeWindow!=='undefined'?unsafeWindow:window).next?.router;}catch(_){}
    if(typeof router?.push!=='function'){location.assign(url);return;}
    try{Promise.resolve(router.push(new URL(url).pathname)).then(()=>kick(),()=>location.assign(url));}catch(_){location.assign(url);return;}
    setTimeout(()=>{if(location.href===from)location.assign(url);},4000);
  }
  // Market-wide pump.fun activity from PumpPortal's public data socket. Only the receiving GMGN tab connects (one socket);
  // it shares a snapshot every 10s so the Discord tab can show it too.
  const PP='wss://pumpportal.fun/api/data', SOL='So11111111111111111111111111111111111111112', tape=VTCore.marketTape();
  let pp=null, ppStatus='off', ppSince=0, ppTries=0, ppNext=0, ppTrades=0, solUsd=null, solAt=0, solTry=0, lastSnap=0;
  function marketConnect(){
    if(pp||Date.now()<ppNext)return;
    let ws;try{ws=new WebSocket(PP);}catch(_){ppStatus='blocked by this page';ppNext=Date.now()+60000;return;}
    pp=ws;ppStatus='connecting';
    ws.addEventListener('open',()=>{if(pp!==ws)return;ppStatus='connected';ppSince=Date.now();ppTries=0;
      ws.send(JSON.stringify({method:'subscribeNewToken'}));ws.send(JSON.stringify({method:'subscribeMigration'}));
      if(get('marketTrades',true))ws.send(JSON.stringify({method:'subscribeTokenTrade',keys:[]}));});
    ws.addEventListener('message',e=>{if(pp!==ws)return;const ev=VTCore.ppEvent(e.data);if(ev.kind==='trade')ppTrades++;tape.add(ev,Date.now());});
    ws.addEventListener('error',()=>{if(pp===ws)ppStatus='connection failed (blocked or offline)';});
    ws.addEventListener('close',()=>{if(pp!==ws)return;pp=null;ppTries=Math.min(ppTries+1,5);ppNext=Date.now()+2000*2**ppTries;ppStatus='reconnecting';});
  }
  function marketDisconnect(){const ws=pp;pp=null;ppStatus='off';ppSince=0;ppNext=0;if(ws)try{ws.close();}catch(_){}}
  async function refreshSol(){
    if(Date.now()-solAt<300000||Date.now()-solTry<60000)return;
    solTry=Date.now();const r=await http(DEX+SOL), pair=VTCore.selectPair(Array.isArray(r.data)?r.data:null,SOL,null);
    if(pair){solUsd=VTCore.number(pair.priceUsd);solAt=Date.now();}
  }
  const marketView=()=>({at:Date.now(),status:ppStatus,since:ppSince,trades:ppTrades>0,windows:tape.windows(Date.now(),ppSince||Date.now(),solUsd)});
  function renderMarket(){
    const on=get('marketOn',true), own=GMGN&&isReceiver&&on, m=own?marketView():get('marketSnap',null), fresh=on&&!!m&&Date.now()-m.at<30000&&!!m.since;
    $('market-status').textContent=!on?'off':own?ppStatus+(ppSince?' · listening '+Math.floor((Date.now()-ppSince)/60000)+'m':''):fresh?'via the receiving GMGN tab':'';
    if(!fresh){
      $('market').replaceChildren();$('market-strip').replaceChildren();
      $('market-note').textContent=!on?'The market feed is off (Settings).':own?'Connecting to PumpPortal…':'Market numbers come from the receiving GMGN tab: open a GMGN token page and press “Use this tab for calls”.';
      return;
    }
    const W=m.windows, mins=[1,5,10,30], plus=k=>W[k].complete?'':'+', cells=[];
    const add=(cls,t)=>{const e=document.createElement('span');if(cls)e.className=cls;e.textContent=t;cells.push(e);};
    add('h l','Last');mins.forEach(k=>add('h',k+'m'));
    const line=(label,val)=>{add('l',label);mins.forEach(k=>add('',val(W[k])+plus(k)));};
    const vol=w=>w.usd!=null?usd(w.usd):fmt(w.sol)+' SOL';
    line('Graduated',w=>w.migrations);line('Launches',w=>w.creates);
    if(m.trades){line('Volume',vol);line('Traders',w=>fmt(w.traders));line('Per token',w=>w.tokens?(w.traders/w.tokens).toFixed(1):'—');}
    $('market').replaceChildren(...cells);
    $('market-note').textContent=(m.trades?'Volume and traders: pump.fun bonding-curve trades only; per token = average traders per traded token. ':get('marketTrades',true)?'No trade data yet: PumpPortal may not stream all trades for free. ':'')+'"+" = still filling (listening for less than that window).';
    const strip=[['Graduated 5m',W[5].migrations+plus(5)],['30m',W[30].migrations+plus(30)]];
    if(m.trades)strip.push(['Traders 5m',fmt(W[5].traders)+plus(5)],['Volume 5m',vol(W[5])+plus(5)]);
    $('market-strip').replaceChildren(...strip.map(([k,v])=>{const s=document.createElement('span'),b=document.createElement('b');s.append(k+' ');b.textContent=v;s.append(b);return s;}));
  }
  // Backtest: score saved calls against GeckoTerminal 1m candles. Candles are cached per call, so changing the
  // target, stop or costs re-scores instantly without refetching.
  const BT_H=120, sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let btRunning=false, btStop=false, btNote='', gtLast=0;
  async function gtGet(url){
    for(;;){
      const wait=gtLast+2200-Date.now();if(wait>0)await sleep(wait);
      gtLast=Date.now();const r=await http(url);
      if(r.status!==429||btStop)return r;
      btNote='GeckoTerminal rate limit: waiting 60s';renderBt();await sleep(60000);
    }
  }
  // 'ok' | 'no-data' | 'no-trades', or null to retry on a later run.
  async function fetchCandles(c){
    const p=await gtGet(GT+'tokens/'+c.mint+'/pools');
    if(p.status===404)return 'no-data';
    if(p.status!==200)return null;
    const pools=VTCore.gtPools(p.data,c.mint).slice(0,2);
    if(!pools.length)return 'no-data';
    const before=Math.floor((c.messageAt+(BT_H+1)*60000)/1000), lists=[];
    for(const pool of pools){
      const r=await gtGet(GT+'pools/'+pool+'/ohlcv/minute?aggregate=1&limit=300&before_timestamp='+before);
      if(r.status===200)lists.push(VTCore.candles(r.data?.data?.attributes?.ohlcv_list));
    }
    if(!lists.length)return null;
    const cs=VTCore.mergeCandles(lists).filter(k=>k.t>=c.messageAt-120000&&k.t<=c.messageAt+BT_H*60000);
    set('bt.c.'+c.id,cs.map(k=>[k.t/1000,k.o,k.h,k.l,k.c,k.v]));
    return cs.length?'ok':'no-trades';
  }
  const btCandidates=()=>calls().filter(c=>!c.manual&&VTCore.MINT.test(c.mint)&&Number.isFinite(c.messageAt));
  function renderBt(){
    const done=get('bt.done',{}), all=btCandidates(), ok=all.filter(c=>done[c.id]==='ok').length, none=all.filter(c=>done[c.id]&&done[c.id]!=='ok').length;
    const young=all.filter(c=>!done[c.id]&&Date.now()-c.messageAt<=(BT_H+5)*60000).length, left=all.length-ok-none-young;
    $('bt-run').textContent=btRunning?'Stop':'Score calls';
    $('bt-status').textContent=(btNote?btNote+' · ':'')+all.length+' saved calls: '+ok+' with candles, '+none+' without price data, '+left+' to score, '+young+' under '+(BT_H+5)+' min old.';
  }
  async function runBacktest(){
    if(btRunning){btStop=true;btNote='Stopping…';renderBt();return;}
    btRunning=true;btStop=false;
    try{
      const done=get('bt.done',{}), now=Date.now();
      const todo=btCandidates().filter(c=>!done[c.id]&&now-c.messageAt>(BT_H+5)*60000).sort((a,b)=>b.messageAt-a.messageAt);
      if(!todo.length){btNote='Nothing new to score';return;}
      for(let i=0;i<todo.length&&!btStop;i++){
        btNote='Scoring '+(i+1)+' of '+todo.length+' (about '+Math.ceil((todo.length-i)*7/60)+' min left)';renderBt();
        const status=await fetchCandles(todo[i]);
        if(status){const d=get('bt.done',{});d[todo[i].id]=status;set('bt.done',d);}
      }
      btNote=btStop?'Stopped; run again to continue':'Done: open the report';
    }finally{btRunning=false;btStop=false;renderBt();}
  }
  function openReport(){
    const tp=Math.max(1,+$('bt-tp').value||100), sl=-Math.min(99,Math.abs(+$('bt-sl').value||50)), cost=Math.max(0,+$('bt-cost').value||0);
    set('bt.opt',{tp,sl,cost});
    const done=get('bt.done',{}), items=[];let noData=0;
    for(const c of btCandidates()){
      if(done[c.id]!=='ok'){if(done[c.id])noData++;continue;}
      const score=VTCore.scoreCall(VTCore.candles(get('bt.c.'+c.id,[])),c.messageAt,{tp,sl,horizon:BT_H});
      if(score.status==='scored')items.push({call:c,score});else noData++;
    }
    showReport(VTCore.backtestReport(items,cost),items,{tp,sl,cost,noData});
  }
  function showReport(rep,items,o){
    document.getElementById('vts-report')?.remove();
    const pct=v=>v==null?'—':(v>=0?'+':'')+v.toFixed(0)+'%', rate=r=>r.winRate==null?'—':r.winRate.toFixed(0)+'% ('+r.lo.toFixed(0)+'–'+r.hi.toFixed(0)+'%)';
    const el=(tag,css,text)=>{const e=document.createElement(tag);if(css)e.style.cssText=css;if(text!=null)e.textContent=text;return e;};
    const C={card:'#16202b',line:'#263243',muted:'#8d9bac',green:'#3ecf8e',red:'#f06b6d',amber:'#f2c45a'};
    const wrap=el('div','position:fixed;inset:0;z-index:2147483647;background:#05080ccc;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8eef6');wrap.id='vts-report';
    const box=el('section','position:absolute;inset:4vh max(4vw,calc(50vw - 520px));overflow:auto;background:#0f151c;border:1px solid '+C.line+';border-radius:14px;padding:18px 22px;box-shadow:0 10px 40px #000c');
    wrap.onclick=e=>{if(e.target===wrap)wrap.remove();};wrap.append(box);
    const btn=(text,name)=>{const b=el('button','font:inherit;border:1px solid #33445a;border-radius:7px;background:#1b2735;color:#e8eef6;padding:6px 10px;cursor:pointer',text);b.dataset.r=name;return b;};
    const head=el('div','display:flex;gap:8px;align-items:center;margin-bottom:10px'), csv=btn('Download CSV','csv'), close=btn('Close','close');
    head.append(el('h2','margin:0;flex:1;font-size:18px','Backtest of saved VolTrak calls'),csv,close);box.append(head);close.onclick=()=>wrap.remove();
    csv.onclick=()=>{
      const cols=['name','symbol','mint','alert_time','call_mc','age_min','largest_cluster','bot_share','fresh_share','top_holder','holders','outcome','trade_return','peak','peak_min','trough','r5','r15','r60'];
      const q=v=>v==null?'':/[",\n]/.test(String(v))?'"'+String(v).replace(/"/g,'""')+'"':String(v);
      const lines=items.map(({call:c,score:s})=>[c.name,c.symbol,c.mint,new Date(c.messageAt).toISOString(),c.callMc,c.ageSeconds==null?null:(c.ageSeconds/60).toFixed(1),c.clusters?.length?Math.max(...c.clusters):null,
        c.holders>0&&c.bots!=null?(100*c.bots/c.holders).toFixed(1):null,c.holders>0&&c.fresh!=null?(100*c.fresh/c.holders).toFixed(1):null,c.topHolder,c.holders,s.outcome,s.ret.toFixed(1),s.peakPct.toFixed(1),s.peakMin.toFixed(1),s.troughPct.toFixed(1),s.r5.toFixed(1),s.r15.toFixed(1),s.r60.toFixed(1)].map(q).join(','));
      const url=URL.createObjectURL(new Blob([[cols.join(','),...lines].join('\n')],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='voltrak-backtest-'+Date.now()+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    const a=rep.all, t=rep.timing;
    box.append(el('p','margin:0 0 12px;color:'+C.muted,'Rules: buy at the alert minute\'s close; sell at +'+o.tp+'% or '+o.sl+'%, whichever comes first, otherwise at the price after '+BT_H+' min. Costs '+o.cost+'% per trade. '+o.noData+' saved call'+(o.noData===1?'':'s')+' had no price data.'));
    document.body.append(wrap);
    if(!a.n){box.append(el('p','color:'+C.amber,'No scored calls yet. Scroll back through the VolTrak channel, then press "Score calls" in the Calls tab.'));return;}
    const tiles=el('div','display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px'), tile=(label,value,color,sub)=>{
      const d=el('div','background:'+C.card+';border:1px solid '+C.line+';border-radius:10px;padding:8px 10px');
      d.append(el('div','color:'+C.muted+';font-size:10.5px;text-transform:uppercase;letter-spacing:.05em',label),el('div','font-size:20px;font-weight:700;color:'+(color||'inherit'),value));
      if(sub)d.append(el('div','color:'+C.muted+';font-size:11px',sub));tiles.append(d);};
    tile('Calls scored',String(a.n));
    tile('Win rate',a.winRate.toFixed(0)+'%',null,'95% range '+a.lo.toFixed(0)+'–'+a.hi.toFixed(0)+'%');
    tile('Avg per trade',pct(a.ev),a.ev>=0?C.green:C.red,'after '+o.cost+'% costs');
    tile('Median peak',pct(a.medianPeak),null,'median '+(t.peakMin==null?'—':t.peakMin.toFixed(0)+' min')+' to peak');
    tile('After 5 / 15 / 60 min',pct(t.r5)+' '+pct(t.r15)+' '+pct(t.r60),null,'median price change');
    box.append(tiles);
    if(a.n<30)box.append(el('p','margin:0 0 12px;padding:8px 10px;border-radius:8px;background:#3d3214;color:'+C.amber,'Only '+a.n+' calls scored: too few to trust any pattern. Scroll further back in the channel and score again; 100+ calls gives usable ranges.'));
    box.append(el('p','margin:0 0 4px;color:'+C.muted,'Peaks: '+t.peakWithin5.toFixed(0)+'% of calls peaked within 5 min, '+t.peakWithin15.toFixed(0)+'% within 15, '+t.peakWithin60.toFixed(0)+'% within 60.'));
    box.append(el('p','margin:0 0 8px;color:'+C.muted,'Win = target hit before the stop. A bucket only "stands out" (green or red) when it has at least 15 calls and its whole 95% range sits above or below the all-calls win rate. Past calls only: a filter is worth using only if it keeps working on new calls.'));
    const widths=['22%','10%','26%','14%','14%','14%'];
    for(const f of rep.features){
      box.append(el('h3','margin:16px 0 4px;font-size:14px',f.name));
      const table=el('table','border-collapse:collapse;width:100%;max-width:900px;table-layout:fixed'), cg=el('colgroup');
      widths.forEach(w=>{const c=el('col');c.style.width=w;cg.append(c);});table.append(cg);
      const hr=el('tr');['Bucket','Calls','Win rate (95% range)','Avg per trade','Median peak',''].forEach(h=>hr.append(el('th','text-align:left;color:'+C.muted+';font-weight:600;padding:4px 8px;border-bottom:1px solid '+C.line,h)));table.append(hr);
      for(const r of f.rows){
        const color=r.standsOut==='above'?C.green:r.standsOut==='below'?C.red:r.few?'#6f7d8d':'', tr=el('tr',color?'color:'+color:'');
        [r.label,String(r.n),rate(r),pct(r.ev),pct(r.medianPeak),r.standsOut==='above'?'better than average':r.standsOut==='below'?'worse than average':r.few?'too few calls':''].forEach(v=>tr.append(el('td','padding:4px 8px;border-bottom:1px solid #1b2531',v)));
        table.append(tr);
      }
      box.append(table);
    }
  }
  async function ownReceiver(force=false){
    return locked('receiver',()=>{const r=receiver();if(force||!receiverAlive(r)||r.id===TAB){set('receiver',{id:TAB,at:Date.now()});return true;}return false;});
  }
  let receiving=false;
  async function receiveLatest(){
    if(receiving||!get('autoload',true))return;
    receiving=true;
    try{
      // Re-takes a lapsed role (e.g. a throttled background tab); never takes a live one from another tab.
      if(receiver()?.id!==TAB&&!await ownReceiver())return;
      await locked('handoff',()=>{
        const call=get('latest',null), receipts=get('receipts',{});
        const action=VTCore.handoff(call,receipts,VTCore.mintFromURL(location.href),Date.now());
        if(action!=='navigate'&&action!=='already-open')return;
        // Durable receipt BEFORE navigation: startup replay cannot reload this call again.
        receipts[call.id]=Date.now();set('receipts',Object.fromEntries(Object.entries(receipts).sort((a,b)=>b[1]-a[1]).slice(0,1000)));
        notice('Received '+call.name+' once');
        if(action==='navigate')openToken(call.mint);
      });
    }finally{receiving=false;}
  }
  async function poll(force=false){
    if(!GMGN||polling||!current)return;
    const now=Date.now(), visible=!document.hidden;
    if(!force&&now<dexPause)return;
    // Open token: every 3s while visible. Receiver also records recent calls every 10s. Hidden display-only tabs stay quiet.
    const dueTracked=isReceiver&&(force||now-lastTracked>=TRACK_MS), dueCurrent=force||(visible&&now-lastResponse>=(liveFresh()?TRACK_MS:CURRENT_MS));
    if(!dueTracked&&!dueCurrent)return;
    polling=true;
    const mintAtStart=current;
    try{
      const tracked=dueTracked?[...new Set([current,...calls().filter(c=>!c.historical&&now-c.receivedAt<90*60000).map(c=>c.mint)])].slice(0,20):[current];
      const res=await http(DEX+tracked.join(',')), at=Date.now(), rows=Array.isArray(res.data)?res.data:null;
      if(current===mintAtStart)lastResponse=at;if(dueTracked)lastTracked=at;
      if(res.status===429){dexPause=at+30000;fetchError='DEX Screener rate limit; paused 30s';render();return;}
      if(rows===null){fetchError='DEX request failed ('+(res.status||'network')+'); gauge withheld';render();return;}
      fetchError='';
      for(const mint of tracked){
        const key='samples.'+mint, samples=dueTracked?get(key,[]):[], previous=samples[samples.length-1];
        const pair=VTCore.selectPair(rows,mint,(mint===current&&snapshot?.pair)||previous?.pair), s=VTCore.normalize(pair,at,rows);
        if(mint===current){snapshot=s;fetchError=s?'':'No indexed pool yet; this does not mean zero trading';}
        if(!s||!dueTracked)continue;
        const f=mint===current?freshFlow():null;
        if(f)s.trades1m={buys:f.m1.buys,sells:f.m1.sells,buyUsd:f.m1.buyUsd,sellUsd:f.m1.sellUsd,wallets:f.m1.wallets,complete:f.m1.complete};
        const L=mint===current?liveNow():null;
        if(L?.stat&&at-L.stat.at<=15000){s.gmgn1m={...L.stat.m1};s.gmgn5m={...L.stat.m5};}
        set(key,[...samples.filter(x=>at-x.at<2*3600000),s].slice(-720));
      }
      if(dueTracked){
        const keys=get('recordedMints',[]);const merged=[...new Set([...tracked,...keys])];set('recordedMints',merged.slice(0,100));
        // Bound browser storage by removing only this version's oldest market observations.
        for(const mint of merged.slice(100))GM_deleteValue(PREFIX+'samples.'+mint);
      }
      render();
    }finally{polling=false;}
  }
  async function pollFlow(force=false){
    if(!GMGN||flowing||!current||!get('trades',true)||liveFresh())return;
    const now=Date.now(), mint=current, dexPair=snapshot?.pair;
    if(!force&&(now<flowPause||now-lastFlow<FLOW_MS||(document.hidden&&!isReceiver)))return;
    if(!dexPair)return;
    flowing=true;lastFlow=now;
    try{
      let pool=gtPools[dexPair]||dexPair, r=await http(GT+'pools/'+pool+'/trades');
      if(r.status===404&&!gtPools[dexPair]){
        // GeckoTerminal may index the pool under another address: look it up once per pool.
        const p=await http(GT+'tokens/'+mint+'/pools'), found=p.status===200?VTCore.gtPool(p.data,mint,dexPair):null;
        if(p.status===429)r=p;
        else if(p.status!==200){flowError='Trade feed request failed ('+(p.status||'network')+')';return;}
        else if(!found){flowError='Trade feed has not indexed this token yet';flowPause=Date.now()+20000;return;}
        else{gtPools[dexPair]=pool=found;r=await http(GT+'pools/'+pool+'/trades');}
      }
      if(mint!==current)return;
      if(r.status===429){flowPause=Date.now()+60000;flowError='Trade feed rate limit; paused 60s';return;}
      if(!Array.isArray(r.data?.data)){flowError='Trade feed request failed ('+(r.status||'network')+')';return;}
      flow={...VTCore.tradeFlow(r.data.data,mint,Date.now()),mint};flowError='';
    }finally{flowing=false;render();}
  }
  // Background tabs throttle timers to once a minute; a worker's messages are not throttled, so it keeps hidden tabs ticking.
  function every(ms,fn){
    setInterval(fn,ms);
    try{const w=new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),'+ms+')'],{type:'text/javascript'})));w.onmessage=()=>{if(document.hidden)fn();};}catch(_){}
  }
  $('claim').onclick=async()=>{await ownReceiver(true);isReceiver=true;notice('This GMGN tab receives calls');render();await poll(true);pollFlow(true);};
  $('refresh').onclick=()=>{poll(true);pollFlow(true);};
  $('bt-run').onclick=()=>runBacktest();$('bt-report').onclick=()=>openReport();$('copy').onclick=()=>{if(current)GM_setClipboard(current,'text');};
  $('initials').onclick=()=>{
    const raw=['cost','proceeds','bag','fee','fixed'].map(k=>$(k).value.trim());
    if(raw.some(x=>x==='')){$('initials-result').textContent='Fill every amount first.';return;}
    const r=VTCore.initials(...raw.map(Number));
    $('initials-result').textContent=r.error|| (r.already?'Initial cost already recovered.':r.covered?'Estimated sale: '+r.pct.toFixed(2)+'% of remaining tokens to recover '+r.need.toFixed(6)+' before any unmodelled costs.':'Even 100% would not recover initials; estimated shortfall '+r.shortfall.toFixed(6)+'.');
  };
  $('open').onclick=()=>{const c=calls().find(c=>c.id===$('call-list').value);if(!c)return;if(GMGN){if(VTCore.mintFromURL(location.href)!==c.mint)openToken(c.mint);}else GM_openInTab(VTCore.gmgnURL(c.mint),{active:true,insert:true});};
  $('import').onclick=async()=>{
    const input=$('paste').value.trim(), parsed=VTCore.parseAlert(input);
    const c=parsed||(VTCore.MINT.test(input)?{mint:input,name:input.slice(0,8),clusters:[]}:null);
    if(!c){notice('Paste a contract or the complete alert text');render();return;}
    await addCall({...c,id:'manual-'+crypto.randomUUID(),messageAt:Date.now(),receivedAt:Date.now(),historical:true,manual:true});notice('Added for review; paste time is not original alert time');$('paste').value='';render();
  };
  $('export').onclick=()=>{
    const all=calls(), mints=get('recordedMints',[]), payload={version:VERSION,exportedAt:new Date().toISOString(),calls:all,
      coverage:{feed:'DEX Screener rolling snapshots summed over indexed pools; gmgn1m/gmgn5m from GMGN\'s page feed and trades1m from GeckoTerminal, open token only',tradeByTrade:false,upstreamTimestamps:false,marketWide:false,retention:'500 calls; 100 observed mints; at most 2h/720 observations per mint (10s cadence); only while receiver runs'},
      samples:Object.fromEntries(mints.map(m=>[m,get('samples.'+m,[])]))};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='voltrak-steroids-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  GM_addValueChangeListener(PREFIX+'calls',()=>{callsCache=null;render();});
  GM_addValueChangeListener(PREFIX+'manual',()=>{callsCache=null;render();});
  GM_addValueChangeListener(PREFIX+'marketSnap',()=>{if(!(GMGN&&isReceiver))renderMarket();});
  GM_addValueChangeListener(PREFIX+'bt.done',()=>renderBt());
  if(GMGN){
    GM_addValueChangeListener(PREFIX+'latest',()=>receiveLatest());
    VTLive.on(frame=>{
      const now=Date.now(), pageMint=VTCore.mintFromURL(location.href);
      if(!pageMint)return;
      if(live.mint!==pageMint)resetLive(pageMint);
      let changed=false;
      for(const x of frame.items){
        // Only the token on screen. Rows without an address are trusted once the page has been on its token for 3s.
        const a=VTCore.addrOf(x);if(a?a!==pageMint:now-live.since<3000)continue;
        if(frame.channel==='token_stat'){live.stat=VTCore.gmgnStat(x,now);changed=true;continue;}
        const t=VTCore.gmgnTrade(x), key=t&&tradeKey(t);if(!t||key&&live.keys.has(key))continue;
        if(key)live.keys.add(key);live.trades.push(t);changed=true;
        if(t.sol>0&&t.usd>0){solUsd=t.usd/t.sol;solAt=now;}
      }
      if(!changed)return;
      live.at=now;live.first=live.first||now;
      if(now-live.prunedAt>10000){live.prunedAt=now;live.trades=live.trades.filter(t=>now-t.at<=360000).slice(-3000);live.keys=new Set(live.trades.map(tradeKey).filter(Boolean));}
      soon();
    });
    // Mark the role as leaving: this tab's next page takes it back at once; if the tab closed, another can take it after 20s.
    addEventListener('pagehide',()=>{const r=receiver();if(r?.id===TAB)set('receiver',{...r,leaving:Date.now()});});
    let ticking=false, lastBeat=0;
    async function tick(){
      if(ticking)return;ticking=true;
      try{
        const next=VTCore.mintFromURL(location.href);
        if(next!==lastMint){lastMint=next;current=next;snapshot=null;flow=null;gtPools={};fetchError='';flowError='';lastResponse=0;lastFlow=0;if(live.mint!==next)resetLive(next);}
        if(Date.now()-lastBeat>=5000){lastBeat=Date.now();isReceiver=await ownReceiver();}
        status=(isReceiver?'Receiving calls':'Display only: another GMGN tab receives calls')+' · '+(liveFresh()?'live from GMGN':'fallback data');
        if(isReceiver)receiveLatest();
        if(isReceiver&&get('marketOn',true)){
          marketConnect();refreshSol();
          if(Date.now()-lastSnap>=10000){lastSnap=Date.now();tape.prune(lastSnap);if(ppSince)set('marketSnap',marketView());}
        }else if(pp)marketDisconnect();
        poll();pollFlow();render();
      }finally{ticking=false;}
    }
    // Short delay lets a duplicated tab learn it needs a fresh ID before it can act as the receiver.
    kick=()=>tick();setTimeout(tick,300);every(1000,tick);
  }
  if(DISCORD){
    let initial=true,lastChannel='',timer=null,scanning=false,others=new Set();
    const headerOf=li=>{for(let n=li,i=0;n&&i<500;n=n.previousElementSibling,i++){const u=n.querySelector?.('[id^="message-username-"]');if(u)return {u,li:n};}return null;};
    // true = VolTrak, false = someone else (cached), null = header not rendered yet (retry next scan).
    const fromVolTrak=li=>{
      const h=headerOf(li);if(!h)return null;
      const name=(h.u.querySelector('[class*="username"]')||h.u).textContent.trim().replace(/(?:APP|BOT)$/,'').trim().toLowerCase();
      if(name!==AUTHOR)return false;
      return !AUTHOR_ID||h.li.querySelector('img[src*="/avatars/"]')?.src.match(/\/avatars\/(\d+)\//)?.[1]===AUTHOR_ID;
    };
    const originalTime=li=>{const t=li.querySelector('time[datetime]');if(t)return Date.parse(t.getAttribute('datetime'));const id=li.id.match(/-(\d+)$/)?.[1];try{return id?Number(BigInt(id)>>22n)+1420070400000:NaN;}catch(_){return NaN;}};
    const alertText=li=>{const title=li.querySelector('[class*="embedTitle"]')?.textContent?.trim();if(!title)return li.innerText||'';const labels=[...li.querySelectorAll('[class*="embedFieldName"]')];
      const desc=li.querySelector('[class*="embedDescription"]')?.textContent||'';
      return title+'\n'+labels.map(e=>e.textContent+'\n'+(e.parentElement.querySelector('[class*="embedFieldValue"]')?.textContent||'')).join('\n')+(desc?'\n'+desc:'');};
    async function scan(){
      if(scanning)return;scanning=true;
      try{
        const channel=location.pathname.split('/')[3];
        if(channel!==lastChannel){lastChannel=channel;initial=true;others=new Set();}
        if(channel!==CHANNEL){status='Waiting for the configured VolTrak channel';render();return;}
        const existing=new Set(get('calls',[]).map(c=>c.id));
        const lis=[...document.querySelectorAll('li[id^="chat-messages-"]')];
        // Never arm from an empty/loading message list: first complete screen is history.
        if(!lis.length)return;
        for(const li of lis){
          const id=li.id.match(/-(\d+)$/)?.[1];if(!id||existing.has(id)||others.has(id))continue;
          const who=fromVolTrak(li);if(who===false)others.add(id);if(!who)continue;
          const parsed=VTCore.parseAlert(alertText(li));if(!parsed)continue;
          const messageAt=originalTime(li), now=Date.now();if(!Number.isFinite(messageAt))continue;
          const historical=initial||now-messageAt>30000||messageAt>now+5000;
          const call={...parsed,id,messageAt,receivedAt:now,historical};
          if(!await addCall(call))continue;existing.add(id);
          if(!historical){
            await locked('publish',()=>{
              const sent=get('published',{});if(now-(sent[call.mint]||0)<60000)return;
              sent[call.mint]=now;set('published',Object.fromEntries(Object.entries(sent).filter(([,t])=>now-t<600000)));set('latest',call);
              GM_setClipboard(call.mint,'text');announce(call);
              GM_notification({title:'VolTrak · '+call.name,text:receiverAlive(receiver())?'Context sent to GMGN.':'No GMGN receiver. Open GMGN to review.',timeout:6000});
            });
          }
        }
        // The first non-empty screen is history; everything after it (and under 30s old) is live.
        initial=false;
        status='Watching VolTrak · '+calls().length+' calls saved';render();
      }finally{scanning=false;}
    }
    const mo=new MutationObserver(mutations=>{if(mutations.every(m=>root.contains(m.target)))return;clearTimeout(timer);timer=setTimeout(scan,120);});
    mo.observe(document.body,{childList:true,subtree:true});setTimeout(scan,2000);every(5000,scan);
  }
  render();
}
// The panel waits for the DOM; the GMGN listener above is already in place from document-start.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
