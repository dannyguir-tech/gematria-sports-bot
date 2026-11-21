// Exits for one position. makePosition() is driven trade by trade (and by the clock): the backtest replays past
// trades through it, the live paper bot feeds it trades as they arrive. One piece of code, so both always agree.
// Our own order is not fed back into the price path (fine for small sizes; noted in the report).
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
export function rugWatch(costs, t0, s0) {
  const win = [[t0, s0]];
  return (t, s) => {
    let hi = s;
    for (const [, x] of win) if (x > hi) hi = x;
    win.push([t, s]);
    while (win.length > 1 && win[1][0] <= t - costs.rugWindowMs) win.shift();
    return s <= hi * (1 - costs.rugDrop);
  };
}

// A position opened at entryT on reserves {vSol, vTok}. Returns events as they happen:
// {type: 'partial', t, sol} after the take-profit sale, {type: 'exit', t, reason} when closed.
export function makePosition({ pad, entryT, vSol, vTok, size, policy = POLICIES.runner, costs = DEFAULT_COSTS }) {
  const fee = padConfig(pad).fee, entrySpot = spot(vSol, vTok), isRug = rugWatch(costs, entryT, entrySpot);
  const earlyMs = policy.earlyMin * MIN, maxMs = policy.maxHoldMin * MIN;
  const p = { entryT, size, entrySpot, tokens: buyOut(vSol, vTok, size, fee) * (1 - costs.entrySlip), proceeds: -costs.txSol,
    peakM: 1, tpDone: false, rugSeen: false, reason: null, exitT: null, txs: 1, vSol, vTok, open: true };
  const sellValue = tok => sellOut(p.vSol, p.vTok, tok, fee) * (1 - costs.exitSlip);
  const close = (t, reason, value) => {
    p.proceeds += (value ?? sellValue(p.tokens)) - costs.txSol; p.txs++; p.tokens = 0; p.exitT = t; p.reason = reason; p.open = false;
    return { type: 'exit', t, reason };
  };
  // Time rules: fire at their deadline, on the last known price.
  function onClock(now) {
    if (!p.open) return null;
    if (!p.tpDone && p.peakM < 1 + policy.earlyNeed && now > entryT + earlyMs) return close(entryT + earlyMs, 'noMove');
    if (now > entryT + maxMs) return close(entryT + maxMs, 'maxHold');
    return null;
  }
  function onTrade(tr) {
    if (!p.open) return [];
    const timed = onClock(tr.t); if (timed) return [timed];
    p.vSol = tr.vSol; p.vTok = tr.vTok;
    const s = spot(p.vSol, p.vTok), m = s / entrySpot;
    if (m > p.peakM) p.peakM = m;
    if (isRug(tr.t, s)) { p.rugSeen = true; return [close(tr.t, 'rug', costs.rugLossFull ? 0 : undefined)]; }
    if (m <= 1 + policy.stop) return [close(tr.t, 'stop')];
    const out = [];
    if (!p.tpDone && m >= 1 + policy.tp) {
      const part = p.tokens * policy.tpFrac, sol = sellValue(part);
      p.proceeds += sol - costs.txSol; p.txs++; p.tokens -= part; p.tpDone = true;
      out.push({ type: 'partial', t: tr.t, sol });
    }
    if (p.tpDone && m <= p.peakM * (1 - policy.trail)) out.push(close(tr.t, 'trail'));
    return out;
  }
  // No more trades (backtest data ended / coin went quiet): close when the time rule would have fired.
  function finish(reason = 'quiet') {
    if (!p.open) return null;
    return close(!p.tpDone && p.peakM < 1 + policy.earlyNeed ? entryT + earlyMs : entryT + maxMs, reason);
  }
  const markValue = () => p.open ? p.proceeds + sellValue(p.tokens) : p.proceeds;
  const result = () => { const pnl = p.proceeds - size;
    return { entryT, exitT: p.exitT, size, pnl, ret: pnl / size, reason: p.reason, rug: p.reason === 'rug', rugSeen: p.rugSeen, peakM: p.peakM, txs: p.txs, open: p.open }; };
  const exitNow = (t, reason) => (p.open ? close(t, reason) : null); // sell everything at the last known price
  return { onTrade, onClock, finish, exitNow, markValue, result, state: p };
}

export function simulateTrade(coin, entryT, size, policy = POLICIES.runner, costs = DEFAULT_COSTS) {
  const trades = coin.trades, cfg = padConfig(coin.pad);
  let j = 0; while (j < trades.length && trades[j].t <= entryT) j++;
  const vSol = j > 0 ? trades[j - 1].vSol : cfg.vSol0, vTok = j > 0 ? trades[j - 1].vTok : cfg.vTok0;
  const pos = makePosition({ pad: coin.pad, entryT, vSol, vTok, size, policy, costs });
  for (let k = j; k < trades.length && pos.state.open; k++) pos.onTrade(trades[k]);
  pos.finish('quiet');
  const r = pos.result();
  // Rug rate counts any rug within the holding window, even after we already left.
  if (!r.rugSeen) {
    const watch = rugWatch(costs, entryT, pos.state.entrySpot), maxMs = policy.maxHoldMin * MIN;
    for (let k = j; k < trades.length && trades[k].t <= entryT + maxMs; k++) {
      if (watch(trades[k].t, spot(trades[k].vSol, trades[k].vTok))) { r.rugSeen = true; break; }
    }
  }
  return { mint: coin.mint, ...r };
}
