# Harmonic (additive) oscillator editor implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 14th oscillator waveform, `harmonics`, that lets a track dial in amplitude + phase per partial (8 of each) instead of picking one of the thirteen fixed shapes — per `docs/superpowers/specs/2026-09-21-harmonic-oscillator-editor-design.md`.

**Architecture:** Four tasks, each ending with a fully green `node verify.js`: (1) the data model and audio engine — the new waveform becomes selectable and audible (as a plain sine, its default) with no panel yet; (2) the UI panel — 16 sliders, four quick-start buttons, a live preview canvas; (3) presets — `harmonics` becomes a sixth captured/applied preset field; (4) save/load validation — `applySavedMix()` and `verify.js`'s bundled-song audit learn the new field's shape.

**Tech Stack:** Plain DOM (`el()`/`glyph()`), no framework, no build step — matches the rest of `index.html`. Tests run through `verify.js`, a headless-Chrome smoke test driven over the Chrome DevTools Protocol (no Jest/pytest in this repo).

**Spec:** `docs/superpowers/specs/2026-09-21-harmonic-oscillator-editor-design.md`

## Global Constraints

- No dependencies, no build step, no bundler — everything lives in `index.html` (plus `verify.js` for testing). Do not add an npm package.
- There is no unit test framework. `index.html` is a `<script type="module">`, so none of its top-level `const`/`function`s (`state`, `getHarmonicsState`, `WAVEFORMS`, ...) are reachable from `verify.js`'s `cdp.evaluate()` calls — only the rendered DOM, `localStorage`, and instrumented native Web Audio APIs are. Every test interaction (switching waveform, dragging a slider, clicking a quick-start button) must go through real DOM events on real elements, exactly like the app's own users would.
- Run the full suite with `node verify.js` from the repo root (~20 minutes). `node verify.js --only <substring>` runs just the steps whose name contains it, for fast iteration on one step. It starts its own dev server and a headless Chromium-family browser (`CHROME_PATH` env var to override, or install Chrome/Chromium/Edge). It fails on any assertion failure *or* any console error/uncaught exception during the run.
- 8 harmonics, fixed (not variable-length). Amplitude is a magnitude, always ≥ 0 (0..1); a Fourier coefficient that would conventionally be negative is expressed as amplitude `|a|` at phase 180°, never as a negative amplitude value.
- Track-level only (`state.harmonics[track]`), no per-note override — same scope as `state.fm`/`state.sync`.
- `state`'s existing helper naming convention: `getX(track)` reads (falls back to a `DEFAULT_X` constant when absent), `setX(track, patch)` merges a patch in. New code follows the same split.
- Every place that saves, restores, clears or removes a track's per-track settings must go through `SPARSE_TRACK_MAPS`, not a hand-written list — this is why `state.harmonics` only needs one line added to that array (Task 1) rather than edits at four call sites (`restoreTrackList()`, `createNewSong()`, `removeTrack()`, `duplicateTrack()` all already loop it generically).
- Follow the existing code style: comments only where something is non-obvious (a spec citation, a bug a naive version would reintroduce, a reason an alternative was rejected) — not what the code visibly does.

---

## Task 1: Data model and audio engine — `harmonics` becomes a selectable, audible waveform

**Files:**
- Modify: `index.html` (`GLYPHS` ~2018, `WAVEFORMS`/`WAVE_LABEL` ~1959-1960, `DEFAULT_SYNC` neighborhood ~2647, per-track state object ~3277, `SPARSE_TRACK_MAPS` ~3325, accessors near `setSyncState` ~3836, `dftToPeriodicWave`/wavetable section ~10373-10417, `resetAudioCaches` ~10645, `setOscWave` ~10822, `DEFAULT_VOICE`/`getTrackVoice` ~10804-10814, `createVoiceSource` ~11166, its three call sites in `scheduleTone`/`schedulePortamentoTone` ~11212/11231/11258)
- Modify: `verify.js` (the `'Waveforms: all thirteen build a distinct sound...'` step ~2793-2979)

**Interfaces:**
- Produces (used by Task 2 and Task 3):
  - `DEFAULT_HARMONICS` — `{ amps: number[8], phases: number[8] }`, a plain sine (amp[0]=1, rest 0, all phases 0).
  - `getHarmonicsState(track)` → `{ amps, phases }` (falls back to `DEFAULT_HARMONICS`).
  - `setHarmonicsState(track, { amps?, phases? })` — merges a patch (replaces whichever of `amps`/`phases` is given, keeps the other).
  - `setHarmonicAmp(track, i, v)` / `setHarmonicPhase(track, i, v)` — clamp-and-set one of the 8 values by index.
  - `'harmonics'` is now a valid member of `WAVEFORMS`, with `WAVE_LABEL.harmonics === 'Harmonics'` and a `GLYPHS.harmonics` entry, so it already appears correctly in the existing waveform picker (`buildFloatingOscMenu()`, unchanged).
  - `getTrackVoice(track).harmonics` — what Task 1's audio engine reads; not yet read by any UI code (that's Task 2).

- [ ] **Step 1: Add the `harmonics` waveform id, label and glyph**

In `index.html`, find (line 1959-1960):

```js
const WAVEFORMS = ['square', 'pwm', 'triangle', 'sawtooth', 'sine', 'halfsine', 'nestri', 'sawtri', 'sync', 'pluck', 'noise', 'ringmod', 'fm']; // selectable per tonal track
const WAVE_LABEL = { square: 'Square', pwm: 'PWM', triangle: 'Triangle', sawtooth: 'Saw', sine: 'Sine', halfsine: 'Half sine', nestri: 'NES Tri', sawtri: 'Saw+Tri', sync: 'Hard sync', pluck: 'Pluck', noise: 'Noise', ringmod: 'Ring', fm: 'FM', kit: 'Kit' };
```

Replace with:

```js
const WAVEFORMS = ['square', 'pwm', 'triangle', 'sawtooth', 'sine', 'halfsine', 'nestri', 'sawtri', 'sync', 'pluck', 'noise', 'ringmod', 'fm', 'harmonics']; // selectable per tonal track
const WAVE_LABEL = { square: 'Square', pwm: 'PWM', triangle: 'Triangle', sawtooth: 'Saw', sine: 'Sine', halfsine: 'Half sine', nestri: 'NES Tri', sawtri: 'Saw+Tri', sync: 'Hard sync', pluck: 'Pluck', noise: 'Noise', ringmod: 'Ring', fm: 'FM', harmonics: 'Harmonics', kit: 'Kit' };
```

