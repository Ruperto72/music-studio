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
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findBrowser, requireFreePort, waitForHttp, launchChrome, openPage } = require('./cdp.js');
// The icon generator, imported for its mark rather than run: auditIcons()
// compares the committed SVGs against what icons.js actually draws, so the
// drawing is never retyped here. Requiring it is side-effect free — it only
// draws under `require.main === module`.
const ICONS_GENERATOR = require('./icons.js');

// `--only <substring>` runs just the steps whose name contains it, which is
// what makes a single step cheap enough to re-run while working on it — the
// whole suite is a twenty-minute round trip. Every step resets the app first
// (see fresh()), so one run alone means the same thing it means in the suite.
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg !== -1 ? (process.argv[onlyArg + 1] || '').toLowerCase() : '';
const SERVER_PORT = process.env.VERIFY_PORT || 8099;
const APP_URL = `http://127.0.0.1:${SERVER_PORT}`;

// A saved song stores a track's part as *clips* rather than a flat note list
// (see the Clips section in index.html): each clip is a window onto its own
// notes, whose starts are relative to the clip's content origin. Anything
// asserting on a saved song therefore has to flatten that the way the app's
// own trackNotes() does — read `song.tracks[id][0]` directly and you get a
// clip object where you meant a note, which does not throw, it just silently
// compares the wrong thing. That is exactly how ten steps in this suite failed
// at once with `{"start":0,"len":null}` in their message: not one of them had
// found a bug, they had all read a clip as a note.
//
// Takes both shapes on purpose. A v2 file (and any hand-written one) still
// holds a flat list, and `applySongData()` still loads it, so the audit below
// must keep accepting it too.
function savedNotesOf(song, id) {
  const part = ((song && song.tracks) || {})[id] || [];
  // Note the empty-array trap CLAUDE.md warns about: [].every() is true, so an
  // empty part would read as "already clips" and flatten to nothing rather
  // than to itself. Length first.
  if (!part.length || !part.every((c) => c && Array.isArray(c.notes))) return part;
  const out = [];
  // Notes carry timeline columns, so a window shows an item when the item's
  // own start falls inside it — no translation. See the Clips section in
  // index.html for why the `offset` this used to apply was removed.
  for (const c of part) {
    for (const n of c.notes) {
      if (n.start >= c.start && (c.len == null || n.start < c.start + c.len)) out.push(n);
    }
  }
  return out;
}
// The same function, installed on the page once per document so the browser-
// side assertions can call it too. One definition, two sides — the alternative
// was pasting the flattening into seventeen evaluate() strings.
const SAVED_NOTES_INSTALL = `window.__savedNotes = ${String(savedNotesOf)};`;

// ---------------------------------------------------------------------------
// Bundled-song audit. The first of two checks in this file that never open a
// browser: it reads songs/*.json and asks whether index.html would accept
// every field in them.
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
      const seq = savedNotesOf(song, id);
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

// ---------------------------------------------------------------------------
// Icon audit. The second check that never opens a browser. Three files
// declare icons — manifest.webmanifest, index.html's <link>s and sw.js's
// SHELL_URLS — and nothing ties them to what is on disk, which is how
// icons/favicon-32.png sat referenced by nothing at all for months and how
// the tab icon stayed a 🎵 emoji in an app that audits every other control
// for exactly that. Values are read out of the real files rather than
// retyped, and a read that finds nothing throws rather than passing
// vacuously.
// ---------------------------------------------------------------------------
// A file that exists on disk but is never referenced is exactly as broken as
// a reference that points at nothing — it's how favicon-32.png sat unused
// for months before this audit existed. `icon-maskable.svg` is the one
// deliberate exception: it's a readable source for the PNGs icons.js
// generates from it, not a runtime asset any of the three files above needs
// to name.
const ICON_ORPHAN_ALLOWLIST = ['icons/icon-maskable.svg'];

function auditIcons(repoRoot) {
  const problems = [];
  const checked = [];
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));
  const pngSize = (rel) => {
    const b = fs.readFileSync(path.join(repoRoot, rel));
    if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) throw new Error(`${rel} is not a PNG`);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  // The same codepoint ranges the interface-icon step uses on controls.
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

  // Referenced by the app (manifest + index.html) vs. actually precached by
  // sw.js are tracked separately from `checked` so they can be compared
  // against each other below — checking declared-icon-exists-on-disk alone
  // (the loop bodies pushing into `checked`) never notices an icon that one
  // of the three files forgot to mention at all.
  const referenced = [];
  const precached = [];

  const manifest = JSON.parse(read('manifest.webmanifest'));
  if (!manifest.icons || !manifest.icons.length) {
    throw new Error('manifest.webmanifest declares no icons — the audit would pass vacuously');
  }
  for (const ic of manifest.icons) {
    checked.push(ic.src);
    referenced.push(ic.src);
    if (!exists(ic.src)) { problems.push(`manifest icon missing on disk: ${ic.src}`); continue; }
    const [w, h] = pngSize(ic.src);
    if (`${w}x${h}` !== ic.sizes) {
      problems.push(`${ic.src} is ${w}x${h} but the manifest declares ${ic.sizes}`);
    }
  }

  const html = read('index.html');
  const links = [...html.matchAll(/<link\b[^>]*\brel="(?:shortcut )?(?:apple-touch-)?icon"[^>]*>/g)].map((m) => m[0]);
  if (!links.length) {
    throw new Error('index.html declares no icon links — the audit would pass vacuously');
  }
  for (const tag of links) {
    const href = (tag.match(/href="([^"]+)"/) || [])[1];
    if (!href) { problems.push(`icon link with no href: ${tag}`); continue; }
    if (href.startsWith('data:')) {
      // An inline SVG favicon is allowed; an emoji pasted into one is not.
      // The app removed emoji from its controls deliberately and audits them
      // above — the <head> was simply never in scope.
      const decoded = decodeURIComponent(href);
      const em = EMOJI.exec(decoded);
      if (em) {
        // Slice a window *around* the match — the codepoint that actually
        // trips this can sit well past character 70 (the 🎵 this audit was
        // written to catch is at roughly 100), so a flat slice(0, 70) names
        // an emoji in the message without showing one.
        const start = Math.max(0, em.index - 40);
        const window = decoded.slice(start, em.index + 40);
        problems.push(`icon link is an emoji data URL: ${start > 0 ? '…' : ''}${window}…`);
      }
      continue;
    }
    checked.push(href);
    referenced.push(href);
    if (!exists(href)) problems.push(`icon link points at a missing file: ${href}`);
  }

  if (exists('icons/apple-touch-icon.png')) {
    const [w, h] = pngSize('icons/apple-touch-icon.png');
    if (w !== 180 || h !== 180) problems.push(`apple-touch-icon.png is ${w}x${h}, expected 180x180`);
  }

  const swSrc = read('sw.js');
  const shell = swSrc.match(/const SHELL_URLS = \[([\s\S]*?)\];/);
  if (!shell) throw new Error('could not read SHELL_URLS out of sw.js — the audit would pass vacuously');
  for (const m of shell[1].matchAll(/'\.\/([^']+)'/g)) {
    if (!/^icons\//.test(m[1])) continue;
    checked.push(m[1]);
    precached.push(m[1]);
    if (!exists(m[1])) problems.push(`sw.js precaches a missing file: ${m[1]}`);
  }

  // Referenced → precached: an icon the manifest or index.html points at but
  // sw.js never lists leaves an installed PWA with no offline copy of it —
  // gutting SHELL_URLS entirely used to still pass, since nothing compared
  // it against what the app actually needs.
  for (const href of referenced) {
    if (!precached.includes(href)) {
      problems.push(`${href} is referenced by manifest.webmanifest/index.html but sw.js's SHELL_URLS never precaches it`);
    }
  }

  // Exists → declared: a file nobody points at is the mirror image of a
  // dangling reference, and it's the exact shape of bug this audit exists
  // for (favicon-32.png sat orphaned this way for months). Checked against
  // `referenced` rather than `checked` — sw.js is meant to *mirror* the
  // manifest/index.html references (that's what the check above verifies),
  // not stand in as its own source of "this icon is used"; a file that
  // dropped out of index.html but still happens to linger in SHELL_URLS is
  // exactly as orphaned as one absent from all three.
  const onDisk = fs.readdirSync(path.join(repoRoot, 'icons')).map((f) => `icons/${f}`);
  for (const f of onDisk) {
    if (ICON_ORPHAN_ALLOWLIST.includes(f)) continue;
    if (!referenced.includes(f)) problems.push(`${f} exists in icons/ but nothing declares it`);
  }

  // Everything above asks whether the *declarations* and the *files* agree.
  // None of it looks at the drawing, so an icons/ full of plausible-looking
  // files that no longer come from the mark passes: rewriting icon.svg by
  // hand to a completely different shape used to be green. icons.js is the
  // single source of the path, the gradient and the three framings, so ask
  // it directly rather than retyping any of that here — the same rule
  // auditBundledSongs follows when it reads its constants out of index.html.
  //
  // Line endings are normalised because the repo has core.autocrlf on and no
  // .gitattributes: a fresh Windows clone gets CRLF in these files while the
  // generator writes LF, and that difference is not the mark drifting.
  const norm = (s) => s.replace(/\r\n/g, '\n');
  for (const out of ICONS_GENERATOR.OUTPUTS) {
    const rel = `icons/${out.file}`;
    if (!exists(rel)) {
      problems.push(`${rel} is missing — icons.js declares it, so run \`node icons.js\``);
      continue;
    }
    if (out.size) {
      // A PNG's *drawing* can only be compared by re-rendering it, which needs
      // a browser this audit deliberately doesn't open. Its dimensions can be
      // read straight out of the header, though, and that is the half that
      // catches a size changed in OUTPUTS without re-running the generator —
      // which used to pass silently: the manifest check below compares the
      // file against the *manifest*, so a declaration only icons.js knows
      // about had nothing checking it at all.
      const [w, h] = pngSize(rel);
      if (w !== out.size || h !== out.size) {
        problems.push(`${rel} is ${w}x${h} but icons.js declares ${out.size} — re-run \`node icons.js\``);
      }
      continue;
    }
    if (norm(read(rel)) !== norm(ICONS_GENERATOR.markup(out.framing))) {
      problems.push(`${rel} is not what icons.js draws for the '${out.framing}' framing — re-run \`node icons.js\``);
    }
  }

  return { checked, problems };
}

