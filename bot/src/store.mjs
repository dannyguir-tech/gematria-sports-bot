// Append-only JSON Lines files under DATA_DIR: events, daily reports, and finished coins for the backtest.
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function makeStore(dir) {
  mkdirSync(dir, { recursive: true });
  const date = t => new Date(t).toISOString().slice(0, 10);
  const append = (name, obj) => { try { appendFileSync(join(dir, name), JSON.stringify(obj) + '\n'); } catch {} };
  return {
    event: e => append(`events-${date(e.t || Date.now())}.jsonl`, e),
    daily: r => append('daily.jsonl', r),
    coin: c => append(`coins-${date(c.createdAt)}.jsonl`, c),
    saveState(obj) { const p = join(dir, 'state.json'); try { writeFileSync(p + '.tmp', JSON.stringify(obj)); renameSync(p + '.tmp', p); } catch {} },
    loadState() { const p = join(dir, 'state.json'); try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; } },
    dir,
  };
}
