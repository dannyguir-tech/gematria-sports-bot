#!/usr/bin/env node
// Usage:
//   node engine/bin/backtest.mjs --fake 2000 --days 14 --seed 1
//   node engine/bin/backtest.mjs --data coins.jsonl
// Writes report.md and result.json to --out (default engine/out).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeDataset } from '../src/fake.mjs';
import { loadCoins } from '../src/data.mjs';
import { fullBacktest } from '../src/backtest.mjs';
import { FILTERS } from '../src/rules.mjs';
import { renderReport } from '../src/report.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') && a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]), a), []));
const out = args.out || join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
let coins, source, notes = null;
if (args.data) {
  const r = loadCoins(args.data); coins = r.coins; source = args.data; notes = { ...r.notes, rejected: r.rejected.length };
} else {
  coins = fakeDataset({ n: +(args.fake || 2000), days: +(args.days || 14), seed: +(args.seed || 1) }); source = 'fake';
}
const t0 = Date.now();
const result = fullBacktest(coins, { filterNames: FILTERS.map(f => f[0]), seed: +(args.seed || 7) });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
writeFileSync(join(out, 'report.md'), renderReport(result, { source, notes }));
console.log(`${coins.length} coins, ${result.signals} signals, ${((Date.now() - t0) / 1000).toFixed(1)} s → ${join(out, 'report.md')}`);
