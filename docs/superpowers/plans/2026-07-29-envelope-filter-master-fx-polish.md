# Envelope & Filter clarity + Master FX visual parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-track Envelope & Filter row self-explanatory (full
words + per-control icons + grouped captions), and restyle the master
track's EQ/Comp/Par Comp/Sidechain/Downsample controls to use the same
icon-chip + floating-popover shell every other track's FX inserts already
use.

**Architecture:** Both changes are additive/presentational only — no DSP,
no state-shape change. Part A restructures `renderAdsrRow()`'s existing
fields into two (sometimes three) captioned `.mfx-group`s and gives each
field an icon. Part B introduces a second registry, `MASTER_FX_REGISTRY`
(parallel to the existing `TRACK_FX_REGISTRY`), and two new builder
functions (`buildMasterFxChip`/`buildMasterFxPopover`) that reuse the exact
chip/popover/knob CSS and the floating-layer portal mechanism the header
redesign already built — but without the per-track add/remove/letter
machinery, since master's five groups are fixed. The static
`#master-fx-panel` markup and its bespoke id-based event-listener wiring
(`syncMasterFxUI()` and friends) are deleted and replaced by the same
"rebuild from state every `render()`" pattern the rest of the app uses.

**Tech Stack:** Vanilla JS/DOM (`index.html`'s single `<script type="module">`), no build step, `verify.js` (headless-Chrome CDP smoke test) for verification.

## Global Constraints

- New icon glyphs go in the existing `GLYPHS` table as bare arrays of SVG
  path `d` strings (the 24×12 wide-box convention every waveform/effect
  icon already uses) — not the `{box, paths}` 24×24 form, which is only for
  square interface buttons.
- No change to any song-file field shape: `state.masterEQ`/`masterComp`/
  `masterParallel`/`sidechain`/`masterCrush`, `state.adsr`/`filter`/`fm`/
  `duty` all keep their exact current shape, defaults, and
  `applySavedMix`/`currentSongData` handling.
- The master FX chip/popover shell reuses the existing `.th-fx-chip`/
  `.th-fx-chip-body`/`.th-fx-popover`/`.th-fx-popover-head`/
  `.th-fx-popover-fields`/`.th-knob*` CSS classes as-is — no new CSS rules
  for the shell itself. The only new classes are `.th-master-fx-chip` and
  `.th-master-fx-popover`, bare JS-selector markers (used by
  `renderFloatingLayer()` and by tests to find/disambiguate a master
  chip/popover from a track one that happens to share the same registry
  key, e.g. both have an `eq` entry) that carry no styling of their own.
- `verify.js` additions use the file's existing `step(name, async () => {
  ... })` + `cdp.evaluate(...)`/`waitFor(...)` pattern — see any existing
  `step('FX panel: ...', ...)` block for the idiom. No new test framework,
  no new assertion helper unless it's reused 3+ times (mirroring
  `addFxEffect`/`stepKnob`/`knobText`, already defined around line 576).
- Follow the file's standing rule: mutate `state`, then call `render()` (and
  `autosave()` where the mutation should persist) — never patch the DOM
  directly outside a render pass, except inside an event-listener body the
  same way the rest of the file already does.

---

## Task 1: New icon glyphs

**Files:**
- Modify: `index.html` (the `GLYPHS` table, currently ending at line 1490
  with the `trash:` entry before the closing `};`)

**Interfaces:**
- Produces: eight new `GLYPHS` keys — `attack`, `decay`, `sustain`,
  `release`, `cutoff`, `resonance`, `envAmount` (consumed by Task 2) and
  `duck` (consumed by Task 3's `MASTER_FX_REGISTRY`).

- [ ] **Step 1: Add the new entries**

Open `index.html` and find the "Effects." glyph group (around line 1418,
just above `const eq: […]`). Add the seven envelope/filter icons there,
right after the existing `send:` entry (line 1431) and before the
`// ---- Interface icons (square) ----` comment (line 1433):

```js
  send:     ['M1 6 h14', 'M11 2 l4 4 l-4 4'],                             // signal tapped off to a shared bus
  // Envelope stages, drawn as one consistent family so they read together:
  // steeper/shallower rises and falls, ending at different heights.
  attack:    ['M2 10 L20 2'],                                             // steep rise
  decay:     ['M2 2 L20 8'],                                              // falls partway, not to zero
  sustain:   ['M2 6 H22'],                                                // held flat
  release:   ['M2 6 L20 11'],                                             // falls to (near) zero
  // Filter response curves, building on the `eq` glyph's curve language
  // above rather than a new visual idiom for "frequency response."
  cutoff:    ['M1 3 H12 C17 3 18 3 22 10'],                                // flat, then rolls off
  resonance: ['M1 8 H8 C11 8 11 1 14 1 C17 1 17 8 22 8'],                  // rolloff with a resonant peak at the knee
  envAmount: ['M1 8 H10 C15 8 15 8 19 3', 'M16 1 L19 3 L17 6'],            // rolloff curve + arrowhead: the knee sweeps
  // Sidechain ducking: a level pumping down and recovering, twice — distinct
  // from `tremolo`'s evenly-spaced vertical bars (a smooth LFO, not a duck).
  duck:      ['M1 6 H5 L7 10 L9 6 H14 L16 10 L18 6 H23'],
```

- [ ] **Step 2: Verify the glyphs render without error**