Find `GLYPHS`'s `ringmod` entry, the last waveform glyph before the `kit`/drum-kit glyphs (line 2018):

```js
  ringmod:  ['M1 6 q1.5 -4 3 0 t3 0 t3 0 t3 0 t3 0 t3 0 t3 0', 'M1 6 q5.5 -5 11 0 t11 0', 'M1 6 q5.5 5 11 0 t11 0'],
```

Add right after it:

```js
  // Not a fixed shape like every other waveform glyph here — this one is
  // user-defined, so it draws what the control surface actually is (eight
  // bars of independent height, one per harmonic) rather than a curve.
  harmonics: ['M2 10 V6', 'M5 10 V3', 'M8 10 V7', 'M11 10 V4', 'M14 10 V8', 'M17 10 V5', 'M20 10 V2', 'M23 10 V6'],
```

`buildFloatingOscMenu()` (index.html:5741) iterates `WAVEFORMS` generically and calls `glyph(w)`, so the picker needs no further changes — "Harmonics" now appears as a 14th option automatically.

- [ ] **Step 2: Add `DEFAULT_HARMONICS`, `state.harmonics`, and the accessors**

Find `DEFAULT_SYNC` (line 2647):

```js
const DEFAULT_SYNC = { sweep: 0 };
```

Add right after the two `SYNC_SWEEP_*` constants that follow it:

```js
// 8 harmonics, amplitude (0..1, magnitude only — sign lives in phase) + phase
// (degrees, 0..360) per partial. Amplitude 1 / phase 0 on the fundamental and
// silence elsewhere is a plain sine — also what an untouched track would
// build if it were ever put on the `harmonics` waveform.
const DEFAULT_HARMONICS = { amps: [1, 0, 0, 0, 0, 0, 0, 0], phases: [0, 0, 0, 0, 0, 0, 0, 0] };
```

Find the per-track state object's `sync: {},` line (line 3277):

```js
  sync: {},                  // id -> { sweep } (tonal tracks only, waveform === 'sync') — see DEFAULT_SYNC
```

Add right after it:

```js
  harmonics: {},             // id -> { amps: number[8], phases: number[8] } (tonal tracks only, waveform === 'harmonics') — see DEFAULT_HARMONICS
```

Find `SPARSE_TRACK_MAPS` (line 3325):

```js
const SPARSE_TRACK_MAPS = ['automation', 'adsr', 'filter', 'fm', 'arpRate', 'sync', 'fxSend', 'comp', 'crush', 'tremolo', 'vibrato', 'duty', 'eq', 'formant', 'activeFx', 'kit'];
```

Add `'harmonics'`:

```js
const SPARSE_TRACK_MAPS = ['automation', 'adsr', 'filter', 'fm', 'arpRate', 'sync', 'harmonics', 'fxSend', 'comp', 'crush', 'tremolo', 'vibrato', 'duty', 'eq', 'formant', 'activeFx', 'kit'];
```

