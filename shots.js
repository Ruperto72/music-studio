// Regenerates the screenshots in docs/img/ that README.md links to.
//
// Docs go stale quietly; pictures of a UI go stale loudly and are the first
// thing a reader sees. So this is a checked-in tool rather than a one-off
// script: when the interface changes, `node shots.js` re-shoots every image
// with the same framing, and the diff shows what actually moved.
//
// Same shape as verify.js and for the same reason — it starts its own
// dev-server on a throwaway port, drives a headless Chromium over the Chrome
// DevTools Protocol using only Node's own built-ins, and adds no dependency
// to a project that deliberately has none. See verify.js's header for the
// longer argument.
//
// Usage: node shots.js
//   CHROME_PATH=/path/to/chrome   override browser auto-discovery
//   SHOTS_PORT=8097               port for the throwaway dev-server instance
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SERVER_PORT = process.env.SHOTS_PORT || 8097;
const APP_URL = `http://127.0.0.1:${SERVER_PORT}`;
const OUT_DIR = path.join(__dirname, 'docs', 'img');

// Each shot names the viewport it is framed for, so a picture is never
// "whatever the window happened to be" — the editor one is a 16:10 desktop,
// the player one a phone.
const SHOTS = [
  {
    file: 'editor.png',
    width: 1440, height: 900,
    caption: 'the editor with a song loaded',
    async setup(page) {
      // Rust Foundry rather than a sparser song: its tracks actually carry
      // inserts, so the inspector column shows the FX strip doing its job
      // instead of "No effects on this track yet", which is a true but
      // useless picture of it.
      await page.loadSong('Rust Foundry');
      await page.clickFirstFxChip();
      await page.scrollToMusic();
    },
  },
  {
    file: 'master.png',
    width: 1440, height: 900,
    caption: 'the master bus in the inspector column',
    async setup(page) {
      await page.loadSong('Neon Drive');
      await page.evaluate(`document.getElementById('master-fx-toggle').click()`);
    },
  },
  {
    file: 'player.png',
    width: 420, height: 880,
    caption: 'the phone player',
    // Load at desktop width first: below 760px the whole editor — the menu
    // this goes through included — is hidden, so driving it there would be
    // clicking something the user cannot see. The player reads the same
    // state either way.
    loadAt: { width: 1200, height: 900 },
    async setup(page) {
      await page.loadSong('Froggy Hop');
    },
  },
];

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
  // Chrome's installer registers an App Paths key rather than adding itself to
  // PATH, so `where chrome.exe` misses a perfectly ordinary install. Same list
  // verify.js carries, for the same reason.
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

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
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

