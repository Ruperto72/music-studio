# Track header redesign implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `index.html`'s track header into a wider (260px), Pro Tools-style sectioned layout (Osc/Inserts/Output), with the waveform picker as a dropdown, lettered insert chips, and — the actual bug-fix payload — a shared floating-popup mechanism (portal-rendered to `document.body`) for the FX effect detail view and the "+ Add effect" menu, fixing the confirmed `.daw`-overflow clipping bug from `docs/superpowers/specs/2026-07-29-track-header-redesign.md`.

**Architecture:** Three tasks, each ending with a fully green `node verify.js`: (1) header sections, width, the waveform dropdown, and removing the FX show/hide toggle (Inserts becomes always-visible, matching the approved mockup) — the task with the widest `verify.js` blast radius, since the waveform picker's presence is used as an "is this track tonal" marker in ~30 places; (2) cosmetic sequential lettering on insert chips — small and self-contained; (3) the floating-popup portal mechanism, which depends on (1)'s Inserts section existing and is the task that actually fixes the clipping bug.

## Global Constraints

- No dependencies, no build step. Everything lives in `index.html` (plus `verify.js` for testing).
- No unit test framework — testing is `node verify.js` (a headless-Chrome smoke test over the Chrome DevTools Protocol), which fails on any assertion failure OR any console error/uncaught exception. Run it from the repo root.
- Known pre-existing flakiness, unrelated to this work (see the `flaky_verify_tests` memory): "Recording: arm a track, count in, and play notes onto the grid" and "Chord presets: every voicing is offered..." occasionally fail on an unrelated timing issue. If ONLY those (or one of those) fail and everything else passes, that's the known baseline — re-run once to confirm before treating a run as broken.
- Follow the existing code style: comments only where something is non-obvious.
- `data-track` is already set on every `.track` element's own row (in `renderPitchTrack`/`renderRhythmTrack`) — use `.track[data-track="..."]` to locate a specific track's row reliably across re-renders, the same pattern several existing `verify.js` steps already use.
- `render()` (index.html:2983) is `renderTimeline(); renderTracks(); positionOverlays(); renderInspector(); autosave(); checkpointHistory();` — `renderTracks()` fully clears and rebuilds `#tracks`' contents on every call. Anything that needs to exist independently of that rebuild (this plan's floating popup layer, Task 3) must live outside `#tracks` and be explicitly managed, the same way `createOverlays()`'s playhead/loop chrome already is (built once, only *repositioned* — not rebuilt — by `positionOverlays()`).

---

## Task 1: Header sections, width, waveform dropdown, remove FX toggle