This alone makes `clearSparseTrackMaps()`, `restoreTrackList()`, `createNewSong()`, `removeTrack()` and `duplicateTrack()` (which `structuredClone()`s every sparse map's per-track value, so the nested `amps`/`phases` arrays are never shared between a track and its copy) all handle `harmonics` with no further edits.

Find `getSyncState`/`setSyncState` (line 3835-3836):

```js
function getSyncState(track) { return state.sync[track] || DEFAULT_SYNC; }
function setSyncState(track, patch) { state.sync[track] = { ...getSyncState(track), ...patch }; }
```

Add right after them:

```js
function getHarmonicsState(track) { return state.harmonics[track] || DEFAULT_HARMONICS; }
function setHarmonicsState(track, patch) { state.harmonics[track] = { ...getHarmonicsState(track), ...patch }; }
function setHarmonicAmp(track, i, v) {
  const amps = getHarmonicsState(track).amps.slice();
  amps[i] = Math.max(0, Math.min(1, v));
  setHarmonicsState(track, { amps });
}
function setHarmonicPhase(track, i, v) {
  const phases = getHarmonicsState(track).phases.slice();
  phases[i] = ((v % 360) + 360) % 360;
  setHarmonicsState(track, { phases });
}
```

(`.slice()` before mutating an index, then passing the *new* array to `setHarmonicsState` — never mutate the array `getHarmonicsState()` just returned in place. When a track has no entry yet, that call returns the shared module-level `DEFAULT_HARMONICS` constant itself, not a per-track copy; mutating its `amps`/`phases` in place would corrupt the default for every other untouched track.)

- [ ] **Step 3: Build a `PeriodicWave` from amplitude+phase, with a per-settings-object cache**

Find the wavetable section's `dftToPeriodicWave` (line 10373) through `getSawTriWave` (line 10417) — add the new function anywhere in that section, e.g. right after `getSawTriWave`:

```js
// The harmonic editor's own waveform: unlike nestri/sawtri/halfsine above,
// which go time-domain samples -> DFT -> PeriodicWave, this one already has
// frequency-domain data (amplitude + phase per harmonic from the UI), so it
// builds the PeriodicWave directly — no DFT needed.
//
// Cached per settings *object*, not per track id: setHarmonicAmp/
// setHarmonicPhase (via setHarmonicsState) always replace state.harmonics[track]
// with a new object rather than mutating in place, so a stale cache entry for
// an edited-away object just becomes unreachable — no manual invalidation to
// write or forget. Cleared wholesale in resetAudioCaches() below, since a
// PeriodicWave (like every other cached wave here) is tied to the
// AudioContext that built it and can't survive a context swap.
let harmonicsWaveCache = new WeakMap();
function getHarmonicsWave(hs) {
  if (harmonicsWaveCache.has(hs)) return harmonicsWaveCache.get(hs);
  const n = hs.amps.length;
  const real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    const a = hs.amps[k - 1], rad = hs.phases[k - 1] * Math.PI / 180;
    real[k] = a * Math.cos(rad);
    imag[k] = -a * Math.sin(rad); // sign convention matches dftToPeriodicWave() above
  }
  const wave = ctx.createPeriodicWave(real, imag);
  harmonicsWaveCache.set(hs, wave);
  return wave;
}
```

Find `resetAudioCaches()` (line 10645):

```js
function resetAudioCaches() {
  noiseBuffer = null;
  crashNoiseBuffer = null;
  pulseWaves.clear();
  crushCurve = null;
  nesTriWave = null;
  halfSineWave = null;
  noiseWaveBuffer = null;
  chanDelays.clear();
  reverbImpulse = null;
  chanReverbs.clear();
  voicePools.clear();
}
```

Add one line:

```js
function resetAudioCaches() {
  noiseBuffer = null;
  crashNoiseBuffer = null;
  pulseWaves.clear();
  crushCurve = null;
  nesTriWave = null;
  halfSineWave = null;
  noiseWaveBuffer = null;
  harmonicsWaveCache = new WeakMap();
  chanDelays.clear();
  reverbImpulse = null;
  chanReverbs.clear();
  voicePools.clear();
}
```

- [ ] **Step 4: Wire `harmonics` into `setOscWave()`/`createVoiceSource()` and the `voice` object**

Find `setOscWave` (line 10822):

```js
function setOscWave(osc, oscType, duty) {
  if (oscType === 'fm' || oscType === 'sine') osc.type = 'sine';
  else if (oscType === 'square' && duty) osc.setPeriodicWave(pulseWave(duty));
  else if (oscType === 'nestri') osc.setPeriodicWave(getNesTriWave());
  else if (oscType === 'sawtri') osc.setPeriodicWave(getSawTriWave());
  else if (oscType === 'halfsine') osc.setPeriodicWave(getHalfSineWave());
  // Ring modulation's carrier is a triangle, the way the SID's is; the
  // modulator that multiplies it is built in createVoiceSource().
  else if (oscType === 'ringmod') osc.type = 'triangle';
  else osc.type = oscType;
}
```

Replace with:

```js
function setOscWave(osc, oscType, duty, harmonics) {
  if (oscType === 'fm' || oscType === 'sine') osc.type = 'sine';
  else if (oscType === 'square' && duty) osc.setPeriodicWave(pulseWave(duty));
  else if (oscType === 'nestri') osc.setPeriodicWave(getNesTriWave());
  else if (oscType === 'sawtri') osc.setPeriodicWave(getSawTriWave());
  else if (oscType === 'halfsine') osc.setPeriodicWave(getHalfSineWave());
  else if (oscType === 'harmonics') osc.setPeriodicWave(getHarmonicsWave(harmonics));
  // Ring modulation's carrier is a triangle, the way the SID's is; the
  // modulator that multiplies it is built in createVoiceSource().
  else if (oscType === 'ringmod') osc.type = 'triangle';
  else osc.type = oscType;
}
```

Find `createVoiceSource` (line 11166):

```js
function createVoiceSource(oscType, duty, freq, fm, sweepLfo, sync) {
```

Change its signature and its one call to `setOscWave` (line 11185, `setOscWave(osc, oscType, duty);`):

```js
function createVoiceSource(oscType, duty, freq, fm, sweepLfo, sync, harmonics) {
```

```js
  setOscWave(osc, oscType, duty, harmonics);
```

(Everything else in `createVoiceSource` — the `noise`/`pwm`/`pluck`/`ringmod` branches — is unaffected; `harmonics` falls through the same default-oscillator path `nestri`/`sawtri`/`halfsine` already use.)

Find `DEFAULT_VOICE`/`getTrackVoice` (line 10804-10814):

```js
const DEFAULT_VOICE = { adsr: DEFAULT_ADSR, filter: DEFAULT_FILTER, fm: DEFAULT_FM, vib: DEFAULT_VIBRATO, duty: null, pwmLfo: null, arpStep: DEFAULT_ARP_STEP, sync: DEFAULT_SYNC };
function getTrackVoice(track) {
  return {
    adsr: getAdsr(track), filter: getFilterState(track), fm: getFmState(track),
    vib: effectiveTrackVibrato(track), duty: getTrackDuty(track),
    // The free-running sweep shared by every `pwm` note on this track. Absent
    // (a track with no channel yet) falls back to a note-local LFO.
    pwmLfo: chanPwmLfo[track] || null,
    arpStep: getArpStep(track), sync: getSyncState(track),
  };
}
```

Replace with:

```js
const DEFAULT_VOICE = { adsr: DEFAULT_ADSR, filter: DEFAULT_FILTER, fm: DEFAULT_FM, vib: DEFAULT_VIBRATO, duty: null, pwmLfo: null, arpStep: DEFAULT_ARP_STEP, sync: DEFAULT_SYNC, harmonics: DEFAULT_HARMONICS };
function getTrackVoice(track) {
  return {
    adsr: getAdsr(track), filter: getFilterState(track), fm: getFmState(track),
    vib: effectiveTrackVibrato(track), duty: getTrackDuty(track),
    // The free-running sweep shared by every `pwm` note on this track. Absent
    // (a track with no channel yet) falls back to a note-local LFO.
    pwmLfo: chanPwmLfo[track] || null,
    arpStep: getArpStep(track), sync: getSyncState(track), harmonics: getHarmonicsState(track),
  };
}
```

Now the three `createVoiceSource(...)` call sites. In `scheduleTone` (line 11212):

```js
  const src = createVoiceSource(oscType, duty, note.freq, voice.fm, voice.pwmLfo, voice.sync);
```
→
```js
  const src = createVoiceSource(oscType, duty, note.freq, voice.fm, voice.pwmLfo, voice.sync, voice.harmonics);
```

Its chorus double, a few lines later (line 11231):

```js
      chorus = createVoiceSource(oscType, duty, note.freq, voice.fm, voice.pwmLfo, voice.sync);
```
→
```js
      chorus = createVoiceSource(oscType, duty, note.freq, voice.fm, voice.pwmLfo, voice.sync, voice.harmonics);
```

And in `schedulePortamentoTone` (line 11258):

```js
  const src = createVoiceSource(oscType, effectiveDuty(note, voice), note.freq, voice.fm, voice.pwmLfo, voice.sync);
```
→
```js
  const src = createVoiceSource(oscType, effectiveDuty(note, voice), note.freq, voice.fm, voice.pwmLfo, voice.sync, voice.harmonics);
```

- [ ] **Step 5: Extend the "Waveforms: all thirteen..." `verify.js` step to fourteen**

In `verify.js`, find the step name and its option-count assertion (line 2793 and 2872):

```js
    step('Waveforms: all thirteen build a distinct sound, none is off in level, and PWM sweeps', async () => {
```
```js
      if (optionValues.length !== 13) throw new Error(`expected 13 waveform options, got ${optionValues.length}`);
```

Change to:

```js
    step('Waveforms: all fourteen build a distinct sound, none is off in level, and PWM sweeps', async () => {
```
```js
      if (optionValues.length !== 14) throw new Error(`expected 14 waveform options, got ${optionValues.length}`);
```

Find the results-count assertion and the FM-at-default-equals-sine check (line 2921-2933):

```js
      const names = Object.keys(results);
      if (names.length !== 13) throw new Error(`rendered ${names.length} waveforms, expected 13`);
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
```

Replace with:

```js
      const names = Object.keys(results);
      if (names.length !== 14) throw new Error(`rendered ${names.length} waveforms, expected 14`);
      const silent = names.filter((n) => results[n].peak <= 0.001);
      if (silent.length) throw new Error(`waveform(s) produced no sound: ${JSON.stringify(silent)}`);
      // FM at its default Depth of 0 IS a plain sine (addFmModulator returns
      // early), and Harmonics at its default (fundamental only, phase 0) IS a
      // plain sine too — so those hashing alike is correct rather than a
      // fall-through. Asserting it keeps the check honest if that changes.
      if (results['fm'].hash !== results['sine'].hash) {
        throw new Error('FM at depth 0 should be identical to a plain sine');
      }
      if (results['harmonics'].hash !== results['sine'].hash) {
        throw new Error('Harmonics at its default (fundamental only) should be identical to a plain sine');
      }
      const others = names.filter((n) => n !== 'fm' && n !== 'harmonics');
      const hashes = new Set(others.map((n) => results[n].hash));
      if (hashes.size !== others.length) {
        throw new Error(`waveforms are not all distinct: ${JSON.stringify(Object.fromEntries(others.map((n) => [n, results[n].hash])))}`);
      }
```

(The RMS/peak level-band loop just below iterates `names` generically — `harmonics` renders as a plain sine at default, which already sits well inside the existing band, so it needs no change.)

- [ ] **Step 6: Run just this step, then the full suite**

Run: `node verify.js --only "Waveforms:"`
Expected: `ok` — Harmonics now appears as a 14th picker option, renders identically to Sine at its default, and every other waveform is unaffected.

Run: `node verify.js`
Expected: every step prints `ok`. Nothing in this task touches any rendering code besides the waveform picker's own data source (`WAVEFORMS`), so every other existing step is unaffected.

- [ ] **Step 7: Commit**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Add a 14th oscillator waveform: user-defined harmonics

Amplitude + phase per harmonic (8 of each), built directly into a
PeriodicWave via createPeriodicWave() — no DFT needed, unlike the
existing time-domain wavetables (nestri/sawtri/halfsine). No panel to
edit it yet; at its default (fundamental only) it is audibly identical
to a plain sine, which the extended Waveforms verify.js step now
asserts explicitly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: UI panel — sliders, quick-start buttons, live preview

**Files:**
- Modify: `index.html` (CSS near `.mfx-cap` ~307, `renderAdsrRow()`'s title logic ~5158-5160 and its FM/Sync group block ~5305-5372)
- Modify: `verify.js` (new step, placed near the other `renderAdsrRow` steps around line 3660)

**Interfaces:**
- Consumes (from Task 1): `getHarmonicsState`, `setHarmonicsState`, `setHarmonicAmp`, `setHarmonicPhase`, `DEFAULT_HARMONICS`.
- Produces: nothing further tasks depend on programmatically — Task 3/4 read and write `state.harmonics` directly via the Task 1 accessors, not through this UI.

- [ ] **Step 1: Add CSS for the new group's layout**

Find (line 306-307):

```css
  .mfx-group { display: flex; align-items: center; gap: 10px; }
  .mfx-cap { font-size: 8px; letter-spacing: 1px; text-transform: uppercase; color: #8f8f9c; font-weight: 700; }
```

Add right after:

```css
  /* The Harmonics group is much wider than its FM/Filter/Arpeggio neighbours
     (16 sliders + a preview + 4 buttons), so unlike the plain .mfx-group it
     wraps — one column per harmonic (amplitude above phase), matching the
     spec's "amplitude above phase, one column per harmonic" layout. */
  .harmonics-group { flex-wrap: wrap; max-width: 720px; }
  .harmonics-pair { display: flex; flex-direction: column; gap: 4px; }
  .harmonics-preview { display: block; width: 120px; height: 40px; background: #1c1c22; border-radius: 4px; }
  .harmonics-quickstart { display: flex; gap: 6px; }
  .harmonics-quickstart button { font-size: 11px; padding: 2px 8px; }
```

- [ ] **Step 2: Add the "Envelope, Filter & Harmonics" title case**

Find (line 5158-5160):

```js
  const title = el('span', 'automation-title'); title.textContent = state.waveform[track] === 'fm' ? 'Envelope, Filter & FM'
    : state.waveform[track] === 'ringmod' ? 'Envelope, Filter & Ring'
    : state.waveform[track] === 'square' ? 'Envelope, Filter & Duty' : 'Envelope & Filter';
```

Replace with:

```js
  const title = el('span', 'automation-title'); title.textContent = state.waveform[track] === 'fm' ? 'Envelope, Filter & FM'
    : state.waveform[track] === 'ringmod' ? 'Envelope, Filter & Ring'
    : state.waveform[track] === 'harmonics' ? 'Envelope, Filter & Harmonics'
    : state.waveform[track] === 'square' ? 'Envelope, Filter & Duty' : 'Envelope & Filter';
```

- [ ] **Step 3: Add the Harmonics group**

Find the end of the FM/Sync/Ring group — its closing brace, right before the unconditional Arpeggio group (line 5371-5374):

```js
    lane.appendChild(modGroup);
  }

  // Arpeggio speed applies whatever the waveform is — a note carries the
```

Insert a new block between them (right after `lane.appendChild(modGroup);\n  }` and before the Arpeggio comment):

```js
  if (state.waveform[track] === 'harmonics') {
    lane.appendChild(el('span', 'adsr-divider'));
    const hGroup = el('div', 'mfx-group harmonics-group');
    const hCap = el('span', 'mfx-cap'); hCap.textContent = 'Harmonics';
    hGroup.appendChild(hCap);

    // Live preview: the same 8-term sine sum getHarmonicsWave() itself builds
    // the PeriodicWave from, so what's drawn tracks what's heard (modulo the
    // engine's own unit-peak normalization, which only rescales the vertical
    // axis, never the shape). Reads state fresh on every call rather than
    // closing over a snapshot, so it stays correct across any number of
    // slider/quick-start edits without needing a full render().
    const canvas = document.createElement('canvas');
    canvas.className = 'harmonics-preview';
    canvas.width = 120; canvas.height = 40;
    function drawPreview() {
      const hs = getHarmonicsState(track);
      const cx = canvas.getContext('2d');
      cx.clearRect(0, 0, canvas.width, canvas.height);
      const n = 128;
      const ys = [];
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        let y = 0;
        for (let k = 0; k < 8; k++) y += hs.amps[k] * Math.sin(2 * Math.PI * (k + 1) * t + hs.phases[k] * Math.PI / 180);
        ys.push(y);
        if (Math.abs(y) > peak) peak = Math.abs(y);
      }
      peak = peak || 1;
      cx.strokeStyle = trackColor(track);
      cx.beginPath();
      ys.forEach((y, i) => {
        const px = (i / n) * canvas.width;
        const py = canvas.height / 2 - (y / peak) * (canvas.height / 2 - 2);
        if (i === 0) cx.moveTo(px, py); else cx.lineTo(px, py);
      });
      cx.stroke();
    }
    drawPreview();
    hGroup.appendChild(canvas);

    // Quick-start: fill the 8 amplitude/phase pairs with a classic waveform's
    // own partial series, then the sliders take over from there — the same
    // "start from something recognizable" pattern the Arpeggio quick-fills
    // use. Amplitude is always >= 0 (a magnitude); a conventionally-negative
    // coefficient is expressed as phase 180 instead.
    const QUICKSTART_SHAPES = {
      Sine: () => ({ amps: [1, 0, 0, 0, 0, 0, 0, 0], phases: [0, 0, 0, 0, 0, 0, 0, 0] }),
      Saw: () => {
        const amps = [], phases = [];
        for (let n = 1; n <= 8; n++) { amps.push(1 / n); phases.push(n % 2 === 0 ? 180 : 0); }
        return { amps, phases };
      },
      Square: () => {
        const amps = new Array(8).fill(0), phases = new Array(8).fill(0);
        for (let n = 1; n <= 8; n += 2) amps[n - 1] = 1 / n;
        return { amps, phases };
      },
      Triangle: () => {
        const amps = new Array(8).fill(0), phases = new Array(8).fill(0);
        let sign = 1;
        for (let n = 1; n <= 8; n += 2) { amps[n - 1] = 1 / (n * n); phases[n - 1] = sign > 0 ? 0 : 180; sign *= -1; }
        return { amps, phases };
      },
    };
    const quickRow = el('div', 'harmonics-quickstart');
    for (const [shapeName, calc] of Object.entries(QUICKSTART_SHAPES)) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = shapeName;
      btn.title = `Fill the harmonics below with ${shapeName}'s own partial series`;
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setHarmonicsState(track, calc());
        const n = trackNotes(track)[0];
        if (n) previewNote(track, n);
        render();
        autosave();
      });
      quickRow.appendChild(btn);
    }
    hGroup.appendChild(quickRow);

    // 8 columns, amplitude above phase, matching the spec's layout — a
    // .harmonics-pair per harmonic rather than one flat row of 16 fields.
    const hs = getHarmonicsState(track);
    for (let k = 0; k < 8; k++) {
      const pair = el('div', 'harmonics-pair');

      const ampField = el('div', 'adsr-field');
      const ampCap = el('span', 'adsr-label'); ampCap.textContent = `H${k + 1} Amp`;
      const ampSlider = document.createElement('input');
      ampSlider.type = 'range'; ampSlider.min = 0; ampSlider.max = 1; ampSlider.step = 0.02; ampSlider.value = hs.amps[k];
      ampSlider.style.accentColor = trackColor(track);
      ampSlider.title = `Amplitude of harmonic ${k + 1}`;
      const ampVal = el('span', 'adsr-val'); ampVal.textContent = Math.round(hs.amps[k] * 100) + '%';
      ampSlider.addEventListener('mousedown', (e) => e.stopPropagation());
      ampSlider.addEventListener('input', () => {
        const v = parseFloat(ampSlider.value);
        ampVal.textContent = Math.round(v * 100) + '%';
        setHarmonicAmp(track, k, v);
        drawPreview();
        autosave();
      });
      ampField.append(ampCap, ampSlider, ampVal);
      pair.appendChild(ampField);

      const phaseField = el('div', 'adsr-field');
      const phaseCap = el('span', 'adsr-label'); phaseCap.textContent = `H${k + 1} Phase`;
      const phaseSlider = document.createElement('input');
      phaseSlider.type = 'range'; phaseSlider.min = 0; phaseSlider.max = 360; phaseSlider.step = 5; phaseSlider.value = hs.phases[k];
      phaseSlider.style.accentColor = trackColor(track);
      phaseSlider.title = `Phase of harmonic ${k + 1}, in degrees`;
      const phaseVal = el('span', 'adsr-val'); phaseVal.textContent = Math.round(hs.phases[k]) + '°';
      phaseSlider.addEventListener('mousedown', (e) => e.stopPropagation());
      phaseSlider.addEventListener('input', () => {
        const v = parseFloat(phaseSlider.value);
        phaseVal.textContent = Math.round(v) + '°';
        setHarmonicPhase(track, k, v);
        drawPreview();
        autosave();
      });
      phaseField.append(phaseCap, phaseSlider, phaseVal);
      pair.appendChild(phaseField);

      hGroup.appendChild(pair);
    }
    lane.appendChild(hGroup);
  }

  // Arpeggio speed applies whatever the waveform is — a note carries the