const CDP_REQUEST_TIMEOUT_MS = 60000;
class CDP {
  constructor(ws) { this.ws = ws; this.nextId = 1; this.pending = new Map(); }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || {})})`));
        else resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} did not reply within ${CDP_REQUEST_TIMEOUT_MS}ms`));
      }, CDP_REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate threw');
    return res.result.value;
  }
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('No Chromium-family browser found. Set CHROME_PATH=/path/to/chrome.');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // The profile directory is made before anything is spawned, and every spawn
  // happens inside the try: whatever fails, the finally below is reached with
  // the processes it has to kill already in variables it can see.
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shots-'));
  let server, chrome;
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'dev-server.js')], {
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForHttp(APP_URL, 10000);
    chrome = spawn(browser, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      // Deterministic text: without this the same page can shoot with
      // different subpixel rendering between runs, so every image would show
      // as changed in a diff even when nothing did.
      '--force-device-scale-factor=2', '--font-render-hinting=none',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('browser never printed its DevTools URL')), 15000);
      chrome.stderr.on('data', (c) => {
        buf += c.toString();
        const m = buf.match(/ws:\/\/[^\s]+/);
        if (m) { clearTimeout(t); resolve(m[0]); }
      });
    });
    // Attach straight to the page target's own socket rather than the
    // browser's. Flat mode would work too, but its sessionId belongs in the
    // message envelope rather than in params — a distinction that is easy to
    // get wrong and reports itself as "'Page.enable' wasn't found", which
    // sounds like a missing domain rather than a misrouted call.
    const httpBase = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const targets = await httpJson(`${httpBase}/json/list`);
    const pageTarget = targets.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('the browser exposed no page target to attach to');
    const cdp = await CDP.attach(pageTarget.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const page = {
      evaluate: (e) => cdp.evaluate(e),
      // The same gesture verify.js drives, for the same reason: going through
      // the real menu means a screenshot can never show a state the app
      // cannot actually reach.
      async loadSong(name) {
        await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
        await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Songs')).click()`);
        await page.waitFor(`document.querySelectorAll('.song-item').length > 0`);
        await cdp.evaluate(`
          const row = Array.from(document.querySelectorAll('.song-item')).find(r => r.querySelector('.song-title')?.textContent === ${JSON.stringify(name)});
          row.querySelector('button').click();
        `);
        await page.waitFor(`document.querySelector('#song-name-display').textContent === ${JSON.stringify(name)}`);
        await new Promise((r) => setTimeout(r, 600)); // let the lanes settle
      },
      // Errors while polling are expected rather than exceptional: the page
      // may still be blank, so an expression that reaches into the DOM throws
      // until the thing it names exists. Only the deadline is a failure.
      // Point the inspector's strip at a real effect. Throws rather than
      // quietly shooting an empty panel: a screenshot that shows the wrong
      // thing is worse than none.
      async clickFirstFxChip() {
        await page.waitFor(`!!document.querySelector('.th-fx-chip[data-track] .th-fx-chip-body')`);
        await cdp.evaluate(`document.querySelector('.th-fx-chip[data-track] .th-fx-chip-body').click()`);
        await page.waitFor(`!!document.querySelector('.inspector .th-strip-section .th-knob')`);
      },
      // Frame the grid on some actual music. A song's first bars are often an
      // intro with a couple of hits in them, and an empty piano roll is a poor
      // picture of the one thing the editor is mostly made of.
      async scrollToMusic() {
        await cdp.evaluate(`(() => {
          const daw = document.getElementById('daw');
          // The FIRST track's first note, not the earliest note anywhere: a
          // song usually has something at bar 1 on a track that is scrolled
          // out of view vertically, and aiming at that leaves the lanes you
          // can actually see empty — which is what the first attempt did.
          const n = document.querySelector('.track .lane .note');
          if (!n) return;
          daw.scrollLeft = Math.max(0, n.offsetLeft - 120);
        })()`);
        await new Promise((r) => setTimeout(r, 300));
      },
      async waitFor(expr, timeoutMs = 8000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try { if (await cdp.evaluate(`!!(${expr})`)) return; } catch { /* not there yet */ }
          await new Promise((r) => setTimeout(r, 60));
        }
        throw new Error(`Timed out waiting for: ${expr}`);
      },
    };

    const viewport = (w, h) => cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 2, mobile: w < 760,
    });
    for (const shot of SHOTS) {
      const setupAt = shot.loadAt || shot;
      await viewport(setupAt.width, setupAt.height);
      await cdp.send('Page.navigate', { url: APP_URL });
      await page.waitFor(`!!document.querySelector('.th-osc-trigger') || document.getElementById('player')?.hidden === false`);
      if (shot.setup) await shot.setup(page);
      if (shot.loadAt) {
        await viewport(shot.width, shot.height);
        await page.waitFor(`document.getElementById('player')?.hidden === false`);
      }
      await new Promise((r) => setTimeout(r, 400));
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const out = path.join(OUT_DIR, shot.file);
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      const kb = Math.round(fs.statSync(out).size / 1024);
      console.log(`  ${shot.file.padEnd(12)} ${shot.width}x${shot.height} @2x  ${String(kb).padStart(4)} kB  — ${shot.caption}`);
    }
    console.log(`\nWrote ${SHOTS.length} screenshots to docs/img/.`);
  } finally {
    // Wait for the browser to actually exit before deleting its profile: on
    // Windows kill() returns while the renderer processes still hold file
    // locks, and the delete then fails with EBUSY. Retry anyway, since the
    // exit event itself is not a promise that every handle is closed.
    if (chrome) await new Promise((resolve) => { chrome.once('exit', resolve); chrome.kill(); setTimeout(resolve, 3000); });
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    if (server) server.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
