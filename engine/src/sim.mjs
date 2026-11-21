// Exit simulation for one position on the real trade path after entry.
// Our own order is not fed back into the path (fine for small sizes; noted in the report).
import { buyOut, sellOut, spot, padConfig } from './curve.mjs';

const MIN = 60_000;

// The agreed default ("runner") and a tighter "steady" style.
export const POLICIES = {
  runner: { stop: -0.25, tp: 0.40, tpFrac: 0.5, trail: 0.25, earlyMin: 60, earlyNeed: 0.15, maxHoldMin: 240 },
  steady: { stop: -0.20, tp: 0.30, tpFrac: 0.7, trail: 0.15, earlyMin: 45, earlyNeed: 0.10, maxHoldMin: 120 },
};

export const DEFAULT_COSTS = {
  entrySlip: 0.015,   // drift + crowding between quote and landing, on top of exact curve impact
  exitSlip: 0.015,
  txSol: 0.0005,      // base + priority fee + tip, per transaction
  rugDrop: 0.6,       // price down 60%+ from its 60-second high = rug event
  rugWindowMs: 60_000,
  rugLossFull: true,  // agreed rule: a rug while holding counts as -100% of what is still held
};

// Rug detector: price down rugDrop or more from its high over the last window (the price just before the
// window counts, so a single dump trade after a quiet minute is still caught).
function rugWatch(costs, t0, s0) {
  const win = [[t0, s0]];
  return (t, s) => {
    let hi = s;
    for (const [, x] of win) if (x > hi) hi = x;
    win.push([t, s]);
    while (win.length > 1 && win[1][0] <= t - costs.rugWindowMs) win.shift();
    return s <= hi * (1 - costs.rugDrop);
  };
}

export function simulateTrade(coin, entryT, size, policy = POLICIES.runner, costs = DEFAULT_COSTS) {
  const fee = padConfig(coin.pad).fee, trades = coin.trades;
  let j = 0; while (j < trades.length && trades[j].t <= entryT) j++;
  const cfg = padConfig(coin.pad);
  let vSol = j > 0 ? trades[j - 1].vSol : cfg.vSol0, vTok = j > 0 ? trades[j - 1].vTok : cfg.vTok0;
  const entrySpot = spot(vSol, vTok);
  let tokens = buyOut(vSol, vTok, size, fee) * (1 - costs.entrySlip);
  let proceeds = -costs.txSol, peakM = 1, tpDone = false, rugSeen = false, reason = null, exitT = null, txs = 1;
  const isRug = rugWatch(costs, entryT, entrySpot);
  const earlyMs = policy.earlyMin * MIN, maxMs = policy.maxHoldMin * MIN;

  const sellAll = (t, why, value) => {
    proceeds += (value ?? sellOut(vSol, vTok, tokens, fee) * (1 - costs.exitSlip)) - costs.txSol;
    txs++; tokens = 0; exitT = t; reason = why;
  };

  for (let k = j; k < trades.length && tokens > 0; k++) {
    const tr = trades[k];
    // Time rules fire on the clock, before the next trade moves the price.
    if (!tpDone && peakM < 1 + policy.earlyNeed && tr.t > entryT + earlyMs) { sellAll(entryT + earlyMs, 'noMove'); break; }
    if (tr.t > entryT + maxMs) { sellAll(entryT + maxMs, 'maxHold'); break; }
    vSol = tr.vSol; vTok = tr.vTok;
    const s = spot(vSol, vTok), m = s / entrySpot;
    if (m > peakM) peakM = m;
    if (isRug(tr.t, s)) {
      rugSeen = true;
      if (costs.rugLossFull) { sellAll(tr.t, 'rug', 0); break; }
      sellAll(tr.t, 'rug'); break;
    }
    if (m <= 1 + policy.stop) { sellAll(tr.t, 'stop'); break; }
    if (!tpDone && m >= 1 + policy.tp) {
      const part = tokens * policy.tpFrac;
      proceeds += sellOut(vSol, vTok, part, fee) * (1 - costs.exitSlip) - costs.txSol; txs++;
      tokens -= part; tpDone = true;
    }
    if (tpDone && m <= peakM * (1 - policy.trail)) { sellAll(tr.t, 'trail'); break; }
  }
  if (tokens > 0) {
    // No more trades: the coin went quiet. Exit at the last known price when the time rule would have fired.
    const t = !tpDone && peakM < 1 + policy.earlyNeed ? entryT + earlyMs : entryT + maxMs;
    sellAll(t, 'quiet');
  }
  // Rug rate counts any rug within the holding window, even after we already left.
  if (!rugSeen) {
    const watch = rugWatch(costs, entryT, entrySpot);
    for (let k = j; k < trades.length && trades[k].t <= entryT + maxMs; k++) {
      const tr = trades[k];
      if (watch(tr.t, spot(tr.vSol, tr.vTok))) { rugSeen = true; break; }
    }
  }
  const pnl = proceeds - size;
  return { mint: coin.mint, entryT, exitT, size, pnl, ret: pnl / size, reason, rug: reason === 'rug', rugSeen, peakM, txs };
}