```

- [ ] **Step 4: Add a `verify.js` step for the panel**

In `verify.js`, add a new step near the other `renderAdsrRow` steps (after the `'Envelope & Filter row: full-word labels, icons, and grouped captions'` step, around line 3660):

```js
    step('Harmonics panel: quick-start fills, a slider edit reaches the file, and the preview draws', async () => {
      await fresh();
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      await cdp.evaluate(`document.querySelector('.track[data-kind="pitch"] .th-osc-trigger').click()`);
      await waitFor(`!!document.querySelector('#floating-layer [role="option"]')`);
      await cdp.evaluate(`(() => {
        [...document.querySelectorAll('#floating-layer [role="option"]')].find(o => /^Harmonics$/.test(o.textContent)).click();
      })()`);
      await cdp.evaluate(`(() => {
        const head = document.querySelectorAll('.track[data-kind="pitch"] .track-header')[0];
        [...head.querySelectorAll('.th-tool-btn')].find(b => /Env/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.harmonics-group')`);

      const labelCount = await cdp.evaluate(`document.querySelectorAll('.harmonics-group .adsr-label').length`);
      if (labelCount !== 16) throw new Error(`expected 16 harmonics fields (8 amp + 8 phase), got ${labelCount}`);
      const quickBtnNames = await cdp.evaluate(`[...document.querySelectorAll('.harmonics-quickstart button')].map(b => b.textContent)`);
      if (JSON.stringify(quickBtnNames) !== JSON.stringify(['Sine', 'Saw', 'Square', 'Triangle'])) {
        throw new Error(`expected the four quick-start buttons in order, got ${JSON.stringify(quickBtnNames)}`);
      }

      const blankPreview = await cdp.evaluate(`(() => {
        const c = document.querySelector('.harmonics-preview');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        return d.some((v, i) => i % 4 !== 3 && v !== 0); // any non-alpha channel non-zero
      })()`);
      if (!blankPreview) throw new Error('the preview canvas should already show the default sine, not be blank');

      const amp1 = () => `[...document.querySelectorAll('.harmonics-group .adsr-field')]
        .find(f => f.querySelector('.adsr-label').textContent === 'H1 Amp').querySelector('input[type=range]')`;
      const savedAmps = () => cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return null;
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find(t => t.name === 'Lead') || {}).id;
        return (d.harmonics || {})[id] || null;
      })()`);

      // Untouched, right after switching to Harmonics: absent from the file,
      // same as every other sparse per-track map's default.
      if (await savedAmps() !== null) throw new Error('an untouched Harmonics track should carry no harmonics key yet');

      // Saw quick-start fills all 8 amplitudes with a 1/n falloff.
      await cdp.evaluate(`[...document.querySelectorAll('.harmonics-quickstart button')].find(b => b.textContent === 'Saw').click()`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find(t => t.name === 'Lead') || {}).id;
        const h = (d.harmonics || {})[id];
        return h && Math.abs(h.amps[1] - 0.5) < 1e-9 && h.phases[1] === 180;
      })()`);

      // A direct slider drag reaches the file too.
      await cdp.evaluate(`(() => { const s = ${amp1()}; s.value = 0.4; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find(t => t.name === 'Lead') || {}).id;
        const h = (d.harmonics || {})[id];
        return h && Math.abs(h.amps[0] - 0.4) < 1e-9;
      })()`);
    });
