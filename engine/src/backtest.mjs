// Scan coins for entries, run them through a day-by-day portfolio, and score the result.
import { makeTracker } from './features.mjs';
import { decide, safetyVetoes, DEFAULT_PARAMS } from './rules.mjs';
import { simulateTrade, POLICIES, DEFAULT_COSTS } from './sim.mjs';

const MIN = 60_000, DAY = 86_400_000;

export const DEFAULT_PORTFOLIO = {
  bankroll: 10,          // SOL at the start
  sizeFrac: 0.03,        // 3% of the day's starting bankroll per trade
  maxTradesPerDay: 15,
  maxOpen: 4,
  dailyLossCap: 0.10,    // stop entering for the day after losing 10% of the day's starting bankroll
  tzOffsetMin: 0,        // day boundary (0 = UTC)
};

// First moment the rules say buy, checking every scanMs from launch.
export function findEntry(coin, params = DEFAULT_PARAMS, opts = {}) {
  const scanMs = opts.scanMs ?? 30_000, disabled = opts.disabled || null;
  if (safetyVetoes(coin, params).length) return null;
  const tr = makeTracker(coin, opts);
  const start = coin.createdAt + params.minAgeMin * MIN, end = coin.createdAt + params.maxAgeMin * MIN;
  for (let t = start; t <= end; t += scanMs) {
    const f = tr.featuresAt(t);
    if (decide(f, coin, params, disabled).buy) return { t, features: f };
  }
  return null;
}

const dayOf = (t, tz) => Math.floor((t + tz * MIN) / DAY);

export function runPortfolio(signals, coinsByMint, policy = POLICIES.runner, costs = DEFAULT_COSTS, pf = DEFAULT_PORTFOLIO) {
  const sorted = [...signals].sort((a, b) => a.t - b.t);
  let bankroll = pf.bankroll, curDay = null, dayStart = bankroll, dayCount = 0;
  const open = [], closed = [], days = new Map(), skipped = { dayCap: 0, lossCap: 0, maxOpen: 0 };
  const realize = upTo => {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitT <= upTo) {
      const p = open.splice(k, 1)[0]; bankroll += p.pnl; closed.push(p);
      const d = dayOf(p.exitT, pf.tzOffsetMin); days.set(d, (days.get(d) || 0) + p.pnl);
    }
  };
  for (const s of sorted) {
    realize(s.t);
    const d = dayOf(s.t, pf.tzOffsetMin);
    if (d !== curDay) { curDay = d; dayStart = bankroll; dayCount = 0; if (!days.has(d)) days.set(d, 0); }
    const todayRealized = closed.filter(p => dayOf(p.exitT, pf.tzOffsetMin) === d).reduce((a, p) => a + p.pnl, 0);
    if (todayRealized <= -pf.dailyLossCap * dayStart) { skipped.lossCap++; continue; }
    if (dayCount >= pf.maxTradesPerDay) { skipped.dayCap++; continue; }
    if (open.length >= pf.maxOpen) { skipped.maxOpen++; continue; }
    const size = Math.max(0, dayStart * pf.sizeFrac);
    if (size <= 0) break;
    const r = simulateTrade(coinsByMint.get(s.mint), s.t, size, policy, costs);
    open.push(r); dayCount++;
  }
  realize(Infinity);
  return { trades: closed.sort((a, b) => a.entryT - b.entryT), days, endBankroll: bankroll, startBankroll: pf.bankroll, skipped };
}

export function score(run, allDays = null, tz = 0) {
  const daysArr = allDays ? allDays.map(d => [d, run.days.get(d) || 0]) : [...run.days.entries()].sort((a, b) => a[0] - b[0]);
  const tradeDays = new Set(run.trades.map(t => dayOf(t.exitT, tz)));
  const n = run.trades.length, pcts = [];
  let peak = run.startBankroll, eq = run.startBankroll, maxDD = 0;
  for (const [d, v] of daysArr) {
    if (tradeDays.has(d)) pcts.push(v / eq); // each day as a share of that day's starting bankroll
    eq += v; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak);
  }
  const green = pcts.filter(v => v > 0).length;
  return {
    trades: n, tradingDays: pcts.length,
    greenDays: pcts.length ? green / pcts.length : 0,
    avgDailyPct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0,
    medianDailyPct: pcts.length ? [...pcts].sort((a, b) => a - b)[Math.floor(pcts.length / 2)] : 0,
    worstDayPct: pcts.length ? Math.min(...pcts) : 0,
    totalReturn: run.endBankroll / run.startBankroll - 1,
    maxDrawdown: maxDD,
    winRate: n ? run.trades.filter(t => t.pnl > 0).length / n : 0,
    avgTradeRet: n ? run.trades.reduce((a, t) => a + t.ret, 0) / n : 0,
    rugRate: n ? run.trades.filter(t => t.rugSeen).length / n : 0,
    rugHitRate: n ? run.trades.filter(t => t.rug).length / n : 0,
    exits: run.trades.reduce((a, t) => (a[t.reason] = (a[t.reason] || 0) + 1, a), {}),
    skipped: run.skipped,
  };
}

