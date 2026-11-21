// The paper bot: live Pumpfun launches → the engine's rules every 30 s → paper trades with the engine's exits.
// No wallet, no keys that can spend: it cannot trade real money.
import { makeFeed } from './feed.mjs';
import { makeBook } from './book.mjs';
import { makeDesk, dayOf } from './paper.mjs';
import { makeNotifier } from './notify.mjs';
import { decide } from '../../engine/src/rules.mjs';
import { makeRpc, fetchMintInfo } from '../../engine/src/backfill.mjs';

const MIN = 60_000;
const fmt = (x, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
const pct = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

export function createBot({ cfg, store, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, now = Date.now, log = () => {} }) {
  const rpc = cfg.rpcUrl ? makeRpc(cfg.rpcUrl, { rps: 5, fetchImpl }) : null;
  const tg = makeNotifier({ token: cfg.telegramToken, chat: cfg.telegramChat, fetchImpl, log, gapMs: cfg.telegramGapMs ?? 1100 });
  const alert = (text, kind = 'trades') => { if (cfg.alerts === 'off' || (cfg.alerts === 'daily' && kind === 'trades')) return; tg.send(text); };
  let degraded = true, downSince = now(), downAlerted = false, startedAt = now(), missAlerted = false;
  const counts = { launches: 0, trades: 0, signals: 0, blocked: {}, vetoed: 0, mintFetches: 0 };

  const desk = makeDesk({ paper: cfg.paper, policy: cfg.policy, costs: cfg.costs, tzOffsetMin: cfg.tzOffsetMin, onEvent: ev => {
    store.event(ev);
    if (ev.type === 'entry') alert(`🟢 PAPER BUY $${ev.symbol || '?'}\n${ev.size.toFixed(3)} SOL at MC ${ev.mcapSol.toFixed(1)} SOL\nhttps://gmgn.ai/sol/token/${ev.mint}`);
    if (ev.type === 'exit') alert(`${ev.pnl > 0 ? '✅' : '🔴'} PAPER SELL $${ev.symbol || '?'} (${ev.reason})\nP&L ${fmt(ev.pnl)} SOL (${pct(ev.ret)}) · held ${Math.round(ev.held)} min · peak ${pct(ev.peak - 1)}\nBankroll ${ev.bankroll.toFixed(3)} SOL`);
  } });

  const book = makeBook({ maxTracked: cfg.maxTracked, keepMin: cfg.params.maxAgeMin + cfg.policy.maxHoldMin, onRetire: (coin, why) => {
    if (cfg.collect === 'off' || (cfg.collect === 'active' && coin.trades.length < 10)) return;
    store.coin({ ...coin, retired: why });
  } });

  const feed = makeFeed({ url: cfg.wsUrl, mode: cfg.feedMode, WebSocketImpl, now, staleMs: cfg.staleMs, log,
    onStatus: st => {
      if (st.state === 'down' && !degraded) { degraded = true; downSince = now(); store.event({ type: 'health', t: now(), state: 'down', why: st.why }); }
      if (st.state === 'connected') store.event({ type: 'health', t: now(), state: 'connected' });
    },
    onEvent: (e, ctx) => {
      if (e.kind === 'create') { counts.launches++; book.addLaunch(e, ctx); return; }
      if (e.kind !== 'trade') return;
      counts.trades++;
      const rec = book.addTrade(e, ctx);
      if (rec) desk.onTrade(e.mint, rec.coin.trades[rec.coin.trades.length - 1]);
    } });

  // Healthy again after 60 s of steady messages. Down for 60 s+ → one alert, no new entries meanwhile.
  function health(t) {
    const live = feed.connected() && t - feed.lastMsg() < cfg.staleMs;
    if (degraded && live && t - downSince > 0 && feed.lastMsg() - Math.max(downSince, startedAt) > 60_000) {
      degraded = false; if (downAlerted) alert('✅ Feed back: entries resumed', 'health'); downAlerted = false;
    }
    if (!live && !degraded) { degraded = true; downSince = t; }
    if (degraded && !downAlerted && t - downSince > 60_000 && t - startedAt > 120_000) { downAlerted = true; alert('⚠️ Feed down for 60 s+: no new paper entries until it is back', 'health'); }
    // Messages but nothing decoded: the events are not in the logs on this setup.
    if (!missAlerted && t - startedAt > 5 * MIN && feed.stats.msgs > 500 && feed.stats.events === 0) {
      missAlerted = true; alert('⚠️ The feed receives Pumpfun transactions but decodes no events. Set FEED_MODE=transactions (see bot/DEPLOY.md).', 'health');
    }
  }

  function scan(t = now()) {
    health(t);
    const p = cfg.params;
    for (const rec of book.all()) {
      if (rec.entered || rec.vetoed) continue;
      const age = (t - rec.coin.createdAt) / MIN;
      if (age < p.minAgeMin || age > p.maxAgeMin) continue;
      const f = rec.tracker.featuresAt(t), d = decide(f, rec.coin, p);
      if (d.vetoes.length) { rec.vetoed = d.vetoes; counts.vetoed++; store.event({ type: 'veto', t, mint: rec.coin.mint, symbol: rec.coin.symbol, vetoes: d.vetoes }); continue; }
      if (!d.buy) continue;
      // Mint settings are checked once, only for coins that pass every filter (saves RPC calls).
      if (!rec.coin.mintInfo) {
        if (rpc && !rec.mintFetch) { counts.mintFetches++; rec.mintFetch = fetchMintInfo(rpc, rec.coin.mint).then(i => { rec.coin.mintInfo = i || { unknown: true }; }).catch(() => { rec.mintFetch = null; }); }
        if (rpc || cfg.requireMintCheck !== false) continue;
      }
      rec.entered = true; counts.signals++;
      const why = desk.blocked(t, degraded);
      store.event({ type: 'signal', t, mint: rec.coin.mint, symbol: rec.coin.symbol, blocked: why, features: f });
      if (why) { counts.blocked[why] = (counts.blocked[why] || 0) + 1; continue; }
      desk.enter(rec.coin, t);
    }
  }

  function clock(t = now()) {
    const rep = desk.onClock(t);
    if (rep) {
      store.daily(rep);
      const sm = desk.summary(), date = new Date(rep.day * 86_400_000).toISOString().slice(0, 10);
      alert(`📊 Day report ${date}: ${pct(rep.pct)} (${fmt(rep.pnl)} SOL)\n${rep.trades} trades, ${rep.wins} wins, ${rep.rugs} rugs · bankroll ${rep.bankroll.toFixed(3)} SOL\nGreen days ${Math.round((sm.greenDays || 0) * sm.days)}/${sm.days} · total ${pct(sm.totalPct)}`, 'daily');
    }
  }
  const cull = (t = now()) => book.cull(t, false, desk.isHeld);

  function saveState(t = now()) {
    const sm = desk.summary();
    store.saveState({ t, bankroll: desk.state.bankroll, start: desk.state.start, history: desk.state.history, day: desk.state.day, dayStart: desk.state.dayStart,
      dayPnl: desk.state.dayPnl, dayTrades: desk.state.dayTrades, dayWins: desk.state.dayWins, dayRugs: desk.state.dayRugs, openMarks: sm.open });
  }
  // After a crash: positions open at the last save are counted at their last saved value.
  function restore(t = now()) {
    const st = store.loadState(); if (!st) return null;
    Object.assign(desk.state, { bankroll: st.bankroll, start: st.start, history: st.history || [], day: st.day, dayStart: st.dayStart, dayPnl: st.dayPnl || 0, dayTrades: st.dayTrades || 0, dayWins: st.dayWins || 0, dayRugs: st.dayRugs || 0 });
    for (const o of st.openMarks || []) {
      const pnl = o.value - o.size; desk.state.bankroll += pnl; if (dayOf(t, cfg.tzOffsetMin) === st.day) desk.state.dayPnl += pnl;
      store.event({ type: 'exit', t, mint: o.mint, symbol: o.symbol, reason: 'restart', pnl, ret: pnl / o.size, bankroll: desk.state.bankroll });
    }
    return st;
  }

  const timers = [];
  return {
    start() {
      const st = restore();
      feed.start();
      timers.push(setInterval(() => scan(), cfg.scanMs), setInterval(() => clock(), 5000), setInterval(() => cull(), MIN), setInterval(() => saveState(), MIN));
      alert(`🤖 Paper bot started${st ? ' (restored)' : ''} · bankroll ${desk.state.bankroll.toFixed(3)} SOL · feed ${cfg.feedMode} · no real money`, 'health');
    },
    stop(reason = 'shutdown') { for (const x of timers) clearInterval(x); feed.stop(); const t = now(); desk.closeAll(t, reason); saveState(t); book.flush(reason); },
    scan, clock, cull, saveState, restore, feed, book, desk, tg,
    status(t = now()) {
      return { up: Math.round((t - startedAt) / 1000), degraded, feed: { connected: feed.connected(), lastMsgAgoS: feed.lastMsg() ? Math.round((t - feed.lastMsg()) / 1000) : null, ...feed.stats, gaps: feed.stats.gaps.length },
        tracked: book.size(), counts, paper: desk.summary() };
    },
  };
}
