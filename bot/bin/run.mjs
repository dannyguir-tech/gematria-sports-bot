#!/usr/bin/env node
// Start the paper bot:  node bot/bin/run.mjs
// Settings: environment variables (see bot/.env.example and bot/DEPLOY.md).
import { createServer } from 'node:http';
import { loadConfig, redact } from '../src/config.mjs';
import { makeStore } from '../src/store.mjs';
import { createBot } from '../src/bot.mjs';

const cfg = loadConfig();
const log = m => console.log(new Date().toISOString(), m);
if (!cfg.wsUrl) { log('Missing HELIUS_API_KEY (or WS_URL). Set it in the server settings, never in the code.'); process.exit(1); }
if (typeof WebSocket === 'undefined') { log('This Node has no built-in WebSocket: use Node 22 or newer.'); process.exit(1); }
log('config ' + JSON.stringify(redact(cfg)));

const store = makeStore(cfg.dataDir);
const bot = createBot({ cfg, store, log });
bot.start();

// Health page for the host (and for you): /health is "ok" or 503, /status has the numbers.
createServer((req, res) => {
  const st = bot.status();
  if (req.url === '/health') { res.writeHead(st.feed.connected && !st.degraded ? 200 : 503, { 'content-type': 'text/plain' }); return res.end(st.degraded ? 'degraded' : 'ok'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(st, null, 2));
}).listen(cfg.port, () => log(`status on :${cfg.port}/status`));

setInterval(() => { const s = bot.status(); log(`feed ${s.feed.connected ? 'up' : 'DOWN'} msgs ${s.feed.msgs} events ${s.feed.events} misses ${s.feed.decodeMisses} · tracked ${s.tracked} · launches ${s.counts.launches} signals ${s.counts.signals} · bankroll ${s.paper.bankroll.toFixed(3)} open ${s.paper.open.length}`); }, 60_000);

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  if (stopping) return; stopping = true; log(`${sig}: closing paper positions at last price, saving state`);
  bot.stop('shutdown'); setTimeout(() => process.exit(0), 1500); // let the last Telegram message go out
});
process.on('uncaughtException', e => log('uncaught: ' + (e.stack || e)));
process.on('unhandledRejection', e => log('unhandled: ' + (e?.stack || e)));
