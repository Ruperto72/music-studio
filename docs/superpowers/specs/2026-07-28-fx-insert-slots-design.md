# Per-track FX insert slots with detail popovers

## Problem

`buildFxPanel()` (index.html:3471) renders all six `TRACK_FX_REGISTRY`
entries — Sends, EQ, Comp, Bitcrush, Tremolo, Vibrato — for every track,
always, as a flat 2-column grid of `<input type=range>` sliders. There is no
way to see at a glance which effects a track actually uses, and no room for
anything beyond a bare label + slider per parameter. The user wants a
Pro Tools-style channel strip instead: an explicit, per-track list of which
effects are "inserted", each with its own more detailed control surface
(knobs, a bypass toggle) reachable by clicking that effect.

Two changes, designed together since the second only makes sense once the
first exists:

1. Insert slots — an explicit per-track "which effects are active" list,
   rendered as removable chips, with a way to add more.
2. A detail popover per active effect — one knob per parameter, plus bypass.

## 1. Data model

### `state.activeFx`

New sparse per-track map, same shape convention as the other nine in
`SPARSE_TRACK_MAPS` (index.html:2225) — `state.activeFx[track]` absent means
"nothing explicitly added yet" (see the visibility rule below for what that
implies, which is *not* the same as "no chips show"):

```js
state.activeFx[track] = {
  eq:         { bypassed: false },
  sendReverb: { bypassed: true },
  // ...one entry per effect key the user has explicitly added, in any order
};
```

Added to `SPARSE_TRACK_MAPS` so `restoreTrackList()`, `createNewSong()`,
`removeTrack()`, `applySavedMix()` and `autosave()`/`currentSongData()` all
pick it up automatically through the existing shared loop — no new call
sites to hand-edit.

### Registry split: `fxSend` → three entries

`TRACK_FX_REGISTRY`'s single `fxSend` entry (three fields: delay/chorus/
reverb) becomes three entries — `sendDelay`, `sendChorus`, `sendReverb` —
each with one field. All three still read/write the same
`state.fxSend[track]` object via `getFxSend`/`setFxSend`/`applyFxSend`; only
how the registry groups them for the UI changes. `applyFxSend` stays one
function (it already loops `ALL_TRACKS` and writes all three gain nodes at
once) and is shared by all three registry entries' `apply`.

### Fixed registry order

Reordered to match the real audio chain (`chanGain → chanEq → chanComp →
chanCrush? → chanTremolo → {chanPan, sends}`, see buildChannelChain()
comments at index.html:6214-6228), with `vibrato` last since it sits outside
this chain entirely (threaded into oscillator scheduling instead):

```
eq, comp, crush, tremolo, sendDelay, sendChorus, sendReverb, vibrato
```

This order is **not** user-reorderable — insert order in a real mixer
matters because it changes the signal path, but here the signal path is
already fixed by `buildChannelChain()`, so letting the UI imply a
reorderable chain would be misleading. The chip list always renders in this
fixed order regardless of the order effects were added.

### Visibility rule (chip shows / doesn't show)

An effect's chip is visible if **either**:

- `state.activeFx[track][key]` exists (explicitly added), **or**
- `effect.get(track)` differs from that effect's `DEFAULT_*` constant in at
  least one field (field-by-field comparison, not object identity).