Run: `node dev-server.js &` (or use an already-running instance), then in
a browser (or via a CDP script, same pattern as the ad hoc scripts already
in the scratchpad dir) evaluate:

```js
['attack','decay','sustain','release','cutoff','resonance','envAmount','duck']
  .map(name => { try { return { name, ok: !!glyph(name).querySelectorAll('path').length }; }
                  catch (e) { return { name, ok: false, err: e.message }; } })
```

Expected: all eight report `ok: true`. If `glyph()` throws or returns an
empty `<svg>`, the entry's array syntax has a typo (missing comma, unclosed
bracket).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add attack/decay/sustain/release/cutoff/resonance/envAmount/duck glyphs"
```

---

## Task 2: Envelope & Filter row — full labels, icons, grouped captions

**Files:**
- Modify: `index.html` — `ADSR_FIELDS` (line 3588), `renderAdsrRow()` (line
  3602-3776), and the `.adsr-*` CSS block (lines 605-616).

**Interfaces:**
- Consumes: the eight glyphs from Task 1 (`attack`/`decay`/`sustain`/
  `release`/`cutoff`/`resonance`/`envAmount`), and the existing `.mfx-group`/
  `.mfx-cap` CSS classes (lines 277-278) — reused verbatim as the group
  caption, the same way the master FX panel already uses them.
- Produces: no new functions/exports — this task only changes what
  `renderAdsrRow()` builds internally.

- [ ] **Step 1: Full-word labels in `ADSR_FIELDS`**

Replace (line 3588-3593):

```js
const ADSR_FIELDS = [
  ['attack', 'A', 0, 0.5, 0.01],
  ['decay', 'D', 0, 0.5, 0.01],
  ['sustain', 'S', 0, 1, 0.01],
  ['release', 'R', 0.02, 0.6, 0.01],
];
```

with:

```js
const ADSR_FIELDS = [
  ['attack', 'Attack', 0, 0.5, 0.01],
  ['decay', 'Decay', 0, 0.5, 0.01],
  ['sustain', 'Sustain', 0, 1, 0.01],
  ['release', 'Release', 0.02, 0.6, 0.01],
];
```

- [ ] **Step 2: CSS — let labels size to their (now longer) text, add room for an icon**

Replace (line 607):

```css
  .adsr-label { font-size: 11px; font-weight: 700; color: var(--muted); width: 34px; text-align: center; }
```

with:

```css
  .adsr-label { display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; color: var(--muted); white-space: nowrap; }
  .adsr-label .glyph { width: 16px; height: 8px; flex: 0 0 auto; }
