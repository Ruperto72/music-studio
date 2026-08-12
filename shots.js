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
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findBrowser, requireFreePort, waitForHttp, launchChrome, openPage } = require('./cdp.js');

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

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('No Chromium-family browser found. Set CHROME_PATH=/path/to/chrome.');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let server, launched, cdp;
  try {
    await requireFreePort(SERVER_PORT, 'SHOTS_PORT');
    server = spawn(process.execPath, [path.join(__dirname, 'dev-server.js')], {
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForHttp(APP_URL, 10000);
    launched = await launchChrome(browser, {
      profilePrefix: 'shots-',
      // Deterministic text: without this the same page can shoot with
      // different subpixel rendering between runs, so every image would show
      // as changed in a diff even when nothing did.
      args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--font-render-hinting=none'],
    });
    cdp = await openPage(launched.httpBase);

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
    if (cdp) cdp.close();
    if (launched) await launched.cleanup();
    if (server) server.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