The second clause is what makes existing songs (e.g. `songs/cinematic.json`)
that already have real EQ/Comp/send values, but no `activeFx` entry (the
field doesn't exist in their saved JSON yet), show the right chips
immediately on load — no migration pass needed, and the panel never lies
about what's audible.

## 2. UI

### FX panel (`buildFxPanel()`, replaces its current body)

Opened the same way as today (the FX toolbar button, `fxSendOpen` Set,
unchanged). Renders:

- **Chips**, one per visible effect (per the rule above), in fixed registry
  order. Each chip: `glyph(effect.icon)` + label, a bypass button (⏻ — new
  glyph, filled when bypassed), and a ✕ (remove). Clicking the chip body
  (not the ⏻ or ✕) toggles its detail popover open/closed.
- **"+ Add effect"** button, opens a small menu listing `trackFxFor(track)`
  entries *not* currently visible. Picking one:
  1. Sets `state.activeFx[track][key] = { bypassed: false }` (fields stay at
     whatever `effect.get(track)` already returns — default, unless the
     visibility rule's second clause is what brought attention to it, which
     can't happen here since we only list *not-visible* effects).
  2. Opens that effect's detail popover immediately — landing straight in
     "adjust what you just added", not a second click to find it.
- **Reset** button: same as today (`delete state[effect.key][track]` +
  `effect.apply()` for every entry `trackFxFor(track)` returns) plus now
  also `delete state.activeFx[track]` — clears every chip along with every
  value.

Removing a single chip (✕): `delete state[effect.key][track]` (or the
relevant sub-field for the three send entries — see below),
`delete state.activeFx[track][key]`, `effect.apply()`. Matches the existing
Reset semantics already in the codebase: gone means back to the audible
default, not hidden-but-still-sounding.

The three `sendDelay`/`sendChorus`/`sendReverb` entries share one state
object (`state.fxSend[track]`); removing one of them patches just that
field back to `DEFAULT_FX_SEND`'s value for that field rather than deleting
the whole object (which would also reset the other two sends).

### Detail popover

Anchored under its chip (not freely draggable — same "opens in a fixed
place, no position bookkeeping" pattern as the existing Auto/Env panels).
Open/closed state lives in a new `Map` (`fxPopoverOpen`, keyed by
`` `${track}:${key}` ``), alongside `automationOpen`/`adsrOpen` — ephemeral
UI state, **not** serialized, **not** part of `SPARSE_TRACK_MAPS`. Closes on
Escape or a pointerdown outside the popover and its chip. Any number can be
open at once, across any tracks/effects.

Contents: title (label + icon), the same ⏻/✕ pair as the chip header, then
one **knob** per entry in `effect.fields` (EQ: three, Comp: four, sends: one
each). A bypassed popover renders with a dimmed/disabled visual treatment
but keeps showing the real stored values — bypass mutes the effect, it does
not hide what's dialed in.

### Knob component

New reusable widget (`buildKnob(track, field, value, onInput)` or similar),
pointer-driven in the same style as the app's other manual gesture state
machines (`startMoveNote`, `startResize`, etc.):

- Circular SVG/CSS dial, angle mapped from `field.min`..`field.max`.
- Vertical drag changes the value (drag up = increase), sensitivity scaled
  to the field's range so a full-height drag covers min→max.
- Double-click resets that one field to its `DEFAULT_*` value.
- Keyboard: roving tabindex (consistent with the grid's own roving-tabindex
  convention), arrow keys step by `field.step`, `role="slider"` with
  `aria-valuemin`/`aria-valuemax`/`aria-valuenow`/`aria-valuetext` (using
  `field.format(value)` for the text) and `aria-label` from `field.label` +
  the effect + track name — matching the accessibility bar the rest of the
  app holds itself to (see CLAUDE.md's Accessibility section).
- One new `GLYPHS` entry for the bypass power icon, following the existing
  "stroked with currentColor, aria-hidden, box shape driven by the glyph
  table" convention.

## 3. Audio: bypass

Bypass changes only what `apply()` writes into the audio graph — it does
**not** change what `get()` returns (the popover must keep showing the real
value while bypassed). New helper:

```js
function isFxBypassed(track, key) {
  return !!state.activeFx[track]?.[key]?.bypassed;
}
```

Six call sites gate their applied value on this (the only places that
actually push a `TRACK_FX_REGISTRY` value into the Web Audio graph):

- `applyFxSend` (index.html:6686) — per send field, use `DEFAULT_FX_SEND`'s
  value for that field instead of the stored one when
  `isFxBypassed(ch, 'sendDelay'|'sendChorus'|'sendReverb')`.
- `applyTrackEq` — use `DEFAULT_TRACK_EQ` instead of `getTrackEq(ch)` when
  `isFxBypassed(ch, 'eq')`.
- `applyTrackComp` — same, `DEFAULT_TRACK_COMP` / `'comp'`.
- `applyTrackCrush` — same, `DEFAULT_TRACK_CRUSH` / `'crush'`.
- `applyTrackTremolo` — same, `DEFAULT_TREMOLO` / `'tremolo'`.
- Vibrato's note-schedule call site (`scheduleTone`/
  `schedulePortamentoTone`, where `getTrackVibrato` feeds `addTrackVibrato`)
  — use `DEFAULT_VIBRATO` when `isFxBypassed(track, 'vibrato')`.

No change to `buildChannelChain()`, `buildMasterBus()`, or any node
construction — bypass is which *value* gets written, never a new node or a
new branch in the graph shape.

## 4. Testing

`verify.js` gets a new section (per the project's existing convention of
extending this script rather than writing throwaway scripts) exercising, on
one track:

- Add an effect via "+ Add effect" → chip appears, popover opens
  automatically.
- Drag/adjust a knob → `state` reflects the new value, chip's popover shows
  the updated `aria-valuenow`/formatted text.
- Toggle bypass → chip/popover show the dimmed state; confirm the relevant
  `chan*` node's param equals the default rather than the dialed-in value.
- Remove the chip → chip and popover gone, `state.activeFx[track][key]` and
  the underlying value both cleared.

Scoped to one track's controls throughout (`.closest()`), per the two traps
already called out in CLAUDE.md's `verify.js` section.

`auditBundledSongs()` (verify.js's first step) gets the new `activeFx` field
added to its validation: unknown effect key, track id that doesn't exist in
that song, `vibrato` present on a rhythm track — same shape of check it
already runs for the other `SPARSE_TRACK_MAPS` entries. Existing bundled
songs need no data changes; none currently have an `activeFx` field, and the
visibility rule (§1) means they don't need one.

## Out of scope

- Fixed lettered slots (A–E as in the Pro Tools reference) — the "+ Add
  effect" list has no slot-count ceiling.
- Reordering insert position in the UI — the chain order is fixed by
  `buildChannelChain()` and the chip list always reflects it.
- A real per-track Delay insert with its own delayTime/feedback/mix. Delay
  stays exactly what it is today — a continuous send to the shared
  tempo-synced delay bus — just relocated into its own chip/popover.
- A freely draggable/repositionable popover window, or multiple popovers
  stacking with z-index management — the popover is anchored, not a window.
- Any change to `buildChannelChain()`/`buildMasterBus()`/node construction
  order — this project only touches which values `apply()` writes and how
  they're presented, never the graph shape.