```

- [ ] **Step 3: Rewrite `renderAdsrRow()`'s field-building body**

Replace the whole body from the `const adsr = getAdsr(track);` line (3624)
through the end of the FM/Ring block (3772), i.e. everything between the
`lane.setAttribute('aria-label', …)` line and `row.append(header, gutter,
lane); return row;`, with:

```js
  const adsr = getAdsr(track);
  // A small local helper so every field's caption is built the same way:
  // icon + full word, instead of the old bare-letter <span>.
  function fieldLabel(iconName, text) {
    const cap = el('span', 'adsr-label');
    cap.appendChild(glyph(iconName));
    const t = document.createElement('span'); t.textContent = text;
    cap.appendChild(t);
    return cap;
  }

  const envGroup = el('div', 'mfx-group');
  const envCap = el('span', 'mfx-cap'); envCap.textContent = 'Envelope';
  envGroup.appendChild(envCap);
  for (const [key, label, min, max, step] of ADSR_FIELDS) {
    const field = el('div', 'adsr-field');
    const cap = fieldLabel(key, label);
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = min; slider.max = max; slider.step = step; slider.value = adsr[key];
    slider.style.accentColor = trackColor(track);
    slider.title = key.charAt(0).toUpperCase() + key.slice(1);
    const val = el('span', 'adsr-val'); val.textContent = Math.round(adsr[key] * 100) + '%';
    slider.addEventListener('mousedown', (e) => e.stopPropagation());
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      val.textContent = Math.round(v * 100) + '%';
      setAdsr(track, { [key]: v });
      autosave();
    });
    field.append(cap, slider, val);
    envGroup.appendChild(field);
  }
  lane.appendChild(envGroup);
  lane.appendChild(el('span', 'adsr-divider'));

  const filterGroup = el('div', 'mfx-group');
  const filterCap = el('span', 'mfx-cap'); filterCap.textContent = 'Filter';
  filterGroup.appendChild(filterCap);

  const filterState = getFilterState(track);
  const cutoffField = el('div', 'adsr-field');
  const cutoffCap = fieldLabel('cutoff', 'Cutoff');
  const cutoffSlider = document.createElement('input');
  cutoffSlider.type = 'range'; cutoffSlider.min = 0; cutoffSlider.max = 1; cutoffSlider.step = 0.001;
  cutoffSlider.value = hzToSlider(filterState.cutoff);
  cutoffSlider.style.accentColor = trackColor(track);
  cutoffSlider.title = 'Filter cutoff (lowpass)';
  const cutoffVal = el('span', 'adsr-val'); cutoffVal.textContent = Math.round(filterState.cutoff);
  cutoffSlider.addEventListener('mousedown', (e) => e.stopPropagation());
  cutoffSlider.addEventListener('input', () => {
    const hz = Math.round(sliderToHz(parseFloat(cutoffSlider.value)));
    cutoffVal.textContent = hz;
    setFilterState(track, { cutoff: hz });
    autosave();
  });
  cutoffField.append(cutoffCap, cutoffSlider, cutoffVal);
  filterGroup.appendChild(cutoffField);

  const qField = el('div', 'adsr-field');
  const qCap = fieldLabel('resonance', 'Resonance');
  const qSlider = document.createElement('input');
  qSlider.type = 'range'; qSlider.min = 0.1; qSlider.max = 20; qSlider.step = 0.1; qSlider.value = filterState.q;
  qSlider.style.accentColor = trackColor(track);
  qSlider.title = 'Filter resonance';
  const qVal = el('span', 'adsr-val'); qVal.textContent = filterState.q.toFixed(1);
  qSlider.addEventListener('mousedown', (e) => e.stopPropagation());
  qSlider.addEventListener('input', () => {
    const q = parseFloat(qSlider.value);
    qVal.textContent = q.toFixed(1);
    setFilterState(track, { q });
    autosave();
  });
  qField.append(qCap, qSlider, qVal);
  filterGroup.appendChild(qField);

  const envAmtField = el('div', 'adsr-field');
  const envAmtCap = fieldLabel('envAmount', 'Env Amount');
  const envSlider = document.createElement('input');
  envSlider.type = 'range'; envSlider.min = -1; envSlider.max = 1; envSlider.step = 0.05; envSlider.value = filterState.envAmount;
  envSlider.style.accentColor = trackColor(track);
  envSlider.title = 'Filter envelope amount — sweeps the cutoff using the envelope above (0 = off)';
  const envVal = el('span', 'adsr-val'); envVal.textContent = Math.round(filterState.envAmount * 100) + '%';
  envSlider.addEventListener('mousedown', (e) => e.stopPropagation());
  envSlider.addEventListener('input', () => {
    const amt = parseFloat(envSlider.value);
    envVal.textContent = Math.round(amt * 100) + '%';
    setFilterState(track, { envAmount: amt });
    autosave();
  });
  envAmtField.append(envAmtCap, envSlider, envVal);
  filterGroup.appendChild(envAmtField);
  lane.appendChild(filterGroup);

  // Same rule as before: a waveform-specific per-track synth setting, shown
  // only for the waveform it applies to — now captioned like the two groups
  // above instead of trailing off the row bare.
  if (state.waveform[track] === 'square') {
    lane.appendChild(el('span', 'adsr-divider'));
    const dutyGroup = el('div', 'mfx-group');
    const dutyGroupCap = el('span', 'mfx-cap'); dutyGroupCap.textContent = 'Duty';
    dutyGroup.appendChild(dutyGroupCap);
    const dutyField = el('div', 'adsr-field');
    const dutyCap = document.createElement('span'); dutyCap.textContent = 'Width';
    const dutySelect = document.createElement('select');
    dutySelect.className = 'adsr-select';
    dutySelect.title = 'Pulse width for this track. A note can override it from the inspector.';
    const trackDuty = getTrackDuty(track);
    for (const v of [null, ...DUTY_VALUES]) {
      const opt = document.createElement('option');
      opt.value = v ?? '';
      opt.textContent = v == null ? 'Square (50%)' : dutyLabel(v);
      if (trackDuty === v) opt.selected = true;
      dutySelect.appendChild(opt);
    }
    dutySelect.addEventListener('mousedown', (e) => e.stopPropagation());
    dutySelect.addEventListener('change', (e) => {
      e.stopPropagation();
      setTrackDuty(track, dutySelect.value === '' ? null : parseFloat(dutySelect.value));
      const n = state.tracks[track][0];
      if (n) previewNote(track, n);
      render(); // the note inspector's own Duty label names the track default
      autosave();
    });
    dutyField.append(dutyCap, dutySelect);
    dutyGroup.appendChild(dutyField);
    lane.appendChild(dutyGroup);
  }

  // Ring modulation uses the same Ratio as FM (a modulator at a multiple of the
  // note's frequency), so it gets the slider too — but not Depth, which has no
  // meaning there: the multiplication is always full.
  if (state.waveform[track] === 'fm' || state.waveform[track] === 'ringmod') {
    lane.appendChild(el('span', 'adsr-divider'));
    const modGroup = el('div', 'mfx-group');
    const modGroupCap = el('span', 'mfx-cap');
    modGroupCap.textContent = state.waveform[track] === 'fm' ? 'FM' : 'Ring';
    modGroup.appendChild(modGroupCap);

    const fmState = getFmState(track);
    const ratioField = el('div', 'adsr-field');
    const ratioCap = document.createElement('span'); ratioCap.textContent = 'Ratio';
    const ratioSlider = document.createElement('input');
    ratioSlider.type = 'range'; ratioSlider.min = 0.5; ratioSlider.max = 12; ratioSlider.step = 0.5; ratioSlider.value = fmState.ratio;
    ratioSlider.style.accentColor = trackColor(track);
    ratioSlider.title = 'FM modulator frequency, as a multiple of the note\'s own frequency';
    const ratioVal = el('span', 'adsr-val'); ratioVal.textContent = fmState.ratio.toFixed(1);
    ratioSlider.addEventListener('mousedown', (e) => e.stopPropagation());
    ratioSlider.addEventListener('input', () => {
      const ratio = parseFloat(ratioSlider.value);
      ratioVal.textContent = ratio.toFixed(1);
      setFmState(track, { ratio });
      autosave();
    });
    ratioField.append(ratioCap, ratioSlider, ratioVal);
    modGroup.appendChild(ratioField);

    if (state.waveform[track] === 'ringmod') { lane.appendChild(modGroup); row.append(header, gutter, lane); return row; }
    const depthField = el('div', 'adsr-field');
    const depthCap = document.createElement('span'); depthCap.textContent = 'Depth';
    const depthSlider = document.createElement('input');
    depthSlider.type = 'range'; depthSlider.min = 0; depthSlider.max = 1; depthSlider.step = 0.02; depthSlider.value = fmState.depth;
    depthSlider.style.accentColor = trackColor(track);
    depthSlider.title = 'FM modulation depth (0 = plain sine)';
    const depthVal = el('span', 'adsr-val'); depthVal.textContent = Math.round(fmState.depth * 100) + '%';
    depthSlider.addEventListener('mousedown', (e) => e.stopPropagation());
    depthSlider.addEventListener('input', () => {
      const depth = parseFloat(depthSlider.value);
      depthVal.textContent = Math.round(depth * 100) + '%';
      setFmState(track, { depth });
      autosave();
    });
    depthField.append(depthCap, depthSlider, depthVal);
    modGroup.appendChild(depthField);
    lane.appendChild(modGroup);
  }

  row.append(header, gutter, lane);
  return row;