async function main() {
  const errors = [];
  const steps = [];
  function step(name, fn) {
    steps.push(async () => {
      if (ONLY && !name.toLowerCase().includes(ONLY)) return;
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
  await requireFreePort(SERVER_PORT, 'VERIFY_PORT');
  const server = spawn(process.execPath, [path.join(repoRoot, 'dev-server.js')], {
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: 'ignore',
  });
  // The `finally` below only runs when this process gets to finish. Killed
  // from outside — a harness timeout, Ctrl-C — it does not, and the dev-server
  // outlives it holding the port. The next run then tests *that* tree instead
  // of its own; requireFreePort() above turns the aftermath into an error, but
  // not leaving it behind is the actual fix.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { server.kill(); process.exit(130); });
  }
  await waitForHttp(APP_URL, 10000).catch((e) => { server.kill(); throw e; });

  let launched, cdp;
  try {
    launched = await launchChrome(browserPath, {
      profilePrefix: 'music-studio-verify-',
      // Without this an AudioContext stays suspended — a synthetic click
      // through the DevTools Protocol is not a trusted user gesture, so
      // resume() never takes and ctx.currentTime sits at 0 forever. Anything
      // that measures *when* something happened (the recording step) would then
      // see every event at time zero.
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    cdp = await openPage(launched.httpBase);
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') errors.push('[console] ' + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      errors.push('[pageerror] ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    });
    cdp.on('Page.javascriptDialogOpening', () => { cdp.send('Page.handleJavaScriptDialog', { accept: true }); });
    await cdp.send('Page.setBypassCSP', { enabled: true });
    // Survives every goto()/fresh(), so a step never has to remember to
    // install it — see SAVED_NOTES_INSTALL for why the assertions need it.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SAVED_NOTES_INSTALL });

    async function goto(url) {
      const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
      await cdp.send('Page.navigate', { url });
      await loaded;
    }
    // Every browser step starts from here. The suite used to let steps inherit
    // whatever the previous one left: only 16 of 67 reset themselves and the
    // other 51 quietly relied on their neighbours. That coupling is not a
    // tidiness problem, it decided *results* — the same broken hitsConflict was
    // caught or missed by the same three steps depending only on what else was
    // injected in that run, which means an audit run against a coupled suite
    // reports things that are not true.
    async function fresh() {
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length >= 5`);
    }
    // A fresh page with one note placed and selected — the precondition five
    // steps were getting from whichever step ran in front of them. The note
    // inspector only exists while something is selected, so a step that reads
    // it has to put it there itself.
    async function withSelectedNote() {
      await fresh();
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`{
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 60, clientY: rect.top + 40 }));
      }`);
      await waitFor(`!!document.querySelector('.track.active .lane .note')`);
      await waitFor(`!!document.querySelector('.inspector .fx-toggle')`);
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
    // Read the kind off the row rather than inferring it from which controls
    // the header happens to carry. The old form — "the track with no waveform
    // trigger" — silently stopped matching anything when the kit picker moved
    // onto that same trigger, and five steps timed out at once.
    const RHYTHM_LANE = `document.querySelector('.track[data-kind="rhythm"] .lane')`;

    // First, and not the last step that needs no browser: a song file the app
    // would silently mangle is worth hearing about before thirteen minutes of
    // rendering, and a bad example ships to everyone who opens the Songs menu.
    step('Bundled songs: every field is one the app will actually load', async () => {
      const { files, problems } = auditBundledSongs(repoRoot);
      if (files.length < 5) throw new Error(`only found ${files.length} example songs — expected the bundled set`);
      if (problems.length) {
        throw new Error(`${problems.length} problem(s):\n        ` + problems.join('\n        '));
      }
    });

    // Second, and the last check that needs no browser: a missing or
    // mis-sized icon should be reported in a second rather than after a
    // browser has started.
    step('Icons: every declared icon exists, is the size it claims, and no emoji is left in the head', async () => {
      const { checked, problems } = auditIcons(repoRoot);
      if (checked.length < 14) throw new Error(`only found ${checked.length} icon references — expected the declared set`);
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
      await fresh();
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
      await fresh();
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
      await fresh();
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
    // chip, and returns once its section is showing in the inspector column's
    // track strip (adding points the strip at it).
    async function addFxEffect(label) {
      const already = await cdp.evaluate(`!![...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body')].find(b => b.getAttribute('aria-label').split(', ').slice(1).join(', ') === ${JSON.stringify(label)})`);
      if (already) return;
      await cdp.evaluate(`(${fxPanelSel}).querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
      await waitFor(`!!document.querySelector('.th-strip-section[data-key]')`);
    }
    // Steps a knob (identified by its label, e.g. 'Lo') by dispatching N
    // keydowns rather than replaying pointer-drag pixel math — deterministic,
    // and it exercises the knob's keyboard support as a side effect.
    async function stepKnob(sectionKey, fieldLabel, key, times) {
      const dialSel = `[...document.querySelector('.th-strip-section[data-key="${sectionKey}"]').querySelectorAll('.th-knob')]` +
        `.find(k => k.querySelector('.th-knob-label').textContent === ${JSON.stringify(fieldLabel)}).querySelector('.th-knob-dial')`;
      await cdp.evaluate(`(() => {
        const dial = ${dialSel};
        dial.focus();
        for (let i = 0; i < ${times}; i++) dial.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
      })()`);
    }
    async function knobText(sectionKey, fieldLabel) {
      return cdp.evaluate(`[...document.querySelector('.th-strip-section[data-key="${sectionKey}"]').querySelectorAll('.th-knob')]` +
        `.find(k => k.querySelector('.th-knob-label').textContent === ${JSON.stringify(fieldLabel)}).querySelector('.th-knob-val').textContent`);
    }

    step('FX panel: adding Delay opens its popover with a working knob', async () => {
      await fresh();
      await addFxEffect('Delay');
      // 0 -> 0.5 at a 0.02 step is exactly 25 presses.
      await stepKnob('sendDelay', 'Delay', 'ArrowUp', 25);
      const text = await knobText('sendDelay', 'Delay');
      if (text !== '50%') throw new Error(`expected Delay to show 50%, got ${text}`);
      // The readout alone is the knob talking to itself: it is painted from
      // the dial's own value, so a knob that repaints and never calls onInput
      // reads 50% while nothing downstream has moved. Ask the song instead.
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return false;
        const fx = (JSON.parse(localStorage.getItem(k)).fxSend || {});
        return Object.values(fx).some((s) => s && s.delay === 0.5);
      })()`);
    });

    step('FX panel: EQ chip renders before Comp regardless of add order, and survives a reload', async () => {
      await fresh();
      // Comp added first, EQ second — if the chip row still shows EQ before
      // Comp, the order is registry-driven (the real audio chain), not
      // insertion order.
      await addFxEffect('Comp');
      await addFxEffect('EQ');
      const chipLabels = await cdp.evaluate(
        `[...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body')].map(b => b.getAttribute('aria-label').split(', ').slice(1).join(', '))`);
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

    step('FX panel: bypass dims the chip and its strip section but keeps showing the dialled value, and Reset clears every chip', async () => {
      await fresh();
      // Adds what it bypasses and dials it, instead of finding both left over
      // from the step before. Without a dialled value, "bypass does not hide
      // the real value" is being asserted about a default.
      await addFxEffect('EQ');
      await addFxEffect('Comp');
      await stepKnob('eq', 'Lo', 'ArrowUp', 12); // 0 -> 6.0dB at a 0.5 step
      await waitFor(`[...document.querySelector('.th-strip-section[data-key="eq"]').querySelectorAll('.th-knob')]
        .find(k => k.querySelector('.th-knob-label').textContent === 'Lo').querySelector('.th-knob-val').textContent === '6.0dB'`);
      // Bypass moved off the chip and onto the strip section head, so each
      // control exists once rather than on both surfaces.
      await cdp.evaluate(`document.querySelector('.th-strip-section[data-key="eq"] .th-fx-chip-bypass').click()`);
      const bypassedState = await cdp.evaluate(`(() => {
        const chip = [...(${fxPanelSel}).querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body').getAttribute('aria-label').split(', ').slice(1).join(', ') === 'EQ');
        const sec = document.querySelector('.th-strip-section[data-key="eq"]');
        return { chipDimmed: chip.classList.contains('bypassed'), secDimmed: sec.classList.contains('bypassed') };
      })()`);
      if (!bypassedState.chipDimmed || !bypassedState.secDimmed) {
        throw new Error(`bypass should dim both the chip and its strip section: ${JSON.stringify(bypassedState)}`);
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
      await fresh();
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
      await fresh();
      const before = errors.length;
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 1200));
      await cdp.evaluate(`document.querySelector('#play').click()`);
      await new Promise((r) => setTimeout(r, 100));
      if (errors.length > before) throw new Error('errors occurred during playback');
    });

    step('adds a track via the menu and undoes it', async () => {
      await fresh();
      // This step used to stop after adding — it never undid anything, so the
      // half its own name promised was untested. Found by counting assertions
      // per step rather than by reading: it had none at all.
      const ids = () => cdp.evaluate(`[...document.querySelectorAll('.track')].map(t => t.dataset.track)`);
      const before = await ids();
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Add track')).click()`);
      await waitFor(`document.querySelectorAll('.track').length === ${before.length} + 1`);
      const added = (await ids()).find((id) => !before.includes(id));
      if (!added) throw new Error('the new track has no id of its own');

      // Wait for the history to actually hold something: commitHistory() is
      // debounced, and on a fresh page the stack starts empty. Before this
      // step reset itself, the stack was full of whatever earlier steps had
      // done — so its undo may well have been undoing one of those instead.
      await waitFor(`!document.querySelector('#undo-btn').disabled`, 4000)
        .catch(() => { throw new Error('adding a track should put something on the undo stack'); });
      await cdp.evaluate(`document.querySelector('#undo-btn').click()`);
      await waitFor(`document.querySelectorAll('.track').length === ${before.length}`, 4000)
        .catch(() => { throw new Error('undo did not remove the added track'); });
      // The count coming back is not enough — undo has to restore the same
      // tracks, not merely the same number of them.
      const after = await ids();
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(`undo should restore the same track list: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      }
      if (after.includes(added)) throw new Error('the undone track is still there');
      // Undo rolls the *song* back, not just the track list, so this step now
      // hands the next one a different starting state than it used to — which
      // is exactly what broke the two steps after it on the first run. Reload
      // so what follows starts from a defined state rather than from whatever
      // this step happened to leave.
      await goto(APP_URL);
    });

    step('Pen: clicking a different pitch at the same time in a tonal track adds a chord tone, not a replacement', async () => {
      await fresh();
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
      await withSelectedNote();
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
      await withSelectedNote();
      await waitFor(`!!Array.from(document.querySelectorAll('.insp-cap')).find(c => c.textContent === 'Chord')`);
      await openPalette('chord');
      await cdp.evaluate(`
        document.querySelector('.preset-grid button[data-chord="maj"]').click();
      `);
      // Root plus two chord tones. This read `=== 4` while the lane also held
      // a note from an earlier step: the count was calibrated to inherited
      // state rather than to what the button does.
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 3`);
      const multiCount = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note.multi-selected').length`);
      if (multiCount !== 3) throw new Error(`expected 3 notes multi-selected as the chord group, got ${multiCount}`);
      // No single note is selected any more, so the column falls back to the
      // active track's FX strip (or the empty placeholder on a narrow layout).
      // Either way the *note* panel must be gone — that is what this asserts,
      // rather than the specific thing that replaced it.
      const noteePanelGone = await cdp.evaluate(`!document.querySelector('.inspector .insp-panel .fx-toggle')`);
      if (!noteePanelGone) throw new Error('expected the single-note inspector to close after the chord is selected as a group');
    });

    step('Chord buttons: re-running on the same root adds nothing (no stacked duplicates)', async () => {
      await withSelectedNote();
      // The palettes are collapsed by default and render no buttons while
      // closed, so a step that clicks one has to open it — and build the chord
      // it is about to ask for again, rather than inheriting one.
      await openPalette('chord');
      await cdp.evaluate(`document.querySelector('.preset-grid button[data-chord="maj"]').click()`);
      await waitFor(`document.querySelectorAll('.track.active .lane .note.multi-selected').length === 3`);
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
      await fresh();
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
      await withSelectedNote();
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
      await fresh();
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
      await fresh();
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
      await fresh();
      // The rhythm counterpart of the same-pitch rule for notes: only a hit of
      // the same *type* in a column is a duplicate. Filtering on start alone
      // wiped the whole column, making kick+hi-hat on one beat unplaceable.
      // Assert *what is in the column*, not how many hits the lane has. The
      // count-only version could come out right for the wrong reason: against a
      // build where hitsConflict ignores the drum type — the exact bug this
      // step exists to catch — it passed inside the suite, while running the
      // same sequence from a clean page failed as it should. Which of those
      // you get depends on the state the previous steps happened to leave, and
      // a reload here is not the answer either: it strips the state the steps
      // *after* this one inherit, and two of them then failed instead.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      const rhythmLane = `document.querySelector('.track[data-kind="rhythm"] .lane')`;
      const hasLane = await cdp.evaluate(`!!${rhythmLane}`);
      if (!hasLane) throw new Error('expected a rhythm track lane');
      await cdp.evaluate(`${rhythmLane}.click()`); // make the rhythm track active
      await new Promise((r) => setTimeout(r, 150));
      const clickRow = (yOffset) => cdp.evaluate(`{
        const lane = ${rhythmLane};
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 200, clientY: rect.top + ${yOffset} }));
      }`);
      // Name the hits rather than count them: "two hits exist" is satisfied by
      // the wrong two, which is how a count-only assertion can pass against a
      // build that wipes the column.
      const hitNames = `[...document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit')].map(h => (h.getAttribute('aria-label') || '?').split(',')[0]).sort().join('+')`;
      const countHits = `document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length`;
      // Every hit names its own drum, bar and beat ("Kick, bar 2 beat 1"), so
      // group by the position part rather than by pixels — a hit block's rect
      // is not a reliable way to ask "which column is this in".
      const labels = `[...${rhythmLane}.querySelectorAll('.hit')].map(h => h.getAttribute('aria-label') || '?')`;
      const drumsAt = (all, where) => all
        .filter((l) => l.split(',').slice(1).join(',').trim() === where)
        .map((l) => l.split(',')[0].trim()).sort().join('+');
      const start = await cdp.evaluate(countHits);
      const before = await cdp.evaluate(labels);
      await clickRow(8);   // row 0 — kick
      await new Promise((r) => setTimeout(r, 200));
      const afterFirst = await cdp.evaluate(countHits);
      if (afterFirst !== start + 1) throw new Error(`expected one hit to be added, got ${start} -> ${afterFirst}`);
      const afterKick = await cdp.evaluate(labels);
      const kick = afterKick.find((l) => /^Kick/.test(l) && !before.includes(l));
      if (!kick) throw new Error(`the click should have added a kick, lane holds ${JSON.stringify(afterKick)}`);
      const where = kick.split(',').slice(1).join(',').trim();
      await clickRow(25);  // row 1 — snare, same column
      await new Promise((r) => setTimeout(r, 200));
      const both = drumsAt(await cdp.evaluate(labels), where);
      if (!/Kick/.test(both) || !/Snare/.test(both)) {
        throw new Error(`${where} must hold both the kick and the snare, holds ${JSON.stringify(both)}`);
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
        const hits = Array.from(document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit'));
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
      await fresh();
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
      await fresh();
      // state.multiSelected is scoped to the active track, but addTrack() set
      // state.activeTrack directly and setActive() then early-returned, so the
      // old track's group stayed selected — and the next nudge copied those
      // items into the new track.
      // Makes its own multi-selection. It used to rely on the hits pasted by
      // the step before still being selected, so what it tested depended on
      // which step ran in front of it.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect();
        for (let i = 0; i < 3; i++) {
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 40 + i * 60, clientY: r.top + 40 }));
        }
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="pitch"] .lane .note').length === 3`);
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        [...lane.querySelectorAll('.note')].forEach((n, i) => {
          n.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: i > 0 }));
        });
      })()`);
      const selected = `document.querySelectorAll('.hit.multi-selected, .note.multi-selected').length`;
      await waitFor(`${selected} > 0`, 3000)
        .catch(() => { throw new Error('this step needs a multi-selection of its own to work with'); });
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
      await fresh();
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
      await withSelectedNote();
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
      const tonal = await cdp.evaluate(`(${panelSel}).closest('.track').dataset.kind === 'pitch'`);
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
          labels: chips.map(c => c.querySelector('.th-fx-chip-body').getAttribute('aria-label').split(', ').slice(1).join(', ')),
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
      await fresh();
      // A populated grid, since half of this is about how notes are named. It
      // used to inherit whichever song an earlier step had loaded.
      await loadExample('Froggy Hop');
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

      // Stateful controls have to say what state they are in, or a screen
      // reader user cannot tell which tool is active or which track is muted.
      // This was documented and unverified: removing aria-checked from a tool
      // button left every assertion in this step green.
      const stateful = await cdp.evaluate(`(() => {
        const tools = [...document.querySelectorAll('.tool-group [role="radio"]')];
        const toggles = [...document.querySelectorAll('.track-header [aria-pressed]')];
        return {
          tools: tools.length,
          toolsStated: tools.filter(b => b.getAttribute('aria-checked') !== null).length,
          checked: tools.filter(b => b.getAttribute('aria-checked') === 'true').length,
          group: !!document.querySelector('.tool-group[role="radiogroup"]'),
          toggles: toggles.length,
        };
      })()`);
      if (!stateful.group) throw new Error('the tool buttons should form a radiogroup');
      if (stateful.tools < 3) throw new Error(`expected the three editing tools, got ${stateful.tools}`);
      if (stateful.toolsStated !== stateful.tools) {
        throw new Error(`every tool must report aria-checked, ${stateful.tools - stateful.toolsStated} do not`);
      }
      if (stateful.checked !== 1) {
        throw new Error(`exactly one tool should read aria-checked="true", got ${stateful.checked}`);
      }
      if (stateful.toggles < 2) {
        throw new Error(`Mute/Solo should report aria-pressed, found ${stateful.toggles} such controls`);
      }
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
        const head = document.querySelector('.track[data-kind="pitch"] .track-header');
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
        const head = document.querySelector('.track[data-kind="pitch"] .track-header');
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
      await fresh();
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
      const tonalLane = `document.querySelector('.track[data-kind="pitch"] .lane')`;
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
        return window.__savedNotes(d, id)[0] || null;
      })()`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find((t) => t.kind !== 'rhythm').id;
        const n = window.__savedNotes(d, id)[0];
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
      const rhythmLane = RHYTHM_LANE;
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
        const h = window.__savedNotes(d, id)[0];
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
        return window.__savedNotes(d, id).map((n) => ({ start: n.start, len: n.len, freq: n.freq }));
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
      // Three, including one played a hair before the transport's zero — which
      // recording used to round up to beat one and, once it stopped snapping,
      // silently dropped instead.
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

      // Metronome is a remembered-per-browser preference (see above), which
      // means turning it on here outlives this step: fresh() reloads the same
      // page, not a new profile, so every later step's playback would click
      // too. Restore it before finishing rather than leaving that for whoever
      // hits it — it surfaced as a later step measuring nonzero output where
      // it expected silence, with nothing about *that* step's own code wrong.
      await cdp.evaluate(`document.getElementById('metronome-btn').click()`);
      if (await cdp.evaluate(`localStorage.getItem('music-studio-metronome')`) !== '0') {
        throw new Error('the metronome should turn back off, not just visually toggle');
      }
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
        return window.__savedNotes(d, id).map((n) => ({ start: n.start, len: n.len, freq: n.freq, type: n.type }))
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
      await fresh();
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
      await fresh();
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
      await fresh();
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
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
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
      await fresh();
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
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect();
        // All eight, inside this lane's own height, counted from a fresh
        // query. It used to place seven and rely on the eighth being left
        // over; +60 landed in the *next* track's lane, which the old
        // whole-document count happily included; and render() rebuilds the
        // lane, so the reference captured above is detached by the end.
        const y = r.top + Math.min(40, r.height / 2);
        for (let i = 0; i < 8; i++) {
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 40 + i * 60, clientY: y }));
        }
        return document.querySelector('.track[data-kind="pitch"] .lane').querySelectorAll('.note').length;
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
      await fresh();
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
        const head = document.querySelector('.track[data-kind="pitch"] .track-header');
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
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
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
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
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
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
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
        const head = document.querySelector('.track[data-kind="pitch"] .track-header');
        head.querySelector('.th-osc-trigger').click();
      })()`);
      await waitFor(`!!document.querySelector('.th-osc-menu')`);
      await cdp.evaluate(`document.querySelector('.th-osc-menu button[data-value="sine"]').click()`);
      await new Promise((r) => setTimeout(r, 400));
      const afterSine = await cdp.evaluate(`document.querySelectorAll('.adsr-select').length`);
      if (afterSine !== 0) throw new Error('Duty should only show on a square track');
    });

    step('Per-track vibrato reaches the note oscillator, and only on tonal tracks', async () => {
      await fresh();
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
      const rhythmHead = `document.querySelector('.track[data-kind="rhythm"] .track-header')`;
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
      await waitFor(`!!document.querySelector('.th-strip-section[data-key="vibrato"]')`);

      // Set a depth, place a note, and confirm an LFO reaches its frequency.
      // 50 cents on a 523.25Hz note => 523.25 * (2^(50/1200) - 1) ~= 15.3Hz.
      // 0 -> 50 at a 1-cent step is 50 presses.
      await cdp.evaluate(`(() => {
        const dial = [...document.querySelector('.th-strip-section[data-key="vibrato"]').querySelectorAll('.th-knob')]
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
        if (document.querySelector('.th-strip-section[data-key="vibrato"]')) return;
        [...head.querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body').getAttribute('aria-label').split(', ').slice(1).join(', ') === 'Vibrato')
          .querySelector('.th-fx-chip-body').click();
      })()`);
      await waitFor(`!!document.querySelector('.th-strip-section[data-key="vibrato"]')`);

      // At depth 0 nothing must be connected — an untouched track is unchanged.
      await cdp.evaluate(`(() => {
        const dial = [...document.querySelector('.th-strip-section[data-key="vibrato"]').querySelectorAll('.th-knob')]
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
      await fresh();
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
      const tonalLane = `document.querySelector('.track[data-kind="pitch"] .lane')`;
      await cdp.evaluate(`(() => {
        const lane = ${tonalLane};
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 200, clientY: r.top + 60 }));
      })()`);
      await waitFor(`!!document.querySelector('.lane .note')`);

      const headSel = `document.querySelector('.track[data-kind="pitch"] .track-header')`;
      await cdp.evaluate(`(${headSel}).querySelector('.th-fx-panel').querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === 'EQ').click()`);
      await waitFor(`!!document.querySelector('.th-strip-section[data-key="eq"]')`);
      // 0 -> 6 at a 0.5 step is 12 presses.
      await cdp.evaluate(`(() => {
        const dial = [...document.querySelector('.th-strip-section[data-key="eq"]').querySelectorAll('.th-knob')]
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

      await cdp.evaluate(`document.querySelector('.th-strip-section[data-key="eq"]').querySelector('.th-fx-chip-bypass').click()`);
      await waitFor(`window.__biquads[${idx}].gain.value === 0`);
      const knobStillSix = await cdp.evaluate(`[...document.querySelector('.th-strip-section[data-key="eq"]').querySelectorAll('.th-knob')]
        .find(k => k.querySelector('.th-knob-label').textContent === 'Lo').querySelector('.th-knob-val').textContent`);
      if (knobStillSix !== '6.0dB') throw new Error(`bypass must not change what the knob displays, Lo now reads ${knobStillSix}`);

      await cdp.evaluate(`document.querySelector('.th-strip-section[data-key="eq"]').querySelector('.th-fx-chip-bypass').click()`);
      await waitFor(`window.__biquads[${idx}].gain.value === 6`);
    });

    // A shared helper for the two steps below: opens the automation lane on
    // the first track, picks `param`, and clicks one point near the top.
    async function drawAutomationPoint(param) {
      await cdp.evaluate(`Array.from(document.querySelectorAll('.track')[0].querySelectorAll('button')).find(b => b.textContent.includes('Auto')).click()`);
      await waitFor(`!!document.querySelector('.automation-lane-el')`);
      await cdp.evaluate(`(() => {
        const sel = document.querySelector('.automation-header select');
        sel.value = ${JSON.stringify(param)};
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(`document.querySelector('.automation-header select').value === ${JSON.stringify(param)}`);
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.automation-lane-el');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 1, clientY: rect.top + 6 }));
      })()`);
      await waitFor(`!!document.querySelector('.automation-point')`);
      await cdp.evaluate(`[...document.querySelectorAll('.automation-header button')].find(b => b.title === 'Close automation lane').click()`);
    }

    step('FX panel: an automated send shows its chip even with the knob at zero', async () => {
      // The asymmetry this was written for: the Automation dropdown offers
      // Delay/Chorus/Reverb regardless of which chips exist, so a curve could
      // be audibly moving a send while the panel showed nothing at all —
      // isEffectDefault() is true when the level is still 0.
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length === 5`);
      const chipKeys = `[...document.querySelectorAll('.track')[0].querySelectorAll('.th-fx-chip')].map(c => c.dataset.key)`;
      const fresh = await cdp.evaluate(chipKeys);
      if (fresh.length) throw new Error(`a starter track should begin with no chips, got ${JSON.stringify(fresh)}`);

      await drawAutomationPoint('reverb');
      const after = await cdp.evaluate(chipKeys);
      if (!after.includes('sendReverb')) {
        throw new Error(`drawing a Reverb curve should reveal its chip, chips are ${JSON.stringify(after)}`);
      }
      // And the strip section it points at exists, so the curve is reachable.
      const inStrip = await cdp.evaluate(`!!document.querySelector('.th-strip-section[data-key="sendReverb"]')`);
      if (!inStrip) throw new Error('the revealed effect should also have a section in the track strip');
    });

    step('FX panel: removing an effect removes its automation curve too', async () => {
      // Removal is not bypass, and scheduleAutomationForChunk() only gates on
      // isFxBypassed() — so a curve left behind by a removed chip keeps
      // playing with nothing on screen that explains it.
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length === 5`);
      await addFxEffect('Delay');
      await drawAutomationPoint('delay');
      await new Promise((r) => setTimeout(r, 700)); // autosave debounce
      const draft = () => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k) || '{}');
        const id = (d.trackList || [])[0] && d.trackList[0].id;
        return { delay: ((d.fxSend || {})[id] || {}).delay, curve: (((d.automation || {})[id]) || {}).delay };
      })()`);
      const withCurve = await draft();
      if (!withCurve.curve || !withCurve.curve.length) {
        throw new Error(`the Delay curve should be in the saved song before removal, got ${JSON.stringify(withCurve)}`);
      }

      await cdp.evaluate(`document.querySelector('.th-strip-section[data-key="sendDelay"] .th-fx-chip-remove').click()`);
      await new Promise((r) => setTimeout(r, 700));
      const gone = await draft();
      if (gone.curve) {
        throw new Error(`removing the Delay chip should take its curve with it, still saved: ${JSON.stringify(gone)}`);
      }
      const chipsLeft = await cdp.evaluate(`[...document.querySelectorAll('.track')[0].querySelectorAll('.th-fx-chip')].map(c => c.dataset.key)`);
      if (chipsLeft.includes('sendDelay')) {
        throw new Error(`the chip should be gone too, chips are ${JSON.stringify(chipsLeft)}`);
      }
    });

    step('Track header: no two chips draw the same glyph', async () => {
      // Icon-only chips make a shared glyph a real defect: the three sends
      // used to draw one 'send' arrow between them, so D/E/F were three
      // identical pills distinguished only by their letter. Compares the
      // actual path geometry rather than a name, so pointing two registry
      // entries at different keys holding the same art still fails.
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length === 5`);
      for (const label of ['EQ', 'Comp', 'Bitcrush', 'Delay', 'Chorus', 'Reverb', 'Vibrato']) await addFxEffect(label);
      const dupes = await cdp.evaluate(`(() => {
        const chips = [...document.querySelectorAll('.track')[0].querySelectorAll('.th-fx-chip')];
        const seen = new Map();
        const out = [];
        for (const c of chips) {
          const d = [...c.querySelectorAll('svg.glyph path')].map(p => p.getAttribute('d')).join('|');
          if (!d) { out.push([c.dataset.key, 'no glyph at all']); continue; }
          if (seen.has(d)) out.push([c.dataset.key, 'same glyph as ' + seen.get(d)]);
          else seen.set(d, c.dataset.key);
        }
        return { dupes: out, n: chips.length };
      })()`);
      if (dupes.n !== 7) throw new Error(`expected seven chips, got ${dupes.n}`);
      if (dupes.dupes.length) throw new Error(`every chip needs its own glyph: ${JSON.stringify(dupes.dupes)}`);

      // Master's five groups are icon+label rather than icon-only, but two
      // identical icons there were just as unhelpful (Comp and Par Comp).
      await cdp.evaluate(`document.querySelector('#master-fx-toggle').click()`);
      await waitFor(`document.querySelectorAll('.th-master-fx-chip').length > 0`);
      const masterDupes = await cdp.evaluate(`(() => {
        const seen = new Map(); const out = [];
        for (const c of document.querySelectorAll('.th-master-fx-chip')) {
          const d = [...c.querySelectorAll('svg.glyph path')].map(p => p.getAttribute('d')).join('|');
          if (seen.has(d)) out.push([c.dataset.key, 'same glyph as ' + seen.get(d)]); else seen.set(d, c.dataset.key);
        }
        return out;
      })()`);
      if (masterDupes.length) throw new Error(`master chips need their own glyphs too: ${JSON.stringify(masterDupes)}`);
    });

    step('Track header: the chip row stays compact with every effect in use', async () => {
      // The whole point of moving editing into the strip: a chip is a letter
      // and an icon, so seven of them wrap onto two short lines instead of
      // six long ones (152px of every track header before this).
      await goto(APP_URL);
      await waitFor(`document.querySelectorAll('.track').length === 5`);
      for (const label of ['EQ', 'Comp', 'Bitcrush', 'Delay', 'Chorus', 'Reverb', 'Vibrato']) await addFxEffect(label);
      const row = await cdp.evaluate(`(() => {
        const r = document.querySelectorAll('.track')[0].querySelector('.th-fx-chip-row');
        const chips = [...r.querySelectorAll('.th-fx-chip')];
        return { h: Math.round(r.getBoundingClientRect().height), n: chips.length,
                 widest: Math.round(Math.max(...chips.map(c => c.getBoundingClientRect().width))) };
      })()`);
      if (row.n !== 7) throw new Error(`expected seven chips, got ${row.n}`);
      if (row.h > 70) throw new Error(`seven chips should fit in ~two lines, the row is ${row.h}px tall`);
      if (row.widest > 60) throw new Error(`a chip should be a letter and an icon, the widest is ${row.widest}px`);
    });

    step('FX panel: a bypassed send is not re-armed by its own automation curve', async () => {
      await fresh();
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
        if (!document.querySelector('.th-strip-section[data-key="sendDelay"]')) {
          [...panel.querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body').getAttribute('aria-label').split(', ').slice(1).join(', ') === 'Delay')
            .querySelector('.th-fx-chip-body').click();
        }
      })()`);
      await waitFor(`!!document.querySelector('.th-strip-section[data-key="sendDelay"]')`);
      await cdp.evaluate(`document.querySelector('.th-strip-section[data-key="sendDelay"]').querySelector('.th-fx-chip-bypass').click()`);
      await waitFor(`document.querySelector('.th-strip-section[data-key="sendDelay"]').querySelector('.th-fx-chip-bypass').getAttribute('aria-pressed') === 'true'`);

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
        const head = document.querySelector('.track[data-kind="pitch"] .track-header');
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

    // Selectors and gestures the five master steps below all share. Spelled
    // out once: the strip container class and the 'master' data-track
    // sentinel are the contract these steps test, so they should move in one
    // place if they ever change.
    const masterSec = (key) => `document.querySelector('.inspector .th-strip-section[data-track="master"]${key ? `[data-key="${key}"]` : ''}')`;
    const clickMasterCell = () => cdp.evaluate(`document.querySelector('.mstrip-master-cell').click()`);
    const isMasterSelected = () => cdp.evaluate(`document.querySelector('#master-track').classList.contains('master-selected')`);
    // :not(.automation-header) — an open Automation/Envelope row builds its
    // own .track-header, and those carry no setActive listener.
    const selectFirstTrack = () => cdp.evaluate(`document.querySelector('.track-header:not(.automation-header)').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);

    step('Master FX: five fixed chips render, all dimmed at default', async () => {
      await fresh();
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

    step('Master FX: a chip click hands the inspector to the master bus', async () => {
      await fresh();
      await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="eq"] .th-fx-chip-body').click()`);
      await waitFor(`!!${masterSec('eq')}`);
      // The whole point of the change: master's knobs live in the same column
      // as a track's, so all five groups are on screen at once rather than one
      // popover at a time.
      const sections = await cdp.evaluate(`[...document.querySelectorAll('.inspector .th-strip-section[data-track="master"]')]
        .map(s => s.querySelector('.th-strip-title').textContent)`);
      if (sections.join('|') !== 'EQ|Comp|Par Comp|Sidechain|Downsample') {
        throw new Error(`expected all five master groups in the inspector, got ${JSON.stringify(sections)}`);
      }
      if (await cdp.evaluate(`document.querySelector('.inspector .th-strip-name').textContent !== 'Master'`)) {
        throw new Error('the inspector strip head should name the master bus');
      }
      // Retired with this change — there must not be a second surface for the
      // same knob (the rule track FX already follow).
      if (await cdp.evaluate(`!!document.querySelector('.th-master-fx-popover')`)) {
        throw new Error('master FX popovers were retired in favour of the inspector strip, but one rendered');
      }
      // Master's sections carry no letter and no bypass/remove: the five are
      // fixed, so there is no order to name and nothing to take away.
      const extras = await cdp.evaluate(`!!${masterSec()}.querySelector('.th-strip-letter, .th-fx-chip-bypass, .th-fx-chip-remove')`);
      if (extras) throw new Error('master strip sections must have no letter and no bypass/remove buttons');
    });

    step('Master FX: selecting a track takes the inspector back from master', async () => {
      await fresh();
      // Put the column *on* master first. Without this the step read as a
      // pass on a fresh page, where the inspector belongs to the Lead track
      // and there is nothing to take back — it asserted that master was not
      // showing, having never made it show.
      await clickMasterCell();
      await waitFor(`!!${masterSec()}`);
      await selectFirstTrack();
      await waitFor(`!${masterSec()}`);
      const shown = await cdp.evaluate(`document.querySelector('.inspector .th-strip-name').textContent`);
      if (shown === 'Master') throw new Error('clicking a track header should hand the inspector back to that track');
      if (await isMasterSelected()) {
        throw new Error('the master cells should stop looking selected once a track takes the inspector');
      }
      // ...and back again, so the two directions are both covered.
      await clickMasterCell();
      await waitFor(`!!${masterSec()}`);
      if (!await isMasterSelected()) {
        throw new Error('clicking the Master cell should mark the bus selected');
      }
    });

    step('Master FX: the master volume slider does not steal the selection', async () => {
      await fresh();
      // A track's volume slider deliberately does NOT activate its track (it
      // stops the header's own mousedown), so master's must not either — or
      // nudging the master fader throws away whatever the inspector was
      // showing, note selection included.
      await selectFirstTrack();
      await waitFor(`!${masterSec()}`);
      await cdp.evaluate(`document.querySelector('#master-vol').click()`);
      if (await cdp.evaluate(`!!${masterSec()}`)) {
        throw new Error('clicking the master volume slider handed the inspector to the master bus');
      }
      if (await isMasterSelected()) {
        throw new Error('the master volume slider must not mark the bus selected — only the cell around it does');
      }
      // The cell itself still does, which is the whole point of the gesture.
      await clickMasterCell();
      await waitFor(`!!${masterSec()}`);
    });

    step('Master FX: selecting master drops a track-scoped strip focus', async () => {
      await fresh();
      // This bug only exists on the <=760px layout, where the strip opens
      // *only* for whoever stripFocus names. On a wide viewport both owners
      // render regardless and it leaves no trace in the DOM — which is how
      // two earlier drafts of this step passed against the unfixed code.
      //
      // The setup has to happen wide, though: on the narrow layout the only
      // way to give a track a strip focus is to tap one of its header chips,
      // and a freshly loaded track has no effect in use, so it has no chip
      // yet. So: reveal one wide, then narrow, then tap it.
      await selectFirstTrack();
      await waitFor(`!!document.querySelector('.inspector .th-strip-add button')`);
      await cdp.evaluate(`document.querySelector('.inspector .th-strip-add button').click()`);
      await waitFor(`!!document.querySelector('.th-fx-chip[data-track] .th-fx-chip-body')`);
      const chipTrack = await cdp.evaluate(`document.querySelector('.th-fx-chip[data-track]').dataset.track`);

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 700, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      try {
        await cdp.evaluate(`document.querySelector('.th-fx-chip[data-track="${chipTrack}"] .th-fx-chip-body').click()`);
        await waitFor(`!!document.querySelector('.inspector .th-strip-section[data-track="${chipTrack}"]')`);

        await clickMasterCell();
        // The bug: masterStripOpen is set and the cells draw as selected, but
        // renderInspector() falls through to the track branch, because the
        // stale `<track>::<fx>` focus still satisfies it — so the sheet goes
        // on showing the track's chain under a master-selected bottom bar.
        if (!await isMasterSelected()) {
          throw new Error('clicking the Master cell should mark the bus selected on the narrow layout too');
        }
        if (await cdp.evaluate(`!!document.querySelector('.inspector .th-strip-section[data-track="${chipTrack}"]')`)) {
          throw new Error("the master cells read as selected while the inspector still showed the previous track's strip");
        }
      } finally {
        await cdp.send('Emulation.clearDeviceMetricsOverride', {});
        // Put the track back the way this step found it — later steps and
        // songs share this page load. One round trip: the chip click puts the
        // section on screen synchronously, so the remove is reachable in the
        // same evaluate.
        await cdp.evaluate(`(() => {
          document.querySelector('.th-fx-chip[data-track="${chipTrack}"] .th-fx-chip-body')?.click();
          document.querySelector('.inspector .th-strip-section[data-track="${chipTrack}"] .th-fx-chip-remove')?.click();
        })()`);
      }
    });

    step('Master FX: EQ knob updates state and un-dims its chip', async () => {
      await fresh();
      await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="eq"] .th-fx-chip-body').click()`);
      await waitFor(`!!${masterSec('eq')}`);
      const secSel = masterSec('eq');
      const dialSel = `[...${secSel}.querySelectorAll('.th-knob')]` +
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
      if (await cdp.evaluate(`${secSel}.classList.contains('bypassed')`)) {
        throw new Error('the EQ strip section should stop looking dimmed once a value moves off default');
      }
      // Each keyboard commit refreshes the chip row (so the dim state above
      // reflects the new value) — that refresh must NOT rebuild the strip
      // section itself, or the focused dial gets detached and falls back to
      // <body>, silently breaking the global guard that stops arrow keys
      // from reaching nudgeSelection() while a knob has focus.
      const stillFocused = await cdp.evaluate(`document.activeElement === window.__testDial`);
      if (!stillFocused) throw new Error('knob dial lost DOM focus after a keyboard commit — a render() rebuilt the strip out from under it, which would let the next arrow-key press fall through to note-nudging');
      // Reset for later steps/songs sharing this page load.
      await cdp.evaluate(`(() => { const d = window.__testDial;
        for (let i = 0; i < 12; i++) d.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()`);
    });

    step('Master FX: Sidechain has a real On/Off toggle, not a bypass button', async () => {
      await fresh();
      await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="sidechain"] .th-fx-chip-body').click()`);
      await waitFor(`!!${masterSec('sidechain')}`);
      const toggleSel = `${masterSec('sidechain')}.querySelector('.th-strip-section-head .icon-btn')`;
      const before = await cdp.evaluate(`${toggleSel}.textContent`);
      if (before !== 'Off') throw new Error(`expected Sidechain to start Off, got ${before}`);
      await cdp.evaluate(`${toggleSel}.click()`);
      await waitFor(`${toggleSel}.textContent === 'On'`);
      const dimmed = await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="sidechain"]').classList.contains('bypassed')`);
      if (dimmed) throw new Error('Sidechain chip should stop looking dimmed once enabled');
      await cdp.evaluate(`${toggleSel}.click()`); // leave it Off for later steps/songs
    });

    step('Track header: a real click on Mute still lands, and on the name still renames', async () => {
      await fresh();
      // The header used to stop `mousedown` on each of its fifteen controls,
      // one line at a time, so that its own mousedown -> setActive -> render
      // could not rebuild a control out from under a click in progress. That
      // is now a single guard on the container, and only a TRUSTED click can
      // tell the two apart: element.click() dispatches no mousedown at all,
      // so every other step in this file would pass with the guard deleted
      // entirely. Hence Input.dispatchMouseEvent, as in the step below.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);

      const at = async (sel) => {
        const box = await cdp.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        if (!box) throw new Error(`no element for ${sel}`);
        return box;
      };
      const realClick = async ({ x, y }, clickCount = 1) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        for (let i = 1; i <= clickCount; i++) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
        }
        await new Promise((r) => setTimeout(r, 150));
      };

      // A button inside the header: the click must survive the header's own
      // mousedown, which activates the track and re-renders.
      const muteSel = '.track-header .th-btns button.m';
      const before = await cdp.evaluate(`document.querySelector('${muteSel}').getAttribute('aria-pressed')`);
      await realClick(await at(muteSel));
      const after = await cdp.evaluate(`document.querySelector('${muteSel}').getAttribute('aria-pressed')`);
      if (after === before) {
        throw new Error(`a real click on Mute was swallowed — the header re-rendered under it (aria-pressed stayed ${before})`);
      }
      await realClick(await at(muteSel)); // leave it unmuted for later steps

      // The track name is interactive without being a form element: it renames
      // on double-click, which needs the span to survive the first mousedown.
      await cdp.evaluate(`window.__renamePrompt = window.prompt; window.prompt = () => 'Renamed';`);
      await realClick(await at('.track-header .th-name'), 2);
      const named = await cdp.evaluate(`document.querySelector('.track-header .th-name').textContent`);
      await cdp.evaluate(`window.prompt = window.__renamePrompt;`);
      if (named !== 'Renamed') {
        throw new Error(`double-clicking the track name should rename it; the header rebuilt under the gesture instead (name is "${named}")`);
      }
    });

    step('FX: a real trusted click through the grid still lands after light-dismiss closes a popover', async () => {
      await fresh();
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

      const headSel = `document.querySelector('.track[data-kind="pitch"] .track-header')`;
      await waitFor(`!!(${headSel}).querySelector('.th-fx-panel')`);
      const panelSel = `(${headSel}).querySelector('.th-fx-panel')`;
      // The floating layer to dismiss is now the "+ Add effect" menu: per-track
      // FX popovers were retired in favour of the inspector column's strip, and
      // the add-menu is the remaining per-track member of that layer.
      await cdp.evaluate(`${panelSel}.querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);

      const tonalLaneSel = `document.querySelector('.track[data-kind="pitch"] .lane')`;
      const before = await cdp.evaluate(`document.querySelectorAll('.lane .note').length`);
      // Pick the point from the lane's *visible* intersection with the
      // viewport, not from a fixed offset. The lane is far wider than the
      // window (1024px of lane in a 780px viewport at the default headless
      // size), so `left + 200` can sit under the inspector rather than over
      // the grid — which is exactly what it did, making this step fail for a
      // day as if light-dismiss were eating the click when the click simply
      // never reached the lane.
      //
      // Then verify it: elementFromPoint must land inside the intended lane
      // before a single event is dispatched. A mis-aimed trusted click is
      // indistinguishable from the bug this step exists to catch, so the
      // aim is asserted separately and fails with both rects.
      const aim = await cdp.evaluate(`(() => {
        const lane = ${tonalLaneSel};
        const r = lane.getBoundingClientRect();
        // The lane's own rect is unclipped — 1024px of it in a 780px window —
        // so it reaches out under the inspector. What bounds the *visible*
        // grid is .daw, and within that the sticky track header + gutter
        // cover the left edge, so push in past those too.
        const daw = lane.closest('.daw').getBoundingClientRect();
        const gutterEnd = daw.left
          + parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-w'))
          + parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter-w'));
        const x0 = Math.max(r.left, gutterEnd) + 20, x1 = Math.min(r.right, daw.right) - 20;
        const y0 = Math.max(r.top, daw.top) + 12, y1 = Math.min(r.bottom, daw.bottom) - 12;
        const x = Math.round(Math.min(Math.max(r.left + 200, x0), x1));
        const y = Math.round(Math.min(Math.max(r.top + 60, y0), y1));
        const hit = document.elementFromPoint(x, y);
        return {
          x, y, ok: !!(hit && hit.closest('.lane') === lane && x1 > x0 && y1 > y0),
          hit: hit ? (hit.className || hit.tagName) : 'null',
          lane: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
          daw: { left: Math.round(daw.left), top: Math.round(daw.top), right: Math.round(daw.right), bottom: Math.round(daw.bottom) },
          view: { w: innerWidth, h: innerHeight },
        };
      })()`);
      if (!aim.ok) {
        throw new Error(`the click point is not over the tonal lane — it hits "${aim.hit}" at `
          + `(${aim.x}, ${aim.y}); lane ${JSON.stringify(aim.lane)} in viewport ${JSON.stringify(aim.view)}`);
      }
      const x = aim.x, y = aim.y;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 300));

      const after = await cdp.evaluate(`document.querySelectorAll('.lane .note').length`);
      if (after !== before + 1) {
        throw new Error(`a real click on the grid with a popover open should place exactly one note (light-dismiss must not eat the click), ${before} -> ${after}`);
      }
      const menuStillOpen = await cdp.evaluate(`!!document.querySelector('.th-fx-add-menu')`);
      if (menuStillOpen) throw new Error('the same outside click should also have dismissed the open add-menu');
    });

    // Last on purpose: this step reloads the page to install its createGain
    // patch, which drops the loaded example song every step above depends on.
    step('Track header: it follows every change to its track', async () => {
      await fresh();
      // A header is rebuilt from scratch on every render, so today this is
      // simply true. It is pinned because the obvious optimisation is to stop
      // rebuilding unchanged headers, and the hazard that buys is a value left
      // out of whatever key decides "unchanged": the header then silently
      // stops updating, which reads as the app ignoring a click. (Tried and
      // measured — a cache with a 100% hit rate changed render time by
      // nothing, because the cost is laying the header out, not building it.
      // See DESIGN.md B.4.) One assertion per thing such a key would need.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      const head = `document.querySelector('.track-header:not(.automation-header)')`;
      // Force a render between each mutation and its check, so a stale header
      // has every chance to show itself: penning a note re-renders everything.
      const churn = async () => {
        await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
        await cdp.evaluate(`(() => {
          const lane = document.querySelector('.lane');
          const r = lane.getBoundingClientRect();
          lane.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 30, clientY: r.top + 30, bubbles: true, pointerId: 1 }));
        })()`);
      };

      const cases = [
        { what: 'mute', act: `${head}.querySelector('.th-btns button.m').click()`,
          read: `${head}.querySelector('.th-btns button.m').getAttribute('aria-pressed')`, want: 'true' },
        { what: 'record-arm', act: `${head}.querySelector('.th-btns button.r').click()`,
          read: `${head}.querySelector('.th-btns button.r').getAttribute('aria-pressed')`, want: 'true' },
        { what: 'collapse', act: `${head}.querySelector('.th-collapse').click()`,
          read: `${head}.querySelector('.th-collapse').getAttribute('aria-expanded')`, want: 'false' },
      ];
      for (const c of cases) {
        await cdp.evaluate(c.act);
        await churn();
        const got = await cdp.evaluate(c.read);
        if (got !== c.want) {
          throw new Error(`the header did not follow a ${c.what} change — headerKey() is missing that value (read ${got}, wanted ${c.want})`);
        }
        await cdp.evaluate(c.act); // put it back
      }

      // The waveform picker's label, and the Inserts chip row: both live in
      // sections the key covers separately from the identity row above.
      await cdp.evaluate(`${head}.querySelector('.th-osc-trigger').click()`);
      await waitFor(`!!document.querySelector('.th-osc-menu button[data-value="sawtooth"]')`);
      await cdp.evaluate(`document.querySelector('.th-osc-menu button[data-value="sawtooth"]').click()`);
      await churn();
      const wave = await cdp.evaluate(`${head}.querySelector('.th-osc-trigger span').textContent`);
      if (wave !== 'Saw') throw new Error(`the header's waveform label went stale after a change (reads "${wave}")`);

      const chipsBefore = await cdp.evaluate(`${head}.querySelectorAll('.th-fx-chip').length`);
      await cdp.evaluate(`${head}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
      await waitFor(`!!document.querySelector('.inspector .th-strip-add button')`);
      await cdp.evaluate(`document.querySelector('.inspector .th-strip-add button').click()`);
      await churn();
      const chipsAfter = await cdp.evaluate(`${head}.querySelectorAll('.th-fx-chip').length`);
      if (chipsAfter !== chipsBefore + 1) {
        throw new Error(`adding an effect should add a chip to the header; got ${chipsBefore} -> ${chipsAfter}`);
      }

      // And a rename, which is the identity row's own text.
      await cdp.evaluate(`window.__p = window.prompt; window.prompt = () => 'Renamed';`);
      await cdp.evaluate(`${head}.querySelector('.th-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await cdp.evaluate(`window.prompt = window.__p;`);
      await churn();
      const named = await cdp.evaluate(`${head}.querySelector('.th-name').textContent`);
      if (named !== 'Renamed') throw new Error(`the header kept the old name after a rename (reads "${named}")`);
    });

    step('Many tracks: off-screen rows still report their real height', async () => {
      await fresh();
      // Nothing skips layout here today, so this passes trivially — and that
      // is the point of pinning it. `content-visibility: auto` on `.track` was
      // tried and measured as a 3-4x speed-up (471 -> 155 ms at 48 tracks) and
      // then dropped, because the overlays (playhead, markers, loop region)
      // are sized from `daw.scrollHeight` and a skipped row reports
      // `contain-intrinsic-size` rather than its real height: 3660 vs 4130 px
      // over 17 rows, so the playhead stopped 470px short of the last track
      // and the scrollbar lied. A row's height is max(lane, header) and the
      // header's is content-driven, so the placeholder cannot be set exactly.
      // Any future attempt at that optimisation has to keep this green.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      for (let i = 0; i < 12; i++) {
        await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
        await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Add track')).click()`);
      }
      // Measured by turning the optimisation off in place and comparing: if a
      // skipped row were reporting contain-intrinsic-size instead of its real
      // height, the scrollable height would move when the skipping stops.
      // (Summing the rows and comparing to scrollHeight was the first attempt
      // and is the wrong test — it fails on the container's own padding,
      // which has nothing to do with what is being asked.)
      const geom = await cdp.evaluate(`(() => {
        const daw = document.getElementById('daw');
        const rows = [...document.querySelectorAll('#tracks .track')];
        const skipped = daw.scrollHeight;
        rows.forEach((r) => { r.style.contentVisibility = 'visible'; });
        void daw.offsetHeight; // force the layout we just asked for
        const forced = daw.scrollHeight;
        rows.forEach((r) => { r.style.contentVisibility = ''; });
        return { rows: rows.length, skipped, forced, clientH: daw.clientHeight,
                 playhead: Math.round(parseFloat(document.querySelector('.playhead').style.height) || 0) };
      })()`);
      if (!(geom.skipped > geom.clientH)) throw new Error('needed enough tracks for .daw to scroll; it does not');
      if (Math.abs(geom.skipped - geom.forced) > 2) {
        throw new Error(`off-screen rows are reporting a placeholder height, not their real one: `
          + `${geom.skipped} skipped vs ${geom.forced} laid out, over ${geom.rows} rows`);
      }
      if (Math.abs(geom.playhead - geom.skipped) > 2) {
        throw new Error(`the playhead should span the whole track stack: ${geom.playhead} vs ${geom.skipped}`);
      }

      // This step leaves a dozen extra tracks behind, and later steps share
      // the page. Reload so it cannot colour anything that runs after it.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
    });

    step('Instrument presets: a built-in one reaches the track, not just the list', async () => {
      // The built-ins are settings the engine already understands, so the
      // check is that loading one moves the track's real synth state —
      // waveform, envelope, FM — not merely that a row rendered.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await cdp.evaluate(`document.querySelector('.track-header:not(.automation-header) .th-tool-btn.icon').click()`);
      await waitFor(`document.querySelectorAll('#builtin-preset-list .song-item').length > 0`);

      const names = await cdp.evaluate(`[...document.querySelectorAll('#builtin-preset-list .song-title')].map(t => t.textContent)`);
      if (!names.includes('Electric piano')) {
        throw new Error(`expected the built-in list to offer an electric piano, got ${JSON.stringify(names)}`);
      }
      // Each row describes itself — the summary is what tells you what a
      // preset does before you load it.
      const desc = await cdp.evaluate(`[...document.querySelectorAll('#builtin-preset-list .song-item')]
        .find(r => r.querySelector('.song-title').textContent === 'Electric piano').querySelector('.song-desc').textContent`);
      if (!/FM/.test(desc)) throw new Error(`the electric piano row should say it is an FM patch, reads "${desc}"`);
      if (await cdp.evaluate(`!!document.querySelector('#builtin-preset-list .song-del')`)) {
        throw new Error('a built-in preset must not offer Delete — it is not stored anywhere to delete from');
      }

      await cdp.evaluate(`[...document.querySelectorAll('#builtin-preset-list .song-item')]
        .find(r => r.querySelector('.song-title').textContent === 'Electric piano')
        .querySelector('button').click()`);
      await waitFor(`document.getElementById('preset-dialog').open === false`);

      const wave = await cdp.evaluate(`document.querySelector('.th-osc-trigger span').textContent`);
      if (wave !== 'FM') throw new Error(`loading the electric piano should switch the track to FM, header reads "${wave}"`);

      await cdp.evaluate(`[...document.querySelectorAll('.track-header:not(.automation-header) .th-tool-btn')]
        .find(b => b.textContent.includes('Env')).click()`);
      await waitFor(`!!document.querySelector('.adsr-lane-el')`);
      const env = await cdp.evaluate(`(() => {
        const vals = {};
        document.querySelectorAll('.adsr-lane-el .adsr-field').forEach((f) => {
          const cap = f.querySelector('.adsr-label'), val = f.querySelector('.adsr-val');
          if (cap && val) vals[cap.textContent.trim()] = val.textContent;
        });
        return vals;
      })()`);
      // Instant attack and real FM depth are what separate this patch from
      // the square-wave default it replaced.
      if (env.Attack !== '0%') throw new Error(`the electric piano should strike instantly, Attack reads ${env.Attack}`);
      if (!env.Depth || env.Depth === '0%') throw new Error(`the electric piano needs FM depth to sound like one, Depth reads ${env.Depth}`);

      // Leave the page as this step found it. Steps share a browser, and the
      // mobile-player step further down measures a viewport it assumes is
      // untouched — it failed here until this reload was added, the same way
      // it failed after the many-tracks step above.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
    });

    step('Keyboard gutter: keys instead of note names, and pressing one is audible', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track[data-kind="pitch"] .gutter .pkey')`);
      const keys = await cdp.evaluate(`(() => {
        const g = document.querySelector('.track[data-kind="pitch"] .gutter');
        const all = [...g.querySelectorAll('.pkey')];
        return {
          total: all.length,
          white: g.querySelectorAll('.pkey.white').length,
          black: g.querySelectorAll('.pkey.black').length,
          // A key carries no text, so its name has to be somewhere or the
          // gutter is a wall of unlabelled boxes to a screen reader.
          unlabelled: all.filter(k => !k.getAttribute('aria-label')).length,
          // Black keys are shorter — that shape is what reads as a keyboard.
          blackNarrower: (() => {
            const w = g.querySelector('.pkey.white').getBoundingClientRect().width;
            const b = g.querySelector('.pkey.black').getBoundingClientRect().width;
            return b < w;
          })(),
          // Only C is labelled, with its octave.
          octaves: [...g.querySelectorAll('.koct')].map(o => o.textContent),
        };
      })()`);
      if (keys.total < 12 || keys.white === 0 || keys.black === 0) {
        throw new Error(`expected a keyboard of white and black keys, got ${JSON.stringify(keys)}`);
      }
      if (keys.unlabelled) throw new Error(`${keys.unlabelled} keys carry no accessible name`);
      if (!keys.blackNarrower) throw new Error('black keys must be shorter than white ones');
      if (!keys.octaves.length) throw new Error('C should be labelled with its octave');
      // Note names are gone from a tonal gutter — that was the ask.
      const stillNamed = await cdp.evaluate(
        `document.querySelectorAll('.track[data-kind="pitch"] .gutter .glabel').length`);
      if (stillNamed) throw new Error(`the note-name labels should be gone, found ${stillNamed}`);
      // ...but the rhythm gutter still names its ten pieces.
      const drumNames = await cdp.evaluate(
        `document.querySelectorAll('.track[data-kind="rhythm"] .gutter .glabel').length`);
      if (drumNames < 10) throw new Error(`the rhythm gutter still needs its labels, found ${drumNames}`);

      // Pressing a key must reach the audio graph at *that pitch* — a count of
      // oscillators is not enough, since building a channel makes some of its
      // own (the PWM sweep LFO), so "something was created" can be true while
      // the key is silent. Record the frequencies and look for the key's own.
      await cdp.evaluate(`(() => {
        window.__freqs = [];
        const orig = AudioContext.prototype.createOscillator;
        AudioContext.prototype.createOscillator = function () {
          const o = orig.call(this);
          const d = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
          try {
            Object.defineProperty(o.frequency, 'value', {
              get() { return d.get.call(this); },
              set(v) { window.__freqs.push(Math.round(v)); d.set.call(this, v); },
              configurable: true,
            });
          } catch {}
          const os = o.frequency.setValueAtTime.bind(o.frequency);
          o.frequency.setValueAtTime = (v, t) => { window.__freqs.push(Math.round(v)); return os(v, t); };
          return o;
        };
      })()`);
      const pressed = await cdp.evaluate(`(() => {
        const k = document.querySelector('.track[data-kind="pitch"] .gutter .pkey');
        k.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        // The key carries its own pitch. Parsing it back out of the label was
        // the first attempt and it threw — the label is for a human, and
        // deriving a number from prose is a second place for the two to drift.
        return Math.round(440 * Math.pow(2, (Number(k.dataset.midi) - 69) / 12));
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      const heard = await cdp.evaluate(`window.__freqs.slice()`);
      if (!heard.some((f) => Math.abs(f - pressed) <= 1)) {
        throw new Error(`pressing the key should sound ${pressed} Hz, the graph saw ${JSON.stringify(heard)}`);
      }
      await goto(APP_URL);
    });

    step('Velocity lane: a stem per item, and dragging its head sets the value', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track[data-kind="pitch"] .lane')`);
      // Three notes, so "which is loudest" is a real comparison.
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect();
        for (let i = 0; i < 3; i++) {
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 40 + i * 70, clientY: r.top + 25 }));
        }
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="pitch"] .note').length === 3`);
      await cdp.evaluate(`(() => {
        const h = document.querySelector('.track[data-kind="pitch"] .track-header');
        [...h.querySelectorAll('.th-tool-btn')].find(b => /Vel/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.vel-lane-el')`);
      const drawn = await cdp.evaluate(`({
        stems: document.querySelectorAll('.vel-stem').length,
        heads: document.querySelectorAll('.vel-head').length,
      })`);
      if (drawn.stems !== 3 || drawn.heads !== 3) {
        throw new Error(`three notes should draw three stems and three heads, got ${JSON.stringify(drawn)}`);
      }

      // Drag one head down and read the value back off the note, not off the
      // element: the lane redrawing is not evidence that anything was stored.
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.vel-lane-el');
        const lr = lane.getBoundingClientRect();
        const h = document.querySelectorAll('.vel-head')[1];
        h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1,
          clientX: h.getBoundingClientRect().left + 4, clientY: lr.top + lr.height - 8 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      const saved = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return null;
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind !== 'rhythm').id;
        return window.__savedNotes(d, id).map(n => n.vel ?? 1).sort();
      })()`);
      if (!saved || !saved.some((v) => v < 0.5)) {
        throw new Error(`dragging a head should store a quieter velocity, song has ${JSON.stringify(saved)}`);
      }
      // Full velocity must still serialise as absent, or every song written
      // before this lane existed starts saving differently.
      if (!saved.filter((v) => v === 1).length) {
        throw new Error(`untouched notes should stay at full velocity, got ${JSON.stringify(saved)}`);
      }
      // The drawing has to follow the value, not merely exist. Pair each stem
      // with the velocity beside it and require the order to match: the
      // quietest note must have the shortest stem. Asserting only "the heights
      // differ" passed against a build where every stem was drawn at full
      // height, because the *notes* still differed.
      const paired = await cdp.evaluate(`(() => {
        const lane = document.querySelector('.vel-lane-el');
        const stems = [...lane.querySelectorAll('.vel-stem')].map(s => Math.round(s.getBoundingClientRect().height));
        const vels = [...lane.querySelectorAll('.vel-head')].map(h => Number(h.getAttribute('aria-valuenow')));
        return { stems, vels };
      })()`);
      if (paired.stems.length !== 3 || paired.vels.length !== 3) {
        throw new Error(`expected three stems and three heads, got ${JSON.stringify(paired)}`);
      }
      const quietest = paired.vels.indexOf(Math.min(...paired.vels));
      const loudest = paired.vels.indexOf(Math.max(...paired.vels));
      if (paired.vels[quietest] === paired.vels[loudest]) {
        throw new Error(`the drag should have made one note quieter: ${JSON.stringify(paired)}`);
      }
      if (!(paired.stems[quietest] < paired.stems[loudest])) {
        throw new Error(`the quieter note must draw the shorter stem: ${JSON.stringify(paired)}`);
      }

      // The lane is generic over the per-item values that already exist, so a
      // picker switches it rather than a second lane being built. Pan is
      // signed, which is a different axis, not just a different label.
      const params = await cdp.evaluate(
        `[...document.querySelector('.vel-lane-el').closest('.track').querySelectorAll('select')][0]
          .options.length`);
      if (params < 2) throw new Error(`the lane should offer more than one value, got ${params}`);
      await cdp.evaluate(`(() => {
        const sel = document.querySelector('.vel-lane-el').closest('.track').querySelector('select');
        sel.value = 'pan'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(`!!document.querySelector('.vel-zero')`);
      const panAxis = await cdp.evaluate(`(() => {
        const row = document.querySelector('.vel-lane-el').closest('.track');
        return {
          labels: [...row.querySelectorAll('.gutter .glabel')].map(g => g.textContent.trim()),
          heads: row.querySelectorAll('.vel-head').length,
        };
      })()`);
      if (panAxis.heads !== 3) throw new Error(`switching value should keep one head per note: ${JSON.stringify(panAxis)}`);
      if (!panAxis.labels.join(' ').match(/[LR]|C/)) {
        throw new Error(`the pan axis should be labelled in pan terms, got ${JSON.stringify(panAxis.labels)}`);
      }
      // ...and dragging now writes pan, not velocity.
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.vel-lane-el');
        const lr = lane.getBoundingClientRect();
        const h = document.querySelectorAll('.vel-head')[0];
        h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1,
          clientX: h.getBoundingClientRect().left + 4, clientY: lr.top + lr.height - 8 }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      const wrote = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind !== 'rhythm').id;
        return window.__savedNotes(d, id).filter(n => n.pan != null).length;
      })()`);
      if (!wrote) throw new Error('dragging on the Pan lane should store a pan, not a velocity');
      await goto(APP_URL);
    });

    step('Slip: Free places without snapping, and the grid still sets the length', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track[data-kind="pitch"] .lane')`);
      // Read the note out of the DOM, not the autosave draft: autosave is
      // debounced 400ms, so a read straight after the click returns the
      // *previous* step's song — which is exactly how the first version of
      // this failed, reporting a start of 31 for a click 1.4 columns in.
      const penAt = async (offset) => {
        const before = await cdp.evaluate(`document.querySelectorAll('.track[data-kind="pitch"] .note').length`);
        await cdp.evaluate(`(() => {
          const lane = document.querySelector('.track[data-kind="pitch"] .lane');
          const r = lane.getBoundingClientRect();
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + ${offset}, clientY: r.top + 25 }));
        })()`);
        await waitFor(`document.querySelectorAll('.track[data-kind="pitch"] .note').length === ${before + 1}`);
        return cdp.evaluate(`(() => {
          const lane = document.querySelector('.track[data-kind="pitch"] .lane');
          const cells = lane.querySelectorAll('.cell');
          const px = cells[1].getBoundingClientRect().left - cells[0].getBoundingClientRect().left;
          const notes = [...lane.querySelectorAll('.note')];
          const n = notes[notes.length - 1].getBoundingClientRect();
          const lr = lane.getBoundingClientRect();
          return { start: Math.round((n.left - lr.left) / px * 100) / 100, len: Math.round(n.width / px * 100) / 100 };
        })()`);
      };
      // A column is one eighth wide; 1.4 columns in is deliberately off-grid.
      const colPx = await cdp.evaluate(`(() => {
        const cells = document.querySelectorAll('.track[data-kind="pitch"] .lane .cell');
        return Math.round(cells[1].getBoundingClientRect().left - cells[0].getBoundingClientRect().left);
      })()`);
      const snapped = await penAt(Math.round(colPx * 1.4));
      if (!snapped || Math.abs(snapped.start - 1) > 0.01) {
        throw new Error(`with the grid on, a click 1.4 columns in should snap to 1, got ${JSON.stringify(snapped)}`);
      }
      await cdp.evaluate(`(() => {
        const g = document.getElementById('grid-select');
        g.value = 'free'; g.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      const free = await penAt(Math.round(colPx * 3.4));
      if (!free) throw new Error('nothing was placed with Free on');
      // Off-grid by a real margin, not by float noise: MICRO is 1/6 of a
      // column, so a genuine unsnapped landing is at least ~0.16 off.
      if (Math.abs(free.start - Math.round(free.start)) < 0.1) {
        throw new Error(`with Free on, a click 3.4 columns in should land off the grid, got ${JSON.stringify(free)}`);
      }
      // The grid is still the note length — Free is about snapping, not about
      // how long a new note is, and conflating the two is the obvious mistake.
      if (Math.abs(free.len - snapped.len) > 1e-6) {
        throw new Error(`Free should not change the length a new note takes: ${JSON.stringify({ snapped, free })}`);
      }
      // Editor state, not song content: it must not ride along in the file.
      const inSong = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        return 'snap' in d || 'snapOn' in d;
      })()`);
      if (inSong) throw new Error('the snap setting belongs to the browser, not to the song');
      await cdp.evaluate(`localStorage.removeItem('frogger-music-editor-snap')`);
      await goto(APP_URL);
    });

    step('Timing: quantize moves by its strength, and 0% moves nothing', async () => {
      // Capture and correction are separate now — recording keeps the timing
      // it was played with, and this is what tidies it afterwards. The
      // assertions are the two ends plus proportionality, because those are
      // deterministic: humanize is random, so anything asserting "it landed
      // off the grid" would pass or fail on a dice roll.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track[data-kind="pitch"] .lane')`);
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect();
        for (let i = 0; i < 4; i++) {
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 40 + i * 70, clientY: r.top + 25 }));
        }
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="pitch"] .note').length === 4`);

      const starts = async () => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind !== 'rhythm').id;
        return window.__savedNotes(d, id).map(n => n.start).sort((a, b) => a - b);
      })()`);
      // Total distance from the grid. `grid` is 1 (an eighth) on a fresh page.
      const err = (list) => list.reduce((sum, st) => sum + Math.abs(st - Math.round(st)), 0);

      const openTiming = async () => {
        await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
        await cdp.evaluate(`document.getElementById('timing-btn').click()`);
        await waitFor(`document.getElementById('timing-dialog').open === true`);
      };
      const run = async (id, value, slider) => {
        await cdp.evaluate(`(() => {
          const s = document.getElementById('${slider}');
          s.value = '${value}'; s.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('${id}').click();
        })()`);
        await new Promise((r) => setTimeout(r, 500));
      };

      await openTiming();
      // Scatter them first, so there is an error to correct at all.
      await run('timing-humanize', '1', 'timing-amount');
      const scattered = await starts();
      if (scattered.length !== 4) throw new Error(`humanize should not lose notes, got ${JSON.stringify(scattered)}`);

      // Strength 0 is the sharp end: a quantize that ignores its strength
      // would snap everything here, and nothing else in this step would notice.
      await run('timing-quantize', '0', 'timing-strength');
      const atZero = await starts();
      if (JSON.stringify(atZero) !== JSON.stringify(scattered)) {
        throw new Error(`quantize at 0% must move nothing: ${JSON.stringify(scattered)} -> ${JSON.stringify(atZero)}`);
      }

      // Half strength halves the error rather than removing it.
      const before = err(scattered);
      await run('timing-quantize', '0.5', 'timing-strength');
      const half = await starts();
      const midErr = err(half);
      if (midErr > before + 1e-9) {
        throw new Error(`quantize at 50% should move notes toward the grid, error ${before} -> ${midErr}`);
      }
      if (before > 0.2 && !(midErr > 0)) {
        throw new Error(`quantize at 50% should not land dead on the grid: ${JSON.stringify(half)}`);
      }

      // Full strength puts every note on a grid line.
      await run('timing-quantize', '1', 'timing-strength');
      const full = await starts();
      if (full.length !== 4) throw new Error(`quantize should not lose notes, got ${JSON.stringify(full)}`);
      if (err(full) > 1e-6) {
        throw new Error(`quantize at 100% should land every note on the grid: ${JSON.stringify(full)}`);
      }

      // Quantizing a run at one pitch collapses it onto a single column, and
      // two notes at the same pitch and column is a duplicate the app never
      // allows anywhere else. Four notes were placed at four pitches above, so
      // stack a same-pitch run and check it merges instead.
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect();
        // Same row, three adjacent grid steps.
        for (let i = 0; i < 3; i++) {
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 420 + i * 24, clientY: r.top + 60 }));
        }
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      await run('timing-quantize', '1', 'timing-strength');
      const merged = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind !== 'rhythm').id;
        const seen = new Set(); let dupes = 0;
        for (const n of window.__savedNotes(d, id)) {
          const key = n.start + '@' + n.freq;
          if (seen.has(key)) dupes++;
          seen.add(key);
        }
        return dupes;
      })()`);
      if (merged) throw new Error(`quantize left ${merged} notes stacked at the same pitch and column`);

      await cdp.evaluate(`document.getElementById('timing-close').click()`);
      await goto(APP_URL);
    });

    step('Transport: every button centres its symbol, and Record is filled like Play/Stop', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);

      // Centring is the kind of thing you otherwise only have an opinion
      // about. The glyph-carrying buttons are the ones at risk: a plain
      // character is centred by the button's own text centring, while an
      // inline SVG sits on the text baseline instead.
      const off = await cdp.evaluate(`(() => {
        const out = [];
        document.querySelectorAll('#transport-panel .tp-btn').forEach((b) => {
          const g = b.querySelector('.glyph');
          if (!g) return;
          const br = b.getBoundingClientRect(), gr = g.getBoundingClientRect();
          const dx = (gr.left + gr.width / 2) - (br.left + br.width / 2);
          const dy = (gr.top + gr.height / 2) - (br.top + br.height / 2);
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
            out.push({ id: b.id, dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10 });
          }
        });
        return out;
      })()`);
      if (off.length) {
        throw new Error(`transport glyphs are off-centre in their buttons: ${JSON.stringify(off)}`);
      }

      // Record sits between ▶ and ■, which are solid shapes; a stroked ring
      // among them reads as a different kind of control.
      const rec = await cdp.evaluate(`(() => {
        const p = document.querySelector('#record-btn .glyph path');
        if (!p) return null;
        const cs = getComputedStyle(p);
        return { fill: cs.fill, stroke: cs.stroke };
      })()`);
      if (!rec) throw new Error('the Record button should carry a glyph');
      if (rec.fill === 'none') throw new Error(`the Record dot should be filled to match Play and Stop, got fill: ${rec.fill}`);

      // ...and the rest of the icon set stays stroked, so "filled" is a
      // property of that one glyph rather than a change to all of them.
      const strokedStillStroked = await cdp.evaluate(`(() => {
        const p = document.querySelector('#metronome-btn .glyph path');
        return p ? getComputedStyle(p).fill : null;
      })()`);
      if (strokedStillStroked !== 'none') {
        throw new Error(`only Record opts into a fill; the metronome should still be stroked, got fill: ${strokedStillStroked}`);
      }
    });

    step('Mobile: the page becomes a player, with a way back to the editor', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      if (await cdp.evaluate(`!document.getElementById('player').hidden`)) {
        throw new Error('the player must stay hidden on a desktop-width viewport');
      }

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 420, height: 820, deviceScaleFactor: 1, mobile: true,
      });
      try {
        await waitFor(`document.body.classList.contains('player-mode')`);
        // The editor is hidden as a whole rather than control by control, so
        // this checks the pieces a user could otherwise still poke at.
        const visible = await cdp.evaluate(`(() => {
          const shown = (sel) => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0; };
          return { toolbar: shown('.toolbar'), grid: shown('.editor-layout'), hscroll: shown('#hscroll'), player: shown('#player') };
        })()`);
        if (!visible.player) throw new Error('the player should be on screen at 420px');
        if (visible.toolbar || visible.grid || visible.hscroll) {
          throw new Error(`the editor should be hidden in player mode, got ${JSON.stringify(visible)}`);
        }

        await waitFor(`document.querySelectorAll('#player-list button').length > 0`);
        const head = await cdp.evaluate(`({
          song: document.getElementById('player-song').textContent,
          total: document.getElementById('player-total').textContent,
        })`);
        if (!head.song) throw new Error('the player should name the current song');
        if (!/^\d+:\d\d$/.test(head.total)) throw new Error(`expected a mm:ss total, got "${head.total}"`);

        // Tapping the middle of the position bar seeks to about halfway.
        await cdp.evaluate(`(() => {
          const bar = document.getElementById('player-progress');
          const r = bar.getBoundingClientRect();
          bar.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1,
          }));
        })()`);
        const seeked = await cdp.evaluate(`parseFloat(document.getElementById('player-fill').style.width)`);
        if (!(seeked > 30 && seeked < 70)) {
          throw new Error(`tapping the middle of the position bar should seek to about halfway, fill is ${seeked}%`);
        }

        // The transport stays put while the list scrolls. Measured as a real
        // scroll, because the failure mode this replaced looked fine in a
        // screenshot: the list simply grew and pushed the card off the top,
        // taking Play and the position bar with it exactly when a song is
        // playing and you are looking for the next one.
        // Force a viewport short enough that the list definitely overflows,
        // rather than relying on the bundled song count to fill 820px — that
        // would make the assertion pass or fail on how many .json files
        // happen to be in songs/, which is not what is under test here.
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 420, height: 520, deviceScaleFactor: 1, mobile: true,
        });
        // Retry the whole measurement rather than any single read. The resize
        // is applied by the browser, not by this call returning, so anything
        // read straight after it can land before the relayout — and patching
        // one assertion at a time just moved the flake: first `canScroll` was
        // false, then `scrollTop` clamped to 0 on a list that was not
        // scrollable *yet*. Setting scrollTop is idempotent, so re-running the
        // whole probe until it takes is both simpler and actually stable. It
        // also covers the list still being filled in from songs/index.json.
        let scrolled = null;
        const scrollDeadline = Date.now() + 5000;
        while (Date.now() < scrollDeadline) {
          scrolled = await cdp.evaluate(`(() => {
            const list = document.getElementById('player-list');
            if (!list) return null;
            const cardTop = () => Math.round(document.getElementById('player-card').getBoundingClientRect().top);
            const before = cardTop();
            list.scrollTop = 400; // past the end is fine — it clamps
            return { before, after: cardTop(), listScrolled: list.scrollTop,
                     canScroll: list.scrollHeight > list.clientHeight };
          })()`);
          if (scrolled && scrolled.listScrolled > 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!scrolled || !scrolled.canScroll) {
          throw new Error('the song list should be its own scrolling box (scrollHeight > clientHeight), so the page does not grow instead');
        }
        if (!(scrolled.listScrolled > 0)) throw new Error('the song list did not scroll at all');
        if (scrolled.before !== scrolled.after) {
          throw new Error(`the player card must not move when the list scrolls (top ${scrolled.before} -> ${scrolled.after})`);
        }
        // ...and the page behind it isn't a second scrolling surface.
        const pageScrolls = await cdp.evaluate(`document.documentElement.scrollHeight > window.innerHeight + 1`);
        if (pageScrolls) throw new Error('player mode should fit the viewport exactly — the page itself must not scroll too');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 420, height: 820, deviceScaleFactor: 1, mobile: true,
        });

        // The way back out, and that it is remembered.
        await cdp.evaluate(`document.getElementById('player-editor-link').click()`);
        await waitFor(`!document.body.classList.contains('player-mode')`);
        if (!await cdp.evaluate(`document.querySelector('.toolbar').getClientRects().length > 0`)) {
          throw new Error('opting into the editor should bring the toolbar back');
        }
        await goto(APP_URL);
        await waitFor(`!!document.querySelector('.th-osc-trigger')`);
        if (await cdp.evaluate(`document.body.classList.contains('player-mode')`)) {
          throw new Error('the editor opt-in should be remembered across a reload');
        }
        await cdp.evaluate(`localStorage.removeItem('music-studio-mobile-editor')`);
      } finally {
        await cdp.send('Emulation.clearDeviceMetricsOverride', {});
      }
    });

    step('MIDI input: a played note lands on the armed track with its velocity', async () => {
      await fresh();
      // No hardware needed and none wanted: Web MIDI is an interface, so a
      // stub that answers requestMIDIAccess() with one fake input exercises
      // every line the real thing would — the message parsing, the velocity
      // mapping, the routing to the armed track — while staying deterministic.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            const input = { name: 'Fake Keys', onmidimessage: null };
            const access = {
              inputs: new Map([['fake', input]]),
              onstatechange: null,
            };
            navigator.requestMIDIAccess = () => Promise.resolve(access);
            // The app attaches its handler to input.onmidimessage; this is how
            // the test plays a key.
            window.__midi = (bytes) => input.onmidimessage({ data: bytes });
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);

      await cdp.evaluate(`document.getElementById('midi-input-btn').click()`);
      await waitFor(`document.getElementById('midi-input-btn').getAttribute('aria-pressed') === 'true'`);
      const label = await cdp.evaluate(`document.querySelector('#midi-input-btn .file-menu-label').textContent`);
      if (!label.includes('Fake Keys')) throw new Error(`the menu item should name the connected device, got "${label}"`);

      // Nothing armed yet: a played note must do nothing, exactly as the
      // letter keys do. Without this the next assertion could pass for the
      // wrong reason.
      await cdp.evaluate(`window.__midi([0x90, 60, 100]); window.__midi([0x80, 60, 0]);`);
      if (await cdp.evaluate(`document.querySelectorAll('.lane .note').length`) !== 0) {
        throw new Error('a MIDI note with no track armed should not place anything');
      }

      // Arm the first tonal track and step-enter a note at two velocities.
      await cdp.evaluate(`document.querySelector('.track-header .th-btns button.r').click()`);
      await waitFor(`!!document.querySelector('.track-header .th-btns button.r.on')`);
      await cdp.evaluate(`window.__midi([0x90, 60, 127]); window.__midi([0x80, 60, 0]);`);
      await cdp.evaluate(`window.__midi([0x90, 64, 51]); window.__midi([0x90, 64, 0]);`); // note-on vel 0 = note off
      await waitFor(`document.querySelectorAll('.lane .note').length === 2`);

      // Read the autosaved draft rather than the app's own `state`: it lives in
      // module scope and is not on window, and going through the saved file
      // proves the velocity survives serialisation too.
      const armed = () => cdp.evaluate(`document.querySelector('.track-header .th-btns button.r.on').closest('.track').dataset.track`);
      // autosave() is debounced, so the draft lags the DOM by a moment — wait
      // for it to carry the expected count rather than reading it straight
      // after the last message and finding yesterday's copy.
      const savedItems = async (expected) => {
        const id = await armed();
        const read = `window.__savedNotes(JSON.parse(localStorage.getItem('frogger-music-editor-autosave')) || {}, ${JSON.stringify(id)})`;
        await waitFor(`(${read}).length === ${expected}`);
        return cdp.evaluate(read);
      };
      const notes = (await savedItems(2)).map(n => ({ freq: Math.round(n.freq), vel: n.vel })).sort((a, b) => a.freq - b.freq);
      // 127 -> 1, and 51/127 = 0.401… -> 0.40 on the sliders' own 0.05 step.
      if (notes.length !== 2) throw new Error(`expected two recorded notes, got ${JSON.stringify(notes)}`);
      if (notes[0].vel !== 1) throw new Error(`velocity 127 should land at full level, got ${JSON.stringify(notes[0])}`);
      if (Math.abs(notes[1].vel - 0.4) > 1e-9) {
        throw new Error(`velocity 51 should map to 0.40 (the Velocity slider's own step), got ${JSON.stringify(notes[1])}`);
      }
      if (notes[0].freq !== 262 || notes[1].freq !== 330) {
        throw new Error(`expected middle C and E above it, got ${JSON.stringify(notes)}`);
      }

      // A rhythm track takes the same messages through the General MIDI map,
      // and a note that maps to no kit piece is dropped rather than folded
      // onto the nearest one.
      // The kit is the last track in the list, and the only one whose lane has
      // drum rows — picked from the DOM rather than from `state`.
      // Picked from the DOM rather than from `state`: a rhythm track is the one
      // whose gutter carries the kit's own row labels (.glabel.rhy).
      await cdp.evaluate(`document.querySelector('.track:has(.glabel.rhy) .th-btns button.r').click()`);
      await waitFor(`document.querySelectorAll('.track-header .th-btns button.r.on').length === 1`);
      await cdp.evaluate(`window.__midi([0x99, 38, 64]); window.__midi([0x89, 38, 0]);`);  // GM snare
      await cdp.evaluate(`window.__midi([0x99, 21, 100]); window.__midi([0x89, 21, 0]);`); // maps to nothing
      const hits = (await savedItems(1)).map(h => ({ type: h.type, vel: h.vel === undefined ? 'absent' : h.vel }));
      if (hits.length !== 1 || hits[0].type !== 'snare') {
        throw new Error(`GM note 38 should place exactly one snare and note 21 nothing, got ${JSON.stringify(hits)}`);
      }
      if (Math.abs(hits[0].vel - 0.5) > 1e-9) {
        throw new Error(`velocity 64 should map to 0.50, got ${JSON.stringify(hits[0])}`);
      }
    });

    step('Rhythm: a hit carries a velocity that reaches the audio graph and the saved file', async () => {
      await fresh();
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
          // No drum scheduler makes a lowpass — they use bandpass and highpass
          // only — so a lowpass created while a hit plays is unambiguously the
          // velocity tone filter scheduleDrum inserts.
          window.__velTone = [];
          const origBq = AudioContext.prototype.createBiquadFilter;
          AudioContext.prototype.createBiquadFilter = function () {
            const f = origBq.call(this);
            const td = Object.getOwnPropertyDescriptor(BiquadFilterNode.prototype, 'type');
            const fd = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
            let isLow = false;
            try {
              Object.defineProperty(f, 'type', {
                get() { return td.get.call(this); },
                set(v) { isLow = v === 'lowpass'; td.set.call(this, v); },
                configurable: true,
              });
              Object.defineProperty(f.frequency, 'value', {
                get() { return fd.get.call(this); },
                set(v) {
                  if (isLow) window.__velTone.push(Math.round(v));
                  // Kits are told apart by their filter frequencies, so record them all.
                  (window.__bqFreqs = window.__bqFreqs || []).push(Math.round(v));
                  fd.set.call(this, v);
                },
                configurable: true,
              });
            } catch {}
            return f;
          };
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
      await cdp.evaluate(`window.__velGains = []; window.__velTone = []`);
      await cdp.evaluate(`document.querySelector('.hit.selected').click()`);
      await new Promise((r) => setTimeout(r, 400));
      const previewed = await cdp.evaluate(`window.__velGains.slice()`);
      if (!previewed.some((v) => Math.abs(v - 0.3) < 1e-6)) {
        throw new Error(`previewing a 30% hit should build a 0.3 gain stage, saw ${JSON.stringify(previewed)}`);
      }
      // Velocity is tone as well as level: a soft hit is duller, not just
      // quieter, which is the difference between a player and a machine.
      const softTone = await cdp.evaluate(`window.__velTone.slice()`);
      if (!softTone.length) throw new Error('a soft hit should be filtered as well as attenuated, but no lowpass was built');
      if (!softTone.every((hz) => hz > 900 && hz < 18000)) {
        throw new Error(`a 30% hit should land well inside the tone range, saw ${JSON.stringify(softTone)}`);
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
      await cdp.evaluate(`window.__velGains = []; window.__velTone = []`);
      await cdp.evaluate(`document.querySelector('.hit.selected').click()`);
      await new Promise((r) => setTimeout(r, 400));
      const full = await cdp.evaluate(`window.__velGains.slice()`);
      if (full.length !== 0) throw new Error(`a full-velocity hit should add no gain stage, saw ${JSON.stringify(full)}`);
      const fullTone = await cdp.evaluate(`window.__velTone.slice()`);
      if (fullTone.length !== 0) throw new Error(`a full-velocity hit should add no tone filter either, saw ${JSON.stringify(fullTone)}`);

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
        const h = window.__savedNotes(d, id)[0];
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

    step('Drum kits: the rhythm track picks one, and it changes the sound', async () => {
      // A kit is parameters the ten schedulers read, so the check is that
      // choosing one moves numbers that actually reach the audio graph — and
      // that the song remembers it. Reuses the biquad recorder the velocity
      // step installs: kits differ in filter frequencies, which is what it
      // already records — so this step has to run *after* that one, which is
      // why it sits here rather than beside the other rhythm checks.
      await goto(APP_URL);
      await waitFor(`!!(${RHYTHM_LANE})`);
      // The rhythm track's trigger is the *last* .th-osc-trigger — rhythm
      // tracks always sort after every tonal one — and both pickers now share
      // that class, so scope by the header rather than by the class alone.
      const KIT_TRIGGER = `[...document.querySelectorAll('.track-header')]
        .filter(h => /^Kit$/.test(h.querySelector('.th-osc-section > .th-section-label')?.textContent.trim() || ''))[0]
        .querySelector('.th-osc-trigger')`;
      await waitFor(`!!(${KIT_TRIGGER})`);
      const openKitMenu = async () => {
        await cdp.evaluate(`(${KIT_TRIGGER}).click()`);
        await waitFor(`!!document.querySelector('#floating-layer .th-osc-menu')`);
      };
      await openKitMenu();
      const options = await cdp.evaluate(
        `[...document.querySelectorAll('#floating-layer .th-osc-menu button')].map(b => b.dataset.value)`);
      if (!(options.includes('retro') && options.includes('eighties') && options.includes('acoustic'))) {
        throw new Error(`expected retro/eighties/acoustic kits, got ${JSON.stringify(options)}`);
      }
      // Each kit draws its own glyph — the whole reason this is a listbox and
      // not a <select>. Three options must mean three *different* pictures,
      // and asserting the count first is what stops `every` passing on an
      // empty list.
      const kitGlyphs = await cdp.evaluate(`(() => {
        const gs = [...document.querySelectorAll('#floating-layer .th-osc-menu button svg')]
          .map(g => [...g.querySelectorAll('path')].map(p => p.getAttribute('d')).join('|'));
        return { count: gs.length, distinct: new Set(gs).size, empty: gs.filter(g => !g).length };
      })()`);
      if (kitGlyphs.count !== 3 || kitGlyphs.distinct !== 3 || kitGlyphs.empty) {
        throw new Error(`each kit needs its own glyph: ${JSON.stringify(kitGlyphs)}`);
      }
      // ...and every option still spells its name out beside the glyph.
      const named = await cdp.evaluate(
        `[...document.querySelectorAll('#floating-layer .th-osc-menu button span')].map(s => s.textContent.trim())`);
      if (named.length !== 3 || named.some((n) => !n)) {
        throw new Error(`a glyph is decoration, never the only name: ${JSON.stringify(named)}`);
      }
      const selectedKit = await cdp.evaluate(
        `document.querySelector('#floating-layer .th-osc-menu button.selected')?.dataset.value`);
      if (selectedKit !== 'retro') {
        throw new Error(`a fresh rhythm track should start on the default kit, got ${JSON.stringify(selectedKit)}`);
      }
      await cdp.evaluate(`(${KIT_TRIGGER}).click()`); // close again
      await new Promise((r) => setTimeout(r, 200));

      // Findability, not just presence. The first version of this shipped a
      // half-width dropdown captioned "Osc" on a track that has no
      // oscillator, and the control was reported as missing. It has to be
      // captioned Kit and sit in the same box, at the same width, as the
      // tonal track's waveform picker.
      const placed = await cdp.evaluate(`(() => {
        const cap = (h) => h.querySelector('.th-osc-section > .th-section-label')?.textContent.trim();
        const heads = [...document.querySelectorAll('.track-header')];
        const kitHead = heads.find(h => cap(h) === 'Kit');
        const tonal = heads.find(h => cap(h) === 'Osc');
        return {
          captions: heads.map(cap),
          kitW: Math.round(kitHead.querySelector('.th-osc-trigger').getBoundingClientRect().width),
          waveW: Math.round(tonal.querySelector('.th-osc-trigger').getBoundingClientRect().width),
        };
      })()`);
      if (!placed.captions.includes('Kit')) {
        throw new Error(`a rhythm track's picker should be captioned Kit: ${JSON.stringify(placed.captions)}`);
      }
      // Same control, same slot, same box — so now it is the same width to
      // the pixel, not merely close.
      if (placed.kitW !== placed.waveW) {
        throw new Error(`the kit picker should be the same box as the waveform picker: ${JSON.stringify(placed)}`);
      }

      // Pen *one* hit and then audition that same hit under each kit. The
      // first version of this penned a fresh hit per kit, which passed against
      // deliberately broken code: the second click landed on the cell the
      // first one filled and removed the hit instead of placing one, so the
      // two recordings differed because one of them was silence — nothing to
      // do with kits at all.
      await cdp.evaluate(`(() => {
        const lane = ${RHYTHM_LANE};
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 60, clientY: r.top + 26 }));
      })()`);
      await waitFor(`document.querySelectorAll('.hit').length === 1`);

      const auditionAndRecord = async () => {
        await cdp.evaluate(`window.__bqFreqs = []`);
        await cdp.evaluate(`document.querySelector('.hit').click()`);
        await new Promise((r) => setTimeout(r, 350));
        const hits = await cdp.evaluate(`document.querySelectorAll('.hit').length`);
        if (hits !== 1) throw new Error(`auditioning should leave the hit alone, saw ${hits}`);
        return cdp.evaluate(`window.__bqFreqs.slice()`);
      };
      const before = await auditionAndRecord();
      if (!before.length) throw new Error('auditioning a hit should build filters to record');
      await openKitMenu();
      await cdp.evaluate(`document.querySelector('#floating-layer .th-osc-menu button[data-value="eighties"]').click()`);
      await new Promise((r) => setTimeout(r, 300));
      // The trigger has to follow the choice, or the header is lying about
      // what the track sounds like.
      const shown = await cdp.evaluate(`(${KIT_TRIGGER}).querySelector('span').textContent.trim()`);
      if (shown !== 'Eighties') throw new Error(`the trigger should show the chosen kit, shows ${JSON.stringify(shown)}`);
      const after = await auditionAndRecord();
      // Same drum, so the same number of filters — what must move is the
      // values. Requiring equal length is what stops "one run made no sound"
      // from reading as "the kit changed".
      if (before.length !== after.length) {
        throw new Error(`the same drum should build the same filters either way: ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
      }
      if (JSON.stringify(before) === JSON.stringify(after)) {
        throw new Error(`switching kit should change the filters reaching the graph, both runs saw ${JSON.stringify(before)}`);
      }

      // ...and the choice belongs to the song, not to the browser. Waited for
      // rather than read once: autosave is debounced 400ms, so a plain read
      // after the 350ms this step already waits sees the *previous* draft and
      // fails on a kit map that is about to be written correctly.
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        try {
          const kit = JSON.parse(localStorage.getItem(k)).kit;
          return !!kit && Object.values(kit).includes('eighties');
        } catch { return false; }
      })()`, 4000);

      // ...and it survives the *file* path too, not only the autosave draft.
      // Those are the same payload today (both go through currentSongData()),
      // which is exactly why this is worth pinning: the one time they drifted,
      // a per-track setting was written to every file and silently dropped on
      // load, and nothing said so. Save through the app's own button, capture
      // what it hands to Blob, and feed that back through the real file input.
      await cdp.evaluate(`(() => {
        window.__savedSong = null;
        const OrigBlob = Blob;
        window.Blob = function (parts, opts) {
          if (opts && opts.type === 'application/json') window.__savedSong = String(parts[0]);
          return new OrigBlob(parts, opts);
        };
        URL.createObjectURL = () => 'blob:stub';
        URL.revokeObjectURL = () => {};
      })()`);
      await cdp.evaluate(`document.getElementById('save-file').click()`);
      await waitFor(`!!window.__savedSong`);
      const savedFile = await cdp.evaluate(`window.__savedSong`);
      const savedKit = JSON.parse(savedFile).kit;
      if (!savedKit || !Object.values(savedKit).includes('eighties')) {
        throw new Error(`Save file should carry the kit, wrote ${JSON.stringify(savedKit)}`);
      }
      // Back to a fresh page (default kit), then load that exact file.
      await goto(APP_URL);
      await waitFor(`!!(${KIT_TRIGGER})`);
      if (await cdp.evaluate(`(${KIT_TRIGGER}).querySelector('span').textContent.trim()`) !== 'Retro') {
        throw new Error('a fresh page should be back on the default kit before the load is meaningful');
      }
      await cdp.evaluate(`(() => {
        const input = document.getElementById('load-file-input');
        const f = new File([${JSON.stringify(savedFile)}], 'kit-roundtrip.json', { type: 'application/json' });
        const dt = new DataTransfer(); dt.items.add(f);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(`(${KIT_TRIGGER}) && (${KIT_TRIGGER}).querySelector('span').textContent.trim() === 'Eighties'`, 4000)
        .catch(() => { throw new Error('the saved kit should come back when the file is loaded'); });
    });

    // Sets the song's key/scale through the real controls and waits for the
    // lane to redraw, so every step below starts from a stated key rather than
    // from whatever the previous one left.
    async function setKey(root, scaleId) {
      await cdp.evaluate(`(() => {
        const r = document.getElementById('key-scale');
        r.value = ${JSON.stringify(scaleId)};
        r.dispatchEvent(new Event('change', { bubbles: true }));
        const k = document.getElementById('key-root');
        k.value = ${JSON.stringify(String(root))};
        k.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(`document.getElementById('key-root').value === ${JSON.stringify(String(root))}`);
    }

    // Keep to scale is a per-browser preference, so it survives fresh() and a
    // step that toggles it is really asserting what the *previous* step left
    // behind. Set it, don't flip it.
    async function setKeepToScale(on) {
      await cdp.evaluate(`(() => {
        const b = document.getElementById('key-snap');
        if ((b.getAttribute('aria-pressed') === 'true') !== ${on}) b.click();
      })()`);
      await waitFor(`document.getElementById('key-snap').getAttribute('aria-pressed') === ${JSON.stringify(String(on))}`);
    }

    step('Key & scale: the lane shades what is outside it, and chromatic shades nothing', async () => {
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      // Chromatic is the identity case: a song that never picked a key must
      // build exactly the class list it built before scales existed, or every
      // row would carry a marking that means nothing.
      const before = await cdp.evaluate(
        `document.querySelectorAll('.track[data-kind="pitch"] .cell.off-scale, .track[data-kind="pitch"] .cell.tonic').length`);
      if (before !== 0) throw new Error(`chromatic should mark no rows, found ${before}`);

      await setKey(0, 'major');
      // Count *rows*, not cells: seven of every twelve semitones are in a major
      // scale, so five of twelve rows shade and one of twelve is the tonic.
      // Asserting the ratio rather than a raw number keeps this independent of
      // the lane's pitch window, which changes with the notes on the track.
      const rows = await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const seen = new Map();
        for (const c of lane.querySelectorAll('.cell')) {
          const r = c.style.gridRow;
          if (seen.has(r)) continue;
          seen.set(r, c.classList.contains('tonic') ? 'tonic' : c.classList.contains('off-scale') ? 'off' : 'in');
        }
        const v = [...seen.values()];
        return { total: v.length, off: v.filter(x => x === 'off').length, tonic: v.filter(x => x === 'tonic').length };
      })()`);
      if (rows.total < 12) throw new Error(`expected at least an octave of rows, got ${rows.total}`);
      // Five of every twelve are outside a major scale, one of every twelve is
      // the tonic — allow the window's partial octave at each end.
      const octaves = rows.total / 12;
      if (Math.abs(rows.off - octaves * 5) > 5) {
        throw new Error(`a major scale should leave ~5 of every 12 rows outside it: ${JSON.stringify(rows)}`);
      }
      if (Math.abs(rows.tonic - octaves) > 1) {
        throw new Error(`exactly one row per octave is the tonic: ${JSON.stringify(rows)}`);
      }
      // The keyboard says the same thing, or the gutter and the lane disagree
      // about which notes belong to the song.
      const keys = await cdp.evaluate(`(() => {
        const g = document.querySelector('.track[data-kind="pitch"] .gutter');
        return {
          total: g.querySelectorAll('.pkey').length,
          off: g.querySelectorAll('.pkey.off-scale').length,
          tonic: g.querySelectorAll('.pkey.tonic').length,
        };
      })()`);
      if (keys.total !== rows.total || keys.off !== rows.off || keys.tonic !== rows.tonic) {
        throw new Error(`the gutter must mark the same rows as the lane: ${JSON.stringify({ rows, keys })}`);
      }

      // And the tonic follows the root — in A major the marked row is an A.
      await setKey(9, 'major');
      const tonicNames = await cdp.evaluate(`(() => {
        const g = document.querySelector('.track[data-kind="pitch"] .gutter');
        return [...g.querySelectorAll('.pkey.tonic')].map(k => k.title);
      })()`);
      if (!tonicNames.length || !tonicNames.every(n => /^A\d/.test(n))) {
        throw new Error(`in A major every tonic key should be an A, got ${JSON.stringify(tonicNames)}`);
      }
    });

    step('Key & scale: it travels with the song and resets between songs', async () => {
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await setKey(2, 'minor');
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        return d.key === 2 && d.scale === 'minor';
      })()`, 4000);
      // Loading a song that predates keys must not inherit the one on screen —
      // the same "restore, don't merge" rule the per-track maps live by, and
      // the one that let song A's settings survive into song B.
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Songs')).click()`);
      await waitFor(`document.querySelectorAll('.song-item').length > 0`);
      await cdp.evaluate(`
        const row = Array.from(document.querySelectorAll('.song-item')).find(r => r.querySelector('.song-title')?.textContent === 'Froggy Hop');
        row.querySelector('button').click();
      `);
      await waitFor(`document.querySelector('#song-name-display').textContent === 'Froggy Hop'`);
      const after = await cdp.evaluate(`({
        root: document.getElementById('key-root').value,
        scale: document.getElementById('key-scale').value,
        marked: document.querySelectorAll('.cell.off-scale').length,
      })`);
      if (after.scale !== 'chromatic' || after.root !== '0' || after.marked !== 0) {
        throw new Error(`a song with no key must load as chromatic C, got ${JSON.stringify(after)}`);
      }
    });

    step('Keep to scale: a placed note moves to the nearest scale tone, and playing is left alone', async () => {
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await setKey(0, 'major');
      await setKeepToScale(false);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      // Off: every row is placeable, so clicking each of an octave's rows
      // gives twelve distinct pitches.
      const placeOctave = () => cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect();
        for (let i = 0; i < 12; i++) {
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true,
            clientX: r.left + 40 + i * 40, clientY: r.top + 6 + i * 11 }));
        }
      })()`);
      const pitches = () => cdp.evaluate(
        `[...document.querySelectorAll('.track.active .lane .note')].map(n => n.getAttribute('aria-label').split(',')[0])`);
      await placeOctave();
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 12`);
      const free = await pitches();
      if (free.some(p => p.includes('#')) === false) {
        throw new Error(`with keep-to-scale off, clicking every row should reach the black keys: ${JSON.stringify(free)}`);
      }

      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await setKey(0, 'major');
      await setKeepToScale(true);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await placeOctave();
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length > 0`);
      const snapped = await pitches();
      // Not "no sharps" — that is true of an empty lane too. Assert that notes
      // landed AND that not one of them is outside C major.
      if (snapped.length < 6) throw new Error(`expected the clicks to place notes, got ${snapped.length}`);
      const outside = snapped.filter(p => p.includes('#'));
      if (outside.length) {
        throw new Error(`keep-to-scale should leave nothing outside C major, got ${JSON.stringify(outside)}`);
      }
      // The setting is a per-browser preference, not song content — it must not
      // ride along in the file the way the key itself does.
      // autosave() is debounced, so the draft may not exist yet — wait for it
      // rather than reading a null and blaming the feature.
      await waitFor(`!!Object.keys(localStorage).find((k) => k.includes('autosave'))`, 4000);
      const inSong = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        return JSON.parse(localStorage.getItem(k)).keepToScale;
      })()`);
      if (inSong !== undefined) throw new Error('keep-to-scale is a working preference and must stay out of the song');
    });

    step('In-key chords: the palette offers the chord this key builds on the note', async () => {
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await setKey(0, 'major');
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      // Place a D (the second degree of C major) by clicking its own key in
      // the gutter's lane row, found by name rather than by pixel arithmetic.
      await cdp.evaluate(`(() => {
        const g = document.querySelector('.track[data-kind="pitch"] .gutter');
        const keys = [...g.querySelectorAll('.pkey')];
        const d = keys.find(k => /^D4$/.test(k.title));
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect(), kr = d.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 60, clientY: kr.top + 4 }));
      })()`);
      await waitFor(`!!document.querySelector('.track.active .lane .note')`);
      await waitFor(`!!Array.from(document.querySelectorAll('.insp-cap')).find(c => c.textContent === 'Chord')`);
      await openPalette('chord');
      const inKey = await cdp.evaluate(
        `[...document.querySelectorAll('.preset-grid button.in-key')].map(b => b.textContent)`);
      // The second degree of a major scale carries a minor triad, so the label
      // has to be lower-case "ii" — upper-case would mean the qualities are
      // coming from somewhere other than the scale.
      if (inKey.join(',') !== 'ii,ii7') {
        throw new Error(`on D in C major the in-key buttons should read ii and ii7, got ${JSON.stringify(inKey)}`);
      }
      await cdp.evaluate(`document.querySelector('.preset-grid button.in-key').click()`);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 3`);
      const chord = await cdp.evaluate(
        `[...document.querySelectorAll('.track.active .lane .note')].map(n => n.getAttribute('aria-label').split(',')[0]).sort()`);
      if (chord.join(' ') !== 'A4 D4 F4') {
        throw new Error(`ii in C major is D-F-A, got ${JSON.stringify(chord)}`);
      }
      // Chromatic has no degrees, so the in-key buttons must be absent rather
      // than present and wrong.
      await setKey(0, 'chromatic');
      await cdp.evaluate(`document.querySelector('.track.active .lane .note').click()`);
      await waitFor(`!!Array.from(document.querySelectorAll('.insp-cap')).find(c => c.textContent === 'Chord')`);
      await openPalette('chord');
      const none = await cdp.evaluate(`document.querySelectorAll('.preset-grid button.in-key').length`);
      if (none !== 0) throw new Error(`chromatic has no degrees, so no in-key buttons: found ${none}`);
    });

    step('Chord progressions: written in the song key, and the same degrees follow it', async () => {
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await setKey(0, 'major');
      const openProgressions = () => cdp.evaluate(`(() => {
        const t = document.querySelector('.track[data-kind="pitch"]');
        [...t.querySelectorAll('.th-tool-btn')].find(b => /progression/i.test(b.title)).click();
      })()`);
      await openProgressions();
      await waitFor(`document.getElementById('progression-dialog').open`);
      const listed = await cdp.evaluate(
        `[...document.querySelectorAll('#progression-list .song-title')].map(t => t.textContent)`);
      if (listed.length < 5) throw new Error(`expected the built-in progressions, got ${JSON.stringify(listed)}`);
      await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('#progression-list .song-item')]
          .find(r => r.querySelector('.song-title').textContent === 'I–V–vi–IV');
        [...row.querySelectorAll('button')].find(b => b.textContent === 'Insert').click();
      })()`);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length > 0`);
      // The first bar of I-V-vi-IV in C major is a C triad: C-E-G, and every
      // note of every bar has to be inside the scale or the chords are not
      // coming from it.
      const notes = await cdp.evaluate(`(() => {
        return [...document.querySelectorAll('.track.active .lane .note')]
          .map(n => ({ label: n.getAttribute('aria-label').split(',')[0], left: parseFloat(n.style.left) }))
          .sort((a, b) => a.left - b.left || a.label.localeCompare(b.label));
      })()`);
      if (notes.some(n => n.label.includes('#'))) {
        throw new Error(`a progression in C major must contain no sharps: ${JSON.stringify(notes.slice(0, 12))}`);
      }
      const firstBar = notes.filter(n => n.left === notes[0].left).map(n => n.label.replace(/\d/, '')).sort();
      if (firstBar.join('') !== 'CEG') {
        throw new Error(`bar 1 of I–V–vi–IV in C major is C-E-G, got ${JSON.stringify(firstBar)}`);
      }
      // Same degrees, different key: in A minor the very same progression has
      // to come out as A-C-E, which is what proves the qualities are read from
      // the scale rather than stored in the table.
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await setKey(9, 'minor');
      await openProgressions();
      await waitFor(`document.getElementById('progression-dialog').open`);
      await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('#progression-list .song-item')]
          .find(r => r.querySelector('.song-title').textContent === 'I–V–vi–IV');
        [...row.querySelectorAll('button')].find(b => b.textContent === 'Insert').click();
      })()`);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length > 0`);
      const minorFirst = await cdp.evaluate(`(() => {
        const ns = [...document.querySelectorAll('.track.active .lane .note')]
          .map(n => ({ label: n.getAttribute('aria-label').split(',')[0], left: parseFloat(n.style.left) }));
        const x = Math.min(...ns.map(n => n.left));
        return ns.filter(n => n.left === x).map(n => n.label.replace(/\\d/, '')).sort();
      })()`);
      if (minorFirst.join('') !== 'ACE') {
        throw new Error(`bar 1 of the same degrees in A minor is A-C-E, got ${JSON.stringify(minorFirst)}`);
      }
    });

    step('Duplicate track: the copy carries the part and the whole voice, independently', async () => {
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect();
        for (const [dx, dy] of [[30, 30], [130, 50]]) {
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + dx, clientY: r.top + dy }));
        }
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="pitch"] .lane .note').length >= 2`);
      // Give the track a non-default voice, so "carries the whole voice" has
      // something to carry beyond the notes.
      await addFxEffect('Delay');
      await stepKnob('sendDelay', 'Delay', 'ArrowUp', 25);
      const firstTrack = `document.querySelectorAll('.track[data-kind="pitch"]')[0]`;
      const before = await cdp.evaluate(`document.querySelectorAll('.track').length`);
      await cdp.evaluate(`(${firstTrack}).querySelector('.th-dup').click()`);
      await waitFor(`document.querySelectorAll('.track').length === ${before} + 1`);
      // Directly below the original, not appended at the end.
      const names = await cdp.evaluate(`[...document.querySelectorAll('.track .th-name')].map(n => n.textContent)`);
      if (names[1] !== names[0] + ' copy') {
        throw new Error(`the copy belongs directly below its original: ${JSON.stringify(names)}`);
      }
      // Wait for the draft to *contain the copy*, not merely to exist:
      // autosave() is debounced, and an earlier step's song is still sitting
      // in that key until it fires. Waiting on the key alone read Froggy Hop's
      // 355 notes and blamed the duplication for them.
      const savedTracks = `(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return null;
        const d = JSON.parse(localStorage.getItem(k));
        const ids = d.trackList.filter(t => t.kind !== 'rhythm');
        return { d, ids: ids.map(t => t.id), names: ids.map(t => t.name) };
      })()`;
      await waitFor(`(() => { const s = ${savedTracks}; return !!s && s.names.some(n => n.endsWith(' copy')); })()`, 6000);
      const copied = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const ids = d.trackList.filter(t => t.kind !== 'rhythm').map(t => t.id);
        return {
          notes: window.__savedNotes(d, ids[0]).length,
          copyNotes: window.__savedNotes(d, ids[1]).length,
          send: (d.fxSend || {})[ids[1]],
        };
      })()`);
      if (copied.notes < 2 || copied.copyNotes !== copied.notes) {
        throw new Error(`the copy should hold the same part: ${JSON.stringify(copied)}`);
      }
      if (!copied.send || Math.abs(copied.send.delay - 0.5) > 1e-6) {
        throw new Error(`the copy should carry the track's inserts, got ${JSON.stringify(copied.send)}`);
      }
      // The two parts must be separate objects, or editing one edits both —
      // the failure that makes a "copy" worse than useless.
      await cdp.evaluate(`(() => {
        const n = document.querySelectorAll('.track[data-kind="pitch"]')[1].querySelector('.lane .note');
        n.click();
      })()`);
      await waitFor(`!!document.querySelector('.lane .note.selected')`);
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
      // Same debounce again: poll for the two parts to differ rather than
      // sleeping a guessed interval and reading once. Never diverging within
      // the timeout IS the failure this step is here to catch.
      const diverged = `(() => {
        const s = ${savedTracks};
        if (!s) return false;
        const a = window.__savedNotes(s.d, s.ids[0]).map(n => n.freq).sort().join(',');
        const b = window.__savedNotes(s.d, s.ids[1]).map(n => n.freq).sort().join(',');
        return a !== b;
      })()`;
      await waitFor(diverged, 6000).catch(() => {
        throw new Error('nudging a note in the copy also moved the original — the parts are shared, not copied');
      });
    });

    step('Transpose: scale steps move inside the key, semitones do not, and Fit repairs a take', async () => {
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await setKey(0, 'major');
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      // A C major triad, placed by finding each pitch's own key in the gutter
      // rather than by pixel arithmetic.
      const placeAt = (name, x) => cdp.evaluate(`(() => {
        const g = document.querySelector('.track[data-kind="pitch"] .gutter');
        const k = [...g.querySelectorAll('.pkey')].find(k => k.title === ${JSON.stringify(name)});
        const lane = document.querySelector('.track[data-kind="pitch"] .lane');
        const r = lane.getBoundingClientRect(), kr = k.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + ${x}, clientY: kr.top + 4 }));
      })()`);
      const pitches = () => cdp.evaluate(
        `[...document.querySelectorAll('.track.active .lane .note')].map(n => n.getAttribute('aria-label').split(',')[0]).sort()`);
      for (const [name, x] of [['C4', 30], ['E4', 30], ['G4', 30]]) await placeAt(name, x);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 3`);
      if ((await pitches()).join(' ') !== 'C4 E4 G4') {
        throw new Error(`expected a C major triad to start from, got ${JSON.stringify(await pitches())}`);
      }

      // Deselect first, or the dialog acts on the one note the pen left
      // selected — which is correct behaviour and the wrong thing to measure
      // here. With nothing selected the scope widens to the whole track.
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await waitFor(`!document.querySelector('.lane .note.selected')`);

      const openTranspose = async () => {
        await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
        await cdp.evaluate(`document.getElementById('transpose-btn').click()`);
        await waitFor(`document.getElementById('transpose-dialog').open`);
      };
      const press = (id) => cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      const close = () => cdp.evaluate(`document.getElementById('transpose-close').click()`);

      // One scale step up: C-E-G becomes D-F-A. Not C#-F-G# — that is the
      // whole difference between moving inside a key and moving off it, and
      // the intervals change (2, 1, 2 semitones) because the scale says so.
      await openTranspose();
      await press('transpose-step-up');
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 3`);
      const stepped = await pitches();
      if (stepped.join(' ') !== 'A4 D4 F4') {
        throw new Error(`one scale step up from C-E-G in C major is D-F-A, got ${JSON.stringify(stepped)}`);
      }
      // A semitone is still a semitone — the two operations must not have
      // collapsed into one.
      await press('transpose-semi-up');
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 3`);
      const semi = await pitches();
      if (semi.join(' ') !== 'A#4 D#4 F#4') {
        throw new Error(`a semitone up from D-F-A is D#-F#-A#, got ${JSON.stringify(semi)}`);
      }
      // ...and Fit puts that back inside the key, which is the repair a take
      // needs now that recording never corrects pitch on the way in.
      await press('transpose-fit');
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 3`);
      const fitted = await pitches();
      if (fitted.some(p => p.includes('#'))) {
        throw new Error(`Fit to the scale should leave nothing outside C major, got ${JSON.stringify(fitted)}`);
      }
      if (fitted.length !== 3) throw new Error(`Fit must not lose a voice: ${JSON.stringify(fitted)}`);
      await close();

      // The arrow keys use the same walk. With Keep to scale on, up is a scale
      // step; Alt is the chromatic escape hatch.
      await setKeepToScale(true);
      await cdp.evaluate(`(() => {
        const ns = [...document.querySelectorAll('.track.active .lane .note')];
        ns.sort((a, b) => parseFloat(b.style.top) - parseFloat(a.style.top));
        ns[0].click();
      })()`);
      await waitFor(`!!document.querySelector('.lane .note.selected')`);
      const selected = () => cdp.evaluate(
        `document.querySelector('.track.active .lane .note.selected').getAttribute('aria-label').split(',')[0]`);
      const midi = (n) => {
        const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const m = n.match(/^([A-G]#?)(\d)$/);
        return names.indexOf(m[1]) + (parseInt(m[2], 10) + 1) * 12;
      };
      const arrow = async (opts) => {
        await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: 'ArrowUp', bubbles: true, ...opts })}))`);
        await new Promise((r) => setTimeout(r, 200));
        return selected();
      };
      // Both presses start from the *same* note, and it is deliberately one
      // where the two answers differ: D is a whole tone below E in C major, so
      // a scale step is 2 semitones and Alt is 1. Measured from a note where
      // the scale step happens to be a semitone anyway (E, B) this step passes
      // against a build with no escape hatch at all — which is exactly what it
      // did before, and what running the injection caught.
      const low = await selected();
      if (midi(low) % 12 !== 2) throw new Error(`this step needs to start on a D, got ${low}`);
      const afterAlt = await arrow({ altKey: true });
      if (midi(afterAlt) - midi(low) !== 1) {
        throw new Error(`Alt+Up must stay chromatic: ${low} -> ${afterAlt}`);
      }
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))`);
      await new Promise((r) => setTimeout(r, 200));
      if (await selected() !== low) throw new Error('Alt+Down should come straight back');
      const afterStep = await arrow({});
      if (midi(afterStep) - midi(low) !== 2) {
        throw new Error(`a scale step from ${low} in C major is 2 semitones, landed on ${afterStep}`);
      }

      // A collision must cost a note its move, never its existence. Two notes
      // a semitone apart in the same column both want the same pitch when
      // fitted; the lower one gets it and the other stays put.
      await fresh();
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      await setKey(0, 'major');
      // Keep to scale is a per-browser preference and this step turned it on
      // above, so it survives the reload — and with it on, C#4 would snap to
      // C4 on the way in and there would be no collision to fit.
      await setKeepToScale(false);
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      for (const name of ['C4', 'C#4']) await placeAt(name, 30);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 2`);
      await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await openTranspose();
      await press('transpose-fit');
      await new Promise((r) => setTimeout(r, 300));
      const survived = await pitches();
      if (survived.length !== 2) {
        throw new Error(`fitting a colliding pair must keep both notes, got ${JSON.stringify(survived)}`);
      }
    });

    step('Overdub: recording round a loop layers laps instead of replacing them', async () => {
      await fresh();
      await waitFor(`document.querySelectorAll('.track').length === 5`);
      // A short song at a fast tempo, so two laps take seconds rather than
      // most of a minute. Both go through the real controls: the length
      // buttons and the loop's own reset, not state pokes.
      await cdp.evaluate(`(() => {
        const t = document.getElementById('tempo');
        t.value = 240; t.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await cdp.evaluate(`(() => {
        const minus = document.getElementById('len-minus');
        for (let i = 0; i < 64 && !/^2 bars/.test(document.getElementById('len-bars').textContent); i++) minus.click();
      })()`);
      await waitFor(`/^2 bars/.test(document.getElementById('len-bars').textContent)`);
      await cdp.evaluate(`document.getElementById('loop-reset').click()`);
      await cdp.evaluate(`(() => {
        const l = document.getElementById('loop');
        if (!l.checked) l.click();
      })()`);
      await waitFor(`document.getElementById('loop').checked`);

      const armBass = `(() => {
        const t = [...document.querySelectorAll('.track')].find((t) => (t.querySelector('.th-name') || {}).textContent === 'Bass');
        [...t.querySelectorAll('.th-btns button')].find((b) => b.textContent === 'R').click();
      })()`;
      await cdp.evaluate(armBass);
      await waitFor(`document.querySelectorAll('.th-btns button.r.on').length === 1`);
      const key = (code, type) => cdp.evaluate(
        `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { code: ${JSON.stringify(code)}, bubbles: true }))`);
      const bassNotes = () => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return [];
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find((t) => t.name === 'Bass') || {}).id;
        return window.__savedNotes(d, id);
      })()`);

      await cdp.evaluate(`document.getElementById('record-btn').click()`);
      await waitFor(`document.body.classList.contains('playing')`, 8000);
      // Lap one: one pitch. Then wait out the rest of the lap and play a
      // *different* pitch on lap two — different, so a lap that wiped the
      // previous one is visible as a missing note rather than as a tie.
      await key('KeyZ', 'keydown');
      await new Promise((r) => setTimeout(r, 200));
      await key('KeyZ', 'keyup');
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find((t) => t.name === 'Bass') || {}).id;
        return window.__savedNotes(d, id).length === 1;
      })()`, 6000);
      const lapOne = (await bassNotes()).map((n) => n.freq);

      // Wait for the playhead to wrap — the transport must still be rolling,
      // which is the half of "overdub" that is about the recorder not
      // stopping at the loop's end.
      const headLeft = () => cdp.evaluate(`parseFloat(document.querySelector('.playhead').style.left)`);
      const before = await headLeft();
      await waitFor(`parseFloat(document.querySelector('.playhead').style.left) < ${before}`, 8000)
        .catch(() => { throw new Error('the transport should keep rolling round the loop while recording'); });
      if (!await cdp.evaluate(`document.body.classList.contains('playing')`)) {
        throw new Error('recording stopped at the end of the loop instead of going round');
      }
      await key('KeyX', 'keydown');
      await new Promise((r) => setTimeout(r, 200));
      await key('KeyX', 'keyup');
      await new Promise((r) => setTimeout(r, 400));

      // A key held *across* the seam. Its keyup lands on a column earlier than
      // its keydown, so the raw difference is negative — which used to be
      // floored to a single grid step, filing a note held through a lap down
      // to a stab. Press in the last quarter of the lap, release after the
      // wrap, and require a length longer than one step.
      const lanePx = await cdp.evaluate(`document.querySelector('.lane').getBoundingClientRect().width`);
      await waitFor(`parseFloat(document.querySelector('.playhead').style.left) > ${lanePx * 0.7}`, 8000);
      await key('KeyC', 'keydown');
      const heldAt = await headLeft();
      await waitFor(`parseFloat(document.querySelector('.playhead').style.left) < ${heldAt}`, 8000);
      await new Promise((r) => setTimeout(r, 120));
      await key('KeyC', 'keyup');
      await new Promise((r) => setTimeout(r, 400));
      await cdp.evaluate(`document.getElementById('stop').click()`);
      await new Promise((r) => setTimeout(r, 600));

      const items = await bassNotes();
      const after = items.map((n) => n.freq);
      if (after.length < 2) {
        throw new Error(`lap two should add to lap one, not replace it: ${JSON.stringify({ lapOne, after })}`);
      }
      if (!lapOne.every((f) => after.includes(f))) {
        throw new Error(`lap one's note must survive lap two: ${JSON.stringify({ lapOne, after })}`);
      }
      if (new Set(after).size < 3) {
        throw new Error(`three laps played three different pitches, so all three should be there: ${JSON.stringify(after)}`);
      }
      const grid = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        return JSON.parse(localStorage.getItem(k)).grid;
      })()`);
      const held = items.reduce((a, b) => (b.len > a.len ? b : a), items[0]);
      if (held.len <= grid) {
        throw new Error(`a note held across the loop's seam must outlast one grid step: ${JSON.stringify(items)}`);
      }
    });

    step('Dynamics: velocity is shaped without moving a note, and full stays absent', async () => {
      await fresh();
      await waitFor(`document.querySelectorAll('.track').length === 5`);
      // Stamp in a groove, which is exactly the case this exists for: every
      // hit lands at the pattern's own level and the part reads as a machine.
      await cdp.evaluate(`(() => {
        const t = [...document.querySelectorAll('.track')].find(t => t.dataset.kind === 'rhythm');
        [...t.querySelectorAll('.th-tool-btn')].find(b => /pattern/i.test(b.title)).click();
      })()`);
      await waitFor(`document.getElementById('pattern-dialog').open`);
      await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('#pattern-list .song-item')]
          .find(r => r.querySelector('.song-title').textContent === 'Rock');
        [...row.querySelectorAll('button')].find(b => b.textContent === 'Insert').click();
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length > 8`);

      const hits = () => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return null;
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind === 'rhythm').id;
        return window.__savedNotes(d, id).map(h => ({ start: h.start, type: h.type, vel: h.vel }));
      })()`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find((k) => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind === 'rhythm').id;
        return window.__savedNotes(d, id).length > 8;
      })()`, 6000);
      const before = await hits();

      const openDynamics = async () => {
        await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
        await cdp.evaluate(`document.getElementById('dynamics-btn').click()`);
        await waitFor(`document.getElementById('dynamics-dialog').open`);
      };
      await openDynamics();
      await cdp.evaluate(`document.getElementById('dynamics-vary').click()`);
      await new Promise((r) => setTimeout(r, 600));
      const after = await hits();

      // Nothing may move. This is the promise the dialog makes in so many
      // words, and the one that makes pressing it cheap.
      const place = (l) => l.map(h => `${h.start}:${h.type}`).sort().join(',');
      if (place(after) !== place(before)) {
        throw new Error('Vary must not move a hit or change what it is — only how hard it lands');
      }
      // Something must actually change, or the button is a decoration.
      const levels = (l) => l.map(h => (h.vel == null ? 1 : h.vel)).join(',');
      if (levels(after) === levels(before)) {
        throw new Error('Vary changed no velocity at all');
      }
      // It must be a *reroll*, not one offset applied to everything. Two
      // presses giving different results proves nothing — a fixed subtraction
      // does that too, which is what running that injection showed. What
      // separates them is whether the items moved by different amounts.
      const vel = (h) => (h.vel == null ? 1 : h.vel);
      const deltas = after.map((h, i) => Math.round((vel(h) - vel(before[i])) * 100));
      if (new Set(deltas).size < 3) {
        throw new Error(`Vary must move items by different amounts, saw ${JSON.stringify([...new Set(deltas)])}`);
      }
      await cdp.evaluate(`document.getElementById('dynamics-vary').click()`);
      await new Promise((r) => setTimeout(r, 600));
      const third = await hits();
      if (place(third) !== place(before)) throw new Error('Vary moved a hit on the second press');

      // Accent reads the meter. Compare each hit against *itself* rather than
      // on-beat against off-beat: a groove already lands harder on the beat,
      // so an accent that had the test backwards still left the on-beat hits
      // louder in absolute terms and the step passed. What it cannot fake is
      // the direction each hit moved.
      const preAccent = await hits();
      await cdp.evaluate(`document.getElementById('dynamics-accent').click()`);
      await new Promise((r) => setTimeout(r, 600));
      const accented = await hits();
      const beat = 2; // eighths per beat at 4/4
      let raised = 0, lowered = 0;
      accented.forEach((h, i) => {
        const d = vel(h) - vel(preAccent[i]);
        const onBeat = h.start % beat === 0;
        if (onBeat && d < -1e-9) throw new Error(`an on-beat hit got quieter: ${JSON.stringify(h)}`);
        if (!onBeat && d > 1e-9) throw new Error(`an off-beat hit got louder: ${JSON.stringify(h)}`);
        if (onBeat && d > 1e-9) raised++;
        if (!onBeat && d < -1e-9) lowered++;
      });
      if (!raised || !lowered) {
        throw new Error(`accenting should raise on-beat hits and lower the others, raised ${raised} lowered ${lowered}`);
      }
      // Full velocity is stored as absent everywhere else, and this must not
      // be the one place that writes 1 onto every item.
      if (accented.some(h => h.vel === 1)) {
        throw new Error('a full-velocity hit must serialise as absent, not as vel: 1');
      }
    });

    step('PWM: every note gives back its tap on the shared sweep, so the graph does not grow', async () => {
      await fresh();
      // The shared sweep LFO outlives every note, so a note's tap on it has to
      // come off when the note ends. It did not: the disconnect took the wrong
      // end of the connection (`width.disconnect()` drops width's own output,
      // not the LFO's), so every pwm note left its tap in place and kept the
      // width node alive with it. The graph grew by two nodes per note for as
      // long as the page was open and the sweep had to feed all of them every
      // render quantum — audible as rasping and stuttering a minute into a
      // pwm-heavy song, and invisible in an offline render, which computes
      // every sample however long it takes.
      //
      // Counting connections is the only way to see this: the DOM says
      // nothing, and the audio is correct until the CPU gives out.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            const live = new Map();
            const oc = AudioNode.prototype.connect, od = AudioNode.prototype.disconnect;
            AudioNode.prototype.connect = function (...a) {
              live.set(this, (live.get(this) || 0) + 1);
              return oc.apply(this, a);
            };
            AudioNode.prototype.disconnect = function (...a) {
              const had = live.get(this) || 0;
              live.set(this, Math.max(0, had - (a.length ? 1 : had)));
              return od.apply(this, a);
            };
            // The busiest oscillator's outstanding fan-out. The sweep LFO is
            // the only oscillator anything else connects to repeatedly.
            window.__maxOscFanOut = () => {
              let m = 0;
              for (const [n, c] of live) if (n instanceof OscillatorNode && c > m) m = c;
              return m;
            };
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('#file-menu-toggle')`);
      // A bundled song whose lead is a pwm part — 193 notes of it.
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.includes('Songs')).click()`);
      await waitFor(`document.querySelectorAll('.song-item').length > 0`);
      await cdp.evaluate(`
        const row = Array.from(document.querySelectorAll('.song-item')).find(r => r.querySelector('.song-title')?.textContent === 'The Fitting Bay');
        row.querySelector('button').click();
      `);
      await waitFor(`document.querySelector('#song-name-display').textContent === 'The Fitting Bay'`);
      await cdp.evaluate(`document.getElementById('play').click()`);
      await waitFor(`document.body.classList.contains('playing')`, 8000);

      // Sample across more than one scheduling chunk. The *peak* proves
      // nothing — a chunk legitimately holds a lookahead's worth of taps at
      // once, leaked or not. What separates them is whether the count ever
      // comes back down: released taps return to nearly nothing between
      // chunks, a leak only ever climbs.
      const samples = [];
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        samples.push(await cdp.evaluate(`window.__maxOscFanOut()`));
      }
      await cdp.evaluate(`document.getElementById('stop').click()`);
      const peak = Math.max(...samples);
      const floor = Math.min(...samples);
      if (peak < 5) {
        throw new Error(`this step is only meaningful while pwm notes are sounding, saw ${JSON.stringify(samples)}`);
      }
      if (floor > 5) {
        throw new Error(
          `taps on the shared sweep are never released — the fan-out only climbs ` +
          `(low ${floor}, high ${peak}): ${JSON.stringify(samples)}`);
      }
      // And the last word must not be the high-water mark: a leak's final
      // sample is its largest.
      if (samples[samples.length - 1] >= peak) {
        throw new Error(`the fan-out ended at its maximum, which is what a leak looks like: ${JSON.stringify(samples)}`);
      }
    });

    step('Seeking takes back what was scheduled, instead of layering it under the new position', async () => {
      await fresh();
      // Playback commits SCHEDULE_LOOKAHEAD_BARS of notes to the graph with
      // future start times. Seeking used to start a new chunk without taking
      // those back, so the old position kept playing underneath the new one —
      // eight bars of it, and dragging the ruler could stack several layers.
      //
      // Measured as the user hears it rather than as the code does it: put
      // notes at the very start, play them, then seek to an empty stretch. If
      // what was scheduled has been taken back the output is silent; if it is
      // still playing, it is not. A tap on the destination is the only way to
      // ask — the DOM cannot tell you what is still sounding.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            let tap = null;
            const oc = AudioNode.prototype.connect;
            AudioNode.prototype.connect = function (dest, ...rest) {
              const r = oc.call(this, dest, ...rest);
              try {
                const c = this.context;
                if (c && dest === c.destination && !(c instanceof OfflineAudioContext)) {
                  if (!tap || tap.context !== c) {
                    tap = c.createAnalyser();
                    tap.fftSize = 2048;
                  }
                  oc.call(this, tap);
                }
              } catch { /* not tappable */ }
              return r;
            };
            window.__level = () => {
              if (!tap) return -1;
              const buf = new Float32Array(tap.fftSize);
              tap.getFloatTimeDomainData(buf);
              let sum = 0;
              for (const v of buf) sum += v * v;
              return Math.sqrt(sum / buf.length);
            };
          })();
        `,
      });
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-trigger')`);
      // Drum hits, spread across the first bars — and drums specifically.
      // Two earlier versions of this step proved nothing: one put a chord at
      // bar 1, which had finished sounding before the seek, so both builds
      // were silent; the other used tonal notes, which go through the voice
      // pool, and the *new* generation stealing a pooled voice re-envelopes
      // its gain and silences the old note as a side effect. Drums are never
      // pooled, so nothing masks a hit that was scheduled and not taken back.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      // Query .lane fresh before *every* click rather than once outside the
      // loop: onRhythmCellClick() re-renders on each hit, which replaces the
      // .lane element entirely, so a cached reference goes stale (detached
      // from the document) after the first click. A click dispatched on a
      // detached node still fires its listener, but that listener's own
      // getBoundingClientRect() then reads all-zero, so every column after
      // the first was computed against clientX alone with nothing subtracted
      // — the 30 hits landed at column 0 and then ~21..49 instead of 0..29,
      // reaching all the way into the "empty" stretch this step seeks into
      // and making the step measure a real, newly-scheduled hit rather than
      // anything left over from before the seek.
      await cdp.evaluate(`(() => {
        for (let i = 0; i < 30; i++) {
          const lane = document.querySelector('.track[data-kind="rhythm"] .lane');
          const r = lane.getBoundingClientRect();
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true,
            clientX: r.left + 4 + i * 16, clientY: r.top + 8 }));
        }
      })()`);
      // One click per column: the lane is 16px a column here, so a tighter
      // spacing would land two clicks in one and replace rather than add.
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length >= 25`);
      // And confirm they actually landed where intended: the step's "empty
      // stretch" assumption is only true if every hit stayed in the first
      // few bars, which is exactly what the stale-lane bug above defeated.
      const hitCols = await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit')].map(h => parseFloat(h.style.left) / 16))`);
      const maxCol = Math.max(...JSON.parse(hitCols));
      if (!(maxCol < 40)) {
        throw new Error(`hits should stay within the first bars, not reach the "empty" stretch this step seeks into: max column ${maxCol}`);
      }
      await cdp.evaluate(`document.getElementById('play').click()`);
      await waitFor(`document.body.classList.contains('playing')`, 8000);

      // Peak over a window, not one instantaneous reading: a part has gaps
      // between its notes, and a single sample can land in one.
      const peakLevel = async (ms) => {
        let peak = 0;
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const v = await cdp.evaluate(`window.__level()`);
          if (v > peak) peak = v;
          await new Promise((r) => setTimeout(r, 25));
        }
        return peak;
      };
      const sounding = await peakLevel(900);
      if (!(sounding > 0.005)) {
        throw new Error(`the part should be audible before the seek, peak ${sounding}`);
      }

      // Seek far ahead, into the empty stretch, through the ruler itself.
      await cdp.evaluate(`(() => {
        const cells = [...document.querySelectorAll('.ruler-cell')];
        const cell = cells[Math.floor(cells.length * 0.75)];
        const r = cell.getBoundingClientRect();
        cell.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, pointerId: 7, clientX: r.left + 1, clientY: r.top + 6 }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerId: 7, clientX: r.left + 1, clientY: r.top + 6 }));
      })()`);
      // Past the 10ms fade and any release tail, and well inside the eight bars
      // the old generation would otherwise have kept playing.
      // A step that did not actually seek proves nothing, so say so outright.
      const moved = await cdp.evaluate(`parseFloat(document.querySelector('.playhead').style.left)`);
      if (!(moved > 600)) throw new Error(`the seek did not move the playhead: ${moved}px`);
      await new Promise((r) => setTimeout(r, 250));
      const after = await peakLevel(900);
      await cdp.evaluate(`document.getElementById('stop').click()`);
      if (after > 0.002) {
        throw new Error(
          `after seeking into an empty stretch the output should be silent, ` +
          `but it is still playing what was scheduled before the seek (level ${after} vs ${sounding} before)`);
      }
    });

    step('Clips: every track draws its clip as a block, and the block does not eat the lane', async () => {
      await fresh();
      // Phase 2 of the clip model (TODO.md): the block is a read-only view of
      // where a clip begins and ends. Every track currently holds exactly one
      // clip spanning the song, so the assertion is one block per lane at the
      // full width — a second block would mean clipsOf() invented one, and a
      // short one would mean clipEnd() lost the unbounded case.
      const blocks = await cdp.evaluate(`JSON.stringify(
        [...document.querySelectorAll('.track[data-kind] .lane')].map(l => ({
          kind: l.closest('.track').dataset.kind,
          clips: l.querySelectorAll('.clip').length,
          // offsetWidth, not style.width: a .lane is a CSS grid sized by its
          // template columns and carries no inline width to read.
          spans: [...l.querySelectorAll('.clip')].map(c =>
            Math.round(parseFloat(c.style.width) / l.offsetWidth * 100)),
        })))`);
      const rows = JSON.parse(blocks);
      if (rows.length < 5) throw new Error(`expected the starter layout's lanes, got ${rows.length}`);
      // Assert the count and the values, not a property over the list: .every()
      // is true of an empty list, so "all blocks are full width" would pass on
      // a build that drew no blocks at all.
      const wrong = rows.filter(r => r.clips !== 1);
      if (wrong.length) throw new Error(`every lane should draw exactly one clip block, got ${JSON.stringify(rows)}`);
      const short = rows.filter(r => r.spans[0] < 99);
      if (short.length) throw new Error(`an unbounded clip should span the whole lane, got ${JSON.stringify(rows)}`);

      // The part that actually matters. The block covers the entire lane, so
      // if it took pointer events every placement in the app would land on it
      // instead of on the grid.
      //
      // Asked through elementFromPoint rather than by dispatching a click:
      // a synthetic MouseEvent aimed at .lane is delivered to that element's
      // listener directly, with no hit-testing on the way, so it lands exactly
      // the same whether the block swallows pointer events or not. That first
      // version of this assertion passed against a build with pointer-events
      // deliberately removed — a step aimed at code it never reaches, which is
      // the failure mode this file's own notes call out. elementFromPoint does
      // the real hit test.
      const onTop = await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="rhythm"] .lane');
        // Into view first. The rhythm track is the fifth row, ~1170px down,
        // and the headless viewport is 600px tall — elementFromPoint takes
        // *viewport* coordinates, so without this it is asked about a point
        // below the fold and answers with nothing at all. That is how the
        // first version of this assertion passed against a build with
        // pointer-events deliberately removed: it was not testing a wrong
        // thing, it was testing nothing.
        lane.closest('.track').scrollIntoView({ block: 'center' });
        const r = lane.getBoundingClientRect();
        // Down the middle of the lane, not near its top edge: the toolbar is
        // sticky and covers the first ~100px of the scrollport, so a point at
        // r.top + 8 hits the toolbar and answers the wrong question — which is
        // the second way this one assertion managed to test nothing.
        const stack = document.elementsFromPoint(r.left + 4 * 16 + 4, r.top + r.height / 2);
        return JSON.stringify(stack.slice(0, 4).map(e => e.className || e.tagName));
      })()`);
      const stack = JSON.parse(onTop);
      // Both guards are load-bearing, and both are here because the assertion
      // silently passed without them: an empty stack (point off-viewport) and
      // a stack that never reaches the lane (point over the toolbar) each read
      // as "the block did not take the click" while proving nothing at all.
      if (!stack.length) throw new Error('the hit test found nothing — the point was off-viewport, so this proves nothing');
      if (!stack.some(c => /\blane\b/.test(c))) {
        throw new Error(`the hit test never reached the lane, so it proves nothing: ${onTop}`);
      }
      if (/\bclip\b/.test(stack[0])) {
        throw new Error(`the clip block must not take pointer events — a point over the lane hit '${stack[0]}' (stack ${onTop})`);
      }
      // ...and the lane still resolves a placement at the clicked column.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="rhythm"] .lane');
        const r = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true,
          clientX: r.left + 4 * 16 + 4, clientY: r.top + 8 }));
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 1`);
      const at = await cdp.evaluate(
        `parseFloat(document.querySelector('.track[data-kind="rhythm"] .lane .hit').style.left) / 16`);
      if (Math.abs(at - 4) > 1e-6) {
        throw new Error(`a click over the clip block should still place at the clicked column 4, landed at ${at}`);
      }
      // And it must sit behind the notes, or a part would be drawn over by its
      // own container.
      const order = await cdp.evaluate(`(() => {
        const lane = document.querySelector('.track[data-kind="rhythm"] .lane');
        const z = (sel) => getComputedStyle(lane.querySelector(sel)).zIndex;
        return JSON.stringify({ clip: z('.clip'), hit: z('.hit') });
      })()`);
      const { clip, hit } = JSON.parse(order);
      if (!(Number(clip) < Number(hit))) {
        throw new Error(`the clip block must draw behind the part it holds, got ${order}`);
      }
    });

    step('Clips: splitting cuts the window in two and keeps the whole part on both sides', async () => {
      await fresh();
      // Phase 3. The interesting claim is not that two blocks appear — it is
      // that a split is a *window* operation: each half keeps the entire
      // content and merely shows its own part of it. That is what makes the
      // trim in phase 4 able to give material back, so it is asserted here
      // rather than left until the feature that depends on it.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      // Six hits, one per column from 0..5 — re-querying the lane each time,
      // since placing one re-renders and replaces the element.
      await cdp.evaluate(`(() => {
        for (let i = 0; i < 6; i++) {
          const lane = document.querySelector('.track[data-kind="rhythm"] .lane');
          const r = lane.getBoundingClientRect();
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true,
            clientX: r.left + 4 + i * 16, clientY: r.top + 8 }));
        }
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 6`);
      // Activate the rhythm track and put the playhead in the middle of them.
      await cdp.evaluate(`document.querySelector('.track[data-kind="rhythm"] .th-name').click()`);
      await cdp.evaluate(`(() => {
        const cells = [...document.querySelectorAll('.ruler-cell')];
        const r = cells[3].getBoundingClientRect();
        cells[3].dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, pointerId: 3, clientX: r.left + 1, clientY: r.top + 6 }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerId: 3, clientX: r.left + 1, clientY: r.top + 6 }));
      })()`);
      await cdp.evaluate(`document.getElementById('file-menu-toggle').click()`);
      await cdp.evaluate(`document.getElementById('split-clip-btn').click()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip').length === 2`);
      // autosave() is debounced, so wait for the draft to carry the split
      // rather than reading it the instant the DOM shows two blocks.
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const t = d && d.trackList && d.trackList.find(t => t.kind === 'rhythm');
        return !!t && (d.tracks[t.id] || []).length === 2;
      })()`);

      // The saved song is the honest place to look: what the windows show
      // must be unchanged (all six hits, same columns), while each clip must
      // still be holding all six in its own content.
      const shape = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind === 'rhythm').id;
        const clips = d.tracks[id];
        return JSON.stringify({
          clips: clips.map(c => ({ start: c.start, len: c.len, held: c.notes.length })),
          sameSource: new Set(clips.map(c => c.source)).size === 1,
          visible: window.__savedNotes(d, id).map(n => n.start).sort((a, b) => a - b),
        });
      })()`);
      const s = JSON.parse(shape);
      if (s.clips.length !== 2) throw new Error(`a split should leave two clips, got ${shape}`);
      // Windows meet exactly at the cut, and the right half's offset has moved
      // into the content by as much as the left half is long.
      const [l, r] = s.clips;
      if (!(l.start === 0 && l.len === 3)) throw new Error(`left window wrong: ${shape}`);
      if (!(r.start === 3)) throw new Error(`right window wrong: ${shape}`);
      if (!s.sameSource) throw new Error(`both halves came from one clip and must share its source: ${shape}`);
      // The claim that matters: neither half threw material away.
      if (!(l.held === 6 && r.held === 6)) {
        throw new Error(`each half must keep the whole part so a trim can give it back, got ${shape}`);
      }
      // ...and yet nothing changed about what is heard or drawn.
      if (JSON.stringify(s.visible) !== JSON.stringify([0, 1, 2, 3, 4, 5])) {
        throw new Error(`splitting must not change what the windows show, got ${shape}`);
      }
      const drawn = await cdp.evaluate(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length`);
      if (drawn !== 6) throw new Error(`splitting must not change the drawn part, got ${drawn} hits`);
    });

    step('Clips: an edit after a split keeps what the other window hides', async () => {
      await fresh();
      // The trap phase 1's setTrackNotes() walked straight into: `items` comes
      // from trackNotes(), which returns only what the windows *show*, so
      // emptying every clip before refiling would silently drop everything
      // they hide. With one unbounded clip nothing was hidden and it could not
      // bite; the moment a split creates a second window it destroys exactly
      // the material trimming is supposed to be able to give back.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        for (let i = 0; i < 6; i++) {
          const lane = document.querySelector('.track[data-kind="rhythm"] .lane');
          const r = lane.getBoundingClientRect();
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true,
            clientX: r.left + 4 + i * 16, clientY: r.top + 8 }));
        }
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 6`);
      await cdp.evaluate(`document.querySelector('.track[data-kind="rhythm"] .th-name').click()`);
      await cdp.evaluate(`(() => {
        const cells = [...document.querySelectorAll('.ruler-cell')];
        const r = cells[3].getBoundingClientRect();
        cells[3].dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, pointerId: 3, clientX: r.left + 1, clientY: r.top + 6 }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerId: 3, clientX: r.left + 1, clientY: r.top + 6 }));
      })()`);
      await cdp.evaluate(`document.getElementById('file-menu-toggle').click()`);
      await cdp.evaluate(`document.getElementById('split-clip-btn').click()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip').length === 2`);

      // Now edit: erase one visible hit, which routes through setTrackNotes().
      await cdp.evaluate(`document.querySelector('[data-tool="eraser"]').click()`);
      // Picking the tool re-renders and replaces the hit elements, so query
      // them after it — and use .click(), the pattern the other erase steps
      // use, rather than a hand-built MouseEvent.
      await new Promise((r) => setTimeout(r, 150));
      await cdp.evaluate(`(() => {
        const hits = [...document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit')];
        hits.sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
        hits[0].click();
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 5`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const t = d && d.trackList && d.trackList.find(t => t.kind === 'rhythm');
        return !!t && window.__savedNotes(d, t.id).length === 5;
      })()`);

      const after = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind === 'rhythm').id;
        return JSON.stringify({
          held: d.tracks[id].map(c => c.notes.length),
          visible: window.__savedNotes(d, id).map(n => n.start).sort((a, b) => a - b),
        });
      })()`);
      const a = JSON.parse(after);
      if (JSON.stringify(a.visible) !== JSON.stringify([1, 2, 3, 4, 5])) {
        throw new Error(`erasing one visible hit should leave the other five, got ${after}`);
      }
      // The right clip hides columns 0-2 and must still be holding them: it
      // was not edited, so an edit on its neighbour must not have cost it
      // anything. Five in the left (it lost the erased one), six in the right.
      if (JSON.stringify(a.held) !== JSON.stringify([5, 6])) {
        throw new Error(`an edit must only replace what a window shows, not what it hides, got ${after}`);
      }
    });

    step('Clips: trimming an edge hides material without destroying it, and pulling it back returns it', async () => {
      await fresh();
      // Phase 4, and the whole reason the clip model exists. A trim must move
      // the *window*: what it hides has to stop drawing and stop sounding, the
      // material has to survive in the file, and dragging the edge back out
      // has to bring exactly it back. Anything less is "a group of notes you
      // can drag" wearing this feature's name.
      const sixHits = async () => {
        await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
        await cdp.evaluate(`(() => {
          for (let i = 0; i < 6; i++) {
            const lane = document.querySelector('.track[data-kind="rhythm"] .lane');
            const r = lane.getBoundingClientRect();
            lane.dispatchEvent(new MouseEvent('click', { bubbles: true,
              clientX: r.left + 4 + i * 16, clientY: r.top + 8 }));
          }
        })()`);
        await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 6`);
      };
      const drawnCols = () => cdp.evaluate(
        `JSON.stringify([...document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit')]
           .map(h => parseFloat(h.style.left) / 16).sort((a, b) => a - b))`);
      // Drags the right edge of the first clip by `cols` columns (negative
      // pulls it in, positive pushes it back out).
      const dragEnd = async (cols, pointerId) => cdp.evaluate(`(() => {
        const edge = document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip')[0]
          .querySelector('.clip-edge.end');
        const r = edge.getBoundingClientRect();
        const x = r.left + 3, y = r.top + 10;
        edge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: ${pointerId}, clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: ${pointerId}, clientX: x + ${cols} * 16, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${pointerId}, clientX: x + ${cols} * 16, clientY: y }));
      })()`);

      await sixHits();
      // A lone clip covering the whole track offers no edges: there is nothing
      // to reveal by trimming it and its edges are the song's own.
      const edgesBefore = await cdp.evaluate(
        `document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip-edge').length`);
      if (edgesBefore !== 0) throw new Error(`a single whole-track clip should offer no trim edges, got ${edgesBefore}`);

      await cdp.evaluate(`document.querySelector('.track[data-kind="rhythm"] .th-name').click()`);
      await cdp.evaluate(`(() => {
        const cells = [...document.querySelectorAll('.ruler-cell')];
        const r = cells[3].getBoundingClientRect();
        cells[3].dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, pointerId: 3, clientX: r.left + 1, clientY: r.top + 6 }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerId: 3, clientX: r.left + 1, clientY: r.top + 6 }));
      })()`);
      await cdp.evaluate(`document.getElementById('file-menu-toggle').click()`);
      await cdp.evaluate(`document.getElementById('split-clip-btn').click()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip').length === 2`);
      if (JSON.parse(await drawnCols()).length !== 6) throw new Error('the split itself should change nothing that is drawn');

      // Pull the left clip's right edge in by two columns.
      await dragEnd(-2, 9);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 4`);
      const hidden = JSON.parse(await drawnCols());
      if (JSON.stringify(hidden) !== JSON.stringify([0, 3, 4, 5])) {
        throw new Error(`trimming should hide exactly the items past the new edge, drawn ${JSON.stringify(hidden)}`);
      }
      // The material must still be in the file — that is the difference
      // between hiding and deleting, and it is invisible from the DOM.
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const t = d && d.trackList && d.trackList.find(t => t.kind === 'rhythm');
        return !!t && (d.tracks[t.id] || []).length === 2 && d.tracks[t.id][0].len === 1;
      })()`);
      const kept = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind === 'rhythm').id;
        return JSON.stringify({
          held: d.tracks[id].map(c => c.notes.length),
          visible: window.__savedNotes(d, id).map(n => n.start).sort((a, b) => a - b),
        });
      })()`);
      const k = JSON.parse(kept);
      if (JSON.stringify(k.held) !== JSON.stringify([6, 6])) {
        throw new Error(`a trim must hide material, not delete it — the clips hold ${kept}`);
      }
      if (JSON.stringify(k.visible) !== JSON.stringify([0, 3, 4, 5])) {
        throw new Error(`what sounds must match what is drawn, got ${kept}`);
      }

      // ...and the edge back out returns exactly what it hid.
      await dragEnd(2, 11);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 6`);
      const back = JSON.parse(await drawnCols());
      if (JSON.stringify(back) !== JSON.stringify([0, 1, 2, 3, 4, 5])) {
        throw new Error(`pulling the edge back out must return what it hid, drawn ${JSON.stringify(back)}`);
      }

      // Clips do not overlap on a track, so an edge stops at its neighbour.
      // Asserted with a drag far past it, because the two drags above stay
      // inside the clip's own room and never reach the clamp at all — a first
      // version of this step left the rule uncovered without looking like it.
      await dragEnd(10, 13);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const t = d && d.trackList && d.trackList.find(t => t.kind === 'rhythm');
        return !!t && d.tracks[t.id].length === 2;
      })()`);
      const clamped = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind === 'rhythm').id;
        return JSON.stringify(d.tracks[id].map(c => ({ start: c.start, len: c.len })));
      })()`);
      const [first, second] = JSON.parse(clamped);
      if (first.start + first.len > second.start) {
        throw new Error(`an edge must stop at its neighbour rather than overlap it, got ${clamped}`);
      }
      // Nothing doubled: an overlap would have drawn the same column twice.
      const afterClamp = JSON.parse(await drawnCols());
      if (JSON.stringify(afterClamp) !== JSON.stringify([0, 1, 2, 3, 4, 5])) {
        throw new Error(`clamping at the neighbour must leave the part as it was, drawn ${JSON.stringify(afterClamp)}`);
      }
    });

    step('Clips: moving one takes its material with it, hidden material included', async () => {
      await fresh();
      // Phase 5. The claim worth asserting is not that the block slides — it is
      // that what the window *hides* slides by the same amount. That is what
      // keeps window and contents in the same relationship, so a trim after a
      // move still reveals what sat beyond that edge rather than whatever now
      // happens to lie at those columns. It is invisible from the DOM, so the
      // saved song is where it has to be checked.
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`(() => {
        for (let i = 0; i < 6; i++) {
          const lane = document.querySelector('.track[data-kind="rhythm"] .lane');
          const r = lane.getBoundingClientRect();
          lane.dispatchEvent(new MouseEvent('click', { bubbles: true,
            clientX: r.left + 4 + i * 16, clientY: r.top + 8 }));
        }
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 6`);

      const gripsBefore = await cdp.evaluate(
        `document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip-grip').length`);
      if (gripsBefore !== 0) throw new Error(`a lone whole-track clip has nowhere to move, so it offers no grip; got ${gripsBefore}`);

      await cdp.evaluate(`document.querySelector('.track[data-kind="rhythm"] .th-name').click()`);
      await cdp.evaluate(`(() => {
        const cells = [...document.querySelectorAll('.ruler-cell')];
        const r = cells[3].getBoundingClientRect();
        cells[3].dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, pointerId: 3, clientX: r.left + 1, clientY: r.top + 6 }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerId: 3, clientX: r.left + 1, clientY: r.top + 6 }));
      })()`);
      await cdp.evaluate(`document.getElementById('file-menu-toggle').click()`);
      await cdp.evaluate(`document.getElementById('split-clip-btn').click()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip').length === 2`);

      const dragGrip = async (which, cols, pointerId) => cdp.evaluate(`(() => {
        const grip = document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip')[${which}]
          .querySelector('.clip-grip');
        const r = grip.getBoundingClientRect();
        const x = r.left + 10, y = r.top + 3;
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: ${pointerId}, clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: ${pointerId}, clientX: x + ${cols} * 16, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${pointerId}, clientX: x + ${cols} * 16, clientY: y }));
      })()`);
      const drawnCols = () => cdp.evaluate(
        `JSON.stringify([...document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit')]
           .map(h => parseFloat(h.style.left) / 16).sort((a, b) => a - b))`);
      const savedClips = () => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = d.trackList.find(t => t.kind === 'rhythm').id;
        return JSON.stringify(d.tracks[id].map(c => ({
          start: c.start, len: c.len, notes: c.notes.map(n => n.start).sort((a, b) => a - b) })));
      })()`);

      // Move the right clip four columns later.
      await dragGrip(1, 4, 21);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const t = d && d.trackList && d.trackList.find(t => t.kind === 'rhythm');
        return !!t && d.tracks[t.id].length === 2 && d.tracks[t.id][1].start === 7;
      })()`);
      const drawn = JSON.parse(await drawnCols());
      if (JSON.stringify(drawn) !== JSON.stringify([0, 1, 2, 7, 8, 9])) {
        throw new Error(`the moved clip's part should sit four columns later, drawn ${JSON.stringify(drawn)}`);
      }
      const moved = JSON.parse(await savedClips());
      if (moved[0].start !== 0 || JSON.stringify(moved[0].notes) !== JSON.stringify([0, 1, 2, 3, 4, 5])) {
        throw new Error(`moving one clip must not disturb its neighbour, got ${JSON.stringify(moved)}`);
      }
      // The assertion this step exists for: every item the moved clip holds
      // shifted by four, not only the three its window was showing.
      if (JSON.stringify(moved[1].notes) !== JSON.stringify([4, 5, 6, 7, 8, 9])) {
        throw new Error(`hidden material must move with its clip, got ${JSON.stringify(moved)}`);
      }

      // And the relationship survived: trimming the moved clip's left edge
      // back out reveals what used to sit before it, at its new place.
      await cdp.evaluate(`(() => {
        const edge = document.querySelectorAll('.track[data-kind="rhythm"] .lane .clip')[1]
          .querySelector('.clip-edge.start');
        const r = edge.getBoundingClientRect();
        const x = r.left + 3, y = r.top + 10;
        edge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 23, clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 23, clientX: x - 3 * 16, clientY: y }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 23, clientX: x - 3 * 16, clientY: y }));
      })()`);
      await waitFor(`document.querySelectorAll('.track[data-kind="rhythm"] .lane .hit').length === 9`);
      // Wait for the *trim* to reach the draft before the next drag reads it.
      // Without this the clamp check below waited on `start !== 4` while the
      // draft still said 7 from the move — true on the previous state, so it
      // returned instantly and the assertion ran against a stale song in both
      // the real and the broken build. It passed either way, proving nothing.
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const t = d && d.trackList && d.trackList.find(t => t.kind === 'rhythm');
        return !!t && d.tracks[t.id].length === 2 && d.tracks[t.id][1].start === 4;
      })()`);
      const revealed = JSON.parse(await drawnCols());
      if (JSON.stringify(revealed) !== JSON.stringify([0, 1, 2, 4, 5, 6, 7, 8, 9])) {
        throw new Error(`trimming the moved clip open should reveal its own carried material, drawn ${JSON.stringify(revealed)}`);
      }

      // Clips do not overlap: dragged hard left, the moved clip stops against
      // its neighbour instead of sliding through it.
      await dragGrip(1, -20, 25);
      // Wait for the drag to have *settled* rather than for the clamped value
      // itself: waiting for the right answer turns a real failure into a bare
      // timeout message that names no symptom.
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const t = d && d.trackList && d.trackList.find(t => t.kind === 'rhythm');
        return !!t && d.tracks[t.id][1].start !== 4;
      })()`);
      const clamped = JSON.parse(await savedClips());
      if (clamped[1].start < clamped[0].start + clamped[0].len) {
        throw new Error(`a moved clip must stop at its neighbour rather than slide through it, got ${JSON.stringify(clamped)}`);
      }
    });

    for (const s of steps) await s();
  } finally {
    if (cdp) cdp.close();
    if (launched) await launched.cleanup();
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
