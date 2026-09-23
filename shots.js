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
// Usage: node shots.js [--only <substring>]
//   CHROME_PATH=/path/to/chrome   override browser auto-discovery
//   SHOTS_PORT=8097               port for the throwaway dev-server instance
//   --only <substring>            shoot only files whose name contains this
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findBrowser, requireFreePort, waitForHttp, launchChrome, openPage } = require('./cdp.js');

const SERVER_PORT = process.env.SHOTS_PORT || 8097;
const APP_URL = `http://127.0.0.1:${SERVER_PORT}`;
const OUT_DIR = path.join(__dirname, 'docs', 'img');
const onlyIdx = process.argv.indexOf('--only');
if (onlyIdx >= 0 && !process.argv[onlyIdx + 1]) { console.error('usage: node shots.js [--only <substring>]'); process.exit(1); }
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1].toLowerCase() : null;

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
  // ---- help.html's own shots, below docs/img/help/ rather than docs/img/
  // directly so the README's three stay easy to tell apart from the guide's. ----
  {
    file: 'help/menu-open.png',
    width: 1200, height: 800,
    caption: 'the file menu open, showing Songs/Save/Load/Export',
    async setup(page) {
      await page.loadSong('Rust Foundry');
      await page.evaluate(`document.getElementById('file-menu-toggle').click()`);
    },
  },
  {
    file: 'help/envelope-panel.png',
    width: 1200, height: 800,
    caption: "a track's Env panel — ADSR, filter and FM/duty",
    async setup(page) {
      await page.loadSong('Rust Foundry');
      await page.evaluate(`(() => {
        const head = document.querySelector('.track[data-kind="pitch"] .track-header');
        [...head.querySelectorAll('.th-tool-btn')].find(b => /Env/.test(b.textContent)).click();
      })()`);
      await page.waitFor(`[...document.querySelectorAll('.automation-title')].some(t => t.textContent.startsWith('Envelope'))`);
    },
  },
  {
    file: 'help/patterns-dialog.png',
    width: 1200, height: 800,
    caption: 'the Patterns dialog, inserting a built-in groove',
    async setup(page) {
      await page.loadSong('Rust Foundry');
      await page.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await page.waitFor(`document.getElementById('pattern-dialog').open`);
    },
  },
  {
    file: 'help/note-inspector.png',
    width: 1200, height: 800,
    caption: 'a selected note in the inspector column',
    async setup(page) {
      await page.loadSong('Rust Foundry');
      await page.waitFor(`!!document.querySelector('.track .lane .note')`);
      // Note selection is the note's own 'click' handler (under the Pen tool,
      // which is the default) — a plain .click() fires it directly.
      await page.evaluate(`document.querySelector('.track .lane .note').click()`);
      await page.waitFor(`!document.querySelector('.inspector.empty')`);
      // With Arpeggio chosen, so the picture shows what a movement brings with
      // it — its own field and presets — rather than four bare choices.
      await page.evaluate(`document.querySelector('.inspector [data-move="arp"]').click()`);
      await page.waitFor(`!!document.querySelector('.inspector .preset-grid button[data-arp]')`);
    },
  },
  // ---- The "From idea to song" walkthrough. These start from the starter
  // layout rather than a bundled song, because that is where the walkthrough
  // starts: an empty Lead/Harmony/Bass/Pad and a kit. ----
  {
    file: 'help/follow-chords.png',
    width: 1200, height: 800,
    caption: 'Chords & parts, opened from the Bass track, following Harmony',
    async setup(page) {
      await page.setKey(0, 'major');
      await page.insertProgression('Harmony', 'I–V–vi–IV');
      await page.openChords('Bass');
      // The dialog opens at its top, on the progressions; the picture is of
      // its second half.
      await page.evaluate(`document.querySelector('#progression-dialog .dialog-sub').scrollIntoView({ block: 'start' })`);
    },
  },
  {
    file: 'help/ghost-notes.png',
    width: 1200, height: 800,
    caption: 'ghost notes: Harmony and Bass drawn faintly in the Lead roll',
    async setup(page) {
      await page.setKey(0, 'major');
      await page.insertProgression('Harmony', 'I–V–vi–IV');
      await page.insertPart('Bass', 'Root–fifth');
      // A short melody on the Lead, placed through the lane like a click, so
      // the picture shows your notes over the ghosts rather than ghosts alone.
      await page.activate('Lead');
      for (const [midi, col] of [[72, 0], [71, 2], [72, 4], [76, 6], [74, 8], [71, 10], [67, 12], [69, 16], [72, 18], [74, 20], [72, 22]]) {
        await page.placeNote('Lead', midi, col);
      }
      await page.evaluate(`document.getElementById('daw').scrollTop = 0`);
    },
  },
  {
    file: 'help/euclid-layer.png',
    width: 1200, height: 800,
    caption: 'the euclidean layer in the Patterns dialog, on the tresillo',
    async setup(page) {
      await page.evaluate(`[...document.querySelectorAll('.track-header button')].find(b => (b.title || '').startsWith('Rhythm patterns')).click()`);
      await page.waitFor(`document.getElementById('pattern-dialog').open`);
      await page.evaluate(`document.querySelector('#euclid-presets button[data-euclid="Tresillo"]').click()`);
      await page.evaluate(`document.querySelector('#pattern-dialog .dialog-sub').scrollIntoView({ block: 'start' })`);
    },
  },
  {
    file: 'help/variation-dialog.png',
    width: 1200, height: 800,
    caption: 'the Variation dialog',
    async setup(page) {
      await page.loadSong('Neon Drive');
      await page.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await page.evaluate(`document.getElementById('vary-btn').click()`);
      await page.waitFor(`document.getElementById('vary-dialog').open`);
    },
  },
  {
    file: 'help/arrange-dialog.png',
    width: 1200, height: 800,
    caption: "the Arrange dialog, listing Cinematic's sections",
    async setup(page) {
      await page.loadSong('Cinematic');
      await page.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await page.evaluate(`document.getElementById('arrange-btn').click()`);
      await page.waitFor(`document.getElementById('arrange-dialog').open`);
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
    // Accept the app's own questions ("unsaved changes — load anyway?") the way a
    // person setting up the shot would; unanswered, one stalls every evaluate.
    cdp.on('Page.javascriptDialogOpening', () => { cdp.send('Page.handleJavaScriptDialog', { accept: true }); });

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
      // The rest drive the starter layout by track *name*, through the same
      // buttons and dialogs a person uses.
      row: (name) => `[...document.querySelectorAll('#tracks > .track[data-kind="pitch"]')].find(t => t.querySelector('.th-name')?.textContent === ${JSON.stringify(name)})`,
      async setKey(root, scale) {
        await cdp.evaluate(`(() => {
          const sc = document.getElementById('key-scale'); sc.value = ${JSON.stringify(scale)}; sc.dispatchEvent(new Event('change', { bubbles: true }));
          const k = document.getElementById('key-root'); k.value = ${JSON.stringify(String(root))}; k.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      },
      async activate(name) {
        await cdp.evaluate(`${page.row(name)}.querySelector('.track-header').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
        await page.waitFor(`${page.row(name)}.classList.contains('active')`);
      },
      async openChords(name) {
        await cdp.evaluate(`[...${page.row(name)}.querySelectorAll('.th-tool-btn')].find(b => /progression/i.test(b.title)).click()`);
        await page.waitFor(`document.getElementById('progression-dialog').open`);
      },
      async insertFrom(listId, title) {
        await cdp.evaluate(`(() => {
          const row = [...document.querySelectorAll('#${listId} .song-item')].find(r => r.querySelector('.song-title').textContent === ${JSON.stringify(title)});
          [...row.querySelectorAll('button')].find(b => b.textContent === 'Insert').click();
        })()`);
      },
      async insertProgression(name, title) {
        await page.openChords(name);
        await page.insertFrom('progression-list', title);
        await page.waitFor(`${page.row(name)}.querySelectorAll('.lane .note').length > 0`);
      },
      async insertPart(name, title) {
        await page.openChords(name);
        await page.insertFrom('follow-list', title);
        await page.waitFor(`${page.row(name)}.querySelectorAll('.lane .note').length > 0`);
      },
      // A click on the lane at the row of the gutter's own key for `midi`.
      async placeNote(name, midi, col) {
        const before = await cdp.evaluate(`${page.row(name)}.querySelectorAll('.lane .note').length`);
        await cdp.evaluate(`(() => {
          const row = ${page.row(name)};
          const key = row.querySelector('.pkey[data-midi="${midi}"]');
          const lane = row.querySelector('.lane');
          const k = key.getBoundingClientRect(), l = lane.getBoundingClientRect();
          const colPx = l.width / parseInt(lane.style.gridTemplateColumns.split('(')[1], 10);
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: l.left + colPx * ${col} + 2, clientY: k.top + k.height / 2 }));
        })()`);
        await page.waitFor(`${page.row(name)}.querySelectorAll('.lane .note').length > ${before}`);
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
    const toShoot = ONLY ? SHOTS.filter((s) => s.file.toLowerCase().includes(ONLY)) : SHOTS;
    for (const shot of toShoot) {
      const setupAt = shot.loadAt || shot;
      await viewport(setupAt.width, setupAt.height);
      // Same reasoning as verify.js's goto(): a shot's setup may leave the
      // song with unsaved changes, and the app's leave-page prompt must not
      // stall the next navigation.
      await cdp.evaluate(`window.addEventListener('beforeunload', (e) => e.stopImmediatePropagation(), true)`).catch(() => {});
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
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      const kb = Math.round(fs.statSync(out).size / 1024);
      console.log(`  ${shot.file.padEnd(20)} ${shot.width}x${shot.height} @2x  ${String(kb).padStart(4)} kB  — ${shot.caption}`);
    }
    console.log(`\nWrote ${toShoot.length} screenshot(s) to docs/img/.`);
  } finally {
    if (cdp) cdp.close();
    if (launched) await launched.cleanup();
    if (server) server.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