**Files:**
- Modify: `index.html` (CSS ~line 25, ~306-402, `buildHeader()` ~3905-4135, `removeTrack()` ~3200, `fxSendOpen` declaration ~3435 and its comment ~3439, `buildFxPanel()`'s own top element ~3833-3851)
- Modify: `verify.js` (~35 sites — see Step 5)

**Interfaces:**
- Produces: a new `.th-osc-select` class on the tonal waveform `<select>` (replaces `.th-wave-group` as both the UI and the "is this track tonal" marker used throughout `verify.js`), `.th-section`/`.th-section-label` as the generic labelled-group pattern Task 3 will also use for its own markup, `--header-w: 260px`. `buildFxPanel()` is called unconditionally for every track (no more `fxSendOpen` gate) — Task 2 and Task 3 both build on top of `buildFxPanel()`'s new always-visible shape.

- [ ] **Step 1: Bump the header width, remove old waveform-picker CSS, add section CSS**

Find (index.html:25):

```css
    --header-w: 200px; --gutter-w: 42px;
```

Change to:

```css
    --header-w: 260px; --gutter-w: 42px;
```

Find and delete the old waveform-picker comment/rules (index.html:389-402):

```css
  /* Waveform picker: six shapes shown at once rather than hidden behind a
     <select>, since the whole point is to compare them. Sized to share the
     200px header (--header-w) minus its padding, so `flex: 1 1 0` splits the
     row evenly however many WAVEFORMS there are. */
  .th-wave-group { display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px; }
  .th-wave-btn {
    min-width: 0; padding: 3px 1px; display: flex; justify-content: center;
    background: #26262d; border: 1px solid #3a3a44; border-radius: 4px;
    color: #8f8f9b; cursor: pointer;
  }
  .th-wave-btn:hover { border-color: #55555f; color: #cfcfd8; }
  .th-wave-btn.on { background: #3a6bd6; border-color: #2a55b5; color: #fff; }
  .th-wave-btn .glyph { width: 100%; height: 12px; }
  .th-wave-name { display: block; font-size: 9px; color: var(--muted); margin-top: 2px; text-align: center; }
```

Replace with nothing (deleted) — the new rules go in with the rest of Step 1's additions below.

Find (index.html:340, part of a longer selector list — only replace this one class name in that line, the rest of the line is unrelated and must stay):

```css
  .track.collapsed .th-wave-row, .track.collapsed .th-tools,
```

Change to:

```css
  .track.collapsed .th-osc-section, .track.collapsed .th-tools,
```

Find (index.html:349):

```css
  .th-wave-row { margin-top: 2px; }
```

Delete this line (the new `.th-section` rule below replaces it — every section, not just Osc, needs top spacing).

Find (index.html:348, the rhythm "Kit" label rule, kept as-is but shown here for anchoring the insertion point):

```css
  .th-osc { display: block; font-size: 9px; color: var(--muted); font-weight: 400; }
```

Add immediately after it:

```css
  /* Generic labelled-group pattern the redesigned header uses for all three
     of its sections (Osc/Inserts/Output) — Task 3's floating popups reuse
     the same caption styling for their title bar. */
  .th-section { margin-top: 6px; padding-top: 6px; border-top: 1px solid #232329; }
  .th-section:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
  .th-section-label {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 8px; text-transform: uppercase; letter-spacing: 0.8px; color: #6f6f7a;
    font-weight: 700; margin-bottom: 5px;
  }
  /* The waveform <select> replaces the old six-to-ten-button picker — a
     dropdown only shows one shape at a time, which is a real tradeoff
     (deliberately accepted; see docs/superpowers/specs/2026-07-29-track-header-redesign.md
     §3) against the Pro Tools-style width/section goal. Matches
     renderAutomationRow()'s existing <select> styling exactly (no new select
     look is introduced). */
  .th-osc-select {
    width: 100%; background: #1c1c22; border: 1px solid #3a3a44; color: var(--ink);
    font-size: 11px; padding: 3px 6px; border-radius: 4px; cursor: pointer;
  }
```

- [ ] **Step 2: Rewrite `buildHeader()`'s Osc/Output sections and remove the FX toggle**

Find the whole block from the waveform-picker comment through the end of the function (index.html:3983-4135):

```js
  // Waveform picker (or the "Kit" label for rhythm) — its own full-width row,
  // hidden while collapsed.
  const waveRow = el('div', 'th-wave-row');
  if (isRhythm(track)) {
    const kit = el('span', 'th-osc');
    kit.append(glyph('kit'), document.createTextNode(' ' + WAVE_LABEL.kit));
    kit.style.display = 'flex'; kit.style.alignItems = 'center'; kit.style.gap = '4px';
    waveRow.append(kit);
  } else {
    // Waveform (oscillator) picker — affects the editor preview AND the game
    // via the exported VOICES config.
    //
    // Six icon buttons rather than the <select> this used to be: the choice is
    // "which of these shapes", and a dropdown only ever showed one shape at a
    // time (and a native <option> can't carry an SVG at all, so the shapes had
    // nowhere to go while it stayed a select). Same role="radiogroup" +
    // aria-checked pattern as the Pen/Eraser/Grab tool group, since this is
    // likewise one choice out of a set and not a row of independent toggles.
    // The glyphs are aria-hidden, so each button carries the waveform's name as
    // its aria-label; the name of the *selected* one is also spelled out below
    // the row, so nothing depends on recognising an icon.
    const group = el('div', 'th-wave-group');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Waveform for ' + trackName(track));
    for (const w of WAVEFORMS) {
      const on = state.waveform[track] === w;
      const btn = el('button', 'th-wave-btn' + (on ? ' on' : ''));
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(on));
      btn.setAttribute('aria-label', WAVE_LABEL[w]);
      btn.title = WAVE_LABEL[w] + ' (VOICES ' + track + ')';
      btn.appendChild(glyph(w));
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.waveform[track] = w;
        const n = state.tracks[track][0];
        if (n) previewNote(track, n);
        autosave();
        // Always re-render now, not only when the Envelope panel is open (which
        // is what the old <select> did): the picker itself has to restyle to
        // move the lit state onto the clicked button, and the note inspector's
        // Duty cycle field only exists while the waveform is `square`.
        render();
      });
      group.appendChild(btn);
    }
    const name = el('span', 'th-wave-name');
    name.textContent = WAVE_LABEL[state.waveform[track]] || state.waveform[track];
    waveRow.append(group, name);
  }

  // A third row for the (less-frequently-used) automation/envelope toggles —
  // keeping them out of .th-top avoids overflowing the header's fixed width.
  const tools = el('div', 'th-tools');
  const autoBtn = el('button', 'th-tool-btn' + (automationOpen.has(track) ? ' on' : ''));
  setGlyphLabel(autoBtn, 'automation', 'Auto');
  autoBtn.title = 'Automation (volume/pan over time)';
  autoBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  autoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (automationOpen.has(track)) automationOpen.delete(track); else automationOpen.set(track, 'gain');
    render();
  });
  tools.append(autoBtn);
  const fxBtn = el('button', 'th-tool-btn' + (fxSendOpen.has(track) ? ' on' : ''));
  setGlyphLabel(fxBtn, 'sparkle', 'FX');
  fxBtn.title = 'Track effects — Delay/Chorus/Reverb send (separate from the per-note Echo/Chorus/Reverb flags), a 3-band EQ, a Compressor, a Bitcrush downsampler and a Tremolo';
  fxBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  fxBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (fxSendOpen.has(track)) fxSendOpen.delete(track); else fxSendOpen.add(track);
    render();
  });
  tools.append(fxBtn);
  if (!isRhythm(track)) { // drum hits use fixed per-type envelopes, not a shared ADSR
    const adsrBtn = el('button', 'th-tool-btn' + (adsrOpen.has(track) ? ' on' : ''));
    setGlyphLabel(adsrBtn, 'envelope', 'Env');
    adsrBtn.title = 'Envelope (attack/decay/sustain/release)';
    adsrBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    adsrBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (adsrOpen.has(track)) adsrOpen.delete(track); else adsrOpen.add(track);
      render();
    });
    tools.append(adsrBtn);
    const presetBtn = el('button', 'th-tool-btn icon');
    setGlyphLabel(presetBtn, 'preset', '');
    presetBtn.title = 'Instrument presets — save/load this track\'s waveform + envelope';
    presetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    presetBtn.addEventListener('click', (e) => { e.stopPropagation(); openPresetDialog(track); });
    tools.append(presetBtn);
  } else {
    const patternsBtn = el('button', 'th-tool-btn icon');
    setGlyphLabel(patternsBtn, 'drums', '');
    patternsBtn.title = 'Rhythm patterns — insert a built-in groove with accents and fills (Rock, Techno, Funk, Bossa Nova, ...)';
    patternsBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    patternsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // insertPatternIntoRhythm() works on state.activeTrack, and the
      // stopPropagation above is exactly what stops the header's own
      // mousedown handler from setting it — so the dialog has to activate
      // its own track. Invisible while a new project was one rhythm lane
      // that was always active; with a starter layout the drum track is the
      // last of five, and Insert would have silently done nothing whenever
      // a tonal track had focus.
      setActive(track, true);
      renderPatternList();
      patternDialog.showModal();
    });
    tools.append(patternsBtn);
  }

  const vol = el('div', 'th-vol');
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = 0; slider.max = 2; slider.step = 0.05; slider.value = state.gains[track];
  slider.title = 'Channel volume (mix)'; slider.style.accentColor = trackColor(track);
  const val = el('span', 'vol-val'); val.textContent = Number(state.gains[track]).toFixed(2);
  slider.addEventListener('mousedown', (e) => e.stopPropagation());
  slider.addEventListener('input', () => {
    state.gains[track] = parseFloat(slider.value);
    val.textContent = state.gains[track].toFixed(2);
    applyGains(); autosave();
  });
  vol.append(slider, val);

  // Stereo pan (VOICES) — affects the editor preview AND the game.
  const panRow = el('div', 'th-pan');
  const panSlider = document.createElement('input');
  panSlider.type = 'range'; panSlider.min = -1; panSlider.max = 1; panSlider.step = 0.1; panSlider.value = state.pan[track];
  panSlider.title = 'Stereo pan'; panSlider.style.accentColor = trackColor(track);
  const panVal = el('span', 'pan-val'); panVal.textContent = panLabel(state.pan[track]);
  panSlider.addEventListener('mousedown', (e) => e.stopPropagation());
  panSlider.addEventListener('dblclick', (e) => { e.stopPropagation(); panSlider.value = 0; panSlider.dispatchEvent(new Event('input')); });
  panSlider.addEventListener('input', () => {
    state.pan[track] = parseFloat(panSlider.value);
    panVal.textContent = panLabel(state.pan[track]);
    applyPan(); autosave();
  });
  panRow.append(panSlider, panVal);

  // Live level meter (VU) — updated by the meter RAF while audio is running.
  const vu = el('div', 'vu');
  const vuMask = el('div', 'vu-mask');
  vu.appendChild(vuMask);
  vuMeters[track] = vuMask;

  header.append(top, waveRow, tools, vol, panRow, vu);
  if (fxSendOpen.has(track)) header.appendChild(buildFxPanel(track));
  header.addEventListener('mousedown', () => setActive(track, true));
  return header;
}
```

Replace the whole thing with:

```js
  // Osc section: waveform dropdown (or the "Kit" label for rhythm) plus the
  // Auto/Env/Preset (or Auto/Patterns) tool-toggle row, both hidden while
  // collapsed via .th-osc-section's own class.
  const oscSection = el('div', 'th-section th-osc-section');
  const oscLabel = el('div', 'th-section-label');
  oscLabel.textContent = 'Osc';
  oscSection.appendChild(oscLabel);
  if (isRhythm(track)) {
    const kit = el('span', 'th-osc');
    kit.append(glyph('kit'), document.createTextNode(' ' + WAVE_LABEL.kit));
    kit.style.display = 'flex'; kit.style.alignItems = 'center'; kit.style.gap = '4px';
    oscSection.appendChild(kit);
  } else {
    // Waveform (oscillator) picker — affects the editor preview AND the game
    // via the exported VOICES config. A plain <select> (same pattern
    // renderAutomationRow() already uses for its own parameter dropdown) —
    // deliberately reverted from the six-to-ten-button picker this used to
    // be, trading "compare every shape at once" for the header's Pro
    // Tools-style width/section goal; see the design spec §3 for the
    // reasoning. Native <option> text carries the name (WAVE_LABEL) with no
    // icon (a <option> can't hold an SVG glyph either way).
    const select = document.createElement('select');
    select.className = 'th-osc-select';
    select.setAttribute('aria-label', 'Waveform for ' + trackName(track));
    for (const w of WAVEFORMS) {
      const opt = document.createElement('option');
      opt.value = w; opt.textContent = WAVE_LABEL[w];
      if (state.waveform[track] === w) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('mousedown', (e) => e.stopPropagation());
    select.addEventListener('change', () => {
      state.waveform[track] = select.value;
      const n = state.tracks[track][0];
      if (n) previewNote(track, n);
      autosave();
      // Re-render so the note inspector's Duty cycle field (square-only)
      // appears/disappears immediately, matching the old picker's behaviour.
      render();
    });
    oscSection.appendChild(select);
  }
  const tools = el('div', 'th-tools');
  const autoBtn = el('button', 'th-tool-btn' + (automationOpen.has(track) ? ' on' : ''));
  setGlyphLabel(autoBtn, 'automation', 'Auto');
  autoBtn.title = 'Automation (volume/pan over time)';
  autoBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  autoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (automationOpen.has(track)) automationOpen.delete(track); else automationOpen.set(track, 'gain');
    render();
  });
  tools.append(autoBtn);
  if (!isRhythm(track)) { // drum hits use fixed per-type envelopes, not a shared ADSR
    const adsrBtn = el('button', 'th-tool-btn' + (adsrOpen.has(track) ? ' on' : ''));
    setGlyphLabel(adsrBtn, 'envelope', 'Env');
    adsrBtn.title = 'Envelope (attack/decay/sustain/release)';
    adsrBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    adsrBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (adsrOpen.has(track)) adsrOpen.delete(track); else adsrOpen.add(track);
      render();
    });
    tools.append(adsrBtn);
    const presetBtn = el('button', 'th-tool-btn icon');
    setGlyphLabel(presetBtn, 'preset', '');
    presetBtn.title = 'Instrument presets — save/load this track\'s waveform + envelope';
    presetBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    presetBtn.addEventListener('click', (e) => { e.stopPropagation(); openPresetDialog(track); });
    tools.append(presetBtn);
  } else {
    const patternsBtn = el('button', 'th-tool-btn icon');
    setGlyphLabel(patternsBtn, 'drums', '');
    patternsBtn.title = 'Rhythm patterns — insert a built-in groove with accents and fills (Rock, Techno, Funk, Bossa Nova, ...)';
    patternsBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    patternsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // insertPatternIntoRhythm() works on state.activeTrack, and the
      // stopPropagation above is exactly what stops the header's own
      // mousedown handler from setting it — so the dialog has to activate
      // its own track. Invisible while a new project was one rhythm lane
      // that was always active; with a starter layout the drum track is the
      // last of five, and Insert would have silently done nothing whenever
      // a tonal track had focus.
      setActive(track, true);
      renderPatternList();
      patternDialog.showModal();
    });
    tools.append(patternsBtn);
  }
  oscSection.appendChild(tools);

  // Output section: volume, pan, VU meter.
  const outputSection = el('div', 'th-section th-output-section');
  const outputLabel = el('div', 'th-section-label');
  outputLabel.textContent = 'Output';
  outputSection.appendChild(outputLabel);

  const vol = el('div', 'th-vol');
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = 0; slider.max = 2; slider.step = 0.05; slider.value = state.gains[track];
  slider.title = 'Channel volume (mix)'; slider.style.accentColor = trackColor(track);
  const val = el('span', 'vol-val'); val.textContent = Number(state.gains[track]).toFixed(2);
  slider.addEventListener('mousedown', (e) => e.stopPropagation());
  slider.addEventListener('input', () => {
    state.gains[track] = parseFloat(slider.value);
    val.textContent = state.gains[track].toFixed(2);
    applyGains(); autosave();
  });
  vol.append(slider, val);
  outputSection.appendChild(vol);

  // Stereo pan (VOICES) — affects the editor preview AND the game.
  const panRow = el('div', 'th-pan');
  const panSlider = document.createElement('input');
  panSlider.type = 'range'; panSlider.min = -1; panSlider.max = 1; panSlider.step = 0.1; panSlider.value = state.pan[track];
  panSlider.title = 'Stereo pan'; panSlider.style.accentColor = trackColor(track);
  const panVal = el('span', 'pan-val'); panVal.textContent = panLabel(state.pan[track]);
  panSlider.addEventListener('mousedown', (e) => e.stopPropagation());
  panSlider.addEventListener('dblclick', (e) => { e.stopPropagation(); panSlider.value = 0; panSlider.dispatchEvent(new Event('input')); });
  panSlider.addEventListener('input', () => {
    state.pan[track] = parseFloat(panSlider.value);
    panVal.textContent = panLabel(state.pan[track]);
    applyPan(); autosave();
  });
  panRow.append(panSlider, panVal);
  outputSection.appendChild(panRow);

  // Live level meter (VU) — updated by the meter RAF while audio is running.
  const vu = el('div', 'vu');
  const vuMask = el('div', 'vu-mask');
  vu.appendChild(vuMask);
  vuMeters[track] = vuMask;
  outputSection.appendChild(vu);

  header.append(top, oscSection, buildFxPanel(track), outputSection);
  header.addEventListener('mousedown', () => setActive(track, true));
  return header;
}
```

Note what changed structurally: the FX/"Inserts" toggle button (`fxBtn`) is gone entirely — `buildFxPanel(track)` is now always appended (no `fxSendOpen` gate), matching the approved mockup where Inserts is a permanent section like Osc and Output. Its "Inserts" caption is added inside `buildFxPanel()` itself in Step 3 below, not here.

- [ ] **Step 3: Add the "Inserts" section label inside `buildFxPanel()`, mark it as a `.th-section`**

Find (index.html:3833-3836):

```js
function buildFxPanel(track) {
  const panel = el('div', 'th-fx-panel');

  const resetWrap = el('div', 'th-fx-reset-wrap');
```

Replace with:

```js
function buildFxPanel(track) {
  const panel = el('div', 'th-fx-panel th-section');

  const resetWrap = el('div', 'th-fx-reset-wrap');
  const insertsLabel = el('span', 'th-section-label-text');
  insertsLabel.textContent = 'Inserts';
  resetWrap.prepend(insertsLabel);
```

(`resetWrap` already has `display: flex; justify-content: flex-end` — Step 4 below updates its CSS to also space the new label to the left and the Reset button to the right, matching the other two sections' single-row caption treatment without needing a second wrapper element.)

- [ ] **Step 4: Update `.th-fx-reset-wrap` CSS for the new label**

Find (index.html:452):

```css
  .th-fx-reset-wrap { display: flex; justify-content: flex-end; }
```

Change to:

```css
  .th-fx-reset-wrap { display: flex; align-items: center; justify-content: space-between; }
  .th-fx-reset-wrap .th-section-label-text {
    font-size: 8px; text-transform: uppercase; letter-spacing: 0.8px; color: #6f6f7a; font-weight: 700;
  }
```

- [ ] **Step 5: Remove `fxSendOpen` entirely**

In `removeTrack(id)`, find (index.html:3200):

```js
  delete vuLevel[id]; delete vuMeters[id]; automationOpen.delete(id); adsrOpen.delete(id); fxSendOpen.delete(id);
```

Change to:

```js
  delete vuLevel[id]; delete vuMeters[id]; automationOpen.delete(id); adsrOpen.delete(id);
```

Find (index.html:3435, and its now-stale reference in the comment two lines below at 3439):

```js
const fxSendOpen = new Set(); // track ids with the Delay/Chorus send panel open
// Which FX insert popovers are open, keyed by `${track}::${effectKey}` — any
// number can be open at once, across tracks and effects (unlike
// automationOpen/adsrOpen, which are one-per-track). Not serialized: purely
// which panel is currently expanded, the same kind of state fxSendOpen above
// already is.
const fxPopoverOpen = new Set();
```

Change to:

```js
// Which FX insert popovers are open, keyed by `${track}::${effectKey}` — any
// number can be open at once, across tracks and effects (unlike
// automationOpen/adsrOpen, which are one-per-track). Not serialized: purely
// which panel is currently expanded — the Inserts section itself is always
// visible now (no more show/hide toggle), only its popovers open and close.
const fxPopoverOpen = new Set();
```

- [ ] **Step 6: Run a manual smoke check**

Run: `node dev.js`

In the browser: confirm every track's header is now 260px wide, shows "Osc" (dropdown + tool buttons), the Inserts chip row (always visible, no toggle button needed to reveal it), and "Output" (vol/pan/VU) each under their own caption. Pick a waveform from the dropdown — confirm it applies (audition plays, and if a note already exists on the track, the picked shape holds). Confirm a rhythm track still shows "Kit" under Osc, no dropdown. Confirm no console errors.

- [ ] **Step 7: Update `verify.js` — mechanical rename, `.th-wave-group` → `.th-osc-select`**

`.th-wave-group` was the old radiogroup `<div>`'s class, used throughout `verify.js` purely to detect "does this track have a waveform picker" (i.e. "is this track tonal"). The new `.th-osc-select` class on the `<select>` itself (Step 2) is a drop-in replacement for that same purpose — replace every occurrence of the literal string `.th-wave-group` with `.th-osc-select` in `verify.js`. This is a pure string substitution; none of these call sites' surrounding logic changes. The occurrences, by line number (re-check with `grep -n "th-wave-group" verify.js` before editing, since earlier edits in this task can shift later line numbers — always match by content, not by these numbers alone):

420, 1116, 1126 (note: this one's on a *different* selector, `.th-wave-row` — see Step 8, do not touch here), 1146, 1148, 1200, 1553, 1591, 1625, 1701, 2211, 2238, 2394, 2454, 2473, 2519, 2537, 2560, 2619, 2733, 2739, 2748, 2751, 2875, 2878, 2887.

After the rename, run:

```bash
grep -c "th-wave-group" verify.js
```

Expected: `0` (every occurrence renamed). Do not touch `.th-wave-btn`, `.th-wave-name`, or `.th-wave-row` references yet — those are handled in Step 8 (the real-interaction rewrites) and Step 9 (the FX-toggle-click removals use `.th-wave-group`-adjacent code paths but are listed separately below since they need more than a rename).

- [ ] **Step 8: Rewrite the four real-interaction waveform tests**

These four steps don't just check `.th-wave-group`'s presence — they click `.th-wave-btn` elements and read `.th-wave-name`, which no longer exist. Each needs a real rewrite to use the `<select>`.

**8a.** Find (verify.js, the `'Icons: waveform picker, per-note toggles and FX headings are glyphed and still labelled'` step's waveform-picker portion):

```js
      const wave = await cdp.evaluate(`(() => {
        const g = document.querySelector('.th-wave-group');
        if (!g) return { missing: true };
        const btns = [...g.querySelectorAll('.th-wave-btn')];
        return {
          role: g.getAttribute('role'),
          count: btns.length,
          named: btns.every(b => b.getAttribute('aria-label')),
          drawn: btns.every(b => b.querySelectorAll('svg.glyph path').length > 0),
          hidden: btns.every(b => b.querySelector('svg.glyph').getAttribute('aria-hidden') === 'true'),
          checked: btns.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('aria-label')),
          name: g.closest('.th-wave-row').querySelector('.th-wave-name')?.textContent,
          fits: g.scrollWidth <= g.closest('.track-header').clientWidth,
        };
      })()`);
      if (wave.missing) throw new Error('no tonal track waveform picker found');
      if (wave.role !== 'radiogroup') throw new Error(`waveform picker should be a radiogroup, got ${wave.role}`);
      if (wave.count !== 10) throw new Error(`expected 10 waveforms, got ${wave.count}`);
      if (wave.count === 0 || !wave.named || !wave.drawn || !wave.hidden) {
        throw new Error(`every waveform button needs a name and a decorative glyph: ${JSON.stringify(wave)}`);
      }
      // The glyph carries no accessible name of its own, so the selected
      // waveform must still be readable as text somewhere.
      if (wave.checked.length !== 1 || wave.name !== wave.checked[0]) {
        throw new Error(`exactly one waveform should be checked and spelled out: ${JSON.stringify(wave)}`);
      }
      if (!wave.fits) throw new Error('the waveform buttons overflow the track header');
      // Scope to one track's picker: by this point the song has several tonal
      // tracks, each with its own group, so an unscoped query would mix their
      // states together and read as many checked buttons as there are tracks.
      const switched = await cdp.evaluate(`(() => {
        const row = document.querySelector('.th-wave-group').closest('.th-wave-row');
        [...row.querySelectorAll('.th-wave-btn')].find(b => b.getAttribute('aria-label') === 'Saw').click();
        const row2 = document.querySelector('.th-wave-group').closest('.th-wave-row');
        const btns = [...row2.querySelectorAll('.th-wave-btn')];
        return {
          checked: btns.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('aria-label')),
          name: row2.querySelector('.th-wave-name')?.textContent,
        };
      })()`);
      if (switched.checked.join() !== 'Saw' || switched.name !== 'Saw') {
        throw new Error(`picking Saw should move both the checked state and the caption: ${JSON.stringify(switched)}`);
      }
```

Replace with:

```js
      // A native <select> carries its own accessible name/value pair for
      // free (aria-label + the selected <option>'s text) — the checks that
      // mattered for the old button picker (every option named, exactly one
      // "checked", the name spelled out as text) are now just "is it a
      // <select> with the right options and the right one selected".
      const wave = await cdp.evaluate(`(() => {
        const s = document.querySelector('.th-osc-select');
        if (!s) return { missing: true };
        return {
          tag: s.tagName,
          named: !!s.getAttribute('aria-label'),
          count: s.options.length,
          selectedText: s.options[s.selectedIndex]?.textContent,
          fits: s.scrollWidth <= s.closest('.track-header').clientWidth,
        };
      })()`);
      if (wave.missing) throw new Error('no tonal track waveform picker found');
      if (wave.tag !== 'SELECT') throw new Error(`waveform picker should be a <select>, got ${wave.tag}`);
      if (!wave.named) throw new Error('waveform <select> needs an aria-label');
      if (wave.count !== 10) throw new Error(`expected 10 waveform options, got ${wave.count}`);
      if (wave.selectedText !== 'Square') throw new Error(`expected Square selected by default, got ${wave.selectedText}`);
      if (!wave.fits) throw new Error('the waveform select overflows the track header');
      // Scope to one track's picker: by this point the song has several tonal
      // tracks, each with its own select, so an unscoped query would mix
      // their states together.
      const switched = await cdp.evaluate(`(() => {
        const s = document.querySelector('.th-osc-select');
        s.value = 'sawtooth';
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return document.querySelector('.th-osc-select').options[document.querySelector('.th-osc-select').selectedIndex].textContent;
      })()`);
      if (switched !== 'Saw') throw new Error(`picking sawtooth should select the "Saw" option, got ${switched}`);
```

**8b.** Find (verify.js, `'Waveforms: all ten build a distinct sound, none is off in level, and PWM sweeps'` step's layout-check + iteration):

```js
      const layout = await cdp.evaluate(`(() => {
        const g = document.querySelector('.th-wave-group');
        const btns = [...g.querySelectorAll('.th-wave-btn')];
        return {
          labels: btns.map(b => b.getAttribute('aria-label')),
          rows: [...new Set(btns.map(b => Math.round(b.getBoundingClientRect().top)))].length,
          minWidth: Math.min(...btns.map(b => Math.round(b.getBoundingClientRect().width))),
          fits: g.scrollWidth <= g.closest('.track-header').clientWidth,
        };
      })()`);
      if (layout.rows !== 2 || !layout.fits) {
        throw new Error(`the picker should wrap to two rows inside the header: ${JSON.stringify(layout)}`);
      }
      // Nine across one row would leave each button about 19px, too small for
      // the shape to read; two rows keeps them at least as big as six were.
      if (layout.minWidth < 29) throw new Error(`waveform buttons shrank to ${layout.minWidth}px`);

      const results = {};
      const delayMods = {};
      for (const label of layout.labels) {
        const before = await cdp.evaluate(`window.__waveRenders.length`);
        await cdp.evaluate(`[...document.querySelectorAll('.th-wave-btn')].find(b => b.getAttribute('aria-label') === ${JSON.stringify('')} + ${JSON.stringify(label)}).click()`);
        await new Promise((r) => setTimeout(r, 300));
```

Replace with:

```js
      // The layout check (rows/min-width) was specific to the button grid —
      // a <select> has nothing analogous to assert beyond "it fits", already
      // covered by the Icons test above. Read the option values directly
      // (WAVEFORMS' own internal ids, not the display labels) to drive the
      // loop below, since setting select.value needs the option value.
      const optionValues = await cdp.evaluate(
        `[...document.querySelector('.th-osc-select').options].map(o => o.value)`);
      if (optionValues.length !== 10) throw new Error(`expected 10 waveform options, got ${optionValues.length}`);

      const results = {};
      const delayMods = {};
      for (const value of optionValues) {
        const before = await cdp.evaluate(`window.__waveRenders.length`);
        await cdp.evaluate(`(() => {
          const s = document.querySelector('.th-osc-select');
          s.value = ${JSON.stringify(value)};
          s.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await new Promise((r) => setTimeout(r, 300));
```

A few lines further down in the same step, the loop body reads `results[label]`/`delayMods[label]` keyed by the old button's `aria-label` (a display string like `'Saw'`). Find:

```js
        results[label] = await cdp.evaluate(`window.__waveRenders[${before}]`);
        delayMods[label] = await cdp.evaluate(`window.__delayMod`);
```

Change `label` to `value` in both lines (keying by the option's own value, e.g. `'sawtooth'`, is equally unique and needs no extra lookup):

```js
        results[value] = await cdp.evaluate(`window.__waveRenders[${before}]`);
        delayMods[value] = await cdp.evaluate(`window.__delayMod`);
```

Any later code in this same step that iterates `Object.keys(results)`/`Object.entries(results)` to compare renders against each other is unaffected by this key-name change (it never assumed a specific string shape) — leave it as-is. If you find a reference to `layout` anywhere else in this step (there shouldn't be, since it was only used for the two checks replaced above), that's a sign this replacement missed something — search the full step before moving on.

**8c.** Find (verify.js, `'PWM: the sweep free-runs across notes instead of restarting on each one'` step):

```js
      await cdp.evaluate(`[...document.querySelectorAll('.th-wave-btn')].find(b => b.getAttribute('aria-label') === 'PWM').click()`);
```

Replace with:

```js
      await cdp.evaluate(`(() => {
        const s = document.querySelector('.th-osc-select');
        s.value = 'pwm';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
```

**8d.** Find (verify.js, `'Duty: a square track has its own default, and a note can override it'` step, the "non-square track must not offer the control" check):

```js
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-select'));
        [...head.querySelectorAll('.th-wave-btn')].find(b => b.getAttribute('aria-label') === 'Sine').click();
      })()`);
```

(Note: by this point in the file, Step 7's rename has already turned this line's `.th-wave-group` into `.th-osc-select` for the *track lookup* — only the `.th-wave-btn` click needs a further rewrite here.) Replace with:

```js
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-select'));
        const s = head.querySelector('.th-osc-select');
        s.value = 'sine';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
```

- [ ] **Step 9: Remove the now-dead "click the FX button to open the panel" blocks**

Five steps click a `.th-tool-btn` matching `/FX/` to reveal `.th-fx-panel` before it existed. Since Step 2 makes `buildFxPanel()` always-appended, `.th-fx-panel` already exists on every track at all times — these clicks now target a button that no longer exists (`fxBtn` was deleted in Step 2) and would throw. Find and delete each of the following (search for the literal `/FX/.test(b.textContent)` substring — there are exactly 5 occurrences; delete only the `.click()` line each time, not the surrounding `waitFor`, which stays as a harmless readiness check):

In the `'FX panel: every TRACK_FX_REGISTRY entry is offered...'` step:

```js
      await cdp.evaluate(`(() => {
        if (document.querySelector('.th-fx-panel')) return;
        [...document.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!document.querySelector('.th-fx-panel')`);
```

Replace with just:

```js
      await waitFor(`!!document.querySelector('.th-fx-panel')`);
```

In the `'FX panel: bypass/rhythm/tonal Vibrato...'`-family step (the rhythm-track add-menu check):

```js
      await cdp.evaluate(`(() => {
        const head = ${rhythmHead};
        if (head.querySelector('.th-fx-panel')) return;
        [...head.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!(${rhythmHead}).querySelector('.th-fx-panel')`);
```

Replace with:

```js
      await waitFor(`!!(${rhythmHead}).querySelector('.th-fx-panel')`);
```

Same step, a few lines later (the new-tonal-track check):

```js
      await cdp.evaluate(`(() => {
        const head = ${newTonalHead};
        head.querySelector('.th-fx-panel') || [...head.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      await waitFor(`!!(${newTonalHead}).querySelector('.th-fx-panel')`);
```

Replace with:

```js
      await waitFor(`!!(${newTonalHead}).querySelector('.th-fx-panel')`);
```

In the `'FX panel: bypass writes the default value to the audio graph...'` step:

```js
      await cdp.evaluate(`(() => {
        const head = [...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-select'));
        [...head.querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click();
      })()`);
      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-select'))`;
```

Replace with just:

```js
      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-select'))`;
```

In the `'FX: a real trusted click through the grid still lands after light-dismiss closes a popover'` step:

```js
      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-select'))`;
      await cdp.evaluate(`[...(${headSel}).querySelectorAll('.th-tool-btn')].find(b => /FX/.test(b.textContent)).click()`);
      await waitFor(`!!(${headSel}).querySelector('.th-fx-panel')`);
```

Replace with:

```js
      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-select'))`;
      await waitFor(`!!(${headSel}).querySelector('.th-fx-panel')`);
```

After this step, confirm no remaining references to the deleted `fxBtn`/FX-toggle pattern:

```bash
grep -n "/FX/.test" verify.js
```

Expected: no output (all 5 removed).

- [ ] **Step 10: Remove the now-pointless `openFxPanel()` helper**

Find (verify.js, in the FX-panel helpers block):

```js
    async function openFxPanel() {
      await cdp.evaluate(`(() => {
        if (${fxPanelSel}) return;
        Array.from(document.querySelectorAll('.track')[0].querySelectorAll('button')).find(b => b.textContent.includes('FX')).click();
      })()`);
      await waitFor(`!!(${fxPanelSel})`);
    }
```

Delete this whole function (the panel is always present now, so there's nothing left to open). Find its two call sites and delete the call lines:

```js
      await openFxPanel();
```

(one in `'FX panel: adding Delay opens its popover with a working knob'`, one in the `'FX panel: the "+ Add effect" menu actually paints on top...'` step) — delete both lines. Nothing else in either step depends on the deleted call (both already proceed straight to interacting with `.th-fx-panel`, which now exists unconditionally).

- [ ] **Step 11: Run the full suite**

Run: `node verify.js`

Expected: every step passes, apart from the two documented pre-existing flaky steps. Pay particular attention to the FX-panel-family steps and the four rewritten waveform steps (8a-8d) — these are the ones most likely to reveal a missed selector or a step-ordering assumption broken by removing the FX toggle.

- [ ] **Step 12: Commit**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Restructure the track header into labelled Osc/Inserts/Output sections

Widens the header to 260px, groups its controls under section captions
matching the Pro Tools-inspired design, replaces the waveform picker
(six-to-ten buttons) with a plain <select> matching
renderAutomationRow()'s existing dropdown pattern, and removes the FX
show/hide toggle — Inserts is now always visible like the other two
sections. Rewrites the ~30 verify.js checks that used the old waveform
picker's presence as an "is this track tonal" marker.
EOF
)"
```

---

## Task 2: Insert chip lettering

**Files:**
- Modify: `index.html` (`buildFxPanel()` ~3853-3855, `buildFxChip()` ~3794-3813, CSS ~465-469)
- Modify: `verify.js` (one assertion in the chip-order test)

**Interfaces:**
- Consumes (from Task 1): `buildFxPanel()`'s current shape (`visibleFxFor(track)` → `chipRow`).
- Produces: `buildFxChip(track, effect, letter)` — one new parameter, a cosmetic sequential letter computed by the caller from the effect's position in `visibleFxFor(track)`.

- [ ] **Step 1: Compute and pass the letter in `buildFxPanel()`**

Find (index.html:3853-3855):

```js
  const visible = visibleFxFor(track);
  const chipRow = el('div', 'th-fx-chip-row');
  for (const effect of visible) chipRow.appendChild(buildFxChip(track, effect));
```

Change to:

```js
  const visible = visibleFxFor(track);
  const chipRow = el('div', 'th-fx-chip-row');
  // A, B, C… by current position only — not a stored slot id. Recomputed
  // fresh every render from visibleFxFor()'s current length, so removing
  // chip "B" reflows the rest (what was "C" becomes "B") rather than
  // leaving a gap, exactly as if nothing were persisted at all (because
  // nothing is — see docs/superpowers/specs/2026-07-29-track-header-redesign.md §4).
  visible.forEach((effect, i) => chipRow.appendChild(buildFxChip(track, effect, String.fromCharCode(65 + i))));
```

- [ ] **Step 2: Render the letter in `buildFxChip()`, as a sibling of the label — not concatenated into it**

Find (index.html:3794-3803):

```js
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
```

Change to:

```js
function buildFxChip(track, effect, letter) {
  const bypassed = isFxBypassed(track, effect.key);
  const open = fxPopoverOpen.has(track + '::' + effect.key);
  const chip = el('div', 'th-fx-chip' + (bypassed ? ' bypassed' : '') + (open ? ' open' : ''));
  const body = el('button', 'th-fx-chip-body');
  body.type = 'button';
  body.title = `${letter} — ${effect.label}`;
  // A separate element from the label span (not `${letter} ${effect.label}`
  // concatenated into one string) so verify.js's existing exact-match label
  // checks (`... === 'EQ'`) keep working unchanged — the letter is purely
  // additive, visually and in the DOM.
  const letterSpan = el('span', 'th-fx-chip-letter'); letterSpan.textContent = letter;
  body.append(letterSpan, glyph(effect.icon));
  const label = document.createElement('span'); label.textContent = effect.label;
  body.appendChild(label);
```

- [ ] **Step 3: CSS for the letter**

Find (index.html, `.th-fx-chip-body .glyph` rule):

```css
  .th-fx-chip-body .glyph { width: 16px; height: 8px; }
```

Add immediately after it:

```css
  .th-fx-chip-letter { color: #6f6f7a; font-weight: 700; }
```

- [ ] **Step 4: Manual smoke check**

Run: `node dev.js`

Add EQ, then Comp, then Delay to a track's Inserts section. Confirm chips read "A EQ", "B Comp", "C Delay" (in registry order, not add order — matching the existing reorder-independence guarantee). Remove the EQ chip ("A"). Confirm Comp's letter becomes "A" and Delay's becomes "B" (reflowed, no gap).

- [ ] **Step 5: Update the chip-order `verify.js` test for the new label format**

Find (verify.js, the `'FX panel: EQ chip renders before Comp regardless of add order...'` step's chip-order read):

```js
      const chipLabels = await cdp.evaluate(`[...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body span')].map(s => s.textContent)`);
```

This now also picks up each chip's new `.th-fx-chip-letter` span (an *extra* `span` inside `.th-fx-chip-body`, per Step 2), doubling the array (`['A', 'EQ', 'B', 'Comp', ...]` instead of `['EQ', 'Comp', ...]`). Change to scope past the letter specifically:

```js
      const chipLabels = await cdp.evaluate(
        `[...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body')].map(b => b.querySelector('span:not(.th-fx-chip-letter)').textContent)`);
```

The rest of that step (the `indexOf('EQ')`/`indexOf('Comp')` comparison right after) needs no further change — it already operates on the array of plain labels, which this fix restores.

Search the rest of `verify.js` for any other `.th-fx-chip-body span` query (there is at least one more, in the `addFxEffect()` helper's "already added?" check and possibly the bypass-test's chip lookup) and apply the same `:not(.th-fx-chip-letter)` scoping wherever a chip's label text is being read for an exact match. Run `grep -n "th-fx-chip-body span\|th-fx-chip-body').textContent" verify.js` to find every site before editing, since a missed one will silently start comparing against `'A'`/`'B'` instead of `'EQ'`/`'Comp'`.

- [ ] **Step 6: Run the full suite**

Run: `node verify.js`

Expected: every step passes apart from the two documented pre-existing flaky steps.

- [ ] **Step 7: Commit**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Add cosmetic sequential lettering (A, B, C…) to insert chips

Purely a display label, computed fresh from each chip's current position
in visibleFxFor() every render — no stored slot id, no fixed count,
keeping the flexible add-list design the FX insert-slots feature already
established. Rendered as a sibling span, not concatenated into the
existing label text, so it doesn't disturb any exact-match label check.
EOF
)"
```

---

## Task 3: Floating popup portal (fixes the `.daw` clipping bug)

**Files:**
- Modify: `index.html` (new `<div id="floating-fx-layer">` in the static HTML ~line 1269, `render()` ~2983, `buildFxPopover()` ~3814-3832, `buildFxChip()`/`buildFxBypassButton()`/`buildFxRemoveButton()`/`removeFxChip()` for `data-*` attributes, `buildFxPanel()`'s add-menu block ~3857-3894, the light-dismiss `click`/`keydown` handlers ~3447-3464, CSS for `.th-fx-popover`/`.th-fx-add-menu`)
- Modify: `verify.js` (every step that queries `.th-fx-popover`/`.th-fx-add-menu` as a descendant of `.th-fx-panel` — they move to a new top-level container)

**Interfaces:**
- Consumes (from Task 1): `buildFxPanel()`'s always-visible shape, `.th-osc-select` as the tonal marker.
- Consumes (from Task 2): `buildFxChip(track, effect, letter)`'s signature (unchanged by this task).
- Produces: `renderFloatingFxLayer()`, called from `render()` right after `renderTracks()`. `#floating-fx-layer` (a `document.body`-level container, cleared and rebuilt every render — mirroring how `#tracks` itself is cleared and rebuilt, not the "build once, reposition" pattern `createOverlays()` uses, since the floating layer's *contents* are dynamic in count while the playhead/loop chrome's are fixed).

- [ ] **Step 1: Add the floating layer container to the static HTML**

Find (index.html, right before the module script tag):

```html
  <textarea id="exportBox" style="display:none" readonly></textarea>

<script type="module">
```

Change to:

```html
  <textarea id="exportBox" style="display:none" readonly></textarea>

  <!-- Portal target for the FX popover/add-menu — see renderFloatingFxLayer().
       A plain top-level body child (not nested in .daw or .editor-layout) so
       position:fixed content here is never clipped by .daw's own
       overflow:auto, which a z-index fix alone cannot undo. -->
  <div id="floating-fx-layer"></div>

<script type="module">
```

- [ ] **Step 2: CSS for the floating layer and its contents**

Find (index.html, the current `.th-fx-add-menu` rule):

```css
  .th-fx-add-menu {
    position: absolute; top: 100%; left: 0; z-index: 20; margin-top: 3px; min-width: 120px;
    background: #1c1c22; border: 1px solid #3a3a44; border-radius: 6px; padding: 2px;
    display: flex; flex-direction: column; box-shadow: 0 4px 12px rgba(0,0,0,0.45);
  }
```

Change to:

```css
  /* #floating-fx-layer itself needs no box styling — it's a plain
     full-viewport-relative anchor point; each child inside it carries its
     own position:fixed left/top set inline by renderFloatingFxLayer(). */
  #floating-fx-layer { position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 60; }
  .th-fx-add-menu {
    position: fixed; min-width: 120px;
    background: #1c1c22; border: 1px solid #3a3a44; border-radius: 6px; padding: 2px;
    display: flex; flex-direction: column; box-shadow: 0 4px 12px rgba(0,0,0,0.45);
  }
```

Find (index.html, the current `.th-fx-popover` rule):

```css
  .th-fx-popover { border: 1px solid #3a3a44; border-radius: 6px; background: #1c1c22; padding: 6px 8px; }
```

Change to:

```css
  .th-fx-popover {
    position: fixed; border: 1px solid #4a4a56; border-radius: 8px; background: #1c1c22;
    padding: 0; box-shadow: 0 10px 30px rgba(0,0,0,0.6); min-width: 140px;
  }
```

Find (index.html, the current `.th-fx-popover-head` rule):

```css
  .th-fx-popover-head {
    display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
    font-size: 10px; font-weight: 700; color: var(--muted);
  }
```

Change to:

```css
  /* Now a title bar (Pro Tools plugin-window style) rather than an inline
     panel's in-flow heading — its own background/border-radius/border-bottom
     frame the floating window's top edge. */
  .th-fx-popover-head {
    display: flex; align-items: center; gap: 6px;
    font-size: 10px; font-weight: 700; color: var(--muted);
    background: #26262e; border-bottom: 1px solid #3a3a44; border-radius: 8px 8px 0 0;
    padding: 6px 8px;
  }
```

Find (index.html, the current `.th-fx-popover-fields` rule):

```css
  .th-fx-popover-fields { display: flex; flex-wrap: wrap; gap: 10px; }
```

Change to:

```css
  .th-fx-popover-fields { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 8px; }
```

- [ ] **Step 3: Tag chips and the add-button with `data-track`/`data-key` so `renderFloatingFxLayer()` can find them after `renderTracks()` rebuilds the header**

Find (index.html, `buildFxChip`, after Task 2's edit — the line building `chip`):

```js
  const chip = el('div', 'th-fx-chip' + (bypassed ? ' bypassed' : '') + (open ? ' open' : ''));
```

Change to:

```js
  const chip = el('div', 'th-fx-chip' + (bypassed ? ' bypassed' : '') + (open ? ' open' : ''));
  chip.dataset.track = track; chip.dataset.key = effect.key;
```

Find (index.html, `buildFxPanel()`, the add-button):

```js
  const addBtn = el('button', 'th-fx-add-btn'); addBtn.type = 'button'; addBtn.textContent = '+ Add effect';
```

Change to:

```js
  const addBtn = el('button', 'th-fx-add-btn'); addBtn.type = 'button'; addBtn.textContent = '+ Add effect';
  addBtn.dataset.track = track;
```

- [ ] **Step 4: Split `buildFxPanel()` — stop building the popover/add-menu inline, keep only the trigger chips/button**

Find (index.html, `buildFxPanel()`'s add-menu block through the end of the function):

```js
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

Replace with:

```js
  addWrap.appendChild(addBtn);
  chipRow.appendChild(addWrap);
  panel.appendChild(chipRow);
  // Popovers and the add-menu itself no longer render here — see
  // buildFloatingAddMenu()/buildFxPopover() and renderFloatingFxLayer(),
  // called once after every track's header (this function included) has
  // been rebuilt, so their trigger elements' on-screen positions are known.
  return panel;
}
// The "+ Add effect" menu's content, built the same way the old inline
// version was, just relocated into the floating layer by
// renderFloatingFxLayer() instead of appended here directly.
function buildFloatingAddMenu(track) {
  const visible = visibleFxFor(track);
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
  return menu;
}
```

- [ ] **Step 5: Write `renderFloatingFxLayer()` and call it from `render()`**

Find (index.html:2983-2991):

```js
function render() {
  if (renderRafId != null) { cancelAnimationFrame(renderRafId); renderRafId = null; }
  renderTimeline();
  renderTracks();
  positionOverlays();
  renderInspector();
  autosave();
  checkpointHistory();
}
```

Change to:

```js
function render() {
  if (renderRafId != null) { cancelAnimationFrame(renderRafId); renderRafId = null; }
  renderTimeline();
  renderTracks();
  renderFloatingFxLayer();
  positionOverlays();
  renderInspector();
  autosave();
  checkpointHistory();
}
```

Add the new function right after `render()` (before the `scheduleRender()`/`renderRafId` block that already follows it):

```js
// Rebuilds #floating-fx-layer from scratch every render — the same
// "clear and rebuild" approach renderTracks() itself uses for #tracks,
// rather than createOverlays()'s "build once, only reposition" pattern,
// since the floating layer's *contents* are dynamic in count (any number of
// popovers, at most one add-menu) while the playhead/loop chrome is always
// exactly one of each. Must run AFTER renderTracks(), since it locates each
// popup's trigger element (a chip or the add-button) by data-track/data-key
// in the just-rebuilt header DOM to read its on-screen position.
function renderFloatingFxLayer() {
  const layer = document.getElementById('floating-fx-layer');
  layer.innerHTML = '';
  // Anchors a built popup element under its trigger's on-screen position —
  // position:fixed, so viewport-relative regardless of #floating-fx-layer's
  // own DOM location. 6px below the trigger, clamped so it can't render
  // off the right/bottom edge of the viewport.
  function place(triggerEl, popupEl) {
    layer.appendChild(popupEl); // must be in the layer before measuring its own size
    const r = triggerEl.getBoundingClientRect();
    const pw = popupEl.offsetWidth, ph = popupEl.offsetHeight;
    const left = Math.min(r.left, window.innerWidth - pw - 8);
    const top = Math.min(r.bottom + 6, window.innerHeight - ph - 8);
    popupEl.style.left = Math.max(8, left) + 'px';
    popupEl.style.top = Math.max(8, top) + 'px';
  }
  for (const key of fxPopoverOpen) {
    const sep = key.indexOf('::');
    const track = key.slice(0, sep), effectKey = key.slice(sep + 2);
    const effect = TRACK_FX_REGISTRY.find((e) => e.key === effectKey);
    const chip = document.querySelector(`.th-fx-chip[data-track="${track}"][data-key="${effectKey}"]`);
    if (!effect || !chip) continue; // track/effect removed since this popover was opened
    place(chip, buildFxPopover(track, effect));
  }
  if (fxAddMenuOpen != null) {
    const btn = document.querySelector(`.th-fx-add-btn[data-track="${fxAddMenuOpen}"]`);
    if (btn) place(btn, buildFloatingAddMenu(fxAddMenuOpen));
  }
}
```

- [ ] **Step 6: Close floating popups when `.daw` scrolls**

Find the existing light-dismiss handlers (index.html, right after the `fxPopoverOpen`/`fxAddMenuOpen` declarations from Task 1 Step 5):

```js
document.addEventListener('click', (e) => {
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

Change to (the `closest()` selector list gains `.th-fx-add-menu` — the add-menu itself is no longer a descendant of `.th-fx-add` once portaled out, so a click inside it needs its own explicit exemption; `.th-fx-popover` already covers popover clicks whichever container it's rendered into, since that's a class-name match, not a DOM-position one):

```js
document.addEventListener('click', (e) => {
  if (!fxPopoverOpen.size && fxAddMenuOpen == null) return;
  if (e.target.closest('.th-fx-popover, .th-fx-chip, .th-fx-add, .th-fx-add-menu')) return;
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
// A position:fixed popup does not move with .daw's own scroll, so without
// this it would visually detach from the chip it belongs to the instant the
// user scrolls .daw — closing it (same as an outside click) is simpler and
// more honest than live-repositioning it to track the scroll.
document.getElementById('daw').addEventListener('scroll', () => {
  if (!fxPopoverOpen.size && fxAddMenuOpen == null) return;
  fxPopoverOpen.clear();
  fxAddMenuOpen = null;
  render();
});
```

- [ ] **Step 7: Manual smoke check**

Run: `node dev.js`

Add several effects to a track near the bottom of a longer song (enough tracks that the old bug would have reproduced). Confirm each popup/add-menu is fully visible, never clipped or hidden behind another track's header or the master strip. Confirm outside-click and Escape still close them. Confirm scrolling `.daw` closes any open popup/menu. Confirm two popovers on different tracks can be open at once, both fully visible. Confirm removing a track that has an open popover doesn't leave a stranded floating element (its `fxPopoverOpen` entry is already cleaned up by `removeTrack()`'s existing loop — this is a regression check, not new code).

- [ ] **Step 8: Rewrite `verify.js`'s FX-panel helpers and every step that queries `.th-fx-popover`/`.th-fx-add-menu` as a descendant of `.th-fx-panel`**

The popover/add-menu no longer live inside `.th-fx-panel` (or inside the track header at all) — they're children of `#floating-fx-layer`. Any selector shaped like `(${fxPanelSel}).querySelector('.th-fx-popover...')` or `(${headSel}).querySelector('.th-fx-add-menu')` will now always return `null`. Since both classes are unique to this feature (nothing else in the app uses `.th-fx-popover`/`.th-fx-add-menu`), the fix is to query them from `document` directly instead of scoped to a track's panel/header — they don't need panel-scoping any more, since `#floating-fx-layer` only ever holds the current track's open popups at read time in each of these single-track test scenarios.

Find (verify.js, the `addFxEffect()`/`stepKnob()`/`knobText()` helpers defined near the top of the FX-panel test block):

```js
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
```

Replace with (only the `.th-fx-popover`/`.th-fx-add-menu` lookups change, from panel-scoped to `document`-scoped — `addFxEffect`'s already-added check stays panel-scoped, since chips themselves are still inside `.th-fx-panel`):

```js
    async function addFxEffect(label) {
      const already = await cdp.evaluate(`!![...(${fxPanelSel}).querySelectorAll('.th-fx-chip-body')].find(b => b.querySelector('span:not(.th-fx-chip-letter)').textContent.trim() === ${JSON.stringify(label)})`);
      if (already) return;
      await cdp.evaluate(`(${fxPanelSel}).querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      await cdp.evaluate(`[...document.querySelectorAll('.th-fx-add-menu button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
      await waitFor(`!!document.querySelector('.th-fx-popover[data-key]')`);
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
```

(`stepKnob`/`knobText` already query `document.querySelector('.th-fx-popover[data-key="..."]')` directly — no change needed there; they were never panel-scoped in the first place, per the code as originally written. Only `addFxEffect`'s two `${fxPanelSel}` uses for the add-menu, and the chip-label lookup's `span:not(.th-fx-chip-letter)` scoping from Task 2 Step 5, change here.)

Search the rest of `verify.js` for every remaining `(${...}).querySelector('.th-fx-popover` and `(${...}).querySelector('.th-fx-add-menu` pattern (i.e. anything that scopes one of these two selectors to a panel/head variable instead of `document`) — there are several in the rhythm/tonal Vibrato test and the bypass/automation tests. Run:

```bash
grep -n "querySelector('\.th-fx-popover\|querySelector('\.th-fx-add-menu" verify.js
```

For each hit shaped like `(${somePanelOrHeadVar}).querySelector('.th-fx-popover...')` or `(${somePanelOrHeadVar}).querySelector('.th-fx-add-menu...')`, replace the `(${somePanelOrHeadVar})` prefix with `document` (or drop the prefix and call `document.querySelector(...)`/`document.querySelectorAll(...)` directly) — the popover/add-menu are never inside that scoping element any more. Leave every other selector in each matched line (e.g. `.th-fx-chip`, `.th-fx-panel`, `.th-knob`) exactly as scoped today; only the two floated-out selectors move to `document`.

One exception needing more than a scope swap: the `'FX panel: the "+ Add effect" menu actually paints on top of the next track, not just in the DOM'` step. Its whole premise — the add-menu might render behind a sibling track's header, found via `head.parentElement.nextElementSibling.querySelector('.track-header')` and an `elementFromPoint` overlap check — no longer applies: the menu is `position: fixed` in `#floating-fx-layer`, entirely outside the header stacking-context tree this step was testing. Find this whole step and replace it with a direct assertion that the menu is a child of `#floating-fx-layer` and its computed position is `fixed`:

```js
    step('FX panel: the "+ Add effect" menu renders in the floating layer, not clipped by .daw', async () => {
      // The bug this used to chase (a sibling track's header painting over
      // the menu inside .daw's own stacking context) can't happen any more
      // now that the menu is portaled to #floating-fx-layer, a
      // document.body-level, position:fixed element with no ancestor
      // overflow box left to clip against. This checks that portal
      // relationship directly instead of re-deriving an overlap that no
      // longer has anything to overlap with.
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-select')`);
      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-osc-select'))`;
      await cdp.evaluate(`(${headSel}).querySelector('.th-fx-panel').querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      const result = await cdp.evaluate(`(() => {
        const menu = document.querySelector('.th-fx-add-menu');
        return {
          inLayer: menu.parentElement && menu.parentElement.id === 'floating-fx-layer',
          position: getComputedStyle(menu).position,
        };
      })()`);
      if (!result.inLayer) throw new Error('the add-effect menu should be a direct child of #floating-fx-layer');
      if (result.position !== 'fixed') throw new Error(`expected the add-effect menu to be position:fixed, got ${result.position}`);
    });
```

- [ ] **Step 9: Add a `verify.js` regression test for the actual clipping fix**

This proves the original bug (the menu rendering somewhere the viewport can't show it, near the bottom of a scrolled `.daw`) can no longer happen, complementing Step 8's structural check. Add this as a new step, placed anywhere after the app has loaded its default multi-track starter layout:

```js
    step('FX panel: the add-effect menu stays fully on-screen even opened near the bottom of a scrolled .daw', async () => {
      // Reproduces the original bug's trigger condition directly: scroll
      // .daw so a track's FX panel sits near the very bottom of the visible
      // area, then open its add-menu and confirm the whole menu's
      // bounding box is inside the viewport — the concrete, user-visible
      // symptom "the menu doesn't show" was actually "renders outside what
      // .daw lets you see."
      await goto(APP_URL);
      await waitFor(`!!document.querySelector('.th-osc-select')`);
      await cdp.evaluate(`document.getElementById('daw').scrollTop = 999999`); // scroll to the bottom
      const headSel = `[...document.querySelectorAll('.track-header')].find(h => h.querySelector('.th-fx-panel'))`;
      await cdp.evaluate(`(${headSel}).querySelector('.th-fx-add-btn').click()`);
      await waitFor(`!!document.querySelector('.th-fx-add-menu')`);
      const box = await cdp.evaluate(`(() => {
        const r = document.querySelector('.th-fx-add-menu').getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
      })()`);
      if (box.top < 0 || box.left < 0 || box.right > box.vw || box.bottom > box.vh) {
        throw new Error(`add-effect menu rendered partly outside the viewport: ${JSON.stringify(box)}`);
      }
    });
```

- [ ] **Step 10: Run the full suite**

Run: `node verify.js`

Expected: every step passes apart from the two documented pre-existing flaky steps, including both new/rewritten Step 8/9 steps.

- [ ] **Step 11: Commit**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Move the FX popover and add-menu to a floating, portal-rendered layer

Fixes the confirmed .daw-overflow clipping bug (see the
fx_add_menu_clipping_bug memory and docs/superpowers/specs/2026-07-29-track-header-redesign.md
§2): both now render as position:fixed children of a new
#floating-fx-layer, a document.body-level container rebuilt every
render() rather than nested inside the scrolling .daw. Positioned from
each trigger's live getBoundingClientRect(), closes on outside
click/Escape (unchanged) and now also on .daw scrolling (a fixed-position
popup can't track scroll without live repositioning, so closing it is the
simpler, honest choice). Not draggable — always reopens at its trigger.
EOF
)"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-29-track-header-redesign.md`):
- §1 (width, sections) → Task 1.
- §2 (floating popups, shared mechanism, scroll-close, non-draggable, fixes the add-menu bug) → Task 3.
- §3 (waveform dropdown) → Task 1.
- §4 (chip lettering, cosmetic only) → Task 2.
- Resolved ambiguity (confirmed with the user before writing this plan): the spec's text said the FX toggle button stays, but the approved mockup showed Inserts always-visible — Task 1 removes the toggle, matching the mockup.
- Out-of-scope items (knob internals, bypass mechanism, registry order, draggable windows, data model) → untouched by all three tasks.

**Placeholder scan:** no TBD/TODO; every step has exact code, an exact command, or a mechanical rename with a verifiable line list and a post-condition `grep` check (used only where the transformation is a pure, uniform string substitution — never in place of showing real code for a logic change).

**Type consistency:** `buildFxChip(track, effect, letter)`'s new third parameter (Task 2) is threaded through consistently: Task 1 doesn't touch `buildFxChip`'s signature, and Task 3's `renderFloatingFxLayer()` calls `buildFxPopover(track, effect)` (unchanged arity) and `buildFloatingAddMenu(track)` (new, Task 3-only) — neither collides with Task 2's `buildFxChip` change. `data-track`/`data-key` attributes (Task 3 Step 3) are read by the exact same names in `renderFloatingFxLayer()`'s selectors.
