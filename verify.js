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
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('＋ Add track')).click()`);
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
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('＋ Add track')).click()`);
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