```

Note: the Duty field's own inline caption changes from "Duty" to "Width"
(since the group caption now says "Duty" — repeating the same word twice on
one row reads oddly), and its `<span>` no longer needs `fieldLabel()`'s icon
wrapper — a select's own option text already says what it does, matching
the FM/Ring group's plain "Ratio"/"Depth" captions right below it.

- [ ] **Step 4: Manual verification**

Run `node dev-server.js` and open the app. Select the starter Lead track
(waveform `square`), click the **Env** tool toggle, and confirm:
- Two labelled groups, "Envelope" and "Filter", each with an icon next to
  every field's full-word label (Attack/Decay/Sustain/Release,
  Cutoff/Resonance/Env Amount).
- A third "Duty" group with the pulse-width dropdown.
- Dragging a slider still updates its value readout and the sound (spot
  check by placing a note).

Switch the track's waveform to `fm` and confirm the third group now reads
"FM" with Ratio/Depth sliders; switch to `ringmod` and confirm it reads
"Ring" with only Ratio.

If a real browser isn't available in this environment, drive the same
checks headlessly via CDP (same pattern as the scratchpad's
`osc-menu-check.js`): navigate to the app, click `.th-tool-btn` containing
"Env", then read `document.querySelectorAll('.mfx-cap')` text content and
confirm `['Envelope', 'Filter', 'Duty']` (or `'FM'`/`'Ring'` depending on
waveform).

- [ ] **Step 5: Run the full verify.js suite to confirm nothing existing broke**

Run: `node verify.js`
Expected: all steps pass (the two pre-existing flaky steps — Chord presets
and Recording — may need one re-run; see the `flaky_verify_tests` memory).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Envelope & Filter row: full-word labels, per-control icons, grouped captions"
```

---

## Task 3: Master FX rendering engine

**Files:**
- Modify: `index.html` — `buildKnob()` (line 3795-3870) and its one call
  site in `buildFxPopover()` (line 3963-3966); add `MASTER_FX_REGISTRY`
  after `isFxBypassed()` (line 2993); add `masterFxPopoverOpen` next to
  `fxPopoverOpen` (line 3540); extend `anyFloatingMenuOpen()`/
  `closeAllFloatingMenus()` (lines 3554-3555); add
  `buildMasterFxChip()`/`buildMasterFxPopover()`/`renderMasterFxChips()`
  after `buildFxPopover()` (line 3969); extend `renderFloatingLayer()` (line
  3081) and `render()` (line 3036).

**Interfaces:**
- Consumes: `getMasterEQ`/`getMasterComp`/`getMasterParallel`/
  `getSidechain`/`getMasterCrush`, `applyMasterFX`/`applyMasterCrush`
  (existing), `dbFormat`/`pctFormat` (existing), the `duck` glyph from Task
  1, `el`/`glyph` (existing).
- Produces: `MASTER_FX_REGISTRY`, `MASTER_FX_FIELD_DEFAULTS`,
  `isMasterFxActive(effect)`, `buildMasterFxChip(effect)`,
  `buildMasterFxPopover(effect)`, `renderMasterFxChips()` — all consumed by
  Task 4's HTML rewrite (`renderMasterFxChips()` needs a `#master-fx-chip-row`
  container that Task 4 adds) and by `render()`/`renderFloatingLayer()`
  (wired in this task already).
- `buildKnob`'s signature changes from `(track, effect, field, value,
  onInput)` to `(ariaLabel, field, value, onInput, defaultValue)` — this is
  a breaking change to its one existing caller, updated in Step 1 below in
  the same commit so the app never sits in a half-migrated state.

- [ ] **Step 1: Generalize `buildKnob()` to not require a track**

Replace the signature line and the two places inside it that use
`track`/`effect` (line 3795, 3804, 3858):

```js
function buildKnob(track, effect, field, value, onInput) {
```
→
```js
function buildKnob(ariaLabel, field, value, onInput, defaultValue) {
```

```js
  dial.setAttribute('aria-label', `${field.label} — ${effect.label} on ${trackName(track)}`);
```
→
```js
  dial.setAttribute('aria-label', ariaLabel);
```

```js
  dial.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    commit(FX_FIELD_DEFAULTS[effect.key][field.param]);
  });
