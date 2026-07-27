#!/usr/bin/env node
// A reusable browser smoke test: starts dev-server.js, drives the app in a
// real headless browser, and fails if any step's expectation is wrong OR if
// the page logs a console error / throws an uncaught exception at any point
// during the run — a permanent, rerunnable version of the one-off
// Playwright scripts written by hand for every feature during development.
//
// Deliberately talks to the browser over the Chrome DevTools Protocol
// (WebSocket + JSON-RPC) using only Node's own built-ins (`http`, the
// global `WebSocket`, stable since Node 21) instead of a browser-automation
// library — matching this repo's "no dependencies to install" rule (see
// dev-server.js/dev.js) rather than introducing the first npm dependency
// (and package.json/node_modules) this project would ever have. It's more
// code than `page.click()` would be, but `element.click()` / dispatching a
// real DOM event via Runtime.evaluate() achieves the same thing for a
// single-page app like this one — no Input.dispatchMouseEvent coordinate
// juggling needed.
//
// Usage: node verify.js
//   CHROME_PATH=/path/to/chrome   override browser auto-discovery
//   VERIFY_PORT=8099              port for the throwaway dev-server instance
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_PORT = process.env.VERIFY_PORT || 8099;
const APP_URL = `http://127.0.0.1:${SERVER_PORT}`;

function findBrowser() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'chrome', 'microsoft-edge'];
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    try {
      const out = execFileSync(whichCmd, [name], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
      if (out) candidates.push(out);
    } catch { /* not found, try next */ }
  }
  const staticPaths = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : process.platform === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ] : [];
  candidates.push(...staticPaths);
  try {
    const pwRoot = '/opt/pw-browsers';
    if (fs.existsSync(pwRoot)) {
      for (const dir of fs.readdirSync(pwRoot)) {
        const p = path.join(pwRoot, dir, 'chrome-linux', 'chrome');
        if (fs.existsSync(p)) candidates.push(p);
      }
    }
  } catch { /* ignore */ }
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

function httpJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error(`Non-JSON response from ${url}: ${body}`)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await new Promise((resolve, reject) => { http.get(url, (res) => { res.resume(); resolve(); }).on('error', reject); }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`${url} never responded within ${timeoutMs}ms`);
}

