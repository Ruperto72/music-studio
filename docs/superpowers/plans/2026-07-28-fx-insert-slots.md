# Per-track FX insert slots implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-all-visible FX slider grid in `index.html`'s track header with an explicit, per-track "insert" list (add/remove chips + a bypass toggle), each opening a knob-based detail popover — per `docs/superpowers/specs/2026-07-28-fx-insert-slots-design.md`.

**Architecture:** Three tasks, each ending with a fully green `node verify.js`: (1) the data model — an `activeFx` map plus a `TRACK_FX_REGISTRY` reshaped so the three FX sends are independent entries — with no visible behavior change yet; (2) the whole new UI — chips, add menu, bypass toggle, popovers, and a new pointer-driven knob widget, replacing the old slider grid in one step (splitting the DOM rewrite further would leave `verify.js` red in between, since the same tests need both halves); (3) making bypass actually mute the audio graph, which the UI in (2) can already toggle but does not yet affect.

**Tech Stack:** Plain DOM (`el()`/`glyph()`), no framework, no build step — matches the rest of `index.html`. Tests run through `verify.js`, a headless-Chrome smoke test driven over the Chrome DevTools Protocol (no Jest/pytest in this repo).

## Global Constraints

- No dependencies, no build step, no bundler — everything lives in `index.html` (plus `verify.js` for testing). Do not add an npm package.
- There is no unit test framework. "Write the failing test, run it, watch it fail, implement, run it again" happens at the level of `verify.js` steps (headless-browser DOM assertions), not isolated function calls — `index.html` is a `<script type="module">`, so none of its top-level `const`/`function`s (`state`, `TRACK_FX_REGISTRY`, `getTrackEq`, ...) are reachable from `verify.js`'s `cdp.evaluate()` calls; only the rendered DOM, `localStorage`, and instrumented native Web Audio APIs are.
- Run the full suite with `node verify.js` from the repo root. It starts its own dev server and a headless Chromium-family browser (`CHROME_PATH` env var to override, or install Chrome/Chromium/Edge). It fails on any assertion failure *or* any console error/uncaught exception during the run.
- Follow the existing code style: comments only where something is non-obvious (a spec citation, a bug a naive version would reintroduce, a reason an alternative was rejected) — not what the code visibly does.
- Every place that saves, restores, clears or removes a track's per-track settings must go through `SPARSE_TRACK_MAPS`, not a hand-written list — this is why `state.activeFx` only needs one line added to that array (Task 1) rather than edits at four call sites.
- `state`'s existing helper naming convention: `getX(track)` reads (falls back to a `DEFAULT_X` constant when absent), `setX(track, patch)` merges a patch in, `applyX()` pushes the current value into the live Web Audio graph, looping `ALL_TRACKS`. New code should follow the same three-way split.

---

## Task 1: Data model — `activeFx`, registry split, `applySavedMix`, `verify.js` audit

**Files:**
- Modify: `index.html` (state object ~2181-2205, `SPARSE_TRACK_MAPS` ~2225, `applySavedMix` ~2231-2348, `TRACK_FX_REGISTRY` ~2709-2787, `trackFxFor` ~2787)
- Modify: `verify.js` (`auditBundledSongs`'s registry parser ~168-182 and validation loop ~236-262, and the "does not inherit" step's `maps` list ~1436)

**Interfaces:**
- Produces (used by Task 2 and Task 3):
  - `state.activeFx` — `{ [track]: { [effectKey]: { bypassed: boolean } } }`, sparse, part of `SPARSE_TRACK_MAPS`.
  - `FX_FIELD_DEFAULTS` — `{ [effectKey]: <that effect's own DEFAULT_* object, or a 1-field slice of DEFAULT_FX_SEND for the three send entries> }`.
  - `isEffectDefault(track, effect)` → `boolean`.
  - `visibleFxFor(track)` → `TRACK_FX_REGISTRY` entries (already filtered by `trackFxFor` for tonal-only), further filtered to those that should show a chip.
  - `isFxBypassed(track, key)` → `boolean`.
  - `TRACK_FX_REGISTRY` entries now: `eq, comp, crush, tremolo, sendDelay, sendChorus, sendReverb, vibrato` (fixed order matches the real audio chain). The three send entries each carry `dataKey: 'fxSend'` (their JSON/state field differs from their own `key`); every other entry has no `dataKey` (falls back to `key`, unchanged from today).

- [ ] **Step 1: Add `state.activeFx` and register it in `SPARSE_TRACK_MAPS`**

In `index.html`, find the state object's per-track song settings block (around line 2191, right after the `eq: {}` line):

```js
  eq: {},                    // id -> { low, mid, high } dB (any track kind) — see DEFAULT_TRACK_EQ
```

Add immediately after it:

```js
  activeFx: {},              // id -> { [effectKey]: { bypassed } } — which TRACK_FX_REGISTRY
                              // entries the FX panel shows as insert chips, and whether each is
                              // muted without losing its dialled-in value; see visibleFxFor()/
                              // isFxBypassed(). Absent per track/key both mean "not shown, not
                              // bypassed" the same way every other sparse map's absence means
                              // "the default".
```

Then find `const SPARSE_TRACK_MAPS = ['automation', 'adsr', 'filter', 'fm', 'fxSend', 'comp', 'crush', 'tremolo', 'vibrato', 'duty', 'eq'];` (line 2225) and add `'activeFx'`:

```js
const SPARSE_TRACK_MAPS = ['automation', 'adsr', 'filter', 'fm', 'fxSend', 'comp', 'crush', 'tremolo', 'vibrato', 'duty', 'eq', 'activeFx'];
```

This alone makes `clearSparseTrackMaps()`, `restoreTrackList()`, `createNewSong()`, `removeTrack()` (its `for (const map of [...SPARSE_TRACK_MAPS.map(k => state[k])]) delete map[id]` loop) and `currentSongData()`'s `sparseTrackMapsPayload()` all handle `activeFx` with no further edits — that is the entire point of the shared list.

- [ ] **Step 2: Split the `fxSend` registry entry into three, and reorder to match the audio chain**

Find `const TRACK_FX_REGISTRY = [` (line 2709) through its closing `];` (line 2782). Replace the whole array with:

