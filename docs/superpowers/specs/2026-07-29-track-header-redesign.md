# Track header redesign: Pro Tools-inspired layout + floating FX popups

## Problem

The track header (`buildHeader()`, index.html) is a flat, unlabeled vertical
stack of rows in a fixed 200px column: identity row, waveform picker (six
buttons), a row of Auto/FX/Env tool toggles, volume, pan, VU meter, and —
since the FX insert-slots feature — a chip row for active effects. It works,
but reads as a list of controls rather than a mixer channel strip, and the
user wants it to feel more like a real DAW (Pro Tools specifically:
labelled groups, a numbered insert list, more breathing room).

Separately, the FX panel's "+ Add effect" dropdown has a confirmed,
reproduced bug: it can render invisibly, because it's `position: absolute`
nested inside `.daw` (the scrolling container holding every track), whose
`overflow-x: auto` computes `overflow-y: auto` too and clips anything that
extends past its own box — no z-index fix can undo an ancestor's overflow
clip (see the `fx_add_menu_clipping_bug` memory for the full root-cause
trail). The user chose to fix this as part of this redesign rather than as
a standalone patch, since the fix — a floating, portal-rendered popup — is
also what makes the FX effect detail view feel like a real plugin window.

Both pieces are designed together below since the floating-popup mechanism
is shared between them.

## 1. Header layout

Width goes from `--header-w: 200px` to **260px**. The identity row (collapse
toggle, reorder up/down, name, Mute/Solo, Record-arm, Remove — currently
`.th-top`) is unchanged; it isn't broken and the extra width isn't needed
there. Everything below it groups into three labelled sections, each a small
uppercase caption (matching the existing `.th-fx-popover-head`/mstrip-cap
type treatment) followed by its controls, with a hairline divider between
sections (same visual language `.th-fx-group` used to use before the FX
insert-slots rewrite):

- **Osc** — tonal tracks: the waveform picker (see §3) plus the existing
  Auto/Env/Preset tool-toggle row. Rhythm tracks: the existing "Kit" label
  plus Auto/Patterns (unchanged from today — this section's *content* isn't
  changing, only that it now sits under a caption).
- **Inserts** — the existing FX chip row and "+ Add effect" menu
  (`buildFxPanel()`), relabelled from "FX" to "Inserts", chips prefixed with
  a sequential letter (see §4). The FX toolbar toggle button that
  shows/hides this section stays where it is today (in the tools row above,
  now inside Osc).
- **Output** — Volume, Pan, and the VU meter, grouped under one caption
  instead of three unlabelled rows.

No change to which controls exist or what they do — this section is pure
layout/grouping/relabelling of what `buildHeader()`/`buildFxPanel()` already
build.

## 2. Floating popups (shared mechanism)

Both the FX effect detail view (currently `buildFxPopover()`, an inline
block that expands the header downward) and the "+ Add effect" menu
(currently `.th-fx-add-menu`, `position: absolute` inside the clipped
`.daw`) become the same kind of floating popup:

- **Portal-rendered**: appended as a direct child of `document.body`, not
  nested inside `.daw`/`.track-header` — this is what lets it escape
  `.daw`'s overflow clip entirely, unlike a z-index-only fix.
- **`position: fixed`**, with `left`/`top` computed from the trigger
  element's (`.th-fx-chip` for a popup, `.th-fx-add-btn` for the add menu)
  `getBoundingClientRect()` at the moment it's built. Recomputed on every
  `render()` call (cheap — a rect read plus two inline-style writes), so a
  layout shift elsewhere (e.g. another track's panel toggling open above
  this one) doesn't leave it stranded.
- **Closes on `.daw` scrolling.** A `position: fixed` element does not move
  with `.daw`'s own scroll, so without this a popup would visually detach
  from the chip it belongs to the moment the user scrolls. Closing it (same
  as the existing Escape/outside-click dismiss) is the simplest correct
  behaviour and needs no live-repositioning-on-scroll machinery — the popup
  simply isn't open while its anchor's position is in flux relative to the
  viewport.
