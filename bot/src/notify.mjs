// Telegram messages, one at a time, never blocking or crashing the bot.
export function makeNotifier({ token, chat, fetchImpl = globalThis.fetch, log = () => {}, gapMs = 1100 }) {
  const q = []; let busy = false; const sent = [];
  async function pump() {
    if (busy) return; busy = true;
    while (q.length) {
      const text = q.shift(); sent.push(text); if (sent.length > 50) sent.shift();
      if (!token || !chat) continue;
      try {
        const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
        if (r.status === 429) { q.unshift(text); await new Promise(res => setTimeout(res, 3000)); }
      } catch (e) { log('telegram failed: ' + e.message); }
      if (gapMs) await new Promise(res => setTimeout(res, gapMs));
    }
    busy = false;
  }
  return { send(text) { q.push(String(text).slice(0, 3900)); pump(); }, sent };
}