```

- [ ] **Step 5: Run just this step, then the full suite**

Run: `node verify.js --only "Harmonics panel"`
Expected: `ok`.

Run: `node verify.js`
Expected: every step prints `ok`.

- [ ] **Step 6: Commit**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Add the Harmonics panel: 16 sliders, quick-start fills, a live preview

Lives in the same Env/Filter row FM and Hard sync already extend, with
its own "Envelope, Filter & Harmonics" caption. Four quick-start
buttons fill the 8 amplitude/phase pairs with a classic waveform's own
partial series (amplitude is always non-negative; a conventionally
negative coefficient is phase 180 instead), and a small canvas redraws
live from the same 8-term sine sum the audio engine's PeriodicWave is
built from.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Presets — `harmonics` becomes a sixth preset field

**Files:**
- Modify: `index.html` (`applyPresetToTrack()` ~9381-9395, the `preset-save` click handler ~9440-9450)
- Modify: `verify.js` (new step)

**Interfaces:**
- Consumes (from Task 1 and Task 2): `getHarmonicsState`, `setHarmonicsState`, the `.th-osc-trigger`/`#floating-layer [role="option"]` waveform picker, the `.harmonics-group` panel and its sliders.
- No new interfaces produced — presets are a leaf consumer of Task 1's accessors.

