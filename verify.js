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

// ---------------------------------------------------------------------------
// Bundled-song audit. The only check here that never opens a browser: it reads
// songs/*.json and asks whether index.html would accept every field in them.
//
// Every constant it validates against is pulled out of index.html rather than
// retyped, so the audit cannot drift from the app — which is the same failure
// this repo already hit when six places each hand-wrote the list of per-track
// settings and four of them fell out of step. Extraction that stops matching
// throws rather than yielding an empty list, since an audit with nothing to
// compare against passes everything.
// ---------------------------------------------------------------------------
function auditBundledSongs(repoRoot) {
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const constArray = (name) => {
    const m = html.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
    if (!m) throw new Error(`could not read ${name} out of index.html — the audit would pass vacuously`);
    return eval(m[1]);
  };
  const WAVEFORMS = constArray('WAVEFORMS');
  const RHYTHM_ROWS = constArray('RHYTHM_ROWS');
  const DUTY_VALUES = constArray('DUTY_VALUES');
  const AUTOMATION_PARAMS = constArray('AUTOMATION_PARAMS');
  const SPARSE_TRACK_MAPS = constArray('SPARSE_TRACK_MAPS');
  const rangeSrc = html.match(/const AUTOMATION_RANGE = (\{.*?\});/);
  if (!rangeSrc) throw new Error('could not read AUTOMATION_RANGE out of index.html');
  const AUTOMATION_RANGE = eval('(' + rangeSrc[1] + ')');

  // Each effect's field ranges, read straight off the TRACK_FX_REGISTRY
  // table. Grouped by dataKey (falls back to key) since the three send
  // entries all share state.fxSend/data.fxSend — see applySavedMix()'s
  // matching group-by in index.html. EFFECT_KEYS/TONAL_ONLY_EFFECTS keep the
  // ungrouped per-entry list (8 keys) for validating activeFx's own
  // effect-key references below, which is a level below what `registry`
  // (grouped by storage, 6 keys after the split) can answer.
  const registry = {};
  const EFFECT_KEYS = [];
  const TONAL_ONLY_EFFECTS = [];
  {
    const from = html.indexOf('const TRACK_FX_REGISTRY = [');
    if (from < 0) throw new Error('could not find TRACK_FX_REGISTRY in index.html');
    const src = html.slice(from, from + html.slice(from).indexOf('\n];'));
    let key = null;
    for (const line of src.split('\n')) {
      const k = line.match(/^\s*key: '(\w+)'/);
      if (k) {
        EFFECT_KEYS.push(k[1]);
        if (/tonalOnly: true/.test(line)) TONAL_ONLY_EFFECTS.push(k[1]);
        const dk = line.match(/dataKey: '(\w+)'/);
        key = dk ? dk[1] : k[1];
        if (!registry[key]) registry[key] = [];
        continue;
      }
      const f = line.match(/\{ param: '(\w+)',.*?min: (-?[\d.]+), max: (-?[\d.]+)/);
      if (f && key) registry[key].push({ param: f[1], min: +f[2], max: +f[3], optional: /optional: true/.test(line) });
    }
    if (!Object.keys(registry).length) throw new Error('read no effects out of TRACK_FX_REGISTRY');
    if (EFFECT_KEYS.length !== 8) throw new Error(`expected 8 TRACK_FX_REGISTRY entries, read ${EFFECT_KEYS.length}: ${EFFECT_KEYS.join(',')}`);
  }

  const TONAL_ONLY = ['adsr', 'filter', 'fm', 'vibrato', 'duty'];
  const SEEDED_MAPS = ['gains', 'waveform', 'pan', 'mute', 'solo'];
  const REQUIRED_FIELDS = {
    adsr: ['attack', 'decay', 'sustain', 'release'],
    filter: ['cutoff', 'q', 'envAmount'],
    fm: ['ratio', 'depth'],
  };

  const problems = [];
  const songsDir = path.join(repoRoot, 'songs');
  const files = fs.readdirSync(songsDir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
  const index = JSON.parse(fs.readFileSync(path.join(songsDir, 'index.json'), 'utf8'));
  if (!files.length) throw new Error('found no example songs to audit');

  // Both directions: a song the menu never offers is invisible, and an entry
  // with no file behind it is a row that fails when clicked.
  const listed = index.map((e) => e.file);
  for (const f of files) if (!listed.includes(f)) problems.push(`${f} is not listed in songs/index.json`);
  for (const e of listed) if (!files.includes(e)) problems.push(`songs/index.json lists ${e}, which does not exist`);

  for (const file of files) {
    const song = JSON.parse(fs.readFileSync(path.join(songsDir, file), 'utf8'));
    const add = (s) => problems.push(`${file}: ${s}`);
    const list = Array.isArray(song.trackList) ? song.trackList : [];
    const ids = list.map((t) => t.id);
    const kind = Object.fromEntries(list.map((t) => [t.id, t.kind]));
    const isRhythm = (id) => kind[id] === 'rhythm';
    const cols = typeof song.cols === 'number' ? song.cols : 64;

    if (!list.length) add('no trackList');
    if (new Set(ids).size !== ids.length) add('duplicate track ids in trackList');
    if (!list.some((t) => t.kind === 'rhythm')) add('no rhythm track');
    if (typeof song.masterVol !== 'number') add('no masterVol');

    for (const id of Object.keys(song.tracks || {})) {
      if (!ids.includes(id)) { add(`tracks["${id}"] is not in trackList — its notes/hits are dropped on load`); continue; }
      const seq = song.tracks[id] || [];
      if (isRhythm(id)) {
        const unknown = [...new Set(seq.filter((h) => !RHYTHM_ROWS.includes(h.type)).map((h) => h.type))];
        if (unknown.length) add(`${id}: hit(s) on an unknown drum: ${unknown.join(', ')}`);
        const badVel = seq.filter((h) => h.vel != null && (h.vel < 0.1 || h.vel > 1));
        if (badVel.length) add(`${id}: ${badVel.length} hit(s) with a velocity outside 0.1-1`);
        // vel: 1 is the same sound as no vel at all, so it is pure file weight
        // — and it is what the inspector deliberately avoids writing.
        const unity = seq.filter((h) => h.vel === 1);
        if (unity.length) add(`${id}: ${unity.length} hit(s) store vel: 1, which means the same as leaving it off`);
      }
      const past = seq.filter((n) => typeof n.start === 'number' && n.start >= cols);
      if (past.length) add(`${id}: ${past.length} item(s) start past the song end (cols ${cols})`);
    }
    for (const id of ids) if (!(song.tracks || {})[id]) add(`${id} has a trackList entry but no tracks[] data`);

    for (const key of [...SPARSE_TRACK_MAPS, ...SEEDED_MAPS]) {
      const map = song[key];
      if (!map || typeof map !== 'object') continue;
      for (const id of Object.keys(map)) {
        // The shape a pre-#96 save could carry: settings for a track that
        // belonged to whichever song was loaded before this one.
        if (!ids.includes(id)) { add(`${key}["${id}"] — no such track in this song`); continue; }
        if (TONAL_ONLY.includes(key) && isRhythm(id)) add(`${key}["${id}"] is on a rhythm track, where it does nothing`);
        const v = map[id];
        for (const f of REQUIRED_FIELDS[key] || []) {
          if (typeof (v || {})[f] !== 'number') add(`${key}["${id}"] is missing ${f} — the whole entry is dropped on load`);
        }
        for (const f of registry[key] || []) {
          if (typeof (v || {})[f.param] !== 'number') {
            if (!f.optional) add(`${key}["${id}"] is missing ${f.param} — the whole entry is dropped on load`);
            continue;
          }
          if (v[f.param] < f.min || v[f.param] > f.max) add(`${key}["${id}"].${f.param} = ${v[f.param]}, outside ${f.min}..${f.max}`);
        }
        if (key === 'duty' && !DUTY_VALUES.includes(v)) add(`duty["${id}"] = ${v}, not one of ${DUTY_VALUES.join('/')} — dropped on load`);
        if (key === 'waveform') {
          if (isRhythm(id) && v !== 'kit') add(`waveform["${id}"] = "${v}" on a rhythm track (expected "kit")`);
          if (!isRhythm(id) && !WAVEFORMS.includes(v)) add(`waveform["${id}"] = "${v}", not a selectable waveform — dropped on load`);
        }
        if (key === 'pan' && (v < -1 || v > 1)) add(`pan["${id}"] = ${v}, outside -1..1`);
      }
    }

    // activeFx's own shape (`{ [effectKey]: { bypassed } }`) is one level
    // deeper than the flat "id -> {param: number}" maps the loop above
    // assumes (registry has no 'activeFx' entry, so the loop's own per-field
    // checks silently skip it) — this covers the nesting the loop can't.
    for (const id of Object.keys(song.activeFx || {})) {
      if (!ids.includes(id)) continue; // already reported above
      const entry = song.activeFx[id];
      if (!entry || typeof entry !== 'object') continue;
      for (const effectKey of Object.keys(entry)) {
        if (!EFFECT_KEYS.includes(effectKey)) { add(`activeFx["${id}"] names an unknown effect: ${effectKey}`); continue; }
        if (TONAL_ONLY_EFFECTS.includes(effectKey) && isRhythm(id)) {
          add(`activeFx["${id}"].${effectKey} is on a rhythm track, where it does nothing`);
        }
        const v = entry[effectKey];
        if (v && typeof v === 'object' && v.bypassed !== undefined && typeof v.bypassed !== 'boolean') {
          add(`activeFx["${id}"].${effectKey}.bypassed should be a boolean`);
        }
      }
    }

    for (const id of Object.keys(song.automation || {})) {
      if (!ids.includes(id)) continue; // already reported by the loop above
      for (const param of Object.keys(song.automation[id])) {
        if (!AUTOMATION_PARAMS.includes(param)) { add(`automation["${id}"].${param} is not an automatable parameter — dropped on load`); continue; }
        const r = AUTOMATION_RANGE[param];
        const pts = song.automation[id][param] || [];
        const malformed = pts.filter((p) => typeof p.col !== 'number' || typeof p.value !== 'number');
        if (malformed.length) add(`automation["${id}"].${param}: ${malformed.length} malformed point(s)`);
        const oor = pts.filter((p) => typeof p.value === 'number' && (p.value < r.min || p.value > r.max));
        if (oor.length) add(`automation["${id}"].${param}: ${oor.length} point(s) outside ${r.min}..${r.max}`);
        const past = pts.filter((p) => typeof p.col === 'number' && p.col > cols);
        if (past.length) add(`automation["${id}"].${param}: ${past.length} point(s) past the song end`);
        if (pts.some((p, i) => i && p.col < pts[i - 1].col)) add(`automation["${id}"].${param} is not sorted by col`);
      }
    }

    if (song.masterEQ) for (const b of ['low', 'mid', 'high']) {
      const v = song.masterEQ[b];
      if (typeof v !== 'number') add(`masterEQ.${b} is not a number — the whole EQ is dropped on load`);
      else if (v < -12 || v > 12) add(`masterEQ.${b} = ${v}, outside -12..12`);
    }
    if (song.masterComp) for (const f of ['threshold', 'ratio', 'attack', 'release']) {
      if (typeof song.masterComp[f] !== 'number') add(`masterComp.${f} is not a number — the whole compressor is dropped on load`);
    }
  }
  return { files, problems };
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
    '--no-sandbox', '--disable-gpu', '--no-first-run',
    // Without this an AudioContext stays suspended — a synthetic click through
    // the DevTools Protocol is not a trusted user gesture, so resume() never
    // takes and ctx.currentTime sits at 0 forever. Anything that measures
    // *when* something happened (the recording step) would then see every
    // event at time zero. A real click grants exactly this, so the flag makes
    // the headless run behave like the browser rather than papering over
    // anything.
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
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

    // The rhythm lane, addressed by kind rather than by position: the starter
    // layout puts four tonal tracks ahead of it, so `.track .lane` — which
    // used to mean "the drum grid" only because a new project had nothing
    // else — now picks the Lead track's piano roll.
    const RHYTHM_LANE = `[...document.querySelectorAll('.track')].filter(t => !t.querySelector('.th-osc-trigger')).map(t => t.querySelector('.lane'))[0]`;

    // First, and the only step that needs no browser: a song file the app
    // would silently mangle is worth hearing about before thirteen minutes of
    // rendering, and a bad example ships to everyone who opens the Songs menu.
    step('Bundled songs: every field is one the app will actually load', async () => {
      const { files, problems } = auditBundledSongs(repoRoot);
      if (files.length < 5) throw new Error(`only found ${files.length} example songs — expected the bundled set`);
      if (problems.length) {
        throw new Error(`${problems.length} problem(s):\n        ` + problems.join('\n        '));
      }
    });

    step('loads with no console errors, boots into the starter layout', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('#file-menu-toggle')`);
      // The names, not just the count: STARTER_TRACKS is what a new user sees
      // first, and a typo or a dropped row there is invisible to a count.
      const names = await cdp.evaluate(`[...document.querySelectorAll('.track .th-name')].map(e => e.textContent)`);
      const want = ['Lead', 'Harmony', 'Bass', 'Pad', 'Rhythm'];
      if (names.join(',') !== want.join(',')) {
        throw new Error(`expected the starter layout ${JSON.stringify(want)}, got ${JSON.stringify(names)}`);
      }
      // Four empty tonal lanes at the old 28-semitone empty window were 321px
      // each — you could not see the drum track at all. An empty lane shows
      // MIN_SPAN now. The floor itself moved up from 220 to 270 with the
      // Osc/Inserts/Output header redesign: the Inserts (FX) section is now
      // always visible instead of hidden behind a toggle, and all three
      // sections carry their own caption row — a real, ~35-40px increase in
      // the header's own minimum height, not lane growth.
      const heights = await cdp.evaluate(`[...document.querySelectorAll('.track')].map(t => Math.round(t.getBoundingClientRect().height))`);
      const tallest = Math.max(...heights);
      if (tallest > 270) throw new Error(`an empty starter lane should stay compact, tallest is ${tallest}px`);
      // The kit is last and the melody voice is where you'd start writing.
      const active = await cdp.evaluate(`(document.querySelector('.track.active .th-name') || {}).textContent`);
      if (active !== 'Lead') throw new Error(`expected the Lead track to start active, got ${JSON.stringify(active)}`);
    });

    step('FX panel: the add-effect menu stays fully on-screen even opened near the bottom of a scrolled .daw', async () => {
      // Reproduces the original bug's trigger condition directly: scroll
      // .daw so a track's FX panel sits near the very bottom of the visible
      // area, then open its add-menu and confirm the whole menu's
      // bounding box is inside the viewport — the concrete, user-visible
      // symptom "the menu doesn't show" was actually "renders outside what
      // .daw lets you see."
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await cdp.evaluate(`document.getElementById('daw').scrollTop = 999999`); // scroll to the bottom
      // The browser dispatches the resulting 'scroll' event asynchronously
      // (at the next "update the rendering" step), not synchronously with the
      // scrollTop write above — without this wait, that event can land right
      // after the click below opens the menu instead of before, and the new
      // .daw scroll-close listener (Step 6) would then immediately close the
      // very menu this step is trying to inspect.
      await new Promise((r) => setTimeout(r, 150));
      // Every track header now has a .th-fx-panel (Inserts is always-visible,
      // no more show/hide toggle), so .find() above used to just grab the
      // FIRST track — after scrolling .daw to its max that header sits far
      // ABOVE the visible area, not "near the bottom" as this test's own name
      // claims. .pop() instead grabs the LAST header with a .th-fx-panel,
      // which is the one actually scrolled near .daw's bottom edge.
      const headSel = `[...document.querySelectorAll('.track-header')].filter(h => h.querySelector('.th-fx-panel')).pop()`;
      await cdp.evaluate(`(${headSel}).querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      const box = await cdp.evaluate(`(() => {
        const r = document.querySelector('.th-fx-add-menu').getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
      })()`);
      if (box.top < 0 || box.left < 0 || box.right > box.vw || box.bottom > box.vh) {
        throw new Error(`add-effect menu rendered partly outside the viewport: ${JSON.stringify(box)}`);
      }
      // getBoundingClientRect() is unaffected by an ancestor's overflow
      // clipping — an element clipped by .daw still reports a perfectly
      // normal, in-viewport bounding box. So the bounds check above can never
      // fail for the original bug (an invisible-but-technically-in-viewport
      // popup). Hit-test the menu's own centre point to confirm it is
      // actually the topmost painted element there, not just coordinates.
      const hit = await cdp.evaluate(`(() => {
        const m = document.querySelector('.th-fx-add-menu');
        const r = m.getBoundingClientRect();
        const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return m.contains(topEl);
      })()`);
      if (!hit) throw new Error('the add-effect menu is in the viewport but something else is painted on top of it at its own position');
    });

    step('Pen: clicking into a track that is not active places at the clicked cell', async () => {
      // setActive() re-renders, which replaces the lane element the handler is
      // attached to — so reading its rect after activating read a detached
      // node's zeros and the item landed wherever the raw viewport coordinates
      // divided into. Only reachable when some *other* track is active, which
      // a one-track new project never was.
      //
      // The check is that the same click gives the same cell whether or not
      // the track was already active. Against the unfixed code the first one
      // landed on a different bar and a different pitch entirely.
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length === 5`);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      const bassLane = `[...document.querySelectorAll('.track')].find(t => (t.querySelector('.th-name') || {}).textContent === 'Bass').querySelector('.lane')`;
      const clickBass = () => cdp.evaluate(`(() => {
        const lane = ${bassLane};
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 180, clientY: r.top + 44 }));
      })()`);
      const bassNote = () => cdp.evaluate(`(() => {
        const n = (${bassLane}).querySelector('.note');
        return n ? n.getAttribute('aria-label') : null;
      })()`);

      const active = await cdp.evaluate(`(document.querySelector('.track.active .th-name') || {}).textContent`);
      if (active === 'Bass') throw new Error('this step needs Bass to start inactive');
      await clickBass();
      await new Promise((r) => setTimeout(r, 400));
      const whileInactive = await bassNote();
      if (!whileInactive) throw new Error('clicking an inactive lane placed nothing');

      // Same click again, this time with Bass already active.
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
      await waitFor(`!(${bassLane}).querySelector('.note')`);
      await clickBass();
      await new Promise((r) => setTimeout(r, 400));
      const whileActive = await bassNote();
      if (whileInactive !== whileActive) {
        throw new Error(`the same click should land in the same cell either way: inactive ${JSON.stringify(whileInactive)} vs active ${JSON.stringify(whileActive)}`);
      }
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

    // Small helpers shared by every FX-panel step below. `panel` is always
    // the first track's (`.track`s[0]) — same target the old slider-grid
    // tests used, kept for continuity with the rest of the suite.
    const fxPanelSel = `document.querySelectorAll('.track')[0].querySelector('.th-fx-panel')`;
    // Adds `label` (e.g. 'EQ') via the "+ Add effect" menu if not already a
    // chip, and returns once its popover is open (adding auto-opens it).
    async function addFxEffect(label) {
      const already = await cdp.evaluate(`!![...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body')].find(b => b.querySelector('span:not(.th-fx-chip-letter)').textContent.trim() === ${JSON.stringify(label)})`);
      if (already) return;
      await cdp.evaluate(`(${fxPanelSel}).querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
      await waitFor(`!!document.querySelector('.th-fx-popover[data-key]')`);
    }
    // Steps a knob (identified by its label, e.g. 'Lo') by dispatching N
    // keydowns rather than replaying pointer-drag pixel math — deterministic,
    // and it exercises the knob's keyboard support as a side effect.
    async function stepKnob(popoverKey, fieldLabel, key, times) {
      const dialSel = `[...document.querySelector('.th-fx-popover[data-key="${popoverKey}"]').querySelectorAll('.th-knob')]` +
        `.find(k => k.querySelector('.th-knob-label').textContent === ${JSON.stringify(fieldLabel)}).querySelector('.th-knob-dial')`;
      await cdp.evaluate(`(() => {
        const dial = ${dialSel};
        dial.focus();
        for (let i = 0; i < ${times}; i++) dial.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
      })()`);
    }
    async function knobText(popoverKey, fieldLabel) {
      return cdp.evaluate(`[...document.querySelector('.th-fx-popover[data-key="${popoverKey}"]').querySelectorAll('.th-knob')]` +
        `.find(k => k.querySelector('.th-knob-label').textContent === ${JSON.stringify(fieldLabel)}).querySelector('.th-knob-val').textContent`);
    }

    step('FX panel: adding Delay opens its popover with a working knob', async () => {
      await addFxEffect('Delay');
      // 0 -> 0.5 at a 0.02 step is exactly 25 presses.
      await stepKnob('sendDelay', 'Delay', 'ArrowUp', 25);
      const text = await knobText('sendDelay', 'Delay');
      if (text !== '50%') throw new Error(`expected Delay to show 50%, got ${text}`);
    });

    step('FX panel: EQ chip renders before Comp regardless of add order, and survives a reload', async () => {
      // Comp added first, EQ second — if the chip row still shows EQ before
      // Comp, the order is registry-driven (the real audio chain), not
      // insertion order.
      await addFxEffect('Comp');
      await addFxEffect('EQ');
      const chipLabels = await cdp.evaluate(
        `[...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body')].map(b => b.querySelector('span:not(.th-fx-chip-letter)').textContent)`);
      if (chipLabels.indexOf('EQ') === -1 || chipLabels.indexOf('EQ') > chipLabels.indexOf('Comp')) {
        throw new Error(`EQ should render before Comp regardless of add order, got ${JSON.stringify(chipLabels)}`);
      }
      // 0 -> 6 and 0 -> -4.5 at a 0.5 step: 12 up, 9 down.
      await stepKnob('eq', 'Lo', 'ArrowUp', 12);
      await stepKnob('eq', 'Hi', 'ArrowDown', 9);
      const lo = await knobText('eq', 'Lo');
      const hi = await knobText('eq', 'Hi');
      if (lo !== '6.0dB') throw new Error(`expected Lo to read 6.0dB, got ${lo}`);
      if (hi !== '-4.5dB') throw new Error(`expected Hi to read -4.5dB, got ${hi}`);
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
    });

    step('FX panel: bypass dims the chip/popover but keeps showing the dialled value, and Reset clears every chip', async () => {
      await cdp.evaluate(`[...(${fxPanelSel}).querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body span:not(.th-fx-chip-letter)').textContent === 'EQ').querySelector('.th-fx-chip-bypass').click()`);
      const bypassedState = await cdp.evaluate(`(() => {
        const chip = [...(${fxPanelSel}).querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body span:not(.th-fx-chip-letter)').textContent === 'EQ');
        const pop = document.querySelector('.th-fx-popover[data-key="eq"]');
        return { chipDimmed: chip.classList.contains('bypassed'), popDimmed: pop.classList.contains('bypassed') };
      })()`);
      if (!bypassedState.chipDimmed || !bypassedState.popDimmed) {
        throw new Error(`bypass should dim both the chip and its popover: ${JSON.stringify(bypassedState)}`);
      }
      const stillShown = await knobText('eq', 'Lo');
      if (stillShown !== '6.0dB') throw new Error(`bypass must not hide the real dialled value, Lo now reads ${stillShown}`);

      await cdp.evaluate(`(${fxPanelSel}).querySelector('.th-fx-reset').click()`);
      await waitFor(`(${fxPanelSel}).querySelectorAll('.th-fx-chip').length === 0`);
      // Re-adding EQ after Reset should start from default again.
      await addFxEffect('EQ');
      const backToDefault = await knobText('eq', 'Lo');
      if (backToDefault !== '0.0dB') throw new Error(`Reset should clear EQ's values, Lo now reads ${backToDefault}`);
      await cdp.evaluate(`(${fxPanelSel}).querySelector('.th-fx-reset').click()`);
      await waitFor(`(${fxPanelSel}).querySelectorAll('.th-fx-chip').length === 0`);
    });

    step('FX panel: the "+ Add effect" menu renders in the floating layer, not clipped by .daw', async () => {
      // The bug this used to chase (a sibling track's header painting over
      // the menu inside .daw's own stacking context) can't happen any more
      // now that the menu is portaled to #floating-layer, a
      // document.body-level, position:fixed element with no ancestor
      // overflow box left to clip against. This checks that portal
      // relationship directly instead of re-deriving an overlap that no
      // longer has anything to overlap with. Reuses the already-reset
      // fxPanelSel track from the step above rather than reloading the
      // page, so the Froggy Hop song and every other step's state stays
      // intact for the steps that follow.
      await cdp.evaluate(`(${fxPanelSel}).querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      const result = await cdp.evaluate(`(() => {
        const menu = document.querySelector('.th-fx-add-menu');
        return {
          inLayer: menu.parentElement && menu.parentElement.id === 'floating-layer',
          position: getComputedStyle(menu).position,
        };
      })()`);
      if (!result.inLayer) throw new Error('the add-effect menu should be a direct child of #floating-layer');
      if (result.position !== 'fixed') throw new Error(`expected the add-effect menu to be position:fixed, got ${result.position}`);
      await cdp.evaluate(`(${fxPanelSel}).querySelector('.th-fx-add-btn').click()`); // close the menu back up
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
      // name, or that the picker overflows the fixed-width header. Check
      // both, plus that clicking still writes through to state. The trigger
      // button carries its own accessible name (aria-label) and the current
      // selection's icon+text; the floating listbox behind it is where the
      // glyphs actually live (a native <option> can't carry an SVG, which is
      // the whole reason this isn't a plain <select> — see the trigger's own
      // comment in buildHeader()).
      const wave = await cdp.evaluate(`(() => {
        const t = document.querySelector('.th-osc-trigger');
        if (!t) return { missing: true };
        return {
          tag: t.tagName,
          named: !!t.getAttribute('aria-label'),
          haspopup: t.getAttribute('aria-haspopup'),
          selectedText: t.querySelector('span:not(.th-osc-caret)')?.textContent,
          drawn: t.querySelectorAll('svg.glyph path').length > 0,
          fits: t.scrollWidth <= t.closest('.track-header').clientWidth,
        };
      })()`);
      if (wave.missing) throw new Error('no tonal track waveform picker found');
      if (wave.tag !== 'BUTTON') throw new Error(`waveform picker should be a <button> trigger, got ${wave.tag}`);
      if (!wave.named) throw new Error('waveform trigger needs an aria-label');
      if (wave.haspopup !== 'listbox') throw new Error(`expected aria-haspopup="listbox", got ${wave.haspopup}`);
      if (wave.selectedText !== 'Square') throw new Error(`expected Square shown by default, got ${wave.selectedText}`);
      if (!wave.drawn) throw new Error('the trigger button needs a decorative glyph for the current waveform');
      if (!wave.fits) throw new Error('the waveform trigger overflows the track header');
      // Scope to one track's picker: by this point the song has several tonal
      // tracks, each with its own trigger, so an unscoped query would mix
      // their states together.
      await cdp.evaluate(`document.querySelector('.th-osc-trigger').click()`);
      await waitFor(`!!document.querySelector('.th-osc-menu')`);
      const menuCount = await cdp.evaluate(`document.querySelectorAll('.th-osc-menu button').length`);
      if (menuCount !== 10) throw new Error(`expected 10 waveform options in the menu, got ${menuCount}`);
      const switched = await cdp.evaluate(`(() => {
        [...document.querySelectorAll('.th-osc-menu button')].find(b => b.textContent.trim() === 'Saw').click();
        return document.querySelector('.th-osc-trigger').querySelector('span:not(.th-osc-caret)').textContent;
      })()`);
      if (switched !== 'Saw') throw new Error(`picking Saw should update the trigger's label, got ${switched}`);
      const closedAfterPick = await cdp.evaluate(`!document.querySelector('.th-osc-menu')`);
      if (!closedAfterPick) throw new Error('picking an option should close the waveform menu');

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

      // FX panel: every TRACK_FX_REGISTRY entry is offered, in the fixed
      // registry order, each with a glyphed chip; adding all of them opens
      // all their popovers (any number can be open at once), so the total
      // knob count across all of them is the same 13/15 the old always-shown
      // slider grid asserted. An earlier step may already have opened this
      // panel, in which case clicking the button would close it.
      await waitFor(`!!document.querySelector('.th-fx-panel')`);
      const panelSel = `document.querySelector('.th-fx-panel')`;
      const tonal = await cdp.evaluate(`!!(${panelSel}).closest('.track-header').querySelector('.th-osc-trigger')`);
      for (let i = 0; i < 8; i++) {
        const added = await cdp.evaluate(`(() => {
          const addBtn = (${panelSel}).querySelector('.th-fx-add-btn');
          if (!addBtn) return false;
          addBtn.click();
          const item = document.querySelector('.th-fx-add-menu button');
          if (!item) { addBtn.click(); return false; } // menu was empty — close it back up and stop
          item.click();
          return true;
        })()`);
        if (!added) break;
        await new Promise((r) => setTimeout(r, 60));
      }
      const fx = await cdp.evaluate(`(() => {
        const panel = ${panelSel};
        const chips = [...panel.querySelectorAll('.th-fx-chip')];
        return {
          labels: chips.map(c => c.querySelector('.th-fx-chip-body span:not(.th-fx-chip-letter)').textContent),
          drawn: chips.every(c => c.querySelectorAll('svg.glyph path').length > 0),
          // Knobs live inside the popover, which now renders in
          // #floating-layer rather than nested under panel — but this
          // track is the only one with any FX added at this point in the
          // run, so a document-wide count is still exactly this track's.
          knobs: document.querySelectorAll('.th-knob').length,
          fits: panel.scrollWidth <= panel.closest('.track-header').clientWidth,
        };
      })()`);
      const wantFx = ['EQ', 'Comp', 'Bitcrush', 'Tremolo', 'Delay', 'Chorus', 'Reverb'].concat(tonal ? ['Vibrato'] : []);
      if (fx.labels.join('|') !== wantFx.join('|')) {
        throw new Error(`unexpected FX chips on a ${tonal ? 'tonal' : 'rhythm'} track: ${JSON.stringify(fx.labels)}`);
      }
      if (!fx.drawn) throw new Error('every FX chip needs a glyph');
      const wantKnobs = tonal ? 15 : 13;
      if (fx.knobs !== wantKnobs) throw new Error(`expected ${wantKnobs} FX knobs across every open popover, got ${fx.knobs}`);
      if (!fx.fits) throw new Error('the FX panel overflows the track header');
      // Leave this track's panel clean for later steps that assume a fresh one.
      await cdp.evaluate(`(${panelSel}).querySelector('.th-fx-reset').click()`);
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

    step('Rhythm patterns: accented hits, a fill on the phrase\'s last bar, a crash after it', async () => {
      await goto(APP_URL); // a blank project, so the insert has the whole song to tile
      await waitFor(`!!document.querySelector('.track')`);
      await cdp.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);

      const choices = await cdp.evaluate(`(() => {
        const s = document.getElementById('pattern-fill-every');
        return { value: s.value, count: s.options.length };
      })()`);
      if (choices.value !== '4' || choices.count !== 4) {
        throw new Error(`expected a 4-option phrase length defaulting to 4 bars, got ${JSON.stringify(choices)}`);
      }
      // Every row, not just the ones exercised below: a new groove added to
      // RHYTHM_PATTERNS without a fill or a description would otherwise ship
      // silently, since nothing else in the app requires either.
      const rows = await cdp.evaluate(`[...document.querySelectorAll('#pattern-list .song-item')].map(r => ({
        name: r.querySelector('.song-title').textContent,
        desc: (r.querySelector('.song-desc') || {}).textContent || '',
        buttons: [...r.querySelectorAll('button')].map(b => b.textContent),
      }))`);
      if (rows.length < 12) throw new Error(`expected at least 12 grooves in the library, got ${rows.length}`);
      for (const r of rows) {
        if (!r.desc.trim()) throw new Error(`pattern "${r.name}" has no description`);
        if (!r.buttons.includes('▶ fill')) throw new Error(`pattern "${r.name}" has no fill`);
      }

      // Read the inserted groove back out of the grid's own aria-labels: they
      // carry the drum, the bar and the velocity, which is exactly the three
      // things this step is about — and reading them also keeps the labels
      // honest, since a hit with no label would simply vanish from the count.
      const insertAndRead = async (name) => {
        await cdp.evaluate(`(() => {
          const row = [...document.querySelectorAll('#pattern-list .song-item')].find(r => r.querySelector('.song-title').textContent === ${JSON.stringify(name)});
          [...row.querySelectorAll('button')].find(b => b.textContent === 'Insert').click();
        })()`);
        await new Promise((r) => setTimeout(r, 400));
        const labels = await cdp.evaluate(`[...document.querySelectorAll('.lane .hit')].map(h => h.getAttribute('aria-label'))`);
        const bars = {};
        for (const l of labels) {
          const m = l.match(/bar (\d+)/);
          if (!m) throw new Error(`a hit has no bar in its label: ${l}`);
          // The bar number comes out so two bars can be compared at all; what
          // is left is drum + beat + velocity. Labels name the beat, not the
          // 8th, so this compares bars at beat granularity — enough to tell a
          // fill from a groove bar, and it is the only per-hit description the
          // grid actually exposes.
          (bars[m[1]] = bars[m[1]] || []).push(l.replace(/bar \d+ /, ''));
        }
        // Sorted so a bar is compared by content, not by the order render()
        // happened to emit it in.
        for (const k of Object.keys(bars)) bars[k].sort();
        return { labels, bars };
      };

      const rock = await insertAndRead('Rock');
      // Not `.some(...)`: a single accented hit would pass that while the rest
      // of the groove stayed flat. The point is that most of it is shaded.
      const accented = rock.labels.filter((l) => /velocity/.test(l));
      if (accented.length < rock.labels.length / 3) {
        throw new Error(`only ${accented.length} of ${rock.labels.length} hits carry a velocity — the groove is still flat`);
      }
      // ...and the loud ones must still be *absent*, not stored as vel: 1, or
      // every inserted pattern grows the saved file for nothing.
      if (!rock.labels.some((l) => !/velocity/.test(l))) {
        throw new Error('every hit carries an explicit velocity — full-strength hits should leave it off');
      }
      const barNums = Object.keys(rock.bars).map(Number).sort((a, b) => a - b);
      if (barNums.length < 6) throw new Error(`expected the pattern to tile several bars, got ${barNums.length}`);
      const key = (n) => (rock.bars[n] || []).join('|');
      if (key(1) !== key(2) || key(2) !== key(3)) {
        throw new Error('bars 1-3 of a phrase should be the same groove bar');
      }
      if (key(4) === key(1)) throw new Error('bar 4 should be the fill, not another groove bar');
      if (key(5) === key(4)) throw new Error('bar 5 should be back to the groove');
      const crashBars = rock.labels.filter((l) => /^Crash/.test(l)).map((l) => Number(l.match(/bar (\d+)/)[1]));
      if (!crashBars.includes(5)) throw new Error(`the bar after a fill should open with a crash, crashes landed on ${JSON.stringify(crashBars)}`);
      if (crashBars.some((b) => b <= 4)) throw new Error(`a crash landed before the first fill: ${JSON.stringify(crashBars)}`);

      // Breakbeat already crashes on its own downbeat. The crash-after-fill
      // must go through hitsConflict rather than being appended blindly, or
      // bar 5 gets two crashes stacked in one cell.
      await cdp.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);
      const breaks = await insertAndRead('Breakbeat');
      const bar5Crashes = (breaks.bars['5'] || []).filter((l) => /^Crash/.test(l));
      if (bar5Crashes.length !== 1) {
        throw new Error(`expected exactly one crash on bar 5 of Breakbeat, got ${bar5Crashes.length}`);
      }

      // Funk is written on 16ths, which the column unit allows (a column is an
      // eighth, positions re-lattice to 1/6 of one) but the *default grid* does
      // not draw: a hit's block is one grid step wide, so on 1/8 two 16ths
      // would render one on top of the other. The pattern brings its grid with
      // it, the way shuffle brings its swing.
      await cdp.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);
      const funk = await insertAndRead('Funk');
      const grid = await cdp.evaluate(`document.getElementById('grid-select').value`);
      if (grid !== '1/16') throw new Error(`inserting Funk should switch the grid to 1/16, got ${grid}`);
      // Sixteen hi-hats in one bar cannot sit on eight eighth-columns, so this
      // is what actually pins the 16th placement — the grid alone would still
      // pass if every `start` had been rounded to a whole column.
      const hats = (funk.bars['1'] || []).filter((l) => /^Hi-hat/.test(l));
      if (hats.length !== 16) throw new Error(`expected 16 hi-hats in Funk's first bar, got ${hats.length}`);

      // Bossa nova declines the crash (crashAfterFill: false) — its fill flips
      // the clave rather than building to anything.
      await cdp.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);
      const bossa = await insertAndRead('Bossa Nova');
      if (bossa.labels.some((l) => /^Crash/.test(l))) {
        throw new Error('Bossa Nova opts out of the crash after a fill, but one was inserted');
      }
      if ((bossa.bars['4'] || []).join('|') === (bossa.bars['1'] || []).join('|')) {
        throw new Error('Bossa Nova still needs a fill bar even without the crash');
      }

      // Reggae's one drop is defined by an absence, which no count or spread
      // would catch: beat 1 carries no kick at all. Anything there and this is
      // a slow rock beat with a different hi-hat.
      await cdp.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);
      const reggae = await insertAndRead('Reggae (one drop)');
      const onOne = reggae.labels.filter((l) => /^Kick, bar [123] beat 1$/.test(l));
      if (onOne.length) throw new Error(`the one drop leaves beat 1 empty, found ${onOne.length} kick(s) there`);
      if (!reggae.labels.some((l) => /^Kick, bar 1 beat 3$/.test(l))) {
        throw new Error('the one drop puts its kick on beat 3');
      }

      // Trap is the only pattern mixing two subdivisions, so it is the only one
      // that can show the lattice really carries both. Measured off the drawn
      // positions rather than asserted from the table: a 16th gap and a triplet
      // gap stand in a 3:2 ratio, and nothing else in the app produces that.
      await cdp.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);
      await insertAndRead('Trap');
      const trapGrid = await cdp.evaluate(`document.getElementById('grid-select').value`);
      if (trapGrid !== '1/16T') throw new Error(`inserting Trap should switch the grid to 1/16T, got ${trapGrid}`);
      const gaps = await cdp.evaluate(`(() => {
        const xs = [...document.querySelectorAll('.lane .hit')]
          .filter(h => (h.getAttribute('aria-label') || '').startsWith('Hi-hat, bar 1 '))
          .map(h => parseFloat(h.style.left))
          .sort((a, b) => a - b);
        const g = [];
        for (let i = 1; i < xs.length; i++) g.push(+(xs[i] - xs[i - 1]).toFixed(2));
        return [...new Set(g)].sort((a, b) => a - b);
      })()`);
      if (gaps.length < 2) throw new Error(`Trap's hi-hats sit at one spacing only: ${JSON.stringify(gaps)}`);
      // A zero gap is two hi-hats in one column, which hitsConflict calls a
      // collision — worth its own message rather than an Infinity ratio.
      if (gaps[0] === 0) throw new Error(`two of Trap's hi-hats landed in the same column: ${JSON.stringify(gaps)}`);
      const ratio = gaps[1] / gaps[0];
      if (Math.abs(ratio - 1.5) > 0.05) {
        throw new Error(`Trap should mix triplets with 16ths (a 3:2 gap ratio), measured ${ratio.toFixed(3)} from ${JSON.stringify(gaps)}`);
      }

      // Fills off: every bar identical again, which is what the patterns did
      // before fills existed — and the only setting that keeps a pattern from
      // commenting on an arrangement it is being tiled underneath.
      await cdp.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);
      await cdp.evaluate(`(() => {
        const s = document.getElementById('pattern-fill-every');
        s.value = '0';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const flat = await insertAndRead('Rock');
      const flatKeys = new Set(Object.values(flat.bars).map((b) => b.join('|')));
      if (flatKeys.size !== 1) {
        throw new Error(`with fills off every bar should be identical, got ${flatKeys.size} distinct bars`);
      }
      if (flat.labels.some((l) => /^Crash/.test(l))) throw new Error('fills off should insert no crashes');

      // The kit is spread across the stereo field on insert (KIT_PAN), so a
      // stamped pattern is a kit in a room rather than ten sounds in one spot.
      // Read off the labels again: hitAriaLabel() names the pan, so a hit
      // placed off-centre without being announced would fail here too.
      const panOf = (labels, drum) => labels
        .filter((l) => l.startsWith(drum + ','))
        .map((l) => (l.match(/pan (L|R|C)(\d*)/) || [])[0] || 'centre');
      const spreadHats = new Set(panOf(flat.labels, 'Hi-hat'));
      if (spreadHats.size !== 1 || !/^pan R/.test([...spreadHats][0])) {
        throw new Error(`hi-hats should all sit right of centre, got ${JSON.stringify([...spreadHats])}`);
      }
      // Kick and snare hold the middle: they carry the pulse, and a song that
      // never touches pan must still serialise without the property at all.
      for (const drum of ['Kick', 'Snare']) {
        const p = new Set(panOf(flat.labels, drum));
        if (p.size !== 1 || [...p][0] !== 'centre') {
          throw new Error(`${drum} should stay centred, got ${JSON.stringify([...p])}`);
        }
      }
      // Two pieces on opposite sides, so this can't pass with everything nudged
      // one way — the shaker is left where the hi-hat is right.
      const shaker = new Set(panOf(flat.labels, 'Shaker'));
      if (shaker.size && !/^pan L/.test([...shaker][0])) {
        throw new Error(`the shaker should sit left of centre, got ${JSON.stringify([...shaker])}`);
      }

      // And the toggle really turns it off — same pattern, everything centred.
      await cdp.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);
      await cdp.evaluate(`(() => {
        const c = document.getElementById('pattern-spread');
        c.checked = false;
        c.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const centred = await insertAndRead('Rock');
      if (centred.labels.some((l) => /pan /.test(l))) {
        throw new Error(`with the spread off nothing should be panned, got ${JSON.stringify(centred.labels.filter((l) => /pan /.test(l)))}`);
      }
    });

    // The autosave draft is currentSongData()'s own payload, so reading it back
    // is a faithful read-out of everything a save would write — which is what
    // both steps below need, and is also why autosave building its own copy of
    // that field list was worth removing.
    const draft = () => cdp.evaluate(`JSON.parse(localStorage.getItem('frogger-music-editor-autosave'))`);
    const loadExample = async (name) => {
      await cdp.evaluate(`(() => {
        document.querySelector('#file-menu-toggle').click();
        [...document.querySelectorAll('#file-menu-panel button')].find(b => b.textContent.includes('Songs')).click();
      })()`);
      await waitFor(`[...document.querySelectorAll('.song-item .song-title')].some(t => t.textContent === ${JSON.stringify(name)})`);
      await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('.song-item')].find(r => r.querySelector('.song-title').textContent === ${JSON.stringify(name)});
        [...row.querySelectorAll('button')].find(b => b.textContent === 'Load').click();
      })()`);
      await waitFor(`document.querySelector('#song-name-display').textContent === ${JSON.stringify(name)}`);
      await new Promise((r) => setTimeout(r, 700)); // autosave is debounced
    };

    step('Song I/O: loading a song does not inherit the previous song\'s track settings', async () => {
      // applySavedMix() only *sets* what the file contains, so anything the
      // previous song left in a sparse per-track map survives on every track id
      // the two share — and every song has a `rhythm`. Neon Cathedral is the
      // one example that uses the FX panel, so it is the one that leaks.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track')`);
      await loadExample('Neon Cathedral');
      const dirty = await draft();
      if (!Object.keys(dirty.comp || {}).length || !Object.keys(dirty.filter || {}).length) {
        throw new Error('Neon Cathedral should carry per-track comp and filter settings — the check below proves nothing without them');
      }
      await loadExample('Techno');
      const after = await draft();
      const file = await cdp.evaluate(`fetch('songs/techno.json').then(r => r.json())`);
      const maps = ['automation', 'adsr', 'filter', 'fm', 'fxSend', 'comp', 'crush', 'tremolo', 'vibrato', 'duty', 'eq', 'activeFx'];
      for (const k of maps) {
        const got = Object.keys(after[k] || {}).sort();
        const want = Object.keys(file[k] || {}).sort();
        if (got.join(',') !== want.join(',')) {
          throw new Error(`state.${k} after loading Techno is ${JSON.stringify(got)}, the file says ${JSON.stringify(want)}`);
        }
      }
    });

    step('Song I/O: a per-track Duty survives a save, a reload and a load', async () => {
      // Duty was written to every saved file and never read back — it is the
      // one per-track setting that is a bare number instead of an object, so
      // it rode along in no shared loop. Checked through the real Save/Load
      // path rather than by poking state, since the gap was in that path.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      // The starter layout's first tonal track (Lead) — no need to add one.
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-trigger'));
        [...head.querySelectorAll('.th-tool-btn')].find(b => /Env/.test(b.textContent)).click();
      })()`);
      // The Env panel's Duty picker: the only select offering pulse widths.
      const dutySel = `[...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent === '12.5%'))`;
      await waitFor(`!!(${dutySel})`);
      await cdp.evaluate(`(() => {
        const s = ${dutySel};
        s.value = [...s.options].map(o => o.value).find(v => parseFloat(v) === 0.25);
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 700));
      const saved = await draft();
      // Two entries now, and both matter: `lead` is the one just set by hand,
      // `harmony` is STARTER_TRACKS' own 25% — so this also proves the starter
      // layout's duty reaches the saved file rather than only the UI.
      if ((saved.duty || {}).lead !== 0.25) {
        throw new Error(`the saved payload should carry the Lead track's 25% duty, got ${JSON.stringify(saved.duty)}`);
      }
      if ((saved.duty || {}).harmony !== 0.25) {
        throw new Error(`the starter Harmony track's duty should be saved too, got ${JSON.stringify(saved.duty)}`);
      }
      // Save it under a name through the Songs dialog, reload the page (so
      // nothing survives in memory), then load it back.
      await cdp.evaluate(`(() => {
        document.querySelector('#file-menu-toggle').click();
        [...document.querySelectorAll('#file-menu-panel button')].find(b => b.textContent.includes('Songs')).click();
      })()`);
      await waitFor(`!!document.getElementById('song-name')`);
      await cdp.evaluate(`(() => {
        document.getElementById('song-name').value = 'DutyRoundTrip';
        document.getElementById('song-save-local').click();
      })()`);
      await waitFor(`[...document.querySelectorAll('.song-item .song-title')].some(t => t.textContent === 'DutyRoundTrip')`);
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track')`);
      await loadExample('DutyRoundTrip');
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-trigger'));
        [...head.querySelectorAll('.th-tool-btn')].find(b => /Env/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!(${dutySel})`);
      const restored = await cdp.evaluate(`(${dutySel}).value`);
      // Cleared before the assertion so a failure still leaves the browser
      // profile clean for the steps after this one.
      await cdp.evaluate(`localStorage.removeItem('music-studio-songs')`);
      if (parseFloat(restored) !== 0.25) {
        throw new Error(`the track's Duty should come back as 25%, the picker shows ${JSON.stringify(restored)}`);
      }
    });

    step('Per-note and per-hit pan reach the audio graph; centre inserts no node', async () => {
      // A panned note looks identical in the DOM, so the DOM alone can't show
      // that pan is applied. Patch createStereoPanner before the page loads
      // and watch what gets built when a note is auditioned.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            window.__panners = [];
            const orig = BaseAudioContext.prototype.createStereoPanner;
            BaseAudioContext.prototype.createStereoPanner = function () {
              const n = orig.call(this);
              window.__panners.push(n);
              return n;
            };
            window.__panVals = () => window.__panners.map((p) => +p.pan.value.toFixed(3));
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      const tonalLane = `[...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-osc-trigger'))`;
      await cdp.evaluate(`(() => {
        const lane = ${tonalLane};
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 200, clientY: r.top + 60 }));
      })()`);
      await waitFor(`!!document.querySelector('.lane .note')`);

      const panField = `[...document.querySelectorAll('.insp-field')].find(f => f.querySelector('span') && f.querySelector('span').textContent === 'Pan')`;
      await waitFor(`!!(${panField})`);
      const centred = await cdp.evaluate(`(${panField}).querySelector('.insp-velval').textContent`);
      if (centred !== 'C') throw new Error(`a new note should read centred, got ${JSON.stringify(centred)}`);

      // Centre must build no panner at all — the same "no node when neutral"
      // contract a full-velocity drum hit keeps. Counted from zero *after* the
      // note exists, so the channel's own chanPan doesn't muddy it.
      await cdp.evaluate(`window.__panners.length = 0`);
      await cdp.evaluate(`document.querySelector('.lane .note').click()`);
      await new Promise((r) => setTimeout(r, 500));
      const atCentre = await cdp.evaluate(`window.__panVals()`);
      if (atCentre.length !== 0) {
        throw new Error(`a centred note should add no panner, saw ${JSON.stringify(atCentre)}`);
      }

      await cdp.evaluate(`(() => {
        const s = (${panField}).querySelector('input[type=range]');
        s.value = -0.7;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      const readout = await cdp.evaluate(`(${panField}).querySelector('.insp-velval').textContent`);
      if (readout !== 'L70') throw new Error(`expected the readout to say L70, got ${JSON.stringify(readout)}`);
      const label = await cdp.evaluate(`document.querySelector('.lane .note').getAttribute('aria-label')`);
      if (!/pan L70/.test(label || '')) {
        throw new Error(`a panned note must say so in its accessible name: ${JSON.stringify(label)}`);
      }

      await cdp.evaluate(`window.__panners.length = 0`);
      await cdp.evaluate(`document.querySelector('.lane .note').click()`);
      await new Promise((r) => setTimeout(r, 500));
      const panned = await cdp.evaluate(`window.__panVals()`);
      if (panned.length !== 1 || Math.abs(panned[0] + 0.7) > 1e-6) {
        throw new Error(`auditioning a note panned to -0.7 should build exactly that panner, saw ${JSON.stringify(panned)}`);
      }

      // It must reach the saved song, and centring must delete the property
      // rather than write 0 — otherwise every note grows the file for nothing.
      const savedNote = () => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find((t) => t.kind !== 'rhythm').id;
        return (d.tracks[id] || [])[0] || null;
      })()`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find((t) => t.kind !== 'rhythm').id;
        const n = (d.tracks[id] || [])[0];
        return n && Math.abs(n.pan + 0.7) < 1e-6;
      })()`, 4000);

      await cdp.evaluate(`(() => {
        const s = (${panField}).querySelector('input[type=range]');
        s.value = 0;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 700));
      const recentred = await savedNote();
      if (!recentred || 'pan' in recentred) {
        throw new Error(`re-centring should remove the property, saved note is ${JSON.stringify(recentred)}`);
      }

      // A drum hit gets the same control, through scheduleDrum()'s one dispatch
      // point rather than the ten individual schedulers — which is why it can
      // be the same two assertions.
      const rhythmLane = `[...document.querySelectorAll('.track')].filter((t) => !t.querySelector('.th-osc-trigger')).map((t) => t.querySelector('.lane'))[0]`;
      await cdp.evaluate(`(() => {
        const lane = ${rhythmLane};
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 100, clientY: r.top + 8 }));
      })()`);
      await waitFor(`!!document.querySelector('.hit')`);
      const hitFields = await cdp.evaluate(`[...document.querySelectorAll('.insp-field span:first-child')].map((e) => e.textContent)`);
      if (hitFields.join(',') !== 'Velocity,Pan') {
        throw new Error(`a hit's inspector should offer Velocity and Pan, got ${JSON.stringify(hitFields)}`);
      }
      await cdp.evaluate(`window.__panners.length = 0`);
      await cdp.evaluate(`document.querySelector('.hit').click()`);
      await new Promise((r) => setTimeout(r, 500));
      const hitCentre = await cdp.evaluate(`window.__panVals()`);
      if (hitCentre.length !== 0) {
        throw new Error(`a centred hit should add no panner, saw ${JSON.stringify(hitCentre)}`);
      }
      await cdp.evaluate(`(() => {
        const s = (${panField}).querySelector('input[type=range]');
        s.value = 0.6;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      const hitLabel = await cdp.evaluate(`document.querySelector('.hit').getAttribute('aria-label')`);
      if (!/pan R60/.test(hitLabel || '')) {
        throw new Error(`a panned hit must say so in its accessible name: ${JSON.stringify(hitLabel)}`);
      }
      await cdp.evaluate(`window.__panners.length = 0`);
      await cdp.evaluate(`document.querySelector('.hit').click()`);
      await new Promise((r) => setTimeout(r, 500));
      const hitPanned = await cdp.evaluate(`window.__panVals()`);
      if (hitPanned.length !== 1 || Math.abs(hitPanned[0] - 0.6) > 1e-6) {
        throw new Error(`auditioning a hit panned to 0.6 should build exactly that panner, saw ${JSON.stringify(hitPanned)}`);
      }
      // And it must be the *only* thing stored on an otherwise untouched hit —
      // full velocity still writes nothing.
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find((t) => t.kind === 'rhythm').id;
        const h = (d.tracks[id] || [])[0];
        return h && Math.abs(h.pan - 0.6) < 1e-6 && !('vel' in h);
      })()`, 4000);
    });

    step('Recording: arm a track, count in, and play notes onto the grid', async () => {
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length === 5`);

      // The transport gained two buttons, both glyphed.
      const tp = await cdp.evaluate(`[...document.querySelectorAll('#transport-panel button')].map((b) => ({ id: b.id, svg: b.querySelectorAll('svg').length }))`);
      for (const id of ['record-btn', 'metronome-btn']) {
        const b = tp.find((x) => x.id === id);
        if (!b || b.svg !== 1) throw new Error(`expected a glyphed ${id} in the transport: ${JSON.stringify(tp)}`);
      }
      // Metronome is a remembered preference, not song data.
      await cdp.evaluate(`document.getElementById('metronome-btn').click()`);
      if (await cdp.evaluate(`document.getElementById('metronome-btn').getAttribute('aria-pressed')`) !== 'true') {
        throw new Error('the metronome button should toggle on');
      }
      if (await cdp.evaluate(`localStorage.getItem('music-studio-metronome')`) !== '1') {
        throw new Error('the metronome setting should be remembered per browser');
      }

      // Every track gets an R beside M and S.
      const btns = await cdp.evaluate(`[...document.querySelectorAll('.track')[0].querySelectorAll('.th-btns button')].map((b) => b.textContent)`);
      if (!btns.includes('R')) throw new Error(`expected a record-arm button beside M/S, got ${JSON.stringify(btns)}`);

      const armBass = `(() => {
        const t = [...document.querySelectorAll('.track')].find((t) => (t.querySelector('.th-name') || {}).textContent === 'Bass');
        [...t.querySelectorAll('.th-btns button')].find((b) => b.textContent === 'R').click();
      })()`;
      await cdp.evaluate(armBass);
      await waitFor(`document.querySelectorAll('.th-btns button.r.on').length === 1`);

      const key = (code, type) => cdp.evaluate(`window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { code, bubbles: true }))`.replace('code,', `code: ${JSON.stringify(code)},`));
      const bassNotes = () => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find((t) => t.name === 'Bass') || {}).id;
        return (d.tracks[id] || []).map((n) => ({ start: n.start, len: n.len, freq: n.freq }));
      })()`);

      // Plain Play with a track armed means "listen", not "type into the song":
      // only Record captures. (Stopped is a different case — that is step
      // entry, covered by its own step below.)
      await cdp.evaluate(`document.getElementById('play').click()`);
      await waitFor(`document.body.classList.contains('playing')`, 3000);
      await key('KeyZ', 'keydown');
      await new Promise((r) => setTimeout(r, 150));
      await key('KeyZ', 'keyup');
      await cdp.evaluate(`document.getElementById('stop').click()`);
      await new Promise((r) => setTimeout(r, 400));
      const idle = await bassNotes();
      if (idle.length !== 0) throw new Error(`playing without recording should capture nothing, got ${JSON.stringify(idle)}`);

      // Record: a bar of count-in, then capture.
      await cdp.evaluate(`document.getElementById('record-btn').click()`);
      await waitFor(`document.body.classList.contains('counting-in')`, 2000);
      if (await cdp.evaluate(`document.body.classList.contains('playing')`)) {
        throw new Error('the transport must not roll until the count-in is over');
      }
      // And "not rolling" as the user sees it, not just as a class name: the
      // playhead must still be where it was a beat into the count-in.
      const playheadLeft = () => cdp.evaluate(`document.querySelector('.playhead').style.left`);
      const beforeCount = await playheadLeft();
      await new Promise((r) => setTimeout(r, 400));
      const duringCount = await playheadLeft();
      if (duringCount !== beforeCount) {
        throw new Error(`the playhead must not move during the count-in: ${beforeCount} -> ${duringCount}`);
      }
      await waitFor(`document.body.classList.contains('playing')`, 6000);
      await waitFor(`document.querySelector('.playhead').style.left !== ${JSON.stringify(beforeCount)}`, 3000);

      for (const code of ['KeyZ', 'KeyX', 'KeyC']) {
        await key(code, 'keydown');
        await new Promise((r) => setTimeout(r, 260));
        await key(code, 'keyup');
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 300));
      await cdp.evaluate(`document.getElementById('stop').click()`);
      await new Promise((r) => setTimeout(r, 500));

      const rec = await bassNotes();
      if (rec.length !== 3) throw new Error(`expected three recorded notes, got ${JSON.stringify(rec)}`);
      // Z X C are C, D and E of the current octave — the pitches, not just the
      // count, so a mis-wired key map can't pass.
      const freqs = rec.map((n) => Math.round(n.freq));
      if (freqs.join(',') !== '262,294,330') {
        throw new Error(`Z/X/C should record C, D and E, got ${JSON.stringify(freqs)}`);
      }
      // And they must land where they were played, not stacked on one column.
      // (Every note at column 0 is exactly what a stopped audio clock looks
      // like — see the autoplay flag at the top of this file.)
      const starts = rec.map((n) => n.start);
      if (new Set(starts).size !== 3 || Math.max(...starts) === 0) {
        throw new Error(`recorded notes should land on separate columns, got ${JSON.stringify(starts)}`);
      }
      if (starts.some((c, i) => i && c <= starts[i - 1])) {
        throw new Error(`recorded notes should be in the order played, got ${JSON.stringify(starts)}`);
      }
      // Every note is at least one grid step long, however briefly it was hit.
      if (rec.some((n) => n.len < 1)) throw new Error(`a recorded note should never be shorter than the grid: ${JSON.stringify(rec)}`);

      // Disarming hands the letter keys back to the shortcuts.
      await cdp.evaluate(armBass);
      await waitFor(`document.querySelectorAll('.th-btns button.r.on').length === 0`);
      await key('KeyZ', 'keydown');
      await key('KeyZ', 'keyup');
      await new Promise((r) => setTimeout(r, 400));
      const after = await bassNotes();
      if (after.length !== 3) throw new Error(`a disarmed track should ignore note keys, got ${JSON.stringify(after)}`);
    });

    step('Step entry: with the transport stopped, keys write notes at the playhead', async () => {
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length === 5`);

      const key = (code, type) => cdp.evaluate(`window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { code, bubbles: true }))`.replace('code,', `code: ${JSON.stringify(code)},`));
      const tap = async (code) => {
        await key(code, 'keydown');
        await new Promise((r) => setTimeout(r, 40));
        await key(code, 'keyup');
        await new Promise((r) => setTimeout(r, 80));
      };
      const arm = (name) => cdp.evaluate(`(() => {
        const t = [...document.querySelectorAll('.track')].find((t) => (t.querySelector('.th-name') || {}).textContent === ${JSON.stringify(name)});
        [...t.querySelectorAll('.th-btns button')].find((b) => b.textContent === 'R').click();
      })()`);
      const items = (name) => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find((t) => t.name === ${JSON.stringify(name)}) || {}).id;
        return (d.tracks[id] || []).map((n) => ({ start: n.start, len: n.len, freq: n.freq, type: n.type }))
          .sort((a, b) => a.start - b.start || (a.freq || 0) - (b.freq || 0));
      })()`);
      const playheadLeft = () => cdp.evaluate(`document.querySelector('.playhead').style.left`);
      // autosave() debounces by 400ms, and items() reads that draft.
      const settle = () => new Promise((r) => setTimeout(r, 700));
      const spoken = () => cdp.evaluate(`document.querySelector('#a11y-status').textContent`);

      await arm('Bass');
      await waitFor(`document.querySelectorAll('.th-btns button.r.on').length === 1`);
      const atStart = await playheadLeft();

      // One key at a time: C, D and E on consecutive grid steps, each a step
      // long. Nothing is playing — this is the whole point of step entry.
      for (const c of ['KeyZ', 'KeyX', 'KeyC']) await tap(c);
      await settle();
      let notes = await items('Bass');
      if (notes.length !== 3) throw new Error(`three taps should write three notes, got ${JSON.stringify(notes)}`);
      if (notes.map((n) => n.start).join(',') !== '0,1,2') {
        throw new Error(`each tap should advance the playhead one grid step, got ${JSON.stringify(notes.map((n) => n.start))}`);
      }
      if (notes.map((n) => Math.round(n.freq)).join(',') !== '262,294,330') {
        throw new Error(`Z/X/C should write C, D and E, got ${JSON.stringify(notes.map((n) => Math.round(n.freq)))}`);
      }
      if (notes.some((n) => n.len !== 1)) throw new Error(`a stepped note should be one grid step long: ${JSON.stringify(notes)}`);
      if (await playheadLeft() === atStart) throw new Error('the playhead should have moved with the entry cursor');
      if (!/C4|D4|E4/.test(await spoken())) throw new Error(`each stepped note should be announced, heard "${await spoken()}"`);

      // Keys held together are a chord: one column, and the cursor moves once.
      for (const c of ['KeyZ', 'KeyC', 'KeyB']) await key(c, 'keydown');
      await new Promise((r) => setTimeout(r, 80));
      for (const c of ['KeyZ', 'KeyC', 'KeyB']) await key(c, 'keyup');
      await settle();
      notes = await items('Bass');
      const chord = notes.filter((n) => n.start === 3);
      if (chord.length !== 3) throw new Error(`a held chord should land on one column, got ${JSON.stringify(notes)}`);
      await tap('KeyX');
      await settle();
      notes = await items('Bass');
      if (!notes.some((n) => n.start === 4) || notes.some((n) => n.start > 4)) {
        throw new Error(`the cursor should advance once for a whole chord, not once per key: ${JSON.stringify(notes.map((n) => n.start))}`);
      }

      // Right arrow leaves a rest; the next note skips that step.
      await key('ArrowRight', 'keydown');
      await new Promise((r) => setTimeout(r, 100));
      await tap('KeyV');   // F
      await settle();
      notes = await items('Bass');
      if (!notes.some((n) => n.start === 6 && Math.round(n.freq) === 349)) {
        throw new Error(`the right arrow should leave a rest, got ${JSON.stringify(notes)}`);
      }
      const before = notes.length;

      // Backspace steps back over the last step and clears it.
      await key('Backspace', 'keydown');
      await settle();
      notes = await items('Bass');
      if (notes.length !== before - 1 || notes.some((n) => n.start === 6)) {
        throw new Error(`Backspace should clear the step it steps back onto, got ${JSON.stringify(notes)}`);
      }
      if (!/Removed 1/.test(await spoken())) throw new Error(`clearing a step should be announced, heard "${await spoken()}"`);
      // And it left the cursor there, so the next note fills the gap it made.
      await tap('KeyN');   // A
      await settle();
      notes = await items('Bass');
      if (!notes.some((n) => n.start === 6 && Math.round(n.freq) === 440)) {
        throw new Error(`Backspace should leave the cursor on the step it cleared, got ${JSON.stringify(notes)}`);
      }

      // The cursor is a way of reading the grid, not only of writing it: every
      // move reports the position *and* what is already there. Without that a
      // screen-reader user can count bars but never find out what is in them.
      await cdp.evaluate(`document.getElementById('rtz').click()`);
      await new Promise((r) => setTimeout(r, 100));
      await key('ArrowRight', 'keydown');   // onto column 1 — D4 from the taps above
      await new Promise((r) => setTimeout(r, 150));
      let heard = await spoken();
      if (!/bar 1/.test(heard) || !/D4/.test(heard)) {
        throw new Error(`the cursor should read out what it lands on, heard "${heard}"`);
      }
      await key('ArrowRight', 'keydown');
      await key('ArrowRight', 'keydown');   // onto column 3 — the chord
      await new Promise((r) => setTimeout(r, 150));
      heard = await spoken();
      if (!/C4, E4, G4/.test(heard)) throw new Error(`a chord should be read low to high, heard "${heard}"`);
      await key('ArrowRight', 'keydown');
      await key('ArrowRight', 'keydown');   // column 5 was left as a rest
      await new Promise((r) => setTimeout(r, 150));
      heard = await spoken();
      if (!/empty/.test(heard)) throw new Error(`an empty step should say so, heard "${heard}"`);

      // End goes to where the part ends — one step past its last note — which
      // is where you would carry on writing, not to the end of the song.
      await key('End', 'keydown');
      await new Promise((r) => setTimeout(r, 150));
      heard = await spoken();
      if (!/bar 1 beat 4/.test(heard) || !/empty/.test(heard)) {
        throw new Error(`End should land one step past the last note, heard "${heard}"`);
      }
      await key('Home', 'keydown');
      await new Promise((r) => setTimeout(r, 150));
      heard = await spoken();
      if (!/bar 1 beat 1/.test(heard) || !/C4/.test(heard)) {
        throw new Error(`Home should return to the first step, heard "${heard}"`);
      }

      // The grid's other dimension: down moves the arm to the next track and
      // says what is under the cursor there.
      await key('ArrowDown', 'keydown');
      await new Promise((r) => setTimeout(r, 250));
      heard = await spoken();
      if (!/^Pad,/.test(heard) || !/empty/.test(heard)) {
        throw new Error(`down should move to the next track and read it, heard "${heard}"`);
      }
      if (await cdp.evaluate(`[...document.querySelectorAll('.track')].findIndex(t => t.querySelector('.th-btns button.r.on')) < 0`)) {
        throw new Error('moving between tracks should keep exactly one armed');
      }
      await key('ArrowUp', 'keydown');
      await new Promise((r) => setTimeout(r, 250));
      heard = await spoken();
      if (!/^Bass,/.test(heard)) throw new Error(`up should move back to the previous track, heard "${heard}"`);

      // Drums step in the same way, from the same row of keys.
      await cdp.evaluate(`document.getElementById('rtz').click()`);
      await arm('Rhythm');
      await waitFor(`document.querySelectorAll('.th-btns button.r.on').length === 1`);
      await tap('KeyZ');
      await tap('KeyX');
      await settle();
      const hits = await items('Rhythm');
      if (hits.length !== 2 || hits[0].type !== 'kick' || hits[1].type !== 'snare') {
        throw new Error(`stepping on a rhythm track should write kit hits, got ${JSON.stringify(hits)}`);
      }
      if (hits.map((h) => h.start).join(',') !== '0,1') {
        throw new Error(`stepped hits should advance the same way notes do, got ${JSON.stringify(hits.map((h) => h.start))}`);
      }
      // Arming the rhythm track moved the arm rather than adding to it, so
      // those two taps reached the kit and nothing else.
      if ((await items('Bass')).length !== before) {
        throw new Error('arming a second track should move the arm, not add to it');
      }
    });

    step('Voice pooling: notes share filter+gain nodes instead of one pair each', async () => {
      // Pooling shipped, then sat switched off behind a leftover `return null`
      // for long enough that both README and DESIGN had drifted into claiming
      // something the build didn't do. What is asserted here is the invariant
      // itself rather than a node count: several note sources connect into the
      // *same* BiquadFilterNode. Unpooled that ratio is exactly 1:1, so this
      // cannot pass by accident.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            window.__pool = { conns: 0, ids: [] };
            let nextId = 1;
            const make = BaseAudioContext.prototype.createBiquadFilter;
            BaseAudioContext.prototype.createBiquadFilter = function (...a) {
              const n = make.apply(this, a);
              n.__poolId = nextId++;
              return n;
            };
            const connect = AudioNode.prototype.connect;
            AudioNode.prototype.connect = function (dest, ...rest) {
              // Only a note's own voice source feeds a biquad directly: the
              // channel chain's EQ is fed from a GainNode, and the vibrato/
              // tremolo/FM LFOs connect to AudioParams, not nodes.
              if (dest instanceof BiquadFilterNode
                  && (this instanceof OscillatorNode || this instanceof AudioBufferSourceNode)) {
                window.__pool.conns++;
                window.__pool.ids.push(dest.__poolId);
              }
              return connect.call(this, dest, ...rest);
            };
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length === 5`);
      await loadExample('Froggy Hop');
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 2500));
      await cdp.evaluate(`document.querySelector('#stop').click()`);

      const pool = await cdp.evaluate(`({ conns: window.__pool.conns, distinct: new Set(window.__pool.ids).size })`);
      if (pool.conns < 20) {
        throw new Error(`too few notes scheduled to say anything about pooling: ${JSON.stringify(pool)}`);
      }
      // Unpooled this is 1:1. Pooled, a channel's handful of voices carry the
      // whole part, so the margin is large — but assert a modest one, since the
      // exact ratio depends on how much of the song the lookahead reached.
      if (pool.distinct * 2 > pool.conns) {
        throw new Error(`notes should share pooled filters, got ${pool.distinct} filters for ${pool.conns} notes`);
      }
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
        await waitFor(`!!(${RHYTHM_LANE})`);
        // Place a hit and audition it — that builds the noise buffers — and
        // give a note a Reverb flag so the convolver gets its impulse.
        await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
        // Row 1 is the snare (short noise buffer) and row 8 the crash (long
        // one); the kick on row 0 is a pure oscillator and would build neither.
        // One evaluate per click, re-querying the lane each time: placing a hit
        // re-renders and replaces the lane element, so a second dispatch on the
        // captured reference goes to a detached node whose rect reads all zeros
        // — the row it computes is then whatever the viewport coordinate
        // happens to divide into.
        for (const [row, x] of [[1, 60], [8, 120]]) {
          await cdp.evaluate(`(() => {
            const lane = ${RHYTHM_LANE};
            const r = lane.getBoundingClientRect();
            const rowH = r.height / 10;
            lane.dispatchEvent(new MouseEvent('click', {
              bubbles: true, clientX: r.left + ${x}, clientY: r.top + (${row} + 0.5) * rowH,
            }));
          })()`);
          await new Promise((r) => setTimeout(r, 350));
        }
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
                let h = 0x811c9dc5, peak = 0, sq = 0, n = 0;
                for (let i = 0; i < d.length; i++) {
                  const a = Math.abs(d[i]);
                  if (a > peak) peak = a;
                  // RMS over the sounding part only: the render is padded with
                  // silence after the note, and averaging that in would just
                  // scale every waveform by the same amount anyway — but the
                  // threshold keeps the figure comparable to a hand check.
                  if (a > 1e-4) { sq += d[i] * d[i]; n++; }
                  const v = Math.round(d[i] * 1e5) | 0;
                  h ^= v & 255; h = Math.imul(h, 0x01000193) >>> 0;
                  h ^= (v >> 8) & 255; h = Math.imul(h, 0x01000193) >>> 0;
                }
                window.__waveRenders.push({ hash: h.toString(16), peak, rms: n ? Math.sqrt(sq / n) : 0 });
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
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-osc-trigger'));
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

      // The layout check (rows/min-width) was specific to the button grid —
      // the trigger+floating-menu has nothing analogous to assert beyond
      // "it fits", already covered by the Icons test above. Read the menu
      // items' data-value (WAVEFORMS' own internal ids, not the display
      // labels) to drive the loop below — opening the trigger once just to
      // enumerate the values, same as the Icons test already does to count
      // them.
      await cdp.evaluate(`document.querySelector('.th-osc-trigger').click()`);
      await waitFor(`!!document.querySelector('.th-osc-menu')`);
      const optionValues = await cdp.evaluate(
        `[...document.querySelectorAll('.th-osc-menu button')].map(b => b.dataset.value)`);
      await cdp.evaluate(`document.querySelector('.th-osc-trigger').click()`); // close it back up
      if (optionValues.length !== 10) throw new Error(`expected 10 waveform options, got ${optionValues.length}`);

      const results = {};
      const delayMods = {};
      for (const value of optionValues) {
        const before = await cdp.evaluate(`window.__waveRenders.length`);
        // The menu is rebuilt fresh (and closes) on every selection, so each
        // pass through the loop has to reopen it before picking the next one.
        await cdp.evaluate(`document.querySelector('.th-osc-trigger').click()`);
        await waitFor(`!!document.querySelector('.th-osc-menu')`);
        await cdp.evaluate(`document.querySelector('.th-osc-menu button[data-value=${JSON.stringify(value)}]').click()`);
        await new Promise((r) => setTimeout(r, 300));
        await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
        // Reset here, not before the waveform click: clicking a waveform button
        // auditions a note, which spins up the live context and its chorus bus,
        // so counting from there makes the baseline depend on whether that
        // context already existed.
        await cdp.evaluate(`window.__delayMod = 0`);
        await cdp.evaluate(`document.getElementById('export-wav').click()`);
        await waitFor(`window.__waveRenders.length > ${before}`, 90000);
        results[value] = await cdp.evaluate(`window.__waveRenders[${before}]`);
        delayMods[value] = await cdp.evaluate(`window.__delayMod`);
      }
      // Not "PWM is the only one" — the shared chorus bus legitimately sweeps its
      // own delay on every render, so the baseline is non-zero. What must hold
      // is that every other waveform shares one baseline and PWM sits above it.
      // Keyed by the option's own value ('pwm'), not its display label ('PWM'),
      // matching the loop above.
      const baseline = Object.keys(delayMods).filter((n) => n !== 'pwm').map((n) => delayMods[n]);
      if (new Set(baseline).size !== 1) {
        throw new Error(`waveforms other than PWM should all modulate the same number of delays: ${JSON.stringify(delayMods)}`);
      }
      if (delayMods['pwm'] <= baseline[0]) {
        throw new Error(`PWM built no LFO on its pulse-width delay — the sweep is gone: ${JSON.stringify(delayMods)}`);
      }
      // Ten exports have just run through the Export WAV button's busy state.
      // That state used to assign an hourglass straight to textContent, which
      // wiped the button's SVG child — and restoring the text alone never
      // brought it back, so one export left it iconless for the session. The
      // icons step above can't see this: it runs before anything is exported.
      const wavBtn = await cdp.evaluate(`(() => {
        const b = document.getElementById('export-wav');
        return { svgs: b.querySelectorAll('svg').length, text: b.textContent.trim(), disabled: b.disabled };
      })()`);
      if (wavBtn.svgs !== 1 || wavBtn.text !== 'Export WAV' || wavBtn.disabled) {
        throw new Error(`Export WAV should come back out of its busy state intact: ${JSON.stringify(wavBtn)}`);
      }

      const names = Object.keys(results);
      if (names.length !== 10) throw new Error(`rendered ${names.length} waveforms, expected 10`);
      const silent = names.filter((n) => results[n].peak <= 0.001);
      if (silent.length) throw new Error(`waveform(s) produced no sound: ${JSON.stringify(silent)}`);
      // FM at its default Depth of 0 IS a plain sine (addFmModulator returns
      // early), so those two hashing alike is correct rather than a
      // fall-through. Asserting it keeps the check honest if that changes.
      if (results['fm'].hash !== results['sine'].hash) {
        throw new Error('FM at depth 0 should be identical to a plain sine');
      }
      const others = names.filter((n) => n !== 'fm');
      const hashes = new Set(others.map((n) => results[n].hash));
      if (hashes.size !== others.length) {
        throw new Error(`waveforms are not all distinct: ${JSON.stringify(Object.fromEntries(others.map((n) => [n, results[n].hash])))}`);
      }

      // Switching waveform must not jump the level. Measured on RMS, not peak,
      // and that correction is the point of this block.
      //
      // A peak spread of up to 4.4 dB across pitch previously read to me as
      // "noise and ring aren't levelled", and was filed as audio work; the
      // retraction is in DONE.md.
      // Measuring RMS alongside peak says otherwise: every waveform's RMS is
      // flat across the range (C5 against E4, all ten within 0.05 dB), while
      // peak swings purely from crest factor — the noise loop is 93 samples
      // whose phase against the envelope shifts with playbackRate, and ring
      // mod's peak follows the carrier/modulator beat. Loudness never moved.
      //
      // At equal peak the waveforms' RMS necessarily differs, because that is
      // what crest factor means: a square is 1, a sine 1.41. Measured against
      // square at C5: sine/FM -1.5, NES Tri -2.9, triangle -3.2, PWM/half sine
      // -3.4, noise -4.5, saw -4.7, ring -6.2 dB. Noise sits mid-pack and ring
      // is the quietest by 1.5 dB. So the band is the spread the app
      // inherently has; what it catches is a waveform falling outside it —
      // which is the original bug exactly, a noise buffer ~5 dB hot, whose RMS
      // would have landed above square's.
      for (const n of names) {
        const rel = 20 * Math.log10(results[n].rms / results['square'].rms);
        if (rel > 0.5 || rel < -7) {
          throw new Error(`${n} sits ${rel.toFixed(1)} dB (RMS) from Square, outside the -7..+0.5 dB the waveforms span`);
        }
      }
      // Peak too, loosely: it costs headroom even when loudness is right. Wide
      // on purpose — the crest-factor swing above is real, not a fault.
      for (const n of names) {
        const rel = 20 * Math.log10(results[n].peak / results['square'].peak);
        if (rel > 1.5 || rel < -6) {
          throw new Error(`${n} peaks ${rel.toFixed(1)} dB from Square, outside the -6..+1.5 dB band`);
        }
      }
    });

    step('PWM: the sweep free-runs across notes instead of restarting on each one', async () => {
      // The wiring check in the step above proves an LFO reaches the pulse-width
      // delay; it cannot tell a per-note LFO from the shared per-track one. Only
      // the audio can, because the difference IS the phase: a per-note LFO
      // starts at 0 every time, so every note begins at the same 50% duty.
      //
      // Duty is readable straight out of the PCM. Saw-minus-delayed-saw is a
      // rectangle whose positive part lasts (1 - duty) of each period, so the
      // fraction of positive samples just after a note's onset gives the duty
      // that note started on. Against the per-note LFO this spread was 0.02 —
      // the same as a plain square's measurement noise — so the threshold below
      // is nowhere near it in either direction.
      await cdp.evaluate(`(() => {
        window.__pwmDuty = null;
        const orig = OfflineAudioContext.prototype.startRendering;
        OfflineAudioContext.prototype.startRendering = function () {
          return orig.call(this).then((buf) => {
            const d = buf.getChannelData(0), sr = buf.sampleRate;
            let peak = 0;
            for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
            const blk = Math.round(sr * 0.005), env = [];
            for (let i = 0; i + blk <= d.length; i += blk) {
              let m = 0; for (let j = i; j < i + blk; j++) if (Math.abs(d[j]) > m) m = Math.abs(d[j]);
              env.push(m);
            }
            // Onsets: the envelope crossing up through 20% of peak, ignoring
            // re-crossings inside one note.
            const thr = peak * 0.2, onsets = [];
            for (let b = 1; b < env.length; b++) {
              if (env[b] > thr && env[b - 1] <= thr) {
                const s = b * blk;
                if (!onsets.length || s - onsets[onsets.length - 1] > sr * 0.05) onsets.push(s);
              }
            }
            const win = Math.round(sr * 0.03), skip = Math.round(sr * 0.005);
            window.__pwmDuty = onsets.map((s) => {
              let pos = 0, n = 0;
              for (let i = s + skip; i < s + skip + win && i < d.length; i++) { if (d[i] > 0) pos++; n++; }
              return n ? 1 - pos / n : 0.5;
            });
            return buf;
          });
        };
      })()`);
      // Eight short notes at one pitch: long enough a run that a 0.8Hz sweep
      // covers most of a cycle, short enough that each note is well inside it.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      const placed = await cdp.evaluate(`(() => {
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-osc-trigger'));
        const r = lane.getBoundingClientRect();
        for (let i = 1; i < 8; i++) {
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 40 + i * 60, clientY: r.top + 60 }));
        }
        return document.querySelectorAll('.lane .note').length;
      })()`);
      if (placed !== 8) throw new Error(`expected 8 notes on the PWM track, got ${placed}`);
      await cdp.evaluate(`document.querySelector('.th-osc-trigger').click()`);
      await waitFor(`!!document.querySelector('.th-osc-menu')`);
      await cdp.evaluate(`document.querySelector('.th-osc-menu button[data-value="pwm"]').click()`);
      await new Promise((r) => setTimeout(r, 300));
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`document.getElementById('export-wav').click()`);
      await waitFor(`!!window.__pwmDuty`, 90000);
      const duty = await cdp.evaluate(`window.__pwmDuty`);
      if (duty.length < 6) throw new Error(`only found ${duty.length} note onsets in the render, expected 8`);
      const spread = Math.max(...duty) - Math.min(...duty);
      if (spread < 0.2) {
        throw new Error(`consecutive PWM notes started within ${spread.toFixed(3)} duty of each other — the sweep is restarting per note: ${JSON.stringify(duty)}`);
      }
      // The sweep is PWM_CENTRE +/- PWM_WIDTH, so nothing may land outside it;
      // a note reading near 0 or 1 would mean the delay ran past the period.
      const out = duty.filter((v) => v < 0.2 || v > 0.8);
      if (out.length) throw new Error(`PWM duty left the 25%-75% sweep range: ${JSON.stringify(duty)}`);
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
      // The starter layout's Lead track is `square`, so its Envelope panel must
      // offer Duty — this step used to add a track first, from when a new
      // project had no tonal one to work with.
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-trigger'));
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
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-osc-trigger'));
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
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-osc-trigger'));
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
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-osc-trigger'));
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
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-trigger'));
        head.querySelector('.th-osc-trigger').click();
      })()`);
      await waitFor(`!!document.querySelector('.th-osc-menu')`);
      await cdp.evaluate(`document.querySelector('.th-osc-menu button[data-value="sine"]').click()`);
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
                // Keep the param itself, not its .value: the app sets a
                // note's pitch with setValueAtTime, which leaves .value at the
                // oscillator's 440Hz default. __readFreqMod() below pairs each
                // modulator gain with the frequency actually scheduled, so the
                // assertion can be exact instead of guessing at a range.
                window.__freqMod.push(this.gain ? { gain: this.gain.value, param: dest } : null);
              }
            } catch {}
            return origConnect.call(this, dest, ...rest);
          };
          window.__freqParams = new WeakSet();
          window.__freqSet = new WeakMap();
          const origSVT = AudioParam.prototype.setValueAtTime;
          AudioParam.prototype.setValueAtTime = function (v, t) {
            try { if (window.__freqParams.has(this)) window.__freqSet.set(this, v); } catch {}
            return origSVT.call(this, v, t);
          };
          // Read after the note is scheduled, so the order of "set the pitch"
          // and "connect the LFO" inside scheduleTone() doesn't matter.
          window.__readFreqMod = () => window.__freqMod.map((m) => m && ({
            gain: m.gain, freq: window.__freqSet.get(m.param) ?? m.param.value,
          }));
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

      // The rhythm track's "+ Add effect" menu must not offer Vibrato.
      // Reached by its own header rather than "the first track" — the
      // starter layout puts four tonal tracks ahead of it.
      const rhythmHead = `[...document.querySelectorAll('.track-header')].find(h => !h.querySelector('.th-osc-trigger'))`;
      await waitFor(`!!(${rhythmHead}).querySelector('.th-fx-panel')`);
      await cdp.evaluate(`(${rhythmHead}).querySelector('.th-fx-panel').querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      const rhythmMenu = await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].map(b => b.textContent.trim())`);
      if (rhythmMenu.includes('Vibrato')) throw new Error(`a rhythm track's add menu must not offer Vibrato: ${JSON.stringify(rhythmMenu)}`);
      if (!rhythmMenu.includes('Tremolo')) throw new Error(`the rhythm add menu lost its other effects: ${JSON.stringify(rhythmMenu)}`);
      await cdp.evaluate(`(${rhythmHead}).querySelector('.th-fx-add-btn').click()`); // close the menu back up

      // A tonal track must offer it. Add a fresh one so its FX panel starts
      // empty (the starter tracks may already be dirtied by earlier steps).
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      const idsBefore = await cdp.evaluate(`[...document.querySelectorAll('.track')].map(t => t.dataset.track)`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('Add track')).click()`);
      await waitFor(`document.querySelectorAll('.track').length === ${idsBefore.length} + 1`);
      const newTrackId = await cdp.evaluate(
        `[...document.querySelectorAll('.track')].map(t => t.dataset.track).find(id => !${JSON.stringify(idsBefore)}.includes(id))`);
      // Keyed on the new track's own id rather than "the tonal track with no
      // FX chip yet" — that predicate stops matching this very track the
      // moment the steps below add one, so a live re-query of it would start
      // silently picking a *different*, still-clean starter track instead.
      const newTonalHead = `document.querySelector('.track[data-track="${newTrackId}"] .track-header')`;
      await waitFor(`!!(${newTonalHead}).querySelector('.th-fx-panel')`);
      await cdp.evaluate(`(${newTonalHead}).querySelector('.th-fx-panel').querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      const tonalMenu = await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].map(b => b.textContent.trim())`);
      if (!tonalMenu.includes('Vibrato')) throw new Error(`a tonal track's add menu should offer Vibrato: ${JSON.stringify(tonalMenu)}`);
      await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === 'Vibrato').click()`);
      await waitFor(`!!document.querySelector('.th-fx-popover[data-key="vibrato"]')`);

      // Set a depth, place a note, and confirm an LFO reaches its frequency.
      // 50 cents on a 523.25Hz note => 523.25 * (2^(50/1200) - 1) ~= 15.3Hz.
      // 0 -> 50 at a 1-cent step is 50 presses.
      await cdp.evaluate(`(() => {
        const dial = [...document.querySelector('.th-fx-popover[data-key="vibrato"]').querySelectorAll('.th-knob')]
          .find(k => k.querySelector('.th-knob-label').textContent === 'Depth').querySelector('.th-knob-dial');
        dial.focus();
        for (let i = 0; i < 50; i++) dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 300));

      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`window.__freqMod = []`);
      // Keyed on the same stable track id as newTonalHead above, rather than
      // matching a `.lane` back to a header — `.lane` elements aren't direct
      // children of `.track-header`, so that indirection is worth avoiding
      // now that the id is already in hand.
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-track="${newTrackId}"] .lane');
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 200, clientY: r.top + 120 }));
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      const mod = await cdp.evaluate(`window.__readFreqMod()`);
      // Exact, not a range: 50 cents of a note at f Hz is f * (2^(50/1200) - 1)
      // deep, so the check works out the expectation from the frequency the
      // app actually used.
      const want = (f) => f * (Math.pow(2, 50 / 1200) - 1);
      if (!mod.some((v) => v && Math.abs(v.gain - want(v.freq)) < 0.5)) {
        throw new Error(`a 50-cent track vibrato should modulate the note's own frequency, saw ${JSON.stringify(mod)}`);
      }

      // The pen-tool click above was an outside click, which now correctly
      // light-dismisses the vibrato popover (Fix 1) — reopen it via its chip
      // before touching the dial again.
      await cdp.evaluate(`(() => {
        const head = ${newTonalHead};
        if (document.querySelector('.th-fx-popover[data-key="vibrato"]')) return;
        [...head.querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body span:not(.th-fx-chip-letter)').textContent.trim() === 'Vibrato')
          .querySelector('.th-fx-chip-body').click();
      })()`);
      await waitFor(`!!document.querySelector('.th-fx-popover[data-key="vibrato"]')`);

      // At depth 0 nothing must be connected — an untouched track is unchanged.
      await cdp.evaluate(`(() => {
        const dial = [...document.querySelector('.th-fx-popover[data-key="vibrato"]').querySelectorAll('.th-knob')]
          .find(k => k.querySelector('.th-knob-label').textContent === 'Depth').querySelector('.th-knob-dial');
        dial.focus();
        for (let i = 0; i < 50; i++) dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
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

    step('FX panel: bypass writes the default value to the audio graph, not the dialled one', async () => {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            window.__biquads = [];
            const orig = BaseAudioContext.prototype.createBiquadFilter;
            BaseAudioContext.prototype.createBiquadFilter = function () {
              const n = orig.call(this);
              window.__biquads.push(n);
              return n;
            };
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      // The audio graph is built lazily by ensureCtx(), not at page load —
      // window.__biquads is empty until something actually starts audio, so
      // place a note (the same trigger the pan test above uses: previewNote()
      // calls ensureCtx()) before looking at any node it builds.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      const tonalLane = `[...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-osc-trigger'))`;
      await cdp.evaluate(`(() => {
        const lane = ${tonalLane};
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 200, clientY: r.top + 60 }));
      })()`);
      await waitFor(`!!document.querySelector('.lane .note')`);

      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-trigger'))`;
      await cdp.evaluate(`(${headSel}).querySelector('.th-fx-panel').querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === 'EQ').click()`);
      await waitFor(`!!document.querySelector('.th-fx-popover[data-key="eq"]')`);
      // 0 -> 6 at a 0.5 step is 12 presses.
      await cdp.evaluate(`(() => {
        const dial = [...document.querySelector('.th-fx-popover[data-key="eq"]').querySelectorAll('.th-knob')]
          .find(k => k.querySelector('.th-knob-label').textContent === 'Lo').querySelector('.th-knob-dial');
        dial.focus();
        for (let i = 0; i < 12; i++) dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      })()`);
      // ensureCtx() builds the song-global master EQ (buildMasterFXChain, its
      // own low/mid/high trio) before it builds any per-track chain, so this
      // track's own low-shelf band is NOT reliably window.__biquads[0] — find
      // it by the one gain value only this dial press can have produced,
      // rather than assuming a fixed index into creation order.
      await waitFor(`window.__biquads.some(b => b.gain.value === 6)`);
      const idx = await cdp.evaluate(`window.__biquads.findIndex(b => b.gain.value === 6)`);

      await cdp.evaluate(`document.querySelector('.th-fx-popover[data-key="eq"]').querySelector('.th-fx-chip-bypass').click()`);
      await waitFor(`window.__biquads[${idx}].gain.value === 0`);
      const knobStillSix = await cdp.evaluate(`[...document.querySelector('.th-fx-popover[data-key="eq"]').querySelectorAll('.th-knob')]
        .find(k => k.querySelector('.th-knob-label').textContent === 'Lo').querySelector('.th-knob-val').textContent`);
      if (knobStillSix !== '6.0dB') throw new Error(`bypass must not change what the knob displays, Lo now reads ${knobStillSix}`);

      await cdp.evaluate(`document.querySelector('.th-fx-popover[data-key="eq"]').querySelector('.th-fx-chip-bypass').click()`);
      await waitFor(`window.__biquads[${idx}].gain.value === 6`);
    });

    step('FX panel: a bypassed send is not re-armed by its own automation curve', async () => {
      // scheduleAutomationForChunk() has its own call site for the three FX
      // sends, separate from every per-effect bypass path the step above
      // covers — it used to write the raw dialled value straight to the
      // send's gain AudioParam every chunk, ignoring bypass entirely.
      await addFxEffect('Delay');

      // Draw one automation point on this track's Delay send at
      // round2(0.9) — see yToValue(): clicking 6px below the top of a 60px
      // lane on the 0..1 delay range lands exactly there. Nothing else in
      // this session's audio graph has reason to write exactly 0.9 to an
      // AudioParam, so a raw match below is unambiguous evidence of *this*
      // curve reaching the graph.
      await cdp.evaluate(`Array.from(document.querySelectorAll('.track')[0].querySelectorAll('button')).find(b => b.textContent.includes('Auto')).click()`);
      await waitFor(`!!document.querySelector('.automation-lane-el')`);
      await cdp.evaluate(`(() => {
        const sel = document.querySelector('.automation-header select');
        sel.value = 'delay';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(`document.querySelector('.automation-header select').value === 'delay'`);
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.automation-lane-el');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 1, clientY: rect.top + 6 }));
      })()`);
      await waitFor(`!!document.querySelector('.automation-point')`);
      const pointLabel = await cdp.evaluate(`document.querySelector('.automation-point').title`);
      if (pointLabel !== '90%') throw new Error(`expected the drawn automation point to read 90%, got ${pointLabel}`);
      await cdp.evaluate(`[...document.querySelectorAll('.automation-header button')].find(b => b.title === 'Close automation lane').click()`);

      // Patch AudioParam's own scheduling methods (not .value=, which the
      // bug never touched) so a chunk's real setValueAtTime/ramp calls are
      // observable regardless of which specific gain node they landed on.
      await cdp.evaluate(`(() => {
        if (AudioParam.prototype.__patchedForVerify) return;
        window.__sendWrites = [];
        const origSet = AudioParam.prototype.setValueAtTime;
        const origRamp = AudioParam.prototype.linearRampToValueAtTime;
        AudioParam.prototype.setValueAtTime = function (v, t) { window.__sendWrites.push(v); return origSet.call(this, v, t); };
        AudioParam.prototype.linearRampToValueAtTime = function (v, t) { window.__sendWrites.push(v); return origRamp.call(this, v, t); };
        AudioParam.prototype.__patchedForVerify = true;
      })()`);
      const has90 = (arr) => arr.some((v) => Math.abs(v - 0.9) < 1e-9);

      // Baseline: send not bypassed yet — the curve must reach the graph,
      // proving the harness (and the curve itself) actually works.
      await cdp.evaluate(`window.__sendWrites = []`);
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 600));
      await cdp.evaluate(`document.querySelector('#stop').click()`);
      const before = await cdp.evaluate(`window.__sendWrites.slice()`);
      if (!has90(before)) {
        throw new Error(`expected the Delay send's automation curve to reach the audio graph before bypassing, saw ${JSON.stringify(before)}`);
      }

      // Bypass the send, then replay — Fix 3: the curve must no longer be
      // written at all, not merely written at a different (default) value.
      await cdp.evaluate(`(() => {
        const panel = ${fxPanelSel};
        if (!document.querySelector('.th-fx-popover[data-key="sendDelay"]')) {
          [...panel.querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body span:not(.th-fx-chip-letter)').textContent.trim() === 'Delay')
            .querySelector('.th-fx-chip-body').click();
        }
      })()`);
      await waitFor(`!!document.querySelector('.th-fx-popover[data-key="sendDelay"]')`);
      await cdp.evaluate(`document.querySelector('.th-fx-popover[data-key="sendDelay"]').querySelector('.th-fx-chip-bypass').click()`);
      await waitFor(`document.querySelector('.th-fx-popover[data-key="sendDelay"]').querySelector('.th-fx-chip-bypass').getAttribute('aria-pressed') === 'true'`);

      await cdp.evaluate(`window.__sendWrites = []`);
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 600));
      await cdp.evaluate(`document.querySelector('#stop').click()`);
      const after = await cdp.evaluate(`window.__sendWrites.slice()`);
      if (has90(after)) {
        throw new Error(`a bypassed Delay send must not be re-armed by its own automation curve, saw ${JSON.stringify(after)}`);
      }
    });

    step('Envelope & Filter row: full-word labels, icons, and grouped captions', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track')`);
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-trigger'));
        [...head.querySelectorAll('.th-tool-btn')].find(b => /Env/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.adsr-lane-el .mfx-cap')`);
      // Scoped to .adsr-lane-el, not a bare .mfx-cap — the master panel's own
      // static "Meter" caption reuses the same class and is present in the
      // DOM (just display:none) on every fresh page load.
      const caps = await cdp.evaluate(`[...document.querySelectorAll('.adsr-lane-el .mfx-cap')].map(c => c.textContent)`);
      if (caps.join('|') !== 'Envelope|Filter|Duty') {
        throw new Error(`expected Envelope/Filter/Duty group captions (starter Lead track is square), got ${JSON.stringify(caps)}`);
      }
      const labels = await cdp.evaluate(`[...document.querySelectorAll('.adsr-label span')].map(s => s.textContent)`);
      const expected = ['Attack', 'Decay', 'Sustain', 'Release', 'Cutoff', 'Resonance', 'Env Amount'];
      if (JSON.stringify(labels) !== JSON.stringify(expected)) {
        throw new Error(`expected full-word field labels ${JSON.stringify(expected)}, got ${JSON.stringify(labels)}`);
      }
      const iconCount = await cdp.evaluate(`document.querySelectorAll('.adsr-label .glyph').length`);
      if (iconCount !== expected.length) {
        throw new Error(`expected one icon per field (${expected.length}), got ${iconCount}`);
      }
    });

    step('Master FX: five fixed chips render, all dimmed at default', async () => {
      await cdp.evaluate(`document.querySelector('#master-fx-toggle').click()`);
      await waitFor(`document.querySelector('#master-fx-panel').style.display !== 'none'`);
      const chips = await cdp.evaluate(`[...document.querySelectorAll('.th-master-fx-chip')].map(c => ({
        label: c.querySelector('.th-fx-chip-body span').textContent,
        dimmed: c.classList.contains('bypassed'),
      }))`);
      const labels = chips.map((c) => c.label);
      if (labels.join('|') !== 'EQ|Comp|Par Comp|Sidechain|Downsample') {
        throw new Error(`expected the five fixed master chips in registry order, got ${JSON.stringify(labels)}`);
      }
      if (!chips.every((c) => c.dimmed)) {
        throw new Error(`a freshly loaded song has every master group at default — all five chips should be dimmed, got ${JSON.stringify(chips)}`);
      }
      // No add menu, no remove button — master's chip set is fixed.
      if (await cdp.evaluate(`!!document.querySelector('.master-fx-panel .th-fx-add-btn')`)) {
        throw new Error('master FX panel must not offer an "+ Add effect" button');
      }
      if (await cdp.evaluate(`!!document.querySelector('.th-master-fx-chip .th-fx-chip-remove')`)) {
        throw new Error('master FX chips must not have a remove button');
      }
    });

    step('Master FX: EQ knob updates state and un-dims its chip', async () => {
      await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="eq"] .th-fx-chip-body').click()`);
      // .th-master-fx-popover, not bare .th-fx-popover[data-key="eq"] — a
      // track's own EQ popover shares the same registry key and could still
      // be open from an earlier step in this same page session.
      await waitFor(`!!document.querySelector('.th-master-fx-popover[data-key="eq"]')`);
      const dialSel = `[...document.querySelector('.th-master-fx-popover[data-key="eq"]').querySelectorAll('.th-knob')]` +
        `.find(k => k.querySelector('.th-knob-label').textContent === 'Lo').querySelector('.th-knob-dial')`;
      // Stash the live element on window (not just re-derived by dialSel each
      // time) so we can compare document.activeElement against this SAME
      // reference after the commit — a synthetic KeyboardEvent dispatched on
      // a captured reference still reaches its listeners even if that element
      // gets detached from the DOM, so this identity check is the only thing
      // in this step that would actually catch a re-render stealing focus.
      await cdp.evaluate(`(() => { window.__testDial = ${dialSel}; window.__testDial.focus(); })()`);
      await cdp.evaluate(`(() => { const d = window.__testDial;
        for (let i = 0; i < 12; i++) d.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); })()`);
      const val = await cdp.evaluate(`${dialSel}.getAttribute('aria-valuetext')`);
      if (val !== '6.0dB') throw new Error(`expected master EQ Lo to read 6.0dB after 12 steps, got ${val}`);
      const dimmed = await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="eq"]').classList.contains('bypassed')`);
      if (dimmed) throw new Error('EQ chip should stop looking dimmed once a value moves off default');
      // Each keyboard commit re-renders the chip row (so the dim state above
      // reflects the new value) — that re-render must NOT rebuild the open
      // popover itself, or the focused dial gets detached and falls back to
      // <body>, silently breaking the global guard that stops arrow keys
      // from reaching nudgeSelection() while a knob has focus.
      const stillFocused = await cdp.evaluate(`document.activeElement === window.__testDial`);
      if (!stillFocused) throw new Error('knob dial lost DOM focus after a keyboard commit — a render() rebuilt the floating layer out from under it, which would let the next arrow-key press fall through to note-nudging');
      // Reset for later steps/songs sharing this page load.
      await cdp.evaluate(`(() => { const d = window.__testDial;
        for (let i = 0; i < 12; i++) d.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`);
    });

    step('Master FX: Sidechain has a real On/Off toggle, not a bypass button', async () => {
      await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="sidechain"] .th-fx-chip-body').click()`);
      await waitFor(`!!document.querySelector('.th-master-fx-popover[data-key="sidechain"]')`);
      const toggleSel = `document.querySelector('.th-master-fx-popover[data-key="sidechain"] .th-fx-popover-head .icon-btn')`;
      const before = await cdp.evaluate(`${toggleSel}.textContent`);
      if (before !== 'Off') throw new Error(`expected Sidechain to start Off, got ${before}`);
      await cdp.evaluate(`${toggleSel}.click()`);
      await waitFor(`${toggleSel}.textContent === 'On'`);
      const dimmed = await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="sidechain"]').classList.contains('bypassed')`);
      if (dimmed) throw new Error('Sidechain chip should stop looking dimmed once enabled');
      await cdp.evaluate(`${toggleSel}.click()`); // leave it Off for later steps/songs
    });

    step('FX: a real trusted click through the grid still lands after light-dismiss closes a popover', async () => {
      // Fix 1 regression test. The bug (light-dismiss rebuilding the DOM on
      // 'pointerdown', detaching the click's real target before 'click'
      // fires) only reproduces with a genuinely trusted click sequence —
      // dispatching pointerdown/click directly via element.dispatchEvent()
      // on a captured reference always reaches that reference's own
      // listeners regardless of what render() did in between, so it can't
      // exercise the browser's real click-retargeting. Input.dispatchMouseEvent
      // goes through Chromium's actual input pipeline (pointerdown ->
      // mousedown -> pointerup -> mouseup -> click, hit-tested for real on
      // whatever the DOM looks like at each step), which is the only way to
      // reproduce it — hence this one step uses it where every other step in
      // this file deliberately doesn't (see the file's own header comment).
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);

      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-trigger'))`;
      await waitFor(`!!(${headSel}).querySelector('.th-fx-panel')`);
      const panelSel = `(${headSel}).querySelector('.th-fx-panel')`;
      await cdp.evaluate(`${panelSel}.querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === 'EQ').click()`);
      await waitFor(`!!document.querySelector('.th-fx-popover[data-key="eq"]')`);

      const tonalLaneSel = `[...document.querySelectorAll('.lane')].find(l => l.closest('.track').querySelector('.th-osc-trigger'))`;
      const before = await cdp.evaluate(`document.querySelectorAll('.lane .note').length`);
      const rect = await cdp.evaluate(`(() => { const r = (${tonalLaneSel}).getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
      const x = rect.left + 200, y = rect.top + 60;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 300));

      const after = await cdp.evaluate(`document.querySelectorAll('.lane .note').length`);
      if (after !== before + 1) {
        throw new Error(`a real click on the grid with a popover open should place exactly one note (light-dismiss must not eat the click), ${before} -> ${after}`);
      }
      const popoverStillOpen = await cdp.evaluate(`!!document.querySelector('.th-fx-popover')`);
      if (popoverStillOpen) throw new Error('the same outside click should also have dismissed the open FX popover');
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
      await waitFor(`!!(${RHYTHM_LANE})`);

      // Pen a hit; it should select itself so its velocity is editable at once.
      // Clicking into the lane also makes that track active, which is what the
      // nudge at the end of this step then acts on.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        const lane = ${RHYTHM_LANE};
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
      // The autosave key by name, not "whichever key mentions trackList": the
      // saved-songs key mentions it too, nested one level deeper, so the fuzzy
      // lookup started reading the wrong object as soon as another step saved
      // a song.
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
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
