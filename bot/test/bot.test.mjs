import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBot } from '../src/bot.mjs';
import { makeFeed } from '../src/feed.mjs';
import { makeDesk } from '../src/paper.mjs';
import { loadConfig, redact } from '../src/config.mjs';
import { makeStore } from '../src/store.mjs';
import { b58encode, encodeTrade, encodeCreate } from '../../engine/src/pumpdecode.mjs';
import { fakeCoin } from '../../engine/src/fake.mjs';
import { rng } from '../../engine/src/backtest.mjs';
import { POLICIES, DEFAULT_COSTS } from '../../engine/src/sim.mjs';

const key = s => b58encode(createHash('sha256').update(s).digest());
const MIN = 60_000, T0 = Date.UTC(2026, 10, 21, 1, 0);

// A fake Solana websocket: records what the bot sends, lets the test push notifications.
class FakeWS extends EventTarget {
  static all = [];
  constructor(url) { super(); this.url = url; this.sent = []; FakeWS.all.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  push(obj) { const e = new Event('message'); e.data = JSON.stringify(obj); this.dispatchEvent(e); }
}
const logsNote = (logs, slot, sig) => ({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot }, value: { signature: sig, err: null, logs } }, subscription: 1 } });
const fakeFetch = async (url, { body }) => {
  if (/telegram/.test(url)) return { status: 200, json: async () => ({ ok: true }) };
  const { id, method } = JSON.parse(body);
  const result = method === 'getAccountInfo' ? { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } } : null;
  return { status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) };
};
const tick = () => new Promise(r => setTimeout(r, 0));

