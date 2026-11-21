// Live Pumpfun feed over a Solana websocket, with reconnects, a stale-feed watchdog and resubscribe.
// Modes: "logs" (logsSubscribe; standard websocket on any plan) or "transactions" (Helius transactionSubscribe;
// includes inner instructions, needed if Pumpfun's events only appear as self-CPI instructions).
import { PUMP_PROGRAM, eventsFromTx } from '../../engine/src/pumpdecode.mjs';

export function makeFeed({ url, mode = 'logs', WebSocketImpl = globalThis.WebSocket, now = Date.now, staleMs = 30_000, onEvent, onStatus = () => {}, log = () => {} }) {
  let ws = null, stopped = false, attempt = 0, lastMsg = 0, connectedAt = 0, timer = null, reconnectTimer = null, id = 0;
  const stats = { msgs: 0, events: 0, reconnects: 0, decodeMisses: 0, gaps: [] };
  const subscribeMsg = () => mode === 'transactions'
    ? { jsonrpc: '2.0', id: ++id, method: 'transactionSubscribe', params: [{ accountInclude: [PUMP_PROGRAM], failed: false }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 0 }] }
    : { jsonrpc: '2.0', id: ++id, method: 'logsSubscribe', params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }] };

  function handle(raw) {
    lastMsg = now(); stats.msgs++;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.method === 'logsNotification') {
      const v = m.params?.result?.value, slot = m.params?.result?.context?.slot;
      if (!v || v.err) return;
      const evs = eventsFromTx({ meta: { logMessages: v.logs } });
      if (!evs.length) { stats.decodeMisses++; return; }
      for (const e of evs) { stats.events++; onEvent(e, { slot, signature: v.signature, t: lastMsg }); }
    } else if (m.method === 'transactionNotification') {
      const r = m.params?.result, tx = r?.transaction;
      if (!tx || tx.meta?.err) return;
      const evs = eventsFromTx(tx);
      if (!evs.length) { stats.decodeMisses++; return; }
      for (const e of evs) { stats.events++; onEvent(e, { slot: r.slot, signature: r.signature, t: lastMsg }); }
    } else if (m.id && m.error) log(`subscribe error: ${m.error.message || JSON.stringify(m.error)}`);
  }

  function connect() {
    if (stopped) return;
    try { ws = new WebSocketImpl(url); } catch (e) { log('websocket create failed: ' + e.message); return schedule(); }
    const sock = ws;
    sock.addEventListener('open', () => {
      if (sock !== ws) return;
      attempt = 0; connectedAt = lastMsg = now();
      sock.send(JSON.stringify(subscribeMsg()));
      onStatus({ state: 'connected' });
    });
    sock.addEventListener('message', e => { if (sock === ws) handle(typeof e.data === 'string' ? e.data : String(e.data)); });
    const down = why => { if (sock !== ws) return; ws = null; onStatus({ state: 'down', why }); schedule(); };
    sock.addEventListener('close', () => down('closed'));
    sock.addEventListener('error', () => { try { sock.close(); } catch {} down('error'); });
  }
  function schedule() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.75 + Math.random() * 0.5);
    stats.reconnects++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }
  // Watchdog: a silent socket is treated as dead (Pumpfun never goes quiet for 30 s).
  function check() {
    if (!ws || !connectedAt) return;
    const quiet = now() - lastMsg;
    if (quiet > staleMs) {
      stats.gaps.push({ at: lastMsg, ms: quiet }); if (stats.gaps.length > 100) stats.gaps.shift();
      log(`feed silent ${Math.round(quiet / 1000)} s: reconnecting`);
      const old = ws; ws = null; try { old.close(); } catch {}
      onStatus({ state: 'down', why: 'stale' }); schedule();
    }
  }
  return {
    start() { stopped = false; connect(); timer = setInterval(check, 5000); },
    stop() { stopped = true; clearInterval(timer); clearTimeout(reconnectTimer); reconnectTimer = null; const s = ws; ws = null; try { s && s.close(); } catch {} },
    check, handle, stats, lastMsg: () => lastMsg, connected: () => !!ws && connectedAt > 0,
  };
}
