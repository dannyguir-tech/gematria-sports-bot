// Point-in-time features. A tracker walks a coin's trades forward in time; features at time t only ever
// use trades with trade.t <= t (no lookahead; tested).
import { padConfig, spot } from './curve.mjs';

const MIN = 60_000;
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };

export function makeTracker(coin, opts = {}) {
  const cfg = padConfig(coin.pad), supply = coin.supply || cfg.supply;
  const solUsd = opts.solUsd ?? 200, windowMs = opts.windowMs ?? 5 * MIN;
  const trades = coin.trades, funding = coin.funding || null;
  const creator = coin.creator;
  const createdSlot = coin.createdSlot ?? (trades[0] && trades[0].slot);

  // Cluster key: a wallet's funder (creator-funded wallets join the creator's cluster).
  const clusterOf = w => {
    if (w === creator) return 'C:' + creator;
    const f = funding && funding[w];
    if (!f) return 'W:' + w;
    return f === creator ? 'C:' + creator : 'F:' + f;
  };

  let i = 0, vSol = cfg.vSol0, vTok = cfg.vTok0, ath = spot(vSol, vTok);
  const hold = new Map(), buyers = new Set();
  let nBuys = 0, nSells = 0, volBuy = 0, volSell = 0, devBought = 0, devSold = 0, bundleTok = 0;
  const ts = [], cumBuy = [], cumSell = [], spots = [], lastBuySizes = [];
  const clBuy = new Map(), clSell = new Map();

  function step(tr) {
    vSol = tr.vSol; vTok = tr.vTok;
    const s = spot(vSol, vTok); if (s > ath) ath = s;
    const w = tr.wallet, cur = hold.get(w) || 0, k = clusterOf(w);
    if (tr.side === 'buy') {
      nBuys++; volBuy += tr.sol; buyers.add(w); hold.set(w, cur + tr.tokens);
      clBuy.set(k, (clBuy.get(k) || 0) + tr.sol);
      if (w === creator) devBought += tr.tokens;
      const sameSlot = tr.slot != null && createdSlot != null ? tr.slot === createdSlot : tr.t - coin.createdAt < 1000;
      if (sameSlot) bundleTok += tr.tokens;
      lastBuySizes.push(Math.round(tr.sol * 1000)); if (lastBuySizes.length > 20) lastBuySizes.shift();
    } else {
      nSells++; volSell += tr.sol; hold.set(w, Math.max(0, cur - tr.tokens));
      clSell.set(k, (clSell.get(k) || 0) + tr.sol);
      if (w === creator) devSold += tr.tokens;
    }
    ts.push(tr.t); cumBuy.push(volBuy); cumSell.push(volSell); spots.push(s);
  }

  const at = (arr, idx, dflt) => (idx >= 0 ? arr[idx] : dflt);

  function featuresAt(t) {
    while (i < trades.length && trades[i].t <= t) step(trades[i++]);
    const n = ts.length, s = spot(vSol, vTok), cut = lowerBound(ts, t - windowMs) - 1;
    const buyW = volBuy - at(cumBuy, cut, 0), sellW = volSell - at(cumSell, cut, 0);
    const spotAgo = at(spots, cut, spot(cfg.vSol0, cfg.vTok0));
    let holders = 0, devHold = 0; const top = [];
    for (const [w, b] of hold) {
      if (b <= supply * 1e-7) continue;
      holders++;
      if (w === creator) devHold = b;
      if (top.length < 10) { top.push(b); top.sort((a, c) => c - a); } else if (b > top[9]) { top[9] = b; top.sort((a, c) => c - a); }
    }
    let wash = 0;
    if (funding) for (const [k, b] of clBuy) { const sl = clSell.get(k) || 0; if (k[0] !== 'W' && sl > 0) wash += 2 * Math.min(b, sl); }
    const volTotal = volBuy + volSell;
    const counts = {}; let same = 0;
    for (const x of lastBuySizes) counts[x] = (counts[x] || 0) + 1;
    for (const x in counts) if (counts[x] >= 3) same += counts[x];
    return {
      t, ageMin: (t - coin.createdAt) / MIN, trades: n,
      price: s, mcapSol: s * supply, mcapUsd: s * supply * solUsd,
      realSol: vSol - cfg.vSol0,
      buys: nBuys, sells: nSells, uniqueBuyers: buyers.size, holders,
      vol5m: buyW + sellW, buyShare5m: buyW + sellW > 0 ? buyW / (buyW + sellW) : 0.5, volTotal,
      priceChange5m: s / spotAgo - 1, drawdownFromAth: 1 - s / ath,
      top10Share: top.reduce((a, b) => a + b, 0) / supply, maxHolderShare: (top[0] || 0) / supply,
      devShare: devHold / supply, devSoldFrac: devBought > 0 ? devSold / devBought : 0,
      bundleShare: bundleTok / supply,
      organicShare: funding ? (volTotal > 0 ? Math.max(0, 1 - wash / volTotal) : 1) : null,
      sameSizeShare: lastBuySizes.length >= 10 ? same / lastBuySizes.length : 0,
    };
  }
  return { featuresAt };
}