- [ ] **Step 1: Capture and apply `harmonics` in the preset shape**

Find `applyPresetToTrack` (line 9381-9390):

```js
function applyPresetToTrack(track, preset) {
  const t = trackOf(track);
  if (!t || isRhythm(track) || !preset) return;
  if (WAVEFORMS.includes(preset.waveform)) state.waveform[track] = preset.waveform;
  if (preset.adsr) setAdsr(track, preset.adsr);
  if (preset.filter) setFilterState(track, preset.filter);
  if (preset.fm) setFmState(track, preset.fm);
  // `in`, not truthiness: null is a real value here (a plain 50% square), and
  // presets saved before duty existed have no key at all and must not reset it.
  if ('duty' in preset) setTrackDuty(track, preset.duty);
```

Add one line after the `fm` line:

```js
function applyPresetToTrack(track, preset) {
  const t = trackOf(track);
  if (!t || isRhythm(track) || !preset) return;
  if (WAVEFORMS.includes(preset.waveform)) state.waveform[track] = preset.waveform;
  if (preset.adsr) setAdsr(track, preset.adsr);
  if (preset.filter) setFilterState(track, preset.filter);
  if (preset.fm) setFmState(track, preset.fm);
  if (preset.harmonics) setHarmonicsState(track, preset.harmonics);
  // `in`, not truthiness: null is a real value here (a plain 50% square), and
  // presets saved before duty existed have no key at all and must not reset it.
  if ('duty' in preset) setTrackDuty(track, preset.duty);
```

Find the `preset-save` click handler (line 9440-9450):

```js
document.getElementById('preset-save').addEventListener('click', () => {
  const track = presetDialogTrack;
  if (!track) return;
  const name = presetNewNameInput.value.trim();
  if (!name) { presetNewNameInput.focus(); return; }
  const presets = readPresets();
  if (presets[name] && !confirm(`Overwrite preset “${name}”?`)) return;
  presets[name] = { waveform: state.waveform[track], adsr: { ...getAdsr(track) }, filter: { ...getFilterState(track) }, fm: { ...getFmState(track) }, duty: getTrackDuty(track) };
  writePresets(presets);
  presetNewNameInput.value = '';
  renderPresetList();
```