```js
const TRACK_FX_REGISTRY = [
  {
    // Three biquads at the head of the insert chain (chanGain[track] ->
    // chanEq[track] -> chanComp[track] -> ...), so the compressor after it
    // reacts to the shaped signal. Same bands and range as the master EQ;
    // not clamped on load, for the same reason the compressor isn't — the
    // slider bounds are cosmetic, BiquadFilterNode takes more.
    key: 'eq', label: 'EQ', icon: 'eq',
    get: getTrackEq, set: setTrackEq, apply: applyTrackEq,
    fields: [
      { param: 'low', label: 'Lo', title: 'Low shelf (~200Hz)', min: -12, max: 12, step: 0.5, format: dbFormat, clamp: false },
      { param: 'mid', label: 'Mid', title: 'Mid peak (~1kHz)', min: -12, max: 12, step: 0.5, format: dbFormat, clamp: false },
      { param: 'high', label: 'Hi', title: 'High shelf (~4kHz)', min: -12, max: 12, step: 0.5, format: dbFormat, clamp: false },
    ],
  },
  {
    // An insert (chanEq[track] -> chanComp[track] -> ...), not a send, so
    // it has no 0-100% "amount" the way the sends below do; same four
    // params/ranges/formatting as the master compressor (COMP_FIELDS).
    key: 'comp', label: 'Comp', icon: 'comp',
    get: getTrackComp, set: setTrackComp, apply: applyTrackComp,
    fields: [
      { param: 'threshold', label: 'Thr', title: 'Threshold', min: -60, max: 0, step: 1, format: (v) => v.toFixed(0) + 'dB', clamp: false },
      { param: 'ratio', label: 'Rat', title: 'Ratio (1:1 = off)', min: 1, max: 20, step: 0.5, format: (v) => v.toFixed(1) + ':1', clamp: false },
      { param: 'attack', label: 'Atk', title: 'Attack', min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) + 's', clamp: false },
      { param: 'release', label: 'Rel', title: 'Release', min: 0.01, max: 1, step: 0.01, format: (v) => v.toFixed(2) + 's', clamp: false },
    ],
  },
  {
    // An insert (chanComp[track] -> chanCrush[track]? -> chanTremolo[track]),
    // reusing the master bus crusher's own AudioWorkletProcessor/formula
    // (crushAmountToHold(), js/downsample-processor.js), just one instance
    // per track — independent of the per-note Crush flag (a fixed always-on
    // 16-step WaveShaperNode, not an amount you can dial in).
    key: 'crush', label: 'Bitcrush', icon: 'crush',
    get: getTrackCrush, set: setTrackCrush, apply: applyTrackCrush,
    fields: [
      { param: 'amount', label: 'Crush', title: 'Lo-fi sample-and-hold downsampler insert, independent of the per-note Crush flag', min: 0, max: 1, step: 0.02, format: pctFormat, clamp: true },
    ],
  },
  {
    // An insert (an LFO added onto a plain gain node's own gain AudioParam,
    // see createChanTremolo()); Depth 0 is a true no-op regardless of Rate.
    key: 'tremolo', label: 'Tremolo', icon: 'tremolo',
    get: getTrackTremolo, set: setTrackTremolo, apply: applyTrackTremolo,
    fields: [
      { param: 'rate', label: 'Rate', title: 'Tremolo LFO speed', min: 0.5, max: 20, step: 0.1, format: (v) => v.toFixed(1) + 'Hz', clamp: false },
      { param: 'depth', label: 'Depth', title: 'Tremolo depth — 0% = off, 100% = swings all the way down to silence at the low point', min: 0, max: 1, step: 0.02, format: pctFormat, clamp: true },
    ],
  },
  {
    // The three sends below register as separate insert chips — a real mixer
    // picks Delay/Chorus/Reverb independently — but all three still read and
    // write one shared state.fxSend[track] object via
    // getFxSend/setFxSend/applyFxSend (setFxSend merges, so removing one
    // send's chip only patches its own field back to default rather than
    // wiping the other two — see removeFxChip() in Task 2). `dataKey` names
    // the song-JSON/state field these three share, since it no longer
    // matches any one of their own `key`s — applySavedMix() below groups by
    // dataKey rather than key so the three merge into one object instead of
    // each overwriting the last, and verify.js's auditBundledSongs() groups
    // the same way when reading this table's source text.
    key: 'sendDelay', dataKey: 'fxSend', label: 'Delay', icon: 'send',
    get: getFxSend, set: setFxSend, apply: applyFxSend,
    fields: [
      { param: 'delay', label: 'Delay', title: 'Continuous send to a shared tempo-synced delay — independent of the per-note Echo flag', min: 0, max: 1, step: 0.02, format: pctFormat, clamp: true },
    ],
  },
  {
    key: 'sendChorus', dataKey: 'fxSend', label: 'Chorus', icon: 'send',
    get: getFxSend, set: setFxSend, apply: applyFxSend,
    fields: [
      { param: 'chorus', label: 'Chorus', title: 'Continuous send to a shared modulated chorus effect — independent of the per-note Chorus flag', min: 0, max: 1, step: 0.02, format: pctFormat, clamp: true },
    ],
  },
  {
    key: 'sendReverb', dataKey: 'fxSend', label: 'Reverb', icon: 'send',
    get: getFxSend, set: setFxSend, apply: applyFxSend,
    fields: [
      { param: 'reverb', label: 'Reverb', title: 'Continuous send to a shared convolver reverb — independent of the per-note Reverb flag', min: 0, max: 1, step: 0.02, format: pctFormat, clamp: true, optional: true, default: 0 },
    ],
  },
  {
    // The pitch counterpart of the tremolo above, and the one entry in this
    // table that is *not* an insert: an LFO on the channel's gain can shape an
    // already-summed signal, but bending its pitch cannot be done downstream —
    // it has to reach each note's own oscillator. So this is threaded into
    // scheduleTone() (see DEFAULT_VIBRATO), which also makes it the only
    // tonal-only entry here: a drum hit has no oscillator to bend.
    key: 'vibrato', label: 'Vibrato', icon: 'vibrato', tonalOnly: true,
    get: getTrackVibrato, set: setTrackVibrato, apply: applyTrackVibrato,
    fields: [
      { param: 'rate', label: 'Rate', title: 'Vibrato LFO speed', min: 0.5, max: 12, step: 0.1, format: (v) => v.toFixed(1) + 'Hz', clamp: false },
      { param: 'depth', label: 'Depth', title: 'Vibrato depth in cents (100 = a semitone) — 0 = off. Adds to the per-note Vibrato flag rather than replacing it', min: 0, max: 100, step: 1, format: (v) => Math.round(v) + '¢', clamp: true },
    ],
  },
];
```

(This is the same content as today's six entries, just reordered and with `fxSend` split into three. Nothing about `getFxSend`/`setFxSend`/`applyFxSend`/`getTrackEq`/etc. changes — they're defined earlier in the file, unchanged.)

- [ ] **Step 3: Add `FX_FIELD_DEFAULTS`, `isEffectDefault`, `visibleFxFor`, `isFxBypassed`**

