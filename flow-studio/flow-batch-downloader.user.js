// ==UserScript==
// @name         Flow Batch Video Downloaderuse
// @namespace    flow.batch.downloader
// @version      3.7.0
// @description  Flow Studio: Scene queue, conservative result matching, named batch downloads and original-only files.
// @author       Daniel
// @match        https://flow.google.com/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_download
// @connect      self
// @connect      flow-content.google
// @connect      googleusercontent.com
// @connect      googlevideo.com
// ==/UserScript==

/* Flow Studio 3.7.0
 * Update the existing script; do not run two copies.
 * No external libraries, telemetry, uploads or automatic downloads.
 * Observes Flow’s existing media responses; never sends private RPC requests.
 * Named downloads save the same original video file Flow lists for each clip,
 * using your folder and name pattern. Clips without a captured original link
 * fall back to Flow’s own Download menu (Flow names those files).
 * Library retries only fetch existing original videos. They never generate/upscale.
 * Create runs ONLY after an explicit Start queue click. No automatic generation retry.
 * Submitted/uncertain jobs are never silently resubmitted, even after a reload.
 * Menu downloads are reported as REQUESTED, not falsely reported as completed.
 * Full prompt text is available only when Flow exposes it. Importing a script alone
 * cannot reliably map every old, generically titled video to a script number.
 * Alt+D: open/minimize to a bottom pill. Minimized state is remembered.
 * Pick on grid: show selection tools. Shift-click: range selection. Row pills: select a visual row.
 */