Add `harmonics` to the captured object (arrays copied by value, not by reference, the same rigor `duplicateTrack()`'s `structuredClone()` already applies elsewhere to this exact field):

```js
document.getElementById('preset-save').addEventListener('click', () => {
  const track = presetDialogTrack;
  if (!track) return;
  const name = presetNewNameInput.value.trim();
  if (!name) { presetNewNameInput.focus(); return; }
  const presets = readPresets();
  if (presets[name] && !confirm(`Overwrite preset “${name}”?`)) return;
  const hs = getHarmonicsState(track);
  presets[name] = {
    waveform: state.waveform[track], adsr: { ...getAdsr(track) }, filter: { ...getFilterState(track) },
    fm: { ...getFmState(track) }, duty: getTrackDuty(track),
    harmonics: { amps: hs.amps.slice(), phases: hs.phases.slice() },
  };
  writePresets(presets);
  presetNewNameInput.value = '';
  renderPresetList();
```

- [ ] **Step 2: Add a `verify.js` step for the round trip**

Add a new step (anywhere near the other track-header/preset-adjacent steps):

```js
    step('Presets: harmonics are captured on save and reapplied on load', async () => {
      await fresh();
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      // Dial the Lead track into Harmonics with a non-default amplitude.
      await cdp.evaluate(`document.querySelector('.track[data-kind="pitch"] .th-osc-trigger').click()`);
      await waitFor(`!!document.querySelector('#floating-layer [role="option"]')`);
      await cdp.evaluate(`[...document.querySelectorAll('#floating-layer [role="option"]')].find(o => /^Harmonics$/.test(o.textContent)).click()`);
      await cdp.evaluate(`(() => {
        const head = document.querySelectorAll('.track[data-kind="pitch"] .track-header')[0];
        [...head.querySelectorAll('.th-tool-btn')].find(b => /Env/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.harmonics-group')`);
      await cdp.evaluate(`[...document.querySelectorAll('.harmonics-quickstart button')].find(b => b.textContent === 'Square').click()`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find(t => t.name === 'Lead') || {}).id;
        const h = (d.harmonics || {})[id];
        return h && h.amps[2] > 0 && h.amps[1] === 0; // Square: H3 on, H2 off
      })()`);

      // Save it as a preset.
      await cdp.evaluate(`(() => {
        const head = document.querySelectorAll('.track[data-kind="pitch"] .track-header')[0];
        [...head.querySelectorAll('.th-tool-btn.icon')].find(b => b.title.startsWith('Instrument presets')).click();
      })()`);
      await waitFor(`document.getElementById('preset-dialog').open === true`);
      await cdp.evaluate(`(() => {
        const input = document.getElementById('preset-new-name');
        input.value = 'Test Square Harmonics';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('preset-save').click();
      })()`);
      await waitFor(`(() => {
        try { return !!JSON.parse(localStorage.getItem('music-studio-instrument-presets'))['Test Square Harmonics']; }
        catch { return false; }
      })()`);
      const stored = await cdp.evaluate(`JSON.parse(localStorage.getItem('music-studio-instrument-presets'))['Test Square Harmonics'].harmonics`);
      if (!stored || stored.amps[1] !== 0 || stored.amps[2] <= 0) {
        throw new Error(`preset did not capture the Square harmonics: ${JSON.stringify(stored)}`);
      }
      await cdp.evaluate(`document.getElementById('preset-close').click()`);

      // Reset the track to a plain sawtooth, then reload the preset and
      // confirm the harmonics come back.
      await cdp.evaluate(`document.querySelector('.track[data-kind="pitch"] .th-osc-trigger').click()`);
      await waitFor(`!!document.querySelector('#floating-layer [role="option"]')`);
      await cdp.evaluate(`[...document.querySelectorAll('#floating-layer [role="option"]')].find(o => /^Saw$/.test(o.textContent)).click()`);
      await cdp.evaluate(`(() => {
        const head = document.querySelectorAll('.track[data-kind="pitch"] .track-header')[0];
        [...head.querySelectorAll('.th-tool-btn.icon')].find(b => b.title.startsWith('Instrument presets')).click();
      })()`);
      await waitFor(`document.getElementById('preset-dialog').open === true`);
      await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('#preset-list .song-item')].find(r => r.querySelector('.song-title').textContent === 'Test Square Harmonics');
        row.querySelector('button').click(); // "Load"
      })()`);
      await waitFor(`document.getElementById('preset-dialog').open === false`);
      await waitFor(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        if (!k) return false;
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find(t => t.name === 'Lead') || {}).id;
        return d.waveform[id] === 'harmonics';
      })()`);
      const reapplied = await cdp.evaluate(`(() => {
        const k = Object.keys(localStorage).find(k => k.includes('autosave'));
        const d = JSON.parse(localStorage.getItem(k));
        const id = (d.trackList.find(t => t.name === 'Lead') || {}).id;
        return (d.harmonics || {})[id];
      })()`);
      if (!reapplied || reapplied.amps[1] !== 0 || reapplied.amps[2] <= 0) {
        throw new Error(`loading the preset did not restore the Square harmonics: ${JSON.stringify(reapplied)}`);
      }
      // Clean up the test preset so it doesn't leak into other runs' localStorage.
      await cdp.evaluate(`(() => {
        const p = JSON.parse(localStorage.getItem('music-studio-instrument-presets'));
        delete p['Test Square Harmonics'];
        localStorage.setItem('music-studio-instrument-presets', JSON.stringify(p));
      })()`);
    });
```

(This step reaches into `#preset-list`'s rows via `.song-title`/`button` — the generic `songRow()` structure presets share with the Songs dialog's own rows.)

- [ ] **Step 3: Run just this step, then the full suite**

Run: `node verify.js --only "Presets: harmonics"`
Expected: `ok`.

Run: `node verify.js`
Expected: every step prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Capture and reapply a track's harmonics in the preset system

harmonics becomes a sixth field alongside waveform/adsr/filter/fm/duty
in both the preset-save handler and applyPresetToTrack() — same
conditional-apply pattern the other five already follow.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Save/load validation — `applySavedMix()` and the bundled-song audit