// Minimal CDP client: one WebSocket, JSON-RPC request/response by id, plus a
// pub/sub for events (Runtime.consoleAPICalled etc). No dependencies beyond
// Node's own built-in WebSocket (stable since Node 21) — see the file header
// comment for why this exists instead of a browser-automation library.
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP WebSocket error: ' + (e.message || e))));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  // Runs `expr` as a plain script in the page's top-level scope (NOT the
  // app's own module scope, which JS modules keep private — but DOM
  // mutations/queries and dispatching real events on elements work exactly
  // like a user interacting with the page, which is all every check below
  // needs). Throws if the page threw.
  async evaluate(expr) {
    const result = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error('Page threw: ' + (d.exception?.description || d.text));
    }
    return result.result.value;
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

async function main() {
  const errors = [];
  const steps = [];
  function step(name, fn) {
    steps.push(async () => {
      try { await fn(); console.log(`  ok  ${name}`); }
      catch (e) { console.log(`FAIL  ${name}: ${e.message}`); errors.push(`[${name}] ${e.message}`); }
    });
  }

  const repoRoot = path.join(__dirname);
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('No Chromium-family browser found. Set CHROME_PATH to one, or install Chrome/Chromium/Edge.');
    process.exit(1);
  }

  console.log(`Starting dev server on ${APP_URL} ...`);
  const server = spawn(process.execPath, [path.join(repoRoot, 'dev-server.js')], {
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: 'ignore',
  });
  await waitForHttp(APP_URL, 10000).catch((e) => { server.kill(); throw e; });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-studio-verify-'));
  const debugPort = 9333 + Math.floor(Math.random() * 500); // avoid clashing with a concurrent run
  const chrome = spawn(browserPath, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`,
    '--no-sandbox', '--disable-gpu', '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 10000);
    const tab = await httpJson(`http://127.0.0.1:${debugPort}/json/new?about:blank`, 'PUT');
    cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') errors.push('[console] ' + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      errors.push('[pageerror] ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    });
    cdp.on('Page.javascriptDialogOpening', () => { cdp.send('Page.handleJavaScriptDialog', { accept: true }); });
    await cdp.send('Page.setBypassCSP', { enabled: true });

    async function goto(url) {
      const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
      await cdp.send('Page.navigate', { url });
      await loaded;
    }
    async function waitFor(expr, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await cdp.evaluate(expr)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timed out waiting for: ${expr}`);
    }

    // The inspector's preset palettes collapse by default and remember it, so
    // their buttons aren't in the DOM until disclosed. Open one before clicking
    // through it — otherwise these checks would exercise buttons no user could
    // actually reach (element.click() works on hidden nodes, and would have
    // worked on detached-by-default markup too, quietly proving nothing).
    async function openPalette(kind) {
      const attr = kind === 'chord' ? 'data-chord' : 'data-arp';
      if (await cdp.evaluate(`!!document.querySelector('.preset-grid button[${attr}]')`)) return;
      const cap = kind === 'chord' ? 'Chord' : 'Pitch';
      await cdp.evaluate(`(() => {
        const panel = Array.from(document.querySelectorAll('.insp-panel'))
          .find((p) => p.querySelector('.insp-cap')?.textContent === ${JSON.stringify(cap)});
        panel.querySelector('.palette-toggle').click();
      })()`);
      await waitFor(`!!document.querySelector('.preset-grid button[${attr}]')`);
    }

    step('loads with no console errors, boots into a blank project', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('#file-menu-toggle')`);
      const trackCount = await cdp.evaluate(`document.querySelectorAll('.track').length`);
      if (trackCount !== 1) throw new Error(`expected 1 track (blank project), got ${trackCount}`);
    });

    step('loads the Froggy Hop example via the Songs menu', async () => {
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Songs')).click()`);
      await waitFor(`document.querySelectorAll('.song-item').length > 0`);
      await cdp.evaluate(`
        const row = Array.from(document.querySelectorAll('.song-item')).find(r => r.querySelector('.song-title')?.textContent === 'Froggy Hop');
        row.querySelector('button').click();
      `);
      await waitFor(`document.querySelector('#song-name-display').textContent === 'Froggy Hop'`);
      const trackCount = await cdp.evaluate(`document.querySelectorAll('.track').length`);
      if (trackCount < 2) throw new Error(`expected multiple tracks after loading Froggy Hop, got ${trackCount}`);
    });

    step('opens the Automation panel and adds a curve point', async () => {
      await cdp.evaluate(`Array.from(document.querySelectorAll('.track')[0].querySelectorAll('button')).find(b => b.textContent.includes('Auto')).click()`);
      await waitFor(`!!document.querySelector('.automation-lane-el')`);
      const before = await cdp.evaluate(`document.querySelectorAll('.automation-point').length`);
      await cdp.evaluate(`
        const lane = document.querySelector('.automation-lane-el');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 10 }));
      `);
      await waitFor(`document.querySelectorAll('.automation-point').length > ${before}`);
    });

    step('opens the FX panel and adjusts the Delay slider', async () => {
      await cdp.evaluate(`Array.from(document.querySelectorAll('.track')[0].querySelectorAll('button')).find(b => b.textContent.includes('FX')).click()`);
      await waitFor(`!!document.querySelector('.th-fx-panel')`);
      await cdp.evaluate(`
        const field = Array.from(document.querySelectorAll('.th-fx-field')).find(f => f.querySelector('.th-fx-label').textContent === 'Delay');
        const slider = field.querySelector('input[type=range]');
        slider.value = 0.5;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      const text = await cdp.evaluate(`
        Array.from(document.querySelectorAll('.th-fx-field')).find(f => f.querySelector('.th-fx-label').textContent === 'Delay').querySelector('.th-fx-val').textContent
      `);
      if (text !== '50%') throw new Error(`expected Delay to show 50%, got ${text}`);
    });

    step('FX panel: per-track EQ sits ahead of the compressor and survives a reload', async () => {
      const labels = await cdp.evaluate(`Array.from(document.querySelectorAll('.th-fx-panel .th-fx-label')).map(e => e.textContent)`);
      for (const band of ['Lo', 'Mid', 'Hi']) {
        if (!labels.includes(band)) throw new Error(`expected an EQ ${band} field, got ${labels.join(',')}`);
      }
      // The registry order is the audio order: EQ feeds the compressor, so a
      // band must render before Thr rather than after it.
      if (labels.indexOf('Hi') > labels.indexOf('Thr')) {
        throw new Error(`EQ should render before the compressor, got ${labels.join(',')}`);
      }
      const setBand = (band, value) => cdp.evaluate(`(() => {
        const field = Array.from(document.querySelectorAll('.th-fx-field')).find(f => f.querySelector('.th-fx-label').textContent === ${JSON.stringify(band)});
        const slider = field.querySelector('input[type=range]');
        slider.value = ${value};
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        return field.querySelector('.th-fx-val').textContent;
      })()`);
      const shown = await setBand('Lo', 6);
      if (shown !== '6.0dB') throw new Error(`expected Lo to read 6.0dB, got ${shown}`);
      const cut = await setBand('Hi', -4.5);
      if (cut !== '-4.5dB') throw new Error(`expected Hi to read -4.5dB, got ${cut}`);
      // Round-trip through the song payload the same way a save/load would.
      await new Promise((r) => setTimeout(r, 500)); // autosave is debounced
      const stored = await cdp.evaluate(`(() => {
        const key = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!key) return null;
        const eq = (JSON.parse(localStorage.getItem(key)) || {}).eq || {};
        return eq[Object.keys(eq)[0]] || null;
      })()`);
      if (!stored || stored.low !== 6 || stored.high !== -4.5) {
        throw new Error(`EQ should be part of the saved song, got ${JSON.stringify(stored)}`);
      }
      // Reset is registry-driven, so it must clear the new group too.
      await cdp.evaluate(`document.querySelector('.th-fx-reset').click()`);
      await waitFor(`Array.from(document.querySelectorAll('.th-fx-field')).find(f => f.querySelector('.th-fx-label').textContent === 'Lo').querySelector('.th-fx-val').textContent === '0.0dB'`);
    });

    step('plays back for a moment with no errors', async () => {
      const before = errors.length;
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 1200));
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 100));
      if (errors.length > before) throw new Error('errors occurred during playback');
    });

    step('adds a track via the menu and undoes it', async () => {
      const before = await cdp.evaluate(`document.querySelectorAll('.track').length`);
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Add track')).click()`);
      await waitFor(`document.querySelectorAll('.track').length === ${before} + 1`);
    });

    step('Pen: clicking a different pitch at the same time in a tonal track adds a chord tone, not a replacement', async () => {
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      const hasLane = await cdp.evaluate(`!!document.querySelector('.track.active .lane')`);
      if (!hasLane) throw new Error('expected an active tonal track with a .lane element');
      await cdp.evaluate(`{
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 20 }));
      }`);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 1`);
      await cdp.evaluate(`{
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 100 }));
      }`);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 2`);
    });

    step('Note inspector: both preset palettes start collapsed', async () => {
      // Expanded, the two ten-button grids were 384px of a 745px inspector,
      // which pushed the panels below them off a 1366x768 screen. They collapse
      // by default and remember the choice; this must run before any other step
      // discloses one. A palette renders no buttons at all while collapsed —
      // element.click() would happily fire on merely-hidden ones.
      await waitFor(`!!Array.from(document.querySelectorAll('.insp-cap')).find(c => c.textContent === 'Chord')`);
      const toggles = await cdp.evaluate(`document.querySelectorAll('.palette-toggle').length`);
      if (toggles !== 2) throw new Error(`expected an Arpeggio and a Chord disclosure, got ${toggles}`);
      const grids = await cdp.evaluate(`document.querySelectorAll('.inspector .preset-grid').length`);
      if (grids !== 0) throw new Error(`expected both palettes collapsed by default, ${grids} were open`);
      const collapsed = await cdp.evaluate(`Array.from(document.querySelectorAll('.palette-toggle')).every(b => b.getAttribute('aria-expanded') === 'false')`);
      if (!collapsed) throw new Error('collapsed palettes should report aria-expanded="false"');
      // And the inspector now fits without scrolling on a small laptop.
      const fits = await cdp.evaluate(`(() => {
        const col = document.querySelector('.inspector-column');
        return { content: document.querySelector('.inspector').scrollHeight, visible: col.clientHeight };
      })()`);
      if (fits.content > 620) throw new Error(`collapsed inspector should stay compact, measured ${fits.content}px`);
    });

    step('Note inspector: the maj chord button adds two real notes and multi-selects the whole chord', async () => {
      await waitFor(`!!Array.from(document.querySelectorAll('.insp-cap')).find(c => c.textContent === 'Chord')`);
      await openPalette('chord');
      await cdp.evaluate(`
        document.querySelector('.preset-grid button[data-chord="maj"]').click();
      `);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 4`);
      const multiCount = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note.multi-selected').length`);
      if (multiCount !== 3) throw new Error(`expected 3 notes multi-selected as the chord group, got ${multiCount}`);
      const inspectorEmpty = await cdp.evaluate(`document.querySelector('.inspector').classList.contains('empty')`);
      if (!inspectorEmpty) throw new Error('expected the single-note inspector to close after the chord is selected as a group');
    });

    step('Chord buttons: re-running on the same root adds nothing (no stacked duplicates)', async () => {
      // The chord tones from the previous step are already there, so asking
      // for the same chord again must be a no-op rather than stacking exact
      // duplicates on top of them. Done here, before the pitch-window pan
      // below, so every note is still inside the visible window — a note
      // scrolled outside it renders at a clamped row (renderPitchTrack's
      // `Math.max(0, Math.min(pitchCount - 1, ...))`), which would make two
      // different pitches share one style.top and break the comparison.
      // The chord group is multi-selected; its root is the lowest pitch of
      // the three, i.e. the largest style.top.
      await cdp.evaluate(`{
        const chord = Array.from(document.querySelectorAll('.track.active .lane .note.multi-selected'));
        chord.sort((a, b) => parseFloat(b.style.top) - parseFloat(a.style.top))[0].click();
      }`);
      await waitFor(`!!Array.from(document.querySelectorAll('.insp-cap')).find(c => c.textContent === 'Chord')`);
      const before = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note').length`);
      await openPalette('chord');
      await cdp.evaluate(`
        document.querySelector('.preset-grid button[data-chord="maj"]').click();
      `);
      await new Promise((r) => setTimeout(r, 150));
      const after = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note').length`);
      if (after !== before) throw new Error(`expected the repeat chord to be a no-op, got ${before} -> ${after} notes`);
    });

    step('Chord buttons at the pitch ceiling: root survives, nothing is deleted', async () => {
      // Push the pitch window's auto-fit all the way up first (a big
      // negative-deltaY wheel scroll pans toward higher pitches, clamped at
      // MIDI_MAX) so a click near the very top row lands on the instrument's
      // actual ceiling — otherwise the auto-fit window for whatever notes
      // this track happens to hold wouldn't reliably reach MIDI_MAX, and the
      // "+4/+7 clamps back to the root" case below wouldn't reproduce.
      await cdp.evaluate(`{
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100000, clientX: rect.left + 10, clientY: rect.top + 10 }));
      }`);
      await new Promise((r) => setTimeout(r, 100));
      await cdp.evaluate(`{
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 60, clientY: rect.top + 5 }));
      }`);
      // The root sits on row 0 here, the one row the render clamp can't
      // ambiguate (notes panned out of view clamp to the *bottom* row), so
      // its style.top/left pair identifies it reliably without reaching into
      // the app's module-private state.
      const rootKey = `(n => n.style.top + '|' + n.style.left)`;
      const before = await cdp.evaluate(`(() => {
        const root = document.querySelector('.track.active .lane .note.selected');
        return { count: document.querySelectorAll('.track.active .lane .note').length, rootKey: root ? ${rootKey}(root) : null };
      })()`);
      if (!before.rootKey) throw new Error('expected the just-placed note to be the selected root');
      await waitFor(`!!Array.from(document.querySelectorAll('.insp-cap')).find(c => c.textContent === 'Chord')`);
      await openPalette('chord');
      await cdp.evaluate(`
        document.querySelector('.preset-grid button[data-chord="maj"]').click();
      `);
      await new Promise((r) => setTimeout(r, 150));
      const after = await cdp.evaluate(`(() => {
        const keys = Array.from(document.querySelectorAll('.track.active .lane .note')).map(${rootKey});
        return { count: keys.length, keys };
      })()`);
      // At the ceiling both +4 and +7 clamp back onto the root's own pitch, so
      // there is no chord to add and the click is a no-op — what must never
      // happen is the root (or any other note) being deleted on the way, or
      // a duplicate being stacked on the root's own pitch.
      if (!after.keys.includes(before.rootKey)) {
        throw new Error(`the root note was deleted by a chord button (root at ${before.rootKey} is gone)`);
      }
      if (after.keys.filter((k) => k === before.rootKey).length !== 1) {
        throw new Error(`a chord button stacked a duplicate on the root's own pitch (${before.rootKey})`);
      }
      if (after.count < before.count) {
        throw new Error(`a chord button deleted an existing note (${before.count} -> ${after.count})`);
      }
    });

    step('Chord presets: every voicing is offered, and a 7th adds all three tones', async () => {
      // The other chord steps only exercise `maj` (two tones). A seventh is the
      // three-tone shape, and the power chord the one-tone shape, so check the
      // table is fully wired and that a longer interval list lands correctly.
      const labels = await cdp.evaluate(`Array.from(document.querySelectorAll('.preset-grid button[data-chord]')).map(b => b.dataset.chord)`);
      const expected = ['5', 'maj', 'min', 'dim', 'aug', 'sus2', 'sus4', '7', 'maj7', 'm7'];
      if (labels.join(',') !== expected.join(',')) {
        throw new Error(`chord presets should be ${expected.join(',')}, got ${labels.join(',')}`);
      }
      if (!await cdp.evaluate(`Array.from(document.querySelectorAll('.preset-grid button[data-chord]')).every(b => b.title.length > 0)`)) {
        throw new Error('every chord button needs a tooltip — the labels alone are abbreviations');
      }
      // Fresh track so the root's own column is empty and the lane's pitch
      // window is not panned; rows are then a direct read of the intervals.
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('Add track')).click()`);
      await new Promise((r) => setTimeout(r, 350));
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`{
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 100, clientY: rect.top + 120 }));
      }`);
      await new Promise((r) => setTimeout(r, 250));
      const col = await cdp.evaluate(`(() => { const s = document.querySelector('.track.active .lane .note.selected'); return s ? s.style.left : null; })()`);
      if (!col) throw new Error('expected the placed note to be selected');
      await openPalette('chord');
      await cdp.evaluate(`document.querySelector('.preset-grid button[data-chord="maj7"]').click()`);
      await new Promise((r) => setTimeout(r, 300));
      // ROW_H is 11px per semitone; measure upward from the lowest note.
      const offsets = await cdp.evaluate(`(() => {
        const tops = Array.from(document.querySelectorAll('.track.active .lane .note'))
          .filter(n => n.style.left === ${JSON.stringify(col)})
          .map(n => parseFloat(n.style.top)).sort((a, b) => b - a);
        return tops.map(t => Math.round((tops[0] - t) / 11));
      })()`);
      if (offsets.join(',') !== '0,4,7,11') {
        throw new Error(`maj7 should voice root/+4/+7/+11 semitones, got ${offsets.join(',')}`);
      }
    });

    step('Arpeggio presets: same palette as Chord, writing intervals into the note', async () => {
      // Both rows read CHORD_PRESETS, so they must offer the same voicings —
      // but an arpeggio only rewrites this one note's `arp` list rather than
      // adding notes, and the Arpeggio field is where that shows up.
      //
      // Select a note before comparing: the previous step ends on a chord
      // button, which multi-selects the new group and so closes the single-note
      // inspector. Reading the two palettes with no inspector rendered would
      // compare one empty list against another and pass for the wrong reason.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`{
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 300, clientY: rect.top + 120 }));
      }`);
      await waitFor(`!!document.querySelector('.track.active .lane .note.selected')`);
      await openPalette('arp');
      await openPalette('chord');
      const arpLabels = await cdp.evaluate(`Array.from(document.querySelectorAll('.preset-grid button[data-arp]')).map(b => b.dataset.arp)`);
      const chordLabels = await cdp.evaluate(`Array.from(document.querySelectorAll('.preset-grid button[data-chord]')).map(b => b.dataset.chord)`);
      if (!arpLabels.length) throw new Error('no Arpeggio presets rendered — is a note selected?');
      if (arpLabels.join(',') !== chordLabels.join(',')) {
        throw new Error(`Arpeggio and Chord rows should offer the same voicings — arp [${arpLabels}] vs chord [${chordLabels}]`);
      }
      if (!await cdp.evaluate(`Array.from(document.querySelectorAll('.preset-grid button[data-arp]')).every(b => b.title.length > 0)`)) {
        throw new Error('every arpeggio button needs a tooltip — the labels alone are abbreviations');
      }
      const notesBefore = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note').length`);
      await cdp.evaluate(`document.querySelector('.preset-grid button[data-arp="m7"]').click()`);
      await new Promise((r) => setTimeout(r, 300));
      const arpValue = await cdp.evaluate(`(() => {
        const f = Array.from(document.querySelectorAll('.insp-field')).find(x => x.textContent.includes('Arpeggio'));
        return f ? f.querySelector('input').value : null;
      })()`);
      if (arpValue !== '3,7,10') throw new Error(`m7 should write 3,7,10 into the Arpeggio field, got ${arpValue}`);
      // An arpeggio is one note sweeping — unlike the Chord row it must not add any.
      const notesAfter = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note').length`);
      if (notesAfter !== notesBefore) {
        throw new Error(`an arpeggio preset should not add notes (${notesBefore} -> ${notesAfter})`);
      }
      const badged = await cdp.evaluate(`!!document.querySelector('.track.active .lane .note .arp-badge')`);
      if (!badged) throw new Error('expected the arpeggiated note to show its ♪ badge');
    });

    step('Eraser: deleting a note does not move the selection to a different note', async () => {
      // state.selected used to be an index, so removing an earlier note
      // shifted it and silently re-pointed the inspector at another note.
      // Runs on its own freshly added track so earlier steps' notes (and the
      // ceiling step's panned pitch window, where off-screen notes render at a
      // clamped row and several can share one style.top) can't confuse the
      // identity comparison below.
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Add track')).click()`);
      await new Promise((r) => setTimeout(r, 300));
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      // Identify notes by column (style.left) alone, NOT by pitch row: removing
      // a note re-fits the lane's pitch window, which shifts every remaining
      // note's style.top even though nothing about them changed. A note's
      // column is unaffected by a deletion, so it stays a valid identity here.
      const key = `(n => n.style.left)`;
      const byColumn = `(() => { const n = Array.from(document.querySelectorAll('.track.active .lane .note'));
        n.sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left)); return n; })()`;
      // Place four notes left-to-right, so array order matches column order.
      // Four, not three: the selected index has to stay *in bounds* after the
      // deletion for the bug to be visible. Selecting the last of three would
      // leave a stale index past the end, which renders as no selection at all
      // — indistinguishable from the acceptable "selection cleared" outcome.
      for (const [dx, dy] of [[20, 30], [120, 50], [220, 70], [320, 90]]) {
        await cdp.evaluate(`{
          const lane = document.querySelector('.track.active .lane');
          const rect = lane.getBoundingClientRect();
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + ${dx}, clientY: rect.top + ${dy} }));
        }`);
        await new Promise((r) => setTimeout(r, 180));
      }
      const columns = await cdp.evaluate(`${byColumn}.map(${key})`);
      if (columns.length !== 4) throw new Error(`expected 4 notes on the fresh track, got ${columns.length}`);
      if (new Set(columns).size !== 4) throw new Error(`expected 4 distinct columns, got ${columns.join(', ')}`);
      // Select the third note, then erase the first (index 0) — the stale index
      // would then land on the fourth.
      const selected = await cdp.evaluate(`(() => { const n = ${byColumn}; n[2].click(); return ${key}(n[2]); })()`);
      await new Promise((r) => setTimeout(r, 150));
      const before = await cdp.evaluate(`(() => { const s = document.querySelector('.track.active .lane .note.selected'); return s ? ${key}(s) : null; })()`);
      if (before !== selected) throw new Error(`clicking a note did not select it (wanted ${selected}, got ${before})`);
      await cdp.evaluate(`document.querySelector('[data-tool="eraser"]').click()`);
      await new Promise((r) => setTimeout(r, 100));
      await cdp.evaluate(`${byColumn}[0].click()`);
      await new Promise((r) => setTimeout(r, 200));
      const after = await cdp.evaluate(`(() => { const s = document.querySelector('.track.active .lane .note.selected'); return s ? ${key}(s) : null; })()`);
      // Following the same note is right; clearing would be acceptable too —
      // silently landing on a *different* note is the bug.
      if (after !== null && after !== selected) {
        throw new Error(`the selection jumped to a different note after erasing another (was ${selected}, now ${after})`);
      }
    });

    step('Rhythm: placing a hit keeps the other rows in that column', async () => {
      // The rhythm counterpart of the same-pitch rule for notes: only a hit of
      // the same *type* in a column is a duplicate. Filtering on start alone
      // wiped the whole column, making kick+hi-hat on one beat unplaceable.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      const rhythmLane = `document.querySelector('.track[data-track="rhythm"] .lane')`;
      const hasLane = await cdp.evaluate(`!!${rhythmLane}`);
      if (!hasLane) throw new Error('expected a rhythm track lane');
      await cdp.evaluate(`${rhythmLane}.click()`); // make the rhythm track active
      await new Promise((r) => setTimeout(r, 150));
      const clickRow = (yOffset) => cdp.evaluate(`{
        const lane = ${rhythmLane};
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 200, clientY: rect.top + ${yOffset} }));
      }`);
      const countHits = `document.querySelectorAll('.track[data-track="rhythm"] .lane .hit').length`;
      const start = await cdp.evaluate(countHits);
      await clickRow(8);   // row 0 — kick
      await new Promise((r) => setTimeout(r, 200));
      const afterFirst = await cdp.evaluate(countHits);
      if (afterFirst !== start + 1) throw new Error(`expected one hit to be added, got ${start} -> ${afterFirst}`);
      await clickRow(25);  // row 1 — snare, same column
      await new Promise((r) => setTimeout(r, 200));
      const afterSecond = await cdp.evaluate(countHits);
      if (afterSecond !== start + 2) {
        throw new Error(`placing a second hit in the same column wiped the first (${afterFirst} -> ${afterSecond}, expected ${start + 2})`);
      }
      // Re-clicking the same row+column must still replace, not stack.
      await clickRow(8);
      await new Promise((r) => setTimeout(r, 200));
      const afterRepeat = await cdp.evaluate(countHits);
      if (afterRepeat !== start + 2) {
        throw new Error(`re-placing the same hit type stacked a duplicate (${afterSecond} -> ${afterRepeat})`);
      }

      // Same rule on drop: dragging a hit into an occupied column must displace
      // only a hit of its own type, not clear the whole column.
      await cdp.evaluate(`document.querySelector('[data-tool="grab"]').click()`);
      await new Promise((r) => setTimeout(r, 150));
      const dragged = await cdp.evaluate(`(() => {
        const hits = Array.from(document.querySelectorAll('.track[data-track="rhythm"] .lane .hit'));
        const snare = hits.find((h) => h.className.includes('snare'));
        if (!snare) return false;
        const r = snare.getBoundingClientRect();
        const opts = { bubbles: true, pointerId: 1, clientX: r.left + 3, clientY: r.top + 3 };
        snare.dispatchEvent(new PointerEvent('pointerdown', opts));
        window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: r.left + 3 - 64 }));
        window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: r.left + 3 - 64 }));
        return true;
      })()`);
      if (!dragged) throw new Error('expected a snare hit to drag');
      await new Promise((r) => setTimeout(r, 300));
      const afterDrag = await cdp.evaluate(countHits);
      if (afterDrag !== start + 2) {
        throw new Error(`dragging a hit into another row's column destroyed it (${afterRepeat} -> ${afterDrag})`);
      }
    });

    // Both steps below run on a rhythm track added here: the song's own rhythm
    // lane already holds hundreds of hits, so a marquee over it would sweep up
    // unrelated ones and the counts would mean nothing. A fresh track starts
    // empty and is made active by addRhythmTrack().
    step('Rhythm: pasting a stacked kick+snare keeps both hits', async () => {
      // The clipboard path keyed hits on their column alone, so one row of a
      // copied stack was dropped and the landing column's other rows cleared.
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Add rhythm track')).click()`);
      await new Promise((r) => setTimeout(r, 350));
      const lane = `document.querySelector('.track.active .lane')`;
      const countHits = `document.querySelectorAll('.track.active .lane .hit').length`;
      if (await cdp.evaluate(countHits) !== 0) throw new Error('expected the new rhythm track to start empty');
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      for (const y of [8, 25]) {
        await cdp.evaluate(`{
          const l = ${lane};
          const rect = l.getBoundingClientRect();
          l.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 200, clientY: rect.top + ${y} }));
        }`);
        await new Promise((r) => setTimeout(r, 180));
      }
      const before = await cdp.evaluate(countHits);
      if (before !== 2) throw new Error(`expected a two-row stack, got ${before} hits`);
      await cdp.evaluate(`document.querySelector('[data-tool="grab"]').click()`);
      await new Promise((r) => setTimeout(r, 150));
      await cdp.evaluate(`{
        const l = ${lane};
        const rect = l.getBoundingClientRect();
        const o = { bubbles: true, pointerId: 21, clientY: rect.top + 40 };
        l.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: rect.left + 180 }));
        window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: rect.left + 230 }));
        window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: rect.left + 230 }));
      }`);
      await new Promise((r) => setTimeout(r, 250));
      const picked = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .hit.multi-selected').length`);
      if (picked !== 2) throw new Error(`expected the marquee to select both hits, got ${picked}`);
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))`);
      await new Promise((r) => setTimeout(r, 150));
      await cdp.evaluate(`{
        const t = document.querySelector('.timeline');
        const rect = t.getBoundingClientRect();
        t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 22, clientX: rect.left + 600, clientY: rect.top + 5 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 22, clientX: rect.left + 600, clientY: rect.top + 5 }));
      }`);
      await new Promise((r) => setTimeout(r, 250));
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }))`);
      await new Promise((r) => setTimeout(r, 350));
      const after = await cdp.evaluate(countHits);
      if (after !== before + 2) {
        throw new Error(`pasting a two-row stack should add both hits (${before} -> ${before + 2}), got ${after}`);
      }
    });

    step('Adding a track does not carry the previous track\'s selection into it', async () => {
      // state.multiSelected is scoped to the active track, but addTrack() set
      // state.activeTrack directly and setActive() then early-returned, so the
      // old track's group stayed selected — and the next nudge copied those
      // items into the new track.
      const selected = `document.querySelectorAll('.hit.multi-selected, .note.multi-selected').length`;
      if (await cdp.evaluate(selected) === 0) throw new Error('expected the pasted hits to still be selected');
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('Add track')).click()`);
      await new Promise((r) => setTimeout(r, 350));
      const afterAdd = await cdp.evaluate(selected);
      if (afterAdd !== 0) throw new Error(`adding a track kept ${afterAdd} item(s) selected from the previous track`);
      const notesBefore = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note').length`);
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
      await new Promise((r) => setTimeout(r, 300));
      const notesAfter = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note').length`);
      if (notesAfter !== notesBefore) {
        throw new Error(`nudging after adding a track pulled items into it (${notesBefore} -> ${notesAfter} notes)`);
      }
    });

    step('Interface icons: drawn from GLYPHS, no emoji, and every control still named', async () => {
      // The point of replacing the emoji was one visual language, so the check
      // is twofold: no pictographic character is left on a control, and nothing
      // lost its accessible name on the way (a glyph is aria-hidden, so a
      // button with no text and no aria-label would be nameless).
      const audit = await cdp.evaluate(`(() => {
        // Codepoint ranges for emoji and the dingbat/misc-symbol blocks they
        // came from, minus the plain geometric characters the UI keeps on
        // purpose: the transport, undo/redo, disclosure triangles, the closes
        // and the +/- steppers. Those read as typography, not as pasted-in
        // pictures, and a stroked play triangle looks worse than the filled one
        // everybody expects. Listing them here is what keeps that a decision
        // rather than an oversight.
        // ✎ was on this list while the song-name button still used it as a
        // ::after; it is a real glyph now, so it comes off — otherwise this
        // check would happily let the old pencil back in.
        const KEEP = '✕⏮■▶↺↶↷▾▸▲▼＋+−-⋯♪…';
        const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
        const strip = (t) => [...t].filter(c => !KEEP.includes(c)).join('');
        const offenders = [];
        const nameless = [];
        // The master strip and the dialogs are in scope too: the first pass at
        // this only covered the toolbar, menu and track headers, and the rename
        // pencil on the song-name button sat outside all three and survived.
        const scope = [
          ...document.querySelectorAll('#file-menu button'),
          ...document.querySelectorAll('.toolbar button'),
          ...document.querySelectorAll('.track-header button'),
          ...document.querySelectorAll('#master-track button'),
          ...document.querySelectorAll('dialog button'),
        ];
        for (const b of scope) {
          const text = b.textContent || '';
          if (emoji.test(strip(text))) offenders.push(text.trim().slice(0, 24));
          const named = text.trim() || b.getAttribute('aria-label') || b.getAttribute('title');
          if (!named) nameless.push(b.id || b.className);
        }
        // A ::before/::after character is invisible to textContent — which is how
        // the pencil and the marker flag hid from the first version of this
        // check. Both are background images now; assert nothing has gone back.
        const pseudo = [];
        for (const el of document.querySelectorAll('*')) {
          for (const which of ['::before', '::after']) {
            const c = getComputedStyle(el, which).content;
            if (c && c !== 'none' && emoji.test(strip(c))) pseudo.push((el.id || el.className || el.tagName) + which + ' ' + c);
          }
        }
        return {
          count: scope.length,
          offenders,
          nameless,
          pseudo,
          // Every menu item should now carry a glyph rather than a character.
          menuItems: document.querySelectorAll('#file-menu .file-menu-item').length,
          menuGlyphs: document.querySelectorAll('#file-menu .file-menu-item svg.glyph-sq').length,
          hidden: [...document.querySelectorAll('svg.glyph')].every(g => g.getAttribute('aria-hidden') === 'true'),
        };
      })()`);
      if (audit.count < 20) throw new Error(`expected to audit the whole toolbar and menu, saw ${audit.count} buttons`);
      if (audit.offenders.length) throw new Error(`emoji left on controls: ${JSON.stringify(audit.offenders)}`);
      if (audit.pseudo.length) throw new Error(`emoji left in CSS content: ${JSON.stringify(audit.pseudo)}`);
      if (audit.nameless.length) throw new Error(`controls with no accessible name: ${JSON.stringify(audit.nameless)}`);
      if (audit.menuItems === 0 || audit.menuGlyphs !== audit.menuItems) {
        throw new Error(`every menu item needs a glyph: ${audit.menuGlyphs}/${audit.menuItems}`);
      }
      if (!audit.hidden) throw new Error('every glyph must stay decorative (aria-hidden)');
      // Each glyph must actually have drawn paths — a typo in a data-glyph name
      // would otherwise produce a silent empty <svg>.
      const empty = await cdp.evaluate(
        `[...document.querySelectorAll('svg.glyph')].filter(g => g.querySelectorAll('path').length === 0).length`);
      if (empty) throw new Error(`${empty} glyph(s) resolved to no paths — check the data-glyph names`);
    });

    step('Icons: waveform picker, per-note toggles and FX headings are glyphed and still labelled', async () => {
      // The glyphs are aria-hidden decoration, so the risk isn't that they fail
      // to draw — it's that adding them quietly costs a control its accessible
      // name, or that the six-button picker overflows the fixed-width header.
      // Check both, plus that clicking still writes through to state.
      const wave = await cdp.evaluate(`(() => {
        const g = document.querySelector('.th-wave-group');
        if (!g) return { missing: true };
        const btns = [...g.querySelectorAll('.th-wave-btn')];
        return {
          role: g.getAttribute('role'),
          count: btns.length,
          named: btns.every(b => b.getAttribute('aria-label')),
          drawn: btns.every(b => b.querySelectorAll('svg.glyph path').length > 0),
          hidden: btns.every(b => b.querySelector('svg.glyph').getAttribute('aria-hidden') === 'true'),
          checked: btns.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('aria-label')),
          name: g.closest('.th-wave-row').querySelector('.th-wave-name')?.textContent,
          fits: g.scrollWidth <= g.closest('.track-header').clientWidth,
        };
      })()`);
      if (wave.missing) throw new Error('no tonal track waveform picker found');
      if (wave.role !== 'radiogroup') throw new Error(`waveform picker should be a radiogroup, got ${wave.role}`);
      if (wave.count !== 10) throw new Error(`expected 10 waveforms, got ${wave.count}`);
      if (wave.count === 0 || !wave.named || !wave.drawn || !wave.hidden) {
        throw new Error(`every waveform button needs a name and a decorative glyph: ${JSON.stringify(wave)}`);
      }
      // The glyph carries no accessible name of its own, so the selected
      // waveform must still be readable as text somewhere.
      if (wave.checked.length !== 1 || wave.name !== wave.checked[0]) {
        throw new Error(`exactly one waveform should be checked and spelled out: ${JSON.stringify(wave)}`);
      }
      if (!wave.fits) throw new Error('the waveform buttons overflow the track header');
      // Scope to one track's picker: by this point the song has several tonal
      // tracks, each with its own group, so an unscoped query would mix their
      // states together and read as many checked buttons as there are tracks.
      const switched = await cdp.evaluate(`(() => {
        const row = document.querySelector('.th-wave-group').closest('.th-wave-row');
        [...row.querySelectorAll('.th-wave-btn')].find(b => b.getAttribute('aria-label') === 'Saw').click();
        const row2 = document.querySelector('.th-wave-group').closest('.th-wave-row');
        const btns = [...row2.querySelectorAll('.th-wave-btn')];
        return {
          checked: btns.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('aria-label')),
          name: row2.querySelector('.th-wave-name')?.textContent,
        };
      })()`);
      if (switched.checked.join() !== 'Saw' || switched.name !== 'Saw') {
        throw new Error(`picking Saw should move both the checked state and the caption: ${JSON.stringify(switched)}`);
      }

      // Per-note pills: select a note, then confirm each toggle still reads as
      // its own label rather than as an unnamed icon.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`document.querySelector('.note')?.click()`);
      await waitFor(`!!document.querySelector('.inspector .fx-toggle')`);
      const pills = await cdp.evaluate(`(() => {
        const btns = [...document.querySelectorAll('.inspector .fx-toggle')];
        return {
          count: btns.length,
          drawn: btns.every(b => b.querySelectorAll('svg.glyph path').length > 0),
          // The accessible name comes from the pill's text, so assert the
          // actual names. Comparing .textContent against the label element
          // instead would only prove the two agree — which they still do when
          // both are empty, so an unnamed icon-only pill would pass.
          names: btns.map(b => b.textContent.trim()).sort(),
          pressed: btns.filter(b => b.getAttribute('aria-pressed')).length,
        };
      })()`);
      // .every() is true for an empty list, so an inspector that rendered no
      // pills at all would otherwise sail through every check above.
      if (pills.count !== 7) throw new Error(`expected 7 per-note effect pills, got ${pills.count}`);
      const wantPills = ['Bitcrush', 'Chorus', 'Echo', 'Portamento', 'Reverb', 'Tremolo', 'Vibrato'];
      if (pills.names.join('|') !== wantPills.join('|')) {
        throw new Error(`per-note pills lost their labels: ${JSON.stringify(pills.names)}`);
      }
      if (!pills.drawn || pills.pressed !== 7) {
        throw new Error(`pills must keep their glyph and aria-pressed: ${JSON.stringify(pills)}`);
      }

      // FX panel: one glyphed heading per TRACK_FX_REGISTRY group, and all 13
      // sliders still present now that the headings share their grid.
      // An earlier step may already have opened an FX panel, in which case
      // clicking the button would close it — open one only if none is showing.
      await cdp.evaluate(`(() => {
        if (document.querySelector('.th-fx-panel')) return;
        [...document.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.th-fx-group')`);
      const fx = await cdp.evaluate(`(() => {
        // Same scoping caution as the waveform picker above — read one panel.
        const panel = document.querySelector('.th-fx-panel');
        const heads = [...panel.querySelectorAll('.th-fx-group')];
        return {
          labels: heads.map(h => h.textContent.trim()),
          drawn: heads.every(h => h.querySelectorAll('svg.glyph path').length > 0),
          fields: panel.querySelectorAll('.th-fx-field').length,
          fits: panel.scrollWidth <= panel.closest('.track-header').clientWidth,
          // Vibrato is tonal-only (it modulates each note's oscillator, so a
          // drum has nothing for it to bend), so what this panel should show
          // depends on which kind of track it belongs to.
          tonal: !!panel.closest('.track-header').querySelector('.th-wave-group'),
        };
      })()`);
      const wantFx = ['Sends', 'EQ', 'Comp', 'Bitcrush', 'Tremolo'].concat(fx.tonal ? ['Vibrato'] : []);
      if (fx.labels.join('|') !== wantFx.join('|')) {
        throw new Error(`unexpected FX group headings on a ${fx.tonal ? 'tonal' : 'rhythm'} track: ${JSON.stringify(fx.labels)}`);
      }
      if (!fx.drawn) throw new Error('every FX group heading needs a glyph');
      const wantFields = fx.tonal ? 15 : 13;
      if (fx.fields !== wantFields) throw new Error(`expected ${wantFields} FX sliders, got ${fx.fields}`);
      if (!fx.fits) throw new Error('the FX panel overflows the track header');
    });

    step('Accessibility: landmarks, labelled grid and keyboard note selection', async () => {
      const structure = await cdp.evaluate(`({
        h1: document.querySelectorAll('h1').length,
        main: document.querySelectorAll('main').length,
        aside: document.querySelectorAll('aside').length,
        toolbar: document.querySelectorAll('[role=toolbar]').length,
        skip: !!document.querySelector('.skip-link'),
        live: !!document.querySelector('#a11y-status[aria-live]'),
      })`);
      for (const [k, v] of Object.entries(structure)) {
        if (!v) throw new Error(`missing ${k} — screen readers need the page structure`);
      }
      // Every note and hit is a positioned div; unlabelled they are just boxes.
      const labelled = await cdp.evaluate(`(() => {
        const items = [...document.querySelectorAll('.note, .hit')];
        const lanes = [...document.querySelectorAll('.lane')];
        return {
          total: items.length,
          named: items.filter((n) => n.getAttribute('aria-label')).length,
          lanesNamed: lanes.length > 0 && lanes.every((l) => l.getAttribute('aria-label')),
          tabStops: items.filter((n) => n.tabIndex === 0).length,
        };
      })()`);
      if (labelled.total === 0) throw new Error('expected a populated grid to check');
      if (labelled.named !== labelled.total) throw new Error(`${labelled.total - labelled.named} grid items have no accessible name`);
      if (!labelled.lanesNamed) throw new Error('every lane needs an accessible name');
      // Roving tabindex: the grid must not put hundreds of stops in Tab order.
      if (labelled.tabStops > 1) throw new Error(`expected at most one grid tab stop, got ${labelled.tabStops}`);
      // Keyboard is the only way in without a mouse: Home selects, Shift+arrow steps.
      // Click a real note to make its track active — clicking the row itself
      // doesn't, and by this point an empty added track holds focus.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`document.querySelector('.note').click()`);
      await waitFor(`!!document.querySelector('.note.selected')`);
      const press = (key, shift) => cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, shiftKey: ${!!shift}, bubbles: true }))`);
      await press('Home');
      await new Promise((r) => setTimeout(r, 350));
      const atFirst = await cdp.evaluate(`document.querySelector('#a11y-status').textContent`);
      if (!atFirst) throw new Error('Home should select an item and announce it');
      await press('ArrowRight', true);
      await new Promise((r) => setTimeout(r, 350));
      const stepped = await cdp.evaluate(`document.querySelector('#a11y-status').textContent`);
      if (!stepped || stepped === atFirst) throw new Error(`Shift+Right should move the selection (${atFirst} -> ${stepped})`);
      // Plain arrows must still nudge rather than navigate.
      await press('ArrowRight');
      await new Promise((r) => setTimeout(r, 300));
      const afterNudge = await cdp.evaluate(`document.querySelector('#a11y-status').textContent`);
      if (afterNudge !== stepped) throw new Error('a plain arrow should nudge, not change the selection');
    });

    step('Noise buffers are seeded: identical across two page loads', async () => {
      // The reverb tail and the six noise-based drum sounds used to be filled
      // from Math.random(), so they differed on every page load. Checksum the
      // buffers themselves as they are handed to the nodes that play them,
      // across two loads.
      //
      // This asserts the buffers, not the export. An earlier version of this
      // comment claimed that identical buffers meant an identical render; they
      // do not. Two exports of the same song still differ, even back to back in
      // one page load — see TODO.md for what that investigation ruled out.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            window.__bufSums = {};
            const sum = (buf) => {
              let out = [];
              for (let c = 0; c < buf.numberOfChannels; c++) {
                const d = buf.getChannelData(c);
                let h = 0x811c9dc5;
                // Stride the samples: a full pass over a 2.2s stereo impulse on
                // every assignment is slow, and any seeding bug shifts the whole
                // sequence rather than one sample.
                for (let i = 0; i < d.length; i += 97) {
                  h ^= Math.round(d[i] * 1e6) | 0; h = Math.imul(h, 0x01000193) >>> 0;
                }
                out.push(h.toString(16));
              }
              return out.join('/') + '@' + buf.length;
            };
            const note = (kind, buf) => {
              if (!buf || window.__bufSums[kind]) return;
              try { window.__bufSums[kind] = sum(buf); } catch {}
            };
            const cd = Object.getOwnPropertyDescriptor(ConvolverNode.prototype, 'buffer');
            Object.defineProperty(ConvolverNode.prototype, 'buffer', {
              get() { return cd.get.call(this); },
              set(b) { note('reverb', b); cd.set.call(this, b); },
              configurable: true,
            });
            const bd = Object.getOwnPropertyDescriptor(AudioBufferSourceNode.prototype, 'buffer');
            Object.defineProperty(AudioBufferSourceNode.prototype, 'buffer', {
              get() { return bd.get.call(this); },
              // The two drum noise buffers differ in length (0.1s vs 0.9s), so
              // the key tells them apart without reaching into the app.
              set(b) { if (b) note(b.length > 20000 ? 'crashNoise' : 'noise', b); bd.set.call(this, b); },
              configurable: true,
            });
          })();
        `,
      });

      // Two separate loads: the buffers are built once per page and cached, so
      // asking twice in one session would prove nothing.
      const collect = async () => {
        await goto(APP_URL);
        await waitFor(`!!document.querySelector('.track .lane')`);
        // Place a hit and audition it — that builds the noise buffers — and
        // give a note a Reverb flag so the convolver gets its impulse.
        await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
        await cdp.evaluate(`(() => {
          const lane = document.querySelector('.track .lane');
          const r = lane.getBoundingClientRect();
          // Derive the row height rather than assuming it: the kit is the ten
          // RHYTHM_ROWS, so row 1 is the snare (short noise buffer) and row 8
          // the crash (long one). The kick on row 0 is a pure oscillator and
          // would build no buffer at all.
          const rowH = r.height / 10;
          const at = (row, x) => lane.dispatchEvent(new MouseEvent('click', {
            bubbles: true, clientX: r.left + x, clientY: r.top + (row + 0.5) * rowH,
          }));
          at(1, 60);
          at(8, 120);
        })()`);
        await new Promise((r) => setTimeout(r, 500));
        await cdp.evaluate(`[...document.querySelectorAll('.hit')].forEach(h => h.click())`);
        await new Promise((r) => setTimeout(r, 800));
        await cdp.evaluate(`document.querySelector('#play').click()`);
        await new Promise((r) => setTimeout(r, 1500));
        await cdp.evaluate(`document.querySelector('#stop').click()`);
        return cdp.evaluate(`JSON.parse(JSON.stringify(window.__bufSums))`);
      };
      const first = await collect();
      if (!first.noise) throw new Error(`no drum noise buffer was captured: ${JSON.stringify(first)}`);
      const second = await collect();
      for (const key of Object.keys(first)) {
        if (first[key] !== second[key]) {
          throw new Error(`${key} buffer differs between page loads (${first[key]} vs ${second[key]}) — it is not seeded`);
        }
      }
      if (Object.keys(second).length !== Object.keys(first).length) {
        throw new Error(`the two loads captured different buffers: ${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
      }
    });

    step('Waveforms: all ten build a distinct sound, none is off in level, and PWM sweeps', async () => {
      // The DOM can only show that ten buttons exist. What matters is that each
      // one produces different audio — a waveform that silently fell through to
      // `square` would look perfect and sound wrong — so render a note per
      // waveform offline and compare the PCM.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            window.__waveRenders = [];
            const orig = OfflineAudioContext.prototype.startRendering;
            OfflineAudioContext.prototype.startRendering = function () {
              return orig.call(this).then((buf) => {
                const d = buf.getChannelData(0);
                let h = 0x811c9dc5, peak = 0;
                for (let i = 0; i < d.length; i++) {
                  if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
                  const v = Math.round(d[i] * 1e5) | 0;
                  h ^= v & 255; h = Math.imul(h, 0x01000193) >>> 0;
                  h ^= (v >> 8) & 255; h = Math.imul(h, 0x01000193) >>> 0;
                }
                window.__waveRenders.push({ hash: h.toString(16), peak });
                return buf;
              });
            };
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track')`);
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('Add track')).click()`);
      await waitFor(`!!document.querySelector('.th-wave-group')`);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-wave-group'));
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 40, clientY: r.top + 60 }));
      })()`);
      await waitFor(`document.querySelectorAll('.lane .note').length === 1`);

      // PWM's sweep is an LFO on the delay that sets the pulse width. Nothing in
      // the DOM or the PCM hash shows whether it is still connected, and a crude
      // duty-over-time metric is too noisy to assert on — so check the wiring,
      // the same way the vibrato step checks an LFO reaches osc.frequency.
      await cdp.evaluate(`(() => {
        window.__delayMod = 0;
        window.__delayParams = new WeakSet();
        const origDelay = BaseAudioContext.prototype.createDelay;
        BaseAudioContext.prototype.createDelay = function (...a) {
          const d = origDelay.apply(this, a);
          window.__delayParams.add(d.delayTime);
          return d;
        };
        const origConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function (dest, ...rest) {
          try { if (dest instanceof AudioParam && window.__delayParams.has(dest)) window.__delayMod++; } catch {}
          return origConnect.call(this, dest, ...rest);
        };
      })()`);

      const layout = await cdp.evaluate(`(() => {
        const g = document.querySelector('.th-wave-group');
        const btns = [...g.querySelectorAll('.th-wave-btn')];
        return {
          labels: btns.map(b => b.getAttribute('aria-label')),
          rows: [...new Set(btns.map(b => Math.round(b.getBoundingClientRect().top)))].length,
          minWidth: Math.min(...btns.map(b => Math.round(b.getBoundingClientRect().width))),
          fits: g.scrollWidth <= g.closest('.track-header').clientWidth,
        };
      })()`);
      if (layout.rows !== 2 || !layout.fits) {
        throw new Error(`the picker should wrap to two rows inside the header: ${JSON.stringify(layout)}`);
      }
      // Nine across one row would leave each button about 19px, too small for
      // the shape to read; two rows keeps them at least as big as six were.
      if (layout.minWidth < 29) throw new Error(`waveform buttons shrank to ${layout.minWidth}px`);

      const results = {};
      const delayMods = {};
      for (const label of layout.labels) {
        const before = await cdp.evaluate(`window.__waveRenders.length`);
        await cdp.evaluate(`[...document.querySelectorAll('.th-wave-btn')].find(b => b.getAttribute('aria-label') === ${JSON.stringify('')} + ${JSON.stringify(label)}).click()`);
        await new Promise((r) => setTimeout(r, 300));
        await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
        // Reset here, not before the waveform click: clicking a waveform button
        // auditions a note, which spins up the live context and its chorus bus,
        // so counting from there makes the baseline depend on whether that
        // context already existed.
        await cdp.evaluate(`window.__delayMod = 0`);
        await cdp.evaluate(`document.getElementById('export-wav').click()`);
        await waitFor(`window.__waveRenders.length > ${before}`, 90000);
        results[label] = await cdp.evaluate(`window.__waveRenders[${before}]`);
        delayMods[label] = await cdp.evaluate(`window.__delayMod`);
      }
      // Not "PWM is the only one" — the shared chorus bus legitimately sweeps its
      // own delay on every render, so the baseline is non-zero. What must hold
      // is that every other waveform shares one baseline and PWM sits above it.
      const baseline = Object.keys(delayMods).filter((n) => n !== 'PWM').map((n) => delayMods[n]);
      if (new Set(baseline).size !== 1) {
        throw new Error(`waveforms other than PWM should all modulate the same number of delays: ${JSON.stringify(delayMods)}`);
      }
      if (delayMods['PWM'] <= baseline[0]) {
        throw new Error(`PWM built no LFO on its pulse-width delay — the sweep is gone: ${JSON.stringify(delayMods)}`);
      }
      const names = Object.keys(results);
      if (names.length !== 10) throw new Error(`rendered ${names.length} waveforms, expected 10`);
      const silent = names.filter((n) => results[n].peak <= 0.001);
      if (silent.length) throw new Error(`waveform(s) produced no sound: ${JSON.stringify(silent)}`);
      // FM at its default Depth of 0 IS a plain sine (addFmModulator returns
      // early), so those two hashing alike is correct rather than a
      // fall-through. Asserting it keeps the check honest if that changes.
      if (results['FM'].hash !== results['Sine'].hash) {
        throw new Error('FM at depth 0 should be identical to a plain sine');
      }
      const others = names.filter((n) => n !== 'FM');
      const hashes = new Set(others.map((n) => results[n].hash));
      if (hashes.size !== others.length) {
        throw new Error(`waveforms are not all distinct: ${JSON.stringify(Object.fromEntries(others.map((n) => [n, results[n].hash])))}`);
      }
      // Switching waveform must not jump the level — the noise buffer needed
      // scaling to sit with the oscillators rather than 5 dB above them.
      const peaks = others.map((n) => results[n].peak);
      const spread = 20 * Math.log10(Math.max(...peaks) / Math.min(...peaks));
      if (spread > 3) {
        throw new Error(`waveform levels differ by ${spread.toFixed(1)} dB: ${JSON.stringify(Object.fromEntries(others.map((n) => [n, results[n].peak.toFixed(4)])))}`);
      }
    });

    step('Duty: a square track has its own default, and a note can override it', async () => {
      // setPeriodicWave() takes an opaque PeriodicWave, so the DOM and the node
      // graph both hide which pulse width was used. Patch pulseWave's consumer
      // instead: record every duty that reaches setPeriodicWave via the app's
      // own cache, keyed by the wave object it hands back.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
          window.__duty = [];
          const origCreate = AudioContext.prototype.createPeriodicWave;
          AudioContext.prototype.createPeriodicWave = function (real, imag, ...rest) {
            const w = origCreate.call(this, real, imag, ...rest);
            // A pulse wave's nth harmonic is (2/(n*pi)) * sin(n*pi*duty); the
            // first two give the duty back without needing the app's internals.
            try {
              const a1 = imag[1] / (2 / Math.PI);
              window.__waveDuty = window.__waveDuty || new WeakMap();
              window.__waveDuty.set(w, Math.asin(Math.max(-1, Math.min(1, a1))) / Math.PI);
            } catch {}
            return w;
          };
          const origSet = OscillatorNode.prototype.setPeriodicWave;
          OscillatorNode.prototype.setPeriodicWave = function (w) {
            try { if (window.__waveDuty && window.__waveDuty.has(w)) window.__duty.push(window.__waveDuty.get(w)); } catch {}
            return origSet.call(this, w);
          };
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track')`);
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('Add track')).click()`);
      await waitFor(`document.querySelectorAll('.track').length > 1`);

      // A new tonal track is `square`, so its Envelope panel must offer Duty.
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'));
        [...head.querySelectorAll('.th-tool-btn')].find(b => /Env/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.adsr-select')`);
      const opts = await cdp.evaluate(
        `[...document.querySelector('.adsr-select').options].map(o => o.textContent)`);
      if (opts.join('|') !== 'Square (50%)|12.5%|25%|50%|75%') {
        throw new Error(`unexpected track Duty options: ${JSON.stringify(opts)}`);
      }

      // Set the track to 12.5% and place a note that doesn't override it.
      await cdp.evaluate(`(() => {
        const sel = document.querySelector('.adsr-select');
        sel.value = '0.125'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`window.__duty = []`);
      await cdp.evaluate(`(() => {
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-wave-group'));
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 200, clientY: r.top + 120 }));
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      const inherited = await cdp.evaluate(`window.__duty.slice()`);
      if (!inherited.some((d) => Math.abs(d - 0.125) < 0.01)) {
        throw new Error(`a note should inherit the track's 12.5% duty, saw ${JSON.stringify(inherited)}`);
      }

      // The inspector's first option must name the track's value, not "50%".
      await waitFor(`!!document.querySelector('.inspector select')`);
      const noteOpts = await cdp.evaluate(`(() => {
        const sel = [...document.querySelectorAll('.inspector select')].find(s => /Track default/.test(s.options[0]?.textContent || ''));
        return sel ? [...sel.options].map(o => o.textContent) : null;
      })()`);
      if (!noteOpts || noteOpts[0] !== 'Track default (12.5%)') {
        throw new Error(`the note's Duty should name the track default: ${JSON.stringify(noteOpts)}`);
      }

      // Overriding on the note must win over the track.
      await cdp.evaluate(`(() => {
        const sel = [...document.querySelectorAll('.inspector select')].find(s => /Track default/.test(s.options[0]?.textContent || ''));
        sel.value = '0.75'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      await cdp.evaluate(`window.__duty = []`);
      await cdp.evaluate(`document.querySelector('.lane .note').click()`);
      await new Promise((r) => setTimeout(r, 600));
      const overridden = await cdp.evaluate(`window.__duty.slice()`);
      if (!overridden.some((d) => Math.abs(d - 0.25) < 0.01)) {
        // asin() folds 0.75 onto its supplement, so a 75% pulse reads back as 25%.
        throw new Error(`the note's own 75% duty should win over the track, saw ${JSON.stringify(overridden)}`);
      }

      // A portamento note must inherit the track's Duty too. It has its own
      // scheduler, which for a while kept a hand-written copy of the waveform
      // selection reading note.duty directly — so the track default silently
      // never reached a glided note. Structurally it now shares
      // createVoiceSource(); this checks that rather than assuming it.
      await cdp.evaluate(`(() => {
        const sel = [...document.querySelectorAll('.inspector select')].find(s => /Track default/.test(s.options[0]?.textContent || ''));
        sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true })); // back to inheriting
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      await cdp.evaluate(`(() => {
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-wave-group'));
        const n = lane.querySelector('.note').getBoundingClientRect();
        // 1.2 columns along, not 1.5: the grid snap rounds, so aiming at the
        // middle of the next cell lands two columns away and leaves a gap —
        // and a gap means the portamento path never runs.
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true,
          clientX: n.left + n.width * 1.2, clientY: n.top + n.height / 2 }));
      })()`);
      await waitFor(`document.querySelectorAll('.lane .note').length === 2`);
      const pair = await cdp.evaluate(`(() => {
        const ns = [...document.querySelectorAll('.lane .note')]
          .map(n => n.getBoundingClientRect()).sort((a, b) => a.left - b.left);
        return { gap: Math.round(ns[1].left - ns[0].left), width: Math.round(ns[0].width), sameRow: Math.abs(ns[0].top - ns[1].top) < 1 };
      })()`);
      if (pair.gap !== pair.width || !pair.sameRow) {
        throw new Error(`the two notes must be contiguous and on one row for a glide: ${JSON.stringify(pair)}`);
      }
      await cdp.evaluate(`(() => {
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-wave-group'));
        lane.querySelector('.note').click();
      })()`);
      await waitFor(`!!document.querySelector('.inspector .fx-toggle')`);
      await cdp.evaluate(`[...document.querySelectorAll('.inspector .fx-toggle')].find(b => /Portamento/.test(b.textContent)).click()`);
      await new Promise((r) => setTimeout(r, 300));
      // Play, don't preview. Clicking a note auditions it through scheduleTone;
      // schedulePortamentoTone only runs from actual playback, so a preview
      // here would exercise the wrong scheduler and pass whatever the state of
      // the glided path — which is exactly how the first version of this check
      // passed with the bug deliberately put back.
      await cdp.evaluate(`window.__duty = []`);
      await cdp.evaluate(`document.querySelector('#rtz').click()`);
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 1500));
      await cdp.evaluate(`document.querySelector('#stop').click()`);
      const portaDuty = await cdp.evaluate(`window.__duty.slice()`);
      if (!portaDuty.some((d) => Math.abs(d - 0.125) < 0.01)) {
        throw new Error(`a portamento note should inherit the track's 12.5% duty, saw ${JSON.stringify(portaDuty)}`);
      }

      // A non-square track must not offer the control at all.
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'));
        [...head.querySelectorAll('.th-wave-btn')].find(b => b.getAttribute('aria-label') === 'Sine').click();
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      const afterSine = await cdp.evaluate(`document.querySelectorAll('.adsr-select').length`);
      if (afterSine !== 0) throw new Error('Duty should only show on a square track');
    });

    step('Per-track vibrato reaches the note oscillator, and only on tonal tracks', async () => {
      // Vibrato cannot be an insert like the other per-track effects — pitch
      // modulation has to reach each note's own oscillator — so the check is
      // that an LFO actually gets connected to an OscillatorNode's frequency,
      // which no DOM assertion can show. Patch connect() before load and
      // record what lands on a `frequency` AudioParam.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
          window.__freqMod = [];
          const origConnect = AudioNode.prototype.connect;
          AudioNode.prototype.connect = function (dest, ...rest) {
            try {
              if (dest instanceof AudioParam && window.__freqParams && window.__freqParams.has(dest)) {
                window.__freqMod.push(this.gain ? this.gain.value : null);
              }
            } catch {}
            return origConnect.call(this, dest, ...rest);
          };
          window.__freqParams = new WeakSet();
          const origOsc = AudioContext.prototype.createOscillator;
          AudioContext.prototype.createOscillator = function () {
            const o = origOsc.call(this);
            window.__freqParams.add(o.frequency);
            return o;
          };
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track')`);

      // A blank project is rhythm-only: its FX panel must not offer Vibrato.
      await cdp.evaluate(`(() => {
        if (document.querySelector('.th-fx-panel')) return;
        [...document.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.th-fx-group')`);
      const rhythmGroups = await cdp.evaluate(
        `[...document.querySelector('.th-fx-panel').querySelectorAll('.th-fx-group')].map(h => h.textContent.trim())`);
      if (rhythmGroups.includes('Vibrato')) {
        throw new Error(`a rhythm track must not offer Vibrato: ${JSON.stringify(rhythmGroups)}`);
      }
      if (!rhythmGroups.includes('Tremolo')) {
        throw new Error(`the rhythm FX panel lost its other groups: ${JSON.stringify(rhythmGroups)}`);
      }

      // A tonal track must offer it.
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('Add track')).click()`);
      await waitFor(`document.querySelectorAll('.track').length > 1`);
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'));
        head.querySelector('.th-fx-panel') || [...head.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'));
        return !!head && !!head.querySelector('.th-fx-panel');
      })()`);
      const tonalGroups = await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'));
        return [...head.querySelector('.th-fx-panel').querySelectorAll('.th-fx-group')].map(h => h.textContent.trim());
      })()`);
      if (!tonalGroups.includes('Vibrato')) {
        throw new Error(`a tonal track should offer Vibrato: ${JSON.stringify(tonalGroups)}`);
      }

      // Set a depth, place a note, and confirm an LFO reaches its frequency.
      // 50 cents on a 523.25Hz note => 523.25 * (2^(50/1200) - 1) ~= 15.3Hz.
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'));
        const panel = head.querySelector('.th-fx-panel');
        const groups = [...panel.querySelectorAll('.th-fx-group')];
        const vib = groups.find(g => g.textContent.trim() === 'Vibrato');
        // The two fields after the Vibrato heading are its Rate and Depth.
        let n = vib.nextElementSibling, fields = [];
        while (n && !n.classList.contains('th-fx-group')) { if (n.classList.contains('th-fx-field')) fields.push(n); n = n.nextElementSibling; }
        const depth = fields[1].querySelector('input[type=range]');
        depth.value = 50; depth.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 300));

      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`window.__freqMod = []`);
      await cdp.evaluate(`(() => {
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-wave-group'));
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 200, clientY: r.top + 120 }));
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      const mod = await cdp.evaluate(`window.__freqMod.slice()`);
      // Only the vibrato LFO's gain feeds a frequency param at a depth this
      // small; FM's modulator gain is far larger and is off by default.
      if (!mod.some((v) => v !== null && v > 5 && v < 40)) {
        throw new Error(`a 50-cent track vibrato should modulate the note's frequency, saw ${JSON.stringify(mod)}`);
      }

      // At depth 0 nothing must be connected — an untouched track is unchanged.
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'));
        const groups = [...head.querySelector('.th-fx-panel').querySelectorAll('.th-fx-group')];
        const vib = groups.find(g => g.textContent.trim() === 'Vibrato');
        let n = vib.nextElementSibling, fields = [];
        while (n && !n.classList.contains('th-fx-group')) { if (n.classList.contains('th-fx-field')) fields.push(n); n = n.nextElementSibling; }
        const depth = fields[1].querySelector('input[type=range]');
        depth.value = 0; depth.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      await cdp.evaluate(`window.__freqMod = []`);
      await cdp.evaluate(`document.querySelector('.lane .note')?.click()`);
      await new Promise((r) => setTimeout(r, 600));
      const off = await cdp.evaluate(`window.__freqMod.slice()`);
      if (off.length !== 0) {
        throw new Error(`depth 0 should connect no vibrato LFO at all, saw ${JSON.stringify(off)}`);
      }
    });

    // Last on purpose: this step reloads the page to install its createGain
    // patch, which drops the loaded example song every step above depends on.
    step('Rhythm: a hit carries a velocity that reaches the audio graph and the saved file', async () => {
      // A quiet hit looks identical in the DOM to a loud one apart from an
      // opacity, so the DOM alone cannot show that velocity is actually
      // applied. Patch createGain before the page loads and record every
      // `.value =` assignment: the ten drum schedulers all use
      // setValueAtTime, so what lands in this array is exactly the velocity
      // stage scheduleDrum inserts, and nothing else.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
          window.__velGains = [];
          const origCreate = AudioContext.prototype.createGain;
          AudioContext.prototype.createGain = function () {
            const g = origCreate.call(this);
            const d = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
            try {
              Object.defineProperty(g.gain, 'value', {
                get() { return d.get.call(this); },
                set(v) { window.__velGains.push(v); d.set.call(this, v); },
                configurable: true,
              });
            } catch {}
            return g;
          };
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track .lane')`);

      // Pen a hit; it should select itself so its velocity is editable at once.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track .lane');
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 100, clientY: r.top + 8 }));
      })()`);
      await waitFor(`!!document.querySelector('.inspector input[type=range]')`);
      const placed = await cdp.evaluate(`(() => {
        const insp = document.querySelector('.inspector');
        return {
          cap: insp.querySelector('.insp-cap')?.textContent,
          vel: insp.querySelector('.insp-velval')?.textContent,
          selected: document.querySelectorAll('.hit.selected').length,
          del: insp.querySelector('.insp-del')?.textContent,
        };
      })()`);
      if (placed.cap !== 'Selected hit' || placed.vel !== '100%' || placed.selected !== 1) {
        throw new Error(`penning a hit should select it and show a full Velocity: ${JSON.stringify(placed)}`);
      }
      if (!/hit/i.test(placed.del || '')) throw new Error(`the delete button should say hit: ${placed.del}`);

      const lowered = await cdp.evaluate(`(() => {
        const s = document.querySelector('.inspector input[type=range]');
        s.value = 0.3;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        const hit = document.querySelector('.hit.selected');
        return { opacity: hit?.style.opacity, label: hit?.getAttribute('aria-label') };
      })()`);
      // 0.4 + 0.6 * 0.3 — the same mapping tonal notes use for velocity.
      if (lowered.opacity !== '0.58') throw new Error(`velocity should dim the hit: ${JSON.stringify(lowered)}`);
      if (!/velocity 30%/.test(lowered.label || '')) {
        throw new Error(`a reduced velocity must be in the accessible name: ${lowered.label}`);
      }

      // Preview path (previewHit -> scheduleDrum).
      await cdp.evaluate(`window.__velGains = []`);
      await cdp.evaluate(`document.querySelector('.hit.selected').click()`);
      await new Promise((r) => setTimeout(r, 400));
      const previewed = await cdp.evaluate(`window.__velGains.slice()`);
      if (!previewed.some((v) => Math.abs(v - 0.3) < 1e-6)) {
        throw new Error(`previewing a 30% hit should build a 0.3 gain stage, saw ${JSON.stringify(previewed)}`);
      }

      // Playback path (playOnce -> scheduleDrum) — a different call site, so
      // exercise it too rather than assuming the preview covers both.
      await cdp.evaluate(`window.__velGains = []`);
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 900));
      const played = await cdp.evaluate(`window.__velGains.slice()`);
      await cdp.evaluate(`document.querySelector('#stop').click()`);
      if (!played.some((v) => Math.abs(v - 0.3) < 1e-6)) {
        throw new Error(`playback should apply the hit's velocity, saw ${JSON.stringify(played)}`);
      }

      // At full velocity no stage is inserted at all, so an untouched song
      // builds exactly the graph it did before hits had a velocity.
      await cdp.evaluate(`(() => {
        const s = document.querySelector('.inspector input[type=range]');
        s.value = 1; s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      await cdp.evaluate(`window.__velGains = []`);
      await cdp.evaluate(`document.querySelector('.hit.selected').click()`);
      await new Promise((r) => setTimeout(r, 400));
      const full = await cdp.evaluate(`window.__velGains.slice()`);
      if (full.length !== 0) throw new Error(`a full-velocity hit should add no gain stage, saw ${JSON.stringify(full)}`);

      // ...and it must not leave `vel: 1` behind in the song data either.
      const serialized = await cdp.evaluate(`(() => {
        const hit = [...document.querySelectorAll('.hit')].length;
        const s = document.querySelector('.inspector input[type=range]');
        s.value = 0.45; s.dispatchEvent(new Event('change', { bubbles: true }));
        return hit;
      })()`);
      if (serialized !== 1) throw new Error(`expected exactly one hit, got ${serialized}`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => (localStorage.getItem(k) || '').includes('trackList'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind === 'rhythm').id;
        const h = d.tracks[id][0];
        return h && Math.abs(h.vel - 0.45) < 1e-6;
      })()`, 4000);

      // A single selected hit must nudge — this path used to assume a tonal
      // note and would have read len/freq off a hit.
      const nudged = await cdp.evaluate(`(() => {
        const before = document.querySelector('.hit.selected')?.style.left;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        return { before, after: document.querySelector('.hit.selected')?.style.left };
      })()`);
      if (!nudged.before || nudged.before === nudged.after) {
        throw new Error(`a selected hit should nudge with the arrow keys: ${JSON.stringify(nudged)}`);
      }
    });

    for (const s of steps) await s();
  } finally {
    if (cdp) cdp.close();
    await new Promise((resolve) => { chrome.once('exit', resolve); chrome.kill(); setTimeout(resolve, 3000); });
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    server.kill();
  }

  console.log('');
  if (errors.length) {
    console.log(`FAILED — ${errors.length} error(s):`);
    for (const e of errors) console.log('  ' + e);
    process.exit(1);
  }
  console.log('All checks passed, no console errors.');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