```
→
```js
  dial.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    commit(defaultValue);
  });
```

Then update `buildFxPopover()`'s call site (line 3963-3966):

```js
  for (const f of effect.fields) {
    fields.appendChild(buildKnob(track, effect, f, values[f.param],
      (v) => { effect.set(track, { [f.param]: v }); effect.apply(); autosave(); }));
  }
```
→
```js
  for (const f of effect.fields) {
    fields.appendChild(buildKnob(`${f.label} — ${effect.label} on ${trackName(track)}`, f, values[f.param],
      (v) => { effect.set(track, { [f.param]: v }); effect.apply(); autosave(); },
      FX_FIELD_DEFAULTS[effect.key][f.param]));
  }
```

- [ ] **Step 2: Verify per-track FX popovers still work**

Run: `node verify.js` — the `FX panel: …` steps (knob drag via keyboard,
double-click reset behaviour is exercised indirectly through the existing
Reset-button steps) must all still pass. This confirms the refactor didn't
change per-track FX behaviour before Master FX code starts depending on it.

- [ ] **Step 3: Add `MASTER_FX_REGISTRY`**

Insert immediately after `function isFxBypassed(track, key) { … }` closes
(line 2993), before the `// Bypass-aware value for whatever WRITES …`
comment:

```js
// Master-bus counterpart to TRACK_FX_REGISTRY, driving the same chip +
// floating-popover shell (buildMasterFxChip/buildMasterFxPopover below) —
// but master's five groups are fixed (no add/remove, no letter prefix) and
// four of them are "neutral by default" the same way a track insert is, so
// isMasterFxActive() below drives a dim-when-neutral display cue instead of
// a real bypass toggle. Sidechain is the one exception: ducking is a
// discrete on/off (state.sidechain.enabled), not a knob resting at zero, so
// its popover gets a real On/Off toggle and its "active" check reads
// `enabled` directly. Deliberately a separate table from TRACK_FX_REGISTRY
// (its own MASTER_FX_FIELD_DEFAULTS below, never mixed with
// FX_FIELD_DEFAULTS) even though a couple of entries reuse the same *icon*
// as their per-track counterpart — same precedent as the three per-track
// sends sharing one 'send' icon.
const MASTER_FX_REGISTRY = [
  {
    key: 'eq', label: 'EQ', icon: 'eq',
    get: getMasterEQ,
    set: (patch) => { state.masterEQ = { ...getMasterEQ(), ...patch }; },
    apply: () => { if (masterFXNodes) applyMasterFX(masterFXNodes, getMasterEQ(), getMasterComp(), getMasterParallel()); },
    fields: [
      { param: 'low', label: 'Lo', title: 'Low shelf (~200Hz)', min: -12, max: 12, step: 0.5, format: dbFormat },
      { param: 'mid', label: 'Mid', title: 'Mid peak (~1kHz)', min: -12, max: 12, step: 0.5, format: dbFormat },
      { param: 'high', label: 'Hi', title: 'High shelf (~4kHz)', min: -12, max: 12, step: 0.5, format: dbFormat },
    ],
  },
  {
    key: 'comp', label: 'Comp', icon: 'comp',
    get: getMasterComp,
    set: (patch) => { state.masterComp = { ...getMasterComp(), ...patch }; },
    apply: () => { if (masterFXNodes) applyMasterFX(masterFXNodes, getMasterEQ(), getMasterComp(), getMasterParallel()); },
    fields: [
      { param: 'threshold', label: 'Thr', title: 'Threshold', min: -60, max: 0, step: 1, format: (v) => v.toFixed(0) + 'dB' },
      { param: 'ratio', label: 'Rat', title: 'Ratio (1:1 = off)', min: 1, max: 20, step: 0.5, format: (v) => v.toFixed(1) + ':1' },
      { param: 'attack', label: 'Atk', title: 'Attack', min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) + 's' },
      { param: 'release', label: 'Rel', title: 'Release', min: 0.01, max: 1, step: 0.01, format: (v) => v.toFixed(2) + 's' },
    ],
  },
  {
    key: 'parcomp', label: 'Par Comp', icon: 'comp',
    get: getMasterParallel,
    set: (patch) => { state.masterParallel = { ...getMasterParallel(), ...patch }; },
    apply: () => { if (masterFXNodes) applyMasterFX(masterFXNodes, getMasterEQ(), getMasterComp(), getMasterParallel()); },
    fields: [
      { param: 'blend', label: 'Blend', title: 'Parallel ("New York") compression blend — mixes in a much harder-compressed copy alongside the main signal', min: 0, max: 1, step: 0.02, format: pctFormat },
    ],
  },
  {
    key: 'sidechain', label: 'Sidechain', icon: 'duck',
    get: getSidechain,
    set: (patch) => { state.sidechain = { ...getSidechain(), ...patch }; },
    apply: () => {}, // ducking reads getSidechain() live on every kick/snare hit — nothing to push
    fields: [
      { param: 'depth', label: 'Depth', title: 'How far the master bus ducks on each kick/snare hit', min: 0.05, max: 0.95, step: 0.05, format: pctFormat },
    ],
  },
  {
    key: 'crush', label: 'Downsample', icon: 'crush',
    get: getMasterCrush,
    set: (patch) => { state.masterCrush = { ...getMasterCrush(), ...patch }; },
    apply: () => applyMasterCrush(getMasterCrush().amount),
    fields: [
      { param: 'amount', label: 'Amt', title: 'Lo-fi sample-and-hold downsampler (AudioWorklet) on the master bus — 0 = full quality', min: 0, max: 1, step: 0.05, format: pctFormat },
    ],
  },
];
const MASTER_FX_FIELD_DEFAULTS = {
  eq: DEFAULT_MASTER_EQ,
  comp: DEFAULT_MASTER_COMP,
  parcomp: DEFAULT_MASTER_PARALLEL,
  sidechain: DEFAULT_SIDECHAIN,
  crush: DEFAULT_MASTER_CRUSH,
};
// Sidechain's "is this doing anything" cue is its own enabled flag, not
// field-equality against defaults (depth is meaningless while disabled).
function isMasterFxActive(effect) {
  if (effect.key === 'sidechain') return getSidechain().enabled;
  const v = effect.get();
  const d = MASTER_FX_FIELD_DEFAULTS[effect.key];
  return !effect.fields.every((f) => v[f.param] === d[f.param]);
}
```