**Files:**
- Modify: `index.html` (`applySavedMix()`, the `sync` block ~3417-3422)
- Modify: `verify.js` (`auditBundledSongs()`'s `TONAL_ONLY` list and its generic sparse-map loop ~138 and ~190-216)

**Interfaces:**
- Consumes (from Task 1): `state.harmonics`, `PITCH_TRACKS`.
- No new interfaces produced — this is the last task, closing the loop between "a song file can carry `harmonics`" and "loading one actually restores it," which Task 1-3 already assumed via `SPARSE_TRACK_MAPS`'s generic handling everywhere *except* the one hand-written, per-field-validated loader (`applySavedMix`) and its matching audit.

- [ ] **Step 1: Load and validate `data.harmonics` in `applySavedMix()`**

Find the `sync` block in `applySavedMix` (currently):

```js
  if (data.sync && typeof data.sync === 'object') {
    for (const ch of PITCH_TRACKS) {
      const v = data.sync[ch] && data.sync[ch].sweep;
      if (typeof v === 'number' && v >= 0 && v <= SYNC_SWEEP_MAX) state.sync[ch] = { sweep: v };
    }
  }
```

Add right after it:

```js
  // Array-shaped, unlike adsr/filter/fm/sync above (all flat "id ->
  // {param: number}"), so it can't ride the generic TRACK_FX_REGISTRY loop
  // below — same reason activeFx gets its own dedicated block there.
  if (data.harmonics && typeof data.harmonics === 'object') {
    for (const ch of PITCH_TRACKS) {
      const h = data.harmonics[ch];
      if (!h || typeof h !== 'object') continue;
      const { amps, phases } = h;
      if (!Array.isArray(amps) || amps.length !== 8 || !Array.isArray(phases) || phases.length !== 8) continue;
      if (!amps.every((v) => typeof v === 'number') || !phases.every((v) => typeof v === 'number')) continue;
      state.harmonics[ch] = {
        amps: amps.map((v) => Math.max(0, Math.min(1, v))),
        phases: phases.map((v) => ((v % 360) + 360) % 360),
      };
    }
  }
```

(Whole-entry drop on malformed shape — same "one bad field/shape drops that entry, not the rest" rule `adsr`/`filter`/`fm` above already follow.)

- [ ] **Step 2: Extend `verify.js`'s `auditBundledSongs()` to know `harmonics`' shape**

Find `TONAL_ONLY` (line 138):

```js
  const TONAL_ONLY = ['adsr', 'filter', 'fm', 'vibrato', 'duty'];
```

Add `'harmonics'`:

```js
  const TONAL_ONLY = ['adsr', 'filter', 'fm', 'vibrato', 'duty', 'harmonics'];
```

(This alone makes the existing generic loop's `if (TONAL_ONLY.includes(key) && isRhythm(id)) add(...)` check cover `harmonics` on a rhythm track. Deliberately **not** adding it to `REQUIRED_FIELDS` — that check assumes a flat `{param: number}` shape via `typeof (v||{})[f] !== 'number'`, which would misfire on `harmonics`' two array fields; it needs its own block instead, same as `activeFx`/`automation` below.)

Find the point right after the generic sparse-map loop closes and right before the `activeFx` dedicated block (inside `for (const file of files) { ... }`, after the `for (const key of [...SPARSE_TRACK_MAPS, ...SEEDED_MAPS]) { ... }` loop's closing `}`):

```js
    // activeFx's own shape (`{ [effectKey]: { bypassed } }`) is one level
    // deeper than the flat "id -> {param: number}" maps the loop above
```

Insert a new block immediately before that comment:

```js
    // harmonics' own shape (`{ amps: number[8], phases: number[8] }`) is
    // array-valued, not the flat "id -> {param: number}" the loop above
    // assumes — same reason activeFx below needs its own block.
    for (const id of Object.keys(song.harmonics || {})) {
      if (!ids.includes(id)) continue; // already reported above
      const h = song.harmonics[id];
      if (!h || typeof h !== 'object') continue;
      if (!Array.isArray(h.amps) || h.amps.length !== 8) add(`harmonics["${id}"].amps should be an 8-element array — dropped on load`);
      else if (h.amps.some((v) => typeof v !== 'number' || v < 0 || v > 1)) add(`harmonics["${id}"].amps has a value outside 0..1`);
      if (!Array.isArray(h.phases) || h.phases.length !== 8) add(`harmonics["${id}"].phases should be an 8-element array — dropped on load`);
      else if (h.phases.some((v) => typeof v !== 'number' || v < 0 || v > 360)) add(`harmonics["${id}"].phases has a value outside 0..360`);
    }
```

- [ ] **Step 3: Run the bundled-song audit, then the full suite**

Run: `node verify.js --only "auditBundledSongs"`

If no step is named exactly that, run the full suite instead — `auditBundledSongs()` runs unconditionally as the very first check before any browser step, so any full run exercises it:

Run: `node verify.js`
Expected: every step prints `ok`. No bundled `songs/*.json` file has a `harmonics` field yet, so the new validation block has nothing to flag on the existing library — it only guards against a hand-edited or future file with a malformed one.

- [ ] **Step 4: Commit**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Load and validate harmonics on song open

applySavedMix() gains a dedicated block for harmonics' array-shaped
{amps, phases} (it can't ride the generic flat-object loader the way
adsr/filter/fm do), clamping amplitude to 0..1 and wrapping phase to
0..360, whole-entry-drop on a malformed shape. verify.js's
auditBundledSongs() learns the same shape, plus that harmonics is
tonal-only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** §1 Data model → Task 1 Steps 1-2. §2 Audio engine → Task 1 Steps 3-4. §3 UI → Task 2. §4 Presets → Task 3. §5 Serialization/validation → Task 4. §6 Testing → a `verify.js` step in each task, plus the extended "Waveforms" step in Task 1.
- **Type/name consistency checked:** `getHarmonicsState`/`setHarmonicsState`/`setHarmonicAmp`/`setHarmonicPhase` (Task 1) are the only accessors referenced anywhere later (Task 2's sliders, Task 3's preset handlers); `getHarmonicsWave(hs)` and `harmonicsWaveCache` (Task 1) are not referenced outside Task 1's own `setOscWave` change. `DEFAULT_HARMONICS`'s shape (`{amps: number[8], phases: number[8]}`) is what every later task's code assumes.
- **The `sawTriWave`-not-reset gap** noted in the spec's §2 is deliberately left alone — flagged there for whoever next touches that neighborhood, not fixed by this plan.