// Seeded RNG so every report is reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Baseline: random allowed-launchpad coins (safety vetoes only), random entry time in the same age window,
// as many per day as the strategy took.
export function randomSignals(coins, strategySignals, params = DEFAULT_PARAMS, seed = 7, pf = DEFAULT_PORTFOLIO) {
  const rand = rng(seed), perDay = new Map();
  for (const s of strategySignals) { const d = dayOf(s.t, pf.tzOffsetMin); perDay.set(d, (perDay.get(d) || 0) + 1); }
  const byDay = new Map();
  for (const c of coins) if (!safetyVetoes(c, params).length) { const d = dayOf(c.createdAt, pf.tzOffsetMin); (byDay.get(d) || byDay.set(d, []).get(d)).push(c); }
  const out = [];
  for (const [d, k] of perDay) {
    const pool = byDay.get(d) || [];
    for (let i = 0; i < k && pool.length; i++) {
      const c = pool[Math.floor(rand() * pool.length)];
      const t = c.createdAt + (params.minAgeMin + rand() * (params.maxAgeMin - params.minAgeMin)) * MIN;
      out.push({ mint: c.mint, t });
    }
  }
  return out;
}

// One pass per coin: features are computed once per scan step and every rule set (all filters, and each
// filter switched off) records its own first entry.
export function scanCoin(coin, params = DEFAULT_PARAMS, disabledSets = [null], opts = {}) {
  const out = disabledSets.map(() => null);
  if (safetyVetoes(coin, params).length) return out;
  const scanMs = opts.scanMs ?? 30_000, tr = makeTracker(coin, opts);
  const start = coin.createdAt + params.minAgeMin * MIN, end = coin.createdAt + params.maxAgeMin * MIN;
  let left = disabledSets.length;
  for (let t = start; t <= end && left; t += scanMs) {
    const f = tr.featuresAt(t);
    for (let k = 0; k < disabledSets.length; k++) if (!out[k] && decide(f, coin, params, disabledSets[k]).buy) { out[k] = { mint: coin.mint, t }; left--; }
  }
  return out;
}

// Everything the report needs: strategy under each exit style, the random baseline, and one run per filter switched off.
export function fullBacktest(coins, { params = DEFAULT_PARAMS, costs = DEFAULT_COSTS, pf = DEFAULT_PORTFOLIO, seed = 7, filterNames = [] } = {}) {
  const byMint = new Map(coins.map(c => [c.mint, c]));
  const sets = [null, ...filterNames.map(f => new Set([f]))];
  const perSet = sets.map(() => []);
  for (const c of coins) scanCoin(c, params, sets).forEach((e, k) => e && perSet[k].push(e));
  const signals = perSet[0];
  const allDays = [...new Set(coins.map(c => dayOf(c.createdAt, pf.tzOffsetMin)))].sort((a, b) => a - b);
  const run = (sig, pol) => score(runPortfolio(sig, byMint, pol, costs, pf), allDays, pf.tzOffsetMin);
  const styles = {}, baseline = {}, ablation = {};
  const rand = randomSignals(coins, signals, params, seed, pf);
  for (const [name, pol] of Object.entries(POLICIES)) { styles[name] = run(signals, pol); baseline[name] = run(rand, pol); }
  filterNames.forEach((f, k) => { ablation[f] = run(perSet[k + 1], POLICIES.runner); });
  const archetypes = {};
  for (const s of signals) { const a = byMint.get(s.mint).archetype; if (a) archetypes[a] = (archetypes[a] || 0) + 1; }
  return { coins: coins.length, days: allDays.length, signals: signals.length, styles, baseline, ablation, archetypes };
}