Right after the `trackFxFor` line (was 2787, now a few lines further down after Step 2's edit):

```js
const trackFxFor = (track) => TRACK_FX_REGISTRY.filter(e => !e.tonalOnly || !isRhythm(track));
```

Add:

```js
// Per-registry-key defaults for exactly that entry's own fields. Used both
// to decide whether a chip is "at default" (see isEffectDefault below) and,
// in Task 2, to reset one chip's fields via effect.set() — which merges, so
// patching sendDelay's one field back to default can't disturb sendChorus/
// sendReverb on the same shared state.fxSend[track] object the way deleting
// the whole object would.
const FX_FIELD_DEFAULTS = {
  eq: DEFAULT_TRACK_EQ,
  comp: DEFAULT_TRACK_COMP,
  crush: DEFAULT_TRACK_CRUSH,
  tremolo: DEFAULT_TREMOLO,
  vibrato: DEFAULT_VIBRATO,
  sendDelay: { delay: DEFAULT_FX_SEND.delay },
  sendChorus: { chorus: DEFAULT_FX_SEND.chorus },
  sendReverb: { reverb: DEFAULT_FX_SEND.reverb },
};
// Field-by-field comparison against FX_FIELD_DEFAULTS — not simply "is
// state[key][track] present", since set() can leave an object sitting at
// literal defaults (e.g. a knob dragged back down to 0) without deleting it.
function isEffectDefault(track, effect) {
  const v = effect.get(track);
  const d = FX_FIELD_DEFAULTS[effect.key];
  return effect.fields.every((f) => v[f.param] === d[f.param]);
}
// Which chips a track's FX panel shows: explicitly added (state.activeFx),
// or already holding a non-default value. The second clause is what makes an
// older song's saved EQ/Comp/sends — no activeFx entry, since the field
// didn't exist when it was saved — show its real chips on load instead of
// looking empty while still audibly applying (get()/apply() never consulted
// activeFx at all, only isFxBypassed() below does).
function visibleFxFor(track) {
  return trackFxFor(track).filter((effect) =>
    (state.activeFx[track] && effect.key in state.activeFx[track]) || !isEffectDefault(track, effect));
}
function isFxBypassed(track, key) {
  return !!(state.activeFx[track] && state.activeFx[track][key] && state.activeFx[track][key].bypassed);
}
```

- [ ] **Step 4: Rewrite `applySavedMix`'s `TRACK_FX_REGISTRY` loop to group by `dataKey`, and load `activeFx`**

In `applySavedMix` (index.html, currently lines 2301-2322), find:

```js
  // The four FX panel effects (Delay/Chorus/Reverb send, Compressor,
  // Bitcrush, Tremolo) all live on every track kind (tonal and rhythm
  // alike), so — unlike adsr/filter/fm above — this iterates ALL_TRACKS, not
  // PITCH_TRACKS. Driven by TRACK_FX_REGISTRY (single source of truth also
  // used by buildFxPanel()) rather than one hand-written block per effect.
  for (const effect of TRACK_FX_REGISTRY) {
    const src = data[effect.key];
    if (!src || typeof src !== 'object') continue;
    for (const ch of ALL_TRACKS) {
      if (effect.tonalOnly && isRhythm(ch)) continue;
      const v = src[ch];
      if (!v || typeof v !== 'object') continue;
      if (!effect.fields.every(f => f.optional || typeof v[f.param] === 'number')) continue;
      const clean = {};
      for (const f of effect.fields) {
        let val = typeof v[f.param] === 'number' ? v[f.param] : f.default;
        if (f.clamp) val = Math.max(f.min, Math.min(f.max, val));
        clean[f.param] = val;
      }
      state[effect.key][ch] = clean;
    }
  }
```

Replace it with:

```js
  // The seven FX panel effects (EQ, Compressor, Bitcrush, Tremolo, and the
  // three sends) all live on every track kind (tonal and rhythm alike, apart
  // from Vibrato), so — unlike adsr/filter/fm above — this iterates
  // ALL_TRACKS, not PITCH_TRACKS. Grouped by dataKey (falls back to key)
  // rather than key alone: the three send entries all read/write
  // data.fxSend, and without grouping, each would independently overwrite
  // state.fxSend[ch] with only its own one field, discarding whatever the
  // previous entry in the group had just set. Each effect within a group
  // keeps the original all-or-nothing-per-effect validation (one bad field
  // drops that effect's own fields, not the group's other effects) and every
  // field always resolves to a real number via FX_FIELD_DEFAULTS, so a
  // corrupt or missing field can never reach a Web Audio param as
  // `undefined`.
  const fxGroups = new Map();
  for (const effect of TRACK_FX_REGISTRY) {
    const dk = effect.dataKey || effect.key;
    if (!fxGroups.has(dk)) fxGroups.set(dk, []);
    fxGroups.get(dk).push(effect);
  }
  for (const [dataKey, effects] of fxGroups) {
    const src = data[dataKey];
    if (!src || typeof src !== 'object') continue;
    for (const ch of ALL_TRACKS) {
      const v = src[ch];
      if (!v || typeof v !== 'object') continue;
      const clean = {};
      for (const effect of effects) {
        if (effect.tonalOnly && isRhythm(ch)) continue;
        const ok = effect.fields.every((f) => f.optional || typeof v[f.param] === 'number');
        for (const f of effect.fields) {
          let val = ok && typeof v[f.param] === 'number' ? v[f.param] : FX_FIELD_DEFAULTS[effect.key][f.param];
          if (ok && f.clamp) val = Math.max(f.min, Math.min(f.max, val));
          clean[f.param] = val;
        }
      }
      if (Object.keys(clean).length) state[dataKey][ch] = clean;
    }
  }
  // activeFx: which TRACK_FX_REGISTRY entries a track's FX panel shows as
  // insert chips, plus each one's bypass flag — see visibleFxFor(). Doesn't
  // ride the loop above since its shape (an effect key -> { bypassed } map)
  // doesn't match the flat "id -> {param: number}" the loop assumes.
  if (data.activeFx && typeof data.activeFx === 'object') {
    for (const ch of ALL_TRACKS) {
      const src = data.activeFx[ch];
      if (!src || typeof src !== 'object') continue;
      const clean = {};
      for (const effectKey of Object.keys(src)) {
        const effect = TRACK_FX_REGISTRY.find((e) => e.key === effectKey);
        if (!effect) continue;
        if (effect.tonalOnly && isRhythm(ch)) continue;
        clean[effectKey] = { bypassed: !!(src[effectKey] || {}).bypassed };
      }
      if (Object.keys(clean).length) state.activeFx[ch] = clean;
    }
  }
```

- [ ] **Step 5: Update `verify.js`'s `auditBundledSongs()` to parse the reshaped registry**

In `verify.js`, find the registry-parsing block (currently lines 168-182):

```js
  // Each effect's field ranges, read straight off the TRACK_FX_REGISTRY table.
  const registry = {};
  {
    const from = html.indexOf('const TRACK_FX_REGISTRY = [');
    if (from < 0) throw new Error('could not find TRACK_FX_REGISTRY in index.html');
    const src = html.slice(from, from + html.slice(from).indexOf('\n];'));
    let key = null;
    for (const line of src.split('\n')) {
      const k = line.match(/^\s*key: '(\w+)'/);
      if (k) { key = k[1]; registry[key] = []; continue; }
      const f = line.match(/\{ param: '(\w+)',.*?min: (-?[\d.]+), max: (-?[\d.]+)/);
      if (f && key) registry[key].push({ param: f[1], min: +f[2], max: +f[3], optional: /optional: true/.test(line) });
    }
    if (!Object.keys(registry).length) throw new Error('read no effects out of TRACK_FX_REGISTRY');
  }
```

Replace with:

```js
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
```

Then, right after the existing generic sparse-map validation loop closes (currently ends at line 262, `}`, just before the `for (const id of Object.keys(song.automation || {}))` block), add:

```js
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
```

- [ ] **Step 6: Add `activeFx` to the "does not inherit" step's map list**

In `verify.js`, find (currently line 1436):

```js
      const maps = ['automation', 'adsr', 'filter', 'fm', 'fxSend', 'comp', 'crush', 'tremolo', 'vibrato', 'duty', 'eq'];
```

Change to:

```js
      const maps = ['automation', 'adsr', 'filter', 'fm', 'fxSend', 'comp', 'crush', 'tremolo', 'vibrato', 'duty', 'eq', 'activeFx'];
```

- [ ] **Step 7: Run the full suite and confirm it is still green**

Run: `node verify.js`

Expected: every step prints `ok` (including `auditBundledSongs` at the very start). Nothing in Task 1 touches `buildFxPanel()` or any other rendering code, so every existing DOM-based FX-panel step (the Delay slider, the EQ-before-compressor order, the 13/15-field count, the rhythm-track-has-no-Vibrato check) still passes unmodified against the reshaped registry — this run is the proof that the reshape is behavior-preserving before Task 2 changes the UI on top of it.

- [ ] **Step 8: Commit**

```bash
git add index.html verify.js
git commit -m "Split FX send registry into three insert-ready entries, add activeFx data model

Reorders TRACK_FX_REGISTRY to match the real audio chain and splits the
combined Sends entry into sendDelay/sendChorus/sendReverb so each can
become its own insert chip. Adds the activeFx sparse map (which chips are
explicitly shown, and each one's bypass flag) with no UI changes yet —
existing verify.js FX panel checks pass unmodified against the reshaped
registry."
```

---

## Task 2: FX panel UI — chips, add menu, bypass toggle, popovers, knob widget

**Files:**
- Modify: `index.html` (CSS ~330-469, `GLYPHS` ~1373, module state near `fxSendOpen` ~3250, `removeTrack` ~3017, `buildFxPanel`/`addFxField` ~3452-3505, `buildHeader`'s FX-panel-open line ~3734)
- Modify: `verify.js` (steps at ~485-535, ~1104-1136, ~2518-2612)

**Interfaces:**
- Consumes (from Task 1): `TRACK_FX_REGISTRY`, `trackFxFor(track)`, `visibleFxFor(track)`, `isFxBypassed(track, key)`, `FX_FIELD_DEFAULTS`, `state.activeFx`.
- Produces (used by Task 3 only indirectly — Task 3 does not touch UI code, but relies on the bypass toggle this task builds already writing `state.activeFx[track][key].bypassed` correctly): the rewritten `buildFxPanel(track)`, `buildKnob(track, effect, field, value, onInput)`, module-level `fxPopoverOpen` (`Set<string>`, keys `` `${track}::${effectKey}` ``) and `fxAddMenuOpen` (`string | null`, a track id).

- [ ] **Step 1: Add the `power` glyph**

In `index.html`'s `GLYPHS` table, in the "Track-header buttons" section, find:

```js
  preset:   { box: '0 0 24 24', paths: ['M6 4v16', 'M12 4v16', 'M18 4v16', 'M3.5 9h5', 'M9.5 14h5', 'M15.5 7h5'] },
```

Add right after it:

```js
  // A power switch: the stem plus an open ring (broken at the top, where the
  // stem crosses it) — the standard ISO bypass/power glyph, stroked like
  // every other icon here rather than a filled symbol.
  power:    { box: '0 0 24 24', paths: ['M12 4v7', 'M7.5 6.2a7 7 0 1 0 9 0'] },
```

- [ ] **Step 2: Add `fxPopoverOpen`/`fxAddMenuOpen` state, and the outside-click/Escape close handler**

Find (currently line 3250):

```js
const fxSendOpen = new Set(); // track ids with the Delay/Chorus send panel open
```

Add right after it:

```js
// Which FX insert popovers are open, keyed by `${track}::${effectKey}` — any
// number can be open at once, across tracks and effects (unlike
// automationOpen/adsrOpen, which are one-per-track). Not serialized: purely
// which panel is currently expanded, the same kind of state fxSendOpen above
// already is.
const fxPopoverOpen = new Set();
// At most one "+ Add effect" menu open at a time, holding the track id it
// belongs to (or null). A single value rather than a Set: unlike popovers,
// which are worth comparing side by side, there is never a reason to have
// two add-menus open at once.
let fxAddMenuOpen = null;
// Light-dismiss for both of the above — an outside click or Escape closes
// whatever is open. Plain inline panels rather than <dialog> elements (see
// buildFxPanel()), so this has to be done by hand instead of getting it from
// the browser.
document.addEventListener('pointerdown', (e) => {
  if (!fxPopoverOpen.size && fxAddMenuOpen == null) return;
  if (e.target.closest('.th-fx-popover, .th-fx-chip, .th-fx-add')) return;
  fxPopoverOpen.clear();
  fxAddMenuOpen = null;
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!fxPopoverOpen.size && fxAddMenuOpen == null) return;
  fxPopoverOpen.clear();
  fxAddMenuOpen = null;
  render();
});
```

- [ ] **Step 3: Clean up `fxPopoverOpen`/`fxAddMenuOpen` when a track is removed**

In `removeTrack(id)` (currently line 3017), find:

```js
  delete vuLevel[id]; delete vuMeters[id]; automationOpen.delete(id); adsrOpen.delete(id); fxSendOpen.delete(id);
```

Change to:

```js
  delete vuLevel[id]; delete vuMeters[id]; automationOpen.delete(id); adsrOpen.delete(id); fxSendOpen.delete(id);
  for (const k of [...fxPopoverOpen]) if (k.startsWith(id + '::')) fxPopoverOpen.delete(k);
  if (fxAddMenuOpen === id) fxAddMenuOpen = null;
```

- [ ] **Step 4: Replace the CSS for the old slider grid with chips/add-menu/popover/knob rules**

Find the whole block from `/* Track FX panel ... */` through `.th-fx-field input[type=range] { width: 100%; cursor: pointer; }` (currently lines 446-468):

```css
  /* Track FX panel (Delay/Chorus/Reverb send, EQ, Compressor, Bitcrush, Tremolo)
     — unlike Automation/Envelope this needs no timeline column width, so it
     lives right inside the header as a compact 2-column grid instead of a
     full-width row (see buildFxPanel()). */
  .th-fx-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; margin-top: 2px; }
  .th-fx-reset-wrap { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
  .th-fx-reset {
    background: #26262e; color: var(--ink); border: 1px solid #3a3a44; border-radius: 4px;
    font-size: 10px; padding: 2px 6px; cursor: pointer;
  }
  .th-fx-reset:hover { border-color: #55555f; }
  .th-fx-group {
    grid-column: 1 / -1; display: flex; align-items: center; gap: 5px;
    font-size: 9px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;
    color: #8f8f9b; border-top: 1px solid #3a3a44; padding-top: 5px; margin-top: 2px;
  }
  .th-fx-group.first { border-top: 0; padding-top: 0; margin-top: 0; }
  .th-fx-group .glyph { width: 18px; height: 9px; }
  .th-fx-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .th-fx-row1 { display: flex; justify-content: space-between; align-items: baseline; gap: 4px; }
  .th-fx-label { font-size: 10px; font-weight: 700; color: var(--muted); }
  .th-fx-val { font-size: 9px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .th-fx-field input[type=range] { width: 100%; cursor: pointer; }
```

Replace with:

```css
  /* Track FX panel — an insert-chip rack (Pro Tools style) rather than an
     always-all-visible slider grid: chips for whichever effects this track
     actually has (visibleFxFor()), a "+ Add effect" menu, and a knob-based
     popover per open chip. Unlike Automation/Envelope this needs no timeline
     column width, so it lives right inside the header (see buildFxPanel()). */
  .th-fx-panel { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
  .th-fx-reset-wrap { display: flex; justify-content: flex-end; }
  .th-fx-reset {
    background: #26262e; color: var(--ink); border: 1px solid #3a3a44; border-radius: 4px;
    font-size: 10px; padding: 2px 6px; cursor: pointer;
  }
  .th-fx-reset:hover { border-color: #55555f; }
  .th-fx-chip-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: flex-start; }
  .th-fx-chip {
    display: inline-flex; align-items: center; gap: 3px;
    background: #26262e; border: 1px solid #3a3a44; border-radius: 12px; padding: 2px 3px 2px 8px;
  }
  .th-fx-chip.open { border-color: #7a4fd1; box-shadow: 0 0 6px rgba(122,79,209,0.35); }
  .th-fx-chip.bypassed { opacity: 0.55; }
  .th-fx-chip-body {
    display: flex; align-items: center; gap: 4px; background: none; border: none;
    font-size: 10px; font-weight: 700; color: var(--ink); cursor: pointer; padding: 2px 0;
  }
  .th-fx-chip-body .glyph { width: 16px; height: 8px; }
  .th-fx-chip-bypass, .th-fx-chip-remove {
    display: flex; align-items: center; justify-content: center; background: none; border: none;
    width: 16px; height: 16px; padding: 0; border-radius: 3px; color: var(--muted); cursor: pointer;
  }
  .th-fx-chip-bypass .glyph-sq { width: 11px; height: 11px; }
  .th-fx-chip-bypass.on { color: #ffb84f; }
  .th-fx-chip-remove:hover { background: #3a1414; color: #ff9a9a; }
  .th-fx-add { position: relative; }
  .th-fx-add-btn {
    background: #26262e; border: 1px dashed #4a4a54; border-radius: 12px; color: var(--muted);
    font-size: 10px; padding: 3px 8px; cursor: pointer;
  }
  .th-fx-add-btn:hover { border-color: #6a6a76; color: var(--ink); }
  .th-fx-add-menu {
    position: absolute; top: 100%; left: 0; z-index: 20; margin-top: 3px; min-width: 120px;
    background: #1c1c22; border: 1px solid #3a3a44; border-radius: 6px; padding: 2px;
    display: flex; flex-direction: column; box-shadow: 0 4px 12px rgba(0,0,0,0.45);
  }
  .th-fx-add-menu button {
    display: flex; align-items: center; gap: 6px; background: none; border: none; text-align: left;
    color: var(--ink); font-size: 10px; padding: 4px 6px; border-radius: 4px; cursor: pointer;
  }
  .th-fx-add-menu button:hover { background: #2c2c33; }
  .th-fx-add-menu button .glyph { width: 16px; height: 8px; }
  .th-fx-add-empty { font-size: 10px; color: var(--muted); padding: 4px 6px; }
  .th-fx-popover { border: 1px solid #3a3a44; border-radius: 6px; background: #1c1c22; padding: 6px 8px; }
  .th-fx-popover.bypassed { opacity: 0.55; }
  .th-fx-popover-head {
    display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
    font-size: 10px; font-weight: 700; color: var(--muted);
  }
  .th-fx-popover-head .glyph { width: 18px; height: 9px; }
  .th-fx-popover-head-spacer { flex: 1; }
  .th-fx-popover-fields { display: flex; flex-wrap: wrap; gap: 10px; }

  /* Insert-effect parameter knob — a pointer-driven rotary control, not a
     restyled <input type=range> (see buildKnob()). -135deg..+135deg sweep
     (270deg), CSS conic-gradient for the lit arc and a rotated pointer stick
     for the indicator, both using the same "0deg = top, clockwise" angle
     convention so they always agree. */
  .th-knob { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
  .th-knob-label { font-size: 9px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; }
  .th-knob-dial {
    position: relative; width: 34px; height: 34px; border-radius: 50%; cursor: pointer; touch-action: none;
  }
  .th-knob-dial:focus-visible { outline: 2px solid #7a4fd1; outline-offset: 2px; }
  .th-knob-pointer {
    position: absolute; left: 50%; top: 50%; width: 2px; height: 14px; background: #e8e8f0; border-radius: 1px;
    margin-left: -1px; margin-top: -14px; transform-origin: 50% 14px;
  }
  .th-knob-val { font-size: 9px; color: var(--muted); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 5: Delete `addFxField`, write `buildKnob`, `buildFxChip`, `removeFxChip`, `buildFxPopover`, and rewrite `buildFxPanel`**

Find `addFxField` through the end of `buildFxPanel` (currently lines 3452-3505):

```js
function addFxField(panel, track, label, title_, value, min, max, step, format, onInput) {
  const field = el('div', 'th-fx-field');
  const row1 = el('div', 'th-fx-row1');
  const cap = el('span', 'th-fx-label'); cap.textContent = label;
  const val = el('span', 'th-fx-val'); val.textContent = format(value);
  row1.append(cap, val);
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = min; slider.max = max; slider.step = step; slider.value = value;
  slider.style.accentColor = trackColor(track);
  slider.title = title_;
  slider.addEventListener('mousedown', (e) => e.stopPropagation());
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    val.textContent = format(v);
    onInput(v);
  });
  field.append(row1, slider);
  panel.appendChild(field);
}
function buildFxPanel(track) {
  const panel = el('div', 'th-fx-panel');

  const resetWrap = el('div', 'th-fx-reset-wrap');
  const resetBtn = el('button', 'th-fx-reset'); resetBtn.textContent = 'Reset';
  resetBtn.title = 'Reset Delay/Chorus/Reverb send, EQ, Compressor, Bitcrush and Tremolo to their defaults';
  resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const effect of trackFxFor(track)) { delete state[effect.key][track]; effect.apply(); }
    render(); autosave();
  });
  resetWrap.appendChild(resetBtn);
  panel.appendChild(resetWrap);

  // Each group gets a heading with its own glyph, rather than the bare hairline
  // rule that used to separate them: the panel is 13 sliders in a two-column
  // grid, and abbreviations like Thr/Rat/Atk/Rel only read as a compressor once
  // you know which group you're looking at. The heading doubles as the
  // separator, so the old .th-fx-divider is gone.
  trackFxFor(track).forEach((effect, i) => {
    const head = el('div', 'th-fx-group' + (i === 0 ? ' first' : ''));
    head.appendChild(glyph(effect.icon));
    const cap = el('span'); cap.textContent = effect.label;
    head.appendChild(cap);
    panel.appendChild(head);
    const values = effect.get(track);
    for (const f of effect.fields) {
      addFxField(panel, track, f.label, f.title, values[f.param], f.min, f.max, f.step, f.format,
        (v) => { effect.set(track, { [f.param]: v }); effect.apply(); autosave(); });
    }
  });

  return panel;
}
```

Replace the whole thing with:

```js
// Insert-effect parameter knob — pointer-driven rotary control (the same
// manual pointerdown/pointermove/pointerup gesture pattern as
// startAutomationDrag and friends), not a restyled <input type=range>.
// -135deg..+135deg sweep (270deg total): 0% at -135, 100% at +135. Renders
// its own value text so a sighted read of the dial and the aria-valuetext a
// screen reader gets never disagree.
function buildKnob(track, effect, field, value, onInput) {
  const wrap = el('div', 'th-knob');
  const cap = el('span', 'th-knob-label'); cap.textContent = field.label;
  const dial = el('div', 'th-knob-dial');
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-orientation', 'vertical');
  dial.setAttribute('aria-valuemin', String(field.min));
  dial.setAttribute('aria-valuemax', String(field.max));
  dial.setAttribute('aria-label', `${field.label} — ${effect.label} on ${trackName(track)}`);
  dial.title = field.title;
  const pointer = el('div', 'th-knob-pointer');
  dial.appendChild(pointer);
  const val = el('span', 'th-knob-val');

  function paint(v) {
    const frac = Math.max(0, Math.min(1, (v - field.min) / (field.max - field.min)));
    const sweep = frac * 270;
    dial.style.background =
      `conic-gradient(from -135deg, #7a4fd1 0deg, #7a4fd1 ${sweep}deg, ` +
      `#4a4a56 ${sweep}deg, #4a4a56 270deg, transparent 270deg, transparent 360deg)`;
    pointer.style.transform = `rotate(${-135 + sweep}deg)`;
    dial.setAttribute('aria-valuenow', String(v));
    dial.setAttribute('aria-valuetext', field.format(v));
    val.textContent = field.format(v);
  }
  paint(value);

  function commit(v) {
    v = Math.max(field.min, Math.min(field.max, v));
    // Snap to the field's own step, rounded in step units to avoid float
    // drift (0.1 + 0.2 !== 0.3).
    v = Math.round(v / field.step) * field.step;
    paint(v);
    onInput(v);
  }

  dial.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    dial.focus();
    const pointerId = e.pointerId;
    const startY = e.clientY;
    const startVal = parseFloat(dial.getAttribute('aria-valuenow'));
    const range = field.max - field.min;
    function onMove(ev) {
      if (ev.pointerId !== pointerId) return;
      // A 150px drag covers the field's full range, whatever it is — a 0..1
      // send and a -60..0 threshold both take one comfortable drag rather
      // than one of them being twitchy.
      commit(startVal + ((startY - ev.clientY) / 150) * range);
    }
    function onUp(ev) {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
  dial.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    commit(FX_FIELD_DEFAULTS[effect.key][field.param]);
  });
  dial.addEventListener('keydown', (e) => {
    const cur = parseFloat(dial.getAttribute('aria-valuenow'));
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); commit(cur + field.step); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); commit(cur - field.step); }
    else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); commit(field.min); }
    else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); commit(field.max); }
  });

  wrap.append(cap, dial, val);
  return wrap;
}
// Shared by the chip's own bypass/remove buttons and its popover's header —
// same handlers either way, so toggling bypass from the chip and from inside
// its own open popover can never disagree.
function buildFxBypassButton(track, effect) {
  const bypassed = isFxBypassed(track, effect.key);
  const btn = el('button', 'th-fx-chip-bypass' + (bypassed ? ' on' : ''));
  btn.type = 'button';
  btn.appendChild(glyph('power'));
  btn.title = bypassed ? `Bypassed — click to re-enable ${effect.label}` : `Bypass ${effect.label}`;
  btn.setAttribute('aria-pressed', String(bypassed));
  btn.setAttribute('aria-label', `Bypass ${effect.label} on ${trackName(track)}`);
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.activeFx[track] = state.activeFx[track] || {};
    state.activeFx[track][effect.key] = { bypassed: !bypassed };
    effect.apply();
    render(); autosave();
  });
  return btn;
}
function buildFxRemoveButton(track, effect) {
  const btn = el('button', 'th-fx-chip-remove');
  btn.type = 'button';
  btn.textContent = '✕';
  btn.title = `Remove ${effect.label}`;
  btn.setAttribute('aria-label', `Remove ${effect.label} from ${trackName(track)}`);
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => { e.stopPropagation(); removeFxChip(track, effect); });
  return btn;
}
// Resets one effect's own fields to default via set() — which merges, so the
// three send entries sharing state.fxSend[track] only patch their own field
// rather than wiping the other two sends — and drops it from
// activeFx/fxPopoverOpen, so it disappears from the panel exactly like it
// was never added and stops contributing anything audible.
function removeFxChip(track, effect) {
  effect.set(track, FX_FIELD_DEFAULTS[effect.key]);
  if (state.activeFx[track]) delete state.activeFx[track][effect.key];
  fxPopoverOpen.delete(track + '::' + effect.key);
  effect.apply();
  render(); autosave();
}
function buildFxChip(track, effect) {
  const bypassed = isFxBypassed(track, effect.key);
  const open = fxPopoverOpen.has(track + '::' + effect.key);
  const chip = el('div', 'th-fx-chip' + (bypassed ? ' bypassed' : '') + (open ? ' open' : ''));
  const body = el('button', 'th-fx-chip-body');
  body.type = 'button';
  body.title = effect.label;
  body.appendChild(glyph(effect.icon));
  const label = document.createElement('span'); label.textContent = effect.label;
  body.appendChild(label);
  body.addEventListener('mousedown', (e) => e.stopPropagation());
  body.addEventListener('click', (e) => {
    e.stopPropagation();
    const popKey = track + '::' + effect.key;
    if (fxPopoverOpen.has(popKey)) fxPopoverOpen.delete(popKey); else fxPopoverOpen.add(popKey);
    render();
  });
  chip.append(body, buildFxBypassButton(track, effect), buildFxRemoveButton(track, effect));
  return chip;
}
function buildFxPopover(track, effect) {
  const bypassed = isFxBypassed(track, effect.key);
  const pop = el('div', 'th-fx-popover' + (bypassed ? ' bypassed' : ''));
  pop.dataset.key = effect.key;
  const head = el('div', 'th-fx-popover-head');
  head.appendChild(glyph(effect.icon));
  const title = document.createElement('span'); title.textContent = effect.label;
  head.append(title, el('span', 'th-fx-popover-head-spacer'), buildFxBypassButton(track, effect), buildFxRemoveButton(track, effect));
  pop.appendChild(head);

  const fields = el('div', 'th-fx-popover-fields');
  const values = effect.get(track);
  for (const f of effect.fields) {
    fields.appendChild(buildKnob(track, effect, f, values[f.param],
      (v) => { effect.set(track, { [f.param]: v }); effect.apply(); autosave(); }));
  }
  pop.appendChild(fields);
  return pop;
}
function buildFxPanel(track) {
  const panel = el('div', 'th-fx-panel');

  const resetWrap = el('div', 'th-fx-reset-wrap');
  const resetBtn = el('button', 'th-fx-reset'); resetBtn.textContent = 'Reset';
  resetBtn.title = 'Remove every insert and send on this track';
  resetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const effect of trackFxFor(track)) {
      effect.set(track, FX_FIELD_DEFAULTS[effect.key]);
      effect.apply();
      fxPopoverOpen.delete(track + '::' + effect.key);
    }
    delete state.activeFx[track];
    render(); autosave();
  });
  resetWrap.appendChild(resetBtn);
  panel.appendChild(resetWrap);

  const visible = visibleFxFor(track);
  const chipRow = el('div', 'th-fx-chip-row');
  for (const effect of visible) chipRow.appendChild(buildFxChip(track, effect));

  const addWrap = el('div', 'th-fx-add');
  const addBtn = el('button', 'th-fx-add-btn'); addBtn.type = 'button'; addBtn.textContent = '+ Add effect';
  addBtn.title = 'Add an effect to this track';
  addBtn.setAttribute('aria-haspopup', 'true');
  addBtn.setAttribute('aria-expanded', String(fxAddMenuOpen === track));
  addBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fxAddMenuOpen = fxAddMenuOpen === track ? null : track;
    render();
  });
  addWrap.appendChild(addBtn);
  if (fxAddMenuOpen === track) {
    const notAdded = trackFxFor(track).filter((e) => !visible.includes(e));
    const menu = el('div', 'th-fx-add-menu');
    if (!notAdded.length) {
      const none = el('div', 'th-fx-add-empty'); none.textContent = 'All effects added';
      menu.appendChild(none);
    }
    for (const effect of notAdded) {
      const item = el('button'); item.type = 'button';
      item.appendChild(glyph(effect.icon));
      const span = document.createElement('span'); span.textContent = effect.label;
      item.appendChild(span);
      item.addEventListener('mousedown', (e) => e.stopPropagation());
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        state.activeFx[track] = state.activeFx[track] || {};
        state.activeFx[track][effect.key] = { bypassed: false };
        fxPopoverOpen.add(track + '::' + effect.key);
        fxAddMenuOpen = null;
        effect.apply();
        render(); autosave();
      });
      menu.appendChild(item);
    }
    addWrap.appendChild(menu);
  }
  chipRow.appendChild(addWrap);
  panel.appendChild(chipRow);

  for (const effect of visible) {
    if (fxPopoverOpen.has(track + '::' + effect.key)) panel.appendChild(buildFxPopover(track, effect));
  }

  return panel;
}
```

- [ ] **Step 6: Manual smoke check before touching `verify.js`**

Run: `node dev.js` (or `node dev-server.js` and open `http://localhost:8080` yourself)