(`getMasterEQ`/`getMasterComp`/`getMasterParallel`/`getSidechain`/
`getMasterCrush`/`applyMasterFX`/`applyMasterCrush`/`DEFAULT_MASTER_*`/
`DEFAULT_SIDECHAIN` are all plain `function`/`const` declarations elsewhere
in the same top-level script scope, so referencing them here ahead of their
textual position is safe — same as `TRACK_FX_REGISTRY` already doing this
with `getTrackEq` etc.)

- [ ] **Step 4: Add `masterFxPopoverOpen` and extend the floating-menu helpers**

Replace (line 3540):

```js
const fxPopoverOpen = new Set();
```
with:
```js
const fxPopoverOpen = new Set();
const masterFxPopoverOpen = new Set(); // effect keys only — one master, no track id to prefix
```

Replace (lines 3554-3555):

```js
function anyFloatingMenuOpen() { return fxPopoverOpen.size > 0 || fxAddMenuOpen != null || oscPickerOpen != null; }
function closeAllFloatingMenus() { fxPopoverOpen.clear(); fxAddMenuOpen = null; oscPickerOpen = null; }
```
with:
```js
function anyFloatingMenuOpen() { return fxPopoverOpen.size > 0 || masterFxPopoverOpen.size > 0 || fxAddMenuOpen != null || oscPickerOpen != null; }
function closeAllFloatingMenus() { fxPopoverOpen.clear(); masterFxPopoverOpen.clear(); fxAddMenuOpen = null; oscPickerOpen = null; }
```

- [ ] **Step 5: Add the builder functions**

Insert immediately after `buildFxPopover()` closes (line 3969), before
`function buildFxPanel(track) {`:

```js
// Master counterpart to buildFxChip/buildFxPopover — same chip/popover
// shell and CSS classes (an extra `th-master-fx-chip` class distinguishes
// it from a track chip for renderFloatingLayer()'s lookup below, since
// master chips carry no data-track), but no letter, no bypass/remove
// buttons: master's five groups are fixed, and isMasterFxActive() drives
// the dimmed look instead of a stored bypass flag.
function buildMasterFxChip(effect) {
  const active = isMasterFxActive(effect);
  const open = masterFxPopoverOpen.has(effect.key);
  const chip = el('div', 'th-fx-chip th-master-fx-chip' + (!active ? ' bypassed' : '') + (open ? ' open' : ''));
  chip.dataset.key = effect.key;
  const body = el('button', 'th-fx-chip-body');
  body.type = 'button';
  body.title = effect.label + ' (Master)';
  body.setAttribute('aria-label', effect.label + ', Master');
  body.appendChild(glyph(effect.icon));
  const label = document.createElement('span'); label.textContent = effect.label;
  body.appendChild(label);
  body.addEventListener('mousedown', (e) => e.stopPropagation());
  body.addEventListener('click', (e) => {
    e.stopPropagation();
    if (masterFxPopoverOpen.has(effect.key)) masterFxPopoverOpen.delete(effect.key); else masterFxPopoverOpen.add(effect.key);
    render();
  });
  chip.appendChild(body);
  return chip;
}
function buildMasterFxPopover(effect) {
  const active = isMasterFxActive(effect);
  // `th-master-fx-popover` is the disambiguator: a track's EQ popover and
  // master's EQ popover both use the registry key 'eq', so anything
  // selecting by [data-key] alone (tests, renderFloatingLayer's own lookup
  // above) would otherwise match whichever one happens to be first in the
  // DOM if both were open at once.
  const pop = el('div', 'th-fx-popover th-master-fx-popover' + (!active ? ' bypassed' : ''));
  pop.dataset.key = effect.key;
  const head = el('div', 'th-fx-popover-head');
  head.appendChild(glyph(effect.icon));
  const title = document.createElement('span'); title.textContent = effect.label;
  head.append(title, el('span', 'th-fx-popover-head-spacer'));
  // Sidechain is the one master group with a real on/off, shown where a
  // track chip's bypass button would sit — see MASTER_FX_REGISTRY's comment.
  if (effect.key === 'sidechain') {
    const sc = getSidechain();
    const toggle = el('button', 'icon-btn');
    toggle.type = 'button';
    toggle.textContent = sc.enabled ? 'On' : 'Off';
    toggle.title = sc.enabled ? 'Sidechain ducking is on — click to disable' : 'Sidechain ducking is off — click to enable';
    toggle.setAttribute('aria-pressed', String(sc.enabled));
    toggle.addEventListener('mousedown', (e) => e.stopPropagation());
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      effect.set({ enabled: !sc.enabled });
      render(); autosave();
    });
    head.appendChild(toggle);
  }
  pop.appendChild(head);

  const fields = el('div', 'th-fx-popover-fields');
  const values = effect.get();
  for (const f of effect.fields) {
    fields.appendChild(buildKnob(`${f.label} — ${effect.label} (Master)`, f, values[f.param],
      (v) => { effect.set({ [f.param]: v }); effect.apply(); autosave(); },
      MASTER_FX_FIELD_DEFAULTS[effect.key][f.param]));
  }
  pop.appendChild(fields);
  return pop;
}
// Rebuilds the master chip row from MASTER_FX_REGISTRY every render() —
// same "clear and rebuild" approach buildFxPanel()'s chip row already uses.
// #master-fx-chip-row is added to the static markup in the next task; until
// then this is a harmless no-op (the `if (!row) return;` guard).
function renderMasterFxChips() {
  const row = document.getElementById('master-fx-chip-row');
  if (!row) return;
  row.innerHTML = '';
  for (const effect of MASTER_FX_REGISTRY) row.appendChild(buildMasterFxChip(effect));
}
```

