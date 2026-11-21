#!/usr/bin/env node
// Pull past Pumpfun launches into coins.jsonl for the backtest.
//
//   HELIUS_API_KEY=your-key node engine/bin/backfill.mjs --days 14 --perDay 150 --out coins.jsonl
//   HELIUS_API_KEY=your-key node engine/bin/backfill.mjs --check <launch signature>
//
// Or set HELIUS_RPC_URL to any Solana RPC URL. The key is never printed or written to the output.
// Resumable: coins already in the output file are skipped. Then run:
//   node engine/bin/backtest.mjs --data coins.jsonl
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { makeRpc, listLaunches, samplePerDay, fetchCoin } from '../src/backfill.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const url = process.env.HELIUS_RPC_URL || (process.env.HELIUS_API_KEY && `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);
if (!url) { console.error('Set HELIUS_API_KEY (or HELIUS_RPC_URL) first.'); process.exit(1); }

const stats = {};
const rpc = makeRpc(url, { rps: +arg('rps', 8), onStat: (m, s) => { const k = `${m} ${s}`; stats[k] = (stats[k] || 0) + 1; } });
const log = m => process.stderr.write(m + '\n');

if (argv.includes('--check')) {
  const sig = arg('check');
  const coin = await fetchCoin(rpc, { signature: sig, t: Date.now() }, { windowMin: +arg('window', 30) });
  if (coin.error) { console.log('No Pumpfun create event found in that transaction:', coin.error); process.exit(1); }
  console.log(`${coin.name} (${coin.symbol})  mint ${coin.mint}\ncreator ${coin.creator}\ncurve ${coin.bondingCurve}`);
  console.log('mint settings:', JSON.stringify(coin.mintInfo));
  console.log(`${coin.trades.length} trades in the first ${arg('window', 30)} min. First 15 — compare with a block explorer:`);
  for (const t of coin.trades.slice(0, 15)) console.log(`${new Date(t.t).toISOString()}  ${t.side.padEnd(4)} ${t.sol.toFixed(4)} SOL  ${Math.round(t.tokens).toLocaleString()} tokens  reserves ${t.vSol.toFixed(3)} SOL / ${Math.round(t.vTok).toLocaleString()}  https://solscan.io/tx/${t.sig}`);
  log('calls: ' + JSON.stringify(stats));
  process.exit(0);
}

const days = +arg('days', 14), perDay = +arg('perDay', 150), out = arg('out', 'coins.jsonl'), windowMin = +arg('window', 360);
const toMs = Date.now() - windowMin * 60_000, fromMs = toMs - days * 86_400_000; // every coin gets its full window
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).launchSig; } catch { return null; } }) : []);

log(`Listing launches from ${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}…`);
const launches = await listLaunches(rpc, { fromMs, toMs, log });
const sample = samplePerDay(launches, perDay, +arg('seed', 1)).filter(l => !done.has(l.signature));
log(`${launches.length} launches found; fetching ${sample.length} (${done.size} already done).`);
let n = 0, failed = 0;
for (const l of sample) {
  try {
    const coin = await fetchCoin(rpc, l, { windowMin });
    if (coin.error) { failed++; continue; }
    for (const t of coin.trades) delete t.sig;
    appendFileSync(out, JSON.stringify({ ...coin, launchSig: l.signature }) + '\n');
  } catch (e) { failed++; log(`skip ${l.signature}: ${e.message}`); }
  if (++n % 10 === 0) log(`${n}/${sample.length} coins (${failed} failed) · calls ${JSON.stringify(stats)}`);
}
log(`Done: ${n - failed} coins written to ${out}, ${failed} failed. Next: node engine/bin/backtest.mjs --data ${out}`);