(function () {
  'use strict';

  // PURE_CORE_START — also exercised by the accompanying development tests.
  function projectIdentity(path) {
    const m = String(path).match(/\/(?:project|projects)\/([^/]+)/);
    return m ? m[1] : null;
  }
  function isProjectGridRoute(path) {
    return /\/(?:project|projects)\/[^/]+\/?$/.test(String(path));
  }
  function assetToken(url) {
    try {
      const safe = trustedMediaURL(url); if (!safe) return '';
      const p = new URL(safe).pathname;
      const uuid = p.match(/\/(?:image|video)\/([a-f\d-]{36})(?:\/|$)/i);
      if (uuid) return uuid[1].toLowerCase();
      const asb = p.match(/\/asb\/([^/]+)/);
      return asb ? 'asb:' + asb[1].replace(/=(?:s\d+|w\d+|mm,).*$/, '') : '';
    } catch (_) { return ''; }
  }
  function scriptId(text) {
    const s = String(text || '');
    const m = s.match(/\b(?:EB[-_ ](?:CLIP[-_ ]?|C)|CLIP\s+)(\d{1,3})([AB]?)\b/i);
    if (m) return 'EB-C' + m[1].padStart(2, '0') + m[2].toUpperCase();
    // Any pack-style ID such as JAY-03, ELI-12B or DEAN-SC-04, kept as written.
    // Uppercase-only so ordinary prompt words are never mistaken for an ID.
    const g = s.slice(0, 240).match(/(?:^|[^A-Za-z0-9_-])([A-Z][A-Z0-9]{1,11}(?:-[A-Z][A-Z0-9]{0,11})?[-_]\d{1,3}[A-Z]?)(?![A-Za-z0-9])/);
    return g ? g[1] : '';
  }
  // Download naming. Pure helpers: no DOM, no storage.
  const NAME_PRESETS = { order_id: '{n}_{id}', id: '{id}', order_id_title: '{n}_{id}_{title}', order_title: '{n}_{title}' };
  function safeSegment(s, max = 80) {
    let out = String(s || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, '')
      .replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').replace(/-{2,}/g, '-')
      .replace(/^[-_.\s]+|[-_.\s]+$/g, '').slice(0, max).replace(/[-_.\s]+$/g, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = '_' + out;
    return out;
  }
  function shortWords(text, words = 5) {
    return safeSegment(text, 200).split('-').filter(Boolean).slice(0, words).join('-').toLowerCase().slice(0, 48).replace(/[-_.]+$/, '');
  }
  function dateStamp(ms = Date.now()) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fillPattern(pattern, values) {
    return String(pattern || '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
  }
  function downloadFolder(pattern, values) {
    return fillPattern(pattern, values).split(/[\\/]+/).map(part => safeSegment(part, 60))
      .filter(part => part && part !== '.' && part !== '..').slice(0, 6).join('/');
  }
  function buildFileName(o) {
    const values = { n: String(o.order || 0).padStart(o.digits || 2, '0'), id: safeSegment(o.id, 60),
      title: shortWords(o.title), date: o.date || dateStamp() };
    if (!values.id) values.id = values.title || 'clip';
    let base = o.outputName ? safeSegment(String(o.outputName).replace(/\.(mp4|mov|webm|m4v)$/i, ''), 120) : '';
    if (!base) {
      base = fillPattern(o.pattern || NAME_PRESETS.order_id, values).replace(/[\\/]+/g, '_');
      base = safeSegment(base, 120).replace(/[_-]{2,}/g, m => m[0]).replace(/^[_-]+|[_-]+$/g, '');
    }
    const prefix = safeSegment(o.prefix, 40);
    if (prefix) base = prefix + '_' + base;
    if (o.take > 1) base += '_take' + o.take;
    base = base || 'clip';
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = '_' + base;
    const folder = downloadFolder(o.folder, values);
    return (folder ? folder + '/' : '') + base + '.mp4';
  }
  function hashText(text) {
    let n = 2166136261;
    for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
    return (n >>> 0).toString(16);
  }
  function normalizeText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function readEditorText(input) {
    // Flow stores each pasted paragraph in its own <p>. textContent joins those
    // paragraphs without spaces; innerText retains the visible word boundaries.
    return input ? (typeof input.innerText === 'string' ? input.innerText : input.textContent || '') : '';
  }
  function editorMatchesPrompt(input, prompt) {
    return normalizeText(readEditorText(input)) === normalizeText(prompt);
  }
  function boundedDockPosition(x, y, width, height, viewportWidth, viewportHeight) {
    return { x: Math.max(8, Math.min(viewportWidth - width - 8, x)),
      y: Math.max(8, Math.min(viewportHeight - height - 8, y)) };
  }
  function parseMotionPack(s) {
    const starts = [...s.matchAll(/^[ \t]*EDIT POSITION\b[^\n]*$/gmi)];
    if (!starts.length) return [];
    const positions = new Set();
    const jobs = starts.map((start, index) => {
      const header = start[0].trim().match(/^EDIT POSITION\s+(\d+)(?:\s*\|\s*([^\n]+))?\s*$/i);
      if (!header) throw new Error('Check this clip heading: ' + start[0].trim());
      const position = +header[1], label = (header[2] || '').split('|')[0].trim();
      const id = label && !/^SOURCE\b/i.test(label) ? label : 'Clip ' + String(position).padStart(2, '0');
      if (!position || positions.has(position)) throw new Error('Repeated or invalid edit position: ' + header[1]);
      positions.add(position);
      const block = s.slice(start.index + start[0].length, starts[index + 1]?.index ?? s.length);
      const open = [...block.matchAll(/^[ \t]*MOTION PROMPT START[ \t]*$/gm)];
      const close = [...block.matchAll(/^[ \t]*MOTION PROMPT END[ \t]*$/gm)];
      if (open.length !== 1 || close.length !== 1 || close[0].index <= open[0].index)
        throw new Error(id + ': needs one complete MOTION PROMPT START / END block.');
      const metadata = block.slice(0, open[0].index);
      const image = [...metadata.matchAll(/^[ \t]*STARTING IMAGE:[ \t]*([^\n]+)$/gmi)];
      const target = [...metadata.matchAll(/^[ \t]*PLANNING TARGET:[ \t]*(\d+(?:\.\d+)?)\s*(?:s|seconds?)\b[^\n]*$/gmi)];
      if (image.length !== 1) throw new Error(id + ': needs one STARTING IMAGE filename.');
      if (target.length !== 1) throw new Error(id + ': needs one PLANNING TARGET in seconds.');
      const planningSeconds = +target[0][1];
      const seconds = [4, 6, 8, 10].find(slot => slot >= planningSeconds);
      if (!(planningSeconds > 0) || !seconds) throw new Error(id + ': planning target must be greater than 0 and at most 10 seconds. Split longer clips first.');
      const sourceFrame = image[0][1].trim();
      const frame = sourceFrame.split(/[\\/]/).pop();
      const output = metadata.match(/^[ \t]*SAVE RENDER AS:[ \t]*([^\n]+)$/mi);
      return { id, frame, sourceFrame, position, planningSeconds, seconds, durationSuggested: true,
        outputName: output ? output[1].trim() : '', format: 'motion',
        prompt: block.slice(open[0].index + open[0][0].length, close[0].index).trim() };
    });
    return jobs.sort((a, b) => a.position - b.position);
  }
  function parseFramePack(s) {
    const lines = s.split('\n'), starts = [];
    let inPrompt = false;
    const promptStart = /^[ \t]*(?:(?:MOTION|OMNI|VIDEO)\s+)?PROMPT START[ \t]*$/i;
    const promptEnd = /^[ \t]*(?:(?:MOTION|OMNI|VIDEO)\s+)?PROMPT END[ \t]*$/i;
    for (let line = 0; line < lines.length; line++) {
      if (promptStart.test(lines[line])) { inPrompt = true; continue; }
      if (promptEnd.test(lines[line])) { inPrompt = false; continue; }
      if (inPrompt) continue;
      const field = lines[line].match(/^[ \t]*(?:BASE FRAME|STARTING IMAGE|START FRAME|FRAME|IMAGE|ATTACH)[ \t]*[:=][ \t]*(.+?)[ \t]*$/i);
      const bare = lines[line].match(/^[ \t]*([^<>|:\n]+\.(?:png|jpe?g|webp))[ \t]*$/i);
      if (field || bare) {
        const sourceFrame = (field || bare)[1].trim().replace(/^(["'`])([\s\S]*)\1$/, '$2');
        starts.push({ line, sourceFrame, frame: sourceFrame.split(/[\\/]/).pop() });
      }
    }
    return starts.map((start, index) => {
      const preceding = lines.slice(0, start.line).reverse().find(line => line.trim());
      const clipHeader = /^[A-Z][A-Z0-9_-]*-\d+[A-Za-z]?$/.test(preceding?.trim() || '') ? preceding.trim() : '';
      const id = clipHeader || 'Clip ' + String(index + 1).padStart(2, '0');
      let stop = starts[index + 1]?.line ?? lines.length;
      if (index + 1 < starts.length) {
        let last = stop - 1; while (last > start.line && !lines[last].trim()) last--;
        if (/^[A-Z][A-Z0-9_-]*-\d+[A-Za-z]?$/.test(lines[last]?.trim() || '')) stop = last;
      }
      const body = lines.slice(start.line + 1, stop);
      const opens = body.map((line, i) => promptStart.test(line) ? i : -1).filter(i => i >= 0);
      const ends = body.map((line, i) => promptEnd.test(line) ? i : -1).filter(i => i >= 0);
      let metadata, prompt;
      if (opens.length || ends.length) {
        if (opens.length !== 1 || ends.length !== 1 || ends[0] <= opens[0]) throw new Error(id + ': incomplete or ambiguous prompt block.');
        metadata = body.slice(0, opens[0]); prompt = body.slice(opens[0] + 1, ends[0]).join('\n').trim();
      } else {
        const labelled = body.findIndex(line => /^[ \t]*(?:(?:MOTION|OMNI|VIDEO)\s+)?PROMPT[ \t]*:/i.test(line));
        if (labelled >= 0) {
          metadata = body.slice(0, labelled);
          prompt = [body[labelled].replace(/^[ \t]*(?:(?:MOTION|OMNI|VIDEO)\s+)?PROMPT[ \t]*:[ \t]*/i, ''), ...body.slice(labelled + 1)].join('\n').trim();
        } else {
          let first = 0;
          while (first < body.length && (!body[first].trim() || /^[ \t]*(?:DURATION|LENGTH|CLIP LENGTH|PLANNING TARGET|SET (?:OMNI )?DURATION)[ \t]*:/i.test(body[first]))) first++;
          metadata = body.slice(0, first); prompt = body.slice(first).join('\n').trim();
        }
        // Optional separators are outside the prompt. Blank lines inside it stay intact.
        prompt = prompt.replace(/(?:\n[ \t]*[-=]{3,}[ \t]*)+\s*$/, '').trim();
      }
      const durations = metadata.join('\n').match(/^[ \t]*(?:DURATION|LENGTH|CLIP LENGTH|PLANNING TARGET|SET (?:OMNI )?DURATION)[ \t]*:[ \t]*(\d+(?:\.\d+)?)\s*(?:s|sec(?:onds?)?)?\b[^\n]*$/mi);
      const planningSeconds = durations ? +durations[1] : null;
      const seconds = planningSeconds == null ? 0 : [4, 6, 8, 10].find(n => n >= planningSeconds);
      if (planningSeconds != null && (!(planningSeconds > 0) || !seconds)) throw new Error(id + ': duration must be greater than 0 and at most 10 seconds.');
      return { id, frame: start.frame, sourceFrame: start.sourceFrame, prompt, seconds, planningSeconds,
        needsDuration: planningSeconds == null, durationSuggested: seconds !== planningSeconds, format: 'frames' };
    });
  }
  function parsePrompts(text) {
    const s = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (/^PK\x03\x04/.test(s)) throw new Error('Unzip the pack first, then choose the prompts .txt file inside it.');
    if (s.length > 2000000) throw new Error('Prompt text exceeds 2 MB. Split the pack.');
    const jobs = parseMotionPack(s);
    if (!jobs.length) jobs.push(...parseSourcePack(s));
    const v7 = /^([\w][\w.-]*)[ \t]*\|[ \t]*ATTACH[ \t]+([^\n|]+?)[ \t]*\|[ \t]*SELECT[ \t]+(\d+)[ \t]+SECONDS[ \t]*\n+([\s\S]*?)(?=\n={8,}[ \t]*\n|\n[\w][\w.-]*[ \t]*\|[ \t]*ATTACH\b|(?![\s\S]))/gmi;
    const v6 = /^CLIP\s+(\d+[AB]?)\s+—\s+ATTACH:\s*([^\n]+)\nSET OMNI DURATION:\s*(\d+) SECONDS[\s\S]*?OMNI PROMPT START\s*\n([\s\S]*?)\n\s*OMNI PROMPT END/gm;
    let m;
    if (!jobs.length) while ((m = v7.exec(s))) jobs.push({ id: m[1], frame: m[2].trim(), seconds: +m[3], prompt: m[4].trim() });
    if (!jobs.length) while ((m = v6.exec(s))) jobs.push({ id: 'EB-C' + m[1], frame: m[2].trim(), seconds: +m[3], prompt: m[4].trim() });
    if (!jobs.length) jobs.push(...parseFramePack(s));
    if (!jobs.length) throw new Error('Could not find frame-to-prompt pairs. Put the image filename above each prompt, for example Frame: Alex-front.png, then Prompt: your text. Character codes are optional. Import the prompts .txt, not the ZIP.');
    if (jobs.length > 500) throw new Error('A pack can contain at most 500 prompts.');
    const seen = new Set();
    for (const j of jobs) {
      if (seen.has(j.id)) throw new Error('Duplicate clip ID: ' + j.id);
      if (!(j.needsDuration && j.seconds === 0) && ![4, 6, 8, 10].includes(j.seconds)) throw new Error(j.id + ': duration must be 4, 6, 8 or 10 seconds.');
      if (!/^[^/\\]+\.(png|jpe?g|webp)$/i.test(j.frame)) throw new Error(j.id + ': expected a frame filename.');
      if (!j.prompt) throw new Error(j.id + ': missing prompt.');
      seen.add(j.id);
      j.fingerprint = hashText((j.format === 'frames' ? '' : j.id + '\n') + j.frame + '\n' + j.seconds + '\n' + j.prompt);
    }
    return jobs;
  }
  function groupVisualRows(items, tolerance = 10) {
    const result = [];
    for (const item of [...items].sort((a, b) => a.top - b.top || a.left - b.left)) {
      let row = result.find(r => Math.abs(r.top - item.top) <= tolerance);
      if (!row) { row = { top: item.top, items: [] }; result.push(row); }
      row.items.push(item);
    }
    result.forEach(r => r.items.sort((a, b) => a.left - b.left));
    return result;
  }
  function rangeKeys(list, anchor, target) {
    const a = list.indexOf(anchor), b = list.indexOf(target);
    return a < 0 || b < 0 ? [target] : list.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  function retryDownloads(records) { return records.filter(r => r.kind !== 'image' && !r.legacy && r.downloadState === 'failed'); }
  function newDownloadCandidates(records) {
    return records.filter(r => r.kind !== 'image' && !r.legacy && r.selected && !/^(downloaded|requested|uncertain|failed|issuing|downloading)$/.test(r.downloadState || ''));
  }
  function recoverDownloadBatch(batch) {
    if (!Array.isArray(batch?.items)) return null;
    const items = batch.items.filter(item => item && typeof item === 'object').map(item => ({ ...item,
      state: item.state === 'locating' ? 'pending' : /^(issuing|downloading)$/.test(item.state) ? 'uncertain' : item.state,
      note: /^(issuing|downloading)$/.test(item.state) ? 'Interrupted after requesting a file. Check Chrome Downloads before retrying.' : item.note
    }));
    return { ...batch, items, phase: batch.phase === 'running' ? 'paused' : batch.phase };
  }
  function batchCounts(batch) {
    const counts = { pending: 0, downloaded: 0, requested: 0, failed: 0, uncertain: 0, skipped: 0, relink: 0, active: 0, total: 0 };
    for (const item of batch?.items || []) { counts.total++; counts[/^(locating|issuing|downloading)$/.test(item.state) ? 'active' : item.state]++; }
    return counts;
  }
  function queueable(job, history = {}) {
    return /^(ready|blocked)$/.test(job.state) && !history[job.fingerprint];
  }
  function eligibleJobs(jobs, history = {}) { return jobs.filter(j => j.selected && queueable(j, history)); }
  function restoredSubmission(saved) {
    return /^(submitted|completed)$/.test(saved?.state) ? saved.state : 'uncertain';
  }
  function sceneLabel(job, index = 0) {
    return String(job.position || index + 1).padStart(2, '0') + ' · ' + job.id;
  }
  function sceneStatus(job, history = {}) {
    if (job.state === 'blocked' && history[job.fingerprint]) return 'Check submission';
    return { ready: 'Ready', blocked: 'Not sent · retry available', preparing: 'Preparing',
      submitting: 'Sending', submitted: 'Sent · awaiting result', uncertain: 'Check submission',
      completed: 'Result found', 'needs-duration': 'Choose duration' }[job.state] || job.state;
  }
  function sceneCandidates(job, jobs, records, since = 0) {
    const prompt = normalizeText(job.prompt);
    if (!prompt) return [];
    // Never guess from a generic title, row position, or a short prompt excerpt.
    // Two scenes sharing a prompt cannot be distinguished without frame metadata.
    if (jobs.filter(j => normalizeText(j.prompt) === prompt).length !== 1) return [];
    return records.filter(r => r.kind !== 'image' && !r.legacy && r.resultReady &&
      ![r.key, ...(r.mediaTokens || [])].some(key => (job.attemptBaseline || []).includes(key)) &&
      normalizeText(r.prompt) === prompt && Number(r.duration) > 0 &&
      Math.abs(Number(r.duration) - job.seconds) < 0.75 &&
      (!since || (r.createdAt && r.createdAt >= since - 2000)));
  }

  function sceneFramePoster(job, records) {
    // Reference pictures must come from the starting image, never a video result.
    const frames = records.filter(r => r.kind === 'image' && r.title === job.frame);
    if (!frames.length) return '';
    const posters = frames.map(r => trustedMediaURL(r.poster));
    // Duplicate catalog entries are safe only when all resolve to the same picture.
    return posters.every(url => url && url === posters[0]) ? posters[0] : '';
  }
  function recoverJobs(jobs) {
    return jobs.map(j => ({ ...j,
      state: j.state === 'submitting' ? 'uncertain' : j.state === 'preparing' ? 'blocked' : j.state,
      note: j.state === 'submitting' ? 'Interrupted after the submission boundary. Check Flow before retrying.' : j.state === 'preparing' ? 'Preparation interrupted. This scene was not sent. Select it and start again after checking the draft.' : j.note
    }));
  }
  function safeOriginalOption(text) {
    const s = normalizeText(text);
    return !/upscal|enhanc|generat|1080|4k|credit|purchase|buy/i.test(s) && /\boriginal\b|\bsource\b|\b720p\b|\bdownload\b/i.test(s);
  }

  function trustedMediaURL(raw) {
    try {
      const u = new URL(String(raw));
      const hosts = ['flow.google.com', 'flow-content.google', 'googleusercontent.com', 'googlevideo.com'];
      if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
      if (!hosts.some(h => u.hostname === h || (['googleusercontent.com', 'googlevideo.com'].includes(h) && u.hostname.endsWith('.' + h)))) return '';
      return u.href;
    } catch (_) { return ''; }
  }
  function addAlias(map, token, key) {
    if (!token) return;
    if (!map.has(token)) map.set(token, key);
    else if (map.get(token) !== key) map.set(token, null);
  }
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s\u0000-\u001f]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function videoIdentityFromURL(raw) {
    const safe = trustedMediaURL(raw); if (!safe) return '';
    const u = new URL(safe);
    const m = u.pathname.match(/^\/video\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:\/|$)/i);
    return m ? 'media:' + m[1].toLowerCase() : '';
  }
  function isNewRecord(key, baseline) { return !!baseline && !baseline.keys.includes(key); }
  function relevantMediaRequest(raw, origin) {
    try {
      const u = new URL(typeof raw === 'string' ? raw : raw?.url || String(raw), origin);
      return u.origin === origin && u.pathname.endsWith('/data/batchexecute');
    } catch (_) { return false; }
  }
  async function boundedResponseText(response, limit = 16000000) {
    if (Number(response.headers?.get('content-length')) > limit) return '';
    if (!response.body?.getReader) return ''; // Do not allocate an unbounded fallback.
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, text = '';
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) { await reader.cancel(); return ''; }
        text += decoder.decode(part.value, { stream: true });
      }
      return text + decoder.decode();
    } finally { reader.releaseLock(); }
  }
  function parseSourcePack(s) {
    const headings = [...s.matchAll(/^[ \t]*([\w][\w.-]*)\s*\|\s*Source:\s*([^\n|]+?)\s*\|\s*(\d+(?:\.\d+)?)s[ \t]*$/gmi)];
    return headings.map((m, i) => {
      const block = s.slice(m.index + m[0].length, headings[i + 1]?.index ?? s.length);
      const markers = [...block.matchAll(/^[ \t]*MOTION PROMPT[ \t]*$/gmi)];
      if (markers.length !== 1) throw new Error(m[1] + ': needs one MOTION PROMPT section.');
      const seconds = +m[3], sourceFrame = m[2].trim();
      const prompt = block.slice(markers[0].index + markers[0][0].length).replace(/\n\s*={3,}\s*$/, '').trim();
      return { id: m[1], frame: sourceFrame.split(/[\\/]/).pop(), sourceFrame, seconds, planningSeconds: seconds,
        position: i + 1, prompt, format: 'source' };
    });
  }

  // PURE_CORE_END

  if (document.getElementById('fs-panel') || window[Symbol.for('flow-studio:installed')]) return;
  window[Symbol.for('flow-studio:installed')] = true;
  const TILE = 'flow-video-tile,flow-image-tile';
  const SCOPE = 'flow-grid-tile-container';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clips = new Map();
  const mediaAliases = new Map();
  let tileIdentities = new WeakMap();
  const ui = {};
  const state = { project: projectIdentity(location.pathname), filter: '', sort: 'script',
    view: 'all', tab: 'library', anchor: '', gridAnchor: '', tilePicker: true,
    rowPicker: GM_getValue('fs3:rows', false), effect: GM_getValue('fs3:effect', 'still'),
    writable: false, scanning: false, downloading: false, generating: false, stop: false, baseline: null,
    mediaReady: false, relinkKey: '', schemaVersion: 4, scanned: false, scanCursor: null, downloadBatch: null, jobs: [], submissionHistory: {}, serial: 0, dirty: false };
  let saveTimer, refreshTimer, overlayFrame;
  const visible = el => !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const own = el => !!el?.closest?.('#fs-panel,#fs-fab,#fs-grid-layer,#fs-pick-dock,[data-fs-ui]');
  const running = () => state.scanning || state.downloading || state.generating;
  const busy = () => !state.writable || running();
  let writerProject = '', releaseWriter = null, writerRevision = 0;
  const sessionTiles = new Set();
  const ambiguousTokens = new Set();
  // Parse only media responses already requested by Flow. Never issue an RPC.
  function parseFlowMedia(text) {
    if (typeof text !== 'string' || text.length > 16000000) return [];
    const uuid = s => typeof s === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(s);
    const roots = [], titles = new Map(), records = new Map();
    for (const line of text.split('\n')) {
      if (!line.trimStart().startsWith('[')) continue;
      try {
        const outer = JSON.parse(line);
        for (const entry of outer) if (entry?.[0] === 'wrb.fr' && typeof entry[2] === 'string') roots.push(JSON.parse(entry[2]));
      } catch (_) { /* Ignore framing lines or unrelated responses. */ }
    }
    const stack = [...roots]; let visited = 0;
    while (stack.length && visited++ < 300000) {
      const row = stack.pop(); if (!Array.isArray(row)) continue;
      if (uuid(row[0]) && uuid(row[4]) && Array.isArray(row[3]) && typeof row[3][0] === 'string' && uuid(row[3][4])) {
        titles.set(row[4] + ':' + row[3][4], row[3][0]);
      }
      // Known media envelope. [7] is video; images live at [6]. Do not crawl
      // input-frame URLs inside generation settings and assign them to outputs.
      if (uuid(row[0]) && uuid(row[1]) && uuid(row[2]) && Array.isArray(row[5]) && Array.isArray(row[7]) && Array.isArray(row[7][0])) {
        const urls = [row[5][5], row[5][10], row[7][0][8]].filter(u => typeof u === 'string' && trustedMediaURL(u));
        const tokens = [...new Set(urls.map(assetToken).filter(Boolean))];
        if (tokens.length) {
          const original = urls.find(u => { try { const x = new URL(u); return x.hostname === 'flow-content.google' && x.pathname === '/video/' + row[0]; } catch (_) { return false; } }) || '';
          records.set(row[1] + ':' + row[0], { key: 'media:' + row[0], mediaId: row[0], entityId: row[2], project: row[1],
            mediaTokens: tokens, poster: trustedMediaURL(row[5][5]) || trustedMediaURL(row[5][10]) || '', originalUrl: original,
            prompt: typeof row[5][1] === 'string' ? row[5][1] : '', duration: Number(row[7][1]?.[2]?.[0]) || 0,
            createdAt: Number(row[5][0]?.[0]) * 1000 || 0 });
        }
      }
      for (const value of row) if (Array.isArray(value)) stack.push(value);
    }
    return [...records.values()].map(r => ({ ...r, title: titles.get(r.project + ':' + r.mediaId) || '' }));
  }
  function mergeDownloadResult(records) {
    const priority = { downloaded: 6, requested: 5, uncertain: 4, issuing: 4, downloading: 4, failed: 3, pending: 2, locating: 2, skipped: 2 };
    return [...records].sort((a,b) => (priority[b.downloadState || b.state] || 0) - (priority[a.downloadState || a.state] || 0))[0] || {};
  }
  function installMediaObserver(page, consume) {
    const relevant = raw => relevantMediaRequest(raw, location.origin);
    const deliver = text => { try { consume(text); } catch (_) { /* Never affect Flow's request. */ } };
    const proto = page.XMLHttpRequest?.prototype;
    if (proto) {
      const open = proto.open, send = proto.send, observed = new WeakMap();
      proto.open = function(method, url, ...rest) { observed.set(this, relevant(url)); return Reflect.apply(open, this, [method, url, ...rest]); };
      proto.send = function(...args) {
        if (observed.get(this)) this.addEventListener('load', function() {
          try { if (this.status === 200 && relevant(this.responseURL) && (!this.responseType || this.responseType === 'text')) deliver(this.responseText); } catch (_) {}
        }, { once: true });
        return Reflect.apply(send, this, args);
      };
    }
    if (typeof page.fetch === 'function') {
      const originalFetch = page.fetch;
      page.fetch = function(...args) {
        const response = Reflect.apply(originalFetch, this, args);
        if (relevant(args[0])) {
          response.then(r => { if (r.ok && relevant(r.url)) return boundedResponseText(r.clone()).then(deliver); }).catch(() => {});
        }
        return response;
      };
    }
  }
  const mediaCatalog = new Map(), readyProjects = new Set();
  let mediaRefresh;
  function ingestMediaResponse(text) {
    const entries = parseFlowMedia(text).filter(r => r.project === projectIdentity(location.pathname)); if (!entries.length) return;
    for (const incoming of entries) {
      const key = incoming.project + ':' + incoming.key, previous = mediaCatalog.get(key);
      mediaCatalog.set(key, { ...previous, ...incoming, title: incoming.title || previous?.title || '',
        poster: incoming.poster || previous?.poster || '', originalUrl: incoming.originalUrl || previous?.originalUrl || '',
        mediaTokens: [...new Set([...(previous?.mediaTokens || []), ...incoming.mediaTokens])] });
      readyProjects.add(incoming.project);
    }
    state.catalogDirty = true;
    if (ui.panel) {
      clearTimeout(mediaRefresh); mediaRefresh = setTimeout(() => {
        if (state.writable && !state.scanning && !state.downloading) { reconcileMedia(); harvest(false); if (!state.generating) renderLibrary(); }
      }, 100);
    }
  }
  function reconcileMedia() {
    if (!state.project) return;
    const entries = [...mediaCatalog.values()].filter(r => r.project === state.project);
    if (!entries.length) return;
    state.mediaReady = readyProjects.has(state.project);
    const bindings = new Map(), remap = new Map();
    for (const entry of entries) for (const token of [entry.key, entry.mediaId, ...entry.mediaTokens]) {
      addAlias(bindings, token, entry.key);
    }
    const matches = new Map();
    for (const rec of clips.values()) {
      if (rec.kind === 'image' || /^image(?:-tile)?:/.test(rec.key)) continue;
      const tokens = [rec.key, ...(rec.mediaTokens || []), assetToken(rec.poster || '')];
      const ids = new Set(tokens.map(t => bindings.get(t)).filter(Boolean));
      const id = ids.size === 1 ? [...ids][0] : null;
      if (!id) { rec.legacy = !/^(media:|tile:|image:|image-tile:)/.test(rec.key); continue; }
      remap.set(rec.key, id);
      if (!matches.has(id)) matches.set(id, []);
      matches.get(id).push(rec);
    }
    for (const info of entries) {
      const previous = matches.get(info.key) || [], rec = clips.get(info.key) || { key: info.key, serial: state.serial++, selected: false, downloadState: '', note: '', firstSeen: Date.now(), seenInBatch: isNewRecord(info.key, state.baseline) };
      const best = mergeDownloadResult(previous), positioned = [...previous].sort((a,b)=>(b.capturedAt || 0)-(a.capturedAt || 0)).find(r=>Number.isFinite(r.y));
      const inherited = previous.find(r => r.selectionCapture);
      if (positioned && !Number.isFinite(rec.y)) Object.assign(rec, {y:positioned.y,x:positioned.x,scrollTop:positioned.scrollTop,capturedAt:positioned.capturedAt});
      if (previous.length) { rec.selected = previous.some(r => r.selected); rec.downloadState = best.downloadState || ''; rec.note = best.note || ''; rec.lastRequestedAt = best.lastRequestedAt || rec.lastRequestedAt; }
      const tokens = [...new Set([...info.mediaTokens, ...previous.flatMap(r=>[r.key,...(r.mediaTokens || [])])])];
      Object.assign(rec, { mediaId: info.mediaId, entityId: info.entityId, legacy: false, mediaTokens: tokens,
        title: info.title || rec.title || 'Video', poster: info.poster || rec.poster, prompt: info.prompt || rec.prompt,
        duration: info.duration || rec.duration, createdAt: info.createdAt, originalUrl: info.originalUrl || rec.originalUrl || '',
        resultReady: !!rec.resultReady || (!!info.originalUrl && info.duration > 0), captureState: 'captured',
        // A scene-linked clip keeps its pack ID; recomputing it here made the two passes fight.
        scriptId: (rec.sceneFingerprint && rec.scriptId) || scriptId(info.title) || scriptId(info.prompt) || rec.scriptId || '' });
      if (!rec.selectionCapture && inherited) rec.selectionCapture = { ...inherited.selectionCapture, key: info.key };
      for (const old of previous) if (old.key !== info.key) clips.delete(old.key);
      clips.set(info.key, rec);
      for (const token of [info.key,info.mediaId,...tokens]) addAlias(mediaAliases, token, info.key);
      for (const old of previous) if (state.baseline?.keys.includes(old.key) && !state.baseline.keys.includes(info.key)) state.baseline.keys.push(info.key);
      rec.seenInBatch = isNewRecord(info.key, state.baseline);
    }
    if (state.downloadBatch) {
      const grouped = new Map();
      for (const item of state.downloadBatch.items) {
        const key = remap.get(item.key) || item.key;
        if (!/^(media:|tile:|image:|image-tile:)/.test(key)) { item.legacyState = item.legacyState || item.state; item.state = 'relink'; continue; }
        item.key = key;
        if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(item);
      }
      const stale = state.downloadBatch.items.filter(i => !/^(media:|tile:|image:|image-tile:)/.test(i.key));
      state.downloadBatch.items = [...grouped].map(([key,items]) => ({ ...mergeDownloadResult(items), key } )).concat(stale);
      if (state.downloadBatch.checkKey) state.downloadBatch.checkKey = remap.get(state.downloadBatch.checkKey) || state.downloadBatch.checkKey;
      // A duplicate legacy failure must not override a confirmed current record.
      for (const item of state.downloadBatch.items) {
        const rec = clips.get(item.key); if (!rec || rec.legacy) continue;
        const winner = mergeDownloadResult([{state: item.state,note:item.note},{state:rec.downloadState,note:rec.note}]);
        item.state = winner.state || 'pending'; rec.downloadState = item.state; item.note = rec.note = winner.note || '';
      }
    }
    state.anchor = remap.get(state.anchor) || state.anchor;
    state.gridAnchor = remap.get(state.gridAnchor) || state.gridAnchor;
    state.catalogDirty = false;
    reconcileScenes();
    saveSoon();
  }
  function beginRelink(key) {
    if (busy()) return;
    state.relinkKey = key; togglePanel(false, true);
    toast('Click the matching video checkbox on the grid to reconnect this old selection.');
  }
  function completeRelink(key) {
    const old = clips.get(state.relinkKey), current = clips.get(key);
    if (!old?.legacy || !current || current.legacy) return false;
    current.selected = current.selected || old.selected;
    const result = mergeDownloadResult([old,current]); current.downloadState = result.downloadState; current.note = result.note;
    current.mediaTokens = [...new Set([...(current.mediaTokens || []),old.key,...(old.mediaTokens || [])])];
    for (const token of current.mediaTokens) addAlias(mediaAliases,token,key);
    for (const item of state.downloadBatch?.items || []) if(item.key===old.key) { item.key=key;if(item.state==='relink')item.state='pending'; }
    clips.delete(old.key); state.relinkKey = '';
    reconcileMedia(); writeStorage(); renderLibrary(); decorateGrid();
    toast('Old selection reconnected to this video’s permanent ID.'); return true;
  }

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (value == null) return;
      if (key === 'text') el.textContent = value;
      else if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value);
    });
    kids.flat().forEach(k => { if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k))); });
    return el;
  }
  function btn(text, action, cls = 'fs-btn', title = '') {
    return h('button', { type: 'button', class: cls, text, title, onclick: action });
  }
  function toast(message, error = false) {
    if (!ui.status) return;
    ui.status.textContent = message;
    ui.status.classList.toggle('error', error);
  }
  function setProgress(n, total) {
    ui.progress.style.width = total ? Math.min(100, n / total * 100) + '%' : '0%';
  }

  async function acquireWriter(project = state.project) {
    const revision = ++writerRevision;
    if (releaseWriter) { releaseWriter(); releaseWriter = null; }
    writerProject = ''; state.writable = false;
    if (!project) { updateCounts(); return; }
    if (!navigator.locks?.request) { toast('This browser cannot lock the project safely. Queue controls are read-only.', true); updateCounts(); return; }
    try {
      await navigator.locks.request('flow-studio:project:' + project, { ifAvailable: true }, async lock => {
        if (revision !== writerRevision || project !== state.project) return;
        if (!lock) { toast('Another Flow Studio tab owns this project. Close it, then click Enable this tab.'); updateCounts(); return; }
        writerProject = project; state.writable = true;
        restoreProject(); harvest(false); renderLibrary(); renderQueue(); updateCounts();
        toast('Project ready. New images and videos are captured from the grid as they appear.');
        try { await new Promise(resolve => { releaseWriter = resolve; }); }
        finally { if (revision === writerRevision) { writerProject = ''; state.writable = false; releaseWriter = null; } }
      });
    } catch (e) {
      if (revision === writerRevision) { writerProject = ''; state.writable = false; updateCounts(); toast('Project lock unavailable: ' + e.message, true); }
    }
  }
  function requireWriter() {
    if (!state.writable || writerProject !== state.project) throw new Error('This tab does not own the project. Use Enable this tab after closing the other Flow Studio tab.');
  }

  function writeStorage(strict = false) {
    clearTimeout(saveTimer);
    if (!state.project) return;
    if (!state.writable || writerProject !== state.project) { if (strict === true) requireWriter(); return; }
    try {
      GM_setValue('fs3:project:' + state.project, { clips: [...clips.values()].map(r => {
        const { videoUrl, prompt, ...rest } = r;
        // Full unselected prompts arrive again with Flow's catalog. Avoid copying
        // megabytes through extension storage on every checkbox or status change.
        // The short original link is kept so a reload can still save named files.
        return r.selected || r.legacy || r.sceneFingerprint ? { ...rest, prompt } : rest;
      }), serial: state.serial, baseline: state.baseline, scanned: state.scanned,
      jobs: state.jobs, submissionHistory: state.submissionHistory,
      downloadBatch: state.downloadBatch, scanCursor: state.scanCursor, schemaVersion: 4, savedAt: Date.now() });
    } catch (e) {
      toast('Could not save project progress: ' + e.message, true);
      if (strict === true) throw new Error('Progress could not be saved. No further action was clicked.', { cause: e });
    }
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(writeStorage, 250); }
  function restoreProject() {
    state.promptImportRevision = (state.promptImportRevision || 0) + 1;
    clips.clear(); mediaAliases.clear(); sessionTiles.clear(); ambiguousTokens.clear(); tileIdentities = new WeakMap();
    const data = state.project ? GM_getValue('fs3:project:' + state.project, {}) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        (data.clips != null && !Array.isArray(data.clips)) || (data.jobs != null && !Array.isArray(data.jobs)))
      throw new Error('Saved project data is malformed. Restore a backup before editing; nothing was overwritten.');
    if (state.writable && data.clips?.length && data.schemaVersion !== 4 && !GM_getValue('fs3:before-stable-ids:' + state.project, null)) GM_setValue('fs3:before-stable-ids:' + state.project, data);
    state.mediaReady = readyProjects.has(state.project);
    for (const r of Array.isArray(data.clips) ? data.clips : []) {
      if (!r || typeof r.key !== 'string') continue;
      clips.set(r.key, { ...r, legacy: !/^(media:|tile:|image:|image-tile:)/.test(r.key), videoUrl: '',
        selected: r.key.startsWith('tile:') ? false : !!r.selected,
        captureState: 'needs-capture',
      downloadState: /^(issuing|downloading)$/.test(r.downloadState) ? 'uncertain' : r.downloadState });
    }
    for (const rec of clips.values()) if (rec.key.startsWith('media:')) for (const token of [rec.key, ...(rec.mediaTokens || [])]) addAlias(mediaAliases, token, rec.key);
    state.serial = data.serial || 0;
    state.baseline = Array.isArray(data.baseline?.keys) ? data.baseline : null;
    state.scanned = !!data.scanned;
    state.scanCursor = data.scanCursor || null;
    if (state.scanCursor?.phase === 'running') state.scanCursor.phase = 'paused';
    state.downloadBatch = recoverDownloadBatch(data.downloadBatch);
    for (const item of state.downloadBatch?.items || []) {
      const rec = clips.get(item.key);
      if (rec) {
        const result = mergeDownloadResult([{ downloadState: item.state, note: item.note }, rec]);
        rec.downloadState = result.downloadState; rec.note = result.note || '';
        item.state = rec.downloadState; item.note = rec.note;
      }
    }
    // Earlier versions marked an ordinary Pause as a download failure.
    for (const rec of clips.values()) if (rec.downloadState === 'failed' && /^Paused by you\./.test(rec.note || '')) {
      rec.downloadState = 'pending'; rec.note = '';
    }
    state.jobs = recoverJobs(Array.isArray(data.jobs) ? data.jobs : []);
    state.sceneFilter = ''; state.activeScene = '';
    for (const job of state.jobs) {
      const saved = data.submissionHistory?.[job.fingerprint];
      if (job.state === 'uncertain' && /^(submitted|completed)$/.test(saved?.state)) job.state = saved.state;
    }
    state.submissionHistory = Object.assign(Object.create(null), data.submissionHistory || {});
    state.anchor = ''; state.gridAnchor = ''; state.relinkKey = '';
    reconcileMedia();
  }
  function sameProject(project) {
    requireWriter();
    if (state.queueLease && GM_getValue(state.queueLease.key, null)?.owner !== state.queueLease.owner) throw new Error('Queue ownership changed. Nothing further was clicked.');
    if (projectIdentity(location.pathname) !== project) throw new Error('Project changed. Operation stopped.');
    if (state.stop) throw new Error('Paused by you.');
  }
  function isGrid() {
    if (!isProjectGridRoute(location.pathname)) return false;
    // A new project can contain only uploaded images, or no media yet.
    // Recognize the workspace itself instead of requiring an existing video.
    return !!document.querySelector(SCOPE + ',cdk-virtual-scroll-viewport.tiles-container') ||
      (!!document.querySelector('flow-rich-text-editor [contenteditable="true"]') && !!appButton('Tile grid settings'));
  }
  function scroller() {
    let el = document.querySelector(TILE) || document.querySelector(SCOPE) || document.querySelector('cdk-virtual-scroll-viewport.tiles-container');
    while (el) {
      if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 40) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function tileTokens(tile) {
    const image = tile.querySelector('img'), video = tile.querySelector('video');
    return [...new Set([image?.src, image?.currentSrc, video?.getAttribute('src'), video?.currentSrc,
      video?.poster, video?.querySelector('source')?.src].filter(Boolean).map(assetToken).filter(Boolean))];
  }
  function tileKey(tile) {
    if (tile.matches('flow-image-tile')) {
      const id = tile.querySelector('img[data-media-id]')?.getAttribute('data-media-id') || '';
      if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) return 'image:' + id.toLowerCase();
      const token = tileTokens(tile)[0]; return token ? 'image-tile:' + token : '';
    }
    const tokens = tileTokens(tile);
    const identities = new Set(tokens.map(t => mediaAliases.get(t)).filter(k => k?.startsWith('media:')));
    const video = tile.querySelector('video');
    for (const raw of [video?.currentSrc, video?.getAttribute('src'), video?.querySelector('source')?.src]) {
      const key = videoIdentityFromURL(raw); if (key) identities.add(key);
    }
    if (identities.size > 1) return '';
    if (identities.size === 1) return [...identities][0];
    // Only a session-bound tile reference, never a durable or original-download ID.
    // Duplicate visible poster/preview tokens are deliberately not selectable.
    if (!tokens.length || tokens.some(token => ambiguousTokens.has(token))) return '';
    return 'tile:' + tokens.slice().sort()[0];
  }
  function refreshTileIdentities() {
    const owners = new Map(); ambiguousTokens.clear();
    const tiles = [...document.querySelectorAll(TILE)];
    for (const tile of tiles) for (const token of tileTokens(tile)) {
      if (owners.has(token) && owners.get(token) !== tile) ambiguousTokens.add(token);
      else owners.set(token, tile);
    }
    for (const tile of tiles) {
      const key = tileKey(tile); if (!key) continue;
      if (key.startsWith('tile:')) {
        sessionTiles.add(key);
        // Preserve selection while the same live tile switches poster to preview,
        // but never bind across a reused DOM node with no shared asset token.
        const previous = tileIdentities.get(tile), tokens = tileTokens(tile);
        if (previous && previous.key !== key && previous.tokens.some(t => tokens.includes(t))) {
          const rec = clips.get(previous.key);
          if (rec && !clips.has(key)) {
            clips.delete(previous.key); rec.key = key; clips.set(key, rec);
            for (const item of state.downloadBatch?.items || []) if (item.key === previous.key) item.key = key;
            if (state.baseline?.keys.includes(previous.key)) state.baseline.keys.push(key);
          }
        }
        tileIdentities.set(tile, { key, tokens });
      }
    }
  }
  function cleanTileText(scope) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n, parts = [];
    while ((n = walker.nextNode())) {
      if (own(n.parentElement) || n.parentElement?.closest('mat-icon,button')) continue;
      const s = normalizeText(n.nodeValue);
      if (s && !/^(play_circle|image|favorite|redo|more_vert|\d+%)$/.test(s)) parts.push(s);
    }
    return parts.sort((a, b) => b.length - a.length)[0] || '';
  }
  function harvest(render = true) {
    if (!state.project || !isGrid() || projectIdentity(location.pathname) !== state.project) return;
    refreshTileIdentities();
    const sc = scroller(), scRect = sc.getBoundingClientRect();
    let changed = false;
    document.querySelectorAll(TILE).forEach(tile => {
      const scope = tile.closest(SCOPE) || tile;
      const text = cleanTileText(scope);
      const exposedPrompt = /SCRIPT|DIALOGUE|PERFORMANCE|Animate the supplied/i.test(text) || state.jobs.some(j => normalizeText(j.prompt) === normalizeText(text)) ? text : '';
      const key = tileKey(tile); if (!key) return;
      const kind = tile.matches('flow-image-tile') ? 'image' : 'video';
      const image = tile.querySelector('img');
      const title = normalizeText(scope.getAttribute('aria-label') || '');
      const rect = scope.getBoundingClientRect();
      let rec = clips.get(key);
      if (!rec) {
        rec = { key, serial: state.serial++, title: '', prompt: '', scriptId: '', selected: false,
          downloadState: '', note: '', firstSeen: Date.now(), seenInBatch: !!state.baseline && !state.baseline.keys.includes(key) };
        clips.set(key, rec); changed = true;
      }
      rec.kind = kind;
      const p = exposedPrompt || '';
      if (title && title !== rec.title) { rec.title = title; changed = true; }
      if (p && p !== rec.prompt) { rec.prompt = p; changed = true; }
      const id = (rec.sceneFingerprint && rec.scriptId) || scriptId(title) || scriptId(p) || rec.scriptId || '';
      if (id !== rec.scriptId) { rec.scriptId = id; changed = true; }
      const poster = image?.currentSrc || image?.src || tile.querySelector('video')?.poster;
      if (poster && poster !== rec.poster) { rec.poster = poster; changed = true; }
      rec.mediaTokens = [...new Set([...(rec.mediaTokens || []), ...tileTokens(tile)])];
      rec.domOnly = key.startsWith('tile:');
      if (key.startsWith('media:')) { rec.mediaId = key.slice(6); state.mediaReady = true; }
      if (key.startsWith('image:')) rec.mediaId = key.slice(6);
      rec.y = sc.scrollTop + rect.top - scRect.top;
      rec.x = rect.left;
      rec.scrollTop = sc.scrollTop;
      rec.capturedAt = Date.now();
      const downloadControl = scope.querySelector('button[aria-label="More options"]');
      const captureState = downloadControl && !downloadControl.disabled ? 'captured' : 'needs-capture';
      if (rec.captureState !== captureState) { rec.captureState = captureState; changed = true; }
      const video = tile.querySelector('video');
      if (video) {
        const src = video.currentSrc || video.src;
        // Never infer an original-download URL from a hover preview.
        if (Number.isFinite(video.duration)) rec.duration = video.duration;
        if (video.readyState >= 1 && video.duration > 0) rec.resultReady = true;
      }
    });
    if (reconcileScenes()) changed = true;
    if (!state.generating) decorateGrid();
    if (changed) saveSoon();
    if (render && changed && !running()) { renderLibrary(); renderQueue(); }
    if (render) updateCounts();
  }
  function ordered() {
    return [...clips.values()].filter(r => state.view === 'legacy' ? r.legacy && r.selected : !r.legacy).sort((a, b) => {
      if (state.sort === 'script' && (a.scriptId || b.scriptId)) {
        if (!a.scriptId) return 1; if (!b.scriptId) return -1;
        const c = a.scriptId.localeCompare(b.scriptId, undefined, { numeric: true }); if (c) return c;
      }
      return (a.gridRank ?? a.y ?? a.serial) - (b.gridRank ?? b.y ?? b.serial) || (a.x || 0) - (b.x || 0) || a.serial - b.serial;
    });
  }
  function filtered() {
    return ordered().filter(r => (!state.sceneFilter || r.sceneFingerprint === state.sceneFilter) && (!state.filter || (r.title + ' ' + r.prompt + ' ' + r.scriptId).toLowerCase().includes(state.filter)) &&
      (state.view !== 'images' || r.kind === 'image') && (state.view !== 'videos' || r.kind !== 'image') && (state.view !== 'selected' || r.selected) && (state.view !== 'failed' || r.downloadState === 'failed') &&
      (state.view !== 'new' || r.seenInBatch) &&
      (state.view !== 'requested' || r.downloadState === 'requested') &&
      (state.view !== 'uncertain' || r.downloadState === 'uncertain') &&
      (state.view !== 'downloaded' || r.downloadState === 'downloaded'));
  }
  function applySelection(keys, selected, message = '') {
    if (busy()) { toast('Enable this tab and pause any active operation before changing selections.'); return; }
    // Capture the current rendered tiles synchronously at the actual click.
    // No scrolling, menu opening, playback manipulation or full-project scan.
    harvest(false);
    keys = keys.filter(key => !selected || !clips.get(key)?.legacy);
    keys.forEach(key => {
      const r = clips.get(key); if (!r || r.legacy || r.kind === 'image') return;
      r.selected = selected;
      if (selected) {
        // The capture belongs to the video, never to a row number or tile index.
        r.selectionCapture = { key: r.key, mediaTokens: [...(r.mediaTokens || [])], poster: r.poster || '',
          title: r.title, y: r.y, x: r.x, scrollTop: r.scrollTop, at: r.capturedAt || null,
          state: r.captureState || 'needs-capture' };
      }
    });
    // A paused batch follows explicit deselection/reselection of pending items.
    for (const item of state.downloadBatch?.items || []) {
      if (keys.includes(item.key) && /^(pending|skipped)$/.test(item.state)) item.state = selected ? 'pending' : 'skipped';
    }
    writeStorage(); renderLibrary(); decorateGrid();
    if (message) {
      const missing = selected ? keys.filter(key => clips.get(key)?.captureState !== 'captured').length : 0;
      toast(message + (selected ? (missing ? ' ' + missing + ' need a loaded tile; the queue will verify them before downloading.' : ' Video identities and download controls captured.') : ''));
    }
  }
  function uncheckAllVideos() {
    if (busy()) { toast('Pause the current operation before clearing video selections.'); return; }
    const selected = new Set([...clips.values()].filter(r => r.selected).map(r => r.key));
    for (const rec of clips.values()) rec.selected = false;
    for (const item of state.downloadBatch?.items || []) {
      if (selected.has(item.key) && /^(pending|skipped)$/.test(item.state)) item.state = 'skipped';
    }
    state.anchor = ''; state.gridAnchor = ''; state.relinkKey = '';
    writeStorage(); renderLibrary(); decorateGrid();
    toast('Unchecked ' + selected.size + ' videos. Download history kept.');
  }
  function selectClip(key, shift, grid = false) {
    if (state.relinkKey && grid) { completeRelink(key); return; }
    const r = clips.get(key); if (!r || r.legacy) return;
    if (r.kind === 'image') { toast('Image detected: ' + r.title + '. Download still images through Flow’s image menu.'); return; }
    const anchor = grid ? state.gridAnchor : state.anchor;
    const list = grid ? visibleGridItems().sort((a, b) => a.top - b.top || a.left - b.left).map(x => x.key) : filtered().map(x => x.key);
    const keys = shift ? rangeKeys(list, anchor, key) : [key], selected = !r.selected;
    applySelection(keys, selected, (selected ? 'Selected ' : 'Cleared ') + keys.length + (keys.length === 1 ? ' clip.' : ' clips.'));
    if (grid) state.gridAnchor = key; else state.anchor = key;
  }
  function stopEvent(e) { e.preventDefault(); e.stopPropagation(); }
  function visibleGridItems() {
    if (!isGrid()) return [];
    return [...document.querySelectorAll(TILE)].map(tile => {
      const scope = tile.closest(SCOPE) || tile, r = scope.getBoundingClientRect();
      return { tile, scope, key: tileKey(tile), top: r.top, left: r.left, bottom: r.bottom, width: r.width, height: r.height };
    }).filter(i => clips.has(i.key) && clips.get(i.key).kind !== 'image' && i.width > 40 && i.bottom > 70 && i.top < innerHeight - 20);
  }
  const gridControls = new Map();
  function toggleVisualRow(anchorKey) {
    // Resolve membership at click time: Flow recycles and moves grid tiles.
    const row = groupVisualRows(visibleGridItems()).find(r => r.items.some(i => i.key === anchorKey));
    if (!row) { scheduleOverlays(); return; }
    const keys = [...new Set(row.items.map(i => i.key))];
    const selected = !keys.every(key => clips.get(key)?.selected);
    applySelection(keys, selected, (selected ? 'Selected ' : 'Cleared ') + keys.length + ' clips in this row.');
  }
  function exposedAt(x, y, scope) {
    if (x < 0 || y < 70 || x > innerWidth || y > innerHeight - 10) return false;
    // Do not float above Flow's composer, modal dialogs, or our own panel.
    const stack = document.elementsFromPoint(x, y);
    const hit = stack.find(el => !el.closest('#fs-grid-layer'));
    return !!hit && (hit === scope || scope.contains(hit));
  }
  function decorateGrid() {
    if (!ui.gridLayer || ui.gridLayer.hidden || state.generating) return;
    const items = state.tilePicker ? visibleGridItems() : [], active = new Set(items.map(i => i.key));
    const rows = new Map();
    if (state.rowPicker) for (const row of groupVisualRows(items)) rows.set(row.items[0].key, row);
    // Finish layout reads before changing overlay styles (no per-tile reflow loop).
    const exposure = new Map(items.map(item => [item.key, {
      single: exposedAt(item.left + 23, item.top + 23, item.scope),
      row: rows.has(item.key) && exposedAt(item.left + Math.min(61, item.width / 2), item.top + 59, item.scope)
    }]));
    for (const [key, control] of gridControls) if (!active.has(key)) { control.box.remove(); gridControls.delete(key); }
    for (const item of items) {
      const rec = clips.get(item.key);
      let control = gridControls.get(item.key);
      if (!control) {
        const check = h('button', { type: 'button', class: 'fs-tile-check', role: 'checkbox' });
        const row = h('button', { type: 'button', class: 'fs-row-check', role: 'checkbox' });
        const box = h('div', { class: 'fs-grid-box', 'data-fs-ui': '' }, check, row);
        for (const button of [check, row]) ['pointerdown', 'mousedown', 'dblclick'].forEach(type => button.addEventListener(type, stopEvent));
        check.addEventListener('click', e => { stopEvent(e); selectClip(item.key, e.shiftKey, true); });
        row.addEventListener('click', e => { stopEvent(e); toggleVisualRow(item.key); });
        control = { box, check, row }; gridControls.set(item.key, control); ui.gridLayer.append(box);
      }
      const { box, check, row: button } = control;
      const geometry = [item.left,item.top,item.width,item.height].join(',');
      if (control.geometry !== geometry) {
        Object.assign(box.style, { left: item.left + 'px', top: item.top + 'px', width: item.width + 'px', height: item.height + 'px' });
        control.geometry = geometry;
      }
      // All controls live outside Flow's clickable tile, avoiding nested click handlers.
      const showSingle = exposure.get(item.key).single;
      check.hidden = !showSingle;
      check.disabled = busy(); button.disabled = busy();
      box.classList.toggle('selected', rec.selected && showSingle);
      check.dataset.key = item.key;
      check.setAttribute('aria-checked', String(rec.selected));
      check.setAttribute('aria-label', 'Select clip: ' + (rec.scriptId || rec.title || 'Untitled'));
      check.classList.toggle('selected', rec.selected);
      if (check.textContent !== (rec.selected ? '✓' : '')) check.textContent = rec.selected ? '✓' : '';
      check.title = (rec.selected ? 'Deselect this clip' : 'Select this clip') + ' · Shift-click for a range';
      const row = rows.get(item.key);
      button.hidden = !row || !exposure.get(item.key).row;
      if (row) {
        const keys = [...new Set(row.items.map(i => i.key))], count = keys.filter(k => clips.get(k)?.selected).length;
        const all = count === keys.length, mixed = count > 0 && !all;
        const label = all ? '✓ Clear row' : '+ Select row';
        if (button.textContent !== label) button.textContent = label;
        button.setAttribute('aria-label', (all ? 'Clear' : 'Select all') + ' ' + keys.length + ' videos in this row');
        button.setAttribute('aria-checked', mixed ? 'mixed' : String(all));
        button.title = (all ? 'Clear' : 'Select') + ' all ' + keys.length + ' videos in this row. You can untick individual clips afterward.';
        button.classList.toggle('selected', all); button.classList.toggle('mixed', mixed);
      }
    }
  }
  async function scanAll(markBaseline = false, fresh = false) {
    if (busy()) { toast('Pause the current operation first.'); return; }
    if (!isGrid()) { toast('Open the project grid to scan.', true); return; }
    state.scanning = true; state.stop = false; updateCounts();
    const project = state.project, sc = scroller();
    const cursor = !fresh && state.scanCursor?.phase === 'paused' && state.scanCursor.markBaseline === markBaseline
      ? state.scanCursor : { top: 0, found: [], phase: 'running', markBaseline };
    state.scanCursor = cursor; cursor.phase = 'running';
    const found = new Set(cursor.found);
    let completed = false, scanError = '', unresolved = 0;
    function collect() {
      if (state.catalogDirty) reconcileMedia();
      harvest();
      const missing = [...document.querySelectorAll(TILE)].filter(tile => !tileKey(tile)).length;
      [...document.querySelectorAll(TILE)].sort((a, b) => {
        const x = a.getBoundingClientRect(), y = b.getBoundingClientRect(); return x.top - y.top || x.left - y.left;
      }).forEach(tile => { const key = tileKey(tile); if (clips.has(key)) found.add(key); });
      return missing;
    }
    async function collectSettled() {
      let missing = collect();
      for (let attempt = 0; missing && attempt < 8; attempt++) {
        await interruptibleDelay(250, project); missing = collect();
      }
      unresolved += missing;
    }
    try {
      sameProject(project); sc.scrollTop = cursor.top; await interruptibleDelay(650, project); await collectSettled();
      let idle = 0;
      for (let n = 0; n < 600; n++) {
        sameProject(project);
        const before = sc.scrollTop, count = found.size;
        sc.scrollTop += Math.max(200, sc.clientHeight * 0.7);
        await interruptibleDelay(650, project); await collectSettled();
        cursor.top = sc.scrollTop; cursor.found = [...found]; writeStorage(true);
        toast('Scanning the grid · ' + found.size + ' media items');
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5 || sc.scrollTop <= before + 2) {
          await interruptibleDelay(700, project); await collectSettled();
          idle = count === found.size ? idle + 1 : 0;
          if (idle >= 3) { completed = true; break; }
        } else idle = 0;
      }
      if (unresolved) { completed = false; scanError = 'Some visible items have missing or shared asset identities. They were skipped; wait for Flow to load them, then Scan from top.'; }
      let rank = 0; found.forEach(key => { if (clips.has(key)) clips.get(key).gridRank = rank++; });
      state.scanned = completed;
      if (markBaseline && completed) {
        state.baseline = { at: Date.now(), keys: [...found] };
        clips.forEach(r => { r.seenInBatch = false; });
        toast('Baseline saved. “New” will show videos first discovered after this scan.');
      } else toast(completed ? 'Scan complete · ' + found.size + ' media items' : 'Scan stopped. Baseline not changed.');
    } catch (e) { scanError = e.message; toast(e.message, true); }
    finally {
      cursor.phase = completed ? 'complete' : 'paused';
      cursor.found = [...found];
      state.scanning = false; state.stop = false; saveSoon(); renderLibrary(); updateCounts();
      if (!completed) toast(scanError || ('Scan paused · ' + found.size + ' captured. Resume continues from the saved position; Scan from top includes newly added clips.'), !!scanError);
    }
  }

  // Downloads: this section has NO calls into the generation queue.
  class UncertainDownload extends Error {}
  class DownloadPaused extends Error {}
  function downloadCheckpoint(project) {
    if (!state.writable || writerProject !== project || state.stop || projectIdentity(location.pathname) !== project) throw new DownloadPaused('Paused. Queue saved.');
  }
  async function interruptibleDelay(ms, project) {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      downloadCheckpoint(project); await sleep(Math.min(100, ms - elapsed));
    }
    downloadCheckpoint(project);
  }
  async function downloadWaitFor(fn, project, timeout = 5000) {
    for (let elapsed = 0; elapsed < timeout; elapsed += 100) {
      downloadCheckpoint(project); const result = fn(); if (result) return result;
      await sleep(100);
    }
    return null;
  }
  async function waitFor(fn, timeout = 6000, gap = 120) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(gap); }
    return null;
  }
  function elementName(el) {
    if (!el) return '';
    const label = el.getAttribute('aria-label'); if (label) return normalizeText(label);
    const copy = el.cloneNode(true);
    copy.querySelectorAll('mat-icon,[aria-hidden="true"]').forEach(n => n.remove());
    return normalizeText(copy.textContent);
  }
  function appButtons() { return [...document.querySelectorAll('button,[role="button"]')].filter(el => !own(el) && visible(el)); }
  function appButton(name) { return appButtons().find(el => elementName(el) === name); }
  function menuText(el) {
    const copy = el.cloneNode(true); copy.querySelectorAll('mat-icon').forEach(n => n.remove());
    return normalizeText(copy.textContent);
  }
  function closeMenus() {
    const menus = [...document.querySelectorAll('.mat-mdc-menu-panel,[role="menu"]')].filter(visible);
    if (!menus.length) return;
    for (const menu of menus.reverse()) {
      const backdrop = menu.closest('.cdk-overlay-pane')?.previousElementSibling;
      if (backdrop?.matches('.cdk-overlay-backdrop')) backdrop.click();
      else menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }
  async function revealTile(rec, project) {
    if (rec.kind === 'image' || rec.legacy || !/^(media:|tile:)/.test(rec.key)) throw new Error('This old selection needs relinking. Open Old picks and choose Link to video.');
    if (rec.key.startsWith('tile:') && (!sessionTiles.has(rec.key) || !rec.selected)) throw new Error('Select this visible clip again in this session before downloading.');
    const find = () => {
      refreshTileIdentities();
      const matches = [...document.querySelectorAll(TILE)].filter(tile => tileKey(tile) === rec.key);
      return matches.length === 1 ? matches[0] : null;
    };
    const sc = scroller();
    function usable(tile) {
      if (!tile) return false;
      const r = tile.getBoundingClientRect(), bounds = sc.getBoundingClientRect();
      return r.bottom > Math.max(70, bounds.top) && r.top < Math.min(innerHeight - 100, bounds.bottom);
    }
    downloadCheckpoint(project);
    let tile = find();
    if (usable(tile)) return tile;
    // Prefer the exact tile, if Flow still has it mounted. A virtualized tile must
    // match its saved media identity; titles and array positions are not identities.
    if (tile) {
      tile.scrollIntoView({ block: 'center', behavior: 'instant' });
      await interruptibleDelay(500, project);
      tile = find(); if (usable(tile)) return tile;
    }
    const target = Math.max(0, (rec.y ?? rec.scrollTop ?? 0) - sc.clientHeight * 0.3);
    // Three local positions, once. Never walk the entire project for every miss.
    for (const offset of [0, -sc.clientHeight * 0.65, sc.clientHeight * 0.65]) {
      downloadCheckpoint(project);
      sc.scrollTo({ top: Math.max(0, target + offset), behavior: 'instant' });
      tile = await downloadWaitFor(() => { harvest(false); const t = find(); return usable(t) ? t : null; }, project, 1500);
      if (tile) return tile;
    }
    throw new Error('Saved video is not at its last position. Select it again on the grid or run Scan all once, then Retry failed downloads.');
  }

  async function menuDownload(rec, item, project) {
    const tile = await revealTile(rec, project), scope = tile.closest(SCOPE) || tile;
    downloadCheckpoint(project);
    const trigger = scope.querySelector('button[aria-label="More options"]');
    if (!trigger) throw new Error('No download menu on this video.');
    // Clicking the existing menu button does not require forcing hover playback.
    closeMenus(); trigger.click();
    const panel = await downloadWaitFor(() => [...document.querySelectorAll('.mat-mdc-menu-panel,[role="menu"]')]
      .find(p => visible(p) && [...p.querySelectorAll('[role="menuitem"],button')].some(el => /^Download$/i.test(menuText(el)))), project);
    if (!panel) throw new Error('Download menu did not open.');
    const download = [...panel.querySelectorAll('[role="menuitem"],button')].find(el => /^Download$/i.test(menuText(el)) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (!download) throw new Error('Download is not available on this video.');
    downloadCheckpoint(project);
    if (!tile.isConnected || tileKey(tile) !== rec.key) throw new Error('The video tile changed before downloading. Select it again.');
    // The parent menu may become a direct download in a future Flow release.
    // Journal before that click too; a missing submenu must not trigger a retry.
    item.state = rec.downloadState = 'issuing'; item.method = 'Flow menu';
    item.requestedAt = Date.now(); rec.lastRequestedAt = item.requestedAt;
    item.note = rec.note = 'Download menu requested; final delivery is not yet confirmed.';
    writeStorage(true);
    try { download.click(); } catch (_) { throw new UncertainDownload('Download action was interrupted. Check Chrome Downloads before retrying.'); }
    const original = await downloadWaitFor(() => [...document.querySelectorAll('.mat-mdc-menu-panel [role="menuitem"],[role="menu"] button')]
      .find(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
        && safeOriginalOption(menuText(el)) && /\boriginal\b|\bsource\b|\b720p\b/i.test(menuText(el))), project);
    if (!original) throw new UncertainDownload('Original-size choice did not appear. Flow may have requested a file directly. Check Chrome Downloads before retrying.');
    downloadCheckpoint(project);
    if (!tile.isConnected || tileKey(tile) !== rec.key || !original.isConnected) throw new Error('The download target changed. Select it again.');
    // Write before the side effect. Refreshing here cannot silently issue a duplicate.
    item.state = rec.downloadState = 'issuing'; item.method = 'Flow menu';
    item.name = ''; item.requestedAt = Date.now(); rec.lastRequestedAt = item.requestedAt;
    item.note = rec.note = 'Flow chooses the filename. Check Chrome Downloads at the request time shown in the report.';
    writeStorage(true);
    try { original.click(); } catch (e) { throw new UncertainDownload('Original click was interrupted. Check Chrome Downloads.'); }
    await sleep(600);
    return 'requested';
  }
  // Save settings are read when each file starts, so edits while paused apply on Resume.
  function loadSaveSettings() {
    const preset = String(GM_getValue('fs3:name-preset', 'order_id'));
    return { folder: String(GM_getValue('fbd_folder', '') || ''), prefix: String(GM_getValue('fbd_prefix', '') || ''),
      preset: preset === 'custom' || NAME_PRESETS[preset] ? preset : 'order_id',
      custom: String(GM_getValue('fs3:name-custom', '{n}_{id}') || '{n}_{id}'),
      method: GM_getValue('fs3:save-method', 'direct') === 'menu' ? 'menu' : 'direct',
      parallel: Math.max(1, Math.min(4, +GM_getValue('fs3:parallel', 3) || 3)) };
  }
  let saveCfg = loadSaveSettings();
  function namePattern() { return saveCfg.preset === 'custom' ? saveCfg.custom : NAME_PRESETS[saveCfg.preset]; }
  function sceneFor(rec) {
    return rec?.sceneFingerprint ? state.jobs.find(j => j.fingerprint === rec.sceneFingerprint) || null : null;
  }
  function takeNumber(rec, job) {
    if (!job) return 1;
    const takes = sceneResults(job).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.serial - b.serial);
    const index = takes.findIndex(r => r.key === rec.key);
    return index > 0 ? index + 1 : 1;
  }
  function plannedName(rec, order = 1, digits = 2) {
    const job = sceneFor(rec);
    const sceneOrder = job ? job.position || state.jobs.indexOf(job) + 1 : 0;
    return buildFileName({ pattern: namePattern(), prefix: saveCfg.prefix, folder: saveCfg.folder,
      order: sceneOrder || order, digits: job ? (state.jobs.length > 99 ? 3 : 2) : digits,
      id: job?.id || rec.scriptId || '', title: rec.title && rec.title !== 'Video' ? rec.title : rec.prompt,
      outputName: job?.outputName || '', take: takeNumber(rec, job) });
  }
  // Clips matched to an imported scene use the scene's edit position. Other clips are
  // numbered in the order Flow generated them, continuing after any existing batch items.
  function planOrder(records, start = 0) {
    const loose = records.filter(r => !sceneFor(r))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.serial - b.serial);
    // Unmatched clips continue after the last scene number so they never share one.
    for (const rec of records) {
      const job = sceneFor(rec);
      if (job) start = Math.max(start, job.position || state.jobs.indexOf(job) + 1);
    }
    const order = new Map(loose.map((r, i) => [r.key, start + i + 1]));
    order.digits = start + loose.length > 99 ? 3 : 2;
    return order;
  }
  function namePlan(records) {
    const order = planOrder(records), names = new Map();
    for (const rec of records) names.set(rec.key, plannedName(rec, order.get(rec.key) || 1, order.digits));
    return names;
  }
  function directLink(rec) {
    if (!rec || saveCfg.method !== 'direct' || typeof GM_download !== 'function' || (rec.directFailures || 0) >= 2) return '';
    return trustedMediaURL(rec.originalUrl || '');
  }
  function downloadError(code, details) {
    const setup = {
      not_enabled: 'Tampermonkey downloads are off. Open the Tampermonkey Dashboard → Settings (Config mode: Advanced) → Downloads BETA, set Download Mode to Browser API, then Resume.',
      not_whitelisted: 'Tampermonkey blocked the .mp4 file type. Tampermonkey Settings → Downloads BETA → Whitelisted File Extensions: add .mp4, then Resume.',
      not_permitted: 'Chrome has not given Tampermonkey download permission. Set Download Mode to Browser API in Tampermonkey and accept Chrome’s prompt, then Resume.',
      not_supported: 'This Tampermonkey version cannot save named files. Update Tampermonkey, or switch Save method to Flow menu.'
    }[code];
    const error = new Error(setup || 'Named download failed' + (details ? ' (' + details + ')' : '') + '. Retry tries again; after two failures it uses Flow’s menu.');
    error.code = code; error.setup = !!setup;
    return error;
  }
  function gmDownload(url, name, timeout = 180000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const timer = setTimeout(() => {
        const error = new Error('No reply after 3 minutes. Check Chrome Downloads before retrying.'); error.uncertain = true;
        finish(reject, error);
      }, timeout);
      try {
        GM_download({ url, name, saveAs: false, conflictAction: 'uniquify',
          onload: () => finish(resolve),
          onerror: err => finish(reject, downloadError(err?.error || 'not_succeeded', err?.details?.current || err?.details || '')),
          ontimeout: () => { const error = new Error('Download timed out. Check Chrome Downloads before retrying.'); error.uncertain = true; finish(reject, error); } });
      } catch (e) { finish(reject, downloadError('not_supported', e.message)); }
    });
  }
  function pendingDownloadBatch() {
    return !!state.downloadBatch?.items.some(item => item.state === 'pending');
  }
  function makeDownloadBatch(records, start = 0) {
    const order = planOrder(records, start);
    return { id: Date.now().toString(36), createdAt: Date.now(), phase: 'paused', deliveryChecked: false,
      items: records.map(rec => ({ key: rec.key, title: rec.title, scriptId: rec.scriptId,
        order: order.get(rec.key) || 0, digits: order.digits, name: '', state: 'pending', note: '', attempts: 0 })) };
  }
  function addSelectedToBatch() {
    if (busy() || !state.downloadBatch || state.downloadBatch.phase === 'complete') return;
    harvest(false);
    const keys = new Set(state.downloadBatch.items.map(i => i.key));
    const additions = newDownloadCandidates(ordered()).filter(r => !keys.has(r.key));
    state.downloadBatch.items.push(...makeDownloadBatch(additions, state.downloadBatch.items.length).items);
    writeStorage(); updateCounts(); toast(additions.length + ' selected videos added to the paused queue.');
  }
  // Named files: Flow's own original link, saved by Tampermonkey with your filename.
  // A few run at once; Pause lets the files already started finish.
  async function runDirectDownloads(batch, project) {
    const queue = batch.items.filter(item => item.state === 'pending' && !clips.get(item.key)?.legacy && directLink(clips.get(item.key)));
    if (!queue.length) return '';
    const total = queue.length;
    let stopReason = '', paused = false, failures = 0, done = 0;
    async function worker() {
      while (queue.length && !stopReason && !paused) {
        try { downloadCheckpoint(project); } catch (_) { paused = true; return; }
        const item = queue.shift(), rec = clips.get(item.key), url = directLink(rec);
        if (!rec || item.state !== 'pending' || !url) continue;
        const name = plannedName(rec, item.order || 1, item.digits || 2);
        try {
          // Journal first: a reload mid-file reports “check this file”, never a silent re-save.
          item.state = rec.downloadState = 'issuing'; item.method = 'Named file'; item.name = name; item.attempts++;
          item.requestedAt = rec.lastRequestedAt = Date.now(); item.note = rec.note = 'Saving as ' + name;
          writeStorage(true); renderLibrary(); updateCounts();
        } catch (e) {
          item.state = rec.downloadState = 'pending'; item.note = rec.note = ''; stopReason = e.message; return;
        }
        try {
          await gmDownload(url, name);
          item.state = rec.downloadState = 'downloaded'; rec.savedAs = name; rec.directFailures = 0;
          item.note = rec.note = 'Saved as ' + name; failures = 0;
        } catch (e) {
          if (e.setup) { item.state = rec.downloadState = 'pending'; item.note = rec.note = ''; stopReason = e.message; }
          else {
            item.state = rec.downloadState = e.uncertain ? 'uncertain' : 'failed'; item.note = rec.note = e.message;
            if (!e.uncertain) rec.directFailures = (rec.directFailures || 0) + 1;
            if (++failures >= 3) stopReason = 'Paused after 3 failed downloads in a row. ' + e.message;
          }
        }
        item.finishedAt = Date.now(); done++;
        if (!stopReason) toast('Saving named files · ' + done + ' of ' + total + ' · ' + name.split('/').pop());
        try { writeStorage(true); } catch (e) { stopReason = e.message; }
        renderLibrary(); updateCounts();
      }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.min(saveCfg.parallel, total) }, worker));
    const crashed = results.find(r => r.status === 'rejected');
    if (crashed && !stopReason) stopReason = crashed.reason?.message || 'Download worker stopped.';
    if (stopReason) return stopReason;
    if (paused) throw new DownloadPaused('Paused. Queue saved.');
    return '';
  }
  // Fallback: Flow's Download menu, one at a time on the grid. Flow names these files.
  async function runMenuDownloads(batch, project) {
    let consecutiveFailures = 0, pauseReason = '';
    for (const item of batch.items) {
      if (item.state !== 'pending') continue;
      if (clips.get(item.key)?.legacy) { item.state = 'relink'; continue; }
      if (item.key.startsWith('tile:') && (!sessionTiles.has(item.key) || !clips.get(item.key)?.selected)) { pauseReason = 'Select the saved clips again on the visible grid before resuming. Their permanent IDs were unavailable.'; break; }
      downloadCheckpoint(project);
      const rec = clips.get(item.key);
      if (!rec) { item.state = 'failed'; item.note = 'Video record missing. Select this video again.'; writeStorage(true); continue; }
      item.state = rec.downloadState = 'locating'; item.attempts++; item.note = rec.note = '';
      writeStorage(true); renderLibrary();
      try {
        // Flow's verified original-size menu is the source of truth, not video.src.
        item.state = rec.downloadState = await menuDownload(rec, item, project);
        item.finishedAt = Date.now(); consecutiveFailures = 0;
      } catch (e) {
        if (e instanceof DownloadPaused && item.state === 'locating') {
          item.state = rec.downloadState = 'pending'; item.note = rec.note = ''; throw e;
        }
        item.state = rec.downloadState = e instanceof UncertainDownload || item.state === 'issuing' ? 'uncertain' : 'failed';
        item.note = rec.note = e.message; item.finishedAt = Date.now(); consecutiveFailures++;
      } finally { closeMenus(); }
      writeStorage(true); renderLibrary(); updateCounts();
      if (item.state === 'requested' && !batch.deliveryChecked) {
        batch.phase = 'awaiting-check'; batch.checkKey = item.key;
        pauseReason = 'First Flow-menu file requested. Check Chrome Downloads (⌘⇧J on Mac / Ctrl+J on Windows), then choose File arrived or File missing.';
        break;
      }
      if (item.state === 'uncertain' || consecutiveFailures >= 3) {
        pauseReason = item.state === 'uncertain' ? 'Paused: check the uncertain file before retrying.' : 'Paused after 3 failures. Select missing videos again or scan once; your queue is saved.';
        break;
      }
      await interruptibleDelay(1800, project);
    }
    return pauseReason;
  }
  async function runDownloads(mode = 'selected') {
    if (busy()) { toast('Pause the current operation first.'); return; }
    if (!isGrid()) { toast('Open the project grid to download.', true); return; }
    reconcileMedia();
    harvest(false);
    if (state.downloadBatch?.phase === 'awaiting-check') {
      toast('Check the first file in Chrome Downloads, then choose File arrived or File missing.'); return;
    }
    if (!pendingDownloadBatch()) {
      const live = [...clips.values()].filter(r => !r.legacy);
      const records = mode === 'failed' ? retryDownloads(live) : newDownloadCandidates(live);
      // Download in saved grid order to avoid crisscrossing the project for script IDs.
      records.sort((a,b) => (a.y ?? a.scrollTop ?? a.serial) - (b.y ?? b.scrollTop ?? b.serial) || (a.x || 0) - (b.x || 0));
      if (!records.length) { toast('Nothing new to download. Saved/requested files are skipped. Use Retry selected missing files if you checked and cannot find them.'); return; }
      if (mode === 'failed') for (const rec of records) { rec.downloadState = 'pending'; }
      state.downloadBatch = makeDownloadBatch(records);
    } else if (mode === 'failed') {
      toast('Resume the saved queue first, or deselect its remaining videos. Failed files stay available for retry.'); return;
    }
    const batch = state.downloadBatch, project = state.project;
    state.downloading = true; state.stop = false; batch.phase = 'running';
    let pauseReason = '';
    try {
      writeStorage(true); updateCounts();
      pauseReason = await runDirectDownloads(batch, project);
      if (!pauseReason) pauseReason = await runMenuDownloads(batch, project);
    } catch (e) { pauseReason = e instanceof DownloadPaused ? 'Paused. Resume continues with the remaining videos.' : e.message; }
    finally {
      // Recover an early error (including a storage error) before a download click.
      for (const item of batch.items) if (item.state === 'locating') {
        item.state = 'pending'; const rec = clips.get(item.key); if (rec) rec.downloadState = 'pending';
      }
      if (batch.phase !== 'awaiting-check') batch.phase = pendingDownloadBatch() ? 'paused' : 'complete';
      state.downloading = false; state.stop = false; writeStorage(); renderLibrary(); updateCounts();
      toast(pauseReason || downloadSummary());
    }
  }
  function checkFirstDownload(arrived) {
    if (busy() || state.downloadBatch?.phase !== 'awaiting-check') return;
    const batch = state.downloadBatch, item = batch.items.find(i => i.key === batch.checkKey), rec = item && clips.get(item.key);
    if (item) {
      item.state = arrived ? 'downloaded' : 'failed';
      item.note = arrived ? 'You confirmed this file arrived in Chrome Downloads.' : 'You reported this file missing. Check Chrome automatic-download permission before retrying.';
      if (rec) { rec.downloadState = item.state; rec.note = item.note; }
    }
    batch.deliveryChecked = arrived;
    batch.phase = pendingDownloadBatch() ? 'paused' : 'complete';
    writeStorage(); renderLibrary(); updateCounts();
    toast(arrived ? (batch.phase === 'complete' ? 'First file confirmed. ' + downloadSummary() : 'First file confirmed. Resume continues from the next video.') : 'Queue preserved. Check Chrome Downloads for a blocked/failed request. Retry selected missing files after fixing it.');
  }
  function retrySelectedMissing() {
    if (busy()) return;
    const records = [...clips.values()].filter(r => !r.legacy && r.selected && /^(failed|requested|uncertain)$/.test(r.downloadState));
    if (!records.length) { toast('Select the missing files first.'); return; }
    if (!confirm('Retry ' + records.length + ' selected missing files? Check Chrome Downloads first: an already-saved file may create a duplicate. No generation or upscaling.')) return;
    for (const rec of records) {
      rec.downloadState = 'pending'; rec.note = '';
      const item = state.downloadBatch?.items.find(i => i.key === rec.key);
      if (item) { item.state = 'pending'; item.note = ''; }
      else if (state.downloadBatch) state.downloadBatch.items.push(...makeDownloadBatch([rec], state.downloadBatch.items.length).items);
    }
    if (state.downloadBatch) { state.downloadBatch.phase = 'paused'; state.downloadBatch.deliveryChecked = false; }
    writeStorage(); renderLibrary(); updateCounts();
    toast('Missing files re-queued. Click Resume / Download when ready.');
  }
  function downloadSummary() {
    const c = batchCounts(state.downloadBatch);
    if (!c.total) return 'Select videos to capture them immediately. Full scan is optional.';
    return [c.downloaded + ' saved', c.pending && c.pending + ' pending', c.active && c.active + ' saving', c.requested && c.requested + ' sent to Chrome (Flow menu)',
      c.failed && c.failed + ' failed', c.uncertain && c.uncertain + ' need checking', c.relink && c.relink + ' old picks need relinking'].filter(Boolean).join(' · ');
  }
  function exportDownloadReport() {
    const headers = ['title','script_id','status','request_time','filename','details','media_id','legacy'];
    const rows = [...clips.values()].filter(r => r.downloadState).map(r => [r.title, r.scriptId, r.downloadState,
      r.lastRequestedAt ? new Date(r.lastRequestedAt).toLocaleString() : '', r.savedAs || 'Flow menu: Flow chose the name', r.note, r.mediaId || '', r.legacy ? 'yes' : 'no']);
    const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: 'Flow-download-report-' + state.project + '.csv' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Report exported with titles, statuses, request times and saved filenames.');
  }

  // Optional generation queue. No calls from Library can enter these functions.
  async function waitButton(name, timeout = 6000) {
    const el = await waitFor(() => appButton(name), timeout);
    if (!el) throw new Error('Flow control missing: ' + name);
    return el;
  }
  function editor() { return [...document.querySelectorAll('[contenteditable="true"]')].find(el => !own(el) && visible(el)); }
  function radio(name) {
    return [...document.querySelectorAll('[role="radio"]')].find(el => !own(el) && visible(el) && elementName(el) === name);
  }
  function settingsAreOpen() { return !!(radio('Video') || radio('Image')); }
  function radioEnabled(el) {
    return !!el && el.isConnected !== false && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }
  async function waitForStableSetting(check, project, timeout = 6000, stableMs = 600) {
    let since = null;
    return !!await waitFor(() => {
      clickPermitted(project);
      if (!check()) { since = null; return false; }
      if (since == null) since = Date.now();
      return Date.now() - since >= stableMs;
    }, timeout, 100);
  }
  async function setSettingsOpen(open, project) {
    clickPermitted(project);
    if (settingsAreOpen() === open) return;
    if (settingsAreOpen() !== open) { const trigger = await waitButton('Settings trigger'); clickPermitted(project); trigger.click(); }
    if (!await waitForStableSetting(() => settingsAreOpen() === open, project, 6000, 250))
      throw new Error('Flow settings did not ' + (open ? 'open' : 'close') + '. Nothing was submitted.');
  }
  async function setRadio(name, project) {
    // Settings can re-render or briefly show the old value after a click.
    // Reacquire the live control and retry only this idempotent settings change.
    let offered = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      clickPermitted(project);
      await setSettingsOpen(true, project);
      const el = await waitFor(() => {
        clickPermitted(project);
        const current = radio(name);
        if (current) offered = true;
        return radioEnabled(current) ? current : null;
      }, 6000, 100);
      if (!el) break;
      clickPermitted(project);
      if (el.getAttribute('aria-checked') === 'true') return;
      el.click();
      if (await waitForStableSetting(() => {
        const current = radio(name);
        return radioEnabled(current) && current.getAttribute('aria-checked') === 'true';
      }, project)) return;
    }
    throw new Error(!offered ? 'Flow does not offer ' + name + ' in the current settings. Nothing was submitted.' :
      'Flow did not keep ' + name + ' selected after retrying. Nothing was submitted.');
  }
  async function configureVideoSettings(job, project) {
    const choices = ['Video', 'Frames', '9:16', 'x1', '720p', job.seconds + 's'];
    // Recheck the complete combination: a later setting can reset an earlier one.
    for (let pass = 0; pass < 2; pass++) {
      await setSettingsOpen(true, project);
      for (const name of choices) await setRadio(name, project);
      if (!await waitForStableSetting(() => choices.every(name => {
        const current = radio(name);
        return radioEnabled(current) && current.getAttribute('aria-checked') === 'true';
      }), project)) continue;
      await setSettingsOpen(false, project);
      if (await waitForStableSetting(() => {
        const text = appButton('Settings trigger')?.textContent || '';
        return /\bVideo\b/.test(text) && /\b720p\b/.test(text) && new RegExp('\\b' + job.seconds + 's\\b').test(text);
      }, project)) return;
    }
    throw new Error('Flow changed the video settings while applying them. Nothing was submitted.');
  }
  function clickPermitted(project) { sameProject(project); }
  async function findFrameOption(frame, project) {
    const search = await waitFor(() => [...document.querySelectorAll('input')].find(el => !own(el) && visible(el) &&
      (el.getAttribute('aria-label') === 'Search assets' || el.getAttribute('placeholder') === 'Search assets')));
    if (!search) throw new Error('The frame picker search did not load. Close it and try this job again.');
    clickPermitted(project);
    search.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Could not enter the frame filename.');
    setter.call(search, frame);
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const option = await waitFor(() => {
      clickPermitted(project);
      const matches = [...document.querySelectorAll('[role="option"]')].filter(el => !own(el) && visible(el) && normalizeText(el.textContent) === frame);
      if (matches.length > 1) throw new Error('Multiple images are named ' + frame + '. Give the intended image a unique filename first.');
      return matches[0];
    }, 12000, 150);
    if (!option) throw new Error('No exact filename match for ' + frame + '. Upload that image to this project with the same filename.');
    clickPermitted(project);
    return option;
  }
  async function prepareJob(job, project) {
    clickPermitted(project);
    if (!isGrid()) throw new Error('Return to the project grid.');
    if (normalizeText(readEditorText(editor())) || appButton('Image ingredient')) throw new Error('The composer already contains a draft. Clear it in Flow, then select this scene and start again.');
    job.draftSignature = '';
    await configureVideoSettings(job, project);
    clickPermitted(project);
    const start = await waitButton('Start'); clickPermitted(project); start.click();
    const option = await findFrameOption(job.frame, project);
    clickPermitted(project); option.click(); await sleep(200);
    clickPermitted(project);
    const add = appButton('Add to prompt'); if (add) add.click();
    if (!await waitFor(() => { clickPermitted(project); return appButton('Image ingredient'); })) throw new Error('Frame was not attached.');
    if (!appButton('End')) throw new Error('Expected a start frame and an empty end frame.');
    clickPermitted(project);
    const input = editor(); if (!input) throw new Error('Prompt editor not found.');
    input.focus();
    // Native editing events keep Flow/ProseMirror state in sync. No innerHTML.
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range);
    if (!document.execCommand('insertText', false, job.prompt)) throw new Error('Browser could not insert the prompt.');
    if (!await waitFor(() => editorMatchesPrompt(editor(), job.prompt), 3000, 100)) throw new Error('The displayed prompt does not match the complete source. The draft was kept for inspection.');
    job.draftSignature = draftSignature();
    writeStorage();
    const settings = appButton('Settings trigger');
    if (!settings || !new RegExp('\\b' + job.seconds + 's\\b').test(settings.textContent) || !/720p/.test(settings.textContent)) throw new Error('Duration or resolution changed.');
    return readyGenerateButton(project);
  }
  function draftSignature() {
    const ingredient = appButton('Image ingredient'), input = editor();
    if (!ingredient || !input) return '';
    const sources = [...ingredient.querySelectorAll('img')].map(img => trustedMediaURL(img.currentSrc || img.src)).filter(Boolean);
    if (!sources.length) return ''; // A generic button label is not an image identity.
    return JSON.stringify([normalizeText(readEditorText(input)), sources.sort(), normalizeText(appButton('Settings trigger')?.textContent)]);
  }
  function ownsPreparedDraft(job) {
    return !!job?.draftSignature && job.draftSignature === draftSignature() && editorMatchesPrompt(editor(), job.prompt) && !!appButton('End');
  }
  function agentModeActive() {
    return appButtons().some(el => elementName(el) === 'Agent' && el.getAttribute('aria-pressed') === 'true');
  }
  async function readyGenerateButton(project) {
    const generate = await waitFor(() => {
      clickPermitted(project);
      const current = appButton('Start generation');
      return radioEnabled(current) ? current : null;
    }, 10000, 150);
    if (!generate) throw new Error('Flow is not ready to generate. Your prepared draft was kept.');
    return generate;
  }
  async function waitForComposerReset(job, project) {
    let clearedAt = 0;
    return !!await waitFor(() => {
      // After clicking, Pause stops subsequent jobs but still observes this one.
      if (projectIdentity(location.pathname) !== project) return false;
      const input = editor();
      const reset = input && !normalizeText(readEditorText(input)) && !appButton('Image ingredient') && !!appButton('Start');
      if (!reset) { clearedAt = 0; return false; }
      if (!clearedAt) clearedAt = Date.now();
      return Date.now() - clearedAt >= 400;
    }, 20000, 150);
  }
  async function runQueue() {
    if (busy()) { toast('Pause the current operation first.'); return; }
    if (!state.project || !isGrid()) { toast('Open the main Flow project workspace before starting.', true); return; }
    if (agentModeActive()) { toast('Turn off Agent in Flow to use the video scene queue, then click Start queue. No scenes were changed.', true); return; }
    const jobs = eligibleJobs(state.jobs, state.submissionHistory);
    const limit = Math.max(1, Math.min(100, +ui.limit.value || 5));
    const gap = Math.max(5, Math.min(300, +ui.gap.value || 5));
    if (!jobs.length) { toast('Select scenes that are ready or not sent. For another take of a sent scene, use Retry selected.'); return; }
    if ((normalizeText(readEditorText(editor())) || appButton('Image ingredient')) && !ownsPreparedDraft(jobs[0])) {
      toast('Flow contains a draft that is not the first selected scene’s verified prepared draft. Clear it in Flow before starting. No scenes were changed.', true); return;
    }
    const project = state.project, leaseKey = 'fs3:lease:' + project;
    const leaseOwner = Date.now() + ':' + Math.random().toString(36).slice(2);
    const existingLease = GM_getValue(leaseKey, null);
    if (existingLease && existingLease.expires > Date.now()) { toast('A queue is already running for this project in another tab.', true); return; }
    // Lock this tab synchronously too: rapid double clicks cannot start two loops.
    state.generating = true; state.stop = false; state.activeScene = 'Starting selected scenes…'; renderQueue();
    let sent = 0, processed = 0, stopReason = '', heartbeat;
    try {
      GM_setValue(leaseKey, { owner: leaseOwner, expires: Date.now() + 300000 });
      await sleep(180);
      if (GM_getValue(leaseKey, {})?.owner !== leaseOwner) throw new Error('Another tab started this queue. Nothing was submitted.');
      state.queueLease = { key: leaseKey, owner: leaseOwner };
      sameProject(project);
      heartbeat = setInterval(() => {
        try {
          if (GM_getValue(leaseKey, {})?.owner !== leaseOwner) { state.stop = true; return; }
          GM_setValue(leaseKey, { owner: leaseOwner, expires: Date.now() + 300000 });
        } catch (_) { state.stop = true; }
      }, 2000);
      const selected = jobs.slice(0, limit);
      for (const job of selected) {
        if (state.stop || projectIdentity(location.pathname) !== project) break;
        if (!queueable(job, state.submissionHistory)) continue;
        job.state = 'preparing'; job.note = '';
        state.activeScene = 'Preparing ' + sceneLabel(job, state.jobs.indexOf(job)) + ' · ' + (processed + 1) + ' of ' + selected.length;
        writeStorage(); renderQueue();
        let clicked = false, boundaryCreated = false, clickedAt = 0;
        try {
          const generate = ownsPreparedDraft(job) ? await readyGenerateButton(project) : await prepareJob(job, project);
          sameProject(project);
          if (!generate.isConnected || generate !== appButton('Start generation') || !radioEnabled(generate) || !editorMatchesPrompt(editor(), job.prompt))
            throw new Error('The prepared draft or Generate control changed. Nothing was sent.');
          // Persist the duplicate-prevention boundary BEFORE clicking Generate.
          clickedAt = Date.now();
          job.state = 'submitting'; job.lastAttemptAt = clickedAt;
          job.attemptBaseline = existingSceneResultKeys(job);
          state.submissionHistory[job.fingerprint] = { at: clickedAt, state: 'submitting', run: leaseOwner };
          boundaryCreated = true;
          writeStorage(true);
          sameProject(project);
          if (!generate.isConnected || generate !== appButton('Start generation') || !radioEnabled(generate) || !editorMatchesPrompt(editor(), job.prompt))
            throw new Error('The prepared draft or Generate control changed before submission. Nothing was sent.');
          clicked = true; generate.click();
          job.attemptCount = (job.attemptCount || 0) + 1;
          state.activeScene = 'Sent ' + job.id + ' · waiting for the composer'; renderQueue();
          const reset = await waitForComposerReset(job, project);
          if (!reset) throw new Error('Generate was clicked but the composer did not reset. Check Flow; this scene may already be rendering.');
          if (job.state !== 'completed') {
            job.state = 'submitted'; job.note = 'Sent to Flow. Waiting for a matching finished result; submission alone does not mean rendering succeeded.';
          }
          job.draftSignature = ''; job.selected = false;
          state.submissionHistory[job.fingerprint].state = job.state; sent++;
        } catch (e) {
          if (job.state !== 'completed') job.state = clicked ? 'uncertain' : 'blocked';
          job.note = e.message;
          if (clicked) {
            state.submissionHistory[job.fingerprint].state = job.state;
            job.selected = false;
          } else if (boundaryCreated) {
            // We know no click occurred in this live attempt. Do not leave a
            // phantom submission record that locks a scene after preparation.
            delete state.submissionHistory[job.fingerprint];
            job.lastAttemptAt = 0;
          }
          state.stop = true; stopReason = job.id + ': ' + e.message;
        }
        processed++; writeStorage(); renderQueue(); setProgress(processed, selected.length);
        if (state.stop) break;
        if (processed < selected.length) {
          const until = clickedAt + gap * 1000;
          state.activeScene = 'Next scene ' + selected[processed].id + ' · waiting for the minimum gap'; updateCounts();
          // The gap includes the time spent observing submission, and there is
          // no unnecessary delay after the last scene in a run.
          while (Date.now() < until && !state.stop) await sleep(Math.min(250, until - Date.now()));
        }
      }
    } catch (e) { stopReason = e.message; }
    finally {
      clearInterval(heartbeat);
      try { if (GM_getValue(leaseKey, {})?.owner === leaseOwner) GM_setValue(leaseKey, null); } catch (_) {}
      state.queueLease = null; state.generating = false; state.stop = false;
      state.activeScene = sent + ' sent this run.' + (stopReason ? ' Paused: ' + stopReason : ' Remaining ready scenes can be started next.');
      reconcileScenes(); writeStorage(); renderQueue(); renderLibrary(); scheduleOverlays();
      toast(state.activeScene, !!stopReason);
    }
  }
  async function importPack(file) {
    if (busy()) { toast('Pause before importing.'); return; }
    if (!state.project) { toast('Open a project first.', true); return; }
    if (!file || file.size > 2000000) { toast('Choose a prompt text file smaller than 2 MB.', true); return; }
    if (/\.zip$/i.test(file.name || '')) { toast('Unzip the pack first, then import the prompts .txt file inside it.', true); return; }
    if (/\.html?$/i.test(file.name || '')) { toast('Choose the prompts .txt file, not START-HERE.html.', true); return; }
    const project = state.project;
    const revision = state.promptImportRevision = (state.promptImportRevision || 0) + 1;
    try {
      const text = await file.text();
      if (revision !== state.promptImportRevision || project !== state.project) return;
      if (busy()) { toast('Pause the current operation, then import again.'); return; }
      const parsed = parsePrompts(text);
      const old = new Map(state.jobs.map(j => [j.fingerprint, j]));
      state.jobs = parsed.map(j => old.get(j.fingerprint) || { ...j, selected: true,
        state: state.submissionHistory[j.fingerprint] ? restoredSubmission(state.submissionHistory[j.fingerprint]) : j.needsDuration ? 'needs-duration' : 'ready',
        note: state.submissionHistory[j.fingerprint] ? 'Restored the saved submission status. Check results before requesting another take.' : '' });
      reconcileScenes(); writeStorage(); renderQueue(); updateCounts(); revealSceneList();
      const suggested = parsed.filter(j => j.durationSuggested).length;
      const missing = state.jobs.filter(j => j.state === 'needs-duration').length;
      toast(parsed.length + ' prompts imported.' + (missing ? ' Choose a duration for ' + missing + ' prompts below.' : suggested ? ' Review the suggested durations before Start queue.' : '') + ' Nothing has generated.');
    } catch (e) {
      if (revision === state.promptImportRevision && project === state.project) toast(e.message, true);
    }
  }
  function changeJobDuration(job, value) {
    if (busy() || !(queueable(job, state.submissionHistory) || job.state === 'needs-duration')) return;
    const seconds = +value;
    // A pack target is guidance, not a minimum generation duration.
    if (![4, 6, 8, 10].includes(seconds)) return;
    // Keep the imported fingerprint: changing a suggested slot must not bypass
    // submission history or make reimporting this same source job submit it again.
    job.seconds = seconds; job.durationSuggested = false; job.needsDuration = false; job.state = 'ready';
    writeStorage(); renderQueue(); updateCounts();
  }
  function setMissingDurations(value) {
    const seconds = +value;
    if (busy() || ![4, 6, 8, 10].includes(seconds)) return;
    for (const job of state.jobs.filter(j => j.state === 'needs-duration')) {
      job.seconds = seconds; job.needsDuration = false; job.durationSuggested = false; job.state = 'ready';
    }
    writeStorage(); renderQueue(); updateCounts();
  }
  function uncheckAllPrompts() {
    if (busy()) { toast('Pause the current operation before clearing prompt selections.'); return; }
    for (const job of state.jobs) job.selected = false;
    writeStorage(); renderQueue(); updateCounts();
    toast('All prompts unchecked. Queue progress kept.');
  }
  function clearImportedPrompts() {
    if (busy()) { toast('Pause the current operation before clearing imported prompts.'); return; }
    if (!state.project || projectIdentity(location.pathname) !== state.project) {
      toast('Wait for this project to finish loading, then clear its prompts.', true); return;
    }
    const lease = GM_getValue('fs3:lease:' + state.project, null);
    if (lease?.expires > Date.now()) {
      toast('Pause the generation queue in the other Flow tab before clearing prompts.', true); return;
    }
    if (!state.jobs.length) return;
    const previous = state.jobs;
    state.jobs = [];
    try { writeStorage(true); }
    catch (_) {
      state.jobs = previous;
      toast('Could not save the cleared list. Your imported prompts are still here.', true); return;
    }
    // A file read already in flight must not restore the pack after clearing it.
    state.promptImportRevision = (state.promptImportRevision || 0) + 1;
    ui.file.value = '';
    renderQueue(); updateCounts();
    toast('Imported prompts cleared. Import a .txt pack whenever you’re ready. Prior submissions are still remembered.');
  }
  function sceneResults(job) {
    return [...clips.values()].filter(r => r.sceneFingerprint === job.fingerprint && r.resultReady && !r.legacy);
  }
  function existingSceneResultKeys(job) {
    const prompt = normalizeText(job.prompt);
    return [...new Set([...clips.values()].filter(r => normalizeText(r.prompt) === prompt)
      .flatMap(r => [r.key, ...(r.mediaTokens || [])]))];
  }
  function reconcileScenes() {
    if (!state.writable || !state.jobs.length) return false;
    let changed = false;
    const records = [...clips.values()], counts = new Map(), byPrompt = new Map();
    for (const job of state.jobs) {
      const prompt = normalizeText(job.prompt); counts.set(prompt, (counts.get(prompt) || 0) + 1);
    }
    for (const rec of records) if (rec.resultReady && rec.prompt) {
      const prompt = normalizeText(rec.prompt);
      if (!byPrompt.has(prompt)) byPrompt.set(prompt, []);
      byPrompt.get(prompt).push(rec);
    }
    for (const job of state.jobs) {
      const prompt = normalizeText(job.prompt);
      if (counts.get(prompt) !== 1) continue;
      const history = state.submissionHistory[job.fingerprint];
      const since = job.lastAttemptAt || (history?.source === 'manual-confirmation' ? 0 : history?.at) || 0;
      const results = sceneCandidates(job, [job], byPrompt.get(prompt) || [], since);
      for (const rec of results) {
        if (rec.sceneFingerprint && rec.sceneFingerprint !== job.fingerprint) continue;
        if (rec.sceneFingerprint !== job.fingerprint || rec.scriptId !== job.id) {
          rec.sceneFingerprint = job.fingerprint; rec.scriptId = job.id; changed = true;
        }
      }
      const linked = results.filter(r => r.sceneFingerprint === job.fingerprint);
      // A result can resolve an uncertain submission. Ready/retried scenes are
      // not silently removed from the user's next run because an old take exists.
      if (linked.length && /^(submitted|uncertain|submitting)$/.test(job.state)) {
        job.state = 'completed'; job.selected = false;
        job.note = 'Finished video matched by the complete prompt and duration. Use Show results to find it.';
        if (history) history.state = 'completed';
        changed = true;
      }
    }
    if (changed) { saveSoon(); renderQueue(); }
    return changed;
  }
  function retryScenes(jobs) {
    if (busy()) return;
    jobs = jobs.filter(j => !j.needsDuration && [4,6,8,10].includes(j.seconds));
    if (!jobs.length) { toast('Select scenes with a duration first.'); return; }
    const protectedJobs = jobs.filter(j => state.submissionHistory[j.fingerprint] || /^(submitted|uncertain|completed)$/.test(j.state));
    if (protectedJobs.length && !window.confirm('Queue another take for ' + protectedJobs.length + ' previously sent or uncertain scenes?\n\n' +
      protectedJobs.slice(0,20).map(j => j.id).join(', ') + (protectedJobs.length > 20 ? '…' : '') +
      '\n\nCheck Flow first: these may already exist or be rendering. Another take spends credits when you click Start queue. This button only queues them.')) return;
    for (const job of jobs) {
      const history = state.submissionHistory[job.fingerprint];
      if (history) job.pastAttempts = [...(job.pastAttempts || []), {...history}].slice(-30);
      delete state.submissionHistory[job.fingerprint];
      job.state = 'ready'; job.note = 'Queued for the next Start queue click.'; job.selected = true;
      // Exclude earlier takes from satisfying this newly requested attempt.
      job.lastAttemptAt = Date.now();
      job.attemptBaseline = existingSceneResultKeys(job);
    }
    state.activeScene = jobs.length + ' scenes ready. Click Start queue to generate.';
    writeStorage(); renderQueue(); updateCounts(); toast(state.activeScene);
  }
  function rearm(job) { retryScenes([job]); }
  function selectUnfinishedScenes() {
    if (busy()) return;
    for (const job of state.jobs) job.selected = job.state !== 'completed';
    writeStorage(); renderQueue();
    toast('Selected scenes without a confirmed result. Use Retry selected only for ones you want to send again.');
  }
  function showSceneResults(job) {
    if (busy()) return;
    state.sceneFilter = job.fingerprint; state.filter = ''; state.view = 'all';
    ui.librarySearch.value = ''; ui.libraryView.value = 'all';
    switchTab('library'); renderLibrary();
    toast(job.id + ': matched results. Change the library search or filter to show other clips.');
  }
  function exportSceneReport() {
    const rows = [['order','scene','status','starting_image','seconds','suggested_filename','matched_video_titles','media_ids','attempts','details','prompt']];
    state.jobs.forEach((job, index) => {
      const results = sceneResults(job);
      const filename = buildFileName({ pattern: namePattern(), prefix: saveCfg.prefix, folder: saveCfg.folder,
        order: job.position || index + 1, digits: state.jobs.length > 99 ? 3 : 2, id: job.id, outputName: job.outputName || '' });
      rows.push([job.position || index + 1, job.id, sceneStatus(job, state.submissionHistory), job.frame, job.seconds,
        filename, results.map(r => r.title).join(' | '), results.map(r => r.mediaId || r.key).join(' | '), job.attemptCount || '', job.note, job.prompt]);
    });
    const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], {type:'text/csv;charset=utf-8'}));
    const a = h('a', {href:url, download:'Flow-scenes-' + state.project + '.csv'});
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url),30000);
    toast('Scene list exported in edit order, with the file name each scene’s result will be saved as.');
  }
  function markAlreadySubmitted(job) {
    if (busy() || job.state === 'submitted') return;
    if (!window.confirm('Mark ' + job.id + ' as already submitted?\n\nUse this only when you have already generated this exact clip in Flow manually. This skips it in future queue runs and does not generate anything.')) return;
    job.state = 'submitted'; job.selected = false; job.note = 'Marked already submitted by you. Rendering/results are managed by Flow.';
    state.submissionHistory[job.fingerprint] = { at: Date.now(), state: 'submitted', source: 'manual-confirmation' };
    writeStorage(); renderQueue(); updateCounts();
  }
  async function copySelection() {
    const list = ordered().filter(r => r.selected);
    if (!list.length) { toast('Select clips first.'); return; }
    const names = namePlan(list);
    const text = list.map((r, i) => (r.scriptId || String(i + 1).padStart(3, '0')) + '\t' + (r.title || '') + '\t' + (r.savedAs || names.get(r.key) || '')).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Copied ' + list.length + ' selected clips with their file names.'); }
    catch (_) { toast('Clipboard unavailable. The selection is still saved.', true); }
  }

  function installStudioStyles() {
  GM_addStyle(`
    #fs-panel,#fs-fab,[data-fs-ui]{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box}
    #fs-panel{--fs-ink:#eeeef5;--fs-muted:#a2a2b7;--fs-line:#ffffff12;--fs-accent:#8200ff;--fs-mint:#c55cff;
      position:fixed;z-index:2147483500;right:22px;top:72px;width:392px;max-width:calc(100vw - 24px);height:min(760px,calc(100vh - 96px));
      display:flex;flex-direction:column;border:1px solid #ffffff20;border-radius:8px;overflow:hidden;color:var(--fs-ink);background:linear-gradient(155deg,#141115f5,#09080afc 32%);
      backdrop-filter:blur(24px);box-shadow:0 28px 90px #0009,0 1px 0 #ffffff0d inset;font-size:12px;line-height:1.45;color-scheme:dark}
    #fs-panel *{box-sizing:border-box}#fs-panel button,#fs-panel input,#fs-panel select{font:inherit}#fs-panel button{cursor:pointer}
    #fs-panel button:disabled{opacity:.38;cursor:not-allowed}#fs-panel button:focus-visible,#fs-panel input:focus-visible,#fs-panel select:focus-visible,[data-fs-ui]:focus-visible{outline:2px solid #c8b6ff;outline-offset:3px}
    .fs-head{display:flex;align-items:center;gap:10px;padding:17px 18px 14px;cursor:grab;user-select:none;flex:none}
    .fs-logo{width:35px;height:35px;display:grid;place-items:center;border-radius:5px;background:linear-gradient(145deg,#a242ff,#6a00c9);color:#0f0716;box-shadow:0 4px 22px #9724ff20;font-size:22px;font-weight:700}
    .fs-brand{font-size:15px;font-weight:650;letter-spacing:-.35px}.fs-eyebrow{font-size:9px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#897e94;margin-top:2px}
    .fs-head-actions{display:flex;gap:4px;margin-left:auto}.fs-icon{border:0;background:#ffffff06;color:#b2abb9;border-radius:8px;width:27px;height:27px;font-size:16px!important}
    .fs-icon:hover{background:#ffffff10;color:#fff}.fs-tabs{margin:0 18px 14px;background:#03020466;padding:4px;border-radius:11px;display:flex;gap:4px;flex:none}
    .fs-tab{flex:1;border:0;padding:8px;border-radius:8px;background:transparent;color:#91879b;font-weight:600!important}.fs-tab.active{background:#1a0d27;color:#dab4ff;box-shadow:0 2px 5px #0003}
    .fs-page{min-height:0;display:flex;flex-direction:column;flex:1}.fs-page[hidden]{display:none!important}
    /* Scroll the whole Scenes page: fixed controls must never collapse its cards. */
    #fs-panel .fs-create-page{overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#39274a transparent}
    #fs-panel .fs-create-page>*{flex-shrink:0}
    #fs-panel .fs-create-page>.fs-list{flex:none;overflow:visible}
    #fs-panel .fs-create-page>.fs-foot{max-height:none;overflow:visible}
    .fs-summary{display:flex;align-items:center;gap:8px;padding:0 18px 12px;color:var(--fs-muted)}.fs-count{font-size:26px;font-weight:650;line-height:1;letter-spacing:-1px;color:var(--fs-ink)}
    .fs-summary-label{font-size:11px;color:#a199a9}.fs-pill{margin-left:auto;border:1px solid #c55cff2b;background:#c55cff09;color:var(--fs-mint);border-radius:20px;padding:4px 9px;font-size:10px;white-space:nowrap}
    .fs-search-row{display:flex;gap:7px;padding:0 18px 10px}.fs-input,.fs-select{border:1px solid #ffffff15;border-radius:9px;background:#050306aa;color:#e2dce8;padding:9px;min-width:0}.fs-input::placeholder{color:#7a7183}
    .fs-input{flex:1}.fs-select{font-size:11px!important}.fs-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:0 18px 10px;flex:none}
    .fs-btn{border:1px solid #ffffff13;border-radius:8px;padding:6px 9px;background:#ffffff04;color:#c2b9cb;white-space:nowrap}.fs-btn:hover{background:#ffffff0b;border-color:#8200ff60;color:#f3e9ff}
    .fs-btn.active{background:#8200ff18;border-color:#8200ff60;color:#c996ff}.fs-link{border:0;background:transparent;color:#a952ff;padding:3px 0;font-size:10px!important;text-align:left}
    .fs-caption{padding:0 18px 10px;color:#8f8599;font-size:10px}.fs-section-line{display:flex;justify-content:space-between;align-items:center;padding:11px 18px 8px;border-top:1px solid var(--fs-line);color:#a99eb3;font-size:10px;letter-spacing:.7px;text-transform:uppercase}
    .fs-queue-summary{flex-wrap:wrap;gap:8px}.fs-prompt-actions{display:flex;flex-wrap:wrap;gap:5px;margin-left:auto}
    .fs-list{flex:1;min-height:0;overflow:auto;padding:0 10px 7px;scrollbar-width:thin;scrollbar-color:#39274a transparent;overscroll-behavior:contain}
    .fs-card{display:flex;align-items:center;gap:10px;border:1px solid transparent;border-radius:12px;padding:7px;margin:2px 0;position:relative;cursor:pointer;transition:background .15s,border-color .15s}
    .fs-card:hover{background:#ffffff06}.fs-card.selected{background:linear-gradient(100deg,#9522ff15,#9522ff06);border-color:#9522ff38}
    .fs-checkbox{accent-color:#8200ff;width:15px;height:15px;flex:none;margin:0;cursor:pointer}.fs-thumb{width:38px;height:56px;object-fit:cover;border-radius:7px;background:#140e1a;flex:none}
    .fs-meta{min-width:0;flex:1}.fs-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#e4deea;font-weight:550;font-size:11px}.fs-detail{margin-top:4px;display:flex;align-items:center;gap:6px;font-size:10px;color:#92879d;flex-wrap:wrap}
    .fs-id{color:#a177c9;font-variant-numeric:tabular-nums;font-size:10px}.fs-badge{font-size:9px;letter-spacing:.2px;border-radius:5px;padding:2px 5px;background:#ffffff06;color:#9f94a9}.fs-badge.good{color:#c55cff;background:#c55cff0c}.fs-badge.bad{color:#ff7a84;background:#ff7a8412}.fs-badge.warn{color:#f9ce67;background:#f9ce670d}
    .fs-empty{padding:30px 22px;text-align:center;color:#90869b;line-height:1.8}.fs-foot{flex:none;padding:12px 18px 14px;border-top:1px solid var(--fs-line);background:#08060966}
    .fs-settings{display:flex;gap:7px;margin-bottom:8px}.fs-settings input{width:0;font-size:11px!important;padding:7px 9px}.fs-primary{width:100%;padding:11px;border:1px solid #9e39ff55;border-radius:10px;background:linear-gradient(100deg,#9e39ff,#7c07e8);color:#110022;font-weight:700!important;box-shadow:0 3px 15px #8e12ff0e}
    .fs-primary:hover{filter:brightness(1.08)}.fs-secondary{width:100%;margin-top:7px;background:transparent;border:1px solid #ffffff16;border-radius:9px;padding:8px;color:#bcb0c8}
    .fs-small-note{font-size:9px;line-height:1.5;color:#9488a1;margin-top:7px}.fs-global-foot{flex:none;padding:0 18px 12px;background:#08060966}.fs-progress{height:2px;background:#ffffff08;border-radius:4px;overflow:hidden;margin-bottom:8px}.fs-progress i{display:block;height:100%;background:#8200ff;width:0;transition:width .3s}
    #fs-panel .fs-foot{max-height:48%;overflow:auto;overscroll-behavior:contain}
    #fs-panel .fs-foot>.fs-small-note:first-child{margin:0 0 8px;color:#d0b9e7;font-size:10px}
    #fs-panel .fs-foot .fs-toolbar{padding:8px 0 0}
    .fs-delivery-check{border:1px solid #e1bc4b66;background:#e1bc4b0c;padding:8px;margin-bottom:8px;border-radius:6px}
    .fs-delivery-check .fs-btn{margin:6px 4px 0 0}
    .fs-status-line{display:flex;align-items:start;gap:8px}.fs-status{flex:1;color:#a496b2;font-size:10px;line-height:1.55;max-height:45px;overflow:auto}.fs-status.error{color:#ff8892}.fs-stop{border:1px solid #e4b68b55;background:#e4b68b0b;border-radius:6px;color:#e4b68b;font-size:10px!important;padding:3px 7px}
    .fs-drop{margin:0 18px 10px;padding:16px 12px;border:1px dashed #8200ff55;background:linear-gradient(130deg,#8200ff0c,#8200ff02);border-radius:12px;text-align:center;color:#c7b0de;cursor:pointer}.fs-drop strong{display:block;font-size:12px;font-weight:600}.fs-drop span{display:block;font-size:10px;color:#907fa2;margin-top:4px}
    .fs-job{cursor:default;align-items:flex-start}.fs-job .fs-checkbox{margin-top:4px}.fs-job .fs-title{white-space:normal;line-height:1.5}.fs-job-note{font-size:10px;color:#cfad85;margin-top:5px}.fs-job-actions{margin-top:4px;display:flex;gap:10px}.fs-control-label{display:flex;flex:1;align-items:center;gap:7px;font-size:10px;color:#ab9fb8}.fs-control-label input{width:55px;flex:none;padding:7px}.fs-job-duration{display:flex;align-items:center;gap:8px;margin-top:7px;color:#ab9fb8;font-size:10px}.fs-job-duration .fs-select{padding:4px 7px}
    /* Idle UI is one small pill, independent of the draggable selection toolbar. */
    #fs-fab{position:fixed;z-index:2147483500;right:16px;bottom:max(10px,env(safe-area-inset-bottom,0px));display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;max-width:calc(100vw - 32px);margin:0;padding:0 13px;border:1px solid #b18bff55;border-radius:999px;background:#100b18f5;color:#dfcaff;box-shadow:0 3px 12px #0005;font:600 11px/1.2 system-ui;white-space:nowrap;cursor:pointer;touch-action:manipulation}
    #fs-fab::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:#a575f5}
    #fs-fab[data-running="true"]::before{background:#8ee8bb}
    #fs-fab:hover{background:#251633;border-color:#c5a3ff}
    #fs-fab:focus-visible{outline:2px solid #c5a3ff;outline-offset:3px}
    #fs-grid-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483400;overflow:hidden}
    .fs-grid-box{position:absolute;pointer-events:none;box-sizing:border-box;border:2px solid transparent;border-radius:16px}
    .fs-grid-box.selected{border-color:#8c16ff;box-shadow:inset 0 0 0 2px #0b0312,0 0 18px #8d10ff55}
    .fs-tile-check{position:absolute;top:7px;left:7px;width:30px;height:30px;padding:0;display:grid;place-items:center;pointer-events:auto;border:2px solid #bb90e6;border-radius:9px;background:#0a0411f2;color:#0f031a;cursor:pointer;font:800 19px/1 system-ui;box-shadow:0 2px 12px #0009;transition:background .16s,transform .16s}
    .fs-tile-check:hover{transform:scale(1.08);background:#32184b}.fs-tile-check.selected{background:#8f19ff;border-color:#cc98ff}
    .fs-row-check{position:absolute;left:7px;top:43px;max-width:calc(100% - 14px);min-height:28px;padding:4px 9px;pointer-events:auto;border:1px solid #9c36ffbb;border-radius:8px;background:#0b0411f5;color:#e1c2ff;font:600 11px/1.3 system-ui;white-space:nowrap;cursor:pointer;box-shadow:0 2px 12px #0008}
    .fs-row-check:hover{background:#29153d}.fs-row-check.selected{background:#8f19ff;color:#120023}.fs-row-check.mixed{border-color:#aa54ff;background:#2f114c}
    #fs-panel[hidden],#fs-fab[hidden],#fs-grid-layer button[hidden],#fs-pick-dock[hidden]{display:none!important}
    .fs-selection-bar{display:flex;align-items:center;gap:6px;padding:0 18px 12px;flex-wrap:wrap;flex:none}
    .fs-selection-count{margin-right:auto;color:#d6acff;font-size:11px;font-weight:650;white-space:nowrap}
    .fs-mode-group{display:flex;gap:3px;background:#03020466;padding:3px;border:1px solid #ffffff0d;border-radius:9px}
    .fs-mode{border:0;border-radius:6px;background:transparent;color:#a89cb4;padding:5px 8px;font:600 11px system-ui;cursor:pointer}
    .fs-mode.active{background:#9521ff26;color:#d8b2ff;box-shadow:inset 0 0 0 1px #8200ff55}
    .fs-pick-button{padding:6px 9px;border-radius:8px;border:1px solid #8200ff55;color:#d6abff;background:linear-gradient(100deg,#8f15ff18,#00eaff09);font-weight:600;white-space:nowrap}
    #fs-pick-dock{position:fixed;z-index:2147483500;bottom:18px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:9px 12px;max-width:calc(100vw - 24px);border:1px solid #8d16ff66;border-radius:6px;color:#dfc0ff;background:#08050bf5;box-shadow:0 10px 45px #0009;backdrop-filter:blur(22px);font:12px/1.4 system-ui;color-scheme:dark}
    #fs-pick-dock .fs-selection-count{min-width:70px}#fs-pick-dock .fs-btn{font:600 11px system-ui;cursor:pointer}
    #fs-panel[data-effect="rainbow"],#fs-panel[data-effect="still"],#fs-pick-dock[data-effect="rainbow"],#fs-pick-dock[data-effect="still"]{border-color:transparent;background:linear-gradient(155deg,#131015,#09080a 38%) padding-box,linear-gradient(110deg,#9c5cff,#d66eff,#ff78c8,#ffa980,#74dcff,#6b91ff,#9c5cff) border-box;background-size:100% 100%,400% 400%;border-width:2px;box-shadow:0 20px 70px #000b,-5px 0 22px #00eaff25,5px 0 22px #d900ff30,0 7px 24px #8700ff25}
    #fs-panel[data-effect="rainbow"],#fs-pick-dock[data-effect="rainbow"]{animation:fs-rainbow 6s linear infinite}
    #fs-panel[data-effect="rainbow"] .fs-logo,#fs-panel[data-effect="still"] .fs-logo{background:linear-gradient(120deg,#aa79ff,#78bdff,#df8cff,#ff8acb,#aa79ff);background-size:250% 250%;box-shadow:0 0 20px #8200ff50}
    #fs-panel[data-effect="rainbow"] .fs-logo{animation:fs-logo-shift 10s ease infinite}
    .fs-effect{font-size:15px!important}.fs-brand-version{color:#7a589b;font-size:9px;font-weight:500;margin-left:6px}
    @keyframes fs-rainbow{0%,100%{background-position:0 0,0% 50%}50%{background-position:0 0,100% 50%}}
    @keyframes fs-logo-shift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
    @media(max-width:560px){#fs-pick-dock{gap:5px;padding:8px}.fs-mode{padding:5px}.fs-selection-count{font-size:10px}}
    @media(prefers-reduced-motion:reduce){#fs-panel,#fs-panel *,#fs-pick-dock,#fs-grid-layer *{animation:none!important;transition:none!important}}

    /* Chroma chassis: black surfaces, sharp controls, purple controls, violet rainbow edges. */
    #fs-panel{--fs-ink:#efe9f5;--fs-muted:#978aa5;--fs-line:#9733ff18;border-radius:8px}
    #fs-panel .fs-head{border-bottom:1px solid #8200ff25;margin-bottom:12px;padding:15px 18px}
    .fs-brand{font:750 15px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:1px;text-transform:uppercase}
    .fs-brand-version{letter-spacing:0;font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:#836c9b}
    .fs-eyebrow{font-size:8px;letter-spacing:2px;color:#8a58bd}
    .fs-logo{font:800 15px/1 ui-monospace,Menlo,monospace;border-radius:4px!important;color:#0a0410}
    .fs-tabs,.fs-tab,.fs-mode-group,.fs-mode,.fs-input,.fs-select,.fs-btn,.fs-pick-button,.fs-primary,.fs-secondary,.fs-drop,.fs-card{border-radius:5px}
    .fs-primary{border-color:#bb79ff;background:linear-gradient(100deg,#9b34ff,#7f0be8);box-shadow:0 0 16px #8200ff25;text-transform:uppercase;letter-spacing:.7px;font-size:11px!important}
    .fs-primary:not(:disabled):hover{box-shadow:0 0 23px #8200ff50}
    .fs-mode.active,.fs-tab.active{color:#b46aff;background:#210b38;border-color:#8200ff80}
    .fs-selection-count{color:#ab5cff;font-variant-numeric:tabular-nums;letter-spacing:.3px}
    .fs-tile-check{border-radius:5px;border-color:#aa7ad8;background:#09050df5;color:#130024}
    .fs-tile-check.selected{background:#8d17ff;border-color:#c790ff;box-shadow:0 0 14px #8200ff60}
    .fs-row-check{border-radius:4px;border-color:#7f00ff77;letter-spacing:.3px}
    .fs-grid-box.selected{border-color:#880fff;box-shadow:inset 0 0 0 1px #0f0418,0 0 14px #8200ff40}
    #fs-pick-dock{border-radius:6px}
    #fs-panel[data-effect="off"],#fs-pick-dock[data-effect="off"]{background:#0b080d;border-color:#2f1d41;box-shadow:0 16px 50px #0009}
    #fs-panel button:focus-visible,#fs-panel input:focus-visible,#fs-panel select:focus-visible,#fs-grid-layer button:focus-visible,#fs-pick-dock button:focus-visible{outline:2px solid #9f3bff;outline-offset:3px}

    /* Violet accent finish; amber and red retain their status meanings. */
    #fs-panel{--fs-accent:#b18bff;--fs-mint:#c3a5ff;--fs-ink:#f3edff;--fs-muted:#b0a1c5;--fs-line:#b18bff22}
    .fs-primary{background:linear-gradient(110deg,#8547df,#6131b7);color:#fffaff;border-color:#c19aff;box-shadow:0 0 18px #a065ff38}
    .fs-primary:not(:disabled):hover{box-shadow:0 0 25px #b18bff66}
    .fs-tab.active,.fs-mode.active{background:#30204d;color:#dfcaff;border-color:#a677ef}
    .fs-selection-count,.fs-link{color:#c5a3ff}.fs-checkbox{accent-color:#a575f5}
    .fs-tile-check.selected,.fs-row-check.selected{background:#b18bff;border-color:#e2d0ff;color:#1b0e30;box-shadow:0 0 14px #ad78ff66}
    .fs-grid-box.selected{border-color:#b18bff;box-shadow:inset 0 0 0 2px #170d26,0 0 18px #a76eff55}
    #fs-pick-dock{width:max-content;max-width:calc(100vw - 16px);flex-wrap:wrap;cursor:grab;touch-action:none;user-select:none}
    .fs-dock-grip{display:grid;place-items:center;flex:none;width:26px;height:30px;border:1px solid #b18bff35;border-radius:4px;background:#a46aff12;color:#c7a7ff;cursor:grab;font:23px/1 system-ui;touch-action:none}
    .fs-dock-grip:hover{background:#a46aff2e;color:#f4eaff}
    #fs-pick-dock[data-dragging="true"],#fs-pick-dock[data-dragging="true"] .fs-dock-grip{cursor:grabbing}
    #fs-panel .fs-toolbar[hidden],#fs-grid-layer[hidden]{display:none!important}
    .fs-scene-preview{color:#ccc0dc;font-size:11px;line-height:1.5;margin:5px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .fs-scene-prompt{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 system-ui;color:#d9cde5;max-height:180px;overflow:auto}
    .fs-scene-details{margin-top:6px;font-size:10px;color:#bfa7db}.fs-scene-details summary{cursor:pointer}
    .fs-job-actions{flex-wrap:wrap}.fs-job .fs-id{font-size:12px;font-weight:650;color:#d2b6ff}
    .fs-job .fs-thumb{width:48px;height:72px}.fs-job .fs-title{overflow-wrap:anywhere;font-size:10px;color:#a596b7}
    #fs-panel .fs-scene-frame{width:48px;height:72px;flex:none;overflow:hidden;border-radius:7px;background:#140e1a}
    #fs-panel .fs-frame-missing{width:100%;height:100%;display:grid;place-items:center;padding:4px;text-align:center;font-size:9px;line-height:1.25;color:var(--fs-muted);overflow-wrap:anywhere}
    #fs-panel .fs-scene-frame [hidden]{display:none!important}
    #fs-panel[data-running="true"]{animation:none!important}
    #fs-panel[data-running="true"] .fs-logo{animation:none!important}
    #fs-pick-dock button:disabled{opacity:.4;cursor:not-allowed}
    #fs-panel .fs-foot button[hidden]{display:none!important}
    #fs-panel .fs-foot .fs-toolbar .fs-btn{padding:5px 8px;font-size:11px!important}

    /* 3.7: save settings, file names on cards, saved state. */
    .fs-save{margin:0 0 10px;border:1px solid #b18bff2e;border-radius:6px;background:#0e0a15cc}
    .fs-save>summary{list-style:none;display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;user-select:none}
    .fs-save>summary::-webkit-details-marker{display:none}
    .fs-save>summary:hover{background:#ffffff06}
    .fs-save-label{flex:none;font:700 9px/1 system-ui;letter-spacing:1px;text-transform:uppercase;color:#a98bd6}
    .fs-save-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f1e8ff}
    .fs-save-edit{flex:none;font-size:10px;color:#b18bff}.fs-save-edit::after{content:"Edit"}.fs-save[open] .fs-save-edit::after{content:"Done"}
    .fs-save-body{display:grid;gap:8px;padding:2px 10px 10px}
    .fs-row2{display:grid;grid-template-columns:1fr 1fr;gap:7px}
    .fs-field{display:grid;gap:4px;min-width:0;font:600 9px/1.2 system-ui;letter-spacing:.6px;text-transform:uppercase;color:#9a8bb0}
    .fs-field[hidden]{display:none!important}
    .fs-field .fs-input,.fs-field .fs-select{width:100%;padding:7px 8px;font:11px/1.2 system-ui!important;text-transform:none;letter-spacing:0}
    .fs-field .fs-input:disabled,.fs-field .fs-select:disabled{opacity:.45}
    .fs-seg{display:flex;gap:3px;padding:3px;border:1px solid #ffffff0d;border-radius:6px;background:#03020466}
    .fs-seg .fs-mode{flex:1}
    .fs-hint{font-size:9.5px;line-height:1.5;color:#8f81a3}
    .fs-hint.fs-warn{color:#f0c96a}.fs-hint[hidden]{display:none!important}
    .fs-file{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c7adf0}
    .fs-file[hidden]{display:none!important}
    .fs-file.saved{color:#86e3b6}.fs-file.menu{color:#d9b56a;font-family:system-ui}
    .fs-badge.saved{color:#86e3b6;background:#86e3b612}
    .fs-card.selected .fs-file:not(.saved):not(.menu){color:#e2d0ff}
    #fs-fab{font-variant-numeric:tabular-nums}
  `);

  }
  const libraryCards = new Map();
  let libraryProject = '', libraryOrder = '';
  function renderLibrary() {
    if (!ui.list) return;
    if (libraryProject !== state.project) { libraryCards.clear(); libraryOrder = ''; libraryProject = state.project; }
    // Keep existing cards and thumbnails mounted. Updating one status must not
    // rebuild hundreds of rows, restart image loads, or lose checkbox focus.
    const records = filtered(), all = ordered(), ranks = new Map(all.map((rec,i) => [rec.key,i+1]));
    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
    // File names shown on cards match what Download will use: queued items keep their
    // batch number; new selections are numbered after the saved queue.
    const batchItems = new Map((state.downloadBatch?.items || []).map(item => [item.key, item]));
    const waiting = batchItems.size && pendingDownloadBatch();
    const fresh = newDownloadCandidates(all).filter(r => !(waiting && batchItems.has(r.key)));
    const freshOrder = planOrder(fresh, waiting ? state.downloadBatch.items.length : 0), freshKeys = new Set(fresh.map(r => r.key));
    const fileLabel = rec => {
      if (rec.kind === 'image' || rec.legacy) return null;
      if (rec.savedAs && rec.downloadState === 'downloaded') return { cls: 'saved', text: '✓ ' + rec.savedAs.split('/').pop(), title: 'Saved as Downloads/' + rec.savedAs };
      const item = batchItems.get(rec.key), queued = item && /^(pending|locating|issuing)$/.test(item.state);
      if (!queued && !freshKeys.has(rec.key)) return null;
      if (!directLink(rec)) return { cls: 'menu', text: '→ Flow menu · Flow names this file', title: 'No original link captured yet. Scroll past this clip in Flow to capture it, or it downloads through Flow’s menu.' };
      const name = queued ? plannedName(rec, item.order || 1, item.digits || 2) : plannedName(rec, freshOrder.get(rec.key) || 1, freshOrder.digits);
      return { cls: '', text: '→ ' + name.split('/').pop(), title: 'Will save as Downloads/' + name };
    };
    for (const rec of records) {
      let entry = libraryCards.get(rec.key);
      if (!entry) {
        const check = h('input', { type: 'checkbox', class: 'fs-checkbox' });
        const image = h('img', { class: 'fs-thumb', loading: 'lazy', alt: '' });
        const title = h('div', { class: 'fs-title' }), detail = h('div', { class: 'fs-detail' });
        const id = h('span', { class: 'fs-id' }), duration = h('span'), badge = h('span', {class:'fs-badge'});
        detail.append(id, duration, badge);
        const file = h('div', { class: 'fs-file', hidden: '' });
        const card = h('div', { class: 'fs-card' }, check, image, h('div', { class: 'fs-meta' }, title, detail, file));
        if (rec.legacy) card.append(btn('Link to video', e => { e.stopPropagation(); beginRelink(rec.key); }, 'fs-link'));
        card.addEventListener('click', e => { if (e.target !== check) selectClip(rec.key, e.shiftKey); });
        check.addEventListener('click', e => { e.stopPropagation(); selectClip(rec.key, e.shiftKey); });
        entry = { card, check, image, title, id, duration, badge, file }; libraryCards.set(rec.key, entry);
      }
      const { card, check, image, title, id, duration, badge, file } = entry;
      const planned = fileLabel(rec);
      file.hidden = !planned;
      if (planned) { setText(file, planned.text); file.className = 'fs-file ' + planned.cls; file.title = planned.title; }
      check.checked = !!rec.selected; check.disabled = busy() || rec.kind === 'image' || !!rec.legacy || (rec.key.startsWith('tile:') && !sessionTiles.has(rec.key));
      check.setAttribute('aria-label', 'Select ' + (rec.scriptId || rec.title || 'clip'));
      card.classList.toggle('selected', !!rec.selected);
      card.title = rec.note || rec.prompt || rec.title;
      const safePoster = trustedMediaURL(rec.poster);
      if (safePoster && image.getAttribute('src') !== safePoster) image.src = safePoster;
      else if (!safePoster) image.removeAttribute('src');
      setText(title, rec.title || rec.scriptId || 'Untitled clip');
      setText(id, rec.scriptId || '#' + String(ranks.get(rec.key)).padStart(3,'0'));
      setText(duration, rec.kind === 'image' ? 'Image' : rec.duration ? Math.round(rec.duration) + 's' : '');
      const labels = { requested: 'Sent to Chrome', downloaded: rec.savedAs ? 'Saved' : 'Confirmed', uncertain: 'Check file', locating: 'Finding video', issuing: 'Saving…', pending: 'Pending', skipped: 'Skipped', failed: 'Failed' };
      setText(badge, (rec.kind === 'image' ? 'Detected · use Flow menu' : rec.legacy ? 'Old pick · not linked' : labels[rec.downloadState]) || (rec.captureState === 'captured' ? 'Captured' : 'Needs capture'));
      badge.className = 'fs-badge ' + (rec.downloadState === 'failed' ? 'bad' : rec.downloadState === 'downloaded' ? 'saved' : /^(requested|uncertain)$/.test(rec.downloadState) || (!rec.downloadState && rec.captureState !== 'captured') ? 'warn' : 'good');
    }
    const order = records.map(r => r.key).join('|');
    if (order !== libraryOrder || !ui.list.childNodes.length) {
      const scroll = ui.list.scrollTop;
      ui.list.replaceChildren(...records.map(rec => libraryCards.get(rec.key).card));
      if (!records.length) ui.list.append(h('div', { class: 'fs-empty', text: clips.size ? 'No clips match this view.' : 'Select videos on the grid to capture them.\nFull-project scanning is optional.' }));
      ui.list.scrollTop = scroll; libraryOrder = order;
    }
    updateCounts();
  }
  function sceneFramePreview(job, poster) {
    const preview = h('div', { class: 'fs-scene-frame' });
    const missing = h('span', { class: 'fs-frame-missing', role: 'img',
      'aria-label': 'Starting frame preview unavailable for ' + job.frame,
      title: 'Starting frame: ' + job.frame + '. Open Flow’s Images view or use Scan from top in Library to refresh previews.',
      text: 'Frame preview unavailable' });
    preview.append(missing);
    if (poster) {
      const image = h('img', { class: 'fs-thumb', loading: 'lazy', alt: 'Starting frame: ' + job.frame });
      image.addEventListener('load', () => { missing.hidden = true; image.hidden = false; });
      image.addEventListener('error', () => { image.hidden = true; missing.hidden = false; });
      // Register handlers before assigning src, including for cached images.
      image.src = poster; missing.hidden = true; preview.append(image);
    }
    return preview;
  }
  const sceneCards = new Map();
  function renderQueue() {
    if (!ui.queueList) return;
    const scroll = ui.queueList.scrollTop, locked = busy();
    const search = (ui.sceneSearch?.value || '').trim().toLowerCase();
    const view = ui.sceneView?.value || 'all';
    const shown = state.jobs.filter(job => (!search || [job.id,job.frame,job.prompt].join(' ').toLowerCase().includes(search)) &&
      (view !== 'unfinished' || job.state !== 'completed') &&
      (view !== 'ready' || queueable(job, state.submissionHistory)) &&
      (view !== 'check' || /^(blocked|uncertain)$/.test(job.state)) &&
      (view !== 'completed' || job.state === 'completed'));
    const records = [...clips.values()];
    const cards = shown.map(job => {
      const results = sceneResults(job);
      const poster = sceneFramePoster(job, records);
      const index = state.jobs.indexOf(job);
      const signature = JSON.stringify([job.id,job.frame,job.prompt,job.position,index,job.seconds,job.state,job.note,job.selected,job.durationSuggested,
        locked,poster,results.map(r=>r.key),!!state.submissionHistory[job.fingerprint]]);
      const old = sceneCards.get(job.fingerprint);
      if (old?.job === job && old.signature === signature) return old.card;
      const check = h('input', {type:'checkbox',class:'fs-checkbox','aria-label':'Select scene ' + job.id});
      // Selecting a scene is separate from authorizing a second submission.
      check.checked = !!job.selected; check.disabled = locked;
      check.addEventListener('change', () => { if (busy()) return; job.selected = check.checked; saveSoon(); updateCounts(); });
      const meta = h('div', {class:'fs-meta'}, h('div',{class:'fs-detail'},
        h('span',{class:'fs-id',text:sceneLabel(job,index)}),
        h('span',{class:'fs-badge ' + (job.state === 'completed' ? 'good' : /blocked|uncertain/.test(job.state) ? 'warn' : ''), text:sceneStatus(job,state.submissionHistory)})),
        h('div',{class:'fs-scene-preview',text:normalizeText(job.prompt)}),
        h('div',{class:'fs-title',text:job.frame}),
        h('div',{class:'fs-detail',text:job.seconds ? job.seconds + ' seconds · vertical · one output' : 'Choose a duration'}));
      const details = h('details',{class:'fs-scene-details'},h('summary',{text:'Full prompt'}),h('div',{class:'fs-scene-prompt',text:job.prompt}));
      details.open = !!old?.card.querySelector('details')?.open; meta.append(details);
      if (job.planningSeconds) meta.append(h('div',{class:'fs-job-note',
        text:'Pack target: ' + job.planningSeconds + 's · your choice: ' + job.seconds + 's' +
          (job.seconds < job.planningSeconds ? ' · shorter than pack target' : '')}));
      {
        const duration = h('select',{class:'fs-select','aria-label':'Generation duration for ' + job.id});
        if (!job.seconds) duration.append(h('option',{value:0,text:'Choose duration…',disabled:''}));
        for (const seconds of [4,6,8,10]) duration.append(h('option',{value:seconds,text:seconds + ' seconds'}));
        duration.value = String(job.seconds); duration.disabled = locked || !(queueable(job,state.submissionHistory) || job.state === 'needs-duration');
        duration.addEventListener('change',()=>changeJobDuration(job,duration.value));
        meta.append(h('label',{class:'fs-job-duration'},'Generation duration',duration));
      }
      if (job.note) meta.append(h('div',{class:'fs-job-note',text:job.note}));
      const actions = h('div',{class:'fs-job-actions'});
      const action = (label, fn) => { const button = btn(label,fn,'fs-link'); button.disabled = locked; actions.append(button); };
      if (results.length) action('Show results (' + results.length + ')',()=>showSceneResults(job));
      if (/^(blocked|submitted|uncertain|completed)$/.test(job.state)) action(queueable(job,state.submissionHistory) ? 'Queue again' : 'Retry / another take',()=>rearm(job));
      if (/^(ready|blocked|uncertain)$/.test(job.state)) action('Mark as sent',()=>markAlreadySubmitted(job));
      meta.append(actions);
      const card = h('div',{class:'fs-card fs-job'},check);
      card.append(sceneFramePreview(job, poster));
      card.append(meta); sceneCards.set(job.fingerprint,{job,signature,card});
      return card;
    });
    for (const key of sceneCards.keys()) if (!state.jobs.some(j=>j.fingerprint === key)) sceneCards.delete(key);
    // Keep unchanged nodes attached, including focused inputs and open prompts.
    cards.forEach((card,index)=>{ if (ui.queueList.children[index] !== card) ui.queueList.insertBefore(card,ui.queueList.children[index] || null); });
    while (ui.queueList.children.length > cards.length) ui.queueList.lastElementChild.remove();
    if (!cards.length) ui.queueList.append(h('div',{class:'fs-empty',text:state.jobs.length ? 'No scenes match this view.' : 'Upload base images to Flow, then import your prompts .txt file.'}));
    ui.queueList.scrollTop = scroll; updateCounts();
  }

  function updateCounts() {
    if (!ui.count) return;
    const all = [...clips.values()];
    const selected = all.filter(r => !r.legacy && r.selected).length;
    const oldPicks = all.filter(r => r.legacy && r.selected).length;
    // Measuring every tile is only worth it while the panel is open to show the number.
    const shown = ui.panel.hidden ? 0 : visibleGridItems().filter(i => clips.get(i.key)?.selected).length;
    const tileOnly = all.filter(r => r.key.startsWith('tile:') && sessionTiles.has(r.key)).length;
    if (ui.identityStatus) ui.identityStatus.textContent = !state.writable ? 'Read-only: another tab owns this project, or the browser lock is unavailable.' :
      selected + ' selected · ' + shown + ' visible' + (tileOnly ? ' · ' + tileOnly + ' use visible-tile identity (reselect after reload)' : '') +
      (!state.mediaReady ? ' · Permanent IDs not received; visible video scanning is available.' : '') + (oldPicks ? ' · ' + oldPicks + ' old picks need relinking' : '');
    if (ui.enableTab) ui.enableTab.hidden = state.writable;
    ui.count.textContent = selected;
    ui.selectionCount.textContent = selected + ' selected';
    ui.dockCount.textContent = selected + ' selected';
    for (const button of ui.uncheckButtons || []) {
      button.disabled = busy() || !(selected + oldPicks);
      button.title = busy() ? 'Pause before clearing selections' : 'Uncheck every video in this project, including off-screen and old picks. Keeps download history.';
    }
    ui.total.textContent = 'selected / ' + all.filter(r => !r.legacy).length + ' videos';
    ui.listCount.textContent = filtered().length + ' items';
    const pending = batchCounts(state.downloadBatch).pending;
    const eligible = newDownloadCandidates(all).length;
    const checking = state.downloadBatch?.phase === 'awaiting-check';
    ui.download.textContent = pending ? '▶  Resume · ' + pending + ' remaining' : '↓  Download ' + eligible + ' new selected';
    ui.download.disabled = busy() || checking || (!pending && !eligible) || !state.project;
    ui.deliveryCheck.hidden = !checking;
    ui.batchStatus.textContent = downloadSummary();
    ui.addToBatch.hidden = !pending;
    ui.addToBatch.disabled = busy();
    const missingSelected = all.some(r => !r.legacy && r.selected && /^(failed|requested|uncertain)$/.test(r.downloadState));
    ui.missing.disabled = busy() || !missingSelected; ui.missing.hidden = !missingSelected;
    const c = batchCounts(state.downloadBatch); if (!state.generating && !state.scanning) setProgress(c.total - c.pending - c.active, c.total);
    const failures = retryDownloads(all).length;
    ui.retry.textContent = '↻  Retry failed downloads' + (failures ? ' · ' + failures : '');
    ui.retry.disabled = busy() || checking || !!pending || !failures; ui.retry.hidden = !failures;
    ui.scan.disabled = busy(); ui.baseline.disabled = busy(); ui.freshScan.disabled = busy();
    ui.scan.textContent = state.scanCursor?.phase === 'paused' ? 'Resume scan' : 'Scan all (optional)';
    ui.stop.hidden = !running();
    ui.gridLayer.hidden = state.generating || !ui.fab.hidden;
    ui.fab.dataset.running = String(running());
    const fabText = state.downloading ? 'Saving ' + (c.total - c.pending - c.active) + ' / ' + c.total + '  ↑'
      : state.generating ? 'Scene queue running  ↑' : state.scanning ? 'Scanning grid  ↑'
      : 'Flow Studio' + (selected ? ' · ' + selected + ' selected' : '') + '  ↑';
    if (ui.fab.textContent !== fabText) ui.fab.textContent = fabText;
    ui.fab.title = (running() ? 'Queue or scan active · ' : '') + 'Open Flow Studio · Alt+D';
    ui.panel.dataset.running = String(state.generating);
    ui.jobsCount.textContent = state.jobs.filter(j => j.state === 'completed').length + ' results · ' + eligibleJobs(state.jobs, state.submissionHistory).length + ' selected to run / ' + state.jobs.length;
    if (ui.queueRetry) ui.queueRetry.disabled = busy() || !state.jobs.some(j => j.selected && !j.needsDuration);
    if (ui.queueSelect) ui.queueSelect.disabled = busy() || !state.jobs.length;
    if (ui.queueResults) ui.queueResults.disabled = busy() || !state.jobs.length;
    updateSavePreview();
    if (ui.sceneSummary) ui.sceneSummary.textContent = state.activeScene || 'Select scenes to run. Sent scenes stay protected until you choose Retry selected.';
    if (ui.queueUncheck) ui.queueUncheck.disabled = busy() || !state.jobs.some(j => j.selected);
    if (ui.queueClear) ui.queueClear.disabled = busy() || !state.jobs.length;
    if (ui.missingDurationsWrap) {
      ui.missingDurationsWrap.hidden = !state.jobs.some(j => j.state === 'needs-duration');
      ui.missingDurations.disabled = busy();
    }
    ui.generate.disabled = busy() || !eligibleJobs(state.jobs, state.submissionHistory).length || !state.project;
    ui.generate.textContent = '▶  Start queue · up to ' + Math.min(eligibleJobs(state.jobs, state.submissionHistory).length, +ui.limit.value || 5) + ' clips';
    ui.importButton.disabled = busy();
    ui.limit.disabled = busy(); ui.gap.disabled = busy();
    ui.project.textContent = state.project ? (state.writable ? 'PROJECT SAVED' : 'READ ONLY') : 'OPEN A PROJECT';
  }
  function revealSceneList() {
    if (!state.jobs.length || !ui.create || ui.create.hidden || !ui.queueList) return;
    // Only scroll our panel; leave Flow's project grid and the page in place.
    const page = ui.create.getBoundingClientRect(), list = ui.queueList.getBoundingClientRect();
    ui.create.scrollTop += list.top - page.top - ui.create.clientTop;
  }
  function switchTab(name) {
    state.tab = name; ui.library.hidden = name !== 'library'; ui.create.hidden = name !== 'create';
    ui.libraryTab.classList.toggle('active', name === 'library'); ui.createTab.classList.toggle('active', name === 'create');
    ui.libraryTab.setAttribute('aria-selected', String(name === 'library')); ui.createTab.setAttribute('aria-selected', String(name === 'create'));
    if (name === 'create' && !ui.create.scrollTop) revealSceneList();
  }
  function setRowMode(enabled) {
    state.rowPicker = !!enabled; GM_setValue('fs3:rows', state.rowPicker);
    for (const pair of ui.modeButtons) pair.forEach((button, index) => {
      const active = state.rowPicker === !!index;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    scheduleOverlays();
  }
  function modePicker() {
    const singles = btn('Singles', () => setRowMode(false), 'fs-mode', 'Show individual clip checkboxes');
    const rows = btn('Singles + rows', () => setRowMode(true), 'fs-mode', 'Add row selection while keeping every single checkbox');
    ui.modeButtons.push([singles, rows]);
    return h('div', { class: 'fs-mode-group', role: 'group', 'aria-label': 'Selection mode' }, singles, rows);
  }
  function applyEffect() {
    if (!['rainbow', 'still', 'off'].includes(state.effect)) state.effect = 'rainbow';
    ui.panel.dataset.effect = state.effect; ui.dock.dataset.effect = state.effect;
    const labels = { rainbow: 'Purple rainbow', still: 'Static violet spectrum', off: 'Glow off' };
    ui.effect.title = labels[state.effect] + ' · click to change';
    ui.effect.setAttribute('aria-label', ui.effect.title);
    ui.effect.textContent = state.effect === 'off' ? '◇' : '✦';
  }
  function buildSavePanel() {
    const field = (label, control) => h('label', { class: 'fs-field' }, h('span', { text: label }), control);
    ui.folder = h('input', { class: 'fs-input', placeholder: 'e.g. Flow/{date}', 'aria-label': 'Download subfolder' });
    ui.prefix = h('input', { class: 'fs-input', placeholder: 'optional, e.g. JIYU', 'aria-label': 'Filename prefix' });
    ui.folder.value = saveCfg.folder; ui.prefix.value = saveCfg.prefix;
    ui.namePreset = h('select', { class: 'fs-select', 'aria-label': 'File name pattern' },
      ...[['order_id', 'Order + ID · 03_JAY-03'], ['id', 'ID only · JAY-03'], ['order_id_title', 'Order + ID + title'],
        ['order_title', 'Order + title'], ['custom', 'Custom pattern…']].map(([value, text]) => h('option', { value, text })));
    ui.namePreset.value = saveCfg.preset;
    ui.nameCustom = h('input', { class: 'fs-input', placeholder: '{n}_{id}', 'aria-label': 'Custom file name pattern' });
    ui.nameCustom.value = saveCfg.custom;
    ui.parallel = h('select', { class: 'fs-select', 'aria-label': 'Files saved at once' },
      ...[1, 2, 3, 4].map(n => h('option', { value: n, text: n + ' at once' })));
    ui.parallel.value = String(saveCfg.parallel);
    const methodButton = (method, text, title) => {
      const b = btn(text, () => { if (busy()) return; GM_setValue('fs3:save-method', method); applySaveSettings(); }, 'fs-mode', title);
      b.dataset.method = method; return b;
    };
    ui.methodButtons = [methodButton('direct', 'Named files', 'Save each original with your folder and file name'),
      methodButton('menu', 'Flow menu', 'Click Flow’s own Download menu; Flow names the files')];
    const store = () => {
      GM_setValue('fbd_folder', ui.folder.value); GM_setValue('fbd_prefix', ui.prefix.value);
      GM_setValue('fs3:name-preset', ui.namePreset.value); GM_setValue('fs3:name-custom', ui.nameCustom.value || '{n}_{id}');
      GM_setValue('fs3:parallel', +ui.parallel.value || 3); applySaveSettings();
    };
    for (const el of [ui.folder, ui.prefix, ui.nameCustom]) el.addEventListener('input', store);
    for (const el of [ui.namePreset, ui.parallel]) el.addEventListener('change', store);
    ui.savePreview = h('span', { class: 'fs-save-preview' });
    ui.saveSetup = h('div', { class: 'fs-hint fs-warn', hidden: '' });
    ui.customWrap = field('Custom pattern', ui.nameCustom);
    const panel = h('details', { class: 'fs-save' },
      h('summary', {}, h('span', { class: 'fs-save-label', text: 'Save as' }), ui.savePreview, h('span', { class: 'fs-save-edit' })),
      h('div', { class: 'fs-save-body' },
        h('div', { class: 'fs-seg', role: 'group', 'aria-label': 'Save method' }, ...ui.methodButtons),
        h('div', { class: 'fs-row2' }, field('Subfolder', ui.folder), field('Prefix', ui.prefix)),
        h('div', { class: 'fs-row2' }, field('File names', ui.namePreset), field('Speed', ui.parallel)),
        ui.customWrap,
        h('div', { class: 'fs-hint', text: 'Tokens: {n} edit order · {id} scene or clip ID · {title} first words · {date} today. Scenes from an imported pack use their pack order and ID, or the pack’s SAVE RENDER AS name. Extra takes get _take2.' }),
        ui.saveSetup));
    panel.open = !!GM_getValue('fs3:save-open', false);
    panel.addEventListener('toggle', () => GM_setValue('fs3:save-open', panel.open));
    ui.savePanel = panel;
    return panel;
  }
  function applySaveSettings() {
    saveCfg = loadSaveSettings();
    updateSavePreview(); renderLibrary();
  }
  function updateSavePreview() {
    if (!ui.savePreview) return;
    const direct = saveCfg.method === 'direct', supported = typeof GM_download === 'function';
    for (const b of ui.methodButtons) {
      const active = b.dataset.method === saveCfg.method;
      b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); b.disabled = busy();
    }
    for (const el of [ui.folder, ui.prefix, ui.namePreset, ui.nameCustom, ui.parallel]) el.disabled = !direct || busy();
    ui.customWrap.hidden = saveCfg.preset !== 'custom';
    let sample = '';
    if (direct) {
      const next = newDownloadCandidates(ordered()).find(r => directLink(r));
      sample = next ? namePlan([next]).get(next.key) : buildFileName({ pattern: namePattern(), prefix: saveCfg.prefix,
        folder: saveCfg.folder, order: 3, id: 'JAY-03', title: 'applies toner pad' });
    }
    ui.savePreview.textContent = direct ? 'Downloads/' + sample : 'Flow menu · Flow names each file';
    ui.savePreview.title = ui.savePreview.textContent;
    ui.saveSetup.hidden = !direct || supported;
    ui.saveSetup.textContent = 'Named files need the GM_download permission. Paste the full 3.7 script (header included) into Tampermonkey and save, or use Flow menu.';
  }
  function selectSceneResults() {
    if (busy()) { toast('Pause the current operation first.'); return; }
    const keys = [...new Set(state.jobs.flatMap(job => sceneResults(job).map(r => r.key)))];
    if (!keys.length) { toast('No finished videos are matched to scenes yet. Results match by the full prompt and duration.'); return; }
    applySelection(keys, true);
    state.sceneFilter = ''; state.filter = ''; state.view = 'selected';
    ui.librarySearch.value = ''; ui.libraryView.value = 'selected';
    switchTab('library'); renderLibrary();
    toast('Selected ' + keys.length + ' scene results. Check the names below, then Download.');
  }
  function cleanStorage() {
    if (busy()) { toast('Pause the current operation first.'); return; }
    if (typeof GM_listValues !== 'function' || typeof GM_deleteValue !== 'function') { toast('Paste the full 3.7 script (header included) to enable cleanup.', true); return; }
    // Age comes from the last save. Projects saved by older versions get a first-seen
    // date now and only become removable 30 days later, so nothing recent is lost.
    const now = Date.now(), cutoff = now - 30 * 864e5, seen = GM_getValue('fs3:project-seen', {}) || {}, targets = [];
    for (const key of GM_listValues()) {
      const id = key.match(/^fs3:project:(.+)$/)?.[1];
      if (!id || id === state.project) continue;
      if (GM_getValue('fs3:lease:' + id, null)?.expires > now) continue;
      const last = GM_getValue(key, null)?.savedAt || seen[id] || (seen[id] = now);
      if (last < cutoff) targets.push(id);
    }
    GM_setValue('fs3:project-seen', seen);
    if (!targets.length) { toast('Nothing to clean. Only projects not opened for 30+ days are removed.'); return; }
    if (!confirm('Forget Flow Studio data for ' + targets.length + ' projects not opened in 30+ days?\n\nThis removes their selections, download history and scene submission history. If you reopen one, the scene queue will no longer know which scenes were already sent. This project is not touched.')) return;
    for (const id of targets) { for (const k of ['fs3:project:', 'fs3:before-stable-ids:', 'fs3:lease:']) GM_deleteValue(k + id); delete seen[id]; }
    GM_setValue('fs3:project-seen', seen);
    toast('Forgot ' + targets.length + ' old projects.');
  }
  function buildUI() {
    ui.modeButtons = []; ui.uncheckButtons = [];
    const uncheckButton = () => {
      const button = btn('Uncheck all', uncheckAllVideos, 'fs-btn', 'Uncheck every video in this project. Keeps download history.');
      ui.uncheckButtons.push(button); return button;
    };
    const head = h('div', { class: 'fs-head' }, h('div', { class: 'fs-logo', text: 'FS' }),
      h('div', {}, h('div', { class: 'fs-brand' }, 'Flow Studio', h('span', {class: 'fs-brand-version', text: '3.7.0'})), h('div', { class: 'fs-eyebrow', text: 'CHROMA / CONTROL DECK' })));
    ui.effect = btn('✦', () => {
      state.effect = { rainbow: 'still', still: 'off', off: 'rainbow' }[state.effect];
      GM_setValue('fs3:effect', state.effect); applyEffect();
      toast({rainbow:'Purple rainbow on.',still:'Static violet edge.',off:'Glow off.'}[state.effect]);
    }, 'fs-icon fs-effect');
    head.append(h('div', { class: 'fs-head-actions' }, ui.effect, btn('−', () => togglePanel(false), 'fs-icon', 'Minimize to bottom pill · Alt+D')));
    ui.libraryTab = btn('Library', () => switchTab('library'), 'fs-tab active'); ui.libraryTab.setAttribute('role', 'tab');
    ui.createTab = btn('Scenes · beta', () => switchTab('create'), 'fs-tab'); ui.createTab.setAttribute('role', 'tab');
    const tabs = h('div', { class: 'fs-tabs', role: 'tablist', 'aria-label': 'Flow Studio tools' }, ui.libraryTab, ui.createTab);
    ui.count = h('span', { class: 'fs-count', text: '0' }); ui.total = h('span', { class: 'fs-summary-label' });
    ui.selectionCount = h('span', { class: 'fs-selection-count', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const selectionBar = h('div', { class: 'fs-selection-bar' }, ui.selectionCount, modePicker(), uncheckButton());
    const search = h('input', { class: 'fs-input', placeholder: 'Search clips, prompts or IDs…', 'aria-label': 'Search clips' });
    ui.librarySearch = search;
    search.oninput = () => { state.sceneFilter = ''; state.filter = search.value.toLowerCase(); renderLibrary(); };
    const views = h('select', { class: 'fs-select', 'aria-label': 'Clip filter' }, ...[['all', 'All media'], ['videos', 'Videos'], ['images', 'Images'], ['legacy', 'Old picks — relink'], ['selected', 'Selected'], ['new', 'New'], ['failed', 'Failed downloads'], ['requested', 'Sent to Chrome'], ['uncertain', 'Needs checking'], ['downloaded', 'Confirmed saved']].map(([value, text]) => h('option', { value, text })));
    ui.libraryView = views;
    views.onchange = () => { state.sceneFilter = ''; state.view = views.value; renderLibrary(); };
    ui.scan = btn('Scan all (optional)', () => scanAll(state.scanCursor?.phase === 'paused' ? state.scanCursor.markBaseline : false)); ui.baseline = btn('Mark baseline', () => scanAll(true), 'fs-btn', 'Scan the currently displayed grid, then track newly discovered media. Clear Flow search/filter first for the whole project.');
    ui.freshScan = btn('Scan from top', () => scanAll(false, true), 'fs-btn', 'Start at the top to include new images and videos. Clear Flow search/filter first for the whole project.');
    ui.enableTab = btn('Enable this tab', () => { if (!running()) acquireWriter(); }, 'fs-btn', 'Close the other Flow Studio tab for this project, then enable this one.');
    const toolbar = h('div', { class: 'fs-toolbar' }, ui.enableTab, ui.scan, ui.freshScan, btn('All', () => applySelection(filtered().map(r => r.key), true)), btn('None', () => applySelection(filtered().map(r => r.key), false)), ui.baseline);
    toolbar.append(btn('Invert', () => {
      const records = filtered(), yes = records.filter(r => !r.selected).map(r => r.key), no = records.filter(r => r.selected).map(r => r.key);
      applySelection(yes, true); applySelection(no, false);
    }), btn('Copy list', copySelection));
    toolbar.append(btn('▦ Pick on grid', () => togglePanel(false, true), 'fs-pick-button', 'Show grid selection tools; minimize when finished'));
    const sort = h('select', { class: 'fs-select', 'aria-label': 'Sort clips' }, h('option', { value: 'script', text: 'Script order' }), h('option', { value: 'grid', text: 'Grid order' }));
    sort.onchange = () => { state.sort = sort.value; renderLibrary(); };
    ui.identityStatus = h('div', {class:'fs-caption',role:'status'});
    ui.listCount = h('span'); ui.project = h('span');
    ui.list = h('div', { class: 'fs-list', 'aria-label': 'Collected clips' });
    const savePanel = buildSavePanel();
    ui.download = btn('↓  Download selected', () => runDownloads(), 'fs-primary'); ui.retry = btn('↻  Retry failed downloads', () => runDownloads('failed'), 'fs-secondary');
    ui.batchStatus = h('div', { class: 'fs-small-note', role: 'status' });
    ui.addToBatch = btn('＋ Add newly selected to saved queue', addSelectedToBatch, 'fs-secondary');
    ui.missing = btn('Retry selected missing files', retrySelectedMissing, 'fs-btn', 'Only after checking Chrome Downloads; may duplicate files already saved.');
    ui.deliveryCheck = h('div', { class: 'fs-delivery-check', hidden: '' },
      h('div', { class: 'fs-small-note', text: 'Did the first video arrive? Open Chrome Downloads: ⌘⇧J (Mac) / Ctrl+J (Windows). This check prevents an entire batch being silently blocked.' }),
      btn('✓ File arrived', () => checkFirstDownload(true), 'fs-btn'), btn('File missing', () => checkFirstDownload(false), 'fs-btn'));
    ui.library = h('section', { class: 'fs-page', 'aria-label': 'Library' }, h('div', { class: 'fs-search-row' }, search, views), toolbar,
      ui.identityStatus,
      h('div', { class: 'fs-section-line' }, ui.listCount, sort), ui.list,
      h('div', { class: 'fs-foot' }, savePanel, ui.batchStatus, ui.deliveryCheck, ui.download, ui.addToBatch, ui.retry,
        h('div', { class: 'fs-toolbar' }, ui.missing, btn('Export report', exportDownloadReport, 'fs-btn', 'CSV of titles, statuses, request times and saved file names'),
          btn('Clean old data', cleanStorage, 'fs-btn', 'Forget saved data for other projects not opened in 30+ days')),
        h('div', { class: 'fs-small-note', text: '720p originals, never upscaled. Files save inside Chrome’s Downloads folder. Pause keeps your queue, even after a refresh.' })));
    ui.file = h('input', { type: 'file', accept: '.txt,text/plain', hidden: '', 'aria-label': 'Import prompt text file' });
    ui.file.onchange = () => { importPack(ui.file.files[0]); ui.file.value = ''; };
    ui.importButton = btn('', () => ui.file.click(), 'fs-drop');
    ui.importButton.append(h('strong', { text: '＋  Import prompts (.txt)' }), h('span', { text: 'Unzip your pack, then choose its prompts .txt file' }));
    ui.sceneSummary = h('div', { class: 'fs-caption', role: 'status' });
    ui.sceneSearch = h('input', { class: 'fs-input', placeholder: 'Find scene, frame or prompt…', 'aria-label': 'Search scenes' });
    ui.sceneSearch.oninput = renderQueue;
    ui.sceneView = h('select', { class: 'fs-select', 'aria-label': 'Scene status filter' },
      ...[['all','All scenes'],['unfinished','No result yet'],['ready','Ready to run'],['check','Needs checking'],['completed','Results found']].map(([value,text]) => h('option',{value,text})));
    ui.sceneView.onchange = renderQueue;
    ui.queueRetry = btn('Retry selected', () => retryScenes(state.jobs.filter(j => j.selected)), 'fs-btn');
    ui.queueSelect = btn('Select unfinished', selectUnfinishedScenes, 'fs-btn');
    ui.queueResults = btn('Select results → download', selectSceneResults, 'fs-btn', 'Select every finished video matched to a scene, then open the Library to download them named in edit order.');
    const sceneTools = h('div', {class:'fs-toolbar'}, ui.queueSelect, ui.queueRetry, ui.queueResults, btn('Export scene list', exportSceneReport));
    ui.jobsCount = h('span'); ui.queueList = h('div', { class: 'fs-list', 'aria-label': 'Generation jobs' });
    ui.queueUncheck = btn('Uncheck prompts', uncheckAllPrompts, 'fs-btn', 'Uncheck all prompt jobs; keep their progress and submission history.');
    ui.queueClear = btn('Clear imported prompts', clearImportedPrompts, 'fs-btn', 'Remove all imported prompts from this project’s saved queue. Previously submitted jobs remain remembered.');
    ui.missingDurations = h('select', { class: 'fs-select', 'aria-label': 'Duration for prompts without one' },
      h('option', { value: '', text: 'Choose duration…' }), ...[4, 6, 8, 10].map(n => h('option', { value: n, text: n + ' seconds' })));
    ui.missingDurations.onchange = () => { setMissingDurations(ui.missingDurations.value); ui.missingDurations.value = ''; };
    ui.missingDurationsWrap = h('label', { class: 'fs-toolbar', hidden: '' }, 'Set missing durations', ui.missingDurations);
    ui.limit = h('input', { class: 'fs-input', type: 'number', min: '1', max: '100', value: '5', 'aria-label': 'Maximum submissions per run' });
    ui.gap = h('input', { class: 'fs-input', type: 'number', min: '5', max: '300', value: '5', 'aria-label': 'Minimum seconds between submissions' });
    ui.limit.oninput = updateCounts;
    ui.generate = btn('▶  Start queue', event => {
      if (!event.isTrusted) { toast('Click Start queue yourself to authorize generation.'); return; }
      runQueue();
    }, 'fs-primary');
    ui.create = h('section', { class: 'fs-page fs-create-page', hidden: '', 'aria-label': 'Create' }, ui.file, ui.importButton,
      h('div', { class: 'fs-caption', text: 'Upload base images to this project first. Image names must match the pack.' }),
      ui.sceneSummary, h('div', {class:'fs-search-row'}, ui.sceneSearch, ui.sceneView), sceneTools, ui.missingDurationsWrap, h('div', { class: 'fs-section-line fs-queue-summary' }, ui.jobsCount,
        h('div', { class: 'fs-prompt-actions' }, ui.queueUncheck, ui.queueClear)), ui.queueList,
      h('div', { class: 'fs-foot' }, h('div', { class: 'fs-settings' }, h('label', { class: 'fs-control-label' }, 'Run limit', ui.limit), h('label', { class: 'fs-control-label' }, 'Min. gap, sec', ui.gap)), ui.generate,
        h('div', { class: 'fs-small-note', text: 'Starting spends Flow credits using your selected model. Stops at the run limit or a problem. Preparation failures can be selected again. Sent scenes require Retry selected before another take.' })));
    ui.progress = h('i'); ui.status = h('div', { class: 'fs-status', role: 'status', 'aria-live': 'polite' });
    ui.stop = btn('Pause', () => {
      state.stop = true; writeStorage();
      toast(state.generating ? 'Pausing after the current generation operation…' : 'Pausing… your selections and remaining queue are saved.');
    }, 'fs-stop'); ui.stop.hidden = true;
    const globalFoot = h('div', { class: 'fs-global-foot' }, h('div', { class: 'fs-progress' }, ui.progress), h('div', { class: 'fs-status-line' }, ui.status, ui.stop));
    ui.panel = h('aside', { id: 'fs-panel', 'aria-label': 'Flow Studio' }, head, selectionBar, tabs, ui.library, ui.create, globalFoot);
    ui.fab = btn('Flow Studio  ↑', () => togglePanel(true), '', 'Open Flow Studio · Alt+D');
    ui.fab.id = 'fs-fab'; ui.fab.hidden = true;
    ui.fab.setAttribute('aria-label', 'Open Flow Studio');
    ui.fab.setAttribute('aria-controls', 'fs-panel');
    ui.fab.setAttribute('aria-expanded', 'false');
    ui.dockCount = h('span', {class: 'fs-selection-count', 'aria-live': 'polite', 'aria-atomic': 'true'});
    ui.dockGrip = h('button', { type: 'button', class: 'fs-dock-grip', text: '⠿',
      'aria-label': 'Move toolbar', title: 'Drag to move. Arrow keys move; Home resets position.' });
    ui.dock = h('div', {id: 'fs-pick-dock', hidden: '', 'data-fs-ui': '', 'aria-label': 'Grid selection toolbar'}, ui.dockGrip, ui.dockCount, modePicker(), uncheckButton(), btn('Open panel ↗', () => togglePanel(true)), btn('−', () => togglePanel(false), 'fs-icon', 'Minimize to bottom pill'));
    ui.gridLayer = h('div', {id: 'fs-grid-layer', 'data-fs-ui': '', 'aria-label': 'Clip selection controls'});
    document.body.append(ui.gridLayer, ui.panel, ui.fab, ui.dock);
    setRowMode(state.rowPicker); applyEffect();
    makeDraggable(head); makeDockDraggable();
    // Start unobtrusively on the first run; restore the user's last open/minimized choice.
    togglePanel(!GM_getValue('fs3:minimized', true));
    document.addEventListener('keydown', e => { if (e.altKey && e.key.toLowerCase() === 'd') { e.preventDefault(); togglePanel(ui.panel.hidden); } });
    window.addEventListener('resize', () => { clampPanel(); placeDock(); scheduleOverlays(); });
    document.addEventListener('scroll', scheduleOverlays, { capture: true, passive: true });
    toast('Loading media. Still images are listed separately; use Flow’s image menu to download them.');
  }
  function togglePanel(show, picking = false) {
    const active = document.activeElement;
    const moveFocus = ui.panel.contains(active) || ui.dock.contains(active) || active === ui.fab;
    const minimized = !show && !picking;
    ui.panel.hidden = !show; ui.panel.style.display = show ? 'flex' : 'none';
    ui.dock.hidden = show || !picking; ui.fab.hidden = !minimized;
    ui.fab.setAttribute('aria-expanded', String(show));
    ui.gridLayer.hidden = minimized || state.generating;
    // Hiding the controls does not stop a queue or clear any selected clips.
    if (minimized) state.relinkKey = '';
    try { GM_setValue('fs3:minimized', !show); } catch (_) { /* The UI still minimizes if storage is unavailable. */ }
    if (show) clampPanel(); else if (picking) placeDock();
    if (moveFocus) (show ? ui.libraryTab : picking ? ui.dockGrip : ui.fab).focus({ preventScroll: true });
    scheduleOverlays();
  }
  function placeDock(position = ui.dockPosition) {
    if (ui.dock.hidden) return;
    const r = ui.dock.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const p = boundedDockPosition(position?.x ?? r.left, position?.y ?? r.top, r.width, r.height, innerWidth, innerHeight);
    ui.dockPosition = p;
    Object.assign(ui.dock.style, { left: p.x + 'px', top: p.y + 'px', right: 'auto', bottom: 'auto', transform: 'none' });
    scheduleOverlays();
  }
  function makeDockDraggable() {
    const dock = ui.dock, grip = ui.dockGrip;
    const saved = GM_getValue('fs3:dock-position', null);
    ui.dockPosition = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
    let drag = null;
    const save = () => { if (ui.dockPosition) {
      try { GM_setValue('fs3:dock-position', ui.dockPosition); }
      catch (_) { toast('Toolbar moved, but its position could not be saved.', true); }
    } };
    dock.addEventListener('pointerdown', e => {
      const control = e.target.closest('button,input,select,a');
      if (e.button !== 0 || e.isPrimary === false || (control && control !== grip)) return;
      const r = dock.getBoundingClientRect();
      drag = { pointer: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
      dock.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
    });
    dock.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointer) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) return;
      drag.moved = true; dock.dataset.dragging = 'true';
      placeDock({ x: drag.left + e.clientX - drag.x, y: drag.top + e.clientY - drag.y });
      e.preventDefault(); e.stopPropagation();
    });
    const finish = e => {
      if (!drag || e.pointerId !== drag.pointer) return;
      const moved = drag.moved; drag = null; delete dock.dataset.dragging;
      if (dock.hasPointerCapture(e.pointerId)) dock.releasePointerCapture(e.pointerId);
      if (moved) save();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) dock.addEventListener(type, finish);
    grip.addEventListener('keydown', e => {
      const move = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[e.key];
      if (!move && e.key !== 'Home') return;
      e.preventDefault(); e.stopPropagation();
      const r = dock.getBoundingClientRect(), step = e.shiftKey ? 40 : 10;
      placeDock(move ? { x: r.left + move[0] * step, y: r.top + move[1] * step }
        : { x: (innerWidth - r.width) / 2, y: innerHeight - r.height - 18 });
      save();
    });
  }
  function clampPanel() {
    const r = ui.panel.getBoundingClientRect(); if (!r.width) return;
    ui.panel.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, r.left)) + 'px';
    ui.panel.style.top = Math.max(8, Math.min(innerHeight - 64, r.top)) + 'px'; ui.panel.style.right = 'auto';
  }
  function makeDraggable(handle) {
    let drag = null;
    const pos = GM_getValue('fs3:position', null);
    if (pos) { ui.panel.style.left = pos.x + 'px'; ui.panel.style.top = pos.y + 'px'; ui.panel.style.right = 'auto'; clampPanel(); }
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = ui.panel.getBoundingClientRect(); drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      handle.setPointerCapture(e.pointerId); e.preventDefault();
    });
    handle.addEventListener('pointermove', e => { if (!drag) return;
      ui.panel.style.left = Math.max(8, Math.min(innerWidth - ui.panel.offsetWidth - 8, drag.left + e.clientX - drag.x)) + 'px';
      ui.panel.style.top = Math.max(8, Math.min(innerHeight - 64, drag.top + e.clientY - drag.y)) + 'px'; ui.panel.style.right = 'auto';
      scheduleOverlays();
    });
    handle.addEventListener('pointerup', () => { if (!drag) return; drag = null; const r = ui.panel.getBoundingClientRect(); GM_setValue('fs3:position', { x: r.left, y: r.top }); });
  }
  function scheduleOverlays() { if (!overlayFrame) overlayFrame = requestAnimationFrame(() => { overlayFrame = null; decorateGrid(); }); }
  try { installMediaObserver(typeof unsafeWindow === 'undefined' ? window : unsafeWindow, ingestMediaResponse); }
  catch (_) { /* The UI reports missing media IDs; no URL-based fallback. */ }
  function boot() {
    if (document.getElementById('fs-panel')) return;
  installStudioStyles();
  let restoreError = '';
  try { restoreProject(); } catch (e) { restoreError = e.message; }
  buildUI(); switchTab('library'); renderLibrary(); renderQueue();
  if (restoreError) toast(restoreError, true);
  else { harvest(); acquireWriter(); }
  new MutationObserver(mutations => {
    if (!mutations.some(m => !own(m.target) && [...m.addedNodes, ...m.removedNodes].some(n => !(n.nodeType === 1 && (n.matches?.('[data-fs-ui]') || own(n)))))) return;
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (!busy()) harvest(); }, 300);
  }).observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    const project = projectIdentity(location.pathname);
    if (project !== state.project) {
      state.stop = true;
      if (running()) return; // Let the current operation release its project first.
      writeStorage(); state.project = project; state.stop = false; state.filter = ''; state.view = 'all';
      restoreProject(); renderLibrary(); renderQueue(); acquireWriter(project);
      for (const key of mediaCatalog.keys()) if (!key.startsWith(project + ':')) mediaCatalog.delete(key);
      toast(project ? 'Project restored. Your selections are saved.' : 'Open a Flow project.');
    }
    if (state.writable && !state.scanning && !state.downloading && state.catalogDirty) reconcileMedia();
    if (!state.scanning && !state.downloading) harvest(!state.generating);
  }, 1200);
  window.addEventListener('beforeunload', writeStorage);
  window.addEventListener('pagehide', () => { writeStorage(); state.stop = true; if (releaseWriter) releaseWriter(); });
  window.addEventListener('pageshow', event => { if (event.persisted) acquireWriter(); });
  }
  // Development tests export this closure in a local DOM harness; never in the release.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