- [ ] **Step 6: Wire into `renderFloatingLayer()` and `render()`**

In `renderFloatingLayer()`, insert right after the `for (const key of
fxPopoverOpen) { … }` loop closes (line 3081), before the `if
(fxAddMenuOpen != null) {` block:

```js
  for (const key of masterFxPopoverOpen) {
    const effect = MASTER_FX_REGISTRY.find((e) => e.key === key);
    const chip = document.querySelector(`.th-master-fx-chip[data-key="${key}"]`);
    if (!effect || !chip || !chip.getClientRects().length) continue;
    place(chip, buildMasterFxPopover(effect));
  }
```

In `render()` (line 3032-3039), insert `renderMasterFxChips();` right before
`renderFloatingLayer();`:

```js
function render() {
  if (renderRafId != null) { cancelAnimationFrame(renderRafId); renderRafId = null; }
  renderTimeline();
  renderTracks();
  renderMasterFxChips();
  renderFloatingLayer();
  positionOverlays();
  renderInspector();
  autosave();
```

- [ ] **Step 7: Verify with the console (no visible container yet)**

`renderMasterFxChips()` no-ops until Task 4 adds `#master-fx-chip-row`, so
there is nothing new to see in the browser yet. Confirm there are no
console errors from this task's code by running `node verify.js` — every
existing step must still pass, since `render()` now unconditionally calls
`renderMasterFxChips()` on every frame.

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "Add master FX chip/popover rendering engine (MASTER_FX_REGISTRY)"
```

---

## Task 4: Master FX panel markup + cleanup of the old flat-panel wiring

**Files:**
- Modify: `index.html` — the `#master-fx-panel` markup (lines 1268-1300),
  the "Master EQ / compression" JS block (lines 5838-5909), the two
  remaining `syncMasterFxUI();` calls (lines 6062, 6168), and the stale
  comment at line 2828.

**Interfaces:**
- Consumes: `renderMasterFxChips()`/`MASTER_FX_REGISTRY` from Task 3 (this
  task gives them a real container to render into).
- Produces: nothing new — this task only deletes now-dead code and swaps
  the static markup that Task 3's `renderMasterFxChips()` was already
  written to expect.

- [ ] **Step 1: Replace the static markup**

Replace lines 1268-1300 (the whole `<div id="master-fx-panel" …>` through
its closing `</div>`, i.e. every `.mfx-group` block for EQ/Comp/Par
Comp/Sidechain/Downsample plus the Meter group):

```html
        <div id="master-fx-panel" class="master-fx-panel" style="display:none">
          <div class="mfx-group">
            <span class="mfx-cap">EQ</span>
            … (through the Downsample mfx-group) …
          </div>
        </div>
```

with:

```html
        <div id="master-fx-panel" class="master-fx-panel" style="display:none">
          <div id="master-fx-chip-row" class="th-fx-chip-row"></div>
          <div class="mfx-group">
            <span class="mfx-cap">Meter</span>
            <canvas id="spectrum-canvas" width="200" height="46" title="Master bus frequency spectrum (post-FX)"></canvas>
            <span id="lufs-val" class="adsr-val" title="Approximate momentary loudness, ITU-R BS.1770 K-weighting (not a certified LUFS meter)">— LUFS</span>
          </div>
        </div>
```

(The Meter group — spectrum canvas + LUFS readout — is a live display, not
a setting, so it stays exactly as it was; only the five settings groups
before it become the chip row.)

- [ ] **Step 2: Delete the old id-based wiring**

Delete the whole block from the `// ---------- Master EQ / compression
----------` comment (line 5838) through the `crush-amount` input's
`addEventListener` block (ending line 5901) — this removes `EQ_FIELDS`,
`COMP_FIELDS`, `syncMasterFxUI()`, and the six `addEventListener` blocks for
`eq-low`/`eq-mid`/`eq-high`/`comp-threshold`/`comp-ratio`/`comp-attack`/
`comp-release`/`parallel-blend`/`sidechain-toggle`/`sidechain-depth`/
`crush-amount` (all now handled by `buildMasterFxPopover()`'s knobs/toggle
instead). Leave the `master-fx-toggle` click listener (lines 5902-5908)
exactly as it is — it only shows/hides the panel, unrelated to what's
inside it. Delete the trailing `syncMasterFxUI();` call that followed it
(line 5909).

