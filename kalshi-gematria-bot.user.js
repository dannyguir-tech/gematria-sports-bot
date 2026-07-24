// ==UserScript==
// @name         Kalshi Gematria Bot
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Calculate English ordinal gematria for Kalshi sports markets
// @author       dannyguir-tech
// @match        https://kalshi.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // --- Gematria logic ---
  function ordinalValue(text) {
    if (!text) return 0;
    return text
      .toUpperCase()
      .split('')
      .filter((ch) => ch >= 'A' && ch <= 'Z')
      .reduce((sum, ch) => sum + (ch.charCodeAt(0) - 64), 0);
  }

  function reducedValue(text) {
    let n = ordinalValue(text);
    while (n > 9) {
      n = String(n).split('').reduce((sum, d) => sum + parseInt(d, 10), 0);
    }
    return n;
  }

  function makePick(home, away, dateText) {
    const homeOrd = ordinalValue(home);
    const awayOrd = ordinalValue(away);
    const homeRed = reducedValue(home);
    const awayRed = reducedValue(away);

    let reason = '';
    let pick = '';

    const dateRed = dateText ? reducedValue(dateText.replace(/-/g, '')) : null;

    if (dateRed !== null) {
      if (homeRed === dateRed && awayRed !== dateRed) {
        pick = home;
        reason = `Home reduced value (${homeRed}) matches the date reduced value (${dateRed}).`;
      } else if (awayRed === dateRed && homeRed !== dateRed) {
        pick = away;
        reason = `Away reduced value (${awayRed}) matches the date reduced value (${dateRed}).`;
      }
    }

    if (!pick) {
      if (homeOrd > awayOrd) {
        pick = home;
        reason = `Home team has the higher ordinal gematria value (${homeOrd} vs ${awayOrd}).`;
      } else if (awayOrd > homeOrd) {
        pick = away;
        reason = `Away team has the higher ordinal gematria value (${awayOrd} vs ${homeOrd}).`;
      } else {
        pick = 'Tie';
        reason = `Both teams have the same ordinal gematria value (${homeOrd}).`;
      }
    }

    return { homeOrd, awayOrd, homeRed, awayRed, dateRed, pick, reason };
  }

  // --- UI ---
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'gematria-bot-panel';
    panel.innerHTML = `
      <div class="kgb-header">
        <span>🔢 Gematria Bot</span>
        <button id="kgb-minimize">−</button>
      </div>
      <div class="kgb-body">
        <label>Side A <input id="kgb-home" type="text" placeholder="e.g. Lakers" /></label>
        <label>Side B <input id="kgb-away" type="text" placeholder="e.g. Celtics" /></label>
        <label>Date (optional) <input id="kgb-date" type="date" /></label>
        <button id="kgb-calc">Calculate</button>
        <div id="kgb-result" class="kgb-result"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const style = document.createElement('style');
    style.textContent = `
      #gematria-bot-panel {
        position: fixed;
        top: 80px;
        right: 20px;
        width: 280px;
        background: #0f172a;
        color: #e2e8f0;
        border: 1px solid #334155;
        border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        z-index: 999999;
      }
      #gematria-bot-panel.minimized .kgb-body { display: none; }
      .kgb-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 14px;
        background: #1e293b;
        border-radius: 12px 12px 0 0;
        font-weight: 700;
        cursor: move;
      }
      .kgb-header button {
        background: transparent;
        border: none;
        color: #e2e8f0;
        font-size: 18px;
        cursor: pointer;
      }
      .kgb-body {
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .kgb-body label {
        display: flex;
        flex-direction: column;
        font-size: 12px;
        color: #94a3b8;
        gap: 4px;
      }
      .kgb-body input {
        padding: 8px;
        border: 1px solid #334155;
        border-radius: 6px;
        background: #020617;
        color: #f8fafc;
        font-size: 13px;
      }
      .kgb-body button {
        padding: 10px;
        background: #38bdf8;
        border: none;
        border-radius: 6px;
        color: #0f172a;
        font-weight: 700;
        cursor: pointer;
      }
      .kgb-body button:hover { background: #0ea5e9; }
      .kgb-result {
        margin-top: 6px;
        padding: 10px;
        background: #064e3b;
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.4;
      }
      .kgb-result.no-pick { background: #451a03; }
      .kgb-values { color: #94a3b8; margin-bottom: 6px; }
      .kgb-pick { font-weight: 700; color: #d1fae5; }
    `;
    document.head.appendChild(style);

    // Minimize
    document.getElementById('kgb-minimize').addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('minimized');
    });

    // Calculate
    document.getElementById('kgb-calc').addEventListener('click', () => {
      const home = document.getElementById('kgb-home').value.trim();
      const away = document.getElementById('kgb-away').value.trim();
      const date = document.getElementById('kgb-date').value;
      const resultEl = document.getElementById('kgb-result');

      if (!home || !away) {
        resultEl.className = 'kgb-result no-pick';
        resultEl.innerHTML = 'Enter both sides.';
        return;
      }

      const r = makePick(home, away, date);
      resultEl.className = r.pick === 'Tie' ? 'kgb-result no-pick' : 'kgb-result';
      resultEl.innerHTML = `
        <div class="kgb-values">
          ${home}: ${r.homeOrd} / ${r.homeRed}<br>
          ${away}: ${r.awayOrd} / ${r.awayRed}<br>
          ${date ? `Date reduced: ${r.dateRed}<br>` : ''}
        </div>
        <div class="kgb-pick">
          Pick: ${r.pick}<br>
          <span style="font-weight:400;color:#a7f3d0">${r.reason}</span>
        </div>
      `;
    });

    // Dragging
    let dragging = false;
    let offsetX, offsetY;
    const header = panel.querySelector('.kgb-header');
    header.addEventListener('mousedown', (e) => {
      dragging = true;
      offsetX = e.clientX - panel.offsetLeft;
      offsetY = e.clientY - panel.offsetTop;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - offsetX}px`;
      panel.style.top = `${e.clientY - offsetY}px`;
      panel.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => (dragging = false));
  }

  // --- Auto-detect market titles (best-effort) ---
  function tryDetectMarketTitles() {
    // Kalshi market titles often live in h1/h2 elements or specific data-testids.
    // This is a generic fallback; update selectors if the site changes.
    const selectors = [
      'h1',
      'h2',
      '[data-testid="market-title"]',
      '[data-testid="event-title"]',
      '.market-title',
      '.event-title',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    return '';
  }

  function init() {
    createPanel();

    // Optional: pre-fill with detected title
    const detected = tryDetectMarketTitles();
    if (detected) {
      const parts = detected.split(/\s+(vs\.?|v\.?|at|@)\s+/i);
      if (parts.length >= 2) {
        const homeInput = document.getElementById('kgb-home');
        const awayInput = document.getElementById('kgb-away');
        if (homeInput && awayInput && !homeInput.value && !awayInput.value) {
          homeInput.value = parts[0].trim();
          awayInput.value = parts[2] ? parts[2].trim() : parts[1].trim();
        }
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
