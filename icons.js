// Draws the app icon and writes every file the app declares — the two SVGs
// index.html and the docs reference, and the six PNGs the manifest, Apple and
// the favicon fallback need.
//
// Checked in for the reason shots.js is: the previous icons came from a
// one-off script nobody kept, so "change the icon" meant writing a PNG
// encoder from scratch. Now it is `node icons.js`.
//
// The mark is the `pwm` entry from index.html's GLYPHS table restated as a
// filled shape: three pulses of growing width standing on a floor. What grows
// across the icon is the share of each cycle that is high — duty, which is
// what pulse-width modulation modulates, and what this editor does that a
// generic sequencer does not.
//
// Usage: node icons.js
//   CHROME_PATH=/path/to/chrome   override browser auto-discovery
'use strict';
const fs = require('fs');
const path = require('path');
const { findBrowser, launchChrome, openPage } = require('./cdp.js');

const OUT_DIR = path.join(__dirname, 'icons');

// ---- The mark: defined once, here. ----
// Pulses 8, 17 and 22 units wide with 16 and 13 units between them, tops at
// y=32, standing on a floor 6 units thick (y=68..74).
const MARK = 'M6 74 H94 V68 H90 V32 H68 V68 H55 V32 H38 V68 H22 V32 H14 V68 H6 Z';
const GRADIENT = ['#2ff3ff', '#ff2fb0']; // TRACK_PALETTE[0] and [1]
const BG = '#131316';                    // --bg, and the manifest's theme_color

// A framing is a background shape plus a motif scale, and nothing else.
//
// `maskable`'s 0.8 is derived, not chosen: a launcher may crop everything
// outside a centred circle of 80% diameter (radius 40 units here), and the
// motif's bounding box is 88x42, whose half-diagonal is 48.75 — 22% over. At
// 0.8 it is 39.0, inside 40. The motif's own centre is (50,53) rather than
// (50,50) because the floor hangs below the pulses' midpoint, so the
// transform lifts it 3 units as well.
//
// `bleed` exists because Safari composites a transparent apple-touch-icon
// against black or white and applies its own squircle, so supplying our own
// rounded corners risks a seam against an unknown backdrop.
const FRAMINGS = {
  rounded:  { rx: 22, scale: 1 },
  bleed:    { rx: 0,  scale: 1 },
  maskable: { rx: 0,  scale: 0.8 },
};

function markup(framingName) {
  const f = FRAMINGS[framingName];
  if (!f) throw new Error(`unknown framing: ${framingName}`);
  const motif = f.scale === 1
    ? `<path d="${MARK}" fill="url(#g)"/>`
    : `<g transform="translate(50,50) scale(${f.scale}) translate(-50,-53)"><path d="${MARK}" fill="url(#g)"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Web Audio Studio">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${GRADIENT[0]}"/>
      <stop offset="1" stop-color="${GRADIENT[1]}"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100"${f.rx ? ` rx="${f.rx}"` : ''} fill="${BG}"/>
  ${motif}
</svg>
`;
}

const OUTPUTS = [
  { file: 'icon.svg',                framing: 'rounded'  },
  { file: 'icon-maskable.svg',       framing: 'maskable' },
  { file: 'icon-192.png',            framing: 'rounded',  size: 192 },
  { file: 'icon-512.png',            framing: 'rounded',  size: 512 },
  { file: 'favicon-32.png',          framing: 'rounded',  size: 32  },
  { file: 'apple-touch-icon.png',    framing: 'bleed',    size: 180 },
  { file: 'icon-maskable-192.png',   framing: 'maskable', size: 192 },
  { file: 'icon-maskable-512.png',   framing: 'maskable', size: 512 },
];

// The SVG fills the viewport exactly, so a screenshot at NxN *is* the icon at
// NxN with no resampling.
function pageFor(framingName) {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>
${markup(framingName)}`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('No Chromium-family browser found. Set CHROME_PATH=/path/to/chrome.');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // The SVGs need no browser at all.
  for (const out of OUTPUTS.filter((o) => !o.size)) {
    fs.writeFileSync(path.join(OUT_DIR, out.file), markup(out.framing));
    console.log(`  ${out.file.padEnd(24)} ${out.framing}`);
  }

  const launched = await launchChrome(browser, { profilePrefix: 'icons-' });
  let cdp;
  try {
    cdp = await openPage(launched.httpBase);
    // Without this the page paints opaque white behind the SVG, and the
    // rounded framing's corners — which are supposed to be transparent —
    // come out white on every home screen that does not use a dark theme.
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

    for (const out of OUTPUTS.filter((o) => o.size)) {
      const n = out.size;
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: n, height: n, deviceScaleFactor: 1, mobile: false,
      });
      await cdp.send('Page.navigate', { url: pageFor(out.framing) });
      await new Promise((r) => setTimeout(r, 150)); // let the SVG paint
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: n, height: n, scale: 1 },
      });
      const abs = path.join(OUT_DIR, out.file);
      fs.writeFileSync(abs, Buffer.from(data, 'base64'));
      const kb = (fs.statSync(abs).size / 1024).toFixed(1);
      console.log(`  ${out.file.padEnd(24)} ${out.framing.padEnd(9)} ${n}x${n}  ${kb.padStart(5)} kB`);
    }
    console.log(`\nWrote ${OUTPUTS.length} files to icons/.`);
  } finally {
    if (cdp) cdp.close();
    await launched.cleanup();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