In the browser: open a track's FX panel (the "FX" tool button). Confirm it now shows only "+ Add effect" (no chips) on a fresh song. Click it, add EQ — confirm a chip appears, its popover opens automatically, and it has three knobs (Lo/Mid/Hi). Drag one with the mouse (value should change) and adjust another with Tab-then-arrow-keys. Click the chip's power icon — chip and popover dim. Click Escape — popover closes. Re-open, click the chip's ✕ — chip disappears. Click "+ Add effect" again — EQ is offered again and now shows its default (0.0dB) knobs when re-added.

Expected: all of the above works with no console errors (check DevTools). This is the point of the plan's Global Constraints note about `verify.js` not substituting for actually exercising a UI change in a real browser.

- [ ] **Step 7: Rewrite the Delay/EQ verify.js step to use the new add-menu + knob**

In `verify.js`, find the two steps `'opens the FX panel and adjusts the Delay slider'` and `'FX panel: per-track EQ sits ahead of the compressor and survives a reload'` (currently lines 485-535):

```js
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
```

Replace both with:

```js
    // Small helpers shared by every FX-panel step below. `panel` is always
    // the first track's (`.track`s[0]) — same target the old slider-grid
    // tests used, kept for continuity with the rest of the suite.
    const fxPanelSel = `document.querySelectorAll('.track')[0].querySelector('.th-fx-panel')`;
    async function openFxPanel() {
      await cdp.evaluate(`(() => {
        if (${fxPanelSel}) return;
        Array.from(document.querySelectorAll('.track')[0].querySelectorAll('button')).find(b => b.textContent.includes('FX')).click();
      })()`);
      await waitFor(`!!(${fxPanelSel})`);
    }
    // Adds `label` (e.g. 'EQ') via the "+ Add effect" menu if not already a
    // chip, and returns once its popover is open (adding auto-opens it).
    async function addFxEffect(label) {
      const already = await cdp.evaluate(`!![...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`);
      if (already) return;
      await cdp.evaluate(`(${fxPanelSel}).querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!(${fxPanelSel}).querySelector('.th-fx-add-menu')`);
      await cdp.evaluate(`[...(${fxPanelSel}).querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
      await waitFor(`!!(${fxPanelSel}).querySelector('.th-fx-popover[data-key]')`);
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
      await openFxPanel();
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
      const chipLabels = await cdp.evaluate(`[...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body span')].map(s => s.textContent)`);
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
      await cdp.evaluate(`[...(${fxPanelSel}).querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body span').textContent === 'EQ').querySelector('.th-fx-chip-bypass').click()`);
      const bypassedState = await cdp.evaluate(`(() => {
        const chip = [...(${fxPanelSel}).querySelectorAll('.th-fx-chip')].find(c => c.querySelector('.th-fx-chip-body span').textContent === 'EQ');
        const pop = (${fxPanelSel}).querySelector('.th-fx-popover[data-key="eq"]');
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
```

- [ ] **Step 8: Rewrite the "one glyphed heading per group" step to add every effect first**

In `verify.js`, find (currently lines 1104-1136):

```js
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
```

Replace with:

```js
      // FX panel: every TRACK_FX_REGISTRY entry is offered, in the fixed
      // registry order, each with a glyphed chip; adding all of them opens
      // all their popovers (any number can be open at once), so the total
      // knob count across all of them is the same 13/15 the old always-shown
      // slider grid asserted. An earlier step may already have opened this
      // panel, in which case clicking the button would close it.
      await cdp.evaluate(`(() => {
        if (document.querySelector('.th-fx-panel')) return;
        [...document.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.th-fx-panel')`);
      const panelSel = `document.querySelector('.th-fx-panel')`;
      const tonal = await cdp.evaluate(`!!(${panelSel}).closest('.track-header').querySelector('.th-wave-group')`);
      for (let i = 0; i < 8; i++) {
        const added = await cdp.evaluate(`(() => {
          const addBtn = (${panelSel}).querySelector('.th-fx-add-btn');
          if (!addBtn) return false;
          addBtn.click();
          const item = (${panelSel}).querySelector('.th-fx-add-menu button');
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
          labels: chips.map(c => c.querySelector('.th-fx-chip-body span').textContent),
          drawn: chips.every(c => c.querySelectorAll('svg.glyph path').length > 0),
          knobs: panel.querySelectorAll('.th-knob').length,
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
```

- [ ] **Step 9: Rewrite the rhythm/tonal Vibrato-availability step and its audio-graph check**

In `verify.js`, find the whole block from the `rhythmHead`/Vibrato-absent check through the depth-0/no-connection check (currently lines 2518-2612):

```js
      // The rhythm track's FX panel must not offer Vibrato. Reached by its
      // own header rather than "the first track" — the starter layout puts
      // four tonal tracks ahead of it.
      const rhythmHead = `[...document.querySelectorAll('.track-header')].find(h => !h.querySelector('.th-wave-group'))`;
      await cdp.evaluate(`(() => {
        const head = ${rhythmHead};
        if (head.querySelector('.th-fx-panel')) return;
        [...head.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!(${rhythmHead}).querySelector('.th-fx-group')`);
      const rhythmGroups = await cdp.evaluate(
        `[...(${rhythmHead}).querySelector('.th-fx-panel').querySelectorAll('.th-fx-group')].map(h => h.textContent.trim())`);
      if (rhythmGroups.includes('Vibrato')) {
        throw new Error(`a rhythm track must not offer Vibrato: ${JSON.stringify(rhythmGroups)}`);
      }
      if (!rhythmGroups.includes('Tremolo')) {
        throw new Error(`the rhythm FX panel lost its other groups: ${JSON.stringify(rhythmGroups)}`);
      }

      // A tonal track must offer it.
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      const beforeAdd2 = await cdp.evaluate(`document.querySelectorAll('.track').length`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('Add track')).click()`);
      // `> 1` used to mean "the added track showed up"; the starter layout is
      // already five, so that would now pass without adding anything.
      await waitFor(`document.querySelectorAll('.track').length === ${beforeAdd2} + 1`);
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
      const mod = await cdp.evaluate(`window.__readFreqMod()`);
      // Exact, not a range: 50 cents of a note at f Hz is f * (2^(50/1200) - 1)
      // deep, so the check works out the expectation from the frequency the
      // app actually used. The previous "somewhere between 5 and 40 Hz" only
      // held for the pitch an empty lane happened to place the note at, and
      // silently became a different test whenever that lane resized.
      const want = (f) => f * (Math.pow(2, 50 / 1200) - 1);
      if (!mod.some((v) => v && Math.abs(v.gain - want(v.freq)) < 0.5)) {
        throw new Error(`a 50-cent track vibrato should modulate the note's own frequency, saw ${JSON.stringify(mod)}`);
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
```

Replace with:

```js
      // The rhythm track's "+ Add effect" menu must not offer Vibrato.
      // Reached by its own header rather than "the first track" — the
      // starter layout puts four tonal tracks ahead of it.
      const rhythmHead = `[...document.querySelectorAll('.track-header')].find(h => !h.querySelector('.th-wave-group'))`;
      await cdp.evaluate(`(() => {
        const head = ${rhythmHead};
        if (head.querySelector('.th-fx-panel')) return;
        [...head.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!(${rhythmHead}).querySelector('.th-fx-panel')`);
      await cdp.evaluate(`(${rhythmHead}).querySelector('.th-fx-panel').querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!(${rhythmHead}).querySelector('.th-fx-add-menu')`);
      const rhythmMenu = await cdp.evaluate(`[...(${rhythmHead}).querySelectorAll('.th-fx-add-menu button')].map(b => b.textContent.trim())`);
      if (rhythmMenu.includes('Vibrato')) throw new Error(`a rhythm track's add menu must not offer Vibrato: ${JSON.stringify(rhythmMenu)}`);
      if (!rhythmMenu.includes('Tremolo')) throw new Error(`the rhythm add menu lost its other effects: ${JSON.stringify(rhythmMenu)}`);
      await cdp.evaluate(`(${rhythmHead}).querySelector('.th-fx-add-btn').click()`); // close the menu back up

      // A tonal track must offer it. Add a fresh one so its FX panel starts
      // empty (the starter tracks may already be dirtied by earlier steps).
      await cdp.evaluate(`document.querySelector('#file-menu-toggle').click()`);
      const beforeAdd2 = await cdp.evaluate(`document.querySelectorAll('.track').length`);
      await cdp.evaluate(`Array.from(document.querySelectorAll('#file-menu-panel button')).find(b => b.textContent.trim().startsWith('Add track')).click()`);
      await waitFor(`document.querySelectorAll('.track').length === ${beforeAdd2} + 1`);
      const newTonalHead = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group') && !h.querySelector('.th-fx-panel .th-fx-chip'))`;
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group') && !h.querySelector('.th-fx-panel'));
        [...head.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!(${newTonalHead})`);
      await cdp.evaluate(`(${newTonalHead}).querySelector('.th-fx-panel').querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!(${newTonalHead}).querySelector('.th-fx-add-menu')`);
      const tonalMenu = await cdp.evaluate(`[...(${newTonalHead}).querySelectorAll('.th-fx-add-menu button')].map(b => b.textContent.trim())`);
      if (!tonalMenu.includes('Vibrato')) throw new Error(`a tonal track's add menu should offer Vibrato: ${JSON.stringify(tonalMenu)}`);
      await cdp.evaluate(`[...(${newTonalHead}).querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === 'Vibrato').click()`);
      await waitFor(`!!(${newTonalHead}).querySelector('.th-fx-popover[data-key="vibrato"]')`);

      // Set a depth, place a note, and confirm an LFO reaches its frequency.
      // 50 cents on a 523.25Hz note => 523.25 * (2^(50/1200) - 1) ~= 15.3Hz.
      // 0 -> 50 at a 1-cent step is 50 presses.
      await cdp.evaluate(`(() => {
        const dial = [...(${newTonalHead}).querySelector('.th-fx-popover[data-key="vibrato"]').querySelectorAll('.th-knob')]
          .find(k => k.querySelector('.th-knob-label').textContent === 'Depth').querySelector('.th-knob-dial');
        dial.focus();
        for (let i = 0; i < 50; i++) dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      })()`);
      await new Promise((r) => setTimeout(r, 300));

      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`window.__freqMod = []`);
      await cdp.evaluate(`(() => {
        const lane = [...document.querySelectorAll('.lane')].find(l => l.closest('.track-header') === ${newTonalHead} ? false : l.closest('.track').querySelector('.track-header') === (${newTonalHead}));
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

      // At depth 0 nothing must be connected — an untouched track is unchanged.
      await cdp.evaluate(`(() => {
        const dial = [...(${newTonalHead}).querySelector('.th-fx-popover[data-key="vibrato"]').querySelectorAll('.th-knob')]
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
```

(The `lane` lookup above is awkward because `.lane` elements aren't direct children of `.track-header`; if this proves flaky when you run it, replace it with the same pattern the original file uses elsewhere — `[...document.querySelectorAll('.track')].find(t => t.querySelector('.track-header') === (${newTonalHead})).querySelector('.lane')` — which walks from the header's own `.track` ancestor instead of trying to match a lane back to a header.)

- [ ] **Step 10: Run the full suite**

Run: `node verify.js`

Expected: every step prints `ok`, including all the rewritten FX-panel steps and the vibrato audio-graph check.

- [ ] **Step 11: Commit**

```bash
git add index.html verify.js
git commit -m "Replace the always-visible FX slider grid with insert chips and knob popovers

Each track's FX panel now shows only the effects explicitly added (or
already holding a non-default value, so older saved songs still show their
real chips) as removable, bypassable chips. Clicking a chip opens a
popover with one pointer-driven, keyboard-accessible knob per parameter,
replacing the old always-all-visible 2-column slider grid. Bypass is UI/
data only in this commit — it dims the chip and sets state.activeFx, but
does not yet mute the audio graph (next commit)."
```

---

## Task 3: Bypass reaches the audio graph

**Files:**
- Modify: `index.html` (module scope near `chanTremoloLfo` ~6218-6228, the five `applyX` functions and four creation functions ~6374-6470 and ~6686-6727, `getTrackVoice` ~7170-7177)
- Modify: `verify.js` (new step, appended near the end of the FX-panel-adjacent tests)

**Interfaces:**
- Consumes (from Task 1): `isFxBypassed(track, key)`, `FX_FIELD_DEFAULTS`, `DEFAULT_TRACK_EQ`, `DEFAULT_TRACK_COMP`, `DEFAULT_TRACK_CRUSH`, `DEFAULT_TREMOLO`, `DEFAULT_VIBRATO`, `DEFAULT_FX_SEND`.
- Consumes (from Task 2): nothing directly — the UI already writes `state.activeFx[track][key].bypassed` correctly; this task only makes the *audio graph* respect it. No UI code changes.
- Produces: `fxEffective(track, key, rawGetter, DEFAULT)` and five bypass-aware accessors (`effectiveTrackEq`, `effectiveTrackComp`, `effectiveTrackCrush`, `effectiveTrackTremolo`, `effectiveFxSend`, `effectiveTrackVibrato`), used at every point a value is *written* into a Web Audio node — both creation-time (`createChanEq`, `createChanComp`, `createChanTremolo`, `ensureTrackCrusher`, `createTrackFxSends`) and apply-time (`applyFxSend`, `applyTrackEq`, `applyTrackComp`, `applyTrackCrush`, `applyTrackTremolo`, `getTrackVoice`'s vibrato field) — never at the UI/popover layer, which always shows the real dialled-in value via the raw `getTrackX()` getters regardless of bypass.

- [ ] **Step 1: Add `fxEffective` and the six bypass-aware accessors**

In `index.html`, right after the `isFxBypassed` function added in Task 1 (which sits right after `visibleFxFor`), add:

```js
// Bypass-aware value for whatever WRITES a value into the Web Audio graph —
// both a channel's creation-time initial values and every apply*() function
// below. Never used by the UI: a popover's knob always shows the real
// dialled-in value via the plain getTrackX() getters, bypassed or not — see
// TRACK_FX_REGISTRY/buildFxPopover(). One helper rather than gating each of
// the ten call sites by hand, so "what does a bypassed effect actually send
// to the graph" has exactly one answer.
function fxEffective(track, key, rawGetter, DEFAULT) {
  return isFxBypassed(track, key) ? DEFAULT : rawGetter(track);
}
const effectiveTrackEq = (id) => fxEffective(id, 'eq', getTrackEq, DEFAULT_TRACK_EQ);
const effectiveTrackComp = (id) => fxEffective(id, 'comp', getTrackComp, DEFAULT_TRACK_COMP);
const effectiveTrackCrush = (id) => fxEffective(id, 'crush', getTrackCrush, DEFAULT_TRACK_CRUSH);
const effectiveTrackTremolo = (id) => fxEffective(id, 'tremolo', getTrackTremolo, DEFAULT_TREMOLO);
const effectiveTrackVibrato = (id) => fxEffective(id, 'vibrato', getTrackVibrato, DEFAULT_VIBRATO);
// The three sends bypass independently (sendDelay/sendChorus/sendReverb are
// separate chips on one shared state.fxSend[track] object), so this can't
// delegate to the single-key fxEffective() above — it merges per field.
function effectiveFxSend(id) {
  const s = getFxSend(id);
  return {
    delay: isFxBypassed(id, 'sendDelay') ? DEFAULT_FX_SEND.delay : s.delay,
    chorus: isFxBypassed(id, 'sendChorus') ? DEFAULT_FX_SEND.chorus : s.chorus,
    reverb: isFxBypassed(id, 'sendReverb') ? DEFAULT_FX_SEND.reverb : s.reverb,
  };
}
```

- [ ] **Step 2: Wire the five `apply*` functions to the effective accessors**

In `index.html`, find (currently lines 6686-6727):

```js
function applyFxSend() {
  for (const ch of ALL_TRACKS) {
    const s = getFxSend(ch);
    if (trackDelaySend[ch]) trackDelaySend[ch].gain.value = s.delay;
    if (trackChorusSend[ch]) trackChorusSend[ch].gain.value = s.chorus;
    if (trackReverbSend[ch]) trackReverbSend[ch].gain.value = s.reverb;
  }
}
function applyTrackEq() {
  for (const ch of ALL_TRACKS) {
    if (!chanEq[ch]) continue;
    const e = getTrackEq(ch);
    chanEq[ch].low.gain.value = e.low;
    chanEq[ch].mid.gain.value = e.mid;
    chanEq[ch].high.gain.value = e.high;
  }
}
function applyTrackComp() {
  for (const ch of ALL_TRACKS) {
    if (!chanComp[ch]) continue;
    const c = getTrackComp(ch);
    chanComp[ch].threshold.value = c.threshold;
    chanComp[ch].ratio.value = c.ratio;
    chanComp[ch].attack.value = c.attack;
    chanComp[ch].release.value = c.release;
  }
}
function applyTrackCrush() {
  for (const ch of ALL_TRACKS) {
    if (!chanCrush[ch]) continue; // worklet not loaded (or still bypassed) yet — nothing to push to
    chanCrush[ch].parameters.get('hold').value = crushAmountToHold(getTrackCrush(ch).amount);
  }
}
function applyTrackTremolo() {
  for (const ch of ALL_TRACKS) {
    if (!chanTremolo[ch]) continue;
    const t = getTrackTremolo(ch);
    chanTremolo[ch].gain.value = 1 - t.depth / 2;
    chanTremoloLfoGain[ch].gain.value = t.depth / 2;
    chanTremoloLfo[ch].frequency.value = t.rate;
  }
}
```

Replace the five `getTrackX`/`getFxSend` calls with their `effective*` counterparts (everything else unchanged):

```js
function applyFxSend() {
  for (const ch of ALL_TRACKS) {
    const s = effectiveFxSend(ch);
    if (trackDelaySend[ch]) trackDelaySend[ch].gain.value = s.delay;
    if (trackChorusSend[ch]) trackChorusSend[ch].gain.value = s.chorus;
    if (trackReverbSend[ch]) trackReverbSend[ch].gain.value = s.reverb;
  }
}
function applyTrackEq() {
  for (const ch of ALL_TRACKS) {
    if (!chanEq[ch]) continue;
    const e = effectiveTrackEq(ch);
    chanEq[ch].low.gain.value = e.low;
    chanEq[ch].mid.gain.value = e.mid;
    chanEq[ch].high.gain.value = e.high;
  }
}
function applyTrackComp() {
  for (const ch of ALL_TRACKS) {
    if (!chanComp[ch]) continue;
    const c = effectiveTrackComp(ch);
    chanComp[ch].threshold.value = c.threshold;
    chanComp[ch].ratio.value = c.ratio;
    chanComp[ch].attack.value = c.attack;
    chanComp[ch].release.value = c.release;
  }
}
function applyTrackCrush() {
  for (const ch of ALL_TRACKS) {
    if (!chanCrush[ch]) continue; // worklet not loaded (or still bypassed) yet — nothing to push to
    chanCrush[ch].parameters.get('hold').value = crushAmountToHold(effectiveTrackCrush(ch).amount);
  }
}
function applyTrackTremolo() {
  for (const ch of ALL_TRACKS) {
    if (!chanTremolo[ch]) continue;
    const t = effectiveTrackTremolo(ch);
    chanTremolo[ch].gain.value = 1 - t.depth / 2;
    chanTremoloLfoGain[ch].gain.value = t.depth / 2;
    chanTremoloLfo[ch].frequency.value = t.rate;
  }
}
```

- [ ] **Step 3: Wire the four creation-time sites**

In `createChanEq` (index.html, currently line 6381):

```js
  const e = getTrackEq(id);
```

Change to:

```js
  const e = effectiveTrackEq(id);
```

In `createChanComp` (currently line 6390):

```js
  const c = getTrackComp(id);
```

Change to:

```js
  const c = effectiveTrackComp(id);
```

In `createChanTremolo` (currently line 6409):

```js
  const t = getTrackTremolo(id);
```

Change to:

```js
  const t = effectiveTrackTremolo(id);
```

In `ensureTrackCrusher` (currently line 6449):

```js
      parameterData: { hold: crushAmountToHold(getTrackCrush(id).amount) },
```

Change to:

```js
      parameterData: { hold: crushAmountToHold(effectiveTrackCrush(id).amount) },
```

In `createTrackFxSends` (currently lines 6461-6469):

```js
function createTrackFxSends(id) {
  trackDelaySend[id] = ctx.createGain();
  trackDelaySend[id].gain.value = getFxSend(id).delay;
  chanTremolo[id].connect(trackDelaySend[id]).connect(fxDelayBus);
  trackChorusSend[id] = ctx.createGain();
  trackChorusSend[id].gain.value = getFxSend(id).chorus;
  chanTremolo[id].connect(trackChorusSend[id]).connect(fxChorusBus);
  trackReverbSend[id] = ctx.createGain();
  trackReverbSend[id].gain.value = getFxSend(id).reverb;
  chanTremolo[id].connect(trackReverbSend[id]).connect(fxReverbBus);
}
```

Change to:

```js
function createTrackFxSends(id) {
  const s = effectiveFxSend(id);
  trackDelaySend[id] = ctx.createGain();
  trackDelaySend[id].gain.value = s.delay;
  chanTremolo[id].connect(trackDelaySend[id]).connect(fxDelayBus);
  trackChorusSend[id] = ctx.createGain();
  trackChorusSend[id].gain.value = s.chorus;
  chanTremolo[id].connect(trackChorusSend[id]).connect(fxChorusBus);
  trackReverbSend[id] = ctx.createGain();
  trackReverbSend[id].gain.value = s.reverb;
  chanTremolo[id].connect(trackReverbSend[id]).connect(fxReverbBus);
}
```

- [ ] **Step 4: Wire Vibrato at note-schedule time**

In `getTrackVoice` (index.html, currently lines 7170-7177):

```js
function getTrackVoice(track) {
  return {
    adsr: getAdsr(track), filter: getFilterState(track), fm: getFmState(track),
    vib: getTrackVibrato(track), duty: getTrackDuty(track),
    // The free-running sweep shared by every `pwm` note on this track. Absent
    // (a track with no channel yet) falls back to a note-local LFO.
    pwmLfo: chanPwmLfo[track] || null,
  };
}
```

Change `vib: getTrackVibrato(track)` to `vib: effectiveTrackVibrato(track)`:

```js
function getTrackVoice(track) {
  return {
    adsr: getAdsr(track), filter: getFilterState(track), fm: getFmState(track),
    vib: effectiveTrackVibrato(track), duty: getTrackDuty(track),
    // The free-running sweep shared by every `pwm` note on this track. Absent
    // (a track with no channel yet) falls back to a note-local LFO.
    pwmLfo: chanPwmLfo[track] || null,
  };
}
```

(Consistent with the existing comment elsewhere that vibrato's `apply` is a deliberate no-op: a bypass toggle takes effect on the next scheduled note, exactly like a waveform/ADSR/filter change already does — no immediate re-application needed here.)

- [ ] **Step 5: Manual smoke check**

Run: `node dev.js`

In the browser: add EQ to a track, boost Lo to +6dB (should audibly brighten a held/played note or a rendered loop), then click the chip's bypass power icon — the boost should audibly disappear while the knob still reads +6.0dB. Un-bypass — the boost returns. Repeat quickly for Comp or Tremolo if you want a second confirmation; the mechanism is identical for all five.

- [ ] **Step 6: Add a `verify.js` step proving bypass reaches the audio graph**

This needs to observe the actual `BiquadFilterNode.gain` values `applyTrackEq()`/`createChanEq()` write, which isn't visible in the DOM. Reuses the exact instrumentation pattern already in this file (see the `createStereoPanner` patch a few hundred lines up): patch `createBiquadFilter` before the page loads to record every instance in creation order, so the *first* one created — which is the starter project's first track's (Lead's) low-shelf band, since `ensureChannelNodes()`/`buildChannelChain()` builds channels in `state.trackList` order and `createChanEq()` creates `low` before `mid`/`high` — is identifiable without needing to correlate nodes back to track ids.

Add this step near the end of the file, after the last existing FX-panel-adjacent step (a good spot is right before the "Last on purpose" comment ahead of the drum-velocity step, since like that step this one also needs its own fresh page load to install a patch):

```js
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
      await waitFor(`!!document.querySelector('.th-wave-group')`);
      // The starter layout's first tonal track (Lead) is also the first
      // track buildChannelChain() runs for, so its low-shelf band is the
      // first BiquadFilterNode ever created.
      const lowGain = () => cdp.evaluate(`+window.__biquads[0].gain.value.toFixed(3)`);
      if (await lowGain() !== 0) throw new Error(`expected an untouched track's EQ low band at 0dB, got ${await lowGain()}`);

      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'));
        [...head.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-wave-group'))`;
      await cdp.evaluate(`(${headSel}).querySelector('.th-fx-panel').querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!(${headSel}).querySelector('.th-fx-add-menu')`);
      await cdp.evaluate(`[...(${headSel}).querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === 'EQ').click()`);
      await waitFor(`!!(${headSel}).querySelector('.th-fx-popover[data-key="eq"]')`);
      // 0 -> 6 at a 0.5 step is 12 presses.
      await cdp.evaluate(`(() => {
        const dial = [...(${headSel}).querySelector('.th-fx-popover[data-key="eq"]').querySelectorAll('.th-knob')]
          .find(k => k.querySelector('.th-knob-label').textContent === 'Lo').querySelector('.th-knob-dial');
        dial.focus();
        for (let i = 0; i < 12; i++) dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      })()`);
      await waitFor(`window.__biquads[0].gain.value === 6`);

      await cdp.evaluate(`(${headSel}).querySelector('.th-fx-popover[data-key="eq"]').querySelector('.th-fx-chip-bypass').click()`);
      await waitFor(`window.__biquads[0].gain.value === 0`);
      const knobStillSix = await cdp.evaluate(`[...(${headSel}).querySelector('.th-fx-popover[data-key="eq"]').querySelectorAll('.th-knob')]
        .find(k => k.querySelector('.th-knob-label').textContent === 'Lo').querySelector('.th-knob-val').textContent`);
      if (knobStillSix !== '6.0dB') throw new Error(`bypass must not change what the knob displays, Lo now reads ${knobStillSix}`);

      await cdp.evaluate(`(${headSel}).querySelector('.th-fx-popover[data-key="eq"]').querySelector('.th-fx-chip-bypass').click()`);
      await waitFor(`window.__biquads[0].gain.value === 6`);
    });
```

- [ ] **Step 7: Run the full suite**

Run: `node verify.js`

Expected: every step prints `ok`, including the new bypass-reaches-the-audio-graph step.

- [ ] **Step 8: Commit**

```bash
git add index.html verify.js
git commit -m "Make FX bypass actually mute the audio graph

Adds fxEffective()/effective* accessors used at every point a value is
written into a Web Audio node (both channel creation and the five apply*
functions), gated on isFxBypassed(). The UI's popover knobs are untouched
— they always read the raw, un-bypassed value, so bypass mutes what's
heard without ever hiding what's dialled in."
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-28-fx-insert-slots-design.md`):
- §1 data model (`activeFx`, registry split, fixed order, visibility rule) → Task 1.
- §2 UI (chips, add menu, popover, knob widget, bypass button on both chip and popover) → Task 2.
- §3 audio/bypass (bypass changes `apply()` only, not `get()`) → Task 3, extended (correctly, per the design's own intent) to also cover the four creation-time sites the spec's "six call sites" undercounted — a bypassed effect must start neutral when a channel is (re)built, not only when `apply()` next happens to run.
- §4 testing (`verify.js` add/knob/bypass/remove scenario, `auditBundledSongs` extension) → covered across all three tasks' `verify.js` steps.
- Out-of-scope items (fixed lettered slots, reorderable inserts, a real Delay insert, a draggable window) → none of the three tasks introduce any of these.

**Placeholder scan:** no TBD/TODO markers; every step has complete, runnable code or an exact command with its expected output.

**Type consistency:** `effect.key` vs. `effect.dataKey` used consistently across Task 1 (`applySavedMix`, `FX_FIELD_DEFAULTS`), Task 2 (`removeFxChip`, `buildFxPanel`'s Reset) and `verify.js`'s parser — `dataKey` only ever means "which `state`/JSON field", `key` only ever means "which registry entry / activeFx entry / chip". `fxPopoverOpen` keys (`` `${track}::${effectKey}` ``) are built and torn down identically in `buildFxChip`, `buildFxPopover`'s implicit membership check, `removeFxChip`, the add-menu handler, and `removeTrack`'s cleanup.
