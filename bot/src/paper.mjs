// Paper trading desk: the agreed portfolio rules around makePosition (the same exit code as the backtest).
import { makePosition } from '../../engine/src/sim.mjs';

const MIN = 60_000, DAY = 86_400_000;
export const dayOf = (t, tz = 0) => Math.floor((t + tz * MIN) / DAY);

export function makeDesk({ paper, policy, costs, tzOffsetMin = 0, onEvent = () => {} }) {
  const s = { bankroll: paper.bankroll, start: paper.bankroll, day: null, dayStart: paper.bankroll, dayPnl: 0, dayTrades: 0, dayWins: 0, dayRugs: 0, history: [], closed: 0 };
  const open = new Map(); // mint -> {pos, symbol, entryT}
  function rollDay(now) {
    const d = dayOf(now, tzOffsetMin);
    if (s.day === null) { s.day = d; return null; }
    if (d === s.day) return null;
    const rep = { day: s.day, pnl: s.dayPnl, pct: s.dayStart > 0 ? s.dayPnl / s.dayStart : 0, trades: s.dayTrades, wins: s.dayWins, rugs: s.dayRugs, bankroll: s.bankroll, open: open.size };
    if (s.dayTrades > 0) s.history.push(rep);
    s.day = d; s.dayStart = s.bankroll; s.dayPnl = 0; s.dayTrades = 0; s.dayWins = 0; s.dayRugs = 0;
    return rep;
  }
  // Can a new position open now? Returns null or the reason it can't.
  function blocked(now, degraded) {
    rollDay(now);
    if (degraded) return 'feedDegraded';
    if (s.dayPnl <= -paper.dailyLossCap * s.dayStart) return 'dailyLossCap';
    if (s.dayTrades >= paper.maxTradesPerDay) return 'dayTradeCap';
    if (open.size >= paper.maxOpen) return 'maxOpen';
    return null;
  }
  function enter(coin, now) {
    if (open.has(coin.mint)) return null;
    const last = coin.trades[coin.trades.length - 1]; if (!last) return null;
    const size = s.dayStart * paper.sizeFrac;
    const pos = makePosition({ pad: coin.pad, entryT: now, vSol: last.vSol, vTok: last.vTok, size, policy, costs });
    open.set(coin.mint, { pos, symbol: coin.symbol, mint: coin.mint, entryT: now });
    s.dayTrades++;
    const ev = { type: 'entry', t: now, mint: coin.mint, symbol: coin.symbol, size, price: pos.state.entrySpot, mcapSol: pos.state.entrySpot * 1e9 };
    onEvent(ev); return ev;
  }
  function settle(mint, o, ev) {
    open.delete(mint);
    const r = o.pos.result();
    s.bankroll += r.pnl; s.dayPnl += r.pnl; s.closed++; if (r.pnl > 0) s.dayWins++; if (r.rug) s.dayRugs++;
    onEvent({ type: 'exit', t: ev.t, mint, symbol: o.symbol, reason: r.reason, pnl: r.pnl, ret: r.ret, peak: r.peakM, held: (ev.t - o.entryT) / MIN, bankroll: s.bankroll });
  }
  function onTrade(mint, tr) {
    const o = open.get(mint); if (!o) return;
    for (const ev of o.pos.onTrade(tr)) {
      if (ev.type === 'partial') onEvent({ type: 'partial', t: ev.t, mint, symbol: o.symbol, sol: ev.sol });
      if (ev.type === 'exit') settle(mint, o, ev);
    }
  }
  function onClock(now) {
    for (const [mint, o] of [...open]) { const ev = o.pos.onClock(now); if (ev) settle(mint, o, ev); }
    return rollDay(now);
  }
  // Shutdown / restart: an open paper position can't be resumed exactly, so it is sold at its last price and flagged.
  function closeAll(now, reason) { for (const [mint, o] of [...open]) { const ev = o.pos.exitNow(now, reason); if (ev) settle(mint, o, ev); } }
  const summary = () => { const h = s.history, green = h.filter(x => x.pnl > 0).length;
    return { bankroll: s.bankroll, startBankroll: s.start, totalPct: s.bankroll / s.start - 1, today: { pnl: s.dayPnl, trades: s.dayTrades, wins: s.dayWins, rugs: s.dayRugs },
      days: h.length, greenDays: h.length ? green / h.length : null, worstDayPct: h.length ? Math.min(...h.map(x => x.pct)) : null, open: [...open.values()].map(o => ({ mint: o.mint, symbol: o.symbol, entryT: o.entryT, value: o.pos.markValue(), size: o.pos.state.size })) }; };
  return { blocked, enter, onTrade, onClock, closeAll, isHeld: m => open.has(m), summary, state: s, rollDay };
}
