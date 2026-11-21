// Plain-language Markdown report from a fullBacktest result.
import { POLICIES, DEFAULT_COSTS } from './sim.mjs';
import { DEFAULT_PORTFOLIO } from './backtest.mjs';

export const TARGETS = { greenDays: 0.70, maxRugRate: 0.05, worstDay: -0.10 };
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';

function verdict(s, b) {
  const checks = [
    ['Green days ≥ 70%', s.greenDays >= TARGETS.greenDays, pct(s.greenDays, 0)],
    ['Rug rate < 5%', s.rugRate < TARGETS.maxRugRate, pct(s.rugRate)],
    ['Worst day ≥ −10%', s.worstDayPct >= TARGETS.worstDay, pct(s.worstDayPct)],
    ['Average day > 0 after costs', s.avgDailyPct > 0, pct(s.avgDailyPct, 2)],
    ['Beats random coins (avg day)', s.avgDailyPct > b.avgDailyPct, `${pct(s.avgDailyPct, 2)} vs ${pct(b.avgDailyPct, 2)}`],
    ['Enough trades to judge (≥ 100)', s.trades >= 100, String(s.trades)],
  ];
  return checks;
}

export function renderReport(r, { source, notes = null, policy = POLICIES, costs = DEFAULT_COSTS, pf = DEFAULT_PORTFOLIO } = {}) {
  const L = [];
  const fake = source === 'fake';
  L.push('# Backtest report', '');
  if (fake) L.push('> **FAKE DATA.** These coins were generated to test the engine. The numbers say the code works, **not** that the rules make money.', '');
  L.push(`Source: ${source} · ${r.coins} coins · ${r.days} days · ${r.signals} buy signals`, '');
  if (notes) L.push(`Data notes: ${Object.entries(notes).map(([k, v]) => `${k} ${v}`).join(', ')}`, '');

  const best = Object.entries(r.styles).sort((a, b) => b[1].greenDays - a[1].greenDays || b[1].avgDailyPct - a[1].avgDailyPct)[0];
  L.push(`## Verdict (best exit style: ${best[0]})`, '', '| Check | Result | Value |', '|---|---|---|');
  for (const [name, ok, v] of verdict(best[1], r.baseline[best[0]])) L.push(`| ${name} | ${ok ? 'pass' : '**fail**'} | ${v} |`);
  L.push('');

  L.push('## Rules vs random coins', '', '| | Trades | Green days | Avg day | Median day | Worst day | Win rate | Rug rate | Max drawdown | Total |', '|---|---|---|---|---|---|---|---|---|---|');
  const row = (n, s) => `| ${n} | ${s.trades} | ${pct(s.greenDays, 0)} | ${pct(s.avgDailyPct, 2)} | ${pct(s.medianDailyPct, 2)} | ${pct(s.worstDayPct)} | ${pct(s.winRate, 0)} | ${pct(s.rugRate)} | ${pct(s.maxDrawdown)} | ${pct(s.totalReturn)} |`;
  for (const [n, s] of Object.entries(r.styles)) L.push(row(`Rules, ${n}`, s));
  for (const [n, s] of Object.entries(r.baseline)) L.push(row(`Random, ${n}`, s));
  L.push('');

  L.push('## How positions ended', '', '| Style | ' + ['stop', 'trail', 'maxHold', 'noMove', 'quiet', 'rug'].join(' | ') + ' |', '|---|---|---|---|---|---|---|');
  for (const [n, s] of Object.entries(r.styles)) L.push(`| ${n} | ${['stop', 'trail', 'maxHold', 'noMove', 'quiet', 'rug'].map(k => s.exits[k] || 0).join(' | ')} |`);
  L.push('');

  const abl = Object.entries(r.ablation);
  if (abl.length) {
    const base = r.styles.runner;
    L.push('## Which filters matter (each one switched off, runner exits)', '', '| Filter off | Trades | Green days | Avg day | Rug rate | Verdict |', '|---|---|---|---|---|---|');
    for (const [f, s] of abl) {
      const same = s.trades === base.trades && Math.abs(s.avgDailyPct - base.avgDailyPct) < 1e-12;
      const worse = s.greenDays < base.greenDays || s.avgDailyPct < base.avgDailyPct || s.rugRate > base.rugRate;
      const better = s.greenDays >= base.greenDays && s.avgDailyPct > base.avgDailyPct && s.rugRate <= base.rugRate;
      const v = same ? 'does nothing here' : better ? 'filter hurts (results better without it)' : worse ? 'filter helps' : 'mixed';
      L.push(`| ${f} | ${s.trades} | ${pct(s.greenDays, 0)} | ${pct(s.avgDailyPct, 2)} | ${pct(s.rugRate)} | ${v} |`);
    }
    L.push('', 'A filter that "does nothing" never decided a trade on this data; it may still matter on other days.', '');
  }
  if (r.archetypes && Object.keys(r.archetypes).length) L.push('## Signals by fake archetype', '', Object.entries(r.archetypes).map(([k, v]) => `${k}: ${v}`).join(' · '), '');

  L.push('## Assumptions', '',
    `- Exit styles: ${Object.entries(policy).map(([n, p]) => `**${n}** stop ${pct(p.stop, 0)}, sell ${pct(p.tpFrac, 0)} at +${pct(p.tp, 0)}, trail ${pct(p.trail, 0)} from high, out after ${p.maxHoldMin} min or ${p.earlyMin} min if never +${pct(p.earlyNeed, 0)}`).join('; ')}.`,
    `- Costs: launchpad fee per side, exact curve impact, plus ${pct(costs.entrySlip)} / ${pct(costs.exitSlip)} extra slippage on entry / exit, ${costs.txSol} SOL per transaction.`,
    `- Rug: price down ${pct(costs.rugDrop, 0)} from its 60-second high; a rug while holding counts as −100% of what is still held.`,
    `- Portfolio: ${pf.bankroll} SOL start, ${pct(pf.sizeFrac, 0)} of the day's bankroll per trade, max ${pf.maxTradesPerDay} trades / day, max ${pf.maxOpen} open, stop for the day after −${pct(pf.dailyLossCap, 0)}.`,
    '- Entries are checked every 30 s using only data up to that moment. Our own orders are not fed back into the price path.',
    '- Random baseline: allowed-launchpad coins that pass the safety checks, random entry time in the same age window, same number per day.',
    '');
  return L.join('\n');
}
