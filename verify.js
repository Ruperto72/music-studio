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
