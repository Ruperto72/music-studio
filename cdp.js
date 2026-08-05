// Shared Chrome DevTools Protocol plumbing for this repo's Node-side tools:
// verify.js (smoke test), shots.js (screenshots) and icons.js (app icon).
//
// This file exists because the same ~120 lines were hand-copied into two
// tools and drifted: shots.js shipped without the hardcoded browser
// install-path list its sibling had, so on a machine where Chrome is not on
// PATH — the common case, since the installer writes an App Paths registry
// key rather than a PATH entry — findBrowser() returned null and the tool
// could not run at all, while verify.js on the same box worked fine. A third
// copy was about to be written. Node built-ins only, matching the repo's
// no-dependencies rule; see verify.js's header for the longer argument.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

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
  // Chrome's installer registers an App Paths key rather than adding itself
  // to PATH, so `where chrome.exe` misses a perfectly ordinary install.
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

// Launches headless Chromium on an *ephemeral* debugging port (`0`) and
// learns the real one by reading the DevTools URL the browser prints to
// stderr. Both callers used to pick a port themselves — verify.js a random
// one in a 500-wide range, which can still collide with a concurrent run.
//
// cleanup() waits for the process to actually exit before deleting its
// profile directory, then retries: on Windows kill() returns while the
// renderer processes still hold file locks, and a single delete throws
// EBUSY.
async function launchChrome(browserPath, { args = [], profilePrefix = 'music-studio-' } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));

  let chrome;
  try {
    chrome = spawn(browserPath, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-sandbox', '--disable-gpu', '--no-first-run',
      ...args,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    // spawn() doesn't only fail asynchronously: an executable-format error
    // (e.g. CHROME_PATH pointing at a non-executable file) throws here,
    // synchronously, before there is a child process for cleanup() below to
    // wait on — so there is nothing to do but remove the profile dir directly.
    fs.rmSync(profile, { recursive: true, force: true });
    throw e;
  }

  const cleanup = async () => {
    await new Promise((resolve) => { chrome.once('exit', resolve); chrome.kill(); setTimeout(resolve, 3000); });
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  };

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('browser never printed its DevTools URL')), 15000);
      // spawn()'s 'error' event is not a promise rejection — an unlistened
      // one crashes the process with a raw Node stack and skips cleanup()
      // entirely, leaking this function's own profile dir. Racing it in here
      // is what lets the catch below run.
      chrome.once('error', (e) => { clearTimeout(t); reject(e); });
      chrome.stderr.on('data', (c) => {
        buf += c.toString();
        const m = buf.match(/ws:\/\/[^\s]+/);
        if (m) { clearTimeout(t); resolve(m[0]); }
      });
    });
    const httpBase = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    return { chrome, httpBase, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

// Opens a fresh tab and attaches to *its* socket rather than the browser's.
// Flat mode would work too, but its sessionId belongs in the message envelope
// rather than in params — a distinction that is easy to get wrong and reports
// itself as "'Page.enable' wasn't found", which sounds like a missing domain
// rather than a misrouted call.
async function openPage(httpBase) {
  const tab = await httpJson(`${httpBase}/json/new?about:blank`, 'PUT');
  const cdp = await CDP.attach(tab.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

// A CDP request that gets no reply used to hang the whole run — see send().
// Two minutes is far past any legitimate call (the slowest is an offline WAV
// render inside Runtime.evaluate) and far short of noticing by hand.
const CDP_REQUEST_TIMEOUT_MS = 120000;

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
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || {})})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }
  static async attach(wsUrl) {
    const cdp = new CDP(wsUrl);
    await cdp.ready;
    return cdp;
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  // Every request gets a deadline. Without one a reply that never arrives
  // parks its promise in `pending` forever, and because waitFor() reaches the
  // browser through here, *its* own timeout never gets to count down — it is
  // blocked inside its very first evaluate(). That is how a run once sat
  // silent for 25 minutes with a five-second timeout in the call stack.
  send(method, params = {}, timeoutMs = CDP_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        // Drop it first: a late reply must not resolve an already-rejected
        // promise, and leaving it in `pending` would leak one entry per hang.
        this.pending.delete(id);
        reject(new Error(`CDP ${method} did not reply within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  // Runs `expr` as a plain script in the page's top-level scope (NOT the
  // app's own module scope, which JS modules keep private — but DOM
  // mutations/queries and dispatching real events on elements work exactly
  // like a user interacting with the page). Throws if the page threw.
  async evaluate(expr) {
    const res = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('Page threw: ' + (d.exception?.description || d.text));
    }
    return res.result.value;
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

module.exports = { findBrowser, httpJson, waitForHttp, launchChrome, openPage, CDP };
