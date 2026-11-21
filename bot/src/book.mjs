// Coins born while the bot runs: their trades, live features, and their exit to the collector files.
import { makeTracker } from '../../engine/src/features.mjs';

const MIN = 60_000;

export function makeBook({ maxTracked = 30_000, keepMin = 360, dudMin = 30, dudTrades = 10, onRetire = () => {} } = {}) {
  const coins = new Map(); // mint -> {coin, tracker, decided, entered}
  function addLaunch(e, ctx) {
    if (coins.has(e.mint)) return coins.get(e.mint);
    if (coins.size >= maxTracked) cull(ctx.t, true);
    const coin = { mint: e.mint, pad: 'pump', name: e.name, symbol: e.symbol, creator: e.user, bondingCurve: e.bondingCurve,
      createdAt: ctx.t, createdSlot: ctx.slot, provenance: true, mintInfo: null, trades: [] };
    const rec = { coin, tracker: makeTracker(coin), entered: false, vetoed: null, mintFetch: null };
    coins.set(e.mint, rec);
    return rec;
  }
  function addTrade(e, ctx) {
    const rec = coins.get(e.mint); if (!rec) return null; // born before the bot started: not tracked
    rec.coin.trades.push({ t: ctx.t, slot: ctx.slot, wallet: e.user, side: e.side, sol: e.sol, tokens: e.tokens, vSol: e.vSol, vTok: e.vTok });
    return rec;
  }
  function retire(mint, rec, why) { coins.delete(mint); try { onRetire(rec.coin, why); } catch {} }
  // Drop coins past their window, and duds; under memory pressure drop the oldest quiet ones first.
  function cull(now, pressure = false, isHeld = () => false) {
    for (const [mint, rec] of coins) {
      if (isHeld(mint)) continue;
      const age = (now - rec.coin.createdAt) / MIN;
      if (age > keepMin) retire(mint, rec, 'done');
      else if (age > dudMin && rec.coin.trades.length < dudTrades) retire(mint, rec, 'dud');
    }
    if (pressure && coins.size >= maxTracked) {
      const quiet = [...coins.entries()].filter(([m]) => !isHeld(m)).sort((a, b) => a[1].coin.trades.length - b[1].coin.trades.length || a[1].coin.createdAt - b[1].coin.createdAt);
      for (const [mint, rec] of quiet.slice(0, Math.ceil(maxTracked * 0.1))) retire(mint, rec, 'pressure');
    }
  }
  return { addLaunch, addTrade, cull, get: m => coins.get(m), size: () => coins.size, all: () => coins.values(), flush(why = 'shutdown') { for (const [m, r] of coins) retire(m, r, why); } };
}