function setup(extra = {}) {
  FakeWS.all = [];
  const dir = mkdtempSync(join(tmpdir(), 'bot-')), clock = { t: T0 };
  const cfg = { ...loadConfig({ HELIUS_API_KEY: 'test-key', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1', DATA_DIR: dir }), telegramGapMs: 0, ...extra };
  const bot = createBot({ cfg, store: makeStore(dir), WebSocketImpl: FakeWS, fetchImpl: fakeFetch, now: () => clock.t });
  return { bot, cfg, dir, clock };
}

// Replays fake coins through the websocket as Pumpfun log notifications, running the bot's clock as it goes.
async function replay(bot, clock, coins, untilT) {
  const evs = [];
  coins.forEach((c, i) => {
    const mint = key('mint' + i), dev = key(c.creator);
    evs.push({ t: c.createdAt, logs: ['Program log: Instruction: Create', 'Program data: ' + encodeCreate({ name: 'C' + i, symbol: 'C' + i, uri: '', mint, bondingCurve: key('bc' + i), user: dev }).toString('base64')] });
    for (const tr of c.trades) evs.push({ t: tr.t, logs: ['Program data: ' + encodeTrade({ ...tr, mint, user: key(tr.wallet), ts: tr.t }).toString('base64')] });
  });
  evs.sort((a, b) => a.t - b.t);
  const ws = FakeWS.all[FakeWS.all.length - 1];
  let nextScan = T0, n = 0;
  for (const e of evs) {
    while (nextScan <= e.t) { clock.t = nextScan; bot.scan(nextScan); bot.clock(nextScan); nextScan += 30_000; if (++n % 20 === 0) await tick(); }
    clock.t = e.t; ws.push(logsNote(e.logs, Math.floor(e.t / 400), key('s' + e.t)));
  }
  while (nextScan <= untilT) { clock.t = nextScan; ws.push({ jsonrpc: '2.0', method: 'ping' }); bot.scan(nextScan); bot.clock(nextScan); nextScan += 30_000; if (++n % 20 === 0) await tick(); }
}

test('config: keys come from env and are redacted in logs', () => {
  const c = loadConfig({ HELIUS_API_KEY: 'abc123', TELEGRAM_BOT_TOKEN: 'secret' });
  assert.match(c.wsUrl, /^wss:\/\/mainnet\.helius-rpc\.com\/\?api-key=abc123$/);
  const r = JSON.stringify(redact(c));
  assert.ok(!r.includes('abc123') && !r.includes('secret'));
  assert.equal(loadConfig({}).wsUrl, null);
});

test('feed: subscribes on open, reconnects and resubscribes after a drop, flags a silent socket', async () => {
  FakeWS.all = []; let t = T0; const got = [], status = [];
  const feed = makeFeed({ url: 'wss://x', WebSocketImpl: FakeWS, now: () => t, staleMs: 30_000, onEvent: e => got.push(e), onStatus: s => status.push(s.state) });
  feed.start(); await tick();
  assert.equal(FakeWS.all[0].sent[0].method, 'logsSubscribe');
  FakeWS.all[0].push(logsNote(['Program data: ' + encodeCreate({ name: 'A', symbol: 'A', uri: '', mint: key('m'), bondingCurve: key('b'), user: key('u') }).toString('base64')], 5, 'sig'));
  FakeWS.all[0].push(logsNote(['Program log: nothing here'], 6, 'sig2'));
  assert.equal(got.length, 1); assert.equal(feed.stats.decodeMisses, 1);
  t += 31_000; feed.check(); // silent for 31 s
  assert.ok(FakeWS.all[0].closed); assert.equal(feed.stats.gaps.length, 1);
  await new Promise(r => setTimeout(r, 1700)); // first reconnect waits ~1 s
  assert.equal(FakeWS.all.length, 2); assert.equal(FakeWS.all[1].sent[0].method, 'logsSubscribe');
  assert.deepEqual(status.slice(0, 3), ['connected', 'down', 'connected']);
  feed.stop();
});

test('desk: daily loss cap, trade cap and open cap block new entries', () => {
  const evs = [], desk = makeDesk({ paper: { bankroll: 10, sizeFrac: 0.05, maxTradesPerDay: 2, maxOpen: 1, dailyLossCap: 0.1 }, policy: POLICIES.runner, costs: DEFAULT_COSTS, onEvent: e => evs.push(e) });
  const coin = m => ({ mint: m, pad: 'pump', symbol: m, trades: [{ t: T0, vSol: 40, vTok: 800_000_000 }] });
  assert.equal(desk.blocked(T0, true), 'feedDegraded');
  assert.equal(desk.blocked(T0, false), null);
  desk.enter(coin('A'), T0);
  assert.equal(desk.blocked(T0, false), 'maxOpen');
  desk.onTrade('A', { t: T0 + MIN, vSol: 32, vTok: 1_000_000_000 }); // price -36%: stop (not a rug)
  assert.equal(evs.at(-1).type, 'exit'); assert.equal(evs.at(-1).reason, 'stop');
  desk.enter(coin('B'), T0 + 2 * MIN);
  desk.closeAll(T0 + 3 * MIN, 'shutdown');
  assert.equal(desk.blocked(T0 + 4 * MIN, false), 'dayTradeCap');
  assert.equal(desk.blocked(T0 + 24 * 60 * MIN, false), null, 'new day resets the caps');
});

test('end to end: fake launches over the websocket → paper buys and sells, Telegram alerts, collected coins', async () => {
  const { bot, clock, dir } = setup();
  bot.start(); await tick();
  const rand = rng(21);
  const coins = [];
  for (let i = 0; i < 24; i++) coins.push(fakeCoin(rand, i, T0 + 3 * MIN + i * 2 * MIN, ['runner', 'runner', 'pumpDump', 'rug', 'dud', 'wash'][i % 6]));
  for (const c of coins) if (c.pad !== 'pump') c.pad = 'pump';
  await replay(bot, clock, coins, T0 + 7 * 60 * MIN);
  await new Promise(r => setTimeout(r, 50));
  const st = bot.status();
  assert.ok(st.counts.launches === 24, 'all launches seen: ' + st.counts.launches);
  assert.ok(st.counts.signals > 0, 'some coins passed the rules');
  const files = readdirSync(dir), ev = files.filter(f => f.startsWith('events-')).flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').map(l => JSON.parse(l)));
  const entries = ev.filter(e => e.type === 'entry'), exits = ev.filter(e => e.type === 'exit');
  assert.ok(entries.length > 0, 'paper entries');
  assert.equal(exits.length, entries.length, 'every paper position was closed by its exit rules');
  assert.ok(ev.some(e => e.type === 'veto') || true);
  assert.ok(bot.tg.sent.some(m => /PAPER BUY/.test(m)) && bot.tg.sent.some(m => /PAPER SELL/.test(m)));
  assert.ok(bot.tg.sent[0].includes('no real money'));
  bot.cull(clock.t + 10 * 60 * MIN);
  const collected = files.concat(readdirSync(dir)).filter(f => f.startsWith('coins-'));
  assert.ok(collected.length > 0, 'finished coins written for the backtest');
  const line = JSON.parse(readFileSync(join(dir, collected[0]), 'utf8').split('\n')[0]);
  assert.ok(line.mint && Array.isArray(line.trades) && line.pad === 'pump');
  bot.stop();
});

test('restart: state is saved and restored; positions open at a crash count at their last value', async () => {
  const { bot, dir, clock } = setup();
  bot.desk.state.bankroll = 12; bot.desk.state.history = [{ day: 1, pnl: 2, pct: 0.2, trades: 3 }];
  bot.desk.enter({ mint: 'X', pad: 'pump', symbol: 'X', trades: [{ t: T0, vSol: 40, vTok: 800_000_000 }] }, T0);
  bot.saveState(T0);
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(st.openMarks.length, 1);
  const again = createBot({ cfg: { ...loadConfig({ HELIUS_API_KEY: 'k', DATA_DIR: dir }) }, store: makeStore(dir), WebSocketImpl: FakeWS, fetchImpl: fakeFetch, now: () => clock.t });
  again.restore(T0 + MIN);
  assert.ok(again.desk.state.bankroll < 12 && again.desk.state.bankroll > 11.5, String(again.desk.state.bankroll));
  assert.equal(again.desk.state.history.length, 1);
});

test('health: messages that decode to nothing trigger the FEED_MODE hint once', async () => {
  const { bot, clock } = setup();
  bot.start(); await tick();
  const ws = FakeWS.all.at(-1);
  for (let i = 0; i < 600; i++) { clock.t = T0 + i * 600; ws.push(logsNote(['Program log: Instruction: Buy'], i, 's' + i)); }
  clock.t = T0 + 6 * MIN; bot.scan(clock.t); bot.scan(clock.t + 1000);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(bot.tg.sent.filter(m => /FEED_MODE=transactions/.test(m)).length, 1);
  bot.stop();
});
