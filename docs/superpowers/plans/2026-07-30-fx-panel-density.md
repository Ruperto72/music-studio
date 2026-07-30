# FX panel density: track strip + honest activeFx — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the per-track FX editing surface out of the 260 px header
column and into the 244 px inspector column, shrink what stays in the header
to a status row, and make `state.activeFx` describe what is actually
audible rather than a separately-maintained list.

**Architecture:** Presentation plus three `activeFx` semantics fixes — no
DSP, no audio-graph change, no song-file field change. `renderInspector()`
grows a second mode (nothing selected → the active track's strip) built from
the existing `TRACK_FX_REGISTRY` and the existing `buildKnob()`. The
per-insert popover (`buildFxPopover`/`fxPopoverOpen`) is deleted and its
bypass/remove buttons move into the strip's section headers; master FX
popovers keep the same `.th-fx-popover*` CSS and floating-layer machinery
untouched. `visibleFxFor()` starts consulting `state.automation`, and
`removeFxChip()` starts clearing it.

**Tech Stack:** Vanilla JS/DOM (`index.html`'s single `<script type="module">`), no build step, `verify.js` (headless-Chrome CDP smoke test) for verification.

**Design doc:** `docs/superpowers/specs/2026-07-30-fx-panel-density-design.md`

## Global Constraints

- **No audio-graph or DSP change.** Every value, range, default and node
  stays exactly as it is. `createTrackFxSends()`, `buildChannelChain()`,
  `scheduleAutomationForChunk()` and the `effectiveTrackX()`/
  `effectiveFxSend()` family are read-only reference material here.
- **No song-file shape change.** `state.activeFx` keeps its `id -> {
  [effectKey]: { bypassed } }` shape; `applySavedMix()`'s `activeFx`
  validation block (line ~2445) and `currentSongData()` are untouched. A
  song saved from `main` today must load into the new build unchanged, and
  vice versa.
- **`SPARSE_TRACK_MAPS` is not modified.** `activeFx` is already its twelfth
  entry and stays there.
- **Master FX is out of scope.** `MASTER_FX_REGISTRY`,
  `buildMasterFxChip`/`buildMasterFxPopover`, `masterFxPopoverOpen` and
  `renderMasterFxChips()` are not touched. The `.th-fx-popover*` CSS block
  (lines ~529-545) therefore **stays** even though track popovers stop using
  it.
- The strip reuses `buildKnob(ariaLabel, field, value, onInput, defaultValue)`
  exactly as it is — no new knob widget, no signature change.
- Follow the file's standing rule: mutate `state`, then `render()` (and
  `autosave()` where it should persist) — never patch the DOM outside a
  render pass.
- `verify.js` additions use the existing `step(name, async () => {…})` +
  `cdp.evaluate`/`waitFor` idiom. The existing helpers `addFxEffect` /
  `stepKnob` / `knobText` (lines ~576-605) are **repointed, not duplicated**.

---

## Task 1: Fix the failing verify step's geometry

Must land first: Task 2 changes what sits at the coordinate this step
clicks, so fixing it afterwards would confuse a real regression with this
pre-existing failure.

**Files:** Modify `verify.js` — the step `'FX: a real trusted click through
the grid still lands after light-dismiss closes a popover'`.

**Diagnosis (already done, do not re-derive):** the step clicks at
`lane.left + 200, lane.top + 60`. In the default 800×600 headless window the
lane is `left 317, top 201, width 1024` while the viewport is `780 × 493`, so
that point is at `(517, 261)` — `document.elementFromPoint` there returns
`.inspector`, not the lane. The control case proves it is not light-dismiss:
**the same click with no popover open also places no note** (`0 -> 0`).

- [ ] **Step 1: Pick a point that is verified to be over the lane**

Before dispatching, assert the target: compute the point, call
`document.elementFromPoint(x, y)`, and require it to be inside the intended
`.lane` (`el.closest('.lane') === lane`). If it is not, fail with the element
that was hit and both rects — a silent mis-aim is what made this step look
like an app bug for a day.

Choose the point from the lane's *visible* intersection with the viewport
rather than a fixed `+200/+60` offset, e.g. clamp to
`min(lane.right, innerWidth) - margin`.

- [ ] **Step 2: Re-run and confirm the step passes**

`node verify.js` — the step must pass, and the second assertion (the outside
click also dismissed the popover) must be *reached*, not skipped.

- [ ] **Step 3: Confirm it still catches the bug it was written for**

Re-introduce the original regression (rebuild the DOM on `pointerdown` in the
light-dismiss handler) and confirm the step fails. A geometry fix that also
disarmed the assertion would be worse than the broken step.

---

## Task 2: The track strip in the inspector column

**Files:**
- Modify: `index.html` — `renderInspector()` (line ~5524), the `<aside
  class="inspector-column">` markup (line ~1280), and a new `.th-strip-*`
  CSS block.

**Interfaces:**
- Consumes: `TRACK_FX_REGISTRY`, `trackFxFor(track)`, `visibleFxFor(track)`,
  `isFxBypassed()`, `buildKnob()`, `FX_FIELD_DEFAULTS`, `state.activeTrack`.
- Produces: `renderTrackStrip(track)` and `buildStripSection(track, effect)`,
  both called only from `renderInspector()`.

- [ ] **Step 1: Second mode in `renderInspector()`**

Today (line ~5532):

```js
  if (!item) {
    inspector.className = 'inspector empty';
    inspector.textContent = 'Nothing selected. Click a note or a drum hit to edit it, or pen a cell to add one.';
    return;
  }
```

becomes: when there is no selected item **and** `state.activeTrack` exists,
render the strip instead. Keep the `empty` class and the placeholder text
only when there is no active track at all — `.inspector.empty { display:
none }` is what keeps the mobile bottom sheet closed (Task 2 Step 5), so the
class must keep meaning "genuinely nothing to show".

`document.body.classList.toggle('has-sel', …)` keeps its current meaning
(a *note* is selected) — the mobile close button is about the note sheet.

- [ ] **Step 2: `renderTrackStrip(track)`**

Header: track name + colour swatch, so it is obvious which track the strip
belongs to when the grid is scrolled away from it.

Body: one section per `visibleFxFor(track)` entry, in the same order the
chips use, so the letters match. Below them, a muted list of the effects
that are still at their defaults with a "+" to reveal one — the same set the
add-menu offers (Task 5 Step 3).

- [ ] **Step 3: `buildStripSection(track, effect)`**

Section head: the effect's letter, `glyph(effect.icon)`, `effect.label`,
then the **bypass** and **remove** buttons — reuse
`buildFxBypassButton(track, effect)` and `buildFxRemoveButton(track,
effect)` verbatim; they are already standalone.

Section body: one `buildKnob()` per `effect.fields` entry, same
`aria-label`/`defaultValue` construction the popover does today (lift it
from `buildFxPopover()` before that function is deleted in Task 3 — this is
the one place its code is worth keeping).

A bypassed section gets the existing dimmed treatment (`.th-fx-popover.bypassed`
is `opacity: 0.55`; use an equivalent `.th-strip-section.bypassed`).

- [ ] **Step 4: `aria-label` on the column**

`<aside class="inspector-column" aria-label="Note inspector">` becomes
something covering both modes, e.g. `aria-label="Inspector"`, since it now
shows either a note or a track. The inner `#inspector` div keeps its id —
`renderInspector()`, the mobile CSS and `#insp-close` all key off it.

- [ ] **Step 5: Mobile**

Below ~760 px, `.inspector` is a fixed bottom sheet hidden while `.empty`.
The strip must **not** open that sheet merely because a track is active:
gate the strip mode on a wide layout, or on an explicit chip tap that sets a
"strip requested" flag cleared on dismiss. Verify by hand at ≤760 px that
the sheet is still absent on load.

- [ ] **Step 6: Screenshot check**

Capture at 1600×1000 with Rust Foundry loaded and confirm the strip is
legible at 244 px with seven effects — this is the width question the spec
could not settle on paper.

---

## Task 3: Retire the per-insert popover

Depends on Task 2: the strip must exist before the popover goes.

**Files:** Modify `index.html` — `buildFxChip()` (line ~4021),
`buildFxPopover()` (line ~4055, deleted), `fxPopoverOpen` (line 3617),
`renderFloatingLayer()` (lines 3138-3150), `anyFloatingMenuOpen()` /
`closeAllFloatingMenus()` (3632-3633), the light-dismiss selector (3636),
`removeTrack()`'s cleanup (3377), `removeFxChip()` (4017) and
`buildFxPanel()`'s Reset handler (~4172).

- [ ] **Step 1: Chip click selects instead of toggling a popover**

In `buildFxChip()`, replace the click body:

```js
    const popKey = track + '::' + effect.key;
    if (fxPopoverOpen.has(popKey)) fxPopoverOpen.delete(popKey); else fxPopoverOpen.add(popKey);
    render();
```

with: make `track` active (`setActive(track)`), clear the note selection so
the strip is what the inspector shows, mark this effect as the strip's
focused section, `render()`, then scroll that section into view. The
`.th-fx-chip.open` class now means "this is the section the strip is showing"
— same CSS, new meaning.

- [ ] **Step 2: Delete `buildFxPopover()` and `fxPopoverOpen`**

Remove the function, the `const fxPopoverOpen = new Set()`, the
`for (const key of fxPopoverOpen)` block in `renderFloatingLayer()`, and the
three cleanup sites (`removeTrack`, `removeFxChip`, the Reset handler).
`anyFloatingMenuOpen()`/`closeAllFloatingMenus()` drop their `fxPopoverOpen`
terms but keep `masterFxPopoverOpen`, `fxAddMenuOpen` and `oscPickerOpen`.

The light-dismiss selector at 3636 keeps `.th-fx-popover` — **master
popovers still use that class**. Only `.th-fx-chip` changes meaning.

- [ ] **Step 3: Confirm master popovers are unaffected**

Open a master FX chip and confirm it still opens, positions, dismisses on
Escape/outside-click, and closes on `.daw` scroll.

---

## Task 4: Narrow the chips

Depends on Task 3: bypass/remove leave the chip only once the strip carries
them.

**Files:** Modify `index.html` — `buildFxChip()` and `.th-fx-chip*` CSS
(lines ~489-500).

- [ ] **Step 1: Drop bypass/remove from the chip**

`chip.append(body, buildFxBypassButton(...), buildFxRemoveButton(...))`
becomes `chip.append(body)`. Both buttons now live in the strip section head
(Task 2 Step 3), so each control appears exactly once.

- [ ] **Step 2: Letter + icon only**

Remove the name span from `body`; keep the `title` and `aria-label` (they
already carry `"${letter}, ${effect.label}"`, so the accessible name is
unchanged). Keep `.th-fx-chip-letter` and the glyph.

- [ ] **Step 3: Measure**

Re-run the measurement from the spec and record the real numbers in the
commit message. Target: chip row 152 px → ~56 px, header ~371 px → ~275 px.
If icon-only reads badly in the screenshot, fall back to letter + icon +
name (~70 px, three per line) and say so — half the saving is still worth
having, and the spec anticipated this.

---

## Task 5: Make `activeFx` describe what is audible

**Files:** Modify `index.html` — `visibleFxFor()` (2977), `removeFxChip()`
(4009), `buildFxPanel()`'s add button (~4190), and the automation toggle's
label.

- [ ] **Step 1: `visibleFxFor()` consults automation**

A chip shows when the effect is non-default **or** when a curve exists for
one of its params. Only the three sends have automatable params, so this is
a lookup keyed `sendDelay → 'delay'`, `sendChorus → 'chorus'`,
`sendReverb → 'reverb'` against `state.automation[track]`, requiring a
non-empty point list.

Put the mapping next to `AUTOMATION_PARAMS` rather than inline — it is the
second place that has to know sends are the automatable subset.

- [ ] **Step 2: `removeFxChip()` clears the curve too**

After `effect.set(track, FX_FIELD_DEFAULTS[effect.key])`, delete the
matching `state.automation[track][param]` (same mapping as Step 1) and drop
`state.automation[track]` entirely if it empties. Without this, removing a
Delay chip leaves a curve that keeps playing, because removal is not bypass
and `scheduleAutomationForChunk()` only gates on `isFxBypassed()`.

The track-level `Reset` handler in `buildFxPanel()` gets the same treatment.

- [ ] **Step 3: "+ Add effect" says what it does**

The button becomes `+` with `title` along the lines of "Show a control for
an effect this track isn't using yet". The menu still lists the effects
currently at their defaults. Nothing about `state.activeFx` writing changes
— `buildFloatingAddMenu`'s `state.activeFx[track][effect.key] = { bypassed:
false }` is exactly right under the new wording: it means "show this".

- [ ] **Step 4: Stale automation label**

The automation toggle still reads `Automation (volume/pan over time)`
though `AUTOMATION_PARAMS` has offered five since Delay/Chorus/Reverb became
automatable. Update the title/`aria-label` to name all five, or drop the
parenthetical.

---

## Task 6: verify.js coverage

**Files:** Modify `verify.js`.

- [ ] **Step 1: Repoint the three helpers**

`addFxEffect` waits on `.th-fx-popover[data-key]` today; `stepKnob` and
`knobText` locate a knob inside `.th-fx-popover[data-key="…"]`. All three
now target the strip section (`.th-strip-section[data-key="…"]`). The
knob-finding logic inside them is otherwise unchanged, which is the point:
if the strip reuses `buildKnob()` properly, only the container selector
moves.

Every existing step that reaches a knob (EQ, vibrato, bypass, …) should then
pass with no other edit. **Treat any step that needs more than the container
selector changed as a signal the strip diverged from the popover**, not as a
test to loosen.

- [ ] **Step 2: New step — the strip is the editing surface**

Nothing selected → the inspector shows the active track's strip, with one
section per visible chip in the same order; selecting a note replaces it
with the note inspector; deselecting brings it back. Assert there is **no**
`.th-fx-popover` with a track `data-key` anywhere after clicking a chip.

- [ ] **Step 3: New step — a curve makes its chip appear**

On a fresh track with `chips: []`, draw a Delay automation curve, and assert
a `sendDelay` chip appears. Inject the bug (drop the automation clause from
`visibleFxFor`) and confirm the step fails — this is the exact asymmetry the
spec was written around, and it is invisible without an explicit check.

- [ ] **Step 4: New step — removing an effect removes its curve**

Add a Delay chip, set a send level, draw a curve, remove the chip. Assert
both `fxSend[track].delay` is back to default **and**
`automation[track].delay` is gone, read from the autosave draft.

- [ ] **Step 5: New step — the chip row is compact**

Assert the chip row's height for a seven-effect track is under a threshold
(~70 px), so a future change that puts the names back gets caught rather
than silently costing 100 px of header per track.

---

## Task 7: Documentation

`CLAUDE.md`, `DESIGN.md` and `README.md` were not updated by PR #111 or the
two FX passes that followed, so they already describe a pre-redesign app —
the FX panel as "a compact 2-column grid" of static sliders, the waveform
picker as a `role="radiogroup"`, `SPARSE_TRACK_MAPS` with eleven entries.

- [ ] **Step 1: Catch up the sections this work touches**

DESIGN.md A.4 (track header), A.7 (track FX panel), A.13 (accessibility —
the inspector column now has two modes), B.2 (`activeFx` in the state
model). CLAUDE.md's Rendering and Audio-synthesis paragraphs. README's
feature bullets.

- [ ] **Step 2: Note what is *not* caught up**

The rest of yesterday's redesign (osc picker, master FX chips, envelope row)
is a separate documentation debt. Record it in `TODO.md` rather than
silently leaving the docs half-true.

- [ ] **Step 3: `sw.js`**

Bump `CACHE_NAME` — `index.html` is precached.

---

## Out of scope

- Master FX (chips, popovers, registry) — untouched.
- New automatable parameters. EQ/Comp/Crush/Tremolo stay static in this
  pass, and per-track **Vibrato can never be a curve**: it is threaded into
  each note at schedule time rather than being an insert, and its `apply` is
  deliberately a no-op, so there is no downstream node to ramp.
- Song-file format, `applySavedMix()`, `currentSongData()`.
- The note inspector's own contents — only *when* it renders changes.