- [ ] **Step 3: Remove the two now-dangling `syncMasterFxUI()` calls**

Delete line 6062 (inside the "starter/empty song" reset function, right
after `state.masterCrush = { ...DEFAULT_MASTER_CRUSH };`) and line 6168
(inside the song-load function, right after `syncMasterVolUI();`). Both
functions already call `render()` shortly afterward (line 6073 and 6185
respectively), which now rebuilds the chip row itself — nothing else needs
to change in either function.

- [ ] **Step 4: Fix the stale comment**

Replace (lines 2828-2829):

```js
// Same rendering as the master EQ's readouts (see syncMasterFxUI/EQ_FIELDS), so
// the two EQ panels don't show the same unit two different ways.
```
with:
```js
// Same rendering as the master EQ's own knobs (see MASTER_FX_REGISTRY's
// 'eq' entry), so the two EQ panels don't show the same unit two different ways.
```

- [ ] **Step 5: Manual verification**

Run `node dev-server.js`, open the app, click the Master FX toggle button
next to the master strip and confirm:
- Five chips render: EQ, Comp, Par Comp, Sidechain, Downsample — all
  visually dimmed (all groups start at their neutral default).
- Clicking a chip opens a floating popover with working knobs (drag or
  arrow-key one, confirm the value updates and the sound changes).
- Clicking Sidechain's chip shows an Off/On toggle in the popover header;
  clicking it to On makes the chip stop looking dimmed.
- The spectrum/LUFS meter still updates during playback.
- No leftover `#eq-low`/`#comp-threshold`/etc. elements exist anywhere in
  the DOM (`document.querySelectorAll('[id^="eq-"], [id^="comp-"],
  #sidechain-toggle, #sidechain-depth, #crush-amount').length === 0`).

If a real browser isn't available, drive the same checks headlessly via
CDP, matching the pattern already used in the scratchpad's
`song-compat-check.js`.

- [ ] **Step 6: Run the full verify.js suite**

Run: `node verify.js`
Expected: all steps pass.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "Master FX: replace flat slider panel with the chip/popover shell"
```

---

## Task 5: verify.js coverage

**Files:**
- Modify: `verify.js` — add new `step(...)` blocks near the end of the
  existing FX-panel section (after the steps around line 900-910 that cover
  Delay/EQ/bypass/Reset, i.e. right before whatever step follows the
  Vibrato-focused steps around line 2725+, or more simply: appended
  immediately after the last existing `step('FX panel: …', …)` block — grep
  for `step('FX panel:` to find the last one).

**Interfaces:**
- Consumes: `step`, `cdp`, `waitFor`, `goto`/`APP_URL` — all already defined
  earlier in `verify.js` and used by every existing step in the file.

- [ ] **Step 1: Add a step covering the Envelope & Filter row's new grouping**

```js
    step('Envelope & Filter row: full-word labels, icons, and grouped captions', async () => {
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.track')`);
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-trigger'));
        [...head.querySelectorAll('.th-tool-btn')].find(b => /Env/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.mfx-cap')`);
      const caps = await cdp.evaluate(`[...document.querySelectorAll('.mfx-cap')].map(c => c.textContent)`);
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
```

- [ ] **Step 2: Verify the new step actually fails against the pre-fix code**

Per this repo's own convention (see `verify.js`'s own "steps" section in
`CLAUDE.md`): temporarily `git stash` Task 2's changes, run `node
verify.js` and confirm this new step fails with the expected error
(bare-letter labels / missing `.mfx-cap`), then `git stash pop` to restore
Task 2 and confirm it passes again.

- [ ] **Step 3: Add steps covering the master FX chips**

```js
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
      await cdp.evaluate(`(() => { const d = ${dialSel}; d.focus();
        for (let i = 0; i < 12; i++) d.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); })()`);
      const val = await cdp.evaluate(`${dialSel}.getAttribute('aria-valuetext')`);
      if (val !== '6.0dB') throw new Error(`expected master EQ Lo to read 6.0dB after 12 steps, got ${val}`);
      const dimmed = await cdp.evaluate(`document.querySelector('.th-master-fx-chip[data-key="eq"]').classList.contains('bypassed')`);
      if (dimmed) throw new Error('EQ chip should stop looking dimmed once a value moves off default');
      // Reset for later steps/songs sharing this page load.
      await cdp.evaluate(`(() => { const d = ${dialSel}; d.focus();
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
```

- [ ] **Step 4: Verify each new step fails against pre-fix code, then passes**

As in Step 2, confirm each of Step 3's assertions genuinely fails without
Task 3/4's changes (e.g. `.th-master-fx-chip` not existing yet) and passes
with them.

- [ ] **Step 5: Run the full suite**

Run: `node verify.js`
Expected: every step passes, including the new ones. Re-run once if only
the pre-existing flaky Chord-presets/Recording steps fail (see the
`flaky_verify_tests` memory) — a failure in any other step is a real
regression.

- [ ] **Step 6: Commit**

```bash
git add verify.js
git commit -m "verify.js: cover Envelope & Filter row grouping and master FX chips"
```
