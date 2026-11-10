// ==UserScript==
// @name         VolTrak Steroids 4.3
// @namespace    voltrak-alert
// @version      4.3.0
// @description  VolTrak context + GMGN handoff + GMGN live trade feed (read-only), live rug checks (dev, top 10, launch block, funder), GMGN holder data, insider-exit alerts, a live coin score, Telegram pings, market-wide pump.fun activity and a call backtest. Analysis only; never submits trades.
// @match        https://discord.com/*
// @match        https://gmgn.ai/*
// @match        https://photon-sol.tinyastro.io/*
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
// @connect      mainnet.helius-rpc.com
// @connect      solana-mainnet.g.alchemy.com
// @connect      api.telegram.org
// @connect      gmgn.ai
// @connect      lite-api.jup.ag
// @connect      api.rugcheck.xyz
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
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';
  const millis = v => { const n = number(v); return n == null ? null : n < 1e12 ? n * 1000 : n; };
  // token_activity item → trade, or null for anything that is not a buy or sell.
  function gmgnTrade(x) {
    const side = {buy: 'buy', b: 'buy', sell: 'sell', s: 'sell'}[String(x?.e).toLowerCase()], at = millis(x?.t) ?? millis(x?.ts);
    if (!side || at == null) return null;
    // Wallet tags, if GMGN sends any (field name unconfirmed; the Settings data check lists the real fields).
    const tags = [x.maker_tags, x.makerTags, x.maker_tag, x.tags].find(v => v != null);
    // The quote side is SOL only when GMGN says so (qad = quote mint). Pump coins can be paired with USDC, USDT or other
    // coins; their quote amount is not SOL and must never set the SOL price.
    const quoteMint = x.qad || null, quote = number(x.qa);
    return {at, side, usd: number(x.au) || 0, sol: quoteMint === WSOL_MINT ? quote : null, quote, quoteMint, amount: number(x.ba), price: number(x.pu), wallet: x.m || null, hash: x.h || null, mint: addrOf(x), ex: x.ex || null,
      tags: Array.isArray(tags) ? tags.map(String) : typeof tags === 'string' && tags ? tags.split(',') : null};
  }
  // token_stat item → GMGN's own rolling windows (b/s = buy/sell count, bv/sv = buy/sell volume, v = volume, p = price then).
  function gmgnStat(x, at) {
    const w = k => ({buys: number(x['b' + k]), sells: number(x['s' + k]), buyUsd: number(x['bv' + k]), sellUsd: number(x['sv' + k]), volume: number(x['v' + k]), priceAgo: number(x['p' + k])});
    return {at, mint: addrOf(x), price: number(x.p) ?? number(x.pu) ?? number(x.price), m1: w('1m'), m5: w('5m'), h1: w('1h')};
  }
  // Live GMGN view for assess(): trades seen since the first live message (`since`) plus GMGN's token_stat rollup.
  // bots (optional): botFlow() over the last 5 min; its organic trades give a bot-free flow window.
  function liveView(trades, stat, at, now, since, bots) {
    if (!at) return null;
    // Price: the newer of GMGN's stats frame and the last trade (a trade's time is its block time, ~1-2s before receipt).
    const last = trades.reduce((a, b) => !a || b.at >= a.at ? b : a, null);
    const price = last?.price > 0 && (!(stat?.price > 0) || last.at >= (stat.at ?? 0) - 2000) ? last.price : stat?.price ?? last?.price ?? null;
    // pump.fun tokens have a fixed 1B supply, so market cap = price × 1e9.
    const marketCap = price > 0 && /pump/i.test(last?.ex || '') ? price * 1e9 : null;
    return {at, stat, flow: trades.length ? windows(trades, now, ms => since <= now - ms) : null, price, marketCap, last,
      organic: bots?.organic?.length ? windows(bots.organic, now, ms => since <= now - ms) : null, botShare: bots?.botShare ?? null};
  }
  function assess(call, s, now, error, flow, live) {
    // risks block the state (CAUTION); flags are call-time review notes shown next to the live state.
    const reasons = [], risks = [], flags = [], missing = [];
    if (call?.conflict) risks.push('Alert has conflicting migration/volume fields');
    // No cluster or top-holder flags: neither predicted outcomes on 73 calls held out from the first analysis.
    if (call?.holders > 0 && (call.fresh != null || call.bots != null)) reasons.push([call.fresh != null && Math.round(call.fresh/call.holders*100) + '% fresh-wallet', call.bots != null && Math.round(call.bots/call.holders*100) + '% bot/high-risk'].filter(Boolean).join(' and ') + ' labels of ' + call.holders + ' holders at call; categories can overlap');
    if (!call?.clusters?.length) missing.push('Call-time wallet clusters missing');
    const fresh = (x, ms) => !!x && now - x.at <= ms && x.at <= now + 1000;
    const L = fresh(live, 15000) ? live : null, st = L && fresh(L.stat, 15000) ? L.stat : null, lf = L?.flow || null, lo = L?.organic || null;
    const f = fresh(flow, 30000) ? flow : null, dex = !error && fresh(s, 30000) ? s : null;
    if (!st && !lf && !f) missing.push('1m trade flow unavailable');
    if (!lf && !f) missing.push('Unique trading wallets unavailable');
    if (!dex && !st && !lf) {
      return {state:'UNKNOWN', side:'NO CURRENT SNAPSHOT', share:null, basis:null, risks, flags, missing,
        reasons:[error || (s ? 'Snapshot fetch is stale' : 'No live or indexed data yet'), ...reasons]};
    }
    if (error) missing.push(error);
    // Gauge source, best first: bot-free live trades, GMGN's own 1m rollup, live trades, GeckoTerminal 1m, GMGN 5m,
    // DEX Screener 5m counts. Wash trades are ~50/50 buy/sell by construction, so every source after the first is
    // pulled toward 50% (and its trade count padded) when volume bots are active.
    const usdShare = (w, min) => w && (w.buys || 0) + (w.sells || 0) >= min && (w.buyUsd || 0) + (w.sellUsd || 0) > 0 ? 100 * (w.buyUsd || 0) / ((w.buyUsd || 0) + (w.sellUsd || 0)) : null;
    const dexWindow = dex && {buys: dex.buys5m, sells: dex.sells5m};
    const pick = [
      [lo ? usdShare(lo.m1, 10) : null, lo?.m1.complete ? 'organic 1m trades ($, bots excluded)' : 'organic trades since open ($, bots excluded)', 1, lo?.m1],
      [st ? usdShare(st.m1, 10) : null, 'GMGN 1m $ volume', 1, st?.m1],
      // Right after the alert the 1m window is not full yet, but those trades are the ones that matter most.
      [lf ? usdShare(lf.m1, 10) : null, lf?.m1.complete ? 'live 1m trades ($)' : 'live trades since open ($)', 1, lf?.m1],
      [f ? usdShare(f.m1, 10) : null, 'GeckoTerminal 1m $ volume', 1, f?.m1],
      [st ? usdShare(st.m5, 1) : null, 'GMGN 5m $ volume', 5, st?.m5],
      [dex && dex.buys5m >= 0 && dex.sells5m >= 0 && dex.buys5m + dex.sells5m > 0 ? 100 * dex.buys5m / (dex.buys5m + dex.sells5m) : null, 'DEX Screener 5m swap count', 5, dexWindow],
    ].find(o => o[0] != null);
    const share = pick ? pick[0] : null, basis = pick ? pick[1] : null;
    const side = share === null ? 'UNKNOWN' : share >= 60 ? 'BUY SIDE' : share <= 40 ? 'SELL SIDE' : 'MIXED';
    if (share != null) reasons.push(Math.round(share) + '% of ' + basis + ' is buys; not a win probability');
    if (pick?.[2] === 5 && (pick[3].buys || 0) + (pick[3].sells || 0) < 20) risks.push('Fewer than 20 swaps in the 5m window; weak sample');
    // token_stat p1m/p5m are read as the price then. A value nowhere near today's price (50× off, e.g. a % change in that
    // field) is ignored rather than turned into a fake momentum reading.
    const price = L?.price ?? dex?.price ?? null, change = ago => price > 0 && ago > 0 && price / ago < 50 && ago / price < 50 ? (price/ago - 1) * 100 : null, pct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    const m1Change = change(st?.m1.priceAgo), m5Change = change(st?.m5.priceAgo) ?? dex?.priceChange5m ?? null;
    const momentum = pick?.[2] === 1 && m1Change != null ? m1Change : m5Change;
    if (m1Change != null) reasons.push('1m price change ' + pct(m1Change));
    if (m5Change != null) reasons.push('5m price change ' + pct(m5Change));
    if (lo) reasons.push('Organic (bot-like trades excluded): ' + lo.m1.buys + ' buys / ' + lo.m1.sells + ' sells from ' + lo.m1.wallets + ' wallets in 1m');
    if (L?.botShare >= 40) flags.push('Bot-like trades are ' + Math.round(L.botShare) + '% of recent $ volume: volume and trade counts overstate demand');
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
    return {state,side,share,basis,window:pick?.[3]||null,reasons,risks,flags,missing,momentum,momentumWindow:momentum==null?null:momentum===m1Change?'1m':'5m'};
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
  // Outcome of buying `delay` minutes after an alert at `alertAt` (ms): target/stop in %. The horizon (minutes) counts
  // from the alert, so every entry delay is judged over the same window.
  // opt.earlyExit (minutes): if still holding at the first candle close that many minutes after entry and the price is
  // not above entry, sell at that close. opt.fill 'cautious': a stop fills at the worse of the stop and the candle's
  // close (or a gap open); a target needs a close above it, or a high 10% beyond it (one thin wick is not a fill).
  // opt.trail {arm, drop} (%): once the price has traded `arm`% above entry, also sell `drop`% below the highest high
  // so far. The level only uses highs of earlier candles, because inside one candle the order of high and low is unknown.
  // Coverage (4.2): opt.dataEnd = the time the candles are known to reach (the caller allows for indexing lag); short of
  // the horizon → 'incomplete'. Target, stop and early-exit events in the candles are taken first; only an open trade
  // with no trade after the entry candle is 'no-exit'. exit = 'target' | 'stop' | 'trail' | 'early' | 'mark' (priced on a
  // trade within 15 min of the horizon) | 'stale-mark' (the last trade was older: a price, not proof the exit could fill).
  const STALE_MARK_MIN = 15;
  function scoreCall(cs, alertAt, opt = {}) {
    const tp = opt.tp ?? 100, sl = opt.sl ?? -50, horizon = opt.horizon ?? 120, at = alertAt + (opt.delay ?? 0) * 60000;
    if (opt.dataEnd != null && opt.dataEnd < alertAt + horizon * 60000) return {status: 'incomplete'};
    const early = opt.earlyExit ?? null, cautious = opt.fill === 'cautious', trail = opt.trail ?? null;
    const minute = Math.floor(at / 60000) * 60000, end = alertAt + horizon * 60000, i0 = cs.findIndex(k => k.t >= minute);
    // No swap within 5 min of the entry time (e.g. a dead coin at +30 min): nothing to buy.
    if (i0 < 0 || cs[i0].t - at > 5 * 60000) return {status: 'no-trades'};
    // Entry: close of the entry time's own minute, else the next traded minute's open. That minute's high/low are
    // skipped because they may come from before the entry.
    const own = cs[i0].t === minute, entry = own ? cs[i0].c : cs[i0].o, path = cs.slice(own ? i0 + 1 : i0).filter(k => k.t < end);
    const pct = p => (p / entry - 1) * 100, stop = entry * (1 + sl / 100), target = entry * (1 + tp / 100);
    let peak = entry, peakAt = at, trough = entry, troughAt = at, outcome = 'open', ret = null, outcomeAt = null, checked = early == null, held = entry;
    for (const k of path) {
      if (k.h > peak) { peak = k.h; peakAt = k.t; }
      if (k.l < trough) { trough = k.l; troughAt = k.t; }
      if (outcome !== 'open') continue;
      const floor = trail && pct(held) >= trail.arm ? Math.max(stop, held * (1 - trail.drop / 100)) : stop;
      // Stop and target inside one candle count as the stop (the order is unknown); a gap through the stop fills at the open.
      if (k.l <= floor) { outcome = floor > stop ? 'exit' : 'loss'; ret = pct(cautious ? Math.min(floor, k.o, k.c) : Math.min(floor, k.o)); outcomeAt = k.t; }
      else if (cautious ? k.c >= target || k.h >= target * 1.1 : k.h >= target) { outcome = 'win'; ret = tp; outcomeAt = k.t; }
      else if (!checked && k.t + 60000 >= at + early * 60000) { checked = true; if (k.c <= entry) { outcome = 'exit'; ret = pct(k.c); outcomeAt = k.t; } }
      held = Math.max(held, k.h);
    }
    // Still open with no trade after the entry candle: nothing to exit on.
    if (outcome === 'open' && !path.some(k => k.t > cs[i0].t)) return {status: 'no-exit', entry};
    const priceAt = min => { let p = entry; for (const k of path) { if (k.t + 60000 <= at + min * 60000) p = k.c; else break; } return pct(p); };
    const rEnd = priceAt((end - at) / 60000), lastT = path.length ? path[path.length - 1].t + 60000 : at, markAge = Math.max(0, (end - lastT) / 60000);
    const exit = outcome === 'win' ? 'target' : outcome === 'loss' ? 'stop' : outcome === 'exit' ? (trail && ret > sl ? 'trail' : 'early') : markAge > STALE_MARK_MIN ? 'stale-mark' : 'mark';
    return {status: 'scored', entry, outcome, exit, ret: ret ?? rEnd, outcomeMin: outcomeAt == null ? null : (outcomeAt - at) / 60000, exitAgeMin: outcomeAt != null ? 0 : markAge,
      peakPct: pct(peak), peakMin: (peakAt - at) / 60000, troughPct: pct(trough), troughMin: (troughAt - at) / 60000,
      r1: priceAt(1), r2: priceAt(2), r3: priceAt(3), r5: priceAt(5), r10: priceAt(10), r15: priceAt(15), r30: priceAt(30), r60: priceAt(60), rEnd};
  }
  // The price path into an alert, from the same candles; all of it is known before any entry fills. close = last close
  // before the alert's minute (the price the call went out at). runUp15 = that close vs the first open in the 15 min
  // before (since launch, if younger); it needs candles reaching back 15 min (`covered`), which caches before 3.7 lack.
  function preAlert(cs, alertAt, covered) {
    const minute = Math.floor(alertAt / 60000) * 60000, before = cs.filter(k => k.t < minute), last = before[before.length - 1];
    if (!last) return {close: null, runUp15: null};
    const first = covered ? before.find(k => k.t >= minute - 15 * 60000) : null;
    return {close: last.c, runUp15: first ? (last.c / first.o - 1) * 100 : null};
  }
  // Win rate needed to break even when every trade ends at +tp or sl (sl negative), after a round-trip cost in %.
  const breakeven = (tp, sl, cost = 0) => 100 * (cost - sl) / (tp - sl);
  const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y), m = s.length >> 1; return !s.length ? null : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // 95% Wilson interval for a win rate, in %.
  function wilson(wins, n, z = 1.96) {
    if (!n) return [null, null];
    const p = wins / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [100 * Math.max(0, c - h), 100 * Math.min(1, c + h)];
  }
  function summarize(scores, cost = 0) {
    const n = scores.length, wins = scores.filter(s => s.outcome === 'win').length, losses = scores.filter(s => s.outcome === 'loss').length, [lo, hi] = wilson(wins, n);
    const ev = n ? scores.reduce((t, s) => t + s.ret, 0) / n - cost : null, sd = n > 1 ? Math.sqrt(scores.reduce((t, s) => t + (s.ret - cost - ev) ** 2, 0) / (n - 1)) : null;
    // evLo/evHi: rough 95% range of the average per trade (normal approximation; wide when n is small).
    return {n, wins, losses, open: n - wins - losses, winRate: n ? 100 * wins / n : null, lo, hi, ev, sd,
      evLo: sd == null ? null : ev - 1.96 * sd / Math.sqrt(n), evHi: sd == null ? null : ev + 1.96 * sd / Math.sqrt(n), medianPeak: median(scores.map(s => s.peakPct))};
  }
  // z with P(Z > z) = p for a standard normal (bisection on the Abramowitz–Stegun erf; error < 1e-6).
  function zFor(p) {
    const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x < 0 ? -y : y; };
    let lo = 0, hi = 10;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (0.5 * (1 - erf(m / Math.SQRT2)) > p) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  // Same for Student's t with df degrees of freedom (Cornish–Fisher expansion; within ~2% for df ≥ 10). A 15-call bucket
  // needs a clearly higher bar than z, or small buckets "stand out" too often.
  function tFor(p, df) {
    const z = zFor(p), z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
    return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
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
    ['Migrated at call', c => c.migrated == null ? null : +c.migrated, [1], 'bool'],
    ['Hour of call (UTC)', c => Number.isFinite(c.messageAt) ? new Date(c.messageAt).getUTCHours() : null, [6, 12, 18], ':00'],
    // Price path into the trade (set on each call by the report from its candles; known before the fill, no lookahead).
    // Move into entry = fill price vs the price the call went out at: how far the call's own crowd had already pushed it.
    ['Move into entry', c => c.entryMove, [0, 10, 25], '%'],
    ['Run-up in the 15 min before the alert', c => c.runUp15, [0, 50, 200], '%'],
    // Rug checks (3.8): rebuilt from the coin's own transactions up to the alert, so nothing after the call leaks in.
    // c.rug is set by the report from the saved check; calls without one land in "unknown".
    ['Top 10 holders at call (excl. curve/pool)', c => c.rug?.top10 ?? null, [15, 25, 35], '%'],
    ['Dev holding at call', c => c.rug?.devPct ?? null, [1, 5], '%'],
    ['Dev sold or moved tokens before the call', c => c.rug?.devSold == null ? null : +c.rug.devSold, [1], 'bool'],
    ['Launch-block buyers besides the dev', c => c.rug?.launchBuyers ?? null, [1, 4], ''],
    ['Supply bought in the launch block', c => c.rug?.launchPct ?? null, [5, 15, 30], '%'],
    ['Dev or its funder on an earlier call', c => c.rug?.seen == null ? null : +c.rug.seen, [1], 'bool'],
    ['Rug grade at the call', c => c.rug?.grade ?? null, [1, 2], 'grade'],
    // Live score (3.9): GMGN's numbers + chain checks + volume bots, saved when the call first opened on GMGN
    // (c.gm, forward only: GMGN gives today's numbers, not past ones).
    // Grade and parts: 4.3 rules only (v2 snapshots); older snapshots used different weights and would blur the test.
    ['Live grade at the call (4.3 rules)', c => c.gm?.v >= 2 ? c.gm.code ?? null : null, [1, 2], 'grade'],
    ['Risk score at the call', c => c.gm?.v >= 2 ? c.gm.risk ?? null : null, [-3, -1, 0], ''],
    ['Demand score at the call', c => c.gm?.v >= 2 ? c.gm.demand ?? null : null, [-1, 0, 1], ''],
    ['Entry score at the call', c => c.gm?.v >= 2 ? c.gm.entry ?? null : null, [-2, -1, 0], ''],
    ['Data confidence at the call', c => c.gm?.v >= 2 ? {high: 0, medium: 1, low: 2}[c.gm.conf] ?? null : null, [1, 2], 'conf'],
    ['Round trip at your size (Jupiter)', c => c.gm?.exitCost ?? null, [5, 10, 25], '%'],
    ['First 70 buyers still holding', c => c.gm?.retention ?? null, [25, 50, 75], '%'],
    ['Holders at 2×+ profit (by supply)', c => c.gm?.profitShare ?? null, [25, 50], '%'],
    ['Move since the call when graded', c => c.gm?.move ?? null, [25, 100], '%'],
    ['Insider bag at the call', c => c.gm?.insiderHold ?? null, [15, 25, 40], '%'],
    ['Bundlers hold at the call', c => c.gm?.bundlerPct ?? null, [10, 20], '%'],
    ['Real traders (app buyers) at the call', c => c.gm?.platformRate ?? null, [20, 50], '%'],
    ['Fresh wallets at the call', c => c.gm?.freshRate ?? null, [20, 40], '%'],
    ['Dev launches', c => c.gm?.launches ?? null, [10, 50], ''],
    ['Volume / MC (1h) at the call', c => c.gm?.volMc ?? null, [3, 10], '×'],
    ['Smart money at the call', c => c.gm?.smart ?? null, [1, 3], ''],
  ];
  const edgeLabel = (v, unit) => unit === '$' ? '$' + (v >= 1000 ? v / 1000 + 'K' : v) : v + unit;
  function bucketOf(v, cuts, unit) {
    if (unit === 'bool') return v >= cuts[0] ? 'yes' : 'no';
    if (unit === 'grade') return v < 1 ? 'clean' : v < 2 ? 'risky' : 'avoid';
    if (unit === 'conf') return v < 1 ? 'high' : v < 2 ? 'medium' : 'low';
    const i = cuts.findIndex(x => v < x);
    if (i === 0) return unit === '' && cuts[0] === 1 ? '0' : '<' + edgeLabel(cuts[0], unit);
    if (i < 0) return '≥' + edgeLabel(cuts[cuts.length - 1], unit);
    return edgeLabel(cuts[i - 1], unit) + '–' + edgeLabel(cuts[i], unit);
  }
  // items [{call, score}] (scored only) → baseline, per-field buckets and timing. Each bucket is compared with the rest
  // of the calls on the average per trade (Welch t). With dozens of buckets some differ by chance (the old rule, CI vs
  // baseline win rate, flagged at least one bucket in about a third of reports on data with no effect at all), so a
  // bucket only "stands out" when it and the rest each have 15+ calls and |t| clears the Bonferroni bar for every
  // bucket tested: about a 5% chance per report of any false find.
  function backtestReport(items, cost = 0) {
    const scores = items.map(i => i.score), all = summarize(scores, cost);
    const sums = list => list.reduce((a, s) => [a[0] + s.ret, a[1] + s.ret * s.ret], [0, 0]), T = sums(scores);
    const features = FEATURES.map(([name, get, cuts, unit]) => {
      const order = [bucketOf(-Infinity, cuts, unit), ...cuts.map(x => bucketOf(x, cuts, unit)), 'unknown'], groups = new Map(order.map(l => [l, []]));
      for (const i of items) { const v = get(i.call); groups.get(v == null || !Number.isFinite(v) ? 'unknown' : bucketOf(v, cuts, unit)).push(i.score); }
      return {name, rows: order.map(label => ({label, list: groups.get(label), ...summarize(groups.get(label), cost)})).filter(r => r.n)};
    });
    const testable = r => r.label !== 'unknown' && r.n >= 15 && all.n - r.n >= 15;
    const tested = features.reduce((n, f) => n + f.rows.filter(testable).length, 0), p = 0.025 / Math.max(1, tested);
    for (const f of features) f.rows = f.rows.map(({list, ...r}) => {
      let diff = null, t = null, bar = null;
      if (testable(r)) {
        const [s, q] = sums(list), n2 = all.n - r.n, m1 = s / r.n, m2 = (T[0] - s) / n2;
        const a = Math.max(0, q - r.n * m1 * m1) / (r.n - 1) / r.n, b = Math.max(0, T[1] - q - n2 * m2 * m2) / (n2 - 1) / n2, se = Math.sqrt(a + b);
        const df = a + b > 0 ? (a + b) ** 2 / (a * a / (r.n - 1) + b * b / (n2 - 1)) : r.n + n2 - 2;
        diff = m1 - m2; t = se > 0 ? diff / se : diff ? Math.sign(diff) * Infinity : 0; bar = tFor(p, Math.max(2, df));
      }
      return {...r, few: r.n < 15, diff, t, bar, standsOut: t != null && Math.abs(t) > bar ? t > 0 ? 'above' : 'below' : null};
    });
    const within = m => scores.length ? 100 * scores.filter(s => s.peakMin <= m).length / scores.length : null;
    return {all, features, tested, timing: {r5: median(scores.map(s => s.r5)), r15: median(scores.map(s => s.r15)), r60: median(scores.map(s => s.r60)),
      peakMin: median(scores.map(s => s.peakMin)), peakWithin5: within(5), peakWithin15: within(15), peakWithin60: within(60)}};
  }
  // ---- Volume bots (4.0): wash-trading patterns in per-trade rows {at, side, usd, amount, wallet, hash, ex} ----
  // GMGN labels every trade's wallet on a second feed channel (token_activity_info_all) and in its trades API: wallet tags
  // (wash_trader, sandwich_bot, app names like axiom/gmgn/photon), token tags (bundler, sniper…), the wallet's trade
  // count on this coin and what it has bought and sold of it in total. prof = Map wallet → gmgnMaker(); without it
  // (Helius history) only the pattern rules run. A trade counts as bot volume when any rule fits:
  //  washTag  GMGN tags the wallet a wash trader / volume bot;   mev  GMGN tags it a sandwich / MEV bot;
  //  heavy    100+ trades on this coin with a flat position (sold ≥70% of what it bought, or the reverse), or 300+ trades;
  //  lifeChurn 25+ trades on this coin, position within 15% of flat, no trading-app tag;
  //  T  one transaction buys and sells the coin on the same pool (on different pools it is arbitrage, not counted);
  //  mirror  one wallet buys and another sells the same token amount (±0.5%) within 3s, neither using a trading app;
  //  F  a wallet buys and sells ≥80% of those tokens back within 10s at nearly the same USD value (flat round trip);
  //  C  churn: 6+ trades in the window with 2+ buys and 2+ sells, ending within 15% of where it started;
  //  bump  sub-$3 trades from a wallet that makes many of them (3+ in the window), or a sub-$1 trade from a wallet with
  //        10+ trades on this coin per GMGN:
  //        trend/"maker" bots that spam tiny trades to inflate trade and holder counts. They are most of the trades on a
  //        bumped coin but almost none of its dollars, so the reading reports both: bot share of trades and of volume.
  // Profitable flips and repeated preset-size buys are never flagged. Untested as a signal.
  const VB = Object.freeze({fastSec: 10, suspectSec: 30, flatTol: 0.04, tokFrac: 0.8, churnN: 6, churnNet: 0.15, microUsd: 3, microN: 3, buyerUsd: 15,
    heavyTt: 100, heavyAny: 300, heavyFlat: 0.7, lifeTt: 25, lifeFlat: 0.85, mirrorSec: 3, mirrorTol: 0.005, dustUsd: 3, bumpN: 3, bumpTt: 10, bumpTtUsd: 1});
  const APP_TAG = /^(gmgn|gmgn_go|axiom|photon|padre|trojan|bullx|maestro|bonkbot|banana|bloom|nova|pepeboost|ave|okx|binance|fomo_app|tg_bot|moonshot)/i;
  const WASH_TAG = /wash|volume_bot|bump_bot|maker_bot/i, MEV_TAG = /sandwich|mev|arbitrage|arb_bot|jito_bot/i;
  const BOT_RULES = ['washTag', 'mev', 'heavy', 'lifeChurn', 'bump', 'txWash', 'mirror', 'fastTrip', 'churn'];
  // Confident = the trade itself shows it (GMGN's label, same-tx wash, flat 10s round trip, repeated dust). Possible =
  // a pattern a real trader can also make (many trades, mirrored sizes, churn): reported, never counted as bot volume.
  const BOT_SURE = new Set(['washTag', 'mev', 'bump', 'txWash', 'fastTrip']);
  // GMGN maker info (feed row or trades-API row) → profile. null without a wallet.
  function gmgnMaker(x) {
    const w = x?.m ?? x?.maker;
    if (!w) return null;
    const list = v => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : [];
    return {wallet: w, at: millis(x.t ?? x.timestamp) ?? 0, tags: list(x.ts ?? x.maker_tags), tokenTags: list(x.tts ?? x.maker_token_tags), eventTags: list(x.maker_event_tags),
      tt: number(x.tt ?? x.total_trade), bought: number(x.hba ?? x.history_bought_amount), sold: number(x.hsa ?? x.history_sold_amount), bal: number(x.b ?? x.balance)};
  }
  // GMGN trades-API row (vas/api/mul-region/token_trades_v2) → trade, same shape as gmgnTrade().
  function gmgnApiTrade(x) {
    const side = {buy: 'buy', sell: 'sell'}[String(x?.event).toLowerCase()], at = millis(x?.timestamp);
    if (!side || at == null) return null;
    const quoteMint = x.quote_address || null, quote = number(x.quote_amount);
    return {at, side, usd: number(x.amount_usd) || 0, sol: quoteMint === WSOL_MINT ? quote : null, quote, quoteMint, amount: number(x.base_amount), price: number(x.price_usd), wallet: x.maker || null,
      hash: x.tx_hash || null, mint: x.token_address || null, ex: null, tags: null, src: 'api'};
  }
  const isApp = p => !!p?.tags?.some(t => APP_TAG.test(t));
  // Lifetime position on this coin: min(bought, sold) / max(bought, sold); 1 = sold everything it bought.
  const flatness = p => p?.bought > 0 && p?.sold > 0 ? Math.min(p.bought, p.sold) / Math.max(p.bought, p.sold) : 0;
  function botFlow(trades, from, to, o = VB, prof = null) {
    const seen = new Set(), rows = [];
    for (const t of Array.isArray(trades) ? trades : []) {
      if (!t || !(t.at >= from && t.at <= to) || (t.side !== 'buy' && t.side !== 'sell')) continue;
      const key = t.hash ? t.hash + '|' + t.side + '|' + t.wallet + '|' + t.amount : t.wallet + '|' + t.at + '|' + t.side + '|' + t.amount + '|' + t.usd;
      if (!seen.has(key)) { seen.add(key); rows.push(t); }
    }
    rows.sort((a, b) => a.at - b.at);
    const P = w => prof?.get?.(w) || null;
    const rule = new Map(), mark = (t, r) => { if (!rule.has(t)) rule.set(t, r); }, group = (list, f) => { const m = new Map(); for (const t of list) { const k = f(t); if (k) (m.get(k) || m.set(k, []).get(k)).push(t); } return m; };
    // 1) Confident rules. GMGN's own wash/MEV labels:
    let profiled = 0;
    for (const t of rows) {
      const p = P(t.wallet);
      if (!p) continue;
      profiled++;
      if (p.tags.some(x => MEV_TAG.test(x))) mark(t, 'mev');
      else if (p.tags.some(x => WASH_TAG.test(x)) || p.eventTags.some(x => WASH_TAG.test(x))) mark(t, 'washTag');
    }
    // Bump bots: repeated sub-$3 trades from one wallet.
    const dust = t => (t.usd || 0) < o.dustUsd, dustBy = new Map();
    for (const t of rows) if (dust(t)) dustBy.set(t.wallet, (dustBy.get(t.wallet) || 0) + 1);
    // A single sub-$1 trade from a wallet with 10+ trades on the coin also counts; a single $1-3 trade does not (a person
    // closing a small leftover bag looks like that: live check, Oct 27, 2.4% of bump hits).
    for (const t of rows) if (dust(t) && (dustBy.get(t.wallet) >= o.bumpN || P(t.wallet)?.tt >= o.bumpTt && (t.usd || 0) < o.bumpTtUsd)) mark(t, 'bump');
    // Same transaction buys and sells on the same pool (different pools = arbitrage, not counted).
    let arb = 0, suspectUsd = 0; const arbLegs = new Set();
    for (const legs of group(rows, t => t.hash).values()) {
      const buys = legs.filter(t => t.side === 'buy'), sells = legs.filter(t => t.side === 'sell');
      if (!buys.length || !sells.length) continue;
      // Pool unknown (trades API rows): neither wash nor arbitrage can be told apart, so leave the legs alone.
      if (legs.some(t => t.ex == null)) continue;
      const buyEx = new Set(buys.map(t => t.ex)), sellEx = new Set(sells.map(t => t.ex));
      if ([...buyEx].some(e => sellEx.has(e))) legs.forEach(t => mark(t, 'txWash')); else { arb++; legs.forEach(t => arbLegs.add(t)); }
    }
    // Flat buy-then-sell within 10s (a profitable or losing flip is not flat, so it is never flagged).
    const tokens = t => t.amount > 0 ? t.amount : null, byWallet = group(rows.filter(t => !arbLegs.has(t)), t => t.wallet);
    for (const list of byWallet.values()) {
      const used = new Set();
      for (const b of list) {
        if (b.side !== 'buy' || rule.has(b) || !(b.usd > 0)) continue;
        let tok = 0, usd = 0, end = null; const legs = [];
        for (const s of list) {
          if (s.side !== 'sell' || used.has(s) || rule.has(s) || s.at < b.at - 999) continue; // 1s timestamps: a sell stamped in the buy's second may pair
          if (s.at - b.at > o.suspectSec * 1000) break;
          legs.push(s); tok += tokens(s) ?? 0; usd += s.usd || 0; end = s.at;
          if (tokens(b) ? tok >= o.tokFrac * tokens(b) : usd >= (1 - o.flatTol) * b.usd) break;
        }
        // Flat = sold back at about the buy's price per token (or, without token amounts, about the same USD).
        const back = tokens(b) ? tok >= o.tokFrac * tokens(b) && tok <= (2 - o.tokFrac) * tokens(b) : legs.length > 0;
        const flat = tokens(b) && tok > 0 ? Math.abs((usd / tok) / (b.usd / tokens(b)) - 1) <= o.flatTol : Math.abs(usd - b.usd) <= o.flatTol * b.usd;
        if (!back || !flat) continue;
        legs.forEach(s => used.add(s));
        if (end - b.at <= o.fastSec * 1000) { mark(b, 'fastTrip'); legs.forEach(s => mark(s, 'fastTrip')); } else suspectUsd += b.usd + usd;
      }
    }
    // 2) Possible (heuristics): many trades on this coin with a flat lifetime position, mirrored sizes across two wallets,
    // churn in the window that is flat in tokens AND in dollars (a $100-in/$200-out trader is not churn).
    for (const t of rows) {
      const p = P(t.wallet);
      if (!p || rule.has(t)) continue;
      if (p.tt >= o.heavyAny || p.tt >= o.heavyTt && flatness(p) >= o.heavyFlat) mark(t, 'heavy');
      else if (p.tt >= o.lifeTt && flatness(p) >= o.lifeFlat && !isApp(p)) mark(t, 'lifeChurn');
    }
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      if (rule.has(a) || arbLegs.has(a) || !(a.amount > 0) || isApp(P(a.wallet))) continue;
      for (let j = i + 1; j < rows.length && rows[j].at - a.at <= o.mirrorSec * 1000; j++) {
        const b = rows[j];
        if (b.side === a.side || b.wallet === a.wallet || rule.has(b) || arbLegs.has(b) || !(b.amount > 0) || isApp(P(b.wallet))) continue;
        if (Math.abs(b.amount / a.amount - 1) <= o.mirrorTol) { mark(a, 'mirror'); mark(b, 'mirror'); break; }
      }
    }
    for (const list of byWallet.values()) {
      const buys = list.filter(t => t.side === 'buy'), sells = list.filter(t => t.side === 'sell');
      const bought = buys.reduce((x, t) => x + (tokens(t) ?? 0), 0), sold = sells.reduce((x, t) => x + (tokens(t) ?? 0), 0);
      const inUsd = buys.reduce((x, t) => x + (t.usd || 0), 0), outUsd = sells.reduce((x, t) => x + (t.usd || 0), 0);
      if (list.length >= o.churnN && buys.length >= 2 && sells.length >= 2 && bought > 0 && Math.abs(bought - sold) <= o.churnNet * bought
        && inUsd > 0 && Math.abs(outUsd - inUsd) <= o.churnNet * inUsd) list.forEach(t => mark(t, 'churn'));
    }
    const sure = t => BOT_SURE.has(rule.get(t)), maybe = t => rule.has(t) && !sure(t);
    const usd = rows.reduce((x, t) => x + (t.usd || 0), 0), flagged = rows.filter(sure), botUsd = flagged.reduce((x, t) => x + (t.usd || 0), 0);
    const possible = rows.filter(maybe), possibleUsd = possible.reduce((x, t) => x + (t.usd || 0), 0);
    const byRule = Object.fromEntries(BOT_RULES.map(r => [r, 0])), usdByRule = Object.fromEntries(BOT_RULES.map(r => [r, 0]));
    for (const [t, r] of rule) { byRule[r]++; usdByRule[r] += t.usd || 0; }
    const botWallets = new Set(flagged.map(t => t.wallet).filter(Boolean));
    let buyers = 0, buyersNet = 0;
    for (const [w, list] of byWallet) {
      if (botWallets.has(w)) continue;
      const b = list.filter(t => t.side === 'buy'), s = list.filter(t => t.side === 'sell'), bUsd = b.reduce((x, t) => x + (t.usd || 0), 0), sUsd = s.reduce((x, t) => x + (t.usd || 0), 0);
      const net = b.some(t => tokens(t)) ? b.reduce((x, t) => x + (tokens(t) ?? 0), 0) - s.reduce((x, t) => x + (tokens(t) ?? 0), 0) : bUsd - sUsd;
      if (bUsd >= o.buyerUsd && net > 0) { buyers++; buyersNet += bUsd - sUsd; }
    }
    // Organic flow: every trade not confidently flagged and not an arbitrage leg ("possible" trades stay in).
    const organic = rows.filter(t => !sure(t) && !arbLegs.has(t)), orgUsd = organic.reduce((x, t) => x + (t.usd || 0), 0);
    const orgBuyUsd = organic.reduce((x, t) => x + (t.side === 'buy' ? t.usd || 0 : 0), 0);
    // Trading-app volume: unflagged trades from wallets GMGN tags with a trading app (people clicking buttons).
    const appUsd = prof ? organic.reduce((x, t) => x + (isApp(P(t.wallet)) && !rule.has(t) ? t.usd || 0 : 0), 0) : null;
    const dustN = rows.filter(dust).length;
    return {n: rows.length, usd, botUsd, botShare: usd > 0 ? 100 * botUsd / usd : null, botTradeShare: rows.length ? 100 * flagged.length / rows.length : null,
      possibleShare: usd > 0 ? 100 * possibleUsd / usd : null, possibleTradeShare: rows.length ? 100 * possible.length / rows.length : null,
      wallets: byWallet.size, botWallets: botWallets.size, byRule, usdByRule, arb, suspectShare: usd > 0 ? 100 * suspectUsd / usd : null,
      buyers, buyersNet, organic, orgN: organic.length, orgShare: orgUsd > 0 ? 100 * orgBuyUsd / orgUsd : null, first: rows[0]?.at ?? null, last: rows[rows.length - 1]?.at ?? null,
      appShare: appUsd != null && usd > 0 ? 100 * appUsd / usd : null, dustShare: rows.length ? 100 * dustN / rows.length : null, profiled: rows.length ? 100 * profiled / rows.length : null,
      flagged: [...rule].slice(-50).map(([t, r]) => ({wallet: t.wallet, hash: t.hash, rule: r, sure: BOT_SURE.has(r)}))};
  }
  // ---- Solana transactions (getTransactionsForAddress, jsonParsed) → per-trade rows for one mint ----
  // One row per signer whose balance of the mint changed in a pump.fun or PumpSwap transaction. SOL size includes fees
  // and tips, which is fine for wash-pattern detection. Transfers and other programs are skipped.
  const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', WSOL = 'So11111111111111111111111111111111111111112';
  function txTrades(tx, mint, solUsd) {
    const meta = tx?.meta, msg = tx?.transaction?.message;
    if (!meta || !msg || meta.err) return [];
    const keys = (msg.accountKeys || []).map(k => typeof k === 'string' ? {pubkey: k} : k || {}), nSig = msg.header?.numRequiredSignatures;
    const every = keys.map(k => k.pubkey).concat(meta.loadedAddresses?.writable || [], meta.loadedAddresses?.readonly || []);
    const ex = every.includes(PUMP_PROGRAM) ? 'pump' : every.includes(PUMPSWAP_PROGRAM) ? 'pump_amm' : null;
    if (!ex) return [];
    const signers = new Set(keys.filter((k, i) => k.signer ?? (nSig != null ? i < nSig : i === 0)).map(k => k.pubkey));
    const bal = (list, m) => { const o = new Map(); for (const b of list || []) if (b?.mint === m && b.owner) o.set(b.owner, (o.get(b.owner) || 0) + Number(b.uiTokenAmount?.amount || 0) / 10 ** (b.uiTokenAmount?.decimals ?? 6)); return o; };
    const pre = bal(meta.preTokenBalances, mint), post = bal(meta.postTokenBalances, mint), wPre = bal(meta.preTokenBalances, WSOL), wPost = bal(meta.postTokenBalances, WSOL);
    const at = (number(tx.blockTime) ?? 0) * 1000, hash = tx.transaction?.signatures?.[0] || null, price = solUsd > 0 ? solUsd : 150, rows = [];
    // A wallet that buys and sells inside one transaction nets to zero in the balances; the parsed token transfers show
    // both legs. Those legs get usd/sol null (the caller prices them from the window's other trades).
    const acct = new Map(), dec = new Map();
    for (const b of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) { const k = keys[b?.accountIndex]?.pubkey; if (k && b.mint) { acct.set(k, {mint: b.mint, owner: b.owner}); dec.set(b.mint, b.uiTokenAmount?.decimals ?? 6); } }
    const moved = new Map(), ins = [...(msg.instructions || []), ...(meta.innerInstructions || []).flatMap(x => x?.instructions || [])];
    for (const ix of ins) {
      const t = ix?.parsed?.type, info = ix?.parsed?.info;
      if (!info || (t !== 'transfer' && t !== 'transferChecked')) continue;
      const src = acct.get(info.source), dst = acct.get(info.destination);
      if ((info.mint || src?.mint || dst?.mint) !== mint) continue;
      const amt = Number(info.tokenAmount?.amount ?? info.amount ?? 0) / 10 ** (dec.get(mint) ?? 6);
      for (const [who, side] of [[src?.owner, 'out'], [dst?.owner, 'in']]) if (who && signers.has(who)) { const m = moved.get(who) || {in: 0, out: 0}; m[side] += amt; moved.set(who, m); }
    }
    for (const [owner, m] of moved) if (m.in > 0 && m.out > 0 && Math.abs(m.in - m.out) <= 0.05 * Math.max(m.in, m.out))
      rows.push({at, side: 'buy', amount: m.in, sol: null, usd: null, wallet: owner, hash, ex}, {at, side: 'sell', amount: m.out, sol: null, usd: null, wallet: owner, hash, ex});
    const washed = new Set(rows.map(r => r.wallet));
    for (const owner of new Set([...pre.keys(), ...post.keys()])) {
      if (!signers.has(owner) || washed.has(owner)) continue;
      const d = (post.get(owner) || 0) - (pre.get(owner) || 0);
      if (!d) continue;
      const i = keys.findIndex(k => k.pubkey === owner);
      let sol = i >= 0 && meta.preBalances && meta.postBalances ? (meta.postBalances[i] - meta.preBalances[i] + (i === 0 ? meta.fee || 0 : 0)) / 1e9 : 0;
      sol += (wPost.get(owner) || 0) - (wPre.get(owner) || 0);
      rows.push({at, side: d > 0 ? 'buy' : 'sell', amount: Math.abs(d), sol: Math.abs(sol), usd: Math.abs(sol) * price, wallet: owner, hash, ex});
    }
    return rows;
  }
  // Late check, 10 or 30 min after an alert: where the price is vs the alert price, and whether it still trades.
  // Descriptive only. The first version graded this BUY/FADE; on 95 past calls no group made money buying at the
  // check, so the labels now just say what happened. change: % vs the alert price (null if unknown).
  const LATE = {down: -30};
  const LATE_LEGACY = {BUY: 'ABOVE', WAIT: 'BELOW', FADE: 'DOWN30', DEAD: 'NOTRADES'};
  function lateGrade(change, traded) {
    if (!traded) return 'NOTRADES';
    if (change == null) return 'NOPRICE';
    return change <= LATE.down ? 'DOWN30' : change >= 0 ? 'ABOVE' : 'BELOW';
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
  // ---- Rug checks: who holds the coin, rebuilt from its own transactions (launch → now) ----
  // Rules from the Rugikk article. Untested on VolTrak calls: the backtest decides whether they matter.
  // soldFrac: a dev balance drop below this share of supply (dust, rounding) is not a sale. outFrac: the dev holding
  // less than this share of supply counts as out.
  const RUG = Object.freeze({top10: 25, dev: 5, launch: 3, soldFrac: 0.0001, outFrac: 0.0005});
  const SYSTEM_PROGRAM = '11111111111111111111111111111111';
  // Holders that are never people even though no program owns the address: AMM authorities whose PDA has no account
  // (Raydium AMM v4, Raydium CPMM, Meteora DAMM v2) and the burn address.
  const NOT_HOLDERS = new Set(['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', '1nc1nerator11111111111111111111111111111111']);
  // Base58 (Solana addresses, instruction data).
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58decode(str) {
    const n = [0];
    for (const c of String(str)) { let v = B58.indexOf(c); if (v < 0) return null; for (let i = 0; i < n.length; i++) { v += n[i] * 58; n[i] = v & 255; v >>= 8; } while (v) { n.push(v & 255); v >>= 8; } }
    for (const c of String(str)) { if (c === '1') n.push(0); else break; }
    return Uint8Array.from(n.reverse());
  }
  function b58encode(bytes) {
    const d = [0];
    for (const x of bytes) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
    let out = ''; for (const x of bytes) { if (x === 0) out += '1'; else break; }
    return out + d.reverse().map(i => B58[i]).join('');
  }
  // pump.fun's own creation instruction (create / create_v2, Anchor): 8-byte discriminator, name, symbol, uri (u32 length +
  // bytes each), then the declared creator (32 bytes). Older creates had no creator argument: the creator is then the
  // instruction's user account (index 7 for create, 5 for create_v2). Checked live on 5 launches (Oct 27 2026).
  const PUMP_CREATE = {'181ec828051c0777': 7, 'd6904cec5f8b31b4': 5};
  function pumpCreator(ix, mint) {
    if (ix?.programId !== PUMP_PROGRAM || typeof ix.data !== 'string' || !Array.isArray(ix.accounts) || ix.accounts[0] !== mint) return null;
    const d = b58decode(ix.data);
    if (!d || d.length < 8) return null;
    const userAt = PUMP_CREATE[[...d.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('')];
    if (userAt == null) return null;
    let o = 8;
    for (let k = 0; k < 3; k++) { if (o + 4 > d.length) return null; const len = d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24; o += 4 + len; if (len < 0 || o > d.length) return null; }
    return o + 32 <= d.length ? b58encode(d.slice(o, o + 32)) : ix.accounts[userAt] || null;
  }
  // One transaction → signature, time, slot, fee payer, signers and this mint's token-account balances before/after
  // (owner and UI amount per token account). null for failed or unparsable transactions.
  function txMint(tx, mint) {
    const meta = tx?.meta, msg = tx?.transaction?.message;
    if (!meta || !msg || meta.err) return null;
    const keys = (msg.accountKeys || []).map(k => typeof k === 'string' ? {pubkey: k} : k || {}), nSig = msg.header?.numRequiredSignatures;
    // jsonParsed lists lookup-table accounts inside accountKeys; other encodings append them as loadedAddresses.
    const extra = [...(meta.loadedAddresses?.writable || []), ...(meta.loadedAddresses?.readonly || [])];
    const key = i => keys[i]?.pubkey ?? extra[i - keys.length] ?? null;
    const read = list => {
      const m = new Map();
      for (const b of list || []) {
        if (b?.mint !== mint) continue;
        const a = key(b.accountIndex);
        if (a) m.set(a, {owner: b.owner || null, amt: Number(b.uiTokenAmount?.amount || 0) / 10 ** (b.uiTokenAmount?.decimals ?? 6)});
      }
      return m;
    };
    // Creation proof: the token program's initializeMint for this mint in this transaction (top level or inner).
    const ins = [...(msg.instructions || []), ...(meta.innerInstructions || []).flatMap(x => x?.instructions || [])];
    const init = ins.some(ix => /^initializeMint2?$/.test(ix?.parsed?.type || '') && ix.parsed.info?.mint === mint);
    let declared = null; for (const ix of ins) if ((declared = pumpCreator(ix, mint))) break;
    return {sig: tx.transaction?.signatures?.[0] || null, sec: number(tx.blockTime), slot: number(tx.slot), payer: keys[0]?.pubkey || null, init, declared,
      signers: new Set(keys.filter((k, i) => k.signer ?? (nSig != null ? i < nSig : i === 0)).map(k => k.pubkey)),
      pre: read(meta.preTokenBalances), post: read(meta.postTokenBalances)};
  }
  // Holder state. Token-account balances come from the chain (each transaction's own post balances, so a missed
  // transfer heals on that account's next transaction). Live trades from GMGN's feed sit in `adj` until the chain
  // catch-up brings in the same signature.
  function rugState(mint) {
    return {mint, creator: null, creatorSrc: null, payer: null, createSec: null, slot: null, supply: null, verified: false, ver: 0, txs: 0, lastSec: null, crossed: false, cutSec: null, atCall: null, devFlows: [],
      acct: new Map(), acctOwner: new Map(), hold: new Map(), adj: new Map(), adjSig: new Map(), adjBy: new Map(), sigs: new Set(),
      launch: new Map(), devBuy: null, devPeak: 0, devSales: []};
  }
  const rugHolding = (S, o) => (S.hold.get(o) || 0) + (S.adjBy.get(o) || 0);
  function dropAdj(S, key) {
    const x = S.adj.get(key);
    if (!x) return;
    S.adj.delete(key);
    const v = (S.adjBy.get(x.wallet) || 0) - x.d;
    if (Math.abs(v) < 1e-6) S.adjBy.delete(x.wallet); else S.adjBy.set(x.wallet, v);
  }
  // Dev balance change d (tokens, negative = out): a sale or transfer out above the dust level is logged once per signature.
  // Every change to the dev's balance, in and out (d in tokens, signed), once per signature: a feed trade later confirmed
  // on chain takes the chain's amount and slot. devNowVerified adds the ones after a verification.
  function devFlow(S, d, at, sig, slot) {
    if (!S.creator || !d) return;
    const f = sig ? S.devFlows.find(x => x.sig === sig) : null;
    if (f) { if (slot != null) { f.slot = slot; f.d = d; } return; }
    S.devFlows.push({at, slot: slot ?? null, d, sig: sig || null});
  }
  // to: owners whose balance rose in the same transaction (chain); a GMGN feed sell is a sale (kind 'sale').
  function devTrack(S, d, at, sig, src, to = null, slot = null) {
    if (!S.creator) return null;
    const dev = rugHolding(S, S.creator);
    S.devPeak = Math.max(S.devPeak, dev);
    if (!(d < 0) || !S.supply || -d < RUG.soldFrac * S.supply) return null;
    if (sig && S.devSales.some(x => x.sig === sig)) return null;
    const ev = {at, slot, amt: -d, sig: sig || null, src, left: Math.max(0, dev), to: to || [], kind: src === 'live' ? 'sale' : 'out'};
    S.devSales.push(ev);
    return ev;
  }
  // Apply one parsed transaction (txMint), oldest first. The first one that moves this token is taken as the creation:
  // its fee payer is the dev and its slot is the launch block. S.verified: that transaction initialised the mint (the
  // proof); without it the creator, dev buy and launch block are estimates. Returns the change per owner, or null if
  // already applied.
  function rugTx(S, t) {
    if (!t || (t.sig && S.sigs.has(t.sig))) return null;
    if (t.sig) S.sigs.add(t.sig);
    S.txs++;
    const first = S.creator == null && t.post.size > 0;
    // The creator: pump.fun's declared creator when the creation instruction is decoded, else the fee payer (an
    // assumption, kept as creatorSrc 'payer' so it is never treated as verified).
    if (first) { S.payer = t.payer; S.creator = t.declared || t.payer; S.creatorSrc = t.declared ? 'pump' : 'payer'; S.createSec = t.sec; S.slot = t.slot; S.verified = !!t.init; }
    if (t.sec != null) S.lastSec = Math.max(S.lastSec ?? t.sec, t.sec);
    // A live trade with this signature is now part of the chain balances.
    if (t.sig && S.adjSig.has(t.sig)) { for (const k of S.adjSig.get(t.sig)) dropAdj(S, k); S.adjSig.delete(t.sig); }
    if (t.sig) for (const e of S.devSales) if (e.sig === t.sig && e.slot == null) e.slot = t.slot;
    const delta = new Map();
    for (const a of new Set([...t.pre.keys(), ...t.post.keys()])) {
      const p = t.pre.get(a), q = t.post.get(a), o = q?.owner ?? p?.owner ?? S.acctOwner.get(a) ?? null;
      if (!o) continue;
      const old = S.acct.get(a) ?? 0, now = q ? q.amt : 0;
      S.acct.set(a, now); S.acctOwner.set(a, o);
      S.hold.set(o, (S.hold.get(o) || 0) + now - old);
      delta.set(o, (delta.get(o) || 0) + now - (p ? p.amt : 0));
    }
    if (first) {
      let s = 0; for (const v of S.acct.values()) s += v;
      S.supply = s > 0 ? s : null;
      S.devBuy = S.supply ? 100 * (S.hold.get(S.creator) || 0) / S.supply : null;
    }
    // Launch block = the creation's slot (or its second, if the RPC gives no slot). Only wallets that signed and gained.
    const block = S.slot != null && t.slot != null ? t.slot === S.slot : t.sec != null && t.sec === S.createSec;
    if (block) for (const [o, d] of delta) if (d > 0 && o !== S.creator && t.signers.has(o)) S.launch.set(o, (S.launch.get(o) || 0) + d);
    devFlow(S, delta.get(S.creator), t.sec != null ? t.sec * 1000 : null, t.sig, t.slot);
    devTrack(S, delta.get(S.creator), t.sec != null ? t.sec * 1000 : null, t.sig, 'chain', [...delta].filter(([o, d]) => d > 0 && o !== S.creator).map(x => x[0]), t.slot);
    S.ver++;
    return delta;
  }
  // Tokens in a GMGN feed trade: `ba` when ba × price ≈ the USD value; otherwise USD / price (if `ba` is in raw units).
  function tradeTokens(t) {
    const r = t?.amount > 0 && t.usd > 0 && t.price > 0 ? t.usd / (t.amount * t.price) : null;
    if (r != null && r > 0.5 && r < 2) return t.amount;
    if (t?.usd > 0 && t.price > 0) return t.usd / t.price;
    return r == null && t?.amount > 0 ? t.amount : null;
  }
  // A GMGN feed trade {wallet, side, tokens, hash, at} → the wallet's balance, until the chain covers that signature.
  // Returns a dev-sale event when the dev sells.
  function rugTrade(S, t) {
    if (!S?.supply || !t?.wallet || !(t.tokens > 0) || t.tokens > S.supply || (t.hash && S.sigs.has(t.hash))) return null;
    const d = t.side === 'buy' ? t.tokens : t.side === 'sell' ? -t.tokens : 0, key = (t.hash || 't' + t.at) + '|' + t.wallet + '|' + t.side + '|' + t.tokens;
    if (!d || S.adj.has(key)) return null;
    S.adj.set(key, {wallet: t.wallet, d, sig: t.hash || null, at: t.at});
    if (t.hash) (S.adjSig.get(t.hash) || S.adjSig.set(t.hash, []).get(t.hash)).push(key);
    S.adjBy.set(t.wallet, (S.adjBy.get(t.wallet) || 0) + d);
    S.ver++;
    if (t.wallet === S.creator) devFlow(S, d, t.at, t.hash, null);
    return t.wallet === S.creator ? devTrack(S, d, t.at, t.hash, 'live') : null;
  }
  // Chain caught up to second `sec`: live trades from 30s+ before it that the chain never confirmed are dropped.
  function rugPrune(S, sec) {
    for (const [k, x] of [...S.adj]) if (x.at != null && x.at < (sec - 30) * 1000) { dropAdj(S, k); if (x.sig) S.adjSig.delete(x.sig); }
  }
  // Newer transactions (oldest first) on top of a state → dev sales found in them.
  // Newer transactions on top of a state. Until a transaction after the alert has been seen, the at-call snapshot keeps
  // following the chain (the indexer can lag the alert by a few seconds); it freezes at the first one after the alert.
  function rugCatch(S, txs) {
    const before = S.devSales.length;
    for (const tx of Array.isArray(txs) ? txs : []) {
      const t = txMint(tx, S.mint);
      if (t && !S.crossed && S.cutSec != null && t.sec != null && t.sec > S.cutSec) { S.atCall = rugSnap(S); S.crossed = true; }
      rugTx(S, t);
    }
    if (!S.crossed && S.cutSec != null) S.atCall = rugSnap(S);
    if (S.lastSec != null) rugPrune(S, S.lastSec);
    return S.devSales.slice(before);
  }
  // Verified holders (4.1): the mint's history cannot show a plain token Transfer (it does not name the mint), so the
  // rebuilt balances are checked against the chain's own largest token accounts. accounts: [{acct, owner, amt}] from
  // getTokenLargestAccounts + their owners; supply: getTokenSupply. Returns the gap (% of supply, summed over those
  // accounts) and the verified owner ranking, which replaces the rebuild for "top 10 now".
  function rugVerify(S, accounts, supply) {
    const sup = supply > 0 ? supply : S.supply, by = new Map();
    if (!(sup > 0) || !Array.isArray(accounts) || !accounts.length) return null;
    let gap = 0;
    for (const x of accounts) {
      if (!x?.owner || !(x.amt >= 0)) continue;
      gap += Math.abs((S.acct.get(x.acct) ?? 0) - x.amt);
      by.set(x.owner, (by.get(x.owner) || 0) + x.amt);
    }
    // approx: built from the chain's 20 largest token accounts, so an owner spread over smaller accounts can be missed.
    return {diff: 100 * gap / sup, supply: sup, ranked: [...by].filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]), n: accounts.length, approx: true};
  }
  // ---- Which chain figures can be used (4.2) ----
  // holderTrust: 'verified' = the history was complete and the rebuild matched the chain's own largest accounts within
  // 2% of supply when compared; 'mismatch' = it did not; 'unchecked' = never compared, or the history was cut short.
  const HOLDER_GAP_MAX = 2;
  const holderTrust = (complete, gap) => !complete || gap == null ? 'unchecked' : gap > HOLDER_GAP_MAX ? 'mismatch' : 'verified';
  // Dev holding now from the chain's own figure: the balance at the verification, less the dev's sales after it (by
  // slot when both are known, else by time against the moment the verification was requested). Never "the lower of
  // two sources": a rebuild that missed a plain transfer can show 0% for a real holding.
  // flows: S.devFlows ({d} signed: buys and incoming transfers add, sales and outgoing transfers subtract).
  function devNowVerified(ver, flows, supply) {
    if (ver?.devPct == null || !(supply > 0)) return null;
    const after = (flows || []).filter(e => e.slot != null && ver.slot != null ? e.slot > ver.slot : e.at != null && e.at > ver.startedAt);
    return Math.max(0, ver.devPct + 100 * after.reduce((t, e) => t + (e.d || 0), 0) / supply);
  }
  // Creator: the first transaction must initialise the mint ('none' otherwise). 'pump' = pump.fun's creation instruction
  // declares it; 'confirmed' = that and GMGN agree; 'conflict' = they differ. 'payer' = only the fee payer (another
  // launchpad): an assumption, so not usable for dev checks (GMGN's own dev % is used instead).
  const creatorCheck = (S, gmCreator) => !S?.verified || !S.creator ? 'none' : S.creatorSrc !== 'pump' ? 'payer' : !gmCreator ? 'pump' : gmCreator === S.creator ? 'confirmed' : 'conflict';
  const creatorUsable = c => c === 'confirmed' || c === 'pump';
  // Discord sender: automatic actions only on an explicit match with the learned VolTrak account ('ok'). 'name-only'
  // mode is for a VolTrak whose messages carry no account ID at all (set when learning finds none).
  const senderTrust = (aid, trusted, mode) => mode === 'name-only' ? 'ok' : !trusted ? 'unknown' : !aid ? 'no-id' : aid === trusted ? 'ok' : 'mismatch';
  // Owners by balance, largest first: [[owner, tokens], …].
  function rugRanked(S, n = 40) {
    const all = new Map(S.hold);
    for (const [o, d] of S.adjBy) all.set(o, (all.get(o) || 0) + d);
    return [...all].filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  // Share of supply (%) held by the n largest holders that are not program accounts (bonding curve, AMM pool, lockers).
  function rugTop(ranked, supply, programs, n = 10) {
    if (!(supply > 0) || !Array.isArray(ranked)) return null;
    let s = 0, k = 0;
    for (const [o, a] of ranked) { if (programs?.has(o) || NOT_HOLDERS.has(o)) continue; s += a; if (++k >= n) break; }
    return 100 * s / supply;
  }
  // Launch-block wallets: how many, % of supply they bought there, % they hold now, how many hold under half of it.
  function rugLaunch(S) {
    let bought = 0, held = 0, sold = 0;
    for (const [o, b] of S.launch) { const h = Math.max(0, rugHolding(S, o)); bought += b; held += h; if (h < b / 2) sold++; }
    const p = v => S.supply ? 100 * v / S.supply : null;
    return {wallets: S.launch.size, bought: p(bought), held: p(held), sold};
  }
  function rugSnap(S) {
    const dev = S.supply && S.creator ? 100 * Math.max(0, rugHolding(S, S.creator)) / S.supply : null;
    return {devPct: dev, devSold: S.devSales.length > 0, devSoldPct: S.supply ? 100 * S.devSales.reduce((t, x) => t + x.amt, 0) / S.supply : null,
      holders: rugRanked(S, 40), launch: rugLaunch(S)};
  }
  // Transactions oldest first, from the coin's creation (getTransactionsForAddress, sortOrder asc) → holder state, with
  // a snapshot at cutMs (the alert) in S.atCall. S.crossed: a transaction after the cut was seen, so every one up to
  // the cut was too, even if the fetch stopped early.
  function rugScan(txs, mint, cutMs) {
    const S = rugState(mint), cut = Math.floor(cutMs / 1000);
    S.cutSec = cut;
    for (const tx of Array.isArray(txs) ? txs : []) {
      const t = txMint(tx, mint);
      if (!t) continue;
      if (!S.atCall && t.sec != null && t.sec > cut) { S.atCall = rugSnap(S); S.crossed = true; }
      rugTx(S, t);
    }
    if (!S.atCall) S.atCall = rugSnap(S);
    return S;
  }
  // A wallet's earliest transactions (oldest first) → the first wallet that sent it SOL.
  function funderOf(txs, wallet) {
    for (const tx of Array.isArray(txs) ? txs : []) {
      if (!tx?.meta || tx.meta.err) continue;
      const msg = tx.transaction?.message, ins = [...(msg?.instructions || []), ...(tx.meta.innerInstructions || []).flatMap(x => x?.instructions || [])];
      for (const ix of ins) {
        const p = ix?.parsed, info = p?.info;
        if (!info || (ix.program !== 'system' && ix.programId !== SYSTEM_PROGRAM) || !/^(transfer|transferWithSeed|createAccount)$/.test(p.type)) continue;
        const to = info.destination ?? info.newAccount, from = info.source, lam = number(info.lamports), sec = number(tx.blockTime);
        if (to === wallet && from && from !== wallet) return {funder: from, sol: lam == null ? null : lam / 1e9, at: sec == null ? null : sec * 1000};
      }
    }
    return null;
  }
  // Real-time rug grade. AVOID: a hard red flag. RISKY: a softer one. CLEAN: none found with full data. PARTIAL: none
  // found, but top 10 or dev % is unknown (busy coin). Untested: the backtest's "Rug grade at the call" table shows
  // whether it predicts outcomes. x: {top10, devPct, devSoldRecent, devSoldBefore, sameDev, funderSeen, launchBuyers, botShare}.
  function rugGrade(x) {
    const p = v => (v < 10 ? v.toFixed(1) : v.toFixed(0)) + '%', avoid = [], risky = [];
    if (x.devSoldRecent) avoid.push('Dev is selling'); else if (x.devSoldBefore) risky.push('Dev sold earlier');
    if (x.sameDev) avoid.push('Same dev as an earlier call');
    if (x.top10 >= 35) avoid.push('Top 10 hold ' + p(x.top10)); else if (x.top10 > RUG.top10) risky.push('Top 10 hold ' + p(x.top10));
    if (x.devPct >= 10) avoid.push('Dev holds ' + p(x.devPct)); else if (x.devPct > RUG.dev) risky.push('Dev holds ' + p(x.devPct));
    if (x.launchBuyers > RUG.launch) risky.push(x.launchBuyers + ' launch-block wallets');
    if (x.funderSeen > 0) risky.push('Dev funder seen on ' + x.funderSeen + ' earlier call' + (x.funderSeen === 1 ? '' : 's'));
    if (x.botShare >= 40) risky.push('Volume bots ' + p(x.botShare) + ' of volume');
    const grade = avoid.length ? 'AVOID' : risky.length ? 'RISKY' : x.top10 != null && x.devPct != null ? 'CLEAN' : 'PARTIAL';
    return {grade, code: {CLEAN: 0, RISKY: 1, AVOID: 2}[grade] ?? null, reasons: [...avoid, ...risky]};
  }
  // The grade from a saved check (values at the alert; a dev sale before the call counts as selling).
  const rugGradeAt = (r, seen) => rugGrade({top10: r?.top10, devPct: r?.devPct, devSoldRecent: !!r?.devSold, sameDev: seen?.dev > 0, funderSeen: seen?.fund || 0, launchBuyers: r?.launchBuyers});
  // ---- GMGN's own token data (3.9): read from the GMGN page's API, the same numbers GMGN shows ----
  // Endpoints (Oct 2026): api/v1/token_stat, vas/api/v1/token_holder_stat, api/v1/tokens/top_buyers,
  // api/v1/mutil_window_token_info (POST), vas/api/v1/token_holders. Rates come as fractions ("0.326") → %.
  // Undocumented: any field may vanish, so everything missing stays null and its check shows "no data".
  const INSIDER_TAG = /dev|creator|bundl|rat_trader|insider|snip|entrap/i;
  const roleOfTags = tags => {
    const t = (tags || []).join(' ');
    return /dev|creator/i.test(t) ? 'dev team' : /bundl/i.test(t) ? 'bundler' : /snip/i.test(t) ? 'sniper' : /rat_trader|insider|entrap/i.test(t) ? 'insider' : null;
  };
  function gmgnParse(r) {
    const n = v => v == null || v === '' ? null : Number.isFinite(+v) ? +v : null, pc = v => n(v) == null ? null : 100 * n(v);
    const st = r?.stat?.data || {}, hs = r?.holderStat?.data || {}, tb = r?.topBuyers?.data?.holders || {};
    const info = (Array.isArray(r?.info?.data) ? r.info.data : [])[0] || {}, dev = info.dev || {}, pr = info.price || {};
    const supply = n(info.circulating_supply) ?? n(info.total_supply), price = n(pr.price), launches = Math.max(n(st.creator_created_count) ?? -1, n(dev.creator_open_count) ?? -1);
    const G = {holders: n(st.holder_count) ?? n(info.holder_count), top10: pc(st.top_10_holder_rate ?? dev.top_10_holder_rate),
      platformRate: pc(st.bot_degen_rate), platformCount: n(st.bot_degen_count), freshRate: pc(st.fresh_wallet_rate),
      bundlerPct: pc(st.top_bundler_trader_percentage), ratPct: pc(st.top_rat_trader_percentage), entrapPct: pc(st.top_entrapment_trader_percentage),
      devTeamPct: pc(st.dev_team_hold_rate), devPct: pc(st.creator_hold_rate), sniperPct: pc(st.top70_sniper_hold_rate ?? tb.top70_sniper_hold_rate),
      launches: launches < 0 ? null : launches, devStatus: dev.creator_token_status || null, creator: dev.creator_address || null, cto: n(dev.cto_flag),
      smart: n(hs.smart_degen_count), renowned: n(hs.renowned_count), insiderCount: n(hs.insider_count), bundlerCount: n(hs.bundler_count), sniperCount: n(hs.sniper_count),
      first70Hold: pc(tb.statusNow?.holding_rate), first70Sold: n(tb.statusNow?.sold), first70N: n(tb.holder_count),
      // First 70 buyers now: still holding, added, sold part, sold out (GMGN's own count).
      first70: tb.statusNow ? {hold: n(tb.statusNow.hold), added: n(tb.statusNow.bought_more), part: n(tb.statusNow.sold_part), out: n(tb.statusNow.sold)} : null, profitShare: null,
      supply, price, mc: price > 0 && supply > 0 ? price * supply : null, liquidity: n(info.liquidity), migrated: info.migrated_timestamp == null ? null : n(info.migrated_timestamp) > 0,
      vol5m: n(pr.volume_5m), vol1h: n(pr.volume_1h), buys5m: n(pr.buys_5m), sells5m: n(pr.sells_5m), insiders: [], cluster: null, listed: false};
    const list = Array.isArray(r?.holders?.data?.list) ? r.holders.data.list : null;
    if (list) {
      G.listed = true;
      // People only: pools and the bonding curve (addr_type 2) are not holders.
      const people = list.filter(h => h?.address && n(h.addr_type) !== 2);
      for (const h of people) {
        const role = G.creator && h.address === G.creator ? 'dev' : roleOfTags(h.maker_token_tags);
        if (role) G.insiders.push({w: h.address, role, pct: pc(h.amount_percentage) || 0});
      }
      // Cost basis: share of the listed holders' supply bought at half today's price or less (sitting on 2x+). avg_cost is
      // GMGN's average entry in USD per token; holders without one are left out.
      if (price > 0) {
        let all = 0, up = 0;
        for (const h of people) { const c = n(h.avg_cost), q = pc(h.amount_percentage) || 0; if (!(c > 0) || !(q > 0)) continue; all += q; if (price / c >= 2) up += q; }
        G.profitShare = all > 0 ? 100 * up / all : null;
      }
      // Hidden bundle: 3+ top holders first funded by the same wallet. A named funder (an exchange) is not a cluster.
      const byFunder = new Map();
      for (const h of people) { const f = h.native_transfer?.from_address; if (f && f !== h.address && !h.native_transfer?.name) (byFunder.get(f) || byFunder.set(f, []).get(f)).push(h); }
      for (const [funder, hs] of byFunder) {
        if (hs.length < 3) continue;
        const pct = hs.reduce((t, h) => t + (pc(h.amount_percentage) || 0), 0);
        if (!G.cluster || pct > G.cluster.pct) G.cluster = {funder, n: hs.length, pct, wallets: hs.map(h => ({w: h.address, pct: pc(h.amount_percentage) || 0}))};
      }
    }
    return G;
  }
  // The insider group: GMGN-tagged dev/team/bundler/sniper/insider holders, the funder cluster, plus the dev and the
  // launch-block wallets from the chain rebuild (extra: [{w, role, pct}]). Each wallet counts once, at its own holding
  // (GMGN's holder list first, else the chain's). complete = GMGN's holder list was read; without it the group only has
  // the chain wallets, so its total is not a measure of the insider bag.
  function insiderGroup(G, extra = []) {
    const m = new Map();
    for (const x of G?.insiders || []) m.set(x.w, {role: x.role, pct: x.pct, src: 'gmgn'});
    for (const x of G?.cluster?.wallets || []) if (!m.has(x.w)) m.set(x.w, {role: 'cluster', pct: x.pct, src: 'gmgn'});
    for (const x of extra) { const o = m.get(x.w); if (!o) m.set(x.w, {role: x.role, pct: x.pct || 0, src: 'chain'}); else if (x.role === 'dev') o.role = 'dev'; }
    const byRole = {};
    let total = 0;
    for (const v of m.values()) { total += v.pct; byRole[v.role] = (byRole[v.role] || 0) + v.pct; }
    return {wallets: m, total, byRole, complete: !!G?.listed};
  }
  // Insider sells [{at, w, role, pct}] → is the group leaving together? coordinated: 3+ insider wallets sold within 60s,
  // or the group sold 3%+ of supply within 2 min.
  // A wallet counts toward "3 wallets" only if its sale is 0.1%+ of supply (GMGN tags many small bundler wallets).
  const EXIT = Object.freeze({wallets: 3, walletMs: 60000, walletMinPct: 0.1, pct: 3, pctMs: 120000});
  function exitStats(events, now) {
    const w60 = new Set(), roles = new Set();
    let pct = 0, last = null;
    for (const e of events || []) {
      if (!(e.at <= now + 5000)) continue;
      if (now - e.at <= EXIT.walletMs && (e.pct || 0) >= EXIT.walletMinPct) w60.add(e.w);
      if (now - e.at <= EXIT.pctMs) { pct += e.pct || 0; roles.add(e.role); last = Math.max(last ?? 0, e.at); }
    }
    return {wallets: w60.size, pct, roles: [...roles], last, coordinated: w60.size >= EXIT.wallets || pct >= EXIT.pct};
  }
  // ---- Coin grade (4.3): four parts and a risk-led headline ----
  // Risk: control, concentration and insider hazards. Demand: is the buying broad, real and lasting. Entry: can it be
  // bought and sold at our size without giving the edge away, and is it late. Confidence: is the evidence complete,
  // current and from verified sources. Strong demand can no longer cancel a risk. Headline:
  //   AVOID  a hard stop, Risk <= -4, or Entry <= -3 (cannot get out at a sane cost);
  //   RISKY  Risk <= -1, Demand <= -2 or Entry <= -1;
  //   CLEAN  otherwise, with data on the core risk checks (else PARTIAL; fewer than 5 checks with data: PARTIAL).
  // The insider bag already holds bundlers, snipers and the funder cluster, so those three only score when the bag is
  // unknown (no double counting). App traders is shown but never scored: an app tag names a tool, not a person.
  // Thresholds are judgment calls, untested; every part is saved at each call for the backtest.
  const SCORE_CORE = ['insiders', 'top10', 'dev'];
  function scoreCoin(x) {
    const checks = [], hard = [], p = v => (v < 10 ? v.toFixed(1) : v.toFixed(0)) + '%';
    // status 'info': shown but not scored (counted in another check, or not a quality signal on its own).
    const add = (cat, key, label, value, pts, note, info) => checks.push({cat, key, label, value, pts, status: value == null ? 'na' : info ? 'info' : pts < 0 ? (pts <= -2 ? 'fail' : 'warn') : 'pass', note: note || ''});
    const band = (v, rules) => { if (v == null) return 0; for (const [test, pts] of rules) if (test(v)) return pts; return 0; };
    if (x.exit?.coordinated) hard.push('Insiders selling together: ' + x.exit.wallets + ' wallet' + (x.exit.wallets === 1 ? '' : 's') + ', ' + p(x.exit.pct) + ' of supply in 2 min');
    if (x.devSellingNow) hard.push('Dev is selling');
    const bag = x.insiderHold != null;
    // Risk
    add('risk', 'insiders', 'Insider bag', x.insiderHold == null ? null : p(x.insiderHold), band(x.insiderHold, [[v => v >= 40, -3], [v => v >= 25, -2], [v => v >= 15, -1], [v => v < 10, 1]]), 'dev, team, bundlers, snipers, insiders, launch block, funder cluster');
    add('risk', 'dev', 'Dev holds', x.devPct == null ? null : p(x.devPct) + (x.devSold ? ' · sold' : ''), band(x.devPct, [[v => v >= 10, -2], [v => v > 5, -1]]));
    add('risk', 'launches', 'Dev launches', x.launches == null ? null : String(x.launches), band(x.launches, [[v => v >= 50, -2], [v => v >= 10, -1]]), 'coins this dev created before');
    add('risk', 'repeat', 'Dev / funder seen', x.sameDev == null && x.funderSeen == null ? null : x.sameDev ? 'same dev' : x.funderSeen ? x.funderSeen + ' earlier call' + (x.funderSeen === 1 ? '' : 's') : 'new', x.sameDev ? -2 : x.funderSeen ? -1 : 0, 'on earlier VolTrak calls');
    add('risk', 'top10', 'Top 10', x.top10 == null ? null : (x.top10Approx ? '≈' : '') + p(x.top10), band(x.top10, [[v => v > 35, -2], [v => v > 25, -1], [v => v < 15, 1]]));
    add('risk', 'bundlers', 'Bundlers hold', x.bundlerPct == null ? null : p(x.bundlerPct), bag ? 0 : band(x.bundlerPct, [[v => v >= 20, -2], [v => v >= 10, -1]]), bag ? 'counted in the insider bag' : '', bag);
    add('risk', 'snipers', 'Snipers hold', x.sniperPct == null ? null : p(x.sniperPct), bag ? 0 : band(x.sniperPct, [[v => v >= 20, -1]]), bag ? 'counted in the insider bag' : '', bag);
    add('risk', 'cluster', 'Funder cluster', x.cluster == null ? null : x.cluster.n ? x.cluster.n + ' wallets · ' + p(x.cluster.pct) : 'none', bag || !x.cluster?.n ? 0 : x.cluster.pct >= 10 || x.cluster.n >= 5 ? -2 : -1, bag ? 'counted in the insider bag' : 'top holders funded by the same wallet', bag);
    add('risk', 'launch', 'Launch block', x.launchBuyers == null ? null : x.launchBuyers + ' wallet' + (x.launchBuyers === 1 ? '' : 's'), band(x.launchBuyers, [[v => v > 3, -1]]));
    // Demand
    add('demand', 'app', 'App traders', x.platformRate == null ? null : p(x.platformRate), 0, 'holders whose wallets use a trading app (a tool, not proof of a person)', true);
    add('demand', 'fresh', 'Fresh wallets', x.freshRate == null ? null : p(x.freshRate), band(x.freshRate, [[v => v >= 40, -1]]));
    add('demand', 'smart', 'Smart money', x.smart == null ? null : String(x.smart), band(x.smart, [[v => v >= 3, 1]]));
    add('demand', 'growth', 'Holders 5m', x.holderGrowth == null ? null : (x.holderGrowth >= 0 ? '+' : '') + p(x.holderGrowth).replace('-', '−'), band(x.holderGrowth, [[v => v >= 10, 1], [v => v <= -5, -1]]));
    add('demand', 'retention', 'First buyers holding', x.retention == null ? null : p(x.retention), band(x.retention, [[v => v >= 50, 1], [v => v < 10, -1]]), 'share of the first 70 buyers' + String.fromCharCode(8217) + ' tokens still held');
    // Bots: the worse of bot share of trades (bump bots faking activity) and of dollar volume (wash trading).
    add('demand', 'bots', 'Bots', x.botShare == null && x.botTrades == null ? null : (x.botTrades == null ? '' : p(x.botTrades) + ' trades · ') + (x.botShare == null ? '' : p(x.botShare) + ' $'),
      Math.min(band(x.botTrades, [[v => v >= 60, -2], [v => v >= 30, -1]]), band(x.botShare, [[v => v >= 40, -1]])), 'bot share of trades and of dollar volume');
    add('demand', 'organic', 'Organic buys', x.orgShare == null ? null : p(x.orgShare), band(x.orgShare, [[v => v >= 60, 1]]), 'buy share with bot trades removed');
    add('demand', 'volmc', 'Volume / MC', x.volMc == null ? null : x.volMc.toFixed(1) + '×', band(x.volMc, [[v => v >= 10, -1]]), '1h volume vs market cap');
    // Entry
    add('entry', 'exitcost', 'Round trip', x.exitCost == null ? null : '−' + p(Math.max(0, x.exitCost)), band(x.exitCost, [[v => v >= 50, -3], [v => v >= 25, -2], [v => v >= 10, -1]]), 'buy then sell at your size (Jupiter quote: fees and price impact)');
    add('entry', 'overhang', 'Holders in profit', x.profitShare == null ? null : p(x.profitShare) + ' at 2×+', band(x.profitShare, [[v => v >= 50, -1]]), 'share of top-holder supply bought at half the price or less');
    add('entry', 'move', 'Since the call', x.moveSinceCall == null ? null : (x.moveSinceCall >= 0 ? '+' : '−') + p(Math.abs(x.moveSinceCall)), band(x.moveSinceCall, [[v => v >= 100, -1]]), 'price move since the alert (chasing after +100%)');
    const known = checks.filter(c => c.status !== 'na').length, sum = c => checks.filter(k => k.cat === c).reduce((t, k) => t + k.pts, 0);
    const risk = sum('risk'), demand = sum('demand'), entry = sum('entry'), score = risk + demand + entry;
    // CLEAN needs the core risk checks: missing data must not read as safe. Red flags still grade with partial data.
    const missing = SCORE_CORE.filter(k => checks.find(c => c.key === k)?.status === 'na');
    const g0 = hard.length || risk <= -4 || entry <= -3 ? 'AVOID' : known < 5 ? 'PARTIAL' : risk <= -1 || demand <= -2 || entry <= -1 ? 'RISKY' : 'CLEAN';
    const grade = g0 === 'CLEAN' && missing.length ? 'PARTIAL' : g0;
    // The check that set the grade: the worst one in the part that tripped the rule (not just the worst overall).
    const worstIn = cat => checks.filter(k => k.cat === cat && k.pts < 0).sort((a, b) => a.pts - b.pts)[0] || null;
    const because = hard.length ? null : g0 === 'AVOID' ? worstIn(risk <= -4 ? 'risk' : 'entry') : g0 === 'RISKY' ? worstIn(risk <= -1 ? 'risk' : demand <= -2 ? 'demand' : 'entry') : null;
    // Confidence: missing core checks or a source conflict = low; stale or unverified inputs, or under 10 checks = medium.
    const c = x.conf || {}, reasons = [...missing.map(k => 'no ' + checks.find(q => q.key === k).label.toLowerCase()), ...(c.conflict || []), ...(c.stale || []), ...(c.unverified || [])];
    const level = missing.length || c.conflict?.length ? 'low' : c.stale?.length || c.unverified?.length || known < 10 ? 'medium' : 'high';
    return {grade, score, risk, demand, entry, confidence: {level, reasons}, known, hard, checks, missing, because: because?.key ?? null, code: {CLEAN: 0, RISKY: 1, AVOID: 2}[grade] ?? null};
  }
  // Saved check (at the call) → one line for Telegram. seen: {dev, fund} earlier calls sharing the dev or its funder.
  function rugLine(r, seen) {
    if (!r || r.empty) return 'Rug checks: no chain data';
    const p = v => v == null ? '?' : (v < 10 ? v.toFixed(1) : v.toFixed(0)) + '%', warn = b => b ? ' ⚠' : '';
    return [rugGradeAt(r, seen).grade, 'Top 10 ' + p(r.top10) + warn(r.top10 > RUG.top10),
      'Dev ' + p(r.devPct) + (r.devSold ? ' (sold)' : '') + warn(r.devPct > RUG.dev || r.devSold),
      'Launch ' + (r.launchBuyers ?? '?') + ' wallet' + (r.launchBuyers === 1 ? '' : 's') + (r.launchPct != null ? ' / ' + p(r.launchPct) : '') + warn(r.launchBuyers > RUG.launch),
      'Funder ' + (!r.funder ? '?' : seen?.dev ? 'same dev as an earlier call' : seen?.fund ? 'seen on ' + seen.fund + ' earlier call' + (seen.fund === 1 ? '' : 's') : 'new') + warn(seen?.dev || seen?.fund)].join(' · ');
  }
  return {MINT,number,money,parseAlert,mintFromURL,gmgnURL,selectPair,normalize,gtPool,gtPools,tradeFlow,gmgnFrame,addrOf,gmgnTrade,gmgnStat,liveView,assess,
    candles,mergeCandles,scoreCall,preAlert,breakeven,wilson,summarize,zFor,tFor,backtestReport,VB,botFlow,gmgnMaker,gmgnApiTrade,APP_TAG,BOT_RULES,BOT_SURE,txTrades,LATE,LATE_LEGACY,lateGrade,ppEvent,marketTape,initials,handoff,
    RUG,SYSTEM_PROGRAM,txMint,rugState,rugHolding,rugTx,tradeTokens,rugTrade,rugPrune,rugCatch,rugVerify,HOLDER_GAP_MAX,holderTrust,devNowVerified,creatorCheck,creatorUsable,senderTrust,rugRanked,rugTop,rugLaunch,rugSnap,rugScan,funderOf,rugGrade,rugGradeAt,rugLine,FEATURES,gmgnParse,roleOfTags,insiderGroup,EXIT,exitStats,scoreCoin,b58decode,b58encode,pumpCreator,devFlow,WSOL_MINT};
})();
/* CORE END */

// GMGN live feed: a read-only listener on the websocket GMGN's page opens itself (ws.gmgn.ai). It never sends on
// that socket and never changes a message; it only reads token_activity and token_stat frames.
const VTLive = (() => {
  const listeners = new Set(), pending = [], seen = new WeakSet();
  let attachedAt = 0, lastFrame = 0;
  // Data check: which channels GMGN sends, which fields its trade rows carry (e.g. wallet tags), a few sample rows.
  const census = {since: Date.now(), frames: 0, hidden: 0, nonText: 0, channels: {}, keys: {}, samples: {}};
  const note = (frame, hidden) => {
    census.frames++; if (hidden) census.hidden++;
    const keys = census.keys[frame.channel] || (census.keys[frame.channel] = []), samples = census.samples[frame.channel] || (census.samples[frame.channel] = []);
    for (const x of frame.items.slice(0, 5)) for (const k of Object.keys(x)) if (!keys.includes(k) && keys.length < 80) keys.push(k);
    if (samples.length < 3 && frame.items[0]) samples.push(JSON.stringify(frame.items[0]).slice(0, 1000));
  };
  const emit = frame => { if (!listeners.size) { if (pending.push(frame) > 200) pending.shift(); return; } for (const fn of listeners) try { fn(frame); } catch (_) {} };
  const watch = ws => {
    if (!ws || seen.has(ws) || !/(^|\.)gmgn\.ai(:|\/|$)/.test(String(ws.url).replace(/^wss?:\/\//, ''))) return;
    seen.add(ws); attachedAt = attachedAt || Date.now();
    ws.addEventListener('message', e => {
      lastFrame = Date.now();
      if (typeof e.data !== 'string') { census.nonText++; return; }
      const ch = e.data.slice(0, 200).match(/"channel"\s*:\s*"([^"]{1,40})"/)?.[1] || '?';
      if (ch in census.channels || Object.keys(census.channels).length < 60) census.channels[ch] = (census.channels[ch] || 0) + 1;
      if (!/"(token_activity|token_activity_info_all|token_stat)"/.test(e.data)) return;
      const frame = VTCore.gmgnFrame(e.data);
      if (frame) { try { note(frame, document.hidden); } catch (_) {} emit(frame); }
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
  return {on(fn) { listeners.add(fn); pending.splice(0).forEach(emit); }, attachedAt: () => attachedAt, lastFrame: () => lastFrame, census: () => census};
})();

// Photon probe (Photon tab only, read-only): Photon has no public API, so this records the shape of the data Photon's
// own page receives (websocket messages and API responses) to find where its volume-bot info lives. Nothing is sent
// anywhere; "Copy Photon report" puts a trimmed, redacted summary on the clipboard for the user to share.
const PhotonProbe = (() => {
  if (location.hostname !== 'photon-sol.tinyastro.io') return null;
  // Redaction: secret-looking keys anywhere in a name, JWTs inside strings, and every Solana address (the user's wallet
  // included) become placeholders. Account-related messages and paths are skipped entirely.
  const SECRET = /token|secret|passw|pwd|auth|session|^sid$|cookie|csrf|xsrf|api[-_]?key|private|seed|mnemonic|otp|^code$|signature|^pk$|^sk$|mail|phone|balance/i;
  const ACCOUNT = /wallet|balance|portfolio|position|order|user|account|profile|referr|settings|login/i;
  const INTEREST = /\b(bots?|volume[_ -]?bots?|wash\w*|maker\w*|snipers?|bundle\w*|insiders?|holders?|trades?|swaps?|tags?)\b|bot_|_bot|bot[A-Z]/;
  const ADDR = /[1-9A-HJ-NP-Za-km-z]{32,44}/g, clean = t => String(t).replace(ADDR, '<addr>').replace(/\b[0-9a-f]{24,}\b/gi, '<id>');
  const rep = {since: Date.now(), sockets: {}, http: {}, events: {}, keys: {}, samples: {}, domLines: []};
  const redact = (v, depth = 0) => {
    if (typeof v === 'string') { const t = clean(v.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[jwt]')); return t.length > 200 ? t.slice(0, 200) + '…' : t; }
    if (!v || typeof v !== 'object') return v;
    if (depth > 6) return '[deep]';
    if (Array.isArray(v)) return v.slice(0, 4).map(x => redact(x, depth + 1));
    const o = {}; for (const [k, x] of Object.entries(v).slice(0, 60)) o[clean(k)] = SECRET.test(k) ? '[redacted]' : redact(x, depth + 1); return o;
  };
  const record = (source, raw) => {
    let msg = raw;
    if (typeof raw === 'string') { const i = raw.search(/[[{]/); if (i < 0) return; try { msg = JSON.parse(raw.slice(i)); } catch (_) { return; } }
    if (!msg || typeof msg !== 'object') return;
    const first = Array.isArray(msg) ? msg.find(x => x && typeof x === 'object') : msg;
    const name = clean(source + ':' + String(first?.type ?? first?.event ?? first?.channel ?? first?.e ?? first?.op ?? (Array.isArray(msg) && typeof msg[0] === 'string' ? msg[0] : '?')).slice(0, 40));
    if (!(name in rep.events) && Object.keys(rep.events).length >= 80) return;
    rep.events[name] = (rep.events[name] || 0) + 1;
    // Account-shaped messages (by their name or top-level fields) are only counted, never sampled.
    if (ACCOUNT.test(name) || ACCOUNT.test(Object.keys(first || {}).join(' '))) return;
    // After the first 200 messages of a kind, only count them: the shape is known and the page should not pay for parsing.
    if (rep.events[name] > 200) return;
    const keys = rep.keys[name] || (rep.keys[name] = []);
    const walk = (o, pre, d) => { if (!o || typeof o !== 'object' || d > 2 || keys.length >= 120) return; for (const [k, v] of Object.entries(Array.isArray(o) ? (o[0] ?? {}) : o).slice(0, 60)) { const path = pre + clean(k); if (!keys.includes(path)) keys.push(path); walk(v, path + '.', d + 1); } };
    walk(first, '', 0);
    const samples = rep.samples[name] || (rep.samples[name] = []);
    if (samples.length < 3) { const text = JSON.stringify(msg); if (INTEREST.test(text)) samples.push(JSON.stringify(redact(msg)).slice(0, 1500)); }
  };
  try {
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window, WS = page.WebSocket;
    page.WebSocket = new Proxy(WS, {construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      try { const u = clean(String(args[0]).replace(/\?.*$/, '')); rep.sockets[u] = (rep.sockets[u] || 0); ws.addEventListener('message', e => { rep.sockets[u]++; if (typeof e.data === 'string') try { record('ws', e.data); } catch (_) {} }); } catch (_) {}
      return ws;
    }});
    const f = page.fetch;
    page.fetch = function (...args) {
      const p = f.apply(this, args);
      try {
        const url = String(args[0]?.url || args[0]), path = clean(url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''));
        // Only data-looking paths, never account ones, and only until 3 samples exist for that path.
        if (INTEREST.test(path) && !ACCOUNT.test(path) && !((rep.samples['http ' + path.slice(0, 60) + ':?'] || []).length >= 3))
          p.then(r => { rep.http[path] = (rep.http[path] || 0) + 1; const ct = r.headers?.get?.('content-type') || ''; if (/event-stream/.test(ct) || !/json|text/.test(ct)) return null; return r.clone().text(); })
            .then(t => { if (t && t.length < 500000) record('http ' + path.slice(0, 60), t); }).catch(() => {});
      } catch (_) {}
      return p;
    };
  } catch (_) {}
  const report = () => {
    const lines = (document.body?.innerText || '').split('\n').map(x => x.trim()).filter(x => x && x.length < 120 && /volume\s*bot|bot\s*vol|wash|\bbots?\b/i.test(x)).map(clean);
    return JSON.stringify({...rep, page: clean(location.pathname), domLines: [...new Set(lines)].slice(0, 30), copiedAt: new Date().toISOString()}, null, 1);
  };
  const ui = () => {
    if (window.top !== window.self || document.getElementById('vts-probe')) return;
    const b = document.createElement('button'); b.id = 'vts-probe';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;font:600 12px system-ui,sans-serif;padding:8px 12px;border-radius:9px;border:1px solid #33445a;background:#0f151c;color:#e8eef6;cursor:pointer;box-shadow:0 6px 20px #0008';
    const label = () => { const n = Object.values(rep.events).reduce((a, x) => a + x, 0); b.textContent = 'VolTrak: copy Photon report (' + n + ' messages)'; };
    // Only a real click by the user copies (the page's own scripts cannot trigger it).
    b.onclick = e => { if (!e.isTrusted) return; GM_setClipboard(report(), 'text'); b.textContent = 'Copied: check it, then paste it to Claude'; setTimeout(label, 4000); };
    document.body.appendChild(b); label(); setInterval(() => { if (!/^Copied/.test(b.textContent)) label(); }, 3000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui, {once: true}); else ui();
  return {report};
})();

// Panel CSS and markup (scoped under #vts-root; no external fonts or images, so page CSP cannot block them).
const PANEL_CSS = String.raw`/* =====================================================================
   VolTrak Steroids · panel CSS (production)
   - Paste inside the <style> at the top of root.innerHTML.
   - Every selector is scoped under #vts-root. System fonts and inline SVG only.
   - Dynamic values (--p meter/bar fill, --x/--y/--cy/--px spark marks, --n
     progress segments) are set with el.style.setProperty() (CSSOM), never with
     style="" attributes in markup, so a strict style-src CSP cannot block them.
   - Colour is never the only signal: every tone also has a glyph, a word or a
     pattern (hazard stripes, hatching, dashed = unproven/pending).
   - Fills: a solid fill means a warning (FADE, CAUTION, RISK). Positive readings
     are tinted. The one exception is a proven A grade (n >= 20).
   ===================================================================== */
#vts-root{
  /* surfaces */
  --bg:#080b0f;--bg2:#0d1218;--card:#10161e;--card2:#16202b;--well:#0a0f15;
  --line:#1d2733;--line2:#2b3848;--line3:#3d4d62;
  /* text, contrast on --card: text 16.5:1 · muted 7.9:1 · dim 5.4:1 */
  --text:#eef3f8;--muted:#9eadbf;--dim:#7f8d9e;
  /* signals: colour · ink (text on a solid fill) · bg (tint) · line (tint border) */
  --buy:#2ee88f;--buy-ink:#02170c;--buy-bg:#0c2318;--buy-line:#1f6b47;
  --sell:#ff5468;--sell-ink:#1f0308;--sell-bg:#2a0e14;--sell-line:#7a2632;
  --warn:#ffc43d;--warn-ink:#211600;--warn-bg:#241c07;--warn-line:#6b5212;
  --wait:#93b4ff;--wait-ink:#08142e;--wait-bg:#111b31;--wait-line:#34528c;
  --lime:#b4ec6e;
  /* the tool itself: clocks, countdowns, active tab, primary button, focus ring */
  --accent:#36c9ff;--accent-ink:#021722;
  /* current reading, switched by data-tone on the root */
  --tone:#6b7a8d;--tone-ink:#eef3f8;--tone-bg:#121922;--tone-line:#2b3848;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Cascadia Mono","DejaVu Sans Mono","Liberation Mono",monospace;
  position:fixed;right:16px;bottom:16px;z-index:2147483647;
  display:flex;flex-direction:column;
  width:380px;max-width:calc(100vw - 24px);max-height:72vh;
  container:vts/inline-size;
  margin:0;padding:0;color:var(--text);font:13px/1.4 var(--sans);text-align:left;letter-spacing:normal;text-transform:none;
  background:var(--bg);border:1px solid var(--line2);border-radius:12px;
  box-shadow:0 0 0 1px #000,0 18px 50px #000c;overflow:hidden;
  -webkit-font-smoothing:antialiased;
}
#vts-root[hidden]{display:none!important}
#vts-root[data-tone=buy]{--tone:var(--buy);--tone-ink:var(--buy-ink);--tone-bg:var(--buy-bg);--tone-line:var(--buy-line)}
#vts-root[data-tone=sell]{--tone:var(--sell);--tone-ink:var(--sell-ink);--tone-bg:var(--sell-bg);--tone-line:var(--sell-line)}
#vts-root[data-tone=caution]{--tone:var(--warn);--tone-ink:var(--warn-ink);--tone-bg:var(--warn-bg);--tone-line:var(--warn-line)}
#vts-root[data-tone=wait]{--tone:var(--wait);--tone-ink:var(--wait-ink);--tone-bg:var(--wait-bg);--tone-line:var(--wait-line)}

/* ---------- base + host-CSS resets (GMGN Tailwind preflight, Discord) ---------- */
#vts-root *,#vts-root *::before,#vts-root *::after{box-sizing:border-box}
#vts-root [hidden]{display:none!important}
/* host pages style generic classes (.sub, .tag, .note, .pill...): neutralise what we don't set ourselves */
#vts-root :where(div,span,b,i,u,small,strong,em,p,ul,ol,li,label,section,header,nav,footer,details,summary,h3,h4,kbd,sup){color:inherit;background:none;border:0;margin:0;padding:0;box-shadow:none;text-shadow:none;float:none;font-style:normal;text-decoration:none;letter-spacing:inherit;text-transform:inherit;min-width:0;max-width:none;width:auto;height:auto;opacity:1;transform:none;filter:none}
#vts-root p{margin:6px 0}
#vts-root .vts-sprite{position:absolute;width:0;height:0;overflow:hidden}
#vts-root .i{display:inline-block;flex:none;width:1em;height:1em;fill:currentColor;vertical-align:-.125em;overflow:visible}
#vts-root .pos{color:var(--buy)}#vts-root .neg{color:var(--sell)}#vts-root .warnc{color:var(--warn)}#vts-root .muted{color:var(--muted)}#vts-root .dim{color:var(--dim)}
#vts-root .lbl{font:700 10.5px/1.2 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
#vts-root kbd{font:700 10px/1 var(--mono);padding:2px 5px;border:1px solid var(--line2);border-bottom-width:2px;border-radius:4px;background:var(--card2);color:var(--text)}
#vts-root button,#vts-root input,#vts-root select,#vts-root textarea{
  -webkit-appearance:none;appearance:none;margin:0;font:inherit;letter-spacing:inherit;text-transform:none;color:var(--text);
  box-shadow:none;min-height:0;height:auto;max-width:100%;outline:none;text-shadow:none}
#vts-root button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;width:auto;
  background:var(--card2);border:1px solid var(--line2);border-radius:7px;padding:7px 11px;font-weight:650;line-height:1.2;text-align:center;white-space:nowrap;text-decoration:none}
#vts-root button:hover{background:#1d2836;border-color:var(--line3)}
#vts-root button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:800}
#vts-root button.primary:hover{background:#6bd8ff}
#vts-root button:focus-visible,#vts-root input:focus-visible,#vts-root select:focus-visible,#vts-root summary:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
#vts-root input,#vts-root select{display:block;width:100%;background:var(--well);border:1px solid var(--line2);border-radius:7px;padding:8px 10px;font-size:13px;line-height:1.25}
#vts-root input::placeholder{color:var(--dim);opacity:1}
#vts-root input[type=number]{-moz-appearance:textfield}
#vts-root input::-webkit-inner-spin-button,#vts-root input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
#vts-root select{padding-right:30px;cursor:pointer;white-space:nowrap;text-overflow:ellipsis;
  background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);
  background-position:calc(100% - 16px) 52%,calc(100% - 11px) 52%;background-size:5px 5px;background-repeat:no-repeat}
#vts-root select option{background:var(--card);color:var(--text)}
/* checkbox = switch (knob drawn with a gradient: no pseudo-elements on inputs) */
#vts-root input[type=checkbox]{flex:none;display:inline-block;width:30px;height:18px;padding:0;border-radius:9px;border:1px solid var(--line3);cursor:pointer;
  background:radial-gradient(circle at 8px 50%,var(--muted) 0 5px,transparent 5.5px) no-repeat,var(--well)}
#vts-root input[type=checkbox]:checked{border-color:var(--accent);background:radial-gradient(circle at calc(100% - 8px) 50%,var(--accent-ink) 0 5px,transparent 5.5px) no-repeat,var(--accent)}

/* ---------- header: drag bar; collapsed it becomes the scoreboard ---------- */
#vts-root header{position:relative;flex:none;display:flex;align-items:center;gap:8px;height:40px;margin:0;padding:0 6px 0 8px;background:var(--bg2);border-bottom:1px solid var(--line);cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}
#vts-root header::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:var(--tone)}
#vts-root .grip{width:10px;height:16px;color:#5a6879}
#vts-root .brand{flex:none;display:flex;align-items:center;gap:6px;font:800 12px/1 var(--mono);letter-spacing:.18em;white-space:nowrap}
#vts-root .brand b{font-weight:800}
#vts-root .brand .i{color:var(--accent);width:14px;height:14px}
#vts-root[data-tone]:not([data-tab=live]) .brand b{display:none}
#vts-root .mini{flex:1;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;white-space:nowrap;overflow:hidden}
#vts-root[data-tab=live]:not(.vts-collapsed) .mini{visibility:hidden}
#vts-root .m-state{flex:none;display:inline-flex;align-items:center;gap:5px;padding:5px 7px;border-radius:5px;font:850 11px/1 var(--sans);letter-spacing:.05em;text-transform:uppercase;background:var(--tone-bg);color:var(--tone);box-shadow:inset 0 0 0 1px var(--tone-line)}
#vts-root[data-tone=sell] .m-state,#vts-root[data-tone=caution] .m-state{background:var(--tone);color:var(--tone-ink);box-shadow:none}
#vts-root .m-read{display:flex;align-items:baseline;gap:6px;min-width:0}
#vts-root .m-sym{min-width:0;font:700 11px/1 var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis}
#vts-root .m-share{flex:none;font:850 16px/1 var(--sans);font-variant-numeric:tabular-nums}
#vts-root .m-share small{font:700 9.5px/1 var(--mono);letter-spacing:.06em;color:var(--muted);margin-left:3px;text-transform:uppercase}
#vts-root .m-since{flex:none;display:inline-flex;align-items:center;gap:4px;font:750 13px/1 var(--mono);color:var(--accent);font-variant-numeric:tabular-nums}
#vts-root .m-since .i{width:.9em;height:.9em}
#vts-root .m-text{display:none;align-items:center;gap:6px;font:750 11px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase}
#vts-root .m-text::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
#vts-root .m-bar{display:none}
#vts-root[data-site=discord] .mini>:not(.m-text){display:none}
#vts-root[data-site=discord] .m-text{display:inline-flex}
#vts-root .hbtn{flex:none;width:28px;height:28px;padding:0;background:transparent;border:1px solid var(--line2);border-radius:6px;font-size:14px}
#vts-root .hbtn .ic-max,#vts-root.vts-collapsed .hbtn .ic-min{display:none}
#vts-root.vts-collapsed .hbtn .ic-max{display:inline-block}
/* tone glyphs: all five ship in the markup, the root's data-tone shows one */
#vts-root .ti{display:inline-flex;flex:none}
#vts-root .ti .i{display:none}
#vts-root .ti .t-unk,#vts-root[data-tone] .ti .t-unk{display:inline-block}
#vts-root[data-tone=buy] .ti .t-unk,#vts-root[data-tone=sell] .ti .t-unk,#vts-root[data-tone=caution] .ti .t-unk,#vts-root[data-tone=wait] .ti .t-unk{display:none}
#vts-root[data-tone=buy] .ti .t-buy,#vts-root[data-tone=sell] .ti .t-sell,#vts-root[data-tone=caution] .ti .t-caution,#vts-root[data-tone=wait] .ti .t-wait{display:inline-block}
/* collapsed: one 52px scoreboard row: state block · symbol over share · clock · split bar along the bottom */
#vts-root.vts-collapsed header{height:52px;padding:0 8px 0 0;border-bottom:0;gap:10px}
#vts-root.vts-collapsed header::before,#vts-root.vts-collapsed .grip{display:none}
#vts-root.vts-collapsed[data-tone] .brand{display:none}
#vts-root.vts-collapsed .mini{justify-content:flex-start;align-self:stretch;gap:12px}
#vts-root.vts-collapsed .m-state{align-self:stretch;min-width:118px;padding:0 12px;border-radius:0;font-size:13.5px;gap:7px;box-shadow:inset 4px 0 0 var(--tone)}
#vts-root.vts-collapsed[data-tone=sell] .m-state{box-shadow:none}
#vts-root.vts-collapsed[data-tone=caution] .m-state{box-shadow:none;padding-left:18px;background:linear-gradient(90deg,transparent 0 8px,var(--warn) 8px),repeating-linear-gradient(135deg,var(--warn-ink) 0 5px,var(--warn) 5px 10px)}
#vts-root.vts-collapsed .m-state .i{width:16px;height:16px}
#vts-root.vts-collapsed .m-read{flex-direction:column;align-items:flex-start;gap:3px;max-width:104px}
#vts-root.vts-collapsed .m-sym{max-width:100%;font-size:10.5px;letter-spacing:.02em}
#vts-root.vts-collapsed .m-share{font-size:26px;letter-spacing:-.02em}
#vts-root.vts-collapsed .m-since{font-size:16px}
#vts-root.vts-collapsed .m-bar{display:block;position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,var(--buy) 0 var(--p,50%),var(--sell) var(--p,50%) 100%)}
#vts-root.vts-collapsed .m-bar.empty{background:var(--line2)}
#vts-root.vts-collapsed .vts-body,#vts-root.vts-collapsed .tabs,#vts-root.vts-collapsed .foot{display:none}

/* ---------- tabs ---------- */
#vts-root .tabs{flex:none;display:flex;margin:0;padding:0 4px;background:var(--bg2);border-bottom:1px solid var(--line)}
#vts-root .tabs button{flex:1;position:relative;background:none;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--muted);font:750 11px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;padding:11px 4px 10px}
#vts-root .tabs button:hover{background:none;color:var(--text)}
#vts-root .tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
#vts-root .tabs .badge{display:inline-block;margin-left:5px;min-width:16px;padding:2px 4px;border-radius:8px;background:var(--buy-bg);color:var(--buy);box-shadow:inset 0 0 0 1px var(--buy-line);font:800 9.5px/1 var(--sans);letter-spacing:0}

/* ---------- body (scrolls) + footer (fixed) ---------- */
#vts-root .vts-body{flex:1 1 auto;min-height:0;padding:10px 12px 12px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
#vts-root .foot{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;min-height:36px;padding:6px 8px 6px 12px;background:var(--bg2);border-top:1px solid var(--line);font-size:11.5px;color:var(--muted)}
#vts-root .foot .st{flex:1 1 170px;min-width:170px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .foot .fg{display:flex;align-items:center;gap:8px;margin-left:auto}
#vts-root .foot button{padding:5px 8px;font-size:11.5px;border-radius:6px}
#vts-root .sw{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);cursor:pointer;white-space:nowrap}
#vts-root .sw input[type=checkbox]{width:26px;height:16px;background:radial-gradient(circle at 7px 50%,var(--muted) 0 4px,transparent 4.5px) no-repeat,var(--well)}
#vts-root .sw input[type=checkbox]:checked{background:radial-gradient(circle at calc(100% - 7px) 50%,var(--accent-ink) 0 4px,transparent 4.5px) no-repeat,var(--accent)}
#vts-root .dot{flex:none;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim)}
#vts-root .dot.ok{background:var(--buy)}#vts-root .dot.warn{background:var(--warn)}#vts-root .dot.bad{background:var(--sell)}

/* ---------- LIVE · identity ---------- */
#vts-root .ident{margin-bottom:8px}
#vts-root .nm{display:flex;align-items:baseline;gap:7px;min-width:0}
#vts-root h3{min-width:0;margin:0;font:850 17px/1.2 var(--sans);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .sym{flex:0 3 auto;min-width:0;font:700 11.5px/1 var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .venue{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:6px}
#vts-root .vtags{display:contents}
#vts-root .mint{padding:3px 7px;gap:6px;font:600 11px/1.2 var(--mono);color:var(--muted);background:transparent;border-color:var(--line2);border-radius:5px}
#vts-root .mint .i{width:12px;height:12px}
#vts-root .tag{flex:none;display:inline-flex;align-items:center;gap:4px;padding:4px 6px;border-radius:4px;border:1px solid var(--line2);color:var(--muted);font:800 10px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}
#vts-root .tag.ok{color:var(--buy);border-color:var(--buy-line)}
#vts-root .tag.warn{color:var(--warn);border-color:var(--warn-line)}
#vts-root .tag.bad{color:var(--sell-ink);background:var(--sell);border-color:var(--sell)}
#vts-root .tag.dash{border-style:dashed;border-color:var(--line3)}

/* ---------- LIVE · hero: state band, two decision numbers, meter ---------- */
#vts-root .hero{container:hero/inline-size;border:1px solid var(--line2);border-radius:10px;overflow:hidden;background:var(--card);background:linear-gradient(180deg,var(--tone-bg) 0,var(--card) 62%)}
#vts-root .band{display:flex;align-items:center;gap:9px;min-height:58px;padding:7px 8px 7px 12px;background:var(--tone-bg);color:var(--tone);border-bottom:1px solid var(--tone-line);box-shadow:inset 4px 0 0 var(--tone)}
#vts-root .band .ti .i{width:22px;height:22px}
#vts-root .band .bt{flex:1;min-width:0}
#vts-root .band [data-vts=state]{display:block;font:900 20px/1.05 var(--sans);font-size:clamp(15px,5.3cqi,21px);letter-spacing:0;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .band .sub{display:flex;align-items:center;gap:6px;min-width:0;margin-top:5px;font:700 11.5px/1.2 var(--sans);color:inherit;white-space:nowrap;overflow:hidden}
#vts-root .band .sub>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
#vts-root .band .sub [data-vts=state-why]{white-space:normal;line-height:1.25;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
#vts-root .band .sub:has([data-vts=state-why]:not([hidden])){align-items:flex-start}
#vts-root .fresh{flex:none;display:inline-flex;align-items:center;gap:4px;padding:3px 5px;border-radius:4px;background:#04070ad0;color:var(--text);font:800 9.5px/1 var(--mono);letter-spacing:.05em}
#vts-root .fresh::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--buy)}
#vts-root .fresh.stale::before{background:var(--warn)}
#vts-root .fresh.off::before{background:var(--sell)}
#vts-root .clock{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px;padding:5px 8px 6px;border-radius:7px;background:#04070ad9;border:1px solid #ffffff14;color:var(--accent)}
#vts-root .clock .lbl{font-size:8.5px;letter-spacing:.1em}
#vts-root .clock b{display:inline-flex;align-items:center;gap:5px;font:750 19px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
#vts-root .clock b .i{width:13px;height:13px}
#vts-root[data-tone=sell] .band{background:var(--sell);color:var(--sell-ink);border-bottom-color:var(--sell);box-shadow:none}
#vts-root[data-tone=caution] .band{background:linear-gradient(90deg,transparent 0 10px,var(--warn) 10px),repeating-linear-gradient(135deg,var(--warn-ink) 0 5px,var(--warn) 5px 10px);color:var(--warn-ink);border-bottom-color:var(--warn);box-shadow:none;padding-left:20px}
#vts-root[data-tone=unknown] .band,#vts-root:not([data-tone]) .band{background:transparent;color:var(--muted);box-shadow:none;border-bottom:1px dashed var(--line2)}
#vts-root[data-tone=unknown] .hero{background:var(--card)}
#vts-root .score{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:end;column-gap:14px;padding:10px 12px 6px}
#vts-root .score>*{min-width:0}
#vts-root .score .r{text-align:right;justify-self:end}
#vts-root .big{display:block;margin-top:4px;font:850 52px/.95 var(--sans);font-size:clamp(40px,15cqi,54px);font-variant-numeric:tabular-nums;letter-spacing:-.035em;white-space:nowrap;overflow:hidden;max-width:100%;color:var(--text)}
#vts-root .big small{font:800 .42em/1 var(--sans);letter-spacing:0;margin-left:2px}
#vts-root .big.long{font-size:clamp(26px,10cqi,40px)}
#vts-root .big.up::before,#vts-root .big.down::before{content:"";display:inline-block;width:.38em;height:.34em;margin-right:.07em;background:currentColor;vertical-align:.3em}
#vts-root .big.up::before{clip-path:polygon(50% 0,100% 100%,0 100%)}
#vts-root .big.down::before{clip-path:polygon(0 0,100% 0,50% 100%)}
#vts-root .big.na{color:var(--dim)}
#vts-root .hsub{display:block;margin-top:6px;font:650 11.5px/1.25 var(--sans);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .hsub b{color:var(--text);font-weight:750}
#vts-root .side{display:inline-block;padding:3px 5px;border-radius:4px;border:1px solid currentColor;font:800 9.5px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase}
#vts-root .side.pos{background:var(--buy-bg)}#vts-root .side.neg{background:var(--sell-bg)}
/* mini trend lines: buy share over 60s (left), MC since the alert (right); hidden under 3 points */
#vts-root .spark{position:relative;width:100%;height:26px;margin-top:17px;color:var(--muted)}
#vts-root .spark.pos{color:var(--buy)}#vts-root .spark.neg{color:var(--sell)}#vts-root .spark.mix{color:var(--wait)}
#vts-root .spark .plot{position:absolute;left:0;top:0;bottom:0;right:0}
#vts-root .spark.r .plot{right:34px}
#vts-root .spark svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
#vts-root .spark .ln{fill:none;stroke:currentColor;stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
#vts-root .spark .ar{fill:currentColor;opacity:.12;stroke:none}
#vts-root .spark .ref{stroke:var(--dim);stroke-width:1;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
#vts-root .spark .end{position:absolute;left:var(--x,100%);top:var(--y,50%);width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:currentColor;box-shadow:0 0 0 2px var(--card)}
#vts-root .spark .cap{position:absolute;top:-14px;font:700 9.5px/1 var(--mono);letter-spacing:.04em;color:var(--muted);white-space:nowrap}
#vts-root .spark .cap.l{left:0}
#vts-root .spark .pk{left:var(--px,50%);transform:translateX(-50%);color:var(--text)}
#vts-root .spark .cl{right:0;top:var(--cy,50%);transform:translateY(-50%);padding:2px 3px;border:1px dashed var(--line3);border-radius:3px;background:var(--card);font-size:8.5px;letter-spacing:.06em;color:var(--muted)}
#vts-root .spark .cl:empty{display:none}
#vts-root .spark.none svg,#vts-root .spark.none .end,#vts-root .spark.none .cl{display:none}
#vts-root .score.nospark .spark{display:none}
#vts-root .meter{position:relative;display:grid;grid-template-columns:repeat(20,minmax(0,1fr));gap:3px;height:18px;margin:8px 12px 0}
#vts-root .meter i{border-radius:2px;background:var(--sell);opacity:.78}
#vts-root .meter i.on{background:var(--buy);opacity:1}
#vts-root .meter.empty i{background:var(--line2);opacity:1}
#vts-root .meter::after{content:"";position:absolute;left:50%;top:-5px;bottom:-5px;width:2px;margin-left:-1px;background:var(--text);border-radius:1px;box-shadow:0 0 0 2px var(--card)}
#vts-root .scale{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 8px;padding:7px 12px 10px;font:750 11.5px/1.25 var(--sans);font-variant-numeric:tabular-nums}
#vts-root .scale .b{color:var(--buy);white-space:nowrap}
#vts-root .scale .s{color:var(--sell);white-space:nowrap;text-align:right}
#vts-root .scale [data-vts=basis]{flex:1 1 0;min-width:0;text-align:center;font:500 11px/1.25 var(--sans);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ---------- LIVE · grade + bots pair, KPIs, late checks ---------- */
#vts-root .pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;margin-top:6px}
#vts-root .cell,#vts-root .kpi{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px 8px}
#vts-root .grade .gb{display:flex;align-items:center;gap:9px;margin-top:7px;min-width:0}
#vts-root .grade .gl{flex:none;display:grid;place-items:center;width:38px;height:38px;border-radius:7px;border:2px solid var(--line2);font:900 22px/1 var(--sans);color:var(--text)}
#vts-root .grade .gt{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}
#vts-root .grade strong{font:800 14px/1.1 var(--sans);font-variant-numeric:tabular-nums;white-space:nowrap}
#vts-root .grade .gn{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
#vts-root .grade.g-a .gl{background:var(--buy);border-color:var(--buy);color:var(--buy-ink)}
#vts-root .grade.g-b .gl{border-color:var(--lime);color:var(--lime)}
#vts-root .grade.g-c .gl{border-color:var(--warn);color:var(--warn)}
#vts-root .grade.g-d .gl{border-color:var(--sell);color:var(--sell)}
#vts-root .grade.g-clean .gl{border-color:var(--buy);color:var(--buy)}
#vts-root .grade.g-clean strong{color:var(--buy)}
#vts-root .grade.g-risky .gl{border-color:var(--warn);color:var(--warn);background:var(--warn-bg)}
#vts-root .grade.g-risky strong{color:var(--warn)}
#vts-root .grade.g-avoid{border-color:var(--sell);background:var(--sell-bg)}
#vts-root .grade.g-avoid .gl{background:var(--sell);border-color:var(--sell);color:var(--sell-ink)}
#vts-root .grade.g-avoid strong{color:var(--sell)}
#vts-root .grade.unproven .gl,#vts-root .grade.few .gl,#vts-root .grade.none .gl{background:transparent;border:2px dashed var(--line3);color:var(--muted)}
#vts-root .grade.few .gl,#vts-root .grade.none .gl{color:var(--dim)}
#vts-root .grade.unproven .gn,#vts-root .grade.few .gn{padding:3px 5px;border:1px dashed var(--line3);border-radius:4px;font:800 9.5px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase}
#vts-root .grade.none strong{color:var(--muted);font-size:12.5px}
#vts-root .bots .bv{display:flex;align-items:baseline;gap:5px;margin-top:6px;white-space:nowrap;min-width:0}
#vts-root .bots .bv b{font:850 20px/1 var(--sans);font-variant-numeric:tabular-nums}
#vts-root .bots .bv .muted{font-size:11.5px}
#vts-root .bots .bv .tag{margin-left:auto;align-self:center}
#vts-root .bots.na .bv .muted{display:none}
#vts-root .bots .bar{display:flex;height:8px;margin-top:7px;border-radius:3px;overflow:hidden;background:#5f7694}
#vts-root .bots .bar i{display:block;width:var(--p,0%);background:repeating-linear-gradient(135deg,var(--warn) 0 4px,#5c470f 4px 7px)}
#vts-root .bots.low .bar i{background:repeating-linear-gradient(135deg,#8c99a8 0 4px,#3a4553 4px 7px)}
#vts-root .bots.high .bar i{background:repeating-linear-gradient(135deg,var(--sell) 0 4px,#5a1620 4px 7px)}
#vts-root .bots.na .bar{background:repeating-linear-gradient(90deg,var(--line2) 0 6px,transparent 6px 10px)}
#vts-root .bots small{display:block;margin-top:6px;font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .bots small b{color:var(--text);font-weight:800}
#vts-root .kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:6px}
#vts-root .kpi b{display:block;margin:4px 0 2px;font:850 20px/1.1 var(--sans);font-variant-numeric:tabular-nums;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .kpi b .i{width:.62em;height:.62em;margin-right:3px;vertical-align:.04em}
#vts-root .kpi small{display:block;font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .kpi.na b{color:var(--dim)}
#vts-root .rug{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
#vts-root .rug:empty{display:none}
#vts-root .rug .kpi b{font-size:18px}
#vts-root .rug .kpi.over{border-color:var(--warn-line);background:var(--warn-bg)}
#vts-root .rug .kpi.over b{color:var(--warn)}
#vts-root .rug .kpi.bad{border-color:var(--sell);background:var(--sell-bg)}
#vts-root .rug .kpi.bad b{color:var(--sell)}
#vts-root .rugbox .note{margin:6px 0 0}
#vts-root .ins{margin:0 0 6px;padding:7px 10px 8px;border:1px solid var(--line2);border-radius:8px;background:var(--card)}
#vts-root .ins .row1{display:flex;align-items:baseline;gap:8px;min-width:0}
#vts-root .ins .row1 .lbl{flex:none}
#vts-root .ins .row1 b{flex:none;font:850 18px/1.1 var(--sans);font-variant-numeric:tabular-nums}
#vts-root .ins .roles{min-width:0;font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .ins.over{border-color:var(--warn-line);background:var(--warn-bg)}
#vts-root .ins.over .row1 b{color:var(--warn)}
#vts-root .ins.bad{border-color:var(--sell);background:var(--sell-bg)}
#vts-root .ins.bad .row1 b{color:var(--sell)}
#vts-root .ins .exit{margin-top:5px;font-size:11.5px;line-height:1.35;color:var(--muted)}
#vts-root .ins .exit.warn{color:var(--warn);font-weight:700}
#vts-root .ins .exit.bad{color:var(--sell);font-weight:800}
#vts-root .ins .exit.bad::before{content:"\25BC  "}
#vts-root .checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
#vts-root .ck.wide{grid-column:1/-1}
#vts-root .ck.wide b{max-width:75%}
#vts-root .ckh{grid-column:1/-1;margin:4px 0 0;font:700 10.5px/1.2 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
#vts-root .parts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin:6px 0 0}
#vts-root .parts[hidden]{display:none}
#vts-root .pt{min-width:0;padding:5px 7px 6px;border:1px solid var(--line);border-radius:7px;background:var(--card)}
#vts-root .pt .lbl{display:block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
#vts-root .pt b{display:block;font:850 16px/1.15 var(--sans);font-variant-numeric:tabular-nums}
#vts-root .pt small{display:block;font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .pt.ok b{color:var(--buy)}
#vts-root .pt.warn{border-color:var(--warn-line)}
#vts-root .pt.warn b{color:var(--warn)}
#vts-root .pt.bad{border-color:var(--sell-line);background:var(--sell-bg)}
#vts-root .pt.bad b{color:var(--sell)}
#vts-root .pt.conf.high b{color:var(--buy)}
#vts-root .pt.conf.medium b{color:var(--warn)}
#vts-root .pt.conf.low{border-color:var(--sell-line)}
#vts-root .pt.conf.low b{color:var(--sell)}
#vts-root .rcbox{margin:6px 0 0}
#vts-root .speed{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:2px 12px;font-size:11.5px;font-variant-numeric:tabular-nums}
#vts-root .speed .h{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
#vts-root .speed span:not(.l):not(.h){text-align:right}
#vts-root .rcbox summary{cursor:pointer;font-size:11.5px;color:var(--muted)}
#vts-root .rcbox li.dim{opacity:.55}
#vts-root .checks:empty{display:none}
#vts-root .ck{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 7px;border:1px solid var(--line);border-radius:6px;background:var(--card);font-size:11.5px;line-height:1.2}
#vts-root .ck i{flex:none;width:12px;text-align:center;font:900 12px/1 var(--sans)}
#vts-root .ck span{flex:1 1 auto;min-width:0;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .ck b{flex:0 1 auto;min-width:0;max-width:60%;font-weight:750;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .ck.pass i{color:var(--buy)}
#vts-root .ck.warn{border-color:var(--warn-line)}
#vts-root .ck.warn i,#vts-root .ck.warn b{color:var(--warn)}
#vts-root .ck.fail{border-color:var(--sell-line);background:var(--sell-bg)}
#vts-root .ck.fail i,#vts-root .ck.fail b{color:var(--sell)}
#vts-root .ck.na{opacity:.55}
#vts-root .ck.info i{color:var(--dim)}
#vts-root .ck.na i{color:var(--dim)}
#vts-root .rugbox .buttons{margin:6px 0 0}
#vts-root .late-chips{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;margin-top:6px}
#vts-root .lc{position:relative;min-width:0;display:flex;flex-direction:column;gap:5px;padding:7px 10px 8px;border-radius:8px;border:1px solid var(--line2);background:var(--card);overflow:hidden;white-space:nowrap}
#vts-root .lc .v{font:850 14.5px/1.1 var(--sans);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
#vts-root .lc.pend{border-style:dashed;background:transparent}
#vts-root .lc.pend .v{font:750 14.5px/1.1 var(--mono);color:var(--accent)}
#vts-root .lc.pend .v.muted{color:var(--muted)}
#vts-root .lc .prog{position:absolute;left:0;bottom:0;height:2px;width:var(--p,0%);background:var(--accent);opacity:.8}
#vts-root .lc.g-buy{background:var(--buy-bg);border-color:var(--buy-line);color:var(--buy)}
#vts-root .lc.g-fade{background:var(--sell);border-color:var(--sell);color:var(--sell-ink)}
#vts-root .lc.g-wait{border-color:var(--warn-line);color:var(--warn)}
#vts-root .lc.g-dead{border-color:var(--line2);color:var(--muted)}
#vts-root .lc.g-fade .lbl{color:inherit;opacity:.8}
#vts-root .lc.g-buy .v::before{content:"\25B2  "}
#vts-root .lc.g-wait .v::before{content:"\2016  "}
#vts-root .lc.g-fade .v::before{content:"\25BC  "}
#vts-root .lc.g-dead .v::before{content:"\2715  "}

/* ---------- LIVE · flags ---------- */
#vts-root .flags{list-style:none;display:grid;gap:4px;margin:8px 0 0;padding:0}
#vts-root .flags li{display:flex;gap:8px;align-items:flex-start;margin:0;padding:6px 8px;border-radius:7px;background:var(--warn-bg);border:1px solid #3a3013;font-size:12.5px;line-height:1.35;color:var(--text)}
#vts-root .flags li::before{content:"FLAG";flex:none;margin-top:1px;padding:3px 5px;border-radius:3px;background:var(--warn);color:var(--warn-ink);font:850 9.5px/1 var(--mono);letter-spacing:.08em}
#vts-root .flags li.risk{background:var(--sell-bg);border-color:#4d1c24}
#vts-root .flags li.risk::before{content:"RISK";background:var(--sell);color:var(--sell-ink)}
#vts-root .flags:empty,#vts-root .strip:empty,#vts-root .feed:empty,#vts-root .late-chips:empty,#vts-root .kpis:empty,#vts-root .mtop:empty,#vts-root .mkt:empty,#vts-root .btp:empty{display:none}

/* ---------- LIVE · below the fold ---------- */
#vts-root .sect{display:flex;align-items:center;gap:8px;margin:14px 0 6px}
#vts-root .sect::after{content:"";order:1;flex:1;height:1px;background:var(--line)}
#vts-root .sect .lbl+.lbl{order:2;color:var(--dim)}
#vts-root .flow{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr) minmax(0,1fr);border:1px solid var(--line);border-radius:8px;background:var(--card);overflow:hidden}
#vts-root .flow>*{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;font:750 13px/1.25 var(--sans);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .flow .h{background:var(--bg2);font:750 10px/1.25 var(--mono);letter-spacing:.09em;color:var(--muted);text-transform:uppercase}
#vts-root .flow .l{text-align:left;font:600 12px/1.25 var(--sans);color:var(--muted)}
#vts-root .flow .ft{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:2px 12px;border-bottom:0;text-align:left;font:500 11.5px/1.4 var(--sans);color:var(--muted);white-space:normal}
#vts-root .flow .ft b{color:var(--text);font-weight:750}
#vts-root .flow sup,#vts-root .mkt sup{font:800 10px/0 var(--mono);color:var(--dim);margin-left:1px}
#vts-root .rb{display:inline-block;width:30px;height:5px;margin-right:6px;border-radius:3px;vertical-align:.12em;background:linear-gradient(90deg,var(--buy) 0 var(--p,50%),var(--sell) var(--p,50%) 100%)}
#vts-root .strip{display:flex;width:100%;justify-content:flex-start;flex-wrap:wrap;gap:4px 10px;margin-top:10px;padding:8px 10px;background:var(--card);border:1px solid var(--line);border-radius:8px;font-size:11.5px;font-weight:500;color:var(--muted);text-align:left;white-space:normal}
#vts-root .strip span{white-space:nowrap}
#vts-root .strip b{color:var(--text);font-weight:750}
#vts-root .strip::before{content:"MARKET 5M";font:700 10.5px/1.5 var(--mono);letter-spacing:.09em}
#vts-root .strip::after{content:"\203A";margin-left:auto;color:var(--accent);font-weight:800}
#vts-root .buttons{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
#vts-root .buttons.two>button{flex:1 1 0;min-width:0}
#vts-root .feed{display:flex;flex-wrap:wrap;gap:2px 10px;margin:2px 0 0;font-size:11.5px;color:var(--muted)}
#vts-root .feed span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
#vts-root .feed .dot{width:6px;height:6px}
#vts-root details{margin-top:8px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
#vts-root summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:9px 10px;font:750 10.5px/1.2 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
#vts-root summary::-webkit-details-marker{display:none}
#vts-root summary::after{content:"+";margin-left:auto;font:700 15px/1 var(--mono);color:var(--muted)}
#vts-root details[open] summary::after{content:"\2212"}
#vts-root details[open] summary{border-bottom:1px solid var(--line)}
#vts-root details>:not(summary){margin-left:10px;margin-right:10px}
#vts-root details ul{margin-top:8px;margin-bottom:6px;padding-left:16px}
#vts-root details li{margin:4px 0;font-size:12.5px;line-height:1.4}
#vts-root details .buttons{margin-bottom:4px}
#vts-root .note{color:var(--muted);font-size:11.5px;line-height:1.45}
#vts-root .note b{color:var(--text)}
#vts-root .result{margin:6px 10px 10px;padding:8px 10px;border-radius:7px;background:var(--well);border:1px solid var(--line2);font-size:12.5px}
#vts-root .result:empty{display:none}

/* ---------- forms (Recover initials, Calls) ---------- */
#vts-root .field{display:block;margin:10px 0 0}
#vts-root .field>.lbl,#vts-root .grid2 .lbl,#vts-root .grid3 .lbl{display:block;margin-bottom:5px}
#vts-root .inline{display:flex;gap:6px}
#vts-root .inline input{flex:1;min-width:0}
#vts-root .grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px}
#vts-root .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
#vts-root .grid2 label,#vts-root .grid3 label{display:block;min-width:0}
#vts-root .pct{position:relative;display:block}
#vts-root .pct input{padding-right:24px}
#vts-root .pct::after{content:"%";position:absolute;right:9px;top:50%;transform:translateY(-50%);color:var(--muted);font-weight:700;pointer-events:none}

/* ---------- MARKET ---------- */
#vts-root .mhead{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 8px;margin-bottom:8px}
#vts-root .pill{display:inline-flex;align-items:center;gap:6px;flex:none;min-width:0;max-width:100%;padding:5px 9px;border-radius:999px;border:1px solid var(--line2);font:650 11.5px/1 var(--sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .pill::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--dim)}
#vts-root .pill.ok::before{background:var(--buy)}#vts-root .pill.warn::before{background:var(--warn)}#vts-root .pill.bad::before{background:var(--sell)}
#vts-root .mtop{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-bottom:8px}
#vts-root .mtop .kpi b{font-size:22px}
#vts-root .mkt{display:grid;grid-template-columns:minmax(0,1.3fr) repeat(4,minmax(0,1fr));margin:0;border:1px solid var(--line2);border-radius:10px;overflow:hidden;background:var(--card)}
#vts-root .mkt>*{padding:9px 8px;text-align:right;border-bottom:1px solid var(--line);font:800 14px/1.1 var(--sans);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#vts-root .mkt>:nth-last-child(-n+5){border-bottom:0}
#vts-root .mkt .h{background:var(--bg2);font:750 10.5px/1.1 var(--mono);letter-spacing:.09em;color:var(--muted);text-transform:uppercase}
#vts-root .mkt .l{text-align:left;font:600 12.5px/1.1 var(--sans);color:var(--muted)}
#vts-root .mkt .hl{background:#122030}
#vts-root .mkt .h.hl{color:var(--text);box-shadow:inset 0 -2px 0 var(--accent)}

/* ---------- CALLS ---------- */
#vts-root .recv{display:flex;align-items:center;gap:8px;margin:0 0 4px;padding:8px 10px;border-radius:8px;font-size:12.5px;line-height:1.35;color:var(--text);background:var(--card);border:1px solid var(--line2)}
#vts-root .recv::before{content:"!";flex:none;display:grid;place-items:center;width:18px;height:18px;border-radius:50%;font:900 11px/1 var(--sans);background:var(--warn);color:var(--warn-ink)}
#vts-root .recv.ok{background:var(--buy-bg);border-color:var(--buy-line)}
#vts-root .recv.ok::before{content:"\2713";background:var(--buy);color:var(--buy-ink)}
#vts-root .mkt.late{grid-template-columns:minmax(0,1fr) 46px repeat(2,minmax(0,1.08fr))}
#vts-root .mkt.late>*{display:flex;align-items:center;justify-content:flex-end;min-height:34px;padding:7px;font:650 12.5px/1.1 var(--sans)}
#vts-root .mkt.late .h{min-height:28px;font:750 10.5px/1.1 var(--mono)}
#vts-root .mkt.late .l{justify-content:flex-start}
#vts-root .mkt.late .go{justify-content:flex-start;color:var(--text);font-weight:750;cursor:pointer}
#vts-root .mkt.late .go:hover{text-decoration:underline}
#vts-root .mkt.late .pend{color:var(--muted);font:650 11.5px/1 var(--mono)}
#vts-root .gp{display:inline-flex;align-items:center;gap:4px;padding:3px 5px;border-radius:5px;border:1px solid transparent;font:850 11.5px/1 var(--sans);font-variant-numeric:tabular-nums;white-space:nowrap}
#vts-root .gp::before{font-size:.85em}
#vts-root .gp.buy{background:var(--buy-bg);border-color:var(--buy-line);color:var(--buy)}
#vts-root .gp.buy::before{content:"\25B2"}
#vts-root .gp.fade{background:var(--sell);border-color:var(--sell);color:var(--sell-ink)}
#vts-root .gp.fade::before{content:"\25BC"}
#vts-root .gp.wait{border-color:var(--warn-line);color:var(--warn)}
#vts-root .gp.wait::before{content:"\2016"}
#vts-root .gp.dead{border-color:var(--line2);color:var(--muted)}
#vts-root .gp.dead::before{content:"\2715"}
#vts-root .legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin:8px 0 2px;font-size:11px;color:var(--muted)}
#vts-root .legend span{display:inline-flex;align-items:center;gap:5px}
#vts-root .btp{margin-top:10px}
#vts-root .btp .bar{display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;background:var(--line)}
#vts-root .btp .bar i{flex:var(--n,0) 1 0;min-width:0;background:var(--line3)}
#vts-root .btp .bar i.ok,#vts-root .btp .k.ok::before{background:var(--accent)}
#vts-root .btp .bar i.none,#vts-root .btp .k.none::before{background:#5a6879}
#vts-root .btp .bar i.left,#vts-root .btp .k.left::before{background:var(--wait)}
#vts-root .btp .bar i.young,#vts-root .btp .k.young::before{background:var(--line3)}
#vts-root .btp .keys{display:flex;flex-wrap:wrap;gap:3px 12px;margin-top:6px;font-size:11px;color:var(--muted)}
#vts-root .btp .k{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
#vts-root .btp .k::before{content:"";width:8px;height:8px;border-radius:2px}
#vts-root .btp .k b{color:var(--text)}
#vts-root .bt-status{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--card);border:1px solid var(--line);font-size:11.5px;color:var(--muted);line-height:1.45}
#vts-root .bt-status:empty{display:none}

/* ---------- SETTINGS ---------- */
#vts-root .set{display:grid}
#vts-root label.check{display:flex;align-items:center;gap:12px;margin:0;padding:9px 0;border-bottom:1px solid var(--line);cursor:pointer;color:var(--text)}
#vts-root label.check>span{flex:1;min-width:0}
#vts-root label.check b{display:block;font:700 13px/1.25 var(--sans)}
#vts-root label.check small{display:block;margin-top:2px;font-size:11.5px;line-height:1.35;color:var(--muted)}

/* ---------- narrow panels (340-372px) ---------- */
@container vts (max-width:372px){
  #vts-root .vts-body{padding:10px 10px 12px}
  #vts-root .band{gap:7px;padding-right:6px}
  #vts-root .clock{padding:4px 6px 5px}
  #vts-root .clock b{font-size:16.5px;gap:4px}
  #vts-root .clock b .i{width:11px;height:11px}
  #vts-root .score{column-gap:10px;padding:10px 10px 6px}
  #vts-root .meter{margin:8px 10px 0;gap:2px}
  #vts-root .scale{padding:7px 10px 9px}
  #vts-root .scale [data-vts=basis]{order:3;flex-basis:100%}
  #vts-root .cell,#vts-root .kpi,#vts-root .lc{padding-left:8px;padding-right:8px}
  #vts-root .kpi .lbl,#vts-root .cell .lbl,#vts-root .lc .lbl{letter-spacing:.04em}
  #vts-root .grade .gb{gap:7px}
  #vts-root .grade .gl{width:34px;height:34px;font-size:20px}
  #vts-root .bots .bv b,#vts-root .kpi b{font-size:18px}
  #vts-root .flow>*{padding:6px 8px}
  #vts-root .mkt>*{padding:8px 6px;font-size:13px}
  #vts-root .mtop .kpi b{font-size:19px}
  #vts-root .mkt.late>*{padding:7px 5px;font-size:12px}
  #vts-root .gp{padding:3px 4px;font-size:11px}
  #vts-root.vts-collapsed .mini{gap:10px}
  #vts-root.vts-collapsed .m-state{min-width:0;padding:0 10px;font-size:12.5px;gap:6px}
  #vts-root.vts-collapsed[data-tone=caution] .m-state{padding-left:16px}
  #vts-root.vts-collapsed .m-read{max-width:84px}
  #vts-root.vts-collapsed .m-share{font-size:24px}
  #vts-root .m-share small{display:none}
  #vts-root.vts-collapsed .m-since{font-size:15px}
}

/* ---------- one-shot flash on a new call or a state change (never loops) ----------
   JS: el.classList.add('flash'); setTimeout(()=>el.classList.remove('flash'),1200)
   on .band and .m-state. Use the timeout, not animationend: with reduced motion
   there is no animation, so animationend never fires. */
@media (prefers-reduced-motion:no-preference){
  #vts-root .flash{animation:vts-flash .9s ease-out 1}
  @keyframes vts-flash{0%{box-shadow:inset 0 0 0 2px var(--text),0 0 0 3px var(--tone);filter:brightness(1.55)}100%{filter:none}}
}
@media (prefers-reduced-motion:reduce){
  #vts-root .flash{outline:2px solid var(--text);outline-offset:-2px}
}
/* review fixes: late pills ellipsis instead of clipping; setup note wraps; 4-column late grid keeps its row borders */
#vts-root .mkt.late .gp{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis}
#vts-root .grade .gn{white-space:normal;line-height:1.3}
#vts-root .grade strong{max-width:100%;overflow:hidden;text-overflow:ellipsis}
#vts-root .mkt.late>:nth-last-child(5){border-bottom:1px solid var(--line)}`;
const PANEL_HTML = String.raw`<svg class="vts-sprite" aria-hidden="true" focusable="false">
<symbol id="vts-i-up" viewBox="0 0 16 16"><path d="M8 2.2 15.2 13.8H.8z"/></symbol>
<symbol id="vts-i-down" viewBox="0 0 16 16"><path d="M8 13.8.8 2.2h14.4z"/></symbol>
<symbol id="vts-i-warn" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 .9 15.7 14.8H.3zM7.1 5.4h1.8v4.9H7.1zm0 6.1h1.8v1.8H7.1z"/></symbol>
<symbol id="vts-i-pause" viewBox="0 0 16 16"><path d="M3 2.4h3.6v11.2H3zm6.4 0H13v11.2H9.4z"/></symbol>
<symbol id="vts-i-unk" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 .8a7.2 7.2 0 1 1 0 14.4A7.2 7.2 0 0 1 8 .8zm0 1.7a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"/><path d="M7.1 10.4h1.8v1.8H7.1zM5.3 6.4a2.7 2.7 0 1 1 4.1 2.3c-.5.3-.6.5-.6 1v.2H7.2v-.4c0-1 .4-1.5 1.1-1.9.4-.3.6-.5.6-.9a.9.9 0 0 0-1.8 0z"/></symbol>
<symbol id="vts-i-clock" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 .8a7.2 7.2 0 1 1 0 14.4A7.2 7.2 0 0 1 8 .8zm0 1.8a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6z"/><path d="M7.1 4h1.8v3.5l2.7 1.6-.9 1.5-3.6-2.1z"/></symbol>
<symbol id="vts-i-copy" viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M5.6 5.6h7.8v7.8H5.6zM10.4 5.6V2.6H2.6v7.8h3"/></symbol>
<symbol id="vts-i-refresh" viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M13.1 8.6A5.2 5.2 0 1 1 11.4 4"/><path d="M14.2 1.4v5H9.2z"/></symbol>
<symbol id="vts-i-bolt" viewBox="0 0 16 16"><path d="M9.8.6 2.6 9.3h4.6L6.2 15.4l7.2-8.7H8.8z"/></symbol>
<symbol id="vts-i-grip" viewBox="0 0 10 16"><path d="M2 2h2.2v2.2H2zm4 0h2.2v2.2H6zM2 6.9h2.2v2.2H2zm4 0h2.2v2.2H6zM2 11.8h2.2V14H2zm4 0h2.2V14H6z"/></symbol>
<symbol id="vts-i-min" viewBox="0 0 16 16"><path d="M3 7.1h10v1.8H3z"/></symbol>
<symbol id="vts-i-plus" viewBox="0 0 16 16"><path d="M7.1 3h1.8v4.1H13v1.8H8.9V13H7.1V8.9H3V7.1h4.1z"/></symbol>
</svg>
<header>
  <svg class="i grip" aria-hidden="true"><use href="#vts-i-grip"/></svg>
  <span class="brand"><svg class="i" aria-hidden="true"><use href="#vts-i-bolt"/></svg><b>VOLTRAK</b></span>
  <span class="mini" data-vts="mini">
    <b class="m-state"><span class="ti" aria-hidden="true"><svg class="i t-buy" aria-hidden="true"><use href="#vts-i-up"/></svg><svg class="i t-sell" aria-hidden="true"><use href="#vts-i-down"/></svg><svg class="i t-caution" aria-hidden="true"><use href="#vts-i-warn"/></svg><svg class="i t-wait" aria-hidden="true"><use href="#vts-i-pause"/></svg><svg class="i t-unk" aria-hidden="true"><use href="#vts-i-unk"/></svg></span><span data-vts="mini-state">No data</span></b>
    <span class="m-read"><span class="m-sym" data-vts="mini-sym"></span><b class="m-share" data-vts="mini-share">—<small>no data</small></b></span>
    <span class="m-since"><svg class="i" aria-hidden="true"><use href="#vts-i-clock"/></svg><span data-vts="mini-since">—</span></span>
    <span class="m-text" data-vts="mini-text"></span>
    <i class="m-bar empty" data-vts="mini-bar"></i>
  </span>
  <button class="hbtn" data-vts="collapse" title="Collapse to the scoreboard (Alt+V hides the panel)"><svg class="i ic-min" aria-hidden="true"><use href="#vts-i-min"/></svg><svg class="i ic-max" aria-hidden="true"><use href="#vts-i-plus"/></svg></button>
</header>
<nav class="tabs" data-vts="tabs"><button data-tab="live" class="on">Live</button><button data-tab="market">Market</button><button data-tab="calls">Calls<span class="badge" data-vts="calls-badge" hidden></span></button><button data-tab="settings">Settings</button></nav>
<div class="vts-body">
<section data-pane="live"><div data-vts="gmgn">
  <div class="ident">
    <div class="nm"><h3 data-vts="token">Open a Solana token</h3><span class="sym" data-vts="symbol"></span></div>
    <div class="venue"><button class="mint" data-vts="mint-copy" title="Copy contract address" hidden><span data-vts="mint"></span><svg class="i" aria-hidden="true"><use href="#vts-i-copy"/></svg></button><span class="vtags" data-vts="venue"></span></div>
  </div>
  <div class="hero">
    <div class="band"><span class="ti" aria-hidden="true"><svg class="i t-buy" aria-hidden="true"><use href="#vts-i-up"/></svg><svg class="i t-sell" aria-hidden="true"><use href="#vts-i-down"/></svg><svg class="i t-caution" aria-hidden="true"><use href="#vts-i-warn"/></svg><svg class="i t-wait" aria-hidden="true"><use href="#vts-i-pause"/></svg><svg class="i t-unk" aria-hidden="true"><use href="#vts-i-unk"/></svg></span><span class="bt"><span data-vts="state">Unknown</span><span class="sub"><b class="fresh" data-vts="fresh" hidden></b><span data-vts="momentum"></span><span data-vts="state-why" hidden></span></span></span><span class="clock" data-vts="clock" title="time since the alert"><span class="lbl">Since alert</span><b><svg class="i" aria-hidden="true"><use href="#vts-i-clock"/></svg><span data-vts="since">—</span></b></span></div>
    <div class="score">
      <span class="lbl">Buy share</span><span class="lbl r">vs call MC</span>
      <b class="big na" data-vts="share">—</b><b class="big r na" data-vts="move">—</b>
      <span class="hsub"><span class="side" data-vts="side" hidden></span></span><span class="hsub r" data-vts="mc-line">no call MC</span>
      <div class="spark none" data-vts="share-spark" title="Buy share over the last 60s; dotted line = 50%"><div class="plot"><svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polygon class="ar" points=""/><line class="ref" x1="0" y1="12" x2="100" y2="12"/><polyline class="ln" points=""/></svg><i class="end"></i></div><span class="cap l"></span></div><div class="spark r none" data-vts="mc-spark" title="Market cap since the alert; dashed line = call MC"><div class="plot"><svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polygon class="ar" points=""/><line class="ref" x1="0" y1="12" x2="100" y2="12"/><polyline class="ln" points=""/></svg><i class="end"></i><span class="cap pk"></span></div><span class="cap cl"></span></div>
    </div>
    <div class="meter empty" data-vts="meter" role="meter" aria-label="Buy share" aria-valuemin="0" aria-valuemax="100"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <div class="scale"><span class="b" data-vts="split-buy"></span><span data-vts="basis" title="">no data yet</span><span class="s" data-vts="split-sell"></span></div>
  </div>
  <div class="pair">
    <div class="cell grade none" data-vts="grade" title="Coin grade from the live checks"><span class="lbl">Coin grade</span><div class="gb"><b class="gl" data-vts="grade-letter">—</b><span class="gt"><strong data-vts="grade-text">No grade</strong><span class="gn" data-vts="grade-note">no rug check yet</span></span></div></div>
    <div class="cell bots na" data-vts="vol-bots" title="Share of the last 5 min of trades (and of dollar volume) from bot wallets"><span class="lbl">Volume bots</span><div class="bv"><b data-vts="bots-pct">—</b><span class="muted">of 5m trades</span><span class="tag" data-vts="bots-level">No data</span></div><div class="bar"><i data-vts="bots-bar"></i></div><small data-vts="bots-org">needs GMGN live trades</small></div>
  </div>
  <div class="parts" data-vts="parts" hidden></div>
  <div class="rugbox" data-vts="rug" hidden><div class="sect"><span class="lbl">Checks</span><span class="lbl" data-vts="rug-src">untested</span></div><div class="ins" data-vts="ins" hidden></div><div class="checks" data-vts="rug-cells"></div><p class="note" data-vts="rug-note"></p><details class="rcbox" data-vts="rc" hidden><summary>RugCheck</summary><ul class="flags"></ul></details><div class="buttons" data-vts="rug-row" hidden><button data-vts="rug-check">Check this coin</button></div></div>
  <div class="kpis" data-vts="kpis"></div>
  <div class="late-chips" data-vts="late-chips"></div>
  <ul class="flags" data-vts="risks"></ul>
  <div class="sect"><span class="lbl">Flow</span><span class="lbl" data-vts="flow-src">GMGN live</span></div>
  <div class="flow" data-vts="metrics"></div>
  <button class="strip" data-vts="market-strip" title="Open the Market tab"></button>
  <div class="buttons two"><button data-vts="refresh"><svg class="i" aria-hidden="true"><use href="#vts-i-refresh"/></svg>Refresh</button><button data-vts="copy"><svg class="i" aria-hidden="true"><use href="#vts-i-copy"/></svg>Copy CA</button></div>
  <p class="feed" data-vts="feed"></p>
  <details><summary>Why this reading</summary><ul data-vts="reasons"></ul><p class="note" data-vts="missing"></p><p class="note">The state, gauge and grade are context, not buy or sell orders and not win probabilities. The backtest in the Calls tab shows what has actually worked.</p></details>
  <details><summary>Recover initials <kbd>Alt+I</kbd></summary><p class="note">GMGN has <b>Sell inits</b> in its Instant Trade tools; place the sale there. Enter all amounts in one currency.</p>
    <div class="grid2"><label><span class="lbl">Total buy cost</span><input data-vts="cost" type="number" min="0" step="any"></label><label><span class="lbl">Proceeds received</span><input data-vts="proceeds" type="number" min="0" step="any" value="0"></label><label><span class="lbl">Remaining bag value</span><input data-vts="bag" type="number" min="0" step="any"></label><label><span class="lbl">Fee / slippage %</span><input data-vts="fee" type="number" min="0" max="99" step="any" value="0"></label><label><span class="lbl">Fixed sale cost</span><input data-vts="fixed" type="number" min="0" step="any" value="0"></label></div>
    <div class="buttons"><button data-vts="initials">Calculate</button></div><p class="result" data-vts="initials-result"></p><p class="note">Nothing is submitted by this script.</p></details>
</div></section>
<section data-pane="market" hidden>
  <div class="mhead"><span class="lbl">pump.fun · market-wide</span><span class="pill" data-vts="market-status"></span></div>
  <div class="mtop" data-vts="market-top"></div>
  <div class="mkt" data-vts="market"></div>
  <p class="note" data-vts="market-note"></p>
</section>
<section data-pane="calls" hidden>
  <p class="recv" data-vts="discord" hidden><span data-vts="receiver"></span></p>
  <div class="sect"><span class="lbl">Late checks</span><span class="lbl">+10 / +30 min</span></div>
  <div data-vts="late"></div>
  <div class="legend"><span><b class="gp buy">ABOVE</b> at or above the call price</span><span><b class="gp wait">BELOW</b> down 0–30%</span><span><b class="gp fade">DOWN</b> down 30%+</span><span><b class="gp dead">NO TRADES</b> none for 5 min</span></div>
  <p class="note">What the price did, not a signal. The backtest report shows what buying at each check did on your past calls.</p>
  <div class="sect"><span class="lbl">Speed</span><span class="lbl">alert → each stage · last 20 calls</span></div>
  <div class="speed" data-vts="speed"></div>
  <div class="sect"><span class="lbl">Saved calls</span></div>
  <select data-vts="call-list"></select>
  <div class="buttons two"><button data-vts="open">Open on GMGN</button><button data-vts="export">Export data</button></div>
  <label class="field"><span class="lbl">Add a call · paste an alert or contract</span><span class="inline"><input data-vts="paste" placeholder="Contract or alert text"><button data-vts="import">Add</button></span></label>
  <div class="sect"><span class="lbl">Backtest</span><span class="lbl">GeckoTerminal 1m</span></div>
  <p class="note" data-vts="bt-help"></p>
  <div class="buttons" data-vts="history-row" hidden><button data-vts="bt-history">Load channel history</button></div>
  <div class="grid2 field"><label><span class="lbl">Early exit</span><select data-vts="bt-exit"><option value="0">Target / stop only</option><option value="5">Sell at 5 min if not up</option></select></label><label><span class="lbl">Fills</span><select data-vts="bt-fill"><option value="touch">At target / stop</option><option value="cautious">Cautious</option></select></label></div>
  <label class="field"><span class="lbl">Buy at</span><select data-vts="bt-delay"><option value="0">The alert</option><option value="1">1 min after the alert</option><option value="10">10 min after the alert</option><option value="30">30 min after the alert</option></select></label>
  <div class="grid3 field"><label><span class="lbl">Target</span><span class="pct"><input data-vts="bt-tp" type="number" min="1" step="any"></span></label><label><span class="lbl">Stop loss</span><span class="pct"><input data-vts="bt-sl" type="number" min="1" max="99" step="any"></span></label><label><span class="lbl">Costs</span><span class="pct"><input data-vts="bt-cost" type="number" min="0" step="any"></span></label></div>
  <div class="buttons two"><button class="primary" data-vts="bt-run">Score calls</button><button data-vts="bt-report">Open report</button></div>
  <div class="buttons"><button data-vts="hb-run">Add volume bots to past calls (Helius)</button></div>
  <div class="buttons"><button data-vts="rc-run">Add rug checks to past calls (Helius)</button></div>
  <div class="btp" data-vts="bt-progress"></div>
  <p class="bt-status" data-vts="bt-status"></p>
</section>
<section data-pane="settings" hidden>
  <div class="set">
    <label class="check"><span><b>Market feed</b><small>PumpPortal public socket: pump.fun launches and graduations (its trade stream now needs a paid key)</small></span><input type="checkbox" data-vts="market-on"></label>
    <label class="check"><span><b>GMGN token data</b><small>Holders, bundlers, snipers, insiders, real traders, dev launches: read from GMGN for the coin on screen</small></span><input type="checkbox" data-vts="gm-on"></label>
    <label class="check"><span><b>Exit cost quotes (Jupiter)</b><small>Every 15s: buy at your size, sell it back; the gap is fees plus price impact</small></span><input type="checkbox" data-vts="jup-on"></label>
    <label class="check"><span><b>RugCheck findings</b><small>Shown under the checks, never mixed into the score</small></span><input type="checkbox" data-vts="rc-on"></label>
    <label class="check"><span><b>GeckoTerminal fallback trades</b><small>Used when GMGN’s live feed is quiet</small></span><input type="checkbox" data-vts="trades"></label>
    <label class="check"><span><b>Voice alert on Discord</b><small>Speaks the token name when a call arrives</small></span><input type="checkbox" data-vts="sound"></label>
    <label class="check"><span><b>Alert when a call is still above its call price</b><small>Notification at +10 / +30 min. Not a buy signal; off by default</small></span><input type="checkbox" data-vts="late-alerts"></label>
  </div>
  <label class="field"><span class="lbl">Your trade size (SOL) · for the exit-cost quote</span><input data-vts="trade-sol" type="number" min="0.001" step="any"></label>
  <div class="sect"><span class="lbl">Data sources</span></div>
  <p class="note">Live: GMGN’s own page feed (token_activity, token_stat), read-only; nothing is sent on GMGN’s connection. Fallbacks: DEX Screener snapshots and GeckoTerminal trades when the live feed is quiet.</p>
  <p class="note">Market: PumpPortal’s public data socket (one connection, receiving GMGN tab only): launches and graduations. Volume bots: GMGN’s live trades for the coin on screen plus GMGN’s own wallet labels (wash trader, sandwich bot, trading app, trades per wallet), with the last 5 min loaded from GMGN’s trades list when a coin opens.</p>
  <p class="note">Checks: GMGN’s own token data for the coin on screen (holders, bundlers, snipers, insiders, real traders, dev launches; read from the GMGN page every 5s for a new coin’s first 3 min, then every 15s), plus the chain checks from your Helius key. Dev and insider sells come from GMGN’s live trade feed the moment they happen.</p>
  <p class="note">Exit cost: Jupiter’s public quote API, every 15s for the coin on screen (buy at your trade size, sell it back). RugCheck: its public report summary, once per coin every 5 min, shown as its own findings. Both are read-only lookups by mint.</p>
  <div class="sect"><span class="lbl">Helius · optional</span></div>
  <label class="field"><span class="lbl">Helius API key (or a full RPC URL)</span><span class="inline"><input data-vts="rpc-key" type="password" placeholder="free key from helius.dev" autocomplete="new-password" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore><button data-vts="rpc-save">Save</button></span></label>
  <div class="buttons two"><button data-vts="rpc-test">Test key</button><button data-vts="rpc-remove">Remove key</button></div>
  <div class="buttons"><button data-vts="rpc-sample" hidden>Copy sample transaction</button></div>
  <p class="note" data-vts="rpc-status">Powers the live rug checks (dev wallet, top 10, launch block, dev funder) and lets the backtest add volume bots and rug checks to past calls. Free plan: 1M credits a month; a rug check uses about 20–250, a past call's volume bots about 10–300. The key stays in this browser.</p>
  <div class="sect"><span class="lbl">Telegram · optional</span></div>
  <div class="set">
    <label class="check"><span><b>Ping my phone on new calls</b><small>One message per call; it updates with the rug checks when they finish</small></span><input type="checkbox" data-vts="tg-on"></label>
    <label class="check"><span><b>Ping when the dev sells</b><small>For a call open on GMGN: the first dev sale, and when the dev is fully out</small></span><input type="checkbox" data-vts="tg-dev"></label>
  </div>
  <label class="field"><span class="lbl">Bot token (from @BotFather)</span><span class="inline"><input data-vts="tg-token" type="password" placeholder="123456:ABC…" autocomplete="new-password" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore><button data-vts="tg-save">Save</button></span></label>
  <div class="buttons two"><button data-vts="tg-find">Find my chat ID</button><button data-vts="tg-test">Send test</button></div>
  <div class="buttons"><button data-vts="tg-remove">Remove Telegram</button></div>
  <p class="note" data-vts="tg-status">1) In Telegram, message @BotFather, send /newbot and paste the token it gives you here. 2) Send your new bot any message. 3) Press Find my chat ID, then Send test. The token stays in this browser.</p>
  <div class="sect"><span class="lbl">Data check</span></div>
  <p class="note" data-vts="census">GMGN feed: not seen yet in this tab.</p>
  <div class="buttons"><button data-vts="census-copy">Copy GMGN feed report</button></div>
  <div class="buttons" data-vts="author-row"><button data-vts="author-reset">Re-learn VolTrak sender</button></div>
  <p class="note" data-vts="author-note"></p>
  <p class="note">Shows which fields GMGN's live feed sends (for example whether it tags wash-trading wallets). Paste the report to Claude to improve the volume-bot reading. It contains public trade data only.</p>
  <div class="sect"><span class="lbl">Keys</span></div>
  <p class="note"><kbd>Alt+V</kbd> hides the panel · <kbd>Alt+I</kbd> opens Recover initials · drag the header to move it. No private keys or trading endpoints. Disable the old VolTrak script before using this one.</p>
</section>
</div>
<footer class="foot"><span class="dot" data-vts="dot"></span><span class="st" data-vts="status"></span><span class="fg" data-vts="foot-gmgn"><label class="sw" title="Open new calls in this tab automatically"><input type="checkbox" data-vts="autoload" checked><span>Auto-open</span></label><button class="primary" data-vts="claim" title="Make this GMGN tab the one that receives calls">Use this tab for calls</button></span></footer>`;

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
  const VERSION=typeof GM_info!=='undefined'?GM_info.script.version:'4.3.0';
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
  // prof: GMGN's label for each wallet seen (tags, trade count and lifetime position on this coin), for the volume-bot reading.
  const resetLive=mint=>{live={mint,since:Date.now(),first:0,at:0,stat:null,trades:[],keys:new Set(),prunedAt:Date.now(),prof:new Map(),profVer:0,fill:null};};resetLive(current);
  const putProf=p=>{if(!p)return;const o=live.prof.get(p.wallet);if(o&&o.at>p.at&&(o.tt??0)>=(p.tt??0))return;live.prof.set(p.wallet,p);live.profVer++;};
  // Volume-bot readings per live call (receiver tab only): bot-like share of the first 60s and 120s after the alert,
  // from GMGN's trades for that coin, saved as 'feat.<id>' so the backtest can test them once enough calls have one.
  // complete = the feed was on this coin within 15s of the alert and stayed until the end of the window.
  const packBots=(r,complete)=>({n:r.n,usd:Math.round(r.usd),share:r.botShare==null?null:+r.botShare.toFixed(1),tradeShare:r.botTradeShare==null?null:+r.botTradeShare.toFixed(1),
    wallets:r.wallets,bots:r.botWallets,buyers:r.buyers,buyersNet:Math.round(r.buyersNet),arb:r.arb,suspect:r.suspectShare==null?null:+r.suspectShare.toFixed(1),
    org:r.orgShare==null?null:+r.orgShare.toFixed(1),orgN:r.orgN,rules:[r.byRule.txWash,r.byRule.fastTrip,r.byRule.churn,r.byRule.bump],
    tagRules:[r.byRule.washTag,r.byRule.mev,r.byRule.heavy,r.byRule.lifeChurn,r.byRule.mirror],possible:r.possibleShare==null?null:+r.possibleShare.toFixed(1),app:r.appShare==null?null:+r.appShare.toFixed(1),dust:r.dustShare==null?null:+r.dustShare.toFixed(1),labeled:r.profiled==null?null:Math.round(r.profiled),complete});
  function recordBots(leaving=false){
    if(!GMGN||!isReceiver||!live?.mint)return;
    const now=Date.now();
    for(const c of calls()){
      if(c.historical||c.manual||c.mint!==live.mint||now<c.messageAt||now-c.messageAt>15*60000)continue;
      const key='feat.'+c.id, f=get(key,null)||{t:c.messageAt};let changed=false;
      for(const sec of [60,120]){
        const end=c.messageAt+sec*1000;if(f['vb'+sec]||(now<end&&!leaving))continue;
        // No feed for this coin yet: wait up to 30s past the window, then mark it missed. Feed started after the
        // window closed: missed. Otherwise save what the feed saw (complete only if it started within 15s of the alert).
        if(!live.first){if(leaving||now-end>30000){f['vb'+sec]={missed:true,complete:false};changed=true;}continue;}
        if(live.first>end){f['vb'+sec]={missed:true,complete:false};changed=true;continue;}
        const r=VTCore.botFlow(live.trades,c.messageAt,Math.min(end,now),VTCore.VB,live.prof);
        f['vb'+sec]=packBots(r,live.first<=c.messageAt+15000&&now>=end);changed=true;
      }
      if(!changed)continue;
      set(key,f);
      const ids=get('featIds',[]);if(!ids.includes(c.id)){ids.unshift(c.id);for(const old of ids.splice(1000))GM_deleteValue(PREFIX+'feat.'+old);set('featIds',ids);}
    }
  }
  // Leaving a coin: save what was seen so far (marked incomplete) before its trades are dropped.
  const switchLive=mint=>{try{recordBots(true);}catch(_){}resetLive(mint);};
  // Opening a coin: the last 5 min of trades from GMGN's trades API (50 per page, newest first, up to 12 pages), with
  // GMGN's wallet labels, so the volume-bot reading is complete at once instead of after 5 min on screen. The pages
  // join the live feed without a gap (the feed is already running), so coverage starts at the oldest trade fetched.
  async function backfillTrades(mint){
    if(!GMGN||!mint||live.mint!==mint||live.fill||!get('gmOn',true)||Date.now()<gmS.pauseTill)return;
    live.fill={busy:true,pages:0,from:null};
    const goal=Date.now()-300000;let cursor=null,oldest=null,ok=false;
    try{
      for(let page=0;page<12;page++){
        const r=await gmGet('/vas/api/mul-region/token_trades_v2/sol/'+mint+'?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
        if(live.mint!==mint)return;
        if(r.limited){gmS.pauseTill=Date.now()+60000;break;}
        const list=r.data?.data?.history;if(!Array.isArray(list))break;
        live.fill.pages++;
        for(const x of list){
          putProf(VTCore.gmgnMaker(x));
          const t=VTCore.gmgnApiTrade(x);if(!t||t.mint&&t.mint!==mint)continue;
          oldest=Math.min(oldest??t.at,t.at);
          const key=tradeKey(t);if(key&&live.keys.has(key))continue;
          if(key)live.keys.add(key);live.trades.push(t);
        }
        cursor=r.data?.data?.next||null;
        if(!list.length||!cursor||oldest!=null&&oldest<=goal){ok=true;break;}
        await new Promise(res=>setTimeout(res,150));
      }
      // Coverage: back to the oldest trade fetched when the pages reached 5 min or ran out (a coin younger than that);
      // otherwise only the newest page's span is trusted as continuous with the feed.
      if(oldest!=null){live.fill.from=oldest;live.fill.complete=ok;live.first=Math.min(live.first||Infinity,ok?Math.min(oldest,goal):oldest);}
    }catch(_){}
    finally{if(live.mint===mint){live.fill.busy=false;soon();}}
  }
  const tradeKey=t=>t.hash?t.hash+':'+t.side+':'+t.wallet+':'+t.amount:null;
  const liveFresh=()=>!!live&&live.mint===current&&Date.now()-live.at<20000;
  const liveNow=bots=>live&&live.mint===current?VTCore.liveView(live.trades,live.stat,live.at,Date.now(),live.first||Infinity,bots):null;
  let renderQueued=false;
  const soon=()=>{if(renderQueued)return;renderQueued=true;setTimeout(()=>{renderQueued=false;render();},250);};
  try{if(typeof GM_listValues==='function'&&!get('cleaned',false)){for(const k of GM_listValues())if(k.startsWith(PREFIX+'mint-alert.'))GM_deleteValue(k);set('cleaned',true);}}catch(_){}
  const root=document.createElement('section'); root.id='vts-root';
  root.innerHTML='<style>'+PANEL_CSS+'</style>'+PANEL_HTML;
  document.body.appendChild(root);
  const $=key=>root.querySelector('[data-vts="'+key+'"]');
  $('discord').hidden=!DISCORD; $('gmgn').hidden=!GMGN; $('foot-gmgn').hidden=!GMGN; $('history-row').hidden=!DISCORD; $('census-copy').parentElement.hidden=!GMGN;
  root.dataset.site=GMGN?'gmgn':'discord';
  // Tabs: Live is GMGN-only; the last tab used is remembered per site.
  const tabKey='tab.'+(GMGN?'gmgn':'discord');
  root.querySelector('[data-tab="live"]').hidden=!GMGN;
  function showTab(name){
    if(name==='live'&&!GMGN||!root.querySelector('[data-pane="'+name+'"]'))name=GMGN?'live':'calls';
    root.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('on',b.dataset.tab===name));
    root.querySelectorAll('[data-pane]').forEach(p=>p.hidden=p.dataset.pane!==name);set(tabKey,name);root.dataset.tab=name;
  }
  root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
  showTab(get(tabKey,GMGN?'live':'calls'));
  $('market-strip').onclick=()=>showTab('market');
  $('autoload').checked=get('autoload',true); $('sound').checked=get('sound',true); $('trades').checked=get('trades',true);
  $('autoload').onchange=()=>set('autoload',$('autoload').checked);
  $('sound').onchange=()=>set('sound',$('sound').checked);
  $('late-alerts').checked=get('lateAlerts',false);$('late-alerts').onchange=()=>set('lateAlerts',$('late-alerts').checked);
  $('trades').onchange=()=>{set('trades',$('trades').checked);flow=null;flowError='';render();};
  $('jup-on').checked=get('jupOn',true);$('jup-on').onchange=()=>{set('jupOn',$('jup-on').checked);render();};
  $('rc-on').checked=get('rcOn',true);$('rc-on').onchange=()=>{set('rcOn',$('rc-on').checked);render();};
  $('trade-sol').value=get('tradeSol',0.1);$('trade-sol').onchange=()=>{const v=+$('trade-sol').value;if(v>0){set('tradeSol',v);jupS.tried=0;}else $('trade-sol').value=get('tradeSol',0.1);};
  $('gm-on').checked=get('gmOn',true);$('gm-on').onchange=()=>{set('gmOn',$('gm-on').checked);render();};
  $('market-on').checked=get('marketOn',true);
  $('market-on').onchange=()=>{set('marketOn',$('market-on').checked);marketDisconnect();render();};
  $('author-row').hidden=!DISCORD;$('author-note').hidden=!DISCORD;
  const authorNote=()=>{const a=AUTHOR_ID||get('authorId','');if(!a&&get('authorMode','')==='name-only'){$('author-note').textContent='VolTrak sender: its messages carry no account ID, so it is matched by name only (anyone renamed "VolTrak" would pass).';return;}$('author-note').textContent=a?'VolTrak sender: account …'+a.slice(-6)+(AUTHOR_ID?' (set in the script)':' (learned from the channel)')+'. Alerts named VolTrak from any other account are flagged unverified.':'VolTrak sender: not learned yet (needs 3 VolTrak alerts on screen).';};authorNote();
  $('author-reset').onclick=()=>{set('authorId','');set('authorMode','');authorNote();notice('VolTrak sender will be re-learned from the channel');render();};
  $('census-copy').onclick=()=>{GM_setClipboard(JSON.stringify({version:VERSION,site:location.hostname,...VTLive.census()},null,1),'text');notice('GMGN feed report copied: paste it to Claude');render();};
  $('rpc-key').value=get('rpcKey','')?'••••'+String(get('rpcKey','')).slice(-4):'';
  const maskKey=()=>{const k=String(get('rpcKey','')||'');$('rpc-key').value=k?'••••'+k.slice(-4):'';};
  $('rpc-key').onfocus=()=>{if(/^••••/.test($('rpc-key').value))$('rpc-key').value='';};
  $('rpc-key').onblur=()=>{if(!$('rpc-key').value.trim())maskKey();};
  // Save never deletes: an empty or masked field keeps the saved key. "Remove key" is the only way to delete it.
  $('rpc-save').onclick=()=>{const v=$('rpc-key').value.trim();if(!v||/^••••/.test(v)){maskKey();$('rpc-status').textContent='Type or paste a key first.';return;}set('rpcKey',v);maskKey();$('rpc-status').textContent='Key saved. Press Test key.';};
  $('rpc-remove').onclick=()=>{set('rpcKey','');maskKey();$('rpc-status').textContent='Key removed from this browser.';};
  $('rpc-test').onclick=()=>testKey();
  // Public on-chain data only (no key): one transaction, for checking the parser against a new format.
  $('rpc-sample').onclick=()=>{if(rpcSample){GM_setClipboard(JSON.stringify(rpcSample,null,1).slice(0,40000),'text');$('rpc-status').textContent='Sample transaction copied: paste it to Claude.';}};
  $('hb-run').onclick=()=>runBackfill();
  $('rc-run').onclick=()=>runRugBackfill();
  $('rug-check').onclick=()=>{if(current)rugBuild(current,callFor(current),(rugLive.get(current)?.tries||0)+1);};
  // Telegram (optional): the bot token and chat ID stay in this browser's script storage, like the Helius key.
  $('tg-on').checked=get('tgOn',true);$('tg-on').onchange=()=>set('tgOn',$('tg-on').checked);
  $('tg-dev').checked=get('tgDev',true);$('tg-dev').onchange=()=>set('tgDev',$('tg-dev').checked);
  const maskTg=()=>{const k=String(get('tgToken','')||'');$('tg-token').value=k?'••••'+k.slice(-4):'';};maskTg();
  const tgStatus=t=>{$('tg-status').textContent=t;};
  $('tg-token').onfocus=()=>{if(/^••••/.test($('tg-token').value))$('tg-token').value='';};
  $('tg-token').onblur=()=>{if(!$('tg-token').value.trim())maskTg();};
  $('tg-save').onclick=async()=>{
    const v=$('tg-token').value.trim();if(!v||/^••••/.test(v)){maskTg();tgStatus('Paste the bot token first.');return;}
    set('tgToken',v);maskTg();tgStatus('Saved. Checking it…');
    const r=await tg('getMe');tgStatus(r.ok?'Saved: your bot is @'+r.result.username+'. Send it any message in Telegram, then press Find my chat ID.':'Saved, but Telegram said: '+r.error);
  };
  $('tg-find').onclick=async()=>{
    if(!get('tgToken','')){tgStatus('Save the bot token first.');return;}
    tgStatus('Looking for your message…');
    const r=await tg('getUpdates',{limit:50,timeout:0});if(!r.ok){tgStatus('Telegram said: '+r.error);return;}
    const msg=[...(r.result||[])].reverse().map(u=>u.message||u.edited_message||u.channel_post).find(m=>m?.chat?.id!=null);
    if(!msg){tgStatus('No messages yet: send your bot any message in Telegram, then press this again.');return;}
    set('tgChat',String(msg.chat.id));tgStatus('Found your chat'+(msg.chat.username?' (@'+msg.chat.username+')':msg.chat.first_name?' ('+msg.chat.first_name+')':'')+'. Press Send test.');
  };
  $('tg-test').onclick=async()=>{
    if(!tgReady()){tgStatus('Save the token and find your chat ID first.');return;}
    const r=await tgSend('VolTrak Steroids is connected. New calls and dev sells will ping here.');tgStatus(r.ok?'Test sent: check Telegram.':'Telegram said: '+r.error);
  };
  $('tg-remove').onclick=()=>{set('tgToken','');set('tgChat','');maskTg();tgStatus('Telegram removed from this browser.');};
  if(tgReady())tgStatus('Connected: pings go to your Telegram bot.');
  $('mint-copy').onclick=()=>{if(current){GM_setClipboard(current,'text');notice('Contract copied');render();}};
  // Default round-trip cost 5%: about 1% pump.fun/PumpSwap + 1% GMGN per side, plus priority fee/tip and price impact
  // (roughly 2–3% round trip for 1 SOL on a sub-$50K bonding curve). Saved settings keep whatever was entered.
  {const o=get('bt.opt',{tp:100,sl:-50,cost:5});$('bt-tp').value=o.tp;$('bt-sl').value=Math.abs(o.sl);$('bt-cost').value=o.cost;$('bt-delay').value=String(o.delay||0);$('bt-exit').value=String(o.exit||0);$('bt-fill').value=o.fill||'touch';}
  // Collapsed = the header alone, as a scoreboard (state, buy share, time since the alert).
  const setCollapsed=on=>{root.classList.toggle('vts-collapsed',on);set('collapsed',on);};
  setCollapsed(get('collapsed',false));
  $('collapse').onclick=()=>setCollapsed(!root.classList.contains('vts-collapsed'));
  let drag=null;
  root.querySelector('header').onpointerdown=e=>{if(e.target.closest('button'))return;const b=root.getBoundingClientRect();drag={x:e.clientX-b.left,y:e.clientY-b.top};e.currentTarget.setPointerCapture(e.pointerId);};
  root.querySelector('header').onpointermove=e=>{if(!drag)return;root.style.left=Math.max(0,Math.min(innerWidth-root.offsetWidth,e.clientX-drag.x))+'px';root.style.top=Math.max(0,Math.min(innerHeight-root.offsetHeight,e.clientY-drag.y))+'px';root.style.right='auto';root.style.bottom='auto';};
  root.querySelector('header').onpointerup=()=>{drag=null;};
  // e.code, not e.key: on macOS Option+V types "√", so e.key never equals "v".
  document.addEventListener('keydown',e=>{if(!e.altKey||e.ctrlKey||e.metaKey)return;if(e.code==='KeyV'){root.hidden=!root.hidden;e.preventDefault();}if(GMGN&&e.code==='KeyI'){root.hidden=false;setCollapsed(false);showTab('live');$('initials').closest('details').open=true;e.preventDefault();}});
  function listText(el,rows){el.replaceChildren(...rows.map(t=>{const li=document.createElement('li');li.textContent=t;return li;}));}
  const fmt=n=>n==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:1,notation:'compact'}).format(n);
  const usd=n=>n==null?'—':'$'+(Math.abs(n)<1000?Math.round(n):fmt(n));
  const ago=t=>t==null?'—':Math.max(0,Math.round((Date.now()-t)/1000))+'s ago';
  const freshFlow=()=>flow&&flow.mint===current&&Date.now()-flow.at<=30000?flow:null;
  let listSignature='';
  // Display names for assess() states: they describe who is trading right now, not what to do.
  const STATE_UI={'WATCH BUY SETUP':['buy','Buyers leading','Buyers'],'FADE / REVIEW EXIT':['sell','Sellers leading','Sellers'],'WAIT':['wait','No clear side','Even'],'CAUTION':['caution','Caution','Caution'],'UNKNOWN':['unknown','No data','No data']};
  const sinceText=ms=>{if(!(ms>=0))return '—';const t=Math.floor(ms/1000),h=Math.floor(t/3600),m=Math.floor(t%3600/60),x=String(t%60).padStart(2,'0');return h>=48?'+'+Math.floor(h/24)+'d':h?'+'+h+':'+String(m).padStart(2,'0')+':'+x:'+'+m+':'+x;};
  const mmss=ms=>{const t=Math.max(0,Math.ceil(ms/1000));return Math.floor(t/60)+':'+String(t%60).padStart(2,'0');};
  const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
  const signed=(v,d=0)=>(v>=0?'+':'−')+Math.abs(v).toLocaleString('en-US',{maximumFractionDigits:d,minimumFractionDigits:d});
  // Trend lines: buy share over the last 60s and market cap since the alert, sampled while this token is on screen.
  let sparkMint=null, shareHist=[], shareSrc='', mcHist=[], mcSrc='', lastTone='', lastShown=null;
  function drawSpark(el,pts,o){
    const svg=el.querySelector('svg'), cap=el.querySelector('.cap.l'), pk=el.querySelector('.cap.pk'), cl=el.querySelector('.cap.cl');
    if(cap)cap.textContent=o.cap||'';
    el.classList.remove('pos','neg','mix');
    if(pts.length<3){el.classList.add('none');if(pk)pk.textContent='';if(cl)cl.textContent='';return;}
    el.classList.remove('none');if(o.cls)el.classList.add(o.cls);
    const vs=pts.map(q=>q.v).concat(o.ref!=null?[o.ref]:[]), lo=o.lo??Math.min(...vs), hi=o.hi??Math.max(...vs), span=hi-lo||1, t0=pts[0].t, t1=Math.max(t0+1,pts[pts.length-1].t);
    const X=t=>100*(t-t0)/(t1-t0), Y=v=>22-20*(v-lo)/span, line=pts.map(q=>X(q.t).toFixed(1)+','+Y(q.v).toFixed(1)).join(' ');
    svg.querySelector('.ln').setAttribute('points',line);svg.querySelector('.ar').setAttribute('points',line+' 100,24 0,24');
    const ry=o.ref!=null?Y(o.ref):12, ref=svg.querySelector('.ref');ref.setAttribute('y1',ry.toFixed(1));ref.setAttribute('y2',ry.toFixed(1));
    const last=pts[pts.length-1];el.style.setProperty('--x',X(last.t).toFixed(1)+'%');el.style.setProperty('--y',(Y(last.v)/24*100).toFixed(1)+'%');
    if(cl){cl.textContent=o.ref!=null?'CALL':'';el.style.setProperty('--cy',(ry/24*100).toFixed(1)+'%');}
    if(pk){const top=pts.reduce((m,q)=>q.v>m.v?q:m,pts[0]);pk.textContent=o.peak?o.peak(top.v):'';el.style.setProperty('--px',Math.min(88,Math.max(12,X(top.t))).toFixed(1)+'%');}
  }
  function flash(){for(const e of [root.querySelector('.band'),root.querySelector('.m-state')]){if(!e)continue;e.classList.remove('flash');void e.offsetWidth;e.classList.add('flash');setTimeout(()=>e.classList.remove('flash'),1200);}}
  // Late-check grade → chip/pill class and text.
  const LATE_UI={ABOVE:['buy','ABOVE'],BELOW:['wait','BELOW'],DOWN30:['fade','DOWN'],NOTRADES:['dead','NO TRADES'],NOPRICE:['dead','NO PRICE']};
  // Entries saved by 3.5 (no rule:2) are re-graded from their stored change/traded, since the old grade also used cluster.
  const lateCode=L=>L.rule===2?L.grade:('change' in L||'traded' in L)?VTCore.lateGrade(L.change??null,L.traded!==false):VTCore.LATE_LEGACY[L.grade]||L.grade;
  const lateView=L=>LATE_UI[lateCode(L)]||['dead',String(L.grade)], lateQuiet=L=>['NOTRADES','NOPRICE'].includes(lateCode(L));
  // Setup card. Filters from the first 22 calls (cluster, age, MC) failed on 73 newer calls, so nothing is graded:
  // the card shows how all scored calls did against the break-even win rate (from the last report opened).
  // Grade card (3.9): AVOID / RISKY / CLEAN from the live score (GMGN numbers + chain checks + volume bots), recomputed on
  // every render. Replaces the old setup grade (its filters from the first 22 calls failed on 73 newer calls). Returns the grade.
  let lastGrade={mint:null,grade:null};
  function renderGrade(s,rv){
    const b=get('bt.summary',null), cell=$('grade');
    const bt=b?.n?' Your backtest ('+b.n+' calls, +'+b.tp+'%/'+b.sl+'%, '+b.cost+'% costs): '+Math.round(b.winRate)+'% won, average '+(b.ev>=0?'+':'')+b.ev.toFixed(1)+'% per trade; break-even '+b.be.toFixed(0)+'%.':'';
    const show=(cls,glyph,text,note,title)=>{cell.className='cell grade '+cls;$('grade-letter').textContent=glyph;$('grade-text').textContent=text;$('grade-note').textContent=note;cell.title=title+bt;};
    if(!s||!s.known){lastGrade={mint:current,grade:null};const busy=rv?.busy||gmS.busy;show(busy?'few':'none',busy?'…':'—',busy?'Checking':'No grade',busy?'loading data':rv?.wait||'no data yet','The grade comes from the checks below.');return null;}
    const [cls,glyph]={AVOID:['g-avoid','✕'],RISKY:['g-risky','!'],CLEAN:['g-clean','✓'],PARTIAL:['few','?']}[s.grade];
    const by=s.checks.find(k=>k.key===s.because), why=s.hard[0]||(by?by.label+' '+(rv?.detail?.[by.key]??by.value):'');
    const sg=v=>(v>0?'+':v<0?'−':'')+Math.abs(v);
    show(cls,glyph,s.grade==='PARTIAL'?'Partial':s.grade,(s.grade==='PARTIAL'?s.known+' checks so far':'risk '+sg(s.risk)+' · demand '+sg(s.demand)+' · entry '+sg(s.entry))+(why?' · '+why:s.grade==='CLEAN'?' · no red flags':'')+(s.confidence.level!=='high'?' · data '+s.confidence.level:''),
      [...s.hard,...s.checks.filter(k=>k.status!=='na').map(k=>(k.pts>0?'+':'')+k.pts+'  '+k.label+' '+(rv?.detail?.[k.key]??k.value))].join('\n')+'\n\nAVOID: a hard stop, Risk -4 or less, or Entry -3 or less. RISKY: Risk -1 or less, Demand -2 or less, or Entry -1 or less. Strong demand cannot cancel a risk. Untested points: the backtest’s "Live grade at the call (4.3 rules)" table shows whether they predict outcomes.');
    if(lastGrade.mint===current&&lastGrade.grade&&lastGrade.grade!==s.grade){cell.classList.remove('flash');void cell.offsetWidth;cell.classList.add('flash');setTimeout(()=>cell.classList.remove('flash'),1200);}
    lastGrade={mint:current,grade:s.grade};
    return s.grade==='PARTIAL'?null:s.grade;
  }
  let botCache={key:'',vb:null};
  function renderBots(now){
    // On while GMGN's feed is live, or once the last 5 min were loaded from GMGN's trades list (a quiet coin).
    const cell=$('vol-bots'), on=live&&live.mint===current&&live.trades.length>0&&(now-live.at<60000||!!live.fill?.pages&&!live.fill.busy);
    // botFlow pairs trades per wallet; with thousands of trades, recompute at most every 3s and only while the panel is
    // visible. Every view needs it (the collapsed scoreboard shows the organic gauge too), not just the Live tab.
    const key=on?live.mint+'|'+live.trades.length+'|'+live.profVer+'|'+Math.floor(now/3000):'';
    if(on&&key!==botCache.key&&!root.hidden&&!document.hidden)botCache={key,vb:VTCore.botFlow(live.trades,now-300000,now,VTCore.VB,live.prof)};
    const vb=on&&botCache.key.startsWith(live.mint+'|')?botCache.vb:null;
    if(!vb||!vb.n||vb.botShare==null){
      cell.className='cell bots na';$('bots-pct').textContent='—';$('bots-level').textContent='No data';$('bots-level').className='tag';$('bots-bar').style.setProperty('--p','0%');
      $('bots-org').textContent=live?.fill?.busy?'loading the last 5 min…':on?'no trades in the last 5m':'needs GMGN live trades';cell.title='Volume bots need GMGN’s live trade feed for the coin on screen.';return null;
    }
    // Headline: bot share of trades (bump bots are most of a bumped coin's trades but almost none of its dollars);
    // the line under it gives the bot share of dollar volume and the trading-app share. Level = the worse of the two.
    const sh=vb.botTradeShare??0, vs=vb.botShare??0, lvT=sh<25?0:sh<50?1:2, lvV=vs<15?0:vs<40?1:2, lvl=Math.max(lvT,lvV), lv=[['low','Low',''],['med','Med','warn'],['high','High','bad']][lvl], partial=live.first>now-300000;
    cell.className='cell bots '+lv[0];$('bots-pct').textContent=Math.round(sh)+'%';$('bots-level').textContent=lv[1];$('bots-level').className='tag'+(lv[2]?' '+lv[2]:'');
    cell.querySelector('.bv .muted').textContent=partial?'of trades · '+mmss(now-live.first):'of 5m trades';
    $('bots-bar').style.setProperty('--p',Math.min(100,sh).toFixed(0)+'%');
    const org=$('bots-org');org.replaceChildren(node('b','',Math.round(vs)+'%'),' of $ vol',...(vb.appShare!=null?[' · ',node('b','',Math.round(vb.appShare)+'%'),' app']:[]),' · ',node('b','',String(vb.buyers)),' buyers');
    const R=vb.byRule, U=vb.usdByRule, pc=x=>vb.usd>0?Math.round(100*x/vb.usd)+'%':'0%', line=(lbl,r)=>R[r]?'\n  '+lbl+': '+R[r]+' trades, '+pc(U[r])+' of $':'';
    cell.title='Bots: '+Math.round(sh)+'% of '+vb.n+' trades and '+Math.round(vs)+'% of $'+Math.round(vb.usd).toLocaleString()+' volume over '+(partial?mmss(now-live.first):'the last 5 min')+', from '+vb.botWallets+' of '+vb.wallets+' wallets.'
      +line('bump bots (repeated sub-$3 trades)','bump')+line('GMGN wash-trader tag','washTag')+line('GMGN sandwich/MEV tag','mev')+line('buy+sell in one transaction','txWash')+line('flat buy-then-sell within 10s','fastTrip')
      +(vb.possibleTradeShare?'\nPossible bots, not counted above (real traders can trade like this too): '+Math.round(vb.possibleTradeShare)+'% of trades, '+Math.round(vb.possibleShare||0)+'% of $'
        +line('100+ trades on this coin, flat position','heavy')+line('25+ trades, flat, no trading app','lifeChurn')+line('mirrored buy/sell across two wallets','mirror')+line('churn, flat in tokens and dollars','churn'):'')
      +(vb.arb?'\n  '+vb.arb+' arbitrage txs not counted':'')
      +'\n\nTrading-app volume (axiom, gmgn, photon…, not flagged): '+(vb.appShare==null?'n/a':Math.round(vb.appShare)+'%')+'. '+vb.buyers+' wallets bought $15+ and are net buyers. Trades under $3: '+Math.round(vb.dustShare||0)+'%.'
      +'\nGMGN wallet labels on '+Math.round(vb.profiled||0)+'% of trades.'+(live.fill?.pages?' Last 5 min loaded from GMGN ('+live.fill.pages+' page'+(live.fill.pages===1?'':'s')+').':'')+' Untested as a signal.';
    return vb;
  }
  function render(){
    const all=calls().slice().sort((a,b)=>b.messageAt-a.messageAt), signature=all.map(c=>c.id).join('|');
    if(signature!==listSignature){const v=$('call-list').value;$('call-list').replaceChildren(...all.slice(0,100).map(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name+' · '+new Date(c.messageAt).toLocaleTimeString()+(c.historical?' · history':'')+(c.unverified?' · unverified sender':'');return o;}));if(all.some(c=>c.id===v))$('call-list').value=v;listSignature=signature;}
    renderMarket();renderBt();renderLate();renderSpeed();
    const nowAll=Date.now(), active=all.filter(c=>!c.historical&&!c.manual&&nowAll-c.messageAt<30*60000).length;
    $('calls-badge').hidden=!active;$('calls-badge').textContent=active||'';
    $('status').textContent=(Date.now()<noteUntil?note+' · ':'')+status+(hasLocks?'':' · Web Locks unavailable: tab coordination is best effort');
    const C=VTLive.census();$('census').textContent=GMGN?(C.frames?'GMGN feed: '+C.frames+' frames since '+new Date(C.since).toLocaleTimeString()+' · channels: '+Object.keys(C.channels).slice(0,8).join(', ')+' · trade fields: '+(C.keys.token_activity||[]).join(', '):'GMGN feed: no frames seen yet in this tab.'):'Open a GMGN token tab to run the data check there.';
    if(DISCORD){
      const alive=receiverAlive(receiver());
      root.dataset.tone='unknown';
      $('dot').className='dot '+(alive?'ok':'warn');
      $('receiver').textContent=alive?'GMGN receiver connected: new calls open there automatically.':'No GMGN receiver: open a GMGN token page and press “Use this tab for calls”.';
      $('discord').className='recv'+(alive?' ok':'');
      $('mini-text').textContent=alive?'receiver connected':'no GMGN receiver';$('mini-text').className='m-text '+(alive?'pos':'warnc');
      return;
    }
    // Bots first: the gauge reads the organic (bot-free) flow when there is enough of it.
    const now=Date.now(), c=all.find(x=>x.mint===current)||null, f=freshFlow(), vb=renderBots(now), L=liveNow(vb), a=VTCore.assess(c,snapshot,now,fetchError,f,L);
    const Lf=L&&now-L.at<=15000?L:null, st=Lf?.stat&&now-Lf.stat.at<=15000?Lf.stat:null, lf=Lf?.flow||null, lo=Lf?.organic||null;
    const [tone,label,short]=STATE_UI[a.state]||STATE_UI.UNKNOWN;
    if(lastShown!==null&&(tone!==lastTone||current!==lastShown))flash();
    lastTone=tone;lastShown=current;root.dataset.tone=tone;
    $('dot').className='dot '+(Lf?'ok':snapshot||f?'warn':'bad');
    $('claim').hidden=isReceiver;
    // Identity.
    $('token').textContent=c?.name||(current?'Token':'Open a Solana token');$('token').title=c?.name||'';
    $('symbol').textContent=c?.symbol?'$'+c.symbol:'';
    $('mint').textContent=current?current.slice(0,4)+'…'+current.slice(-4):'';$('mint-copy').hidden=!current;$('mint-copy').title=current?current+' · click to copy':'';
    const pool=snapshot?.dex?({pumpfun:'pump.fun',pumpswap:'PumpSwap',raydium:'Raydium',meteora:'Meteora'}[snapshot.dex]||snapshot.dex):null;
    $('venue').replaceChildren(...[pool&&[pool+(snapshot.pools>1?' +'+(snapshot.pools-1):''),''],c?.migrated!=null&&[c.migrated?'Migrated':'Bonding curve',''],c&&!c.historical&&!c.manual&&['Call '+new Date(c.messageAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),'dash']].filter(Boolean).map(([t,cls])=>node('span','tag'+(cls?' '+cls:''),t)));
    // State band.
    $('state').textContent=label;
    const fr=$('fresh'), fs=Lf?['LIVE '+Math.max(0,Math.round((now-Lf.at)/1000))+'s','']:snapshot?['DEX '+Math.max(0,Math.round((now-snapshot.at)/1000))+'s','stale']:f?['GECKO '+Math.max(0,Math.round((now-f.at)/1000))+'s','stale']:current?['NO FEED','off']:null;
    fr.hidden=!fs;if(fs){fr.textContent=fs[0];fr.className='fresh'+(fs[1]?' '+fs[1]:'');}
    const why=a.state==='CAUTION'&&a.risks.length?a.risks[0]+(a.risks.length>1?' · +'+(a.risks.length-1)+' more':''):'';
    $('state-why').hidden=!why;$('state-why').textContent=why;$('state-why').title=a.risks.join(' · ');
    $('momentum').hidden=!!why;$('momentum').textContent=a.momentum!=null?'price '+a.momentumWindow+' '+(a.momentum>=0?'▲ +':'▼ ')+Math.abs(a.momentum).toFixed(1)+'%':'';
    $('since').textContent=c?sinceText(now-c.messageAt):'—';$('clock').title=c?'Alert at '+new Date(c.messageAt).toLocaleTimeString()+' · time since the alert':'Time since the alert';
    // Decision numbers: buy share and move vs the call's market cap, each with a trend line.
    if(sparkMint!==current){sparkMint=current;shareHist=[];mcHist=[];mcSrc='';}
    const share=a.share, mc=Lf?.marketCap??snapshot?.marketCap, move=mc>0&&c?.callMc>0?(mc/c.callMc-1)*100:null;
    // One price source per trend line: live and DEX market caps can differ, so a source switch restarts the line.
    const mcFrom=Lf?.marketCap?'live':'dex';if(mc>0&&mcFrom!==mcSrc){mcSrc=mcFrom;mcHist=[];}
    const shareFrom=(a.basis||'').split(' ')[0];if(share!=null&&shareFrom!==shareSrc){shareSrc=shareFrom;shareHist=[];}
    if(share!=null&&(!shareHist.length||now-shareHist[shareHist.length-1].t>=2000))shareHist.push({t:now,v:share});
    shareHist=shareHist.filter(q=>now-q.t<=60000);
    if(mc>0&&(!mcHist.length||now-mcHist[mcHist.length-1].t>=5000)){mcHist.push({t:now,v:mc});if(mcHist.length>360)mcHist=mcHist.filter((_,i)=>i%2===0||i===mcHist.length-1);}
    const sh=$('share');sh.className='big'+(share==null?' na':share>=60?' pos':share<=40?' neg':'');sh.replaceChildren(...(share==null?['—']:[String(Math.round(share)),node('small','','%')]));
    const side=$('side');side.hidden=share==null;side.textContent=share>=60?'▲ Buy side':share<=40?'▼ Sell side':'≈ Mixed';side.className='side'+(share>=60?' pos':share<=40?' neg':'');
    const mv=$('move');mv.className='big r'+(move==null?' na':move>=0?' pos up':' neg down')+(move!=null&&Math.abs(move)>=1000?' long':'');mv.replaceChildren(...(move==null?['—']:[signed(move),node('small','','%')]));
    $('mc-line').replaceChildren(...(mc>0&&c?.callMc>0?[node('b','',usd(mc)),' from '+usd(c.callMc)]:mc>0?['MC ',node('b','',usd(mc))]:['no call MC']));
    drawSpark($('share-spark'),shareHist,{lo:0,hi:100,ref:50,cls:share==null?'mix':share>=60?'pos':share<=40?'neg':'mix',cap:shareHist.length>=3?'60s':'60s · filling'});
    drawSpark($('mc-spark'),mcHist,{ref:c?.callMc>0?c.callMc:null,cls:move==null?'mix':move>=0?'pos':'neg',peak:v=>c?.callMc>0?'peak '+signed((v/c.callMc-1)*100)+'%':''});
    // Meter: 20 cells, one per 5% of buy share.
    const meter=$('meter');meter.classList.toggle('empty',share==null);[...meter.children].forEach((e,i)=>e.classList.toggle('on',share!=null&&i<Math.round(share/5)));
    if(share==null)meter.removeAttribute('aria-valuenow');else meter.setAttribute('aria-valuenow',String(Math.round(share)));
    const has=w=>w&&(w.buys!=null||w.sells!=null), w1=[st?.m1,lf?.m1,f?.m1].find(has)||null, dexOnly=a.basis?.startsWith('DEX'), sw=a.window&&!dexOnly?a.window:w1;
    $('split-buy').textContent=dexOnly&&snapshot?'▲ '+snapshot.buys5m+' buys':sw?'▲ '+(sw.buys??'—')+' buys · '+usd(sw.buyUsd):'';
    $('split-sell').textContent=dexOnly&&snapshot?snapshot.sells5m+' sells ▼':sw?usd(sw.sellUsd)+' · '+(sw.sells??'—')+' sells ▼':'';
    $('basis').textContent=a.basis||'no data yet';$('basis').title=a.basis?'Buy share basis: '+a.basis:'';
    const rv=rugView(c,now), ls=liveScore(rv,vb,now,move);renderChecks(c,now,rv,ls);gmSnapshot(c,ls,now);
    const grade=renderGrade(ls.score,rv);
    if(c&&grade)latMark(c.mint,'grade');
    // KPIs.
    const wl=lf||f, part=w=>w.complete?'':'+', last=Lf?.last, lastAt=last?.at??f?.lastTradeAt, cl=c?.clusters?.length?Math.max(...c.clusters):null;
    const kpi=(lbl,val,sub,cls,icon)=>{const d=node('div','kpi'+(cls==='na'?' na':'')),b=node('b',cls&&cls!=='na'?cls:'');if(icon){b.append(node('span','',icon))}b.append(val);d.append(node('span','lbl',lbl),b,typeof sub==='string'?node('small','',sub):sub);return d;};
    const lastSub=node('small');if(last){lastSub.append(node('span',last.side==='buy'?'pos':'neg',last.side==='buy'?'▲':'▼'),' '+last.side+' '+usd(last.usd));}else lastSub.textContent=lastAt?'GeckoTerminal':'no trades seen';
    $('kpis').replaceChildren(
      wl?kpi('Wallets 1m',wl.m1.wallets+part(wl.m1),wl.m5.wallets+part(wl.m5)+' in 5m'):kpi('Wallets 1m','—','no live feed','na'),
      cl==null?kpi('Top cluster','—','not in alert','na'):kpi('Top cluster',(cl>=10?Math.round(cl):cl.toFixed(1))+'%','largest at call'),
      lastAt?kpi('Last trade',Math.max(0,Math.round((now-lastAt)/1000))+'s',lastSub,now-lastAt>30000?'warnc':''):kpi('Last trade','—','no trades seen','na'));
    // Late checks for this call.
    const lateAll=get('late',{}), chips=[];
    if(c&&!c.historical&&!c.manual)for(const d of LATE_AT){
      const Lc=lateAll[c.id]?.[d], due=c.messageAt+d*60000, ch=node('div','lc');ch.append(node('span','lbl','+'+d+' min'));
      if(Lc?.grade){const [k,t]=lateView(Lc);ch.className='lc g-'+k;ch.append(node('b','v',t+(Lc.change==null||lateQuiet(Lc)?'':' '+signed(Lc.change)+'%')));}
      else if(Lc?.missed||now>due+5*60000)ch.className='lc pend',ch.append(node('b','v muted','missed'));
      else{ch.className='lc pend';ch.append(node('b','v',now<due?'in '+mmss(due-now):'checking…'));const pr=node('i','prog');pr.style.setProperty('--p',Math.min(100,100*(now-c.messageAt)/(d*60000)).toFixed(0)+'%');ch.append(pr);}
      chips.push(ch);
    }
    $('late-chips').replaceChildren(...chips);
    $('risks').replaceChildren(...a.risks.map(t=>node('li','risk',t)),...rugRisks(now).map(t=>node('li','risk',t)),...(ls.ex.coordinated?[node('li','risk','Insiders leaving together: '+ls.ex.wallets+' wallet'+(ls.ex.wallets===1?'':'s')+' sold '+pctS(ls.ex.pct)+' of supply in 2 min ('+ls.ex.roles.join(', ')+')')]:[]),...a.flags.map(t=>node('li','',t)));
    // Flow table: 1m and 5m from the best live source.
    const m5=[st?.m5,lf?.m5].find(has)||null, cells=[];
    const add=(cls,t,plus)=>{const e=node('span',cls,t);if(plus)e.append(node('sup','','+'));cells.push(e);};
    const shr=w=>w&&(w.buyUsd||0)+(w.sellUsd||0)>0?100*(w.buyUsd||0)/((w.buyUsd||0)+(w.sellUsd||0)):null;
    const bar=(v,plus)=>{const e=node('span');if(v==null){e.textContent='—';}else{const i=node('i','rb');i.style.setProperty('--p',v.toFixed(0)+'%');e.append(i,Math.round(v)+'%');if(plus)e.append(node('sup','','+'));}cells.push(e);};
    add('h l','Window');add('h','1m');add('h','5m');
    add('l','▲ Buys');add('',w1?.buys??'—',w1&&w1.complete===false);add('',m5?.buys??snapshot?.buys5m??'—',m5&&m5.complete===false);
    add('l','▼ Sells');add('',w1?.sells??'—',w1&&w1.complete===false);add('',m5?.sells??snapshot?.sells5m??'—',m5&&m5.complete===false);
    add('l','Buy share $');bar(shr(w1),w1&&w1.complete===false);bar(shr(m5),m5&&m5.complete===false);
    add('l','Organic share $');bar(shr(lo?.m1),lo&&!lo.m1.complete);bar(shr(lo?.m5),lo&&!lo.m5.complete);
    add('l','Wallets');add('',wl?wl.m1.wallets:'—',wl&&!wl.m1.complete);add('',wl?wl.m5.wallets:'—',wl&&!wl.m5.complete);
    add('l','Volume');add('',usd(st?.m1.volume??(w1?(w1.buyUsd||0)+(w1.sellUsd||0):null)));add('',usd(st?.m5.volume??(m5?(m5.buyUsd||0)+(m5.sellUsd||0):snapshot?.volume5m)));
    const ft=node('span','ft');for(const [k,v] of [['Liquidity',usd(snapshot?.liquidity)],['1h vol',usd(st?.h1?.volume??snapshot?.volume1h)],['Pool',pool||'—']]){const x=node('span','',k+' ');x.append(node('b','',v));ft.append(x);}
    cells.push(ft);$('metrics').replaceChildren(...cells);
    $('flow-src').textContent=st||lf?'GMGN live':f?'GeckoTerminal + DEX':snapshot?'DEX Screener':'no data';
    // Sources line.
    const src=(ok,t)=>{const e=node('span');e.append(node('i','dot '+ok),t);return e;};
    $('feed').replaceChildren(src(Lf?'ok':VTLive.attachedAt()?'warn':'bad',Lf?'GMGN live '+Math.max(0,Math.round((now-Lf.at)/1000))+'s ago':VTLive.attachedAt()?'GMGN live waiting':'GMGN live not connected'),
      src(snapshot?'ok':'warn',snapshot?'DEX Screener '+Math.max(0,Math.round((now-snapshot.at)/1000))+'s ago':'DEX Screener: no pool yet'),
      ...(get('trades',true)&&!Lf?[src(f?'ok':flowError?'bad':'warn',flowError||(f?'GeckoTerminal '+Math.max(0,Math.round((now-f.at)/1000))+'s ago':'GeckoTerminal starting'))]:[]));
    listText($('reasons'),[...a.reasons,...(vb?['Volume bots: '+Math.round(vb.botShare)+'% of '+(live.first>now-300000?'recent':'5m')+' $ volume from '+vb.botWallets+' flagged wallets (rough lower bound; untested as a signal)']:[])]);
    $('missing').textContent=a.missing.length?'Missing: '+a.missing.join(' · '):'';
    // Collapsed scoreboard.
    $('mini-state').textContent=short;$('mini-sym').textContent=(grade?grade+' · ':'')+(c?.symbol?'$'+c.symbol:current?current.slice(0,4)+'…':'');
    $('mini-share').replaceChildren(...(share==null?['—',node('small','','no data')]:[Math.round(share)+'%',node('small','','buys')]));
    $('mini-since').textContent=c?sinceText(now-c.messageAt):'—';
    const mb=$('mini-bar');mb.classList.toggle('empty',share==null);if(share!=null)mb.style.setProperty('--p',share.toFixed(0)+'%');
  }
  async function addCall(call){
    const key=call.manual?'manual':'calls', cap=call.manual?100:2000;
    return locked('write.'+key,()=>{const all=get(key,[]);if(all.some(c=>c.id===call.id))return false;set(key,[call,...all].slice(0,cap));callsCache=null;return true;});
  }
  // Only Discord speaks. No sound in GMGN and no repeated speech after navigation.
  function say(text){if(!DISCORD||!get('sound',true))return;try{const u=new SpeechSynthesisUtterance(text);u.rate=1.05;speechSynthesis.speak(u);}catch(_){}}
  const announce=call=>say('VolTrak. '+call.name+'. Check Steroids.');
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
  let pp=null, ppStatus='off', ppSince=0, ppTries=0, ppNext=0, ppTrades=0, ppMsgs=0, ppErr='', ppLast='', ppClose=null, solUsd=null, solAt=0, solTry=0, lastSnap=0;
  function marketConnect(){
    if(pp||Date.now()<ppNext)return;
    // Free events only: launches and graduations. PumpPortal's trade stream needs a funded API key (since May 2026).
    let ws;try{ws=new WebSocket(PP);}catch(e){ppStatus='blocked by this page';ppErr=String(e?.message||e).slice(0,80);ppNext=Date.now()+60000;return;}
    pp=ws;ppStatus='connecting';let opened=false;
    ws.addEventListener('open',()=>{if(pp!==ws)return;opened=true;ppStatus='connected';ppSince=Date.now();ppTries=0;
      ws.send(JSON.stringify({method:'subscribeNewToken'}));ws.send(JSON.stringify({method:'subscribeMigration'}));});
    ws.addEventListener('message',e=>{if(pp!==ws)return;ppMsgs++;const ev=VTCore.ppEvent(e.data);if(ev.kind==='trade')ppTrades++;else if(ev.kind==='other'&&typeof e.data==='string')ppLast=e.data.slice(0,80);tape.add(ev,Date.now());});
    ws.addEventListener('error',()=>{if(pp===ws)ppStatus=opened?'connection error':'blocked by this page or offline';});
    ws.addEventListener('close',e=>{if(pp!==ws)return;pp=null;ppSince=0;ppClose=e.code;ppTries=Math.min(ppTries+1,5);ppNext=Date.now()+2000*2**ppTries;ppStatus=opened?'reconnecting':'blocked by this page or offline';});
  }
  function marketDisconnect(){const ws=pp;pp=null;ppStatus='off';ppSince=0;ppNext=0;if(ws)try{ws.close();}catch(_){}}
  async function refreshSol(){
    if(Date.now()-solAt<300000||Date.now()-solTry<60000)return;
    solTry=Date.now();const r=await http(DEX+SOL), pair=VTCore.selectPair(Array.isArray(r.data)?r.data:null,SOL,null);
    if(pair){solUsd=VTCore.number(pair.priceUsd);solAt=Date.now();}
  }
  const marketView=()=>({at:Date.now(),status:ppStatus,since:ppSince,trades:ppTrades>0,msgs:ppMsgs,windows:tape.windows(Date.now(),ppSince||Date.now(),solUsd)});
  function renderMarket(){
    const on=get('marketOn',true), own=GMGN&&isReceiver&&on, m=own?marketView():get('marketSnap',null), fresh=on&&!!m&&Date.now()-m.at<30000&&!!m.since;
    const pill=$('market-status'), mins=m?.since?Math.floor((Date.now()-m.since)/60000):0;
    pill.className='pill '+(!on?'':fresh?'ok':/blocked|error|offline/.test(own?ppStatus:'')?'bad':'warn');
    pill.textContent=!on?'off':own?ppStatus+(ppSince?' · '+mins+'m · '+ppMsgs+' msgs':'')+(ppClose&&!ppSince?' · code '+ppClose:''):fresh?'via receiver · '+mins+'m':'no receiver';
    if(!fresh){
      $('market').replaceChildren();$('market-top').replaceChildren();$('market-strip').replaceChildren();
      $('market-note').textContent=!on?'The market feed is off (Settings).':own?(/blocked/.test(ppStatus)?'This page blocked the PumpPortal connection'+(ppErr?' ('+ppErr+')':'')+'. Launches and graduations are unavailable here.':'Connecting to PumpPortal…'+(ppLast?' Last message: '+ppLast:'')):'Market numbers come from the receiving GMGN tab: open a GMGN token page and press “Use this tab for calls”.';
      return;
    }
    const W=m.windows, cols=[1,5,10,30], plus=k=>W[k].complete?'':'+', span=(cls,t,sup)=>{const e=document.createElement('span');if(cls)e.className=cls;e.textContent=t;if(sup){const x=document.createElement('sup');x.textContent='+';e.append(x);}return e;};
    // Pace: the 5m per-minute rate vs the 30m average (both partial while listening is shorter).
    // Pace needs a baseline: shown once the feed has listened for 10+ minutes.
    const pace=k=>{if(mins<10)return ['pace after 10m','muted'];const a=W[5][k]/5, base=W[30][k]/Math.min(30,mins);if(!(base>0))return ['—','muted'];const r=a/base;return [(r>1.15?'▲ ':r<0.87?'▼ ':'≈ ')+r.toFixed(1)+'× pace',r>1.15?'pos':r<0.87?'neg':'muted'];};
    const kpi=(label,val,[sub,cls])=>{const d=document.createElement('div'),l=document.createElement('span'),b=document.createElement('b'),sm=document.createElement('small');d.className='kpi';l.className='lbl';l.textContent=label;b.textContent=val;sm.textContent=sub;sm.className=cls;d.append(l,b,sm);return d;};
    $('market-top').replaceChildren(kpi('Grads 5m',W[5].migrations+plus(5),pace('migrations')),kpi('Launches 5m',W[5].creates+plus(5),pace('creates')),kpi('Grad rate 30m',W[30].creates?(100*W[30].migrations/W[30].creates).toFixed(1)+'%':'—',['grads per launch','muted']));
    const cells=[span('h l','Last'),...cols.map(k=>span('h'+(k===5?' hl':''),k+'m'))];
    const line=(label,val)=>{cells.push(span('l',label));cols.forEach(k=>cells.push(span(k===5?'hl':'',String(val(W[k])),!W[k].complete)));};
    line('Graduated',w=>w.migrations);line('Launches',w=>w.creates);
    const short=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:0,notation:'compact'}).format(n);
    if(m.trades){line('Volume',w=>w.usd!=null?'$'+short(w.usd):short(w.sol)+' SOL');line('Traders',w=>short(w.traders));}
    $('market').replaceChildren(...cells);
    $('market-note').textContent='Pace = 5m per-minute rate vs the 30m average: ▲ above 1.15×, ▼ below 0.87×. "+" = still filling (listening for less than that window). Free feed: launches and graduations only.';
    const strip=[['Grad',W[5].migrations+plus(5)],['Launch',W[5].creates+plus(5)],['Grad 30m',W[30].migrations+plus(30)]];
    $('market-strip').replaceChildren(...strip.map(([k,v])=>{const e=document.createElement('span'),b=document.createElement('b');e.append(k+' ');b.textContent=v;e.append(b);return e;}));
  }

  // Backtest: score saved calls against GeckoTerminal 1m candles. Candles are cached per call, so changing the
  // target, stop or costs re-scores instantly without refetching.
  // FORWARD_FROM: calls after the 95-call analysis (Oct 11 2026 03:30 UTC) are a clean forward test of its leads.
  const BT_H=120, BT_PRE=15, LATE_AT=[10,30], BT_DELAYS=[0,1,...LATE_AT], FORWARD_FROM=Date.parse('2026-10-11T03:30:00Z'), sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let btRunning=false, btStop=false, btNote='', gtLast=0, gtGap=3000;
  // GeckoTerminal's free tier allows ~30 requests/min per IP, shared by every tab. Start at 20/min; after a rate limit,
  // pause 60s and double the gap (up to 15s), then ease back by 10% per successful request. While scoring runs, the
  // GMGN tab's GeckoTerminal fallback stays quiet (bt.busy) so the two do not compete.
  async function gtGet(url){
    for(;;){
      const wait=gtLast+gtGap-Date.now();if(wait>0)await sleep(wait);
      gtLast=Date.now();set('bt.busy',gtLast);const r=await http(url);
      if(r.status!==429){gtGap=Math.max(3000,gtGap*0.9);return r;}
      if(btStop)return r;
      gtGap=Math.min(15000,gtGap*2);btNote='GeckoTerminal rate limit: pausing 60s, then continuing slower (automatic)';renderBt();await sleep(60000);
    }
  }
  // 'ok' | 'no-data' | 'no-trades', or null to retry on a later run. Keeps BT_PRE min before the alert (for the run-up
  // split) and volume; 'bt.pre' marks calls whose cache reaches that far back (caches before 3.7 kept only 2 min).
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
    const cs=VTCore.mergeCandles(lists).filter(k=>k.t>=c.messageAt-BT_PRE*60000&&k.t<=c.messageAt+BT_H*60000);
    if(!cs.length)return 'no-trades';
    const sig=x=>+x.toPrecision(6);
    set('bt.c.'+c.id,cs.map(k=>[k.t/1000,sig(k.o),sig(k.h),sig(k.l),sig(k.c),sig(k.v)]));set('bt.f.'+c.id,Date.now());
    const pre=get('bt.pre',{});pre[c.id]=1;set('bt.pre',pre);
    return 'ok';
  }
  // Unverified-sender calls are kept in the list but left out of every automatic path (backtest, checks, pings).
  const btCandidates=()=>calls().filter(c=>!c.manual&&!c.unverified&&VTCore.MINT.test(c.mint)&&Number.isFinite(c.messageAt));
  const upgradeable=()=>{const done=get('bt.done',{}), pre=get('bt.pre',{});return btCandidates().filter(c=>done[c.id]==='ok'&&!(c.id in pre));};
  function renderBt(){
    const done=get('bt.done',{}), all=btCandidates(), ok=all.filter(c=>done[c.id]==='ok').length, none=all.filter(c=>done[c.id]&&done[c.id]!=='ok').length;
    const young=all.filter(c=>!done[c.id]&&Date.now()-c.messageAt<=(BT_H+5)*60000).length, left=all.length-ok-none-young;
    const oldest=all.reduce((m,c)=>Math.min(m,c.messageAt),Infinity), when=t=>new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    $('bt-run').textContent=btRunning?'Stop':'Score calls';$('hb-run').textContent=hbRunning?'Stop adding volume bots':'Add volume bots to past calls (Helius)';$('bt-history').textContent=histRunning?'Stop loading':'Load channel history';
    $('rc-run').textContent=rcRunning?'Stop adding rug checks':'Add rug checks to past calls (Helius)';
    $('history-row').hidden=!DISCORD;
    // Progress bar: scored / no price data / waiting / too recent.
    const parts=[['ok',ok,'scored'],['none',none,'no price data'],['left',left,'waiting'],['young',young,'too recent']].filter(x=>x[1]>0);
    if(parts.length){
      const bar=document.createElement('div'),keys=document.createElement('div');bar.className='bar';keys.className='keys';
      for(const [k,n,t] of parts){const i=document.createElement('i');i.className=k;i.style.setProperty('--n',String(n));bar.append(i);const sp=document.createElement('span'),b=document.createElement('b');sp.className='k '+k;b.textContent=n;sp.append(b,' '+t);keys.append(sp);}
      $('bt-progress').replaceChildren(bar,keys);
    }else $('bt-progress').replaceChildren();
    $('bt-help').textContent=DISCORD?'1) Load channel history: scrolls the VolTrak channel back for you and saves every alert. 2) Score calls: fetches 2h of 1m prices per call from GeckoTerminal (about 7–10s per call; slows down automatically if GeckoTerminal rate-limits; you can stop and resume). 3) Open report.'
      :'Open the VolTrak channel in Discord and press "Load channel history" there first. Then score calls (about 7–10s per call; stop and resume any time).';
    const up=btRunning?0:upgradeable().length;
    $('bt-status').textContent=[histNote,btNote,hbNote,rcNote].filter(Boolean).join(' · ')+(histNote||btNote||hbNote||rcNote?' · ':'')+all.length+' saved calls'+(all.length?' (oldest '+when(oldest)+')':'')+'. Calls under '+(BT_H+5)+' min old wait until their 2h window is complete.'
      +(up?' '+up+' older scored call'+(up===1?'':'s')+' will be refetched once on the next "Score calls" to add '+BT_PRE+' min of pre-alert prices (run-up split).':'');
  }
  // Discord: load older messages by scrolling the channel to the top until Discord stops loading more.
  // scan() saves every VolTrak alert as it renders, so this only drives the scrolling.
  let histRunning=false, histStop=false, histNote='';
  async function loadHistory(){
    if(histRunning){histStop=true;histNote='Stopping…';renderBt();return;}
    if(location.pathname.split('/')[3]!==CHANNEL){histNote='Open the VolTrak channel first';renderBt();return;}
    const scroller=()=>{const li=document.querySelector('li[id^="chat-messages-"]');for(let n=li?.parentElement;n&&n!==document.body;n=n.parentElement){const o=getComputedStyle(n).overflowY;if((o==='auto'||o==='scroll')&&n.scrollHeight>n.clientHeight)return n;}return null;};
    histRunning=true;histStop=false;
    const before=get('calls',[]).length;
    try{
      let still=0, lastTop='';
      while(!histStop&&still<10){
        const sc=scroller();if(!sc){histNote='Could not find the message list';break;}
        sc.scrollTop=0;await sleep(1500);
        const top=document.querySelector('li[id^="chat-messages-"]')?.id||'';
        still=top===lastTop?still+1:0;lastTop=top;
        histNote='Loading history: '+(get('calls',[]).length-before)+' older calls saved so far';renderBt();
      }
      if(!histNote.startsWith('Could not'))histNote=(histStop?'Stopped':'Reached the start of the channel')+': '+(get('calls',[]).length-before)+' older calls saved';
    }finally{histRunning=false;histStop=false;renderBt();}
  }
  async function runBacktest(){
    if(btRunning){btStop=true;btNote='Stopping…';renderBt();return;}
    btRunning=true;btStop=false;
    try{
      const done=get('bt.done',{}), now=Date.now(), byAge=(a,b)=>b.messageAt-a.messageAt;
      // New calls first, then calls scored before 3.7, refetched once so their cache reaches BT_PRE min before the alert.
      const fresh=btCandidates().filter(c=>!done[c.id]&&now-c.messageAt>(BT_H+5)*60000).sort(byAge), old=upgradeable().sort(byAge), todo=[...fresh,...old];
      if(!todo.length){btNote='Nothing new to score';return;}
      for(let i=0;i<todo.length&&!btStop;i++){
        const upgrade=i>=fresh.length;
        btNote=(upgrade?'Adding pre-alert prices to older call '+(i-fresh.length+1)+' of '+old.length:'Scoring '+(i+1)+' of '+fresh.length)+' (about '+Math.ceil((todo.length-i)*2.3*gtGap/60000)+' min left in total)';renderBt();
        const status=await fetchCandles(todo[i]);
        // A failed refetch keeps the old candles and score; it is marked so it is not retried every run.
        if(upgrade){if(status&&status!=='ok'){const p=get('bt.pre',{});p[todo[i].id]=0;set('bt.pre',p);}continue;}
        if(status){const d=get('bt.done',{});d[todo[i].id]=status;set('bt.done',d);}
      }
      btNote=btStop?'Stopped; run again to continue':'Done: open the report';
    }finally{btRunning=false;btStop=false;renderBt();}
  }
  // Late checks: 10 and 30 min after each live alert, read DEX Screener once and grade the call (VTCore.lateGrade).
  // The base price is DEX Screener's own market cap in the first 3 min after the alert (else the alert's MC). Discord
  // tabs and the GMGN receiver can both run this, but Web Locks do not reach across sites, so there is one writer: the
  // GMGN receiver while it is alive, else Discord. The write merges per call into the latest stored copy.
  let lateBusy=false;
  async function lateChecks(){
    if(lateBusy||GMGN&&!isReceiver||DISCORD&&receiverAlive(receiver()))return;
    const last=LATE_AT[LATE_AT.length-1], recent=()=>calls().filter(c=>!c.historical&&!c.manual&&!c.unverified&&Date.now()-c.messageAt<(last+6)*60000);
    if(!recent().length)return;
    lateBusy=true;
    try{await locked('late',async()=>{
      const late=get('late',{}), now=Date.now(), list=recent(), due=new Set(), checks=[];
      for(const c of list){
        const L=late[c.id]||(late[c.id]={t:c.messageAt}), retry=now-(L.tried||0)>=15000; // a coin DEX has not indexed yet: every 15s
        if(!L.base&&now-c.messageAt<3*60000&&retry){L.tried=now;due.add(c.mint);}
        for(const d of LATE_AT){
          const t=c.messageAt+d*60000;if(L[d]||now<t)continue;
          if(now>t+5*60000)L[d]={missed:true};else if(retry||L.tried===now){L.tried=now;due.add(c.mint);checks.push([c,d]);}
        }
      }
      for(const [id,L] of Object.entries(late))if(now-L.t>48*3600000)delete late[id];
      const fresh=[];
      if(due.size){
        const res=await http(DEX+[...due].slice(0,30).join(',')), at=Date.now(), rows=Array.isArray(res.data)?res.data:null;
        if(rows)for(const c of list){
          if(!due.has(c.mint))continue;
          const s=VTCore.normalize(VTCore.selectPair(rows,c.mint),at,rows), L=late[c.id];
          if(!s?.marketCap)continue; // not indexed yet: retried until the 5-min window closes
          if(!L.base&&at-c.messageAt<3*60000)L.base={mc:s.marketCap,at};
          for(const [cc,d] of checks){
            if(cc!==c)continue;
            const base=L.base?.mc||c.callMc, change=base>0?(s.marketCap/base-1)*100:null;
            const traded=s.buys5m==null&&s.sells5m==null?true:(s.buys5m||0)+(s.sells5m||0)>0;
            const grade=VTCore.lateGrade(change,traded);
            L[d]={at,mc:s.marketCap,change,traded,grade,rule:2};if(grade==='ABOVE')fresh.push([c,d,change]);
          }
        }
      }
      {const cur=get('late',{});for(const c of list)if(late[c.id])cur[c.id]=late[c.id];for(const [id,L] of Object.entries(cur))if(now-L.t>48*3600000)delete cur[id];set('late',cur);}
      if(!get('lateAlerts',false))return;
      for(const [c,d,change] of fresh){
        GM_notification({title:'VolTrak +'+d+' min · '+c.name,text:'Still above the call price ('+(change>=0?'+':'')+change.toFixed(0)+'%) and trading. Not a buy signal: see the backtest report. Click to open on GMGN.',timeout:15000,
          onclick:()=>GMGN?openToken(c.mint):GM_openInTab(VTCore.gmgnURL(c.mint),{active:true,insert:true})});
        say('VolTrak. '+c.name+'. '+d+' minute check: above call price.');
      }
    });}finally{lateBusy=false;}
  }
  let lateSignature='';
  function renderLate(){
    const late=get('late',{}), now=Date.now(), list=calls().filter(c=>!c.historical&&!c.manual).sort((a,b)=>b.messageAt-a.messageAt).slice(0,20);
    const cell=(c,d)=>{
      const L=late[c.id]?.[d], due=c.messageAt+d*60000;
      if(L?.grade){const [k,t]=lateView(L);return [lateQuiet(L)||L.change==null?t.toLowerCase():(L.change>=0?'+':'−')+Math.abs(L.change).toFixed(0)+'%',k,t];}
      return [L?.missed||now>due+5*60000?'missed':now<due?'in '+Math.ceil((due-now)/60000)+'m':'checking…',null];
    };
    const age=t=>{const m=Math.floor((now-t)/60000);return m<60?m+'m':m<2880?Math.floor(m/60)+'h':Math.floor(m/1440)+'d';};
    const data=list.map(c=>[c,age(c.messageAt),...LATE_AT.map(d=>cell(c,d))]);
    const signature=JSON.stringify(data.map(([c,...r])=>[c.id,r]));if(signature===lateSignature)return;lateSignature=signature;
    if(!list.length){const p=document.createElement('p');p.className='note';p.textContent='Calls that arrive while this script runs show here. History calls are graded in the backtest report instead.';$('late').replaceChildren(p);return;}
    const box=document.createElement('div');box.className='mkt late';
    const add=(text,cls,go)=>{const d=document.createElement('span');d.textContent=text;if(cls)d.className=cls;if(go){d.title='Open on GMGN';d.onclick=go;}box.append(d);};
    ['Call','Age',...LATE_AT.map(d=>'+'+d+' min')].forEach((h,i)=>add(h,'h'+(i<2?' l':'')));
    for(const [c,time,...cells] of data){
      add(c.name,'go',()=>GMGN?(VTCore.mintFromURL(location.href)!==c.mint&&openToken(c.mint)):GM_openInTab(VTCore.gmgnURL(c.mint),{active:true,insert:true}));add(time,'l muted');
      // Graded cells are pills (class gp + grade); pending/missed cells are muted text.
      for(const [t,k,full] of cells){if(!k){add(t,'pend');continue;}const d=document.createElement('span'),b=document.createElement('b');b.className='gp '+k;b.textContent=t;b.title=full+' '+t;d.append(b);box.append(d);}
    }
    $('late').replaceChildren(box);
  }
  // Helius (optional, the user's own key): every trade around each past call's alert, for volume-bot readings on
  // history. getTransactionsForAddress pages through all successful transactions touching the mint in a time window.
  const rpcUrl=()=>{const k=String(get('rpcKey','')||'').trim();return !k?null:/^https:\/\//i.test(k)?k:'https://mainnet.helius-rpc.com/?api-key='+encodeURIComponent(k);};
  function rpcCall(method,params){
    const url=rpcUrl();if(!url)return Promise.resolve({status:0,error:'no key'});
    return new Promise(resolve=>GM_xmlhttpRequest({method:'POST',url,headers:{'Content-Type':'application/json',Accept:'application/json'},data:JSON.stringify({jsonrpc:'2.0',id:'vt',method,params}),timeout:25000,
      onload:r=>{let d=null;try{d=JSON.parse(r.responseText);}catch(_){}resolve({status:r.status,data:d,error:d?.error?.message||(r.status!==200?'HTTP '+r.status:null)});},
      onerror:()=>resolve({status:0,error:'network error'}),ontimeout:()=>resolve({status:0,error:'timeout'})}));
  }
  let rpcSample=null;
  // getTransactionsForAddress result → transactions. Items are {transaction, meta, blockTime, slot}; some providers
  // nest them one level deeper.
  const txList=res=>(Array.isArray(res)?res:Array.isArray(res?.data)?res.data:Array.isArray(res?.transactions)?res.transactions:[])
    .map(x=>x?.meta?x:x?.transaction?.meta?{...x.transaction,blockTime:x.transaction.blockTime??x.blockTime,slot:x.transaction.slot??x.slot}:x);
  // from = null: from the address's first transaction.
  async function txWindow(mint,from,to,maxPages=40){
    const txs=[];let token=null,pages=0;
    do{
      // Solana now has version-1 transactions; the RPC refuses to return them unless asked. If it names a newer
      // version in its error, retry once with that and remember it.
      const opt={transactionDetails:'full',sortOrder:'asc',limit:100,commitment:'confirmed',encoding:'jsonParsed',maxSupportedTransactionVersion:get('rpcTxVersion',1),filters:{blockTime:from==null?{lte:to}:{gte:from,lte:to},status:'succeeded'}};
      if(token)opt.paginationToken=token;
      let r=await rpcCall('getTransactionsForAddress',[mint,opt]);
      const want=+(String(r.error||'').match(/maxSupportedTransactionVersion\W+(\d+)/)?.[1]);
      if(Number.isFinite(want)&&want>opt.maxSupportedTransactionVersion&&want<10){set('rpcTxVersion',want);opt.maxSupportedTransactionVersion=want;r=await rpcCall('getTransactionsForAddress',[mint,opt]);}
      if(r.status===429){await sleep(2500);r=await rpcCall('getTransactionsForAddress',[mint,opt]);}
      if(r.error)return {txs,pages,error:r.error,truncated:true};
      const res=r.data?.result;
      txs.push(...txList(res));
      if(!rpcSample&&txs.length)rpcSample=txs.find(t=>t?.meta&&!t.meta.err)||txs[0];
      token=res?.paginationToken||null;pages++;await sleep(120);
    }while(token&&pages<maxPages);
    return {txs,pages,truncated:!!token};
  }
  async function backfillOne(c){
    const t=Math.floor(c.messageAt/1000), w=await txWindow(c.mint,t-300,t+180);
    if(w.error&&!w.txs.length)return {err:w.error};
    const rows=w.txs.flatMap(tx=>VTCore.txTrades(tx,c.mint,solUsd));
    // Legs of in-transaction round trips have no SOL size: price them at the window's median price per token.
    const per=rows.filter(r=>r.usd>0&&r.amount>0).map(r=>r.usd/r.amount).sort((a,b)=>a-b), med=per.length?per[per.length>>1]:null;
    for(const r of rows)if(r.usd==null){r.usd=med!=null?r.amount*med:0;r.sol=solUsd>0?r.usd/solUsd:null;}
    const pre=VTCore.botFlow(rows,c.messageAt-300000,c.messageAt), post=VTCore.botFlow(rows,c.messageAt,c.messageAt+120000);
    // Transactions but no trades parsed: the transaction format may have changed. Keep one so the user can share it.
    if(w.txs.length&&!rows.length)rpcSample=w.txs.find(t=>t?.meta&&!t.meta.err)||w.txs[0];
    return {pre:packBots(pre,!w.truncated),post:packBots(post,!w.truncated),txs:w.txs.length,trades:rows.length,pages:w.pages,truncated:!!w.truncated,err:w.error||null};
  }
  async function testKey(){
    const st=$('rpc-status');if(!rpcUrl()){st.textContent='Add a key first.';return;}
    st.textContent='Testing…';await refreshSol();
    const c=btCandidates().filter(x=>Date.now()-x.messageAt>10*60000).sort((a,b)=>b.messageAt-a.messageAt)[0];
    if(!c){const r=await rpcCall('getSlot',[]);st.textContent=r.error?'Key error: '+r.error:'Key works (no past call to test the trade history on yet).';return;}
    const r=await backfillOne(c);
    const planHint=/method not found|not available|upgrade|your plan|paid plan/i.test(r.err||'')?' · this plan may not include getTransactionsForAddress':'';
    st.textContent=r.err?'Key error on '+c.name+': '+r.err+planHint
      :r.txs&&!r.trades?'Key works, but '+r.txs+' transactions on '+c.name+' gave 0 trades: the format may have changed. Press "Copy sample" and paste it to Claude.'
      :'Works: '+c.name+' · '+r.txs+' transactions → '+r.trades+' trades'+(r.truncated?' (window cut short)':'')+' · bots before the alert '+(r.pre.share??'—')+'%, first 2 min '+(r.post.share??'—')+'%';
    $('rpc-sample').hidden=!rpcSample;
  }
  let hbRunning=false,hbStop=false,hbNote='';
  async function runBackfill(){
    if(hbRunning){hbStop=true;hbNote='Stopping…';renderBt();return;}
    if(!rpcUrl()){hbNote='Add a Helius key in Settings first';renderBt();return;}
    hbRunning=true;hbStop=false;
    try{
      await refreshSol();
      const done=get('bt.done',{}), todo=btCandidates().filter(c=>done[c.id]==='ok'&&!get('hb.'+c.id,null)).sort((a,b)=>b.messageAt-a.messageAt);
      if(!todo.length){hbNote=btCandidates().some(c=>done[c.id]==='ok')?'Volume bots: every scored call already has a reading':'Score calls first: volume bots are added to scored calls';return;}
      for(let i=0;i<todo.length&&!hbStop;i++){
        hbNote='Volume bots: '+(i+1)+' of '+todo.length;renderBt();
        const r=await backfillOne(todo[i]);
        // Any error (even after some pages) stops the run without saving, so the call is retried next time.
        if(r.err){hbNote='Helius error on '+todo[i].name+': '+r.err+' (stopped; run again to retry)';return;}
        set('hb.'+todo[i].id,{...r,at:Date.now()});
      }
      hbNote=hbStop?'Volume bots: stopped; run again to continue':'Volume bots added: open the report';
    }finally{hbRunning=false;hbStop=false;renderBt();}
  }
  // ---- Rug checks (3.8): dev wallet, top 10 holders, launch-block wallets and the dev's funder ----
  // Built from the coin's own chain history (Helius getTransactionsForAddress, oldest first), then kept live on the GMGN
  // tab from GMGN's trade feed plus chain catch-ups. The rules are the Rugikk article's and untested: each call's values
  // at the alert are saved ('rug.<id>') so the backtest can test them. The live state and the saved record come from
  // the same scan, so they always match.
  // RUG_LAG: history read 3s after the alert (current-state reads start at once, see rugQuick). The at-call record is
  // saved once a transaction after the alert has been seen, or 20s after the alert (indexing has caught up by then).
  const RUG_LAG=3000, RUG_SAVE_AFTER=20000, RUG_PAGES=25, RUG_LIVE_MS=2*3600000, RUG_SALE_MS=10*60000;
  const rugLive=new Map(); // mint → {mint, call, S, prog, checked, status, err, at, startedAt, building, catching, lastCatch, tries, alerted…}
  let rugIdx=null, rugBusy=false, rcRunning=false, rcStop=false, rcNote='', rugRankCache={mint:null,ver:-1,rk:null,launch:null};
  const pctS=v=>v==null?'—':(v<1?v.toFixed(2):v<10?v.toFixed(1):v.toFixed(0))+'%', r2=v=>v==null?null:Math.round(v*100)/100;
  function callFor(mint){let best=null;for(const c of calls())if(c.mint===mint&&(!best||c.messageAt>best.messageAt))best=c;return best;}
  // The wallet that first sent SOL to the dev, from the dev wallet's earliest transactions.
  async function funderLookup(wallet,sec){
    if(!wallet)return null;
    const opt={transactionDetails:'full',sortOrder:'asc',limit:25,commitment:'confirmed',encoding:'jsonParsed',maxSupportedTransactionVersion:get('rpcTxVersion',1),filters:{status:'succeeded'}};
    if(sec!=null)opt.filters.blockTime={lte:sec};
    const r=await rpcCall('getTransactionsForAddress',[wallet,opt]);
    return r.error?{error:r.error}:VTCore.funderOf(txList(r.data?.result),wallet)||{funder:null};
  }
  // Which large holders are program accounts (bonding curve, AMM pool, lockers): those stay out of the top 10.
  async function rugPrograms(L,more=[]){
    const want=[...new Set([...L.S.atCall.holders,...VTCore.rugRanked(L.S,30)].map(h=>h[0]).concat(more))].filter(o=>o&&!L.checked.has(o)).slice(0,100);
    if(!want.length)return;
    const r=await rpcCall('getMultipleAccounts',[want,{encoding:'base64',dataSlice:{offset:0,length:0},commitment:'confirmed'}]), v=r.data?.result?.value;
    if(r.error||!Array.isArray(v)){L.progErr=r.error||'no result';return;}
    want.forEach((o,i)=>{L.checked.add(o);if(v[i]&&v[i].owner!==VTCore.SYSTEM_PROGRAM)L.prog.add(o);});
    L.progErr=null;
  }
  // Verified holders (4.1): the chain's own supply, largest token accounts (with owners) and the dev's token accounts.
  // A plain token Transfer never names the mint, so the mint's history can miss it; this is the check on the rebuild.
  // quick: no history yet (rugQuick): holders and supply only, no dev balance, no rebuild comparison.
  async function rugVerifyNow(L,quick=false){
    const S=L.S, startedAt=Date.now();
    L.verTried=startedAt;
    try{
      const [sup,big,dv]=await Promise.all([rpcCall('getTokenSupply',[L.mint,{commitment:'confirmed'}]),rpcCall('getTokenLargestAccounts',[L.mint,{commitment:'confirmed'}]),
        S.creator&&!quick?rpcCall('getTokenAccountsByOwner',[S.creator,{mint:L.mint},{encoding:'jsonParsed',commitment:'confirmed'}]):Promise.resolve({})]);
      const supply=+sup.data?.result?.value?.uiAmountString, accts=big.data?.result?.value;
      if(sup.error||big.error||!(supply>0)||!Array.isArray(accts)){L.verifyErr=sup.error||big.error||'no result';return;}
      const own=accts.length?await rpcCall('getMultipleAccounts',[accts.map(a=>a.address),{encoding:'jsonParsed',commitment:'confirmed'}]):{data:{result:{value:[]}}}, vals=own.data?.result?.value;
      if(own.error||!Array.isArray(vals)){L.verifyErr=own.error||'no owners';return;}
      const list=accts.map((a,i)=>({acct:a.address,owner:vals[i]?.data?.parsed?.info?.owner,amt:+a.uiAmountString})).filter(x=>x.owner&&x.amt>=0);
      const v=VTCore.rugVerify(S,list,supply);if(!v){L.verifyErr='no holders';return;}
      await rugPrograms(L,v.ranked.map(x=>x[0]));
      const dl=dv?.data?.result?.value, devAmt=Array.isArray(dl)?dl.reduce((t,x)=>t+(+x.account?.data?.parsed?.info?.tokenAmount?.uiAmountString||0),0):null;
      // startedAt/slot: what the balances include (sales after them come off); diff: the latest rebuild gap.
      const slot=dv?.data?.result?.context?.slot??big.data?.result?.context?.slot??null;
      L.ver={...v,diff:quick?null:v.diff,at:Date.now(),startedAt,slot,devPct:devAmt==null||quick?null:100*devAmt/supply};L.verifyErr=null;
      if(!quick&&L.firstGap==null)L.firstGap=v.diff;
    }catch(e){L.verifyErr=String(e?.message||e).slice(0,100);}
  }
  // A dev outflow: a sale when tokens went to the curve/pool (a program account) or came from GMGN's sell feed; a
  // transfer when every recipient is a checked ordinary wallet; otherwise "sold or moved".
  // Creator check for a chain state: the mint's initialisation, plus GMGN's creator when GMGN names one.
  const creatorOf=L=>VTCore.creatorCheck(L?.S,gmS.mint===L?.mint?gmS.G?.creator:null);
  const creatorOk=L=>VTCore.creatorUsable(creatorOf(L));
  function devKind(L,ev){
    if(ev.kind==='sale'||ev.to?.some(o=>L.prog.has(o)))return 'sale';
    return ev.to?.length&&ev.to.every(o=>L.checked.has(o)&&!L.prog.has(o))?'transfer':'out';
  }
  const DEV_VERB={sale:'sold',transfer:'moved',out:'sold or moved'};
  function noteDevWallets(L,evs){for(const ev of evs)if(devKind(L,ev)==='transfer'){L.devWallets=L.devWallets||new Set();for(const w of ev.to)L.devWallets.add(w);}}
  // Saved check: the values at the alert only (no lookahead), for the backtest and the Telegram ping.
  // holders: 'verified' (history complete and the rebuild matched the chain's own holders when compared), 'unchecked'
  // (never compared: e.g. history cut short) or 'mismatch' (dropped). creator: 'confirmed' | 'payer' | 'conflict' | 'none';
  // dev, launch-block and funder figures only for a usable creator. The report's tables use verified holders only.
  const HOLDER_GAP_MAX=VTCore.HOLDER_GAP_MAX;
  function rugRecord(call,L){
    const S=L.S, a=S.atCall, ok=!!L.atCallOk, f=L.funder, gap=L.firstGap??null, holders=VTCore.holderTrust(ok&&L.complete!==false,gap), cc=creatorOf(L), cOk=VTCore.creatorUsable(cc);
    const keep=ok&&holders!=='mismatch';
    return {v:3,done:true,t:call.messageAt,at:Date.now(),creator:S.creator,creatorCheck:cc,creatorVerified:cOk,createdAt:S.createSec!=null?S.createSec*1000:null,funder:cOk?f?.funder||null:null,funderSol:cOk?r2(f?.sol??null):null,
      top10:keep&&!L.progErr?r2(VTCore.rugTop(a.holders,S.supply,L.prog)):null,devPct:keep&&cOk?r2(a.devPct):null,devSold:keep&&cOk?a.devSold:null,devBuyPct:cOk?r2(S.devBuy):null,
      launchBuyers:cOk?S.launch.size:null,launchPct:cOk?r2(a.launch.bought):null,complete:ok,holders,holderGap:gap==null?null:r2(gap),txs:S.txs,pages:L.pages};
  }
  function saveRug(call,rec){
    set('rug.'+call.id,rec);
    if(!rec.done)return;
    const ids=get('rugIds',[]);
    if(!ids.includes(call.id)){ids.unshift(call.id);for(const old of ids.splice(2000))GM_deleteValue(PREFIX+'rug.'+old);set('rugIds',ids);}
    rugIdx=null;tgUpdate(call);
  }
  // Earlier calls (by alert time) whose saved check has the same dev or the same funder.
  // Built from the stored records themselves (not the id list), so a record saved by another site is never missed.
  function rugIndex(){
    if(rugIdx)return rugIdx;
    const ids=typeof GM_listValues==='function'?GM_listValues().filter(k=>k.startsWith(PREFIX+'rug.')).map(k=>k.slice(PREFIX.length+4)):get('rugIds',[]);
    rugIdx=[];for(const id of ids){const r=get('rug.'+id,null);if(r?.done&&!r.empty&&r.creatorVerified!==false&&r.creatorCheck!=='conflict')rugIdx.push({id,t:r.t,creator:r.creator,funder:r.funder});}
    return rugIdx;
  }
  function rugSeen(id,t,creator,funder){
    let dev=0,fund=0;
    for(const x of rugIndex()){if(x.id===id||!(x.t<t))continue;if(creator&&x.creator===creator)dev++;if(funder&&x.funder===funder)fund++;}
    return {dev,fund};
  }
  // At-call check without a live state (background calls, backfill): history up to the alert only.
  // At-call check without a live state (background calls, backfill): the history to now (the at-call snapshot is taken
  // on the way), then the rebuild is compared with the chain's own holders, so saved holder figures are verified or
  // marked unchecked. A coin with more history than RUG_PAGES pages stays unchecked (the at-call snapshot is still exact
  // if the pages got past the alert).
  async function rugCheck(c){
    const w=await txWindow(c.mint,null,Math.floor(Date.now()/1000),RUG_PAGES);
    if(w.error)return {err:w.error};
    const S=VTCore.rugScan(w.txs,c.mint,c.messageAt);
    if(!S.creator)return {v:3,done:true,empty:true,t:c.messageAt,at:Date.now(),complete:false,holders:'unchecked',pages:w.pages};
    const L={mint:c.mint,S,prog:new Set(),checked:new Set(),complete:!w.truncated,atCallOk:!w.truncated||S.crossed,pages:w.pages};
    await rugPrograms(L);
    if(L.complete)await rugVerifyNow(L);
    L.funder=S.verified?await funderLookup(S.creator,S.createSec):null;
    return rugRecord(c,L);
  }
  // Live state for a coin on this GMGN tab: full history to now (the at-call snapshot is taken on the way), then GMGN's
  // feed and chain catch-ups keep it current.
  async function rugBuild(mint,call,tries=0){
    if(!rpcUrl()||rugLive.get(mint)?.building)return;
    const Q=rugQuickMap.get(mint), L={mint,call:call||null,S:null,prog:new Set(Q?.prog||[]),checked:new Set(Q?.checked||[]),status:'checking',at:Date.now(),startedAt:Date.now(),building:true,lastCatch:0,tries,alerted:{},noted:{}};
    rugLive.set(mint,L);soon();
    try{
      const w=await txWindow(mint,null,Math.floor(Date.now()/1000),RUG_PAGES);
      if(w.error){L.status='error';L.err=w.error;return;}
      const S=VTCore.rugScan(w.txs,mint,call?call.messageAt:Date.now());
      if(!S.creator){L.status='error';L.err='no transactions found for this coin yet';return;}
      // A busy coin stops after RUG_PAGES pages: the at-call snapshot is still exact if the fetch got past the alert,
      // but the live holder state is not (dev sells from GMGN's feed still show).
      L.S=S;L.complete=!w.truncated;L.atCallOk=!w.truncated||S.crossed;L.pages=w.pages;
      await rugPrograms(L,S.devSales.flatMap(e=>e.to||[]));
      // Check the rebuild against the chain's own holders before anything is saved or scored.
      await rugVerifyNow(L);
      L.funder=S.verified?await funderLookup(S.creator,S.createSec):null;
      noteDevWallets(L,S.devSales);
      // Trades already seen on this tab that are newer than the chain read (older ones are in it; the signature check
      // catches the rest, e.g. trades loaded from GMGN's trades list).
      if(live?.mint===mint)for(const t of live.trades)if(t.at>=(S.lastSec??0)*1000)rugFeed(L,t);
      L.status='ok';L.at=Date.now();L.lastCatch=Date.now();
      for(const ev of S.devSales)devAlert(L,ev);
      latMark(mint,'chain');
      if(call&&!call.manual&&!call.unverified&&!get('rug.'+call.id,null)?.done){if(S.crossed||Date.now()-call.messageAt>RUG_SAVE_AFTER)saveRug(call,rugRecord(call,L));else L.pendingSave=true;}
    }catch(e){L.status='error';L.err=String(e?.message||e).slice(0,120);}
    finally{L.building=false;soon();}
  }
  // Current state at once (no history needed): the chain's own largest holders and supply, for a provisional top 10.
  const rugQuickMap=new Map();
  async function rugQuick(mint){
    if(rugQuickMap.has(mint))return;
    const Q={mint,S:VTCore.rugState(mint),prog:new Set(),checked:new Set(),startedAt:Date.now()};Q.S.atCall={holders:[]};rugQuickMap.set(mint,Q);
    await rugVerifyNow(Q,true);
    if(Q.ver)latMark(mint,'chainQuick');
    soon();
  }
  // GMGN tab: check the call on screen as soon as the chain has it; retry a failed check up to 3 times.
  function rugAuto(){
    if(!GMGN||!current||!rpcUrl())return;
    const L=rugLive.get(current), c=callFor(current);
    if(!L&&c&&!c.historical&&!c.manual&&!c.unverified)rugQuick(current);
    if(L){if(L.status==='error'&&!L.building&&L.tries<2&&Date.now()-L.at>20000)rugBuild(current,L.call,L.tries+1);return;}
    if(!c||!c.historical&&!c.manual&&Date.now()-c.messageAt<RUG_LAG)return;
    rugBuild(current,c);
  }
  async function rugCatchUp(L){
    L.catching=true;
    try{
      const w=await txWindow(L.mint,L.S.lastSec,Math.floor(Date.now()/1000),5);
      // More than 500 new transactions: carry on from where this stopped on the next tick.
      if(w.error&&!w.txs.length){L.catchErr=w.error;return;}
      L.lastCatch=w.truncated?0:Date.now();L.catchOk=Date.now();
      L.catchErr=null;
      const evs=VTCore.rugCatch(L.S,w.txs);
      await rugPrograms(L,evs.flatMap(e=>e.to||[]));noteDevWallets(L,evs);
      for(const ev of evs)devAlert(L,ev);
      await rugVerifyNow(L);
      // At-call record held back until indexing caught up past the alert.
      if(L.pendingSave&&L.call&&(L.S.crossed||Date.now()-L.call.messageAt>RUG_SAVE_AFTER)){L.pendingSave=false;L.atCallOk=L.complete||L.S.crossed;if(!get('rug.'+L.call.id,null)?.done)saveRug(L.call,rugRecord(L.call,L));}
    }finally{L.catching=false;soon();}
  }
  // GMGN's feed carries every trade while it is connected; the chain catch-up adds transfers and fixes drift every 2 min,
  // or every 20s when the feed is quiet or disconnected. Only for a complete state, for 2h after the check.
  function rugCatchTick(){
    const L=current&&rugLive.get(current);
    if(!L?.S||L.status!=='ok'||L.catching||!rpcUrl()||document.hidden||Date.now()-L.startedAt>RUG_LIVE_MS)return;
    // History cut short (busy coin): no rebuild to catch up, but the chain's own figures are re-read every minute.
    if(!L.complete){if(!L.verifying&&Date.now()-(L.verTried||0)>60000){L.verifying=true;rugVerifyNow(L).finally(()=>{L.verifying=false;soon();});}return;}
    // A held-back at-call record gets a catch-up as soon as the 20s have passed.
    const due=L.pendingSave&&L.call&&Date.now()-L.call.messageAt>RUG_SAVE_AFTER&&Date.now()-L.lastCatch>5000;
    if(!due&&Date.now()-L.lastCatch<(Date.now()-VTLive.lastFrame()<15000?120000:20000))return;
    rugCatchUp(L);
  }
  function rugFeed(L,t){
    if(!L?.S||!t)return null;
    return VTCore.rugTrade(L.S,{wallet:t.wallet,side:t.side,tokens:VTCore.tradeTokens(t),hash:t.hash,at:t.at});
  }
  // A dev sale after the call (or after a manual check started), seen within the last 10 min: flash, notify, Telegram.
  // Notifications: the first sale, the moment the dev is out, and at most one a minute in between.
  function devAlert(L,ev){
    const S=L.S, key=ev.sig||String(ev.at);
    if(!ev||L.alerted[key]||!creatorOk(L))return;
    L.alerted[key]=1;
    const since=L.call&&!L.call.historical&&!L.call.manual?L.call.messageAt:L.startedAt;
    if(!(ev.at>=since-1000)||Date.now()-ev.at>RUG_SALE_MS)return;
    const left=L.complete?100*Math.max(0,VTCore.rugHolding(S,S.creator))/S.supply:null, out=left!=null&&left<VTCore.RUG.outFrac*100, kind=devKind(L,ev);
    const name=L.call?.name||L.mint.slice(0,4)+'…'+L.mint.slice(-4);
    const text='Dev '+DEV_VERB[kind]+' '+pctS(100*ev.amt/S.supply)+' of supply'+(kind==='transfer'?' to wallet …'+ev.to[0].slice(-4):'')+(left==null?'':out?'. The dev wallet is empty.':', '+pctS(left)+' left');
    if(L.mint===current)flash();
    const now=Date.now(), first=!L.noted.first, outNow=out&&!L.noted.out;
    if(!first&&!outNow&&now-(L.noted.at||0)<60000)return;
    L.noted.first=1;if(out)L.noted.out=1;L.noted.at=now;
    GM_notification({title:(kind==='transfer'?'Dev moving tokens · ':'Dev selling · ')+name,text,timeout:10000});
    if(L.call&&get('tgDev',true)&&tgReady()&&(first||outNow))tgSend((kind==='transfer'?'Dev moving tokens: ':'Dev selling: ')+name+'\n'+text+'\n'+VTCore.gmgnURL(L.mint));
  }
  // Background checks for live calls that are not on a GMGN screen. One runner: the GMGN receiver when there is one,
  // else a Discord tab. The GMGN tab checks the coin on its own screen itself (rugBuild).
  const rugDue=(r,now)=>!r||(!r.done&&(r.pending?now-r.pending>90000:(r.tries||0)<3&&now-(r.failedAt||0)>30000));
  async function rugTick(){
    if(rugBusy||!rpcUrl()||rcRunning)return;
    if(GMGN?!isReceiver:receiverAlive(receiver()))return;
    const now=Date.now(), due=calls().filter(c=>!c.historical&&!c.manual&&!c.unverified&&now-c.messageAt>=RUG_LAG&&now-c.messageAt<15*60000&&!(GMGN&&c.mint===current)&&rugDue(get('rug.'+c.id,null),now));
    if(!due.length)return;
    const c=due.sort((a,b)=>b.messageAt-a.messageAt)[0], prev=get('rug.'+c.id,null);
    rugBusy=true;
    try{
      set('rug.'+c.id,{pending:now,tries:prev?.tries||0});
      const r=await rugCheck(c);
      if(r.err)set('rug.'+c.id,{failedAt:Date.now(),tries:(prev?.tries||0)+1,err:r.err});else saveRug(c,r);
    }catch(e){set('rug.'+c.id,{failedAt:Date.now(),tries:(prev?.tries||0)+1,err:String(e?.message||e).slice(0,120)});}
    finally{rugBusy=false;}
  }
  async function runRugBackfill(){
    if(rcRunning){rcStop=true;rcNote='Stopping…';renderBt();return;}
    if(!rpcUrl()){rcNote='Add a Helius key in Settings first';renderBt();return;}
    rcRunning=true;rcStop=false;
    try{
      const done=get('bt.done',{}), todo=btCandidates().filter(c=>done[c.id]==='ok'&&!(get('rug.'+c.id,null)?.v>=3)).sort((a,b)=>b.messageAt-a.messageAt);
      if(!todo.length){rcNote=btCandidates().some(c=>done[c.id]==='ok')?'Rug checks: every scored call already has one':'Score calls first: rug checks are added to scored calls';return;}
      for(let i=0;i<todo.length&&!rcStop;i++){
        rcNote='Rug checks: '+(i+1)+' of '+todo.length;renderBt();
        const r=await rugCheck(todo[i]);
        if(r.err){rcNote='Helius error on '+todo[i].name+': '+r.err+' (stopped; run again to retry)';return;}
        saveRug(todo[i],r);
      }
      rcNote=rcStop?'Rug checks: stopped; run again to continue':'Rug checks added: open the report';
    }finally{rcRunning=false;rcStop=false;renderBt();}
  }
  // Recent dev sales on the coin on screen, as RISK lines.
  function rugRisks(now){
    const L=current&&rugLive.get(current), S=L?.S;
    if(!S||!creatorOk(L)||!S.devSales.length)return [];
    const last=S.devSales[S.devSales.length-1];
    if(!(now-(last.at||0)<RUG_SALE_MS))return [];
    const total=100*S.devSales.reduce((t,x)=>t+x.amt,0)/S.supply, left=L.complete?100*Math.max(0,VTCore.rugHolding(S,S.creator))/S.supply:null;
    const kinds=new Set(S.devSales.map(e=>devKind(L,e))), verb=kinds.size===1?DEV_VERB[[...kinds][0]]:'sold or moved';
    return ['Dev '+verb+' '+pctS(total)+' of supply'+(S.devSales.length>1?' in '+S.devSales.length+' transactions':'')+' · last '+sinceText(now-last.at).slice(1)+' ago'+(left==null?'':left<VTCore.RUG.outFrac*100?' · dev wallet empty':' · '+pctS(left)+' left')];
  }
  // Chain checks for the coin on screen → {gradeIn, detail} for the score, or {wait, busy} while not ready. No DOM.
  function rugView(c,now){
    const L=rugLive.get(current), isCall=!!c&&!c.manual;
    if(!rpcUrl())return {wait:'add a Helius key for chain checks',noKey:true};
    const Q=rugQuickMap.get(current), qTop=Q?.ver&&now-Q.ver.at<=300000&&!Q.progErr?VTCore.rugTop(Q.ver.ranked,Q.ver.supply,Q.prog):null;
    if(!L?.S&&qTop!=null){
      const base={detail:{top10:'≈'+pctS(qTop)+' (chain, provisional)'},titles:{top10:'Read from the chain’s 20 largest accounts at once; the full check (dev, launch block, funder) follows.'},src:'chain provisional',
        gradeIn:{top10:qTop,top10Approx:true},quick:true};
      if(L?.status==='checking')return {...base,busy:true,wait:'reading the history '+Math.round((now-L.startedAt)/1000)+'s'};
      if(!L)return {...base,busy:true,wait:'history in '+Math.max(0,Math.ceil((RUG_LAG-(now-(callFor(current)?.messageAt||now)))/1000))+'s'};
    }
    if(!L?.S){
      if(L?.status==='checking')return {busy:true,wait:'reading the chain '+Math.round((now-L.startedAt)/1000)+'s'};
      if(L?.status==='error')return {wait:'chain check failed: '+L.err+(L.tries<2?' · retrying':''),retry:L.tries>=2};
      if(c&&!c.historical&&!c.manual&&now-c.messageAt<RUG_LAG)return {busy:true,wait:'chain check in '+Math.ceil((RUG_LAG-(now-c.messageAt))/1000)+'s'};
      if(c)return {busy:true,wait:'starting the chain check'};
      return {wait:'not a VolTrak call',manual:true};
    }
    const S=L.S, sup=L.ver?.supply||S.supply, a=S.atCall, cc=creatorOf(L), cOk=VTCore.creatorUsable(cc);
    if(rugRankCache.mint!==current||rugRankCache.ver!==S.ver)rugRankCache={mint:current,ver:S.ver,rk:VTCore.rugRanked(S,40),launch:VTCore.rugLaunch(S)};
    // Three separate states: fetched (L.complete), verified (the chain's own figures, read in the last 5 min), current
    // (the rebuild, only while its latest comparison matched and it was caught up in the last 5 min). The live score
    // takes current figures only; at-call figures are shown apart and never stand in for them.
    const verified=!!L.ver&&now-L.ver.at<=300000, trustNow=VTCore.holderTrust(!!L.complete,L.ver?.diff??null);
    // The rebuild's own clock: its last successful catch-up (a live trade does not prove transfers were caught).
    const chainAt=L.catchOk||L.at||0, rebuildNow=trustNow==='verified'&&now-chainAt<=300000;
    const topNow=L.progErr?null:verified?VTCore.rugTop(L.ver.ranked,sup,L.prog):rebuildNow?VTCore.rugTop(rugRankCache.rk,S.supply,L.prog):null;
    const callTrust=VTCore.holderTrust(!!L.atCallOk&&!!L.complete,L.firstGap??null);
    const topCall=isCall&&L.atCallOk&&!L.progErr&&callTrust!=='mismatch'?VTCore.rugTop(a.holders,S.supply,L.prog):null;
    const sales=S.devSales, lastSale=sales[sales.length-1], recent=!!lastSale&&now-(lastSale.at||0)<RUG_SALE_MS;
    // Dev now: the chain's own balance less sales after it was read; else the trusted rebuild. Never the lower of the two.
    const devNow=!cOk?null:verified?VTCore.devNowVerified(L.ver,S.devFlows,sup):rebuildNow?100*Math.max(0,VTCore.rugHolding(S,S.creator))/S.supply:null;
    const devCall=cOk&&isCall&&L.atCallOk&&callTrust!=='mismatch'?a.devPct:null;
    const soldPct=100*sales.reduce((t,x)=>t+x.amt,0)/sup, out=devNow!=null&&devNow<VTCore.RUG.outFrac*100&&sales.length>0;
    const ln=rugRankCache.launch, n=cOk?ln.wallets:null;
    const f=L.funder, seen=f?.funder?rugSeen(isCall?c.id:null,isCall?c.messageAt:Infinity,S.creator,f.funder):{dev:0,fund:0};
    const kinds=new Set(sales.map(e=>devKind(L,e))), verb=kinds.size===1?DEV_VERB[[...kinds][0]]:'sold or moved';
    const callNote=v=>v==null?null:'call '+pctS(v)+', not scored';
    const detail={
      top10:topNow!=null?pctS(topNow)+(topCall!=null&&Math.abs(topNow-topCall)>=1?' (call '+pctS(topCall)+')':''):callNote(topCall),
      dev:devNow!=null?(out?'empty · '+verb+' '+pctS(soldPct):pctS(devNow)+(sales.length?' · '+verb+' '+pctS(soldPct)+(lastSale.at?' '+sinceText(now-lastSale.at).slice(1)+' ago':''):'')):callNote(devCall),
      launch:n==null?null:n+' wallet'+(n===1?'':'s')+(n?' · hold '+pctS(ln.held):''),
      repeat:!cOk?null:f?.error?null:!f?.funder?'no funder found':seen.dev?'same dev':seen.fund?'funder seen '+seen.fund+'×':'new'};
    const creatorTxt={confirmed:'Dev wallet (declared in pump.fun’s creation instruction; GMGN agrees) ',pump:'Dev wallet (declared in pump.fun’s creation instruction) ',payer:'Fee payer of the creation (not pump.fun: not verified, so GMGN’s dev % is used) ',conflict:'Creator CONFLICT: GMGN names a different creator than pump.fun’s instruction ',none:'Creator NOT verified (no initializeMint in the first transaction) '}[cc];
    const titles={dev:creatorTxt+S.creator+(S.devBuy!=null&&cOk?' · bought '+pctS(S.devBuy)+' at launch':'')+(L.devWallets?.size?' · moved tokens to '+L.devWallets.size+' wallet(s), counted as dev wallets':'')
        +(verified?' · balance from the chain, read '+sinceText(now-L.ver.at).slice(1)+' ago':''),
      launch:'Wallets besides the dev that bought in the launch block: bought '+pctS(ln.bought)+', hold '+pctS(ln.held)+(ln.sold?', '+ln.sold+' dumped':''),
      repeat:f?.funder?'First wallet to send the dev SOL: '+f.funder+(f.sol!=null?' ('+f.sol.toFixed(2)+' SOL)':''):'',
      top10:'Ten largest holders that are not the bonding curve, a pool or another program account. '+(verified?'From the chain’s own largest accounts, read '+sinceText(now-L.ver.at).slice(1)+' ago.':rebuildNow?'Rebuilt from the coin’s transactions (matched the chain when last compared).':'No current figure.')
        +(L.ver?.diff!=null?' Latest rebuild gap: '+pctS(L.ver.diff)+' of supply.':'')};
    const src=verified?'chain verified':rebuildNow?'chain rebuilt':!L.complete?'chain: at the call':'chain not current';
    const note=[L.catchErr?'Chain catch-up failed: '+L.catchErr+'.':'',L.verifyErr?'Holder check failed: '+L.verifyErr+'.':'',
      !cOk?(cc==='conflict'?'GMGN names a different creator than the chain':cc==='payer'?'Not a pump.fun launch: the creator is only the fee payer':'Creator not verified')+': chain dev, launch block and funder checks are off for this coin.':'',
      trustNow==='mismatch'?'Rebuilt holders were off by '+pctS(L.ver.diff)+' of supply; only the chain’s own figures are used.':'',
      !verified&&!rebuildNow?'No current chain figures (last read over 5 min ago or not matched): top 10 and dev % are not scored.':''].filter(Boolean).join(' ');
    return {S,L,src,note,detail,titles,unverified:[...(cOk?[]:[cc==='payer'?'dev from the fee payer only (not pump.fun)':'creator not verified']),...(trustNow==='unchecked'&&!verified?['holders not checked against the chain']:[])],conflict:cc==='conflict'?['GMGN names a different creator']:[],
      stale:!verified&&!rebuildNow&&L.S?['chain figures over 5 min old']:[],gradeIn:{top10:topNow,top10Approx:verified&&topNow!=null,devPct:devNow,devSoldRecent:cOk&&recent&&[...sales].reverse().some(e=>now-(e.at||0)<RUG_SALE_MS&&devKind(L,e)!=='transfer'),devSoldBefore:cOk&&sales.length>0,
      sameDev:cOk&&f?.funder?seen.dev>0:null,funderSeen:cOk&&f?.funder?seen.fund:null,launchBuyers:n}};
  }
  // ---- GMGN's own token data (3.9): read by this GMGN tab for the coin on screen ----
  // Right away when a coin opens, every 5s for its first 3 minutes (after the alert or after opening it), then every
  // 15s. A rate limit pauses it for 60s. Same-origin requests from the GMGN page; nothing is sent anywhere else.
  const GMX={fast:5000,slow:15000,fastFor:180000};
  // at = last successful read (data age), tried = last attempt (scheduling). Data older than GM_MAX is not used.
  const GM_MAX=60000;
  // parts: each GMGN response with its own time; the parsed view only uses parts read in the last GM_MAX.
  const GM_PARTS={stat:'token stats',holderStat:'holder tags',topBuyers:'first buyers',info:'token info',holders:'holder list'};
  let gmS={mint:null,G:null,at:0,tried:0,opened:0,busy:false,err:null,pauseTill:0,hist:[],exits:[],exitKeys:new Set(),noted:{},group:null,parts:{},view:null};
  function gmReset(mint){gmS={mint,G:null,at:0,tried:0,opened:Date.now(),busy:false,err:null,pauseTill:gmS.pauseTill||0,hist:[],exits:[],exitKeys:new Set(),noted:{},group:null,parts:{},view:null};}
  function gmFresh(now=Date.now()){
    if(gmS.mint!==current)return null;
    const fresh=Object.entries(gmS.parts).filter(([,v])=>now-v.at<=GM_MAX), key=fresh.map(([k,v])=>k+v.at).join('|');
    if(!fresh.length)return null;
    if(gmS.view?.key!==key)gmS.view={key,G:VTCore.gmgnParse(Object.fromEntries(fresh.map(([k,v])=>[k,v.data])))};
    return gmS.view.G;
  }
  // GMGN parts that were read once but are now older than GM_MAX (shown in Confidence).
  const gmStale=(now=Date.now())=>gmS.mint!==current?[]:Object.entries(gmS.parts).filter(([,v])=>now-v.at>GM_MAX).map(([k,v])=>'GMGN '+GM_PARTS[k]+' '+Math.round((now-v.at)/1000)+'s old');
  function gmGet(path,opt={}){
    const done=(resolve,status,text)=>{let j=null;try{j=JSON.parse(text);}catch(_){}
      resolve(status===429||status===403?{limited:true,status}:j&&j.code===0?{data:j}:{status,error:j?.message||'HTTP '+status});};
    return new Promise(resolve=>{
      const ctl=typeof AbortController!=='undefined'?new AbortController():null, t=setTimeout(()=>ctl?.abort(),8000);
      // The page's own origin first (cookies included); GM_xmlhttpRequest if this context cannot fetch.
      fetch(path,{credentials:'include',...opt,signal:ctl?.signal}).then(r=>r.text().then(x=>done(resolve,r.status,x)))
        .catch(()=>GM_xmlhttpRequest({method:opt.method||'GET',url:'https://gmgn.ai'+path,headers:{Accept:'application/json',...(opt.headers||{})},data:opt.body,timeout:8000,
          onload:r=>done(resolve,r.status,r.responseText),onerror:()=>resolve({error:'network error'}),ontimeout:()=>resolve({error:'timeout'})}))
        .finally(()=>clearTimeout(t));
    });
  }
  // Five reads at once; each one is used the moment it arrives (a slow endpoint does not hold the others back).
  async function gmPull(mint){
    gmS.busy=true;gmS.tried=Date.now();
    const b='/sol/'+mint, reqs={stat:gmGet('/api/v1/token_stat'+b),holderStat:gmGet('/vas/api/v1/token_holder_stat'+b),topBuyers:gmGet('/api/v1/tokens/top_buyers'+b),
      info:gmGet('/api/v1/mutil_window_token_info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chain:'sol',addresses:[mint]})}),
      holders:gmGet('/vas/api/v1/token_holders'+b+'?limit=100&orderby=amount_percentage&direction=desc')};
    let ok=0, limited=false, firstErr=null;
    await Promise.all(Object.entries(reqs).map(([k,pr])=>pr.then(r=>{
      if(gmS.mint!==mint)return;
      if(r.limited){limited=true;return;}
      if(!r.data){firstErr=firstErr||r.error;return;}
      ok++;const at=Date.now();gmS.parts[k]={data:r.data,at};gmS.at=at;
      // Unfiltered view of everything read so far (for non-scoring uses: supply, creator); scoring uses gmFresh().
      gmS.G=VTCore.gmgnParse(Object.fromEntries(Object.entries(gmS.parts).map(([q,v])=>[q,v.data])));
      if(k==='stat'&&gmS.G.holders!=null){gmS.hist.push({t:at,h:gmS.G.holders});gmS.hist=gmS.hist.filter(x=>at-x.t<=15*60000);}
      latMark(mint,'gmgn');soon();
    }).catch(e=>{firstErr=firstErr||String(e?.message||e).slice(0,80);})));
    if(gmS.mint===mint){
      if(limited)gmS.pauseTill=Date.now()+60000;
      gmS.err=!ok?(limited?'GMGN rate limit: paused 60s':'GMGN data unavailable ('+(firstErr||'no data')+')'):ok<5?(5-ok)+' of 5 GMGN reads failed this round'+(!reqs.holders||!gmS.parts.holders||Date.now()-gmS.parts.holders.at>GM_MAX?' (holder list missing: insider bag unknown)':''):null;
    }
    gmS.busy=false;soon();
  }
  function gmTick(){
    if(!GMGN||!current||!get('gmOn',true))return;
    if(gmS.mint!==current)gmReset(current);
    if(gmS.busy||Date.now()<gmS.pauseTill||(document.hidden&&!isReceiver))return;
    const c=callFor(current), since=Math.min(Date.now()-gmS.opened,c&&!c.historical?Date.now()-c.messageAt:Infinity);
    if(gmS.tried&&Date.now()-gmS.tried<(since<GMX.fastFor?GMX.fast:GMX.slow))return;
    gmPull(current);
  }
  // Insider group for the coin on screen: GMGN's tagged holders + funder cluster + the dev and launch-block wallets.
  function gmGroup(){
    // The dev, its launch block and the wallets it moved tokens to: only with a usable creator. Dev % from the chain's own
    // figure when verified (the rebuild can miss a plain transfer).
    const L=rugLive.get(current), S=L?.S, extra=[], pct=w=>S?.supply?100*Math.max(0,VTCore.rugHolding(S,w))/S.supply:0;
    if(S&&creatorOk(L)){
      const verDev=L.ver&&Date.now()-L.ver.at<=300000?VTCore.devNowVerified(L.ver,S.devFlows,L.ver.supply):null;
      extra.push({w:S.creator,role:'dev',pct:verDev??pct(S.creator)});
      for(const [w] of S.launch)extra.push({w,role:'launch block',pct:pct(w)});
      for(const w of L.devWallets||[])extra.push({w,role:'dev wallet',pct:pct(w)});
    }
    const G=gmFresh();
    return gmS.group=G||extra.length?VTCore.insiderGroup(G,extra):null;
  }
  // ---- Speed (4.3): per call, when each stage first happened (GMGN side; Discord's detection is the call's receivedAt
  // and the Telegram ping time is in its tg record). One record per call, fields only ever set once.
  const latSeen=new Set();
  function latMark(mint,field){
    if(!GMGN||!mint)return;
    const c=callFor(mint);if(!c||c.historical||c.manual||c.unverified||Date.now()-c.messageAt>15*60000)return;
    const seen=c.id+'|'+field;if(latSeen.has(seen))return;latSeen.add(seen);
    const k='lat.'+c.id, had=get(k,null), r=had||{t:c.messageAt};if(r[field])return;r[field]=Date.now();set(k,r);
    // A new record: drop ones over 48h old.
    if(!had)try{for(const key of GM_listValues())if(key.startsWith(PREFIX+'lat.')&&Date.now()-(GM_getValue(key,null)?.t||0)>48*3600000)GM_deleteValue(key);}catch(_){}
  }
  const LAT_STAGES=[['detected','Seen on Discord'],['handoff','GMGN tab got it'],['open','Coin open on GMGN'],['feed','First live trade'],['gmgn','First GMGN data'],['chainQuick','Chain top 10'],['grade','First grade'],['chain','Full chain check'],['quote','Exit quote'],['tg','Telegram ping']];
  let speedCache={at:0,rows:null};
  function speedRows(){
    if(Date.now()-speedCache.at<3000&&speedCache.rows)return speedCache.rows;
    const list=calls().filter(c=>!c.historical&&!c.manual&&!c.unverified).sort((a,b)=>b.messageAt-a.messageAt).slice(0,20), vals=Object.fromEntries(LAT_STAGES.map(([k])=>[k,[]]));
    for(const c of list){
      const r=get('lat.'+c.id,null)||{}, tgr=get('tg.'+c.id,null);
      const at={...r,detected:c.receivedAt,tg:tgr?.at};
      for(const [k] of LAT_STAGES)if(at[k]>0&&at[k]>=c.messageAt-5000)vals[k].push((at[k]-c.messageAt)/1000);
    }
    const med=a=>{const s=[...a].sort((x,y)=>x-y);return s.length?s.length%2?s[s.length>>1]:(s[s.length/2-1]+s[s.length/2])/2:null;};
    speedCache={at:Date.now(),rows:LAT_STAGES.map(([k,l])=>({k,l,n:vals[k].length,med:med(vals[k]),max:vals[k].length?Math.max(...vals[k]):null})),n:list.length};
    return speedCache.rows;
  }
  function renderSpeed(){
    const box=$('speed');if(!box)return;
    const rows=speedRows(), f=v=>v==null?'n/a':v<10?v.toFixed(1)+'s':Math.round(v)+'s', cells=[];
    for(const r of rows){if(!r.n)continue;cells.push(node('span','l',r.l),node('span','',f(r.med)),node('span','',f(r.max)));}
    box.replaceChildren(...(cells.length?[node('span','h','Stage'),node('span','h','Median'),node('span','h','Slowest'),...cells]:[node('span','l','No live calls timed yet')]));
  }
  // ---- Exit cost (4.3): a Jupiter quote to buy at your size, then one to sell what that buys back ----
  // The gap is the round trip: pool fees plus price impact both ways (not GMGN's own fee or priority fees). No route on
  // Jupiter means unknown here, not unsellable. Every 15s for the coin on screen.
  const JUP='https://lite-api.jup.ag/swap/v1/quote', WSOL=VTCore.WSOL_MINT;
  let jupS={mint:null,at:0,tried:0,busy:false,res:null};
  async function jupTick(){
    if(!GMGN||!current||!get('jupOn',true)||jupS.busy||document.hidden&&!isReceiver)return;
    if(jupS.mint!==current)jupS={mint:current,at:0,tried:0,busy:false,res:null};
    if(Date.now()-jupS.tried<15000)return;
    const mint=current, size=Math.max(0.001,+get('tradeSol',0.1)||0.1), lam=Math.round(size*1e9);
    jupS.busy=true;jupS.tried=Date.now();
    try{
      const buy=await http(JUP+'?inputMint='+WSOL+'&outputMint='+mint+'&amount='+lam+'&slippageBps=2500');
      let res;
      if(!(buy.data?.outAmount>0))res={noRoute:'buy',status:buy.status};
      else{
        const sell=await http(JUP+'?inputMint='+mint+'&outputMint='+WSOL+'&amount='+buy.data.outAmount+'&slippageBps=2500');
        res=sell.data?.outAmount>0?{roundTrip:100*(1-sell.data.outAmount/lam),size,route:[...new Set([...(buy.data.routePlan||[]),...(sell.data.routePlan||[])].map(r=>r.swapInfo?.label).filter(Boolean))].join(', ')}:{noRoute:'sell',status:sell.status};
      }
      if(jupS.mint===mint){jupS.res={...res,at:Date.now()};jupS.at=Date.now();if(res.roundTrip!=null)latMark(mint,'quote');}
    }finally{jupS.busy=false;soon();}
  }
  // ---- RugCheck (4.3): its own findings, kept separate (never mixed into the score) ----
  // On a coin still on the pump.fun curve, RugCheck's holder-concentration findings are about the curve itself.
  let rcS={mint:null,at:0,busy:false,res:null};
  async function rcTick(){
    if(!GMGN||!current||!get('rcOn',true)||rcS.busy)return;
    if(rcS.mint===current&&Date.now()-rcS.at<300000)return;
    rcS={mint:current,at:Date.now(),busy:true,res:rcS.mint===current?rcS.res:null};const mint=current;
    try{const r=await http('https://api.rugcheck.xyz/v1/tokens/'+mint+'/report/summary');if(rcS.mint===mint)rcS.res=r.data&&Array.isArray(r.data.risks)?{risks:r.data.risks,score:r.data.score_normalised??null}:{err:r.status||'no answer'};}
    finally{rcS.busy=false;soon();}
  }
  // A sell by an insider wallet (GMGN's feed): logged for the "leaving together" check.
  function gmOnTrade(t,mint){
    if(t.side!=='sell'||!t.wallet||gmS.mint!==mint)return;
    const L=rugLive.get(mint), role=gmS.group?.wallets.get(t.wallet)?.role||(L?.S?.creator===t.wallet?'dev':L?.S?.launch.has(t.wallet)?'launch block':null)
      ||(live.mint===mint?VTCore.roleOfTags(live.prof.get(t.wallet)?.tokenTags):null);
    if(!role)return;
    const sup=gmS.G?.supply||L?.ver?.supply||L?.S?.supply, tok=VTCore.tradeTokens(t), key=(t.hash||t.at)+'|'+t.wallet;
    if(!(sup>0)||!(tok>0)||gmS.exitKeys.has(key))return;
    gmS.exitKeys.add(key);gmS.exits.push({at:t.at,w:t.wallet,role,pct:100*tok/sup});
    gmS.exits=gmS.exits.filter(e=>Date.now()-e.at<=600000);
    const ex=VTCore.exitStats(gmS.exits,Date.now());
    if(ex.coordinated)insiderAlert(ex,mint);
  }
  function insiderAlert(ex,mint){
    const now=Date.now();if(now-(gmS.noted.exit||0)<120000)return;gmS.noted.exit=now;
    const c=callFor(mint), name=c?.name||mint.slice(0,4)+'…'+mint.slice(-4), text=ex.wallets+' insider wallet'+(ex.wallets===1?'':'s')+' sold '+pctS(ex.pct)+' of supply in 2 min ('+ex.roles.join(', ')+')';
    if(mint===current)flash();
    GM_notification({title:'Insiders exiting · '+name,text,timeout:10000});
    if(c&&get('tgDev',true)&&tgReady())tgSend('Insiders exiting: '+name+'\n'+text+'\n'+VTCore.gmgnURL(mint));
  }
  // Live score for the coin on screen: GMGN numbers + chain checks + volume bots.
  function liveScore(rv,vb,now,move){
    const G=gmFresh(now), gi=rv?.gradeIn||{}, grp=gmGroup(), ex=VTCore.exitStats(gmS.mint===current?gmS.exits:[],now);
    // GMGN's holder list is up to 15s old: take off insider sells seen since it was read.
    // (Chain-tracked wallets are already live, so only GMGN-listed ones are adjusted.)
    const soldSince=gmS.exits.filter(e=>e.at>gmS.at&&grp?.wallets.get(e.w)?.src==='gmgn').reduce((t,e)=>t+Math.min(e.pct,grp.wallets.get(e.w).pct),0);
    const old=G?gmS.hist.find(x=>gmS.at-x.t>=240000&&gmS.at-x.t<=420000):null;
    // Insider bag only with GMGN's holder list (complete): the chain wallets alone (dev, launch block) are not the bag.
    const x={exit:ex,devSellingNow:!!gi.devSoldRecent,insiderHold:grp?.complete?Math.max(0,grp.total-soldSince):null,devPct:gi.devPct??G?.devPct,devSold:gi.devSoldBefore||G?.devStatus==='creator_close',
      launches:G?.launches,sameDev:gi.sameDev,funderSeen:gi.funderSeen,top10:gi.top10??G?.top10,bundlerPct:G?.bundlerPct,sniperPct:G?.sniperPct,
      cluster:G?.listed?(G.cluster||{n:0}):null,launchBuyers:gi.launchBuyers,platformRate:G?.platformRate,freshRate:G?.freshRate,smart:G?.smart,
      holderGrowth:old&&old.h>0?100*(G.holders/old.h-1):null,volMc:G?.vol1h!=null&&G.mc>0?G.vol1h/G.mc:null,botShare:vb?.botShare,botTrades:vb?.botTradeShare,orgShare:vb?.orgShare,
      top10Approx:gi.top10!=null?!!gi.top10Approx:false,retention:G?.first70Hold??null,profitShare:G?.profitShare??null,moveSinceCall:Number.isFinite(move)?move:null};
    const jr=jupS.mint===current&&jupS.res&&now-jupS.res.at<=60000?jupS.res:null;
    x.exitCost=jr?.roundTrip??null;
    // Confidence inputs: stale parts, unverified identities, conflicts.
    x.conf={stale:[...gmStale(now),...(rv?.stale||[]),...(jupS.mint===current&&jupS.res&&!jr?['exit quote over 60s old']:[])],unverified:rv?.unverified||[],conflict:rv?.conflict||[]};
    return {score:VTCore.scoreCoin(x),x,grp,ex,jr};
  }
  // The checks box: insider bag + who is selling, then every check with its points.
  function renderChecks(c,now,rv,ls){
    const box=$('rug');box.hidden=!current;
    if(!current)return;
    const row=$('rug-row'), btn=$('rug-check'), say=t=>{$('rug-note').textContent=t;$('rug-note').hidden=!t;}, ins=$('ins');
    row.hidden=!(rv.manual||rv.retry)||!rpcUrl();btn.textContent=rv.retry?'Retry chain check':'Check this coin';
    const G=gmFresh(now), {score,grp,ex,x}=ls, age=gmS.mint===current&&gmS.at?Math.max(0,Math.round((now-gmS.at)/1000)):null;
    $('rug-src').textContent=[age!=null?'GMGN '+age+'s'+(age>30?(G?' old':' · expired'):''):gmS.busy?'GMGN loading':null,rv.src||null].filter(Boolean).join(' · ')||'untested';
    // Insider bag and live selling.
    if(grp){
      const roles=Object.entries(grp.byRole).filter(r=>r[1]>=0.05).sort((a,b)=>b[1]-a[1]).map(([r,v])=>r+' '+pctS(v)).join(' · ');
      const h=x.insiderHold, cls=ex.coordinated?'bad':h>=25?'over':'';
      ins.className='ins'+(cls?' '+cls:'');
      const top=node('div','row1');top.append(node('span','lbl','Insider bag'),node('b','',h==null?'?':pctS(h)),node('span','roles',h==null?'no GMGN holder list: dev and launch block only ('+pctS(grp.total)+')':roles||'no tagged insiders'));
      const recent=gmS.exits.filter(e=>now-e.at<=VTCore.EXIT.pctMs), line=node('div','exit'+(ex.coordinated?' bad':recent.length?' warn':''));
      line.textContent=ex.coordinated?'Leaving together: '+ex.wallets+' wallet'+(ex.wallets===1?'':'s')+' sold '+pctS(ex.pct)+' in 2 min ('+ex.roles.join(', ')+')'
        :recent.length?'Insider selling: '+pctS(ex.pct)+' in 2 min ('+ex.roles.join(', ')+')':'No insider selling in the last 2 min';
      ins.replaceChildren(top,line);ins.hidden=false;
      ins.title='Everyone likely to dump: '+[...grp.wallets.values()].length+' wallets (dev, dev team, bundlers, snipers, GMGN insiders, launch-block wallets, funder cluster). "Leaving together" = 3+ of them selling within 60s, or 3%+ of supply in 2 min.';
    }else ins.hidden=true;
    // Four parts, then the checklist grouped by part.
    const glyph={pass:'✓',warn:'!',fail:'✕',na:'·',info:'·'}, detail={...(rv.detail||{})}, titles={...(rv.titles||{})}, jr=ls.jr;
    if(jr?.roundTrip!=null){detail.exitcost='−'+pctS(Math.max(0,jr.roundTrip))+' · '+jr.size+' SOL';titles.exitcost='Jupiter: buy '+jr.size+' SOL then sell it back: '+pctS(jr.roundTrip)+' lost to pool fees and price impact ('+(jr.route||'route')+'). GMGN’s fee and priority fees are not included.';}
    else if(jupS.mint===current&&jupS.res?.noRoute)detail.exitcost='no Jupiter route (unknown, not unsellable)';
    const parts=$('parts'), PART={risk:'Risk',demand:'Demand',entry:'Entry'}, sgn=v=>(v>0?'+':v<0?'−':'')+Math.abs(v);
    if(score.known){
      const cells=Object.entries(PART).map(([cat,lbl])=>{const v=score[cat], worst=score.checks.filter(k=>k.cat===cat&&k.pts<0).sort((a,b)=>a.pts-b.pts)[0], d=node('div','pt '+(v<=-2?'bad':v<0?'warn':'ok'));
        d.append(node('span','lbl',lbl),node('b','',sgn(v)),node('small','',worst?worst.label:score.checks.some(k=>k.cat===cat&&k.status!=='na')?'no flags':'no data'));
        d.title=lbl+': '+score.checks.filter(k=>k.cat===cat&&k.status!=='na').map(k=>(k.pts>0?'+':'')+k.pts+' '+k.label).join(', ');return d;});
      const cf=score.confidence, dc=node('div','pt conf '+cf.level);dc.append(node('span','lbl','Data'),node('b','',cf.level),node('small','',cf.reasons[0]||'complete and current'));dc.title='Confidence: '+cf.level+(cf.reasons.length?'\n'+cf.reasons.join('\n'):'');
      parts.replaceChildren(...cells,dc);parts.hidden=false;
    }else parts.hidden=true;
    const out=[];
    for(const cat of ['risk','demand','entry']){
      const list=score.checks.filter(k=>k.cat===cat);if(!score.known||!list.length)continue;
      out.push(node('div','ckh',PART[cat]));
      // Long readings take a full row, after the short ones of the same part (so nothing is cut off).
      const cellsOf=list.map(k=>{const d=node('div','ck '+k.status),v=detail[k.key]??k.value, wide=String(v??'').length>12||(k.label+String(v??'no data')).length>24;if(wide)d.classList.add('wide');
        d.append(node('i','',glyph[k.status]),node('span','',k.label),node('b','',v??'no data'));
        d.title=k.label+': '+(v??'no data')+(k.note?' ('+k.note+')':'')+' · '+(k.pts>0?'+':'')+k.pts+' pts'+(titles[k.key]?'\n'+titles[k.key]:'');return [wide,d];});
      out.push(...cellsOf.filter(x=>!x[0]).map(x=>x[1]),...cellsOf.filter(x=>x[0]).map(x=>x[1]));
    }
    $('rug-cells').replaceChildren(...out);
    // RugCheck: its findings as they are, apart from the score.
    const rc=$('rc'), rr=rcS.mint===current?rcS.res:null;
    if(rr?.risks){
      const onCurve=gmS.mint===current&&gmS.G?.migrated!=null?gmS.G.migrated===false:callFor(current)?.migrated===false, curveish=r=>onCurve&&/single holder|holder concentration|top 10 holders|top holders/i.test(r.name||'');
      const real=rr.risks.filter(r=>!curveish(r)), dz=real.filter(r=>r.level==='danger').length, wn=real.filter(r=>r.level==='warn').length;
      rc.querySelector('summary').textContent='RugCheck: '+(dz?dz+' danger':'')+(dz&&wn?', ':'')+(wn?wn+' warning'+(wn===1?'':'s'):'')+(!dz&&!wn?'no findings':'')+' (not in the score)';
      rc.querySelector('ul').replaceChildren(...rr.risks.map(r=>node('li',(r.level==='danger'?'risk':'')+(curveish(r)?' dim':''),(r.name||'?')+(r.value?' · '+r.value:'')+(curveish(r)?' (the bonding curve, normal before migration)':''))));
      rc.hidden=false;
    }else{rc.hidden=!(rcS.mint===current&&rr?.err);if(!rc.hidden){rc.querySelector('summary').textContent='RugCheck: no report ('+rr.err+')';rc.querySelector('ul').replaceChildren();}}
    say([rv.wait&&!rv.S?'Chain: '+rv.wait+'.':'',rv.note,gmS.err?'GMGN: '+gmS.err+'.':'',!get('gmOn',true)?'GMGN token data is off (Settings).':''].filter(Boolean).join(' '));
  }
  // At-call snapshot of the live score, once per call, when the call first opens on GMGN (within 3 min of the alert).
  // Waits up to 30s for the chain check so the saved score uses everything. Forward data for the backtest.
  function gmSnapshot(c,ls,now){
    if(!c||c.historical||c.manual||c.unverified||gmS.mint!==c.mint||!gmFresh(now)||now-c.messageAt>180000||get('gm.'+c.id,null))return;
    const L=rugLive.get(c.mint);
    if(rpcUrl()&&L?.status!=='ok'&&L?.status!=='error'&&now-c.messageAt<30000)return;
    // Wait (up to 30s after the alert) for the first exit quote too, so the saved score has it.
    if(get('jupOn',true)&&!(jupS.mint===c.mint&&jupS.res)&&now-c.messageAt<30000)return;
    const {score:s,x}=ls, r=v=>v==null?null:Math.round(v*100)/100;
    set('gm.'+c.id,{t:c.messageAt,at:now,delay:Math.round((now-c.messageAt)/1000),grade:s.grade,code:s.code,score:s.score,known:s.known,hard:s.hard,
      insiderHold:r(x.insiderHold),bundlerPct:r(x.bundlerPct),sniperPct:r(x.sniperPct),platformRate:r(x.platformRate),freshRate:r(x.freshRate),launches:x.launches??null,
      volMc:r(x.volMc),smart:x.smart??null,top10:r(x.top10),devPct:r(x.devPct),clusterN:x.cluster?.n??null,clusterPct:r(x.cluster?.pct),holders:gmS.G.holders,
      first70Hold:r(gmS.G.first70Hold),devStatus:gmS.G.devStatus,checks:Object.fromEntries(s.checks.map(k=>[k.key,k.status==='na'?null:k.pts])),
      v:2,risk:s.risk,demand:s.demand,entry:s.entry,conf:s.confidence.level,confWhy:s.confidence.reasons.slice(0,4),exitCost:r(x.exitCost),tradeSol:ls.jr?.size??null,retention:r(x.retention),profitShare:r(x.profitShare),move:r(x.moveSinceCall)});
    locked('gmIds',()=>{const ids=get('gmIds',[]);if(!ids.includes(c.id)){ids.unshift(c.id);for(const old of ids.splice(2000))GM_deleteValue(PREFIX+'gm.'+old);set('gmIds',ids);}});
    tgUpdate(c);
  }
  // ---- Telegram (optional): call pings that update with the rug checks, and dev-sell pings ----
  function tg(method,body){
    const t=String(get('tgToken','')||'').trim();
    if(!t)return Promise.resolve({ok:false,error:'no bot token'});
    return new Promise(resolve=>GM_xmlhttpRequest({method:'POST',url:'https://api.telegram.org/bot'+t+'/'+method,headers:{'Content-Type':'application/json'},data:JSON.stringify(body||{}),timeout:12000,
      onload:r=>{let d=null;try{d=JSON.parse(r.responseText);}catch(_){}resolve(d?.ok?{ok:true,result:d.result}:{ok:false,error:d?.description||'HTTP '+r.status});},
      onerror:()=>resolve({ok:false,error:'network error'}),ontimeout:()=>resolve({ok:false,error:'timeout'})}));
  }
  function tgReady(){return !!(get('tgToken','')&&get('tgChat',''));}
  function tgSend(text){return tg('sendMessage',{chat_id:get('tgChat',''),text,link_preview_options:{is_disabled:true}});}
  function tgCallText(c){
    const r=get('rug.'+c.id,null), age=c.ageSeconds==null?'':' · age '+(c.ageSeconds<3600?Math.round(c.ageSeconds/60)+'m':(c.ageSeconds/3600).toFixed(1)+'h');
    const lines=['VolTrak call: '+c.name+(c.symbol?' ($'+c.symbol+')':''),'MC '+(c.callMc?usd(c.callMc):'?')+age,VTCore.gmgnURL(c.mint)];
    const g=get('gm.'+c.id,null);
    if(g){const worst=Object.entries(g.checks||{}).filter(e=>e[1]<0).sort((a,b)=>a[1]-b[1]).slice(0,3).map(e=>TG_NAMES[e[0]]||e[0]);
      const sg=v=>(v>0?'+':v<0?'−':'')+Math.abs(v);
      lines.push('Live: '+g.grade+(g.v>=2?' (risk '+sg(g.risk)+', demand '+sg(g.demand)+', entry '+sg(g.entry)+(g.conf&&g.conf!=='high'?', data '+g.conf:'')+')':' (score '+(g.score>0?'+':'')+g.score+', '+g.known+' checks)')
        +(g.hard?.length?' · '+g.hard[0]:worst.length?' · weak: '+worst.join(', '):''));
      if(g.exitCost!=null)lines.push('Round trip at '+g.tradeSol+' SOL: −'+Math.max(0,g.exitCost).toFixed(1)+'% (Jupiter quote)');}
    // With a live score, the chain line is just the numbers (one grade per ping); without one, it carries the chain grade.
    if(r?.done&&!r.empty){const line=VTCore.rugLine(r,rugSeen(c.id,c.messageAt,r.creator,r.funder));lines.push(g?'Chain: '+line.replace(/^[A-Z]+ · /,''):'Chain grade: '+line);}else if(r?.empty)lines.push('Chain checks: no chain data yet');else if(rpcUrl())lines.push('Chain checks: running…');
    return lines.join('\n');
  }
  const TG_NAMES={insiders:'insider bag',dev:'dev holds',launches:'dev launches',repeat:'dev/funder seen before',top10:'top 10',bundlers:'bundlers',snipers:'snipers',cluster:'funder cluster',
    launch:'launch block',real:'few real traders',app:'app traders',fresh:'fresh wallets',growth:'holders falling',volmc:'volume vs MC',bots:'volume bots',organic:'organic buys',smart:'smart money',
    retention:'first buyers sold',exitcost:'exit cost',overhang:'holders in profit',move:'already pumped'};
  async function tgCall(c){
    if(c.unverified)return;
    if(!get('tgOn',true)||!tgReady())return;
    const r=await tgSend(tgCallText(c));
    if(!r.ok){notice('Telegram: '+r.error);render();return;}
    const now=Date.now();
    set('tg.'+c.id,{chat:get('tgChat',''),id:r.result.message_id,at:now,last:tgCallText(c)});
    try{for(const k of GM_listValues())if(k.startsWith(PREFIX+'tg.')&&now-(GM_getValue(k,null)?.at||0)>48*3600000)GM_deleteValue(k);}catch(_){}
    tgUpdate(c);
  }
  const tgRec=id=>get('tg.'+id,null)||get('tgMsgs',{})[id]||null;
  // Edits the call's ping when a new piece (chain check, live score) arrives; never sends the same text twice.
  async function tgUpdate(c){
    const m=tgRec(c.id), text=tgCallText(c);
    if(!m||m.last===text||!get('tgToken',''))return;
    const r=await tg('editMessageText',{chat_id:m.chat,message_id:m.id,text,link_preview_options:{is_disabled:true}});
    if(r.ok)set('tg.'+c.id,{...m,last:text});
  }
  function openReport(){
    const tp=Math.max(1,+$('bt-tp').value||100), sl=-Math.min(99,Math.abs(+$('bt-sl').value||50)), cost=Math.max(0,+$('bt-cost').value||0);
    const delay=BT_DELAYS.includes(+$('bt-delay').value)?+$('bt-delay').value:0, exit=+$('bt-exit').value===5?5:0, fill=$('bt-fill').value==='cautious'?'cautious':'touch';
    set('bt.opt',{tp,sl,cost,delay,exit,fill});
    const base={tp,sl,horizon:BT_H,fill,earlyExit:exit||null};
    // Every call is scored at each entry delay from the same cached candles (no extra requests).
    const done=get('bt.done',{}), covered=get('bt.pre',{}), rows=[];let noData=0, noExit=0, incomplete=0;
    // Trailing exit with fixed, untuned settings (arm at half the target, give back 30% from the peak) so it is not fitted to these calls.
    const trail={arm:tp/2,drop:30};
    for(const c of btCandidates()){
      if(done[c.id]!=='ok'){if(done[c.id])noData++;continue;}
      // dataEnd: candles cover up to the fetch time (calls are fetched once their 2h window has closed; caches from
      // before 4.1 have no fetch time and were fetched under the same rule).
      // Coverage: GeckoTerminal can lag a few minutes behind the chain, so candles fetched at time F are taken to reach
      // F - 5 min at most (an assumption, stated in the report). Caches from before 4.1 have no fetch time: they were
      // fetched under the same "window closed + 5 min" rule and are counted as covered (also stated).
      const cs=VTCore.candles(get('bt.c.'+c.id,[])), by={}, fetched=get('bt.f.'+c.id,null), cb={...base,dataEnd:fetched?Math.min(fetched-5*60000,c.messageAt+(BT_H+1)*60000):undefined};
      for(const d of BT_DELAYS)by[d]=VTCore.scoreCall(cs,c.messageAt,{...cb,delay:d});
      // Exit rules compared at the chosen entry: target/stop only, a 5-min early exit, a +50% target, and a trailing exit.
      const ex={plain:VTCore.scoreCall(cs,c.messageAt,{...cb,earlyExit:null,delay}),early5:VTCore.scoreCall(cs,c.messageAt,{...cb,earlyExit:5,delay}),tp50:VTCore.scoreCall(cs,c.messageAt,{...cb,earlyExit:null,tp:50,delay}),
        trail:VTCore.scoreCall(cs,c.messageAt,{...cb,earlyExit:null,delay,trail})};
      if(by[0].status!=='scored'){if(by[0].status==='no-exit')noExit++;else if(by[0].status==='incomplete')incomplete++;else noData++;continue;}
      // The live late check, replayed: price vs the alert entry and any swap in the 5 min before the check.
      const late={};
      // Only candles that closed inside [check−5 min, check) count as "traded", so nothing after the check leaks in.
      for(const d of LATE_AT){const at=c.messageAt+d*60000;late[d]=VTCore.lateGrade(by[0]['r'+d],cs.some(k=>k.t>=at-300000&&k.t+60000<=at));}
      rows.push({call:c,by,ex,late,pre:VTCore.preAlert(cs,c.messageAt,covered[c.id]===1),hb:get('hb.'+c.id,null),ft:get('feat.'+c.id,null),rug:get('rug.'+c.id,null),gm:get('gm.'+c.id,null)});
    }
    const scored=d=>rows.filter(r=>r.by[d].status==='scored');
    const entries=BT_DELAYS.map(d=>({delay:d,dead:rows.length-scored(d).length,...VTCore.summarize(scored(d).map(r=>r.by[d]),cost)}));
    const grades=LATE_AT.flatMap(d=>['ABOVE','BELOW','DOWN30','NOTRADES','NOPRICE'].map(g=>{const all=rows.filter(r=>r.late[d]===g), sc=all.filter(r=>r.by[d].status==='scored');
      return {delay:d,grade:g,total:all.length,...VTCore.summarize(sc.map(r=>r.by[d]),cost)};}).filter(x=>x.total));
    // Price-path features ride on a copy of each call: the fill vs the price the call went out at, and the run-up before it.
    const moveInto=(r,d)=>r.pre.close>0&&r.by[d].status==='scored'?(r.by[d].entry/r.pre.close-1)*100:null;
    // Rug checks at the alert, plus whether the dev or its funder showed up on an earlier call.
    // Only checks saved from 4.2 on (v3). Holder figures only when verified; dev/launch/funder only with a usable creator.
    const rugFeat=r=>{const x=r.rug;if(!x?.done||x.empty||!(x.v>=3))return null;const cOk=x.creatorVerified&&x.creatorCheck!=='conflict', hOk=x.holders==='verified';
      const s=cOk?rugSeen(r.call.id,r.call.messageAt,x.creator,x.funder):{dev:0,fund:0};
      const f={top10:hOk?x.top10:null,devPct:hOk&&cOk?x.devPct:null,devSold:hOk&&cOk?x.devSold:null,launchBuyers:cOk?x.launchBuyers:null,launchPct:cOk?x.launchPct:null,
        seen:cOk&&(x.creator||x.funder)?s.dev+s.fund>0:null,seenDev:cOk?s.dev:null,seenFund:cOk?s.fund:null};
      return {...f,grade:hOk&&cOk?VTCore.rugGradeAt(f,s).code:null};};
    for(const r of rows)r.rf=rugFeat(r);
    // Live-score features only for entries made after the score was saved (no peeking: a score saved 40s after the
    // alert cannot group an entry at the alert).
    const gmAt=(r,d)=>r.gm&&r.gm.at<=r.call.messageAt+d*60000?r.gm:null;
    const items=scored(delay).map(r=>({call:{...r.call,entryMove:moveInto(r,delay),runUp15:r.pre.runUp15,rug:r.rf,gm:gmAt(r,delay)},score:r.by[delay]}));
    // Stale marks: still open at the end of the window and priced on a trade 15+ min old. They are a price, not proof the
    // exit could fill. Kept in the main numbers (they are never wins, so dropping them would flatter the win rate) and
    // shown separately with the numbers without them.
    const isStale=r=>r.by[delay].exit==='stale-mark', staleExits=scored(delay).filter(isStale).length;
    const fresh=VTCore.summarize(items.filter(i=>i.score.exit!=='stale-mark').map(i=>i.score),cost), staleSum=VTCore.summarize(items.filter(i=>i.score.exit==='stale-mark').map(i=>i.score),cost);
    // Worst case: every stale exit could not be sold at all (-100%).
    const worst=VTCore.summarize(items.map(i=>i.score.exit==='stale-mark'?{...i.score,ret:-100,outcome:'loss'}:i.score),cost);
    // Exit rules on the same calls (paired: the difference is per call, so it is tighter than comparing averages).
    const exitRule=(key,label,list)=>{const ok=list.filter(r=>r.ex[key].status==='scored'&&r.ex.plain.status==='scored'), x=VTCore.summarize(ok.map(r=>r.ex[key]),cost), d=ok.map(r=>r.ex[key].ret-r.ex.plain.ret);
      const m=d.length?d.reduce((a,b)=>a+b,0)/d.length:null, sd=d.length>1?Math.sqrt(d.reduce((a,b)=>a+(b-m)**2,0)/(d.length-1)):null;
      return {key,label,...x,diff:m,diffLo:sd==null?null:m-1.96*sd/Math.sqrt(d.length),diffHi:sd==null?null:m+1.96*sd/Math.sqrt(d.length)};};
    const exitRules=list=>[exitRule('plain','Target +'+tp+'% / stop '+sl+'%',list),exitRule('early5','… and sell at 5 min if not up',list),exitRule('tp50','Target +50% / stop '+sl+'%',list),
      exitRule('trail','… and once up +'+trail.arm+'%, sell '+trail.drop+'% below the peak',list)];
    const fwd=rows.filter(r=>r.call.messageAt>=FORWARD_FROM);
    const all=VTCore.summarize(items.map(i=>i.score),cost);
    set('bt.summary',{n:all.n,winRate:all.winRate,ev:all.ev,evLo:all.evLo,evHi:all.evHi,be:VTCore.breakeven(tp,sl,cost),tp,sl,cost,delay,at:Date.now()});
    showReport(VTCore.backtestReport(items,cost),items,{tp,sl,cost,noData,delay,exit,fill,entries,grades,rows,moveInto,runUps:rows.filter(r=>r.pre.runUp15!=null).length,
      rug:{n:rows.filter(r=>r.rf).length,cut:rows.filter(r=>r.rf&&r.rug.holders!=='verified').length,old:rows.filter(r=>r.rug?.done&&!r.rug.empty&&!(r.rug.v>=3)).length},gmN:rows.filter(r=>r.gm).length,gmUsed:rows.filter(r=>gmAt(r,delay)).length,
      noExit,incomplete,staleExits,fresh,staleSum,worst,legacyCache:rows.filter(r=>!get('bt.f.'+r.call.id,null)).length,
      exits:exitRules(rows),forward:{n:fwd.length,rules:fwd.length?exitRules(fwd):[]}});
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
      // One row per call. The first block buys at the alert (same columns as before); buy10_/buy30_ buy later and are
      // blank when the coin had no trades at that time.
      const later=LATE_AT, f=v=>v==null?null:v.toFixed(1);
      const cols=['name','symbol','mint','alert_time','call_mc','age_min','largest_cluster','bot_share','fresh_share','top_holder','holders','outcome','trade_return','peak','peak_min','trough','r5','r10','r15','r30','r60',
        'outcome_min','trough_min','r1','r2','r3','early5_outcome','early5_return','tp50_outcome','tp50_return','set_entry_min','set_tp','set_sl','set_cost','set_fill','set_early_exit',
        ...later.flatMap(d=>['grade','outcome','trade_return','peak','peak_min','r15','r60'].map(x=>'buy'+d+'_'+x)),
        'bots_pre_share','bots_pre_wallets','bots_pre_buyers','bots_2m_share','bots_2m_wallets','bots_2m_buyers','bots_trades','bots_truncated','live_bots_60s','live_bots_120s','live_buyers_120s','live_bots_complete',
        'entry_move','run_up_15','migrated','trail_outcome','trail_return','bots_2m_organic_share','bots_2m_organic_trades','live_organic_120s',
        'rug_top10','rug_dev_pct','rug_dev_buy_pct','rug_dev_sold','rug_launch_buyers','rug_launch_pct','rug_seen_dev','rug_seen_funder','rug_complete','rug_creator','rug_funder','rug_grade',
        'live_grade','live_score','live_checks','live_delay_s','live_insider_bag','live_bundlers','live_snipers','live_real_traders','live_fresh','live_dev_launches','live_vol_mc','live_smart','live_top10','live_dev_pct','live_cluster_wallets','live_cluster_pct','live_holders','live_first70_hold','live_dev_status',
        'live_rules','live_risk','live_demand','live_entry','live_confidence','live_exit_cost','live_trade_sol','live_retention','live_profit_share','live_move'];
      const q=v=>v==null?'':/[",\n]/.test(String(v))?'"'+String(v).replace(/"/g,'""')+'"':String(v);
      const lines=o.rows.map(r=>{const {call:c,by,ex,late,hb,ft}=r, s=by[0];return [c.name,c.symbol,c.mint,new Date(c.messageAt).toISOString(),c.callMc,c.ageSeconds==null?null:(c.ageSeconds/60).toFixed(1),c.clusters?.length?Math.max(...c.clusters):null,
        c.holders>0&&c.bots!=null?(100*c.bots/c.holders).toFixed(1):null,c.holders>0&&c.fresh!=null?(100*c.fresh/c.holders).toFixed(1):null,c.topHolder,c.holders,s.outcome,f(s.ret),f(s.peakPct),f(s.peakMin),f(s.troughPct),f(s.r5),f(s.r10),f(s.r15),f(s.r30),f(s.r60),
        f(s.outcomeMin),f(s.troughMin),f(s.r1),f(s.r2),f(s.r3),ex.early5.outcome,f(ex.early5.ret),ex.tp50.outcome,f(ex.tp50.ret),o.delay,o.tp,o.sl,o.cost,o.fill,o.exit||0,
        ...later.flatMap(d=>{const x=by[d];return [late[d],...(x.status==='scored'?[x.outcome,f(x.ret),f(x.peakPct),f(x.peakMin),f(x.r15),f(x.r60)]:[null,null,null,null,null,null])];}),
        hb?.pre?.share,hb?.pre?.bots,hb?.pre?.buyers,hb?.post?.share,hb?.post?.bots,hb?.post?.buyers,hb?.trades,hb?hb.truncated:null,ft?.vb60?.share,ft?.vb120?.share,ft?.vb120?.buyers,ft?.vb120?ft.vb120.complete:null,
        f(o.moveInto(r,0)),f(r.pre.runUp15),c.migrated,ex.trail.outcome,f(ex.trail.ret),hb?.post?.org,hb?.post?.orgN,ft?.vb120?.org,
        ...(r.rf?[r.rf.top10,r.rf.devPct,r.rug.devBuyPct,r.rf.devSold,r.rf.launchBuyers,r.rf.launchPct,r.rf.seenDev,r.rf.seenFund,r.rug.complete,r.rug.creator,r.rug.funder,['clean','risky','avoid'][r.rf.grade]??null]:Array(12).fill(null)),
        ...(r.gm?[r.gm.grade,r.gm.score,r.gm.known,r.gm.delay,r.gm.insiderHold,r.gm.bundlerPct,r.gm.sniperPct,r.gm.platformRate,r.gm.freshRate,r.gm.launches,r.gm.volMc,r.gm.smart,r.gm.top10,r.gm.devPct,r.gm.clusterN,r.gm.clusterPct,r.gm.holders,r.gm.first70Hold,r.gm.devStatus,
          r.gm.v>=2?'4.3':'old',r.gm.risk,r.gm.demand,r.gm.entry,r.gm.conf,r.gm.exitCost,r.gm.tradeSol,r.gm.retention,r.gm.profitShare,r.gm.move]:Array(29).fill(null))].map(q).join(',');});
      const url=URL.createObjectURL(new Blob([[cols.join(','),...lines].join('\n')],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='voltrak-backtest-'+Date.now()+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    const a=rep.all, t=rep.timing;
    const at=d=>d?d+' min after the alert':'the alert';
    box.append(el('p','margin:0 0 12px;color:'+C.muted,'Rules: buy at '+at(o.delay)+' (close of that minute); sell at +'+o.tp+'% or '+o.sl+'%, whichever comes first'+(o.exit?', or at the 5-min close if the price is not above entry':'')+', otherwise at the price '+BT_H+' min after the alert. Fills: '+(o.fill==='cautious'?'cautious (stops at the worse of stop and candle close; targets need a close above, or a high 10% beyond)':'at the exact target/stop (optimistic)')+'. Costs '+o.cost+'% per trade. '+o.noData+' saved call'+(o.noData===1?'':'s')+' had no price data.'
      +(o.delay?' '+o.entries.find(e=>e.delay===o.delay).dead+' had no trades at '+at(o.delay)+' (dead) and are left out.':'')));
    document.body.append(wrap);
    if(!o.rows.length){box.append(el('p','color:'+C.amber,'No scored calls yet. Scroll back through the VolTrak channel, then press "Score calls" in the Calls tab.'));return;}
    const widths=['22%','10%','26%','14%','14%','14%'];
    const table=(first,rows)=>{
      const tb=el('table','border-collapse:collapse;width:100%;max-width:900px;table-layout:fixed'), cg=el('colgroup');
      widths.forEach(w=>{const c=el('col');c.style.width=w;cg.append(c);});tb.append(cg);
      const hr=el('tr');[first,'Calls','Win rate (95% range)','Avg per trade','Median peak',''].forEach(h=>hr.append(el('th','text-align:left;color:'+C.muted+';font-weight:600;padding:4px 8px;border-bottom:1px solid '+C.line,h)));tb.append(hr);
      for(const [cells,color] of rows){const tr=el('tr',color?'color:'+color:'');cells.forEach(v=>tr.append(el('td','padding:4px 8px;border-bottom:1px solid #1b2531',v)));tb.append(tr);}
      box.append(tb);
    };
    if(a.n){
      const tiles=el('div','display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px'), tile=(label,value,color,sub)=>{
        const d=el('div','background:'+C.card+';border:1px solid '+C.line+';border-radius:10px;padding:8px 10px');
        d.append(el('div','color:'+C.muted+';font-size:10.5px;text-transform:uppercase;letter-spacing:.05em',label),el('div','font-size:20px;font-weight:700;color:'+(color||'inherit'),value));
        if(sub)d.append(el('div','color:'+C.muted+';font-size:11px',sub));tiles.append(d);};
      tile('Calls scored',String(a.n));
      tile('Win rate',a.winRate.toFixed(0)+'%',null,'95% range '+a.lo.toFixed(0)+'–'+a.hi.toFixed(0)+'%');
      tile('Avg per trade',pct(a.ev),a.ev>=0?C.green:C.red,a.evLo==null?'after '+o.cost+'% costs':'95% range '+pct(a.evLo)+' to '+pct(a.evHi));
      tile('Break-even',VTCore.breakeven(o.tp,o.sl,o.cost).toFixed(0)+'%',null,'win rate needed at '+o.cost+'% costs');
      tile('Median peak',pct(a.medianPeak),null,'median '+(t.peakMin==null?'—':t.peakMin.toFixed(0)+' min')+' to peak');
      tile('After 5 / 15 / 60 min',pct(t.r5)+' '+pct(t.r15)+' '+pct(t.r60),null,'median change from entry');
      box.append(tiles);
      // Verdict from the 95% range of the average, not the point estimate.
      const verdict=a.evHi!=null&&a.evHi<0?['Losing: the whole 95% range of the average is below zero.',C.red,'#2a0e14']:a.evLo!=null&&a.evLo>0?['Positive on these calls: the whole 95% range is above zero. Check it holds on new calls (forward test below).',C.green,'#0c2318']:['Can’t tell yet: the 95% range of the average includes zero.',C.amber,'#241c07'];
      box.append(el('p','margin:0 0 10px;padding:8px 10px;border-radius:8px;font-weight:600;background:'+verdict[2]+';color:'+verdict[1],verdict[0]));
      // Calls without price data are mostly coins that died before GeckoTerminal indexed them; leaving them out flatters the average.
      if(o.noData&&!o.delay)box.append(el('p','margin:0 0 10px;color:'+C.muted,'Survivorship check: '+o.noData+' call'+(o.noData===1?'':'s')+' had no price data and '+(o.noData===1?'is':'are')+' left out above. If '+(o.noData===1?'it':'they all')+' had lost the stop, the average would be '
        +pct((a.ev*a.n+(o.sl-o.cost)*o.noData)/(a.n+o.noData))+' per trade over '+(a.n+o.noData)+' calls.'));
      if(a.n<30)box.append(el('p','margin:0 0 12px;padding:8px 10px;border-radius:8px;background:#3d3214;color:'+C.amber,'Only '+a.n+' calls scored: too few to trust any pattern. Scroll further back in the channel and score again; 100+ calls gives usable ranges.'));
      // Three ways to count the exits that were only a stale price.
      box.append(el('h3','margin:4px 0 4px;font-size:14px','Three ways to count the exits'));
      table('Counting',[[['Fills only',String(o.fresh.n),rate(o.fresh),pct(o.fresh.ev),pct(o.fresh.medianPeak),'stale exits left out'],''],
        [['All (the numbers above)',String(a.n),rate(a),pct(a.ev),pct(a.medianPeak),o.staleExits?o.staleExits+' at their last price':'no stale exits'],''],
        [['Worst case',String(o.worst.n),rate(o.worst),pct(o.worst.ev),pct(o.worst.medianPeak),o.staleExits?o.staleExits+' counted as −100%':'same as all'],o.staleExits?C.amber:'']]);
      box.append(el('p','margin:4px 0 12px;color:'+C.muted,'A stale exit is a coin still open at the end of the window with no trade in its last 15+ min: the price is a mark, not proof you could sell. Left out of all three: '+o.noExit+' with no trade after the entry, '+o.incomplete+' with candles that stop early.'));
    }
    // Same calls bought at the alert, +10 and +30 min: does waiting for the first dump help?
    box.append(el('h3','margin:4px 0 4px;font-size:14px','When to buy: same calls, same target and stop'));
    table('Buy at',o.entries.map(e=>[[e.delay?'+'+e.delay+' min':'Alert',String(e.n),rate(e),pct(e.ev),pct(e.medianPeak),
      [e.delay===o.delay?'this report':'',e.dead?e.dead+' dead by then':''].filter(Boolean).join(' · ')],e.delay===o.delay?'':'#9aa7b6']));
    box.append(el('p','margin:4px 0 12px;color:'+C.muted,'"Dead" = no trades within 5 min of the entry time, so there was nothing to buy. Change "Buy at" in the Calls tab to see the splits below for another entry time.'));
    // Exit rules on the same calls, at the chosen entry.
    const exitRows=list=>list.map(x=>[[x.label,String(x.n),rate(x),pct(x.ev),pct(x.medianPeak),x.key==='plain'||x.diff==null?'baseline':(x.diff>=0?'+':'')+x.diff.toFixed(1)+' pts vs baseline ('+pct(x.diffLo)+' to '+pct(x.diffHi)+')'],'']);
    box.append(el('h3','margin:4px 0 4px;font-size:14px','Exit rules: same calls, buying at '+at(o.delay)));
    table('Exit',exitRows(o.exits));
    box.append(el('p','margin:4px 0 12px;color:'+C.muted,'The 5-min exit was the most promising lead in an analysis of 95 calls, but it was found on those same calls: treat it as untested until the forward test below agrees. The trailing exit (added in 3.7) uses fixed settings and only earlier candles\' highs, so it is a fair forward test from here on.'));
    // Forward test: only calls after that analysis count as a fair test of its leads.
    box.append(el('h3','margin:4px 0 4px;font-size:14px','Forward test: calls after Oct 11 03:30 UTC ('+o.forward.n+')'));
    if(o.forward.n)table('Exit',exitRows(o.forward.rules));
    box.append(el('p','margin:4px 0 12px;color:'+C.muted,o.forward.n<30?'Needs about 30–70 new calls to tell whether the 5-min exit really beats target/stop only. Keep the script running and score new calls as they age past 2 hours.':'Enough calls to start judging the 5-min exit: look at the range in the last column.'));
    // Late checks replayed on past calls: what buying at +10/+30 did, by where the price was at the check.
    box.append(el('h3','margin:4px 0 4px;font-size:14px','Late checks: buying at the check, by where the price was'));
    const gName={ABOVE:'above call',BELOW:'below call (0 to −30%)',DOWN30:'down 30%+',NOTRADES:'no trades',NOPRICE:'no price'};
    table('At the check',o.grades.map(g=>[['+'+g.delay+' min · '+gName[g.grade],String(g.n),rate(g),pct(g.ev),pct(g.medianPeak),g.total>g.n?(g.total-g.n)+' had nothing to buy':''],'']));
    box.append(el('p','margin:4px 0 12px;color:'+C.muted,'Same check as the Calls tab: price at +10/+30 min vs the alert price (down '+(-VTCore.LATE.down)+'%+ is its own group); "no trades" = nothing traded in the 5 min before the check. These are descriptions, not signals: a group is only worth acting on if its average stays above zero on new calls.'));
    // Volume bots on past calls: Helius backfill, or the live GMGN reading saved when the call arrived.
    // Only complete readings: a partial window (feed started late, receiver left early, history cut short) is not comparable.
    // The live GMGN reading wins over Helius: it sees each leg directly, while Helius in-transaction legs are priced by estimate.
    const postOf=r=>r.ft?.vb120?.n>0&&r.ft.vb120.complete?r.ft.vb120:r.hb?.post?.n>0&&r.hb.post.complete?r.hb.post:null;
    const preR=o.rows.filter(r=>r.hb?.pre?.n>0&&r.hb.pre.complete), postR=o.rows.filter(postOf), orgR=postR.filter(r=>postOf(r).org!=null&&postOf(r).orgN>=5);
    if(preR.length||postR.length){
      box.append(el('h3','margin:4px 0 4px;font-size:14px','Volume bots and organic flow on past calls'));
      const bands=(cuts,unit)=>v=>{if(v==null)return null;const i=cuts.findIndex(x=>v<x);return i===0?'under '+cuts[0]+unit:i<0?cuts[cuts.length-1]+unit+'+':cuts[i-1]+'–'+cuts[i]+unit;};
      const split=(list,val,d,band,labels)=>labels.map(b=>{const sc=list.filter(r=>band(val(r))===b&&r.by[d].status==='scored').map(r=>r.by[d]), x=VTCore.summarize(sc,o.cost);return [[b,String(x.n),rate(x),pct(x.ev),pct(x.medianPeak),''],''];}).filter(x=>x[0][1]!=='0');
      const botB=bands([20,40],'%'), botL=['under 20%','20–40%','40%+'], orgB=bands([40,60],'%'), orgL=['under 40%','40–60%','60%+'], buyB=bands([10,25],''), buyL=['under 10','10–25','25+'];
      if(preR.length){box.append(el('p','margin:4px 0;color:'+C.muted,'Bot-like share of $ volume in the 5 min before the alert → buying at the alert ('+preR.length+' calls with a reading):'));table('Bots before alert',split(preR,r=>r.hb.pre.share,0,botB,botL));}
      if(postR.length){box.append(el('p','margin:8px 0 4px;color:'+C.muted,'Bot-like share in the first 2 min after the alert → buying at +10 min, when that reading is already known ('+postR.length+' calls):'));table('Bots first 2 min',split(postR,r=>postOf(r).share,10,botB,botL));}
      // Readings saved before 3.7 have no organic share; they are left out of these two tables.
      if(orgR.length){
        box.append(el('p','margin:8px 0 4px;color:'+C.muted,'Organic (bot-free) buy share of $ volume in the first 2 min → buying at +10 min ('+orgR.length+' calls with 5+ organic trades):'));table('Organic buy share',split(orgR,r=>postOf(r).org,10,orgB,orgL));
        box.append(el('p','margin:8px 0 4px;color:'+C.muted,'Real buyers (not flagged, $15+ bought, still net long) in the first 2 min → buying at +10 min:'));table('Real buyers',split(orgR,r=>postOf(r).buyers,10,buyB,buyL));
      }
      box.append(el('p','margin:4px 0 12px;color:'+C.muted,'Bot-like = a buy and a sell in one transaction, a flat buy-then-sell within 10s, churn wallets, or dust trades. Organic = everything else, minus arbitrage. A rough lower bound from wallet behaviour; exploratory until about 100 calls have a reading.'));
    }
    // Per-call view, last in the report because it is long.
    const eachCall=()=>{
      box.append(el('h3','margin:16px 0 4px;font-size:14px','Each call at +10 and +30 min (newest first)'));
      const tb=el('table','border-collapse:collapse;width:100%;max-width:900px;table-layout:fixed'), gc={ABOVE:C.green,BELOW:C.amber,DOWN30:C.red}, oc={win:C.green,loss:C.red}, cg=el('colgroup');
      ['28%',...LATE_AT.flatMap(()=>['14%','22%'])].forEach(w=>{const c=el('col');c.style.width=w;cg.append(c);});tb.append(cg);
      const hr=el('tr');['Call',...LATE_AT.flatMap(d=>['+'+d+' check','Bought at +'+d])].forEach(h=>hr.append(el('th','text-align:left;color:'+C.muted+';font-weight:600;padding:4px 8px;border-bottom:1px solid '+C.line,h)));tb.append(hr);
      const td=(text,color)=>el('td','padding:4px 8px;border-bottom:1px solid #1b2531;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'+(color?';color:'+color:''),text);
      for(const r of o.rows.slice().sort((x,y)=>y.call.messageAt-x.call.messageAt).slice(0,100)){
        const tr=el('tr');tr.append(td(r.call.name+' · '+new Date(r.call.messageAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})));
        for(const d of LATE_AT){
          const s=r.by[d];tr.append(td(['NOTRADES','NOPRICE'].includes(r.late[d])?gName[r.late[d]]:pct(r.by[0]['r'+d])+' · '+gName[r.late[d]].split(' (')[0],gc[r.late[d]]||C.muted));
          tr.append(td(s.status!=='scored'?'—':s.outcome+' '+pct(s.ret)+' · peak '+pct(s.peakPct),oc[s.outcome]||C.muted));
        }
        tb.append(tr);
      }
      box.append(tb);
      box.append(el('p','margin:4px 0 12px;color:'+C.muted,'Check = grade and price vs the alert at that time. Bought = result of buying right then with your target and stop (window ends '+BT_H+' min after the alert).'));
    };
    if(!a.n){box.append(el('p','color:'+C.amber,'None of these calls still traded '+at(o.delay)+'. Pick an earlier "Buy at" time.'));eachCall();return;}
    box.append(el('p','margin:0 0 4px;color:'+C.muted,'Peaks (from entry): '+t.peakWithin5.toFixed(0)+'% of calls peaked within 5 min, '+t.peakWithin15.toFixed(0)+'% within 15, '+t.peakWithin60.toFixed(0)+'% within 60.'));
    box.append(el('p','margin:0 0 8px;color:'+C.muted,'Win = target hit before the stop. Each bucket\'s average per trade is compared with the rest of the calls. With '+rep.tested+' buckets tested, a few always look different by chance, so a bucket only "stands out" (green or red) when it and the rest have 15+ calls each and the gap clears a bar corrected for all '+rep.tested+' tests (about a 5% chance per report of any false find). Past calls only: a filter is worth using only if it keeps working on new calls.'));
    box.append(el('p','margin:0 0 8px;color:'+C.muted,'"Move into entry" = your fill vs the last trade before the alert: how far the call\'s own crowd had already pushed the price (the live panel\'s "vs call MC" number). "Run-up" = the 15 min before the alert; '+o.runUps+' of '+o.rows.length+' calls have those prices so far (older calls get them on the next "Score calls").'));
    box.append(el('p','margin:0 0 8px;color:'+C.muted,'Rug checks: '+o.rug.n+' of '+o.rows.length+' calls have one'+(o.rug.cut?' ('+o.rug.cut+' busy coins have only the launch block and funder)':'')+'. The rules (top 10 over 25%, dev over 5% or selling, 4+ launch-block wallets) come from an article and are untested; the tables below show whether they mattered on your calls. Add checks to more calls with "Add rug checks to past calls".'));
    box.append(el('p','margin:0 0 8px;color:'+C.muted,'Live score at the call (GMGN numbers + chain checks): '+o.gmN+' of '+o.rows.length+' calls have one; '+o.gmUsed+' of them were saved before this entry time and are used (a score saved after the entry is left out, so it cannot peek). Usually saved 10 to 40s after the alert: choose "Buy at 1 min" to test it. GMGN only gives today'+String.fromCharCode(8217)+'s numbers, so this builds up from calls that open on GMGN from 3.9 on; the "Live grade" and "Live score" tables need about 100 of them before they say much.'));
    const pf=v=>v==null?'n/a':(v>=0?'+':'')+v.toFixed(0)+'%';
    box.append(el('p','margin:0 0 8px;color:'+C.muted,'Exit data: '+o.noExit+' call'+(o.noExit===1?'':'s')+' had no trade after the entry and '+o.incomplete+' had candles that did not reach the end of the 2h window; both are left out, not counted as flat. '
      +o.staleExits+' scored call'+(o.staleExits===1?'':'s')+' ended still open with no trade in the last 15+ min, so the exit is a stale price, not a fill'+(o.staleExits?': they average '+pf(o.staleSum.ev)+' and are kept above (never as wins); without them the win rate is '+(o.fresh.winRate==null?'n/a':o.fresh.winRate.toFixed(0)+'%')+' and the average '+pf(o.fresh.ev)+'.':'.')
      +' Coverage assumes GeckoTerminal is at most 5 min behind when the candles were fetched'+(o.legacyCache?'; '+o.legacyCache+' older caches have no fetch time and are counted as covered':'')+'.'
      +(o.rug.old?' '+o.rug.old+' rug checks were saved before 4.2 and are not used in the tables until re-checked ("Add rug checks to past calls").':'')));
    const gap=r=>r.diff==null?'':(r.diff>=0?'+':'')+r.diff.toFixed(0)+' pts vs the rest';
    for(const f of rep.features){
      box.append(el('h3','margin:16px 0 4px;font-size:14px',f.name));
      table('Bucket',f.rows.map(r=>[[r.label,String(r.n),rate(r),pct(r.ev),pct(r.medianPeak),r.standsOut==='above'?'better than the rest ('+gap(r)+')':r.standsOut==='below'?'worse than the rest ('+gap(r)+')':r.few?'too few calls':gap(r)?gap(r)+' (within chance)':''],
        r.standsOut==='above'?C.green:r.standsOut==='below'?C.red:r.few?'#6f7d8d':'']));
    }
    eachCall();
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
        // One tab shows one coin, so the newest call wins. Older live calls that never opened here are marked skipped
        // (they keep their background checks and pings, and stay in Calls) and named, so a fast double call is not silent.
        const skipped=calls().filter(c=>!c.historical&&!c.manual&&!c.unverified&&c.id!==call.id&&!receipts[c.id]&&c.messageAt<call.messageAt&&Date.now()-c.messageAt<120000);
        for(const c of skipped)receipts[c.id]=-Date.now();
        // Durable receipt BEFORE navigation: startup replay cannot reload this call again.
        latMark(call.mint,'handoff');
        receipts[call.id]=Date.now();set('receipts',Object.fromEntries(Object.entries(receipts).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,1000)));
        notice(skipped.length?'Opened '+call.name+' (newest); skipped '+skipped.map(c=>c.name).join(', ')+': see Calls':'Received '+call.name+' once');
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
    if(!GMGN||flowing||!current||!get('trades',true)||liveFresh()||Date.now()-get('bt.busy',0)<30000)return;
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
  $('bt-run').onclick=()=>runBacktest();$('bt-history').onclick=()=>loadHistory();$('bt-report').onclick=()=>openReport();$('copy').onclick=()=>{if(current)GM_setClipboard(current,'text');};
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
  GM_addValueChangeListener(PREFIX+'late',()=>renderLate());
  every(5000,lateChecks);every(15000,renderLate);every(5000,rugTick);
  GM_addValueChangeListener(PREFIX+'rugIds',()=>{rugIdx=null;});
  if(GMGN){
    GM_addValueChangeListener(PREFIX+'latest',()=>receiveLatest());
    VTLive.on(frame=>{
      const now=Date.now(), pageMint=VTCore.mintFromURL(location.href);
      if(!pageMint)return;
      if(live.mint!==pageMint)switchLive(pageMint);
      let changed=false;
      for(const x of frame.items){
        // Only the token on screen. GMGN's rows carry the token address; a row without one is never assumed to match.
        const a=VTCore.addrOf(x);if(a!==pageMint)continue;
        if(frame.channel==='token_stat'){live.stat=VTCore.gmgnStat(x,now);changed=true;continue;}
        // Maker info: GMGN's label for the wallet behind each trade (the trade itself also comes on token_activity).
        if(frame.channel==='token_activity_info_all'){putProf(VTCore.gmgnMaker(x));const it=VTCore.gmgnTrade(x);if(it)gmOnTrade(it,pageMint);changed=true;continue;}
        const t=VTCore.gmgnTrade(x), key=t&&tradeKey(t);if(!t||key&&live.keys.has(key))continue;
        if(key)live.keys.add(key);live.trades.push(t);changed=true;
        // Rug checks: every trade updates the holders live; a dev sale alerts at once.
        const RL=rugLive.get(pageMint);if(RL?.status==='ok'){const ev=rugFeed(RL,t);if(ev)devAlert(RL,ev);}
        gmOnTrade(t,pageMint);
        if(t.sol>0&&t.usd>0){solUsd=t.usd/t.sol;solAt=now;}
      }
      if(!changed)return;
      live.at=now;live.first=live.first||now;latMark(pageMint,'feed');
      if(now-live.prunedAt>10000){live.prunedAt=now;live.trades=live.trades.filter(t=>now-t.at<=360000).slice(-3000);live.keys=new Set(live.trades.map(tradeKey).filter(Boolean));}
      soon();
    });
    // Mark the role as leaving: this tab's next page takes it back at once; if the tab closed, another can take it after 20s.
    addEventListener('pagehide',()=>{try{recordBots(true);}catch(_){}const r=receiver();if(r?.id===TAB)set('receiver',{...r,leaving:Date.now()});});
    let ticking=false, lastBeat=0;
    async function tick(){
      if(ticking)return;ticking=true;
      try{
        const next=VTCore.mintFromURL(location.href);
        if(next!==lastMint){lastMint=next;current=next;snapshot=null;flow=null;gtPools={};fetchError='';flowError='';lastResponse=0;lastFlow=0;if(live.mint!==next)switchLive(next);}
        if(Date.now()-lastBeat>=5000){lastBeat=Date.now();isReceiver=await ownReceiver();}
        status=(isReceiver?'Receiving calls':'Display only: another GMGN tab receives calls')+' · '+(liveFresh()?'live from GMGN':'fallback data');
        if(isReceiver)receiveLatest();
        if(isReceiver&&get('marketOn',true)){
          marketConnect();refreshSol();
          if(Date.now()-lastSnap>=10000){lastSnap=Date.now();tape.prune(lastSnap);if(ppSince)set('marketSnap',marketView());}
        }else if(pp)marketDisconnect();
        if(current&&live.mint===current&&!live.fill)backfillTrades(current);
        if(current)latMark(current,'open');
        recordBots();rugAuto();rugCatchTick();gmTick();jupTick();rcTick();poll();pollFlow();render();
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
    // VolTrak's sender ID (the number in its avatar URL), learned from the alerts on screen (the most common one) unless
    // AUTHOR_ID is set. A "VolTrak" alert from another ID is saved but flagged unverified: it is not opened on GMGN and
    // not pinged. Settings → "Re-learn VolTrak sender" resets it (e.g. if VolTrak changes its bot).
    const authorIdOf=li=>headerOf(li)?.li.querySelector('img[src*="/avatars/"]')?.src.match(/\/avatars\/(\d+)\//)?.[1]||null;
    const trustedId=()=>AUTHOR_ID||get('authorId','');
    const senderMode=()=>AUTHOR_ID?'':get('authorMode','');
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
        // Learn the sender from the alerts on screen: the most common avatar ID among VolTrak-named alerts (3+ needed).
        // Learn the sender from the alerts on screen: the most common account ID among VolTrak-named alerts (3+ needed).
        // If 3+ VolTrak alerts carry no account ID at all, VolTrak cannot be told apart by account: "name-only" mode,
        // shown in Settings. Until either is learned, no alert is opened or pinged automatically.
        if(!trustedId()&&!senderMode()){const n=new Map();let none=0;for(const li of lis){if(fromVolTrak(li)!==true||!VTCore.parseAlert(alertText(li)))continue;const a=authorIdOf(li);if(a)n.set(a,(n.get(a)||0)+1);else none++;}
          const best=[...n].sort((a,b)=>b[1]-a[1])[0];if(best&&best[1]>=3)set('authorId',best[0]);else if(!n.size&&none>=3)set('authorMode','name-only');}
        for(const li of lis){
          const id=li.id.match(/-(\d+)$/)?.[1];if(!id||existing.has(id)||others.has(id))continue;
          const who=fromVolTrak(li);if(who===false)others.add(id);if(!who)continue;
          const parsed=VTCore.parseAlert(alertText(li));if(!parsed)continue;
          const messageAt=originalTime(li), now=Date.now();if(!Number.isFinite(messageAt))continue;
          const historical=initial||now-messageAt>30000||messageAt>now+5000;
          const aid=authorIdOf(li), trust=VTCore.senderTrust(aid,trustedId(),senderMode()), unverified=trust!=='ok';
          const call={...parsed,id,messageAt,receivedAt:now,historical,...(unverified?{unverified:true,sender:trust,authorId:aid}:{})};
          if(!await addCall(call))continue;existing.add(id);
          if(!historical&&unverified){
            const why={mismatch:'sent by a different account than usual',['no-id']:'its account could not be read',unknown:'the VolTrak account is not learned yet'}[call.sender]||'sender not verified';
            GM_notification({title:'Unverified VolTrak sender · '+call.name,text:'Named VolTrak but '+why+'. Saved in Calls; not opened, pinged or checked. If VolTrak changed its bot, use Settings → Re-learn VolTrak sender.',timeout:15000});
          }else if(!historical){
            await locked('publish',()=>{
              const sent=get('published',{});if(now-(sent[call.mint]||0)<60000)return;
              sent[call.mint]=now;set('published',Object.fromEntries(Object.entries(sent).filter(([,t])=>now-t<600000)));set('latest',call);
              GM_setClipboard(call.mint,'text');announce(call);
              GM_notification({title:'VolTrak · '+call.name,text:receiverAlive(receiver())?'Context sent to GMGN.':'No GMGN receiver. Open GMGN to review.',timeout:6000});
              tgCall(call);
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