- **Not draggable.** Confirmed explicitly: "flytande, men förankrad" (float,
  but anchored) — it always reopens at its trigger's position, never
  remembers a dragged-to location. No drag handle, no per-popup position
  state to persist.
- **Any number can be open at once**, across tracks and effects — unchanged
  from the current popover behaviour.
- **Content is unchanged**: title bar (icon + label + bypass toggle + ✕
  remove — the same fields `buildFxPopover()`'s head already builds) above
  the field knobs. Only the frame changes from an inline block to a
  floating window with its own border/shadow (matching the Pro Tools
  plugin-window reference: a title bar with a power icon, then the
  control(s)).

This directly fixes the "+ Add effect" clipping bug: once the menu is a
`document.body`-level `position: fixed` element instead of a descendant of
the clipped `.daw`, there is no ancestor overflow box left to clip it
against, and no sibling `.track-header`/`#master-track` stacking-context
collision either (a top-level portal naturally paints above normal document
content without needing the z-index games attempted and abandoned earlier).

## 3. Waveform picker becomes a dropdown

The six-button waveform picker (`WAVEFORMS`, one icon button per shape) is
replaced with a plain `<select>` — the same native-select pattern
`renderAutomationRow()` already uses for choosing an automation parameter,
so no new UI pattern is introduced. This is an explicit, acknowledged
reversal of the picker's original design (a `<select>` was replaced with
buttons specifically because a dropdown shows only one shape at a time,
making comparison harder) — the user weighed that tradeoff against the
width/Pro-Tools-feel goal and chose the dropdown. The option text is the
waveform's existing label (`WAVE_LABEL`); no icon in the `<option>` list
(native `<option>` elements can't carry an SVG glyph, which was the other
reason buttons existed) — a plain text list, matching how Pro Tools' own
routing/output dropdowns in the reference image are plain text. Rhythm
tracks keep today's static "Kit" label (no dropdown, nothing to choose).

## 4. Insert chip lettering

Each visible chip in the Inserts section gets a sequential letter prefix —
A, B, C… — in the same fixed registry order the chip row already renders in
(`eq, comp, crush, tremolo, sendDelay, sendChorus, sendReverb, vibrato`,
filtered to whichever are currently visible). This is **cosmetic only**:

- Not a fixed slot count. There is still no ceiling on how many effects a
  track can have, and no empty/placeholder slots are ever shown — this
  explicitly keeps the "+ Add effect" flexible-list decision from the
  original FX insert-slots design (`docs/superpowers/specs/2026-07-28-fx-insert-slots-design.md`),
  rather than reintroducing the "fixed lettered slots (A–E)" option that
  design explicitly ruled out.
- The letters are recomputed from scratch on every render, purely from the
  current position in `visibleFxFor(track)`'s result — nothing is stored.
  Removing chip "B" reflows the remaining chips' letters (what was "C"
  becomes "B") rather than leaving a gap, exactly as if the letters were
  never persisted state at all (because they aren't).

## Out of scope

- No change to the knob widget itself (drag/keyboard/ARIA/double-click
  behaviour), the bypass mechanism, or `TRACK_FX_REGISTRY`'s fixed
  audio-chain ordering — all of that is already correct from the previous
  feature and this redesign only changes how it's framed/positioned.
- No change to `state.activeFx`'s data shape, `FX_FIELD_DEFAULTS`, or any
  `applySavedMix`/save-file behaviour — this is a rendering/layout change,
  not a data model change.
- No draggable popup windows, no per-popup remembered position, no
  multi-monitor/off-screen clamping beyond whatever the browser does by
  default for a `position: fixed` element near a viewport edge (not raised
  as a concern in review; can be revisited if it turns out to matter in
  practice).
- The identity row (collapse/reorder/name/Mute/Solo/Record-arm/Remove) is
  unchanged — only the sections below it are restructured.
