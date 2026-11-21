// Load real coins from JSON Lines (one coin per line) and check them before they reach the backtest.
// Format (docs in engine/README.md):
// {"mint","pad","creator","createdAt"(ms),"createdSlot"?,"supply"?,"provenance"?,"mintInfo"?,"funding"?,
//  "trades":[{"t"(ms),"slot"?,"wallet","side":"buy"|"sell","sol","tokens","vSol"?,"vTok"?}]}
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fillReserves } from './curve.mjs';

export function validateCoin(c) {
  const errs = [];
  if (!c.mint) errs.push('mint');
  if (!Number.isFinite(c.createdAt)) errs.push('createdAt');
  if (!Array.isArray(c.trades)) errs.push('trades');
  else for (const tr of c.trades) {
    if (!Number.isFinite(tr.t) || !tr.wallet || !(tr.side === 'buy' || tr.side === 'sell') || !(tr.sol >= 0) || !(tr.tokens >= 0)) { errs.push('trade'); break; }
  }
  return errs;
}

// path = one .jsonl file, or a folder: every coins-*.jsonl in it (what the paper bot writes).
export function loadCoins(path) {
  const coins = [], rejected = [], notes = { noMintInfo: 0, noFunding: 0, reservesRebuilt: 0 }, seen = new Set();
  const files = statSync(path).isDirectory() ? readdirSync(path).filter(f => /^coins-.*\.jsonl$/.test(f)).sort().map(f => join(path, f)) : [path];
  const lines = files.flatMap(f => readFileSync(f, 'utf8').split('\n'));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    let c; try { c = JSON.parse(line); } catch { rejected.push({ line: i + 1, why: 'json' }); continue; }
    const errs = validateCoin(c); if (errs.length) { rejected.push({ line: i + 1, why: errs.join(',') }); continue; }
    if (seen.has(c.mint)) continue; seen.add(c.mint);
    c.trades.sort((a, b) => a.t - b.t || (a.slot ?? 0) - (b.slot ?? 0));
    if (!c.mintInfo) notes.noMintInfo++;
    if (!c.funding) notes.noFunding++;
    if (c.trades.some(tr => !Number.isFinite(tr.vSol))) notes.reservesRebuilt++;
    coins.push(fillReserves(c));
  }
  coins.sort((a, b) => a.createdAt - b.createdAt);
  return { coins, rejected, notes };
}
