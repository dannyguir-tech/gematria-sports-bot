// ==UserScript==
// @name         VolTrak Steroids
// @namespace    voltrak-alert
// @version      3.2.0
// @description  VolTrak context + GMGN handoff + GMGN live trade feed (read-only) with DEX fallbacks. Analysis only; never submits trades.
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
  return {MINT,number,money,parseAlert,mintFromURL,gmgnURL,selectPair,normalize,gtPool,tradeFlow,gmgnFrame,addrOf,gmgnTrade,gmgnStat,liveView,assess,initials,handoff};
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
  const VERSION=typeof GM_info!=='undefined'?GM_info.script.version:'3.2.0';
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
  #vts-root{position:fixed;right:16px;bottom:16px;width:350px;max-width:calc(100vw - 24px);z-index:2147483647;color:#e9eef6;font:12px/1.45 system-ui,sans-serif;box-shadow:0 8px 32px #0008;border:1px solid #3a4656;border-radius:14px;background:#111820}
  #vts-root *{box-sizing:border-box}#vts-root header{display:flex;align-items:center;gap:8px;padding:11px 13px;cursor:grab;border-bottom:1px solid #293444;font-weight:700}
  #vts-root .vts-body{padding:12px;max-height:70vh;overflow:auto}#vts-root h3{font-size:16px;margin:0 0 4px}#vts-root p{margin:6px 0}#vts-root .muted{color:#a7b4c4;font-size:11px}#vts-root .row{display:flex;justify-content:space-between;gap:8px;margin:5px 0}
  #vts-root button,#vts-root input,#vts-root select{font:inherit;border:1px solid #40516a;border-radius:6px;background:#1a2737;color:#edf3fc;padding:6px;max-width:100%}#vts-root button{cursor:pointer}#vts-root button:hover{background:#263b54}#vts-root input[type=checkbox]{width:auto}#vts-root input{width:100%}#vts-root .buttons{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}
  #vts-root .gauge{height:10px;position:relative;background:linear-gradient(90deg,#bf625f,#707d8f,#54ad91);border-radius:7px;margin:10px 0 4px}#vts-root .needle{height:18px;width:3px;background:white;position:absolute;top:-4px}#vts-root .warning{color:#f3c982}#vts-root ul{padding-left:16px;margin:8px 0}#vts-root details{border-top:1px solid #293444;margin-top:12px;padding-top:9px}#vts-root summary{cursor:pointer}#vts-root .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}#vts-root label{display:block;font-size:11px}#vts-root a{color:#8dc1ff}#vts-root .state{font-size:14px;font-weight:750;color:#e8d495}#vts-root code{word-break:break-all;font-size:10px}
  </style><header><span style="flex:1">VolTrak Steroids <small>3.2</small></span><button data-vts="collapse" title="Collapse">−</button></header><div class="vts-body">
  <div class="muted" data-vts="status"></div>
  <div data-vts="discord"><p>VolTrak calls → one GMGN receiver.</p><div data-vts="receiver"></div><p class="muted">Initial visible messages are saved for review. Only new, verified calls can move GMGN.</p></div>
  <div data-vts="gmgn"><div class="buttons"><button data-vts="claim">Use this GMGN tab</button><label><input data-vts="autoload" type="checkbox"> Load new calls</label></div>
  <h3 data-vts="token">Open a Solana token</h3><code data-vts="mint"></code><p class="muted" data-vts="feed"></p><div class="state" data-vts="state">UNKNOWN</div>
  <div class="gauge"><span class="needle" data-vts="needle" hidden></span></div><div class="row"><span>Sell side</span><b data-vts="share">—</b><span>Buy side</span></div>
  <p class="muted" data-vts="basis">Gauge = buy share of GMGN's 1m $ volume when live, else the best available fallback. Experimental context, not a buy/sell order or a probability.</p>
  <div data-vts="metrics"></div><ul data-vts="reasons"></ul><ul class="warning" data-vts="risks"></ul><p class="muted" data-vts="missing"></p>
  <div class="buttons"><button data-vts="refresh">Refresh snapshot</button><button data-vts="copy">Copy CA</button></div>
  <details><summary>Recover initials</summary><p>GMGN already offers <b>Sell inits</b> in its Instant Trade tools. Use GMGN to review and submit the sale.</p><p class="muted">Optional calculator: enter all amounts in the same currency. Bag value should be your estimated gross executable sale value. Quotes and fees can change.</p>
  <div class="grid"><label>Total buy cost<input data-vts="cost" type="number" min="0" step="any"></label><label>Net proceeds received<input data-vts="proceeds" type="number" min="0" step="any" value="0"></label><label>Remaining bag value<input data-vts="bag" type="number" min="0" step="any"></label><label>Sale fee/slippage allowance %<input data-vts="fee" type="number" min="0" max="99" step="any" value="0"></label><label>Fixed sale cost<input data-vts="fixed" type="number" min="0" step="any" value="0"></label></div>
  <div class="buttons"><button data-vts="initials">Calculate only</button></div><p data-vts="initials-result"></p><p class="muted">No order is filled or submitted by this script. Alt+I opens this calculator.</p></details></div>
  <details><summary>Calls and recording</summary><select data-vts="call-list" style="width:100%"></select><div class="buttons"><button data-vts="open">Open selected on GMGN</button><button data-vts="export">Export observations</button></div><p class="muted">Records call-time context and fetched snapshots while the receiving GMGN tab is running. Rolling 5m snapshots cannot reconstruct 1m trades. Export regularly.</p><label>Paste a complete VolTrak alert or a contract<input data-vts="paste" placeholder="Contract or alert text"></label><button data-vts="import">Add for review</button></details>
  <details><summary>Data and controls</summary><p>Live: GMGN's own page feed (token_activity trades and token_stat 1m/5m rollups), read-only, the same data GMGN shows. Nothing is sent on GMGN's connection.</p><p>Fallbacks when the live feed is quiet: DEX Screener snapshots (open token every 3s, recent calls every 10s in the receiving tab) and GeckoTerminal's latest-300-trades feed. No private keys or trading endpoints.</p><label><input type="checkbox" data-vts="trades"> GeckoTerminal fallback trade feed</label><label><input type="checkbox" data-vts="sound"> Voice on Discord only</label><p class="muted">Alt+V hides/shows this panel. Drag the header. Disable the old VolTrak script before using this replacement.</p></details>
  </div>`;
  document.body.appendChild(root);
  const $=key=>root.querySelector('[data-vts="'+key+'"]');
  $('discord').hidden=!DISCORD; $('gmgn').hidden=!GMGN;
  $('autoload').checked=get('autoload',true); $('sound').checked=get('sound',true); $('trades').checked=get('trades',true);
  $('autoload').onchange=()=>set('autoload',$('autoload').checked);
  $('sound').onchange=()=>set('sound',$('sound').checked);
  $('trades').onchange=()=>{set('trades',$('trades').checked);flow=null;flowError='';render();};
  $('collapse').onclick=()=>{const b=root.querySelector('.vts-body');b.hidden=!b.hidden;$('collapse').textContent=b.hidden?'+':'−';};
  let drag=null;
  root.querySelector('header').onpointerdown=e=>{if(e.target.closest('button'))return;const b=root.getBoundingClientRect();drag={x:e.clientX-b.left,y:e.clientY-b.top};e.currentTarget.setPointerCapture(e.pointerId);};
  root.querySelector('header').onpointermove=e=>{if(!drag)return;root.style.left=Math.max(0,Math.min(innerWidth-root.offsetWidth,e.clientX-drag.x))+'px';root.style.top=Math.max(0,Math.min(innerHeight-root.offsetHeight,e.clientY-drag.y))+'px';root.style.right='auto';root.style.bottom='auto';};
  root.querySelector('header').onpointerup=()=>{drag=null;};
  // e.code, not e.key: on macOS Option+V types "√", so e.key never equals "v".
  document.addEventListener('keydown',e=>{if(!e.altKey||e.ctrlKey||e.metaKey)return;if(e.code==='KeyV'){root.hidden=!root.hidden;e.preventDefault();}if(GMGN&&e.code==='KeyI'){root.hidden=false;root.querySelector('.vts-body').hidden=false;$('initials').closest('details').open=true;e.preventDefault();}});
  function listText(el,rows){el.replaceChildren(...rows.map(t=>{const li=document.createElement('li');li.textContent=t;return li;}));}
  const fmt=n=>n==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:2,notation:'compact'}).format(n);
  const usd=n=>n==null?'—':'$'+fmt(n);
  const ago=t=>t==null?'—':Math.max(0,Math.round((Date.now()-t)/1000))+'s ago';
  const freshFlow=()=>flow&&flow.mint===current&&Date.now()-flow.at<=30000?flow:null;
  let listSignature='';
  function render(){
    $('status').textContent=(Date.now()<noteUntil?note+' · ':'')+status+(hasLocks?'':' · Browser Web Locks unavailable: tab coordination is best effort');
    const all=calls().slice().sort((a,b)=>b.messageAt-a.messageAt), signature=all.map(c=>c.id).join('|');
    if(signature!==listSignature){const v=$('call-list').value;$('call-list').replaceChildren(...all.slice(0,100).map(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name+' · '+new Date(c.messageAt).toLocaleTimeString()+(c.historical?' · history':'');return o;}));if(all.some(c=>c.id===v))$('call-list').value=v;listSignature=signature;}
    if(DISCORD){$('receiver').textContent=receiverAlive(receiver())?'GMGN receiver connected':'Open GMGN and choose “Use this GMGN tab”.';return;}
    const now=Date.now(), c=all.find(x=>x.mint===current)||null, f=freshFlow(), L=liveNow(), a=VTCore.assess(c,snapshot,now,fetchError,f,L);
    const Lf=L&&now-L.at<=15000?L:null, st=Lf?.stat&&now-Lf.stat.at<=15000?Lf.stat:null, lf=Lf?.flow||null;
    $('token').textContent=c?.name|| (current?'Token context':'Open a Solana token');$('mint').textContent=current||'';
    $('feed').textContent=(Lf?'GMGN live · last update '+ago(Lf.at):VTLive.attachedAt()?'GMGN live: waiting for this token':'GMGN live: not connected (fallbacks below)')+' · '+(snapshot?'DEX '+ago(snapshot.at):'DEX: no pool yet')+(get('trades',true)&&!Lf?' · '+(flowError||(f?'GeckoTerminal '+ago(f.at):'GeckoTerminal starting')):'');
    $('state').textContent=a.state+(a.flags.length?' · '+a.flags.length+' flag'+(a.flags.length>1?'s':''):'');$('share').textContent=a.share==null?'—':Math.round(a.share)+'% buys';$('needle').hidden=a.share==null;if(a.share!=null)$('needle').style.left=Math.max(0,Math.min(100,a.share))+'%';
    $('basis').textContent='Gauge = buy share of '+(a.basis||'1m $ volume (≥10 trades) or 5m swap count')+'. Experimental context, not a buy/sell order or a probability.';
    const w1=st?.m1||lf?.m1||f?.m1, wallets=lf||f, part=w=>w.complete?'':'+', last=Lf?.last;
    const rows=[['1m buys / sells',w1?(w1.buys??'—')+' / '+(w1.sells??'—'):'—'],['1m buy $ / sell $',w1?usd(w1.buyUsd)+' / '+usd(w1.sellUsd):'—'],
      ['5m buys / sells',st?(st.m5.buys??'—')+' / '+(st.m5.sells??'—'):(snapshot?.buys5m??'—')+' / '+(snapshot?.sells5m??'—')],['5m / 1h volume',st?usd(st.m5.volume)+' / '+usd(st.h1.volume):usd(snapshot?.volume5m)+' / '+usd(snapshot?.volume1h)],
      ['Wallets 1m / 5m',wallets?wallets.m1.wallets+part(wallets.m1)+' / '+wallets.m5.wallets+part(wallets.m5):'—'],['Last trade',last?last.side+' '+usd(last.usd)+' · '+ago(last.at):f?ago(f.lastTradeAt):'—'],
      ['Indexed liquidity',usd(snapshot?.liquidity)],['Market cap / call MC',usd(Lf?.marketCap??snapshot?.marketCap)+' / '+usd(c?.callMc)],['Main pool',snapshot?(snapshot.dex||'DEX')+' · '+snapshot.pair?.slice(0,6)+(snapshot.pools>1?' (+'+(snapshot.pools-1)+')':''):'—'],['Alert migration status',c?.migrated==null?'unknown':c.migrated?'Migrated (at call)':'Bonding curve (at call)'],['Largest reported cluster',c?.clusters?.length?Math.max(...c.clusters)+'%':'—']];
    $('metrics').replaceChildren(...rows.map(([k,v])=>{const d=document.createElement('div');d.className='row';const l=document.createElement('span'),r=document.createElement('b');l.textContent=k;r.textContent=v;d.append(l,r);return d;}));
    listText($('reasons'),a.reasons);listText($('risks'),[...a.risks,...a.flags]);$('missing').textContent=a.missing.join(' · ');
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
  $('refresh').onclick=()=>{poll(true);pollFlow(true);};$('copy').onclick=()=>{if(current)GM_setClipboard(current,'text');};
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
        status=(isReceiver?'Receiving calls · ':'Display only (another GMGN tab receives calls) · ')+(liveFresh()?'GMGN live feed':'fallback polling')+(isReceiver?' · auto-load '+(get('autoload',true)?'on':'off'):'');
        if(isReceiver)receiveLatest();
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
