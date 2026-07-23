# Chord entry in the piano roll

## Problem

Tonal tracks and the audio engine already support polyphony — a single track
can hold several notes that overlap in time at different pitches (e.g. the
bundled `songs/cinematic.json`'s Strings track, three notes per chord, plus
`VOICE_POOL_SIZE` in the synthesis code explicitly sized "generous for
chords/arps"). But there is no way to *create* such a chord from the editor:
every place that adds/moves/resizes a note treats "any other note whose time
range overlaps, regardless of pitch" as something to delete. Chords in the
example songs only exist because they were hand-authored directly in JSON.

Two changes fix this:

1. Make every note-editing interaction pitch-aware, so building a chord one
   note at a time no longer deletes the notes already placed.
2. Add a quick way to build a common chord (major/minor triad) from a single
   selected note, without clicking each interval by hand.

## 1. Pitch-aware overlap handling

Today, "does this note conflict with that one" is computed purely from time
overlap, in four places:

- `clearOverlaps(notes, start, len, exceptIdx)` (index.html:1819) — used by
  `onCellClick` (Pen: add a note, index.html:3227) and `pasteClipboard`
  (index.html:3435).
- `nudgeSelection`'s single-note and multi-select branches (index.html:3364),
  an inline reimplementation of the same time-only filter.
- `startMoveNote`'s pointerup handler (index.html:3521), another inline
  time-only filter, run when a drag ends.
- `startResize`'s `maxLen` computation via `nextNoteStart` (index.html:3452),
  which stops a note's resize at the next note's start regardless of pitch.

The fix: a note only ever conflicts with another note **at the same pitch**
that overlaps it in time. Different pitches overlapping in time are exactly
what a chord is, and must never be auto-deleted.

Concretely:

- `clearOverlaps` gains a `freq` parameter and only removes a note that
  overlaps in time **and** matches that exact frequency (a true duplicate at
  the same pitch, same time). `onCellClick` and `pasteClipboard` pass the
  new/pasted note's own `freq`.
  - Net effect for the Pen tool: since an existing note's own DOM element
    already captures clicks on its own cells (`stopPropagation`), a plain
    click can never actually land on a cell that has a same-pitch note under
    it — so in practice the Pen tool now always adds, never replaces,
    matching the chosen behavior. The exact-duplicate check stays as a
    defensive invariant for the other call sites (paste, nudge) where a
    same-pitch collision is a real possibility.
- `nudgeSelection`'s overlap filters and `startMoveNote`'s pointerup filter
  add a `o.freq === n.freq` condition alongside the existing time-overlap
  check.
- `startResize` filters `others` down to same-`freq` notes before computing
  `nextNoteStart`, so a note can grow past a different-pitch chord tone that
  shares its start column.

No change to rhythm tracks — hits are keyed by `type` (which row), so two
hits at the same column already coexist across rows today; only tonal-track
note handling changes.

## 2. Quick chord buttons in the note inspector

A new **"Chord"** panel section in `renderInspector()` (index.html:3564),
placed after the existing "Pitch" section (after the arp-preset buttons,
before "Texture / FX"). Two buttons: **"Add Major Chord"** and **"Add Minor
Chord"**.

Behavior on click, with `note` = the currently selected (root) note and
`track` = its track:

1. Compute two new frequencies from `note.freq`: root+4 and root+7 semitones
   (major), or root+3 and root+7 (minor), each converted via
   `freqToMidi`/`midiToFreq` and clamped to `[MIDI_MIN, MIDI_MAX]`.
2. For each interval, build a plain note: same `start`/`len`/`vel` as the
   root, all effect flags neutral (`bend: null, vib: false, trem: false,
   duty: null, arp: null, porta: false, crush: false, echo: false, chorus:
   false, reverb: false`) — a fresh note, not a copy of the root's own
   effects. The player can tune each chord tone individually afterward like
   any other note.
3. Run the new (freq-aware) `clearOverlaps` against the track before adding
   each new note, so clicking a chord button twice in a row doesn't stack
   exact duplicates.
4. Play a short preview (`previewNote`) for each newly added tone, so the
   chord is audible immediately.
5. Select the whole chord as a group: `state.multiSelected = new Set([note,
   ...newNotes])`, `state.selected = null` — the same convention
   `pasteClipboard` already uses. This closes the single-note inspector (as
   multi-select always does) but means the chord can be dragged as one group
   with the Grab tool right away.
6. `render()` (auto-commits history via its existing `checkpointHistory()`
   call — no separate undo handling needed).

This only appears for tonal notes; the rhythm-hit path never reaches
`renderInspector`'s per-note fields today and is unaffected.

## Docs touch-up

Update the in-app help text for the Pen tool (index.html:704) to mention
that clicking a different pitch at the same time in a tonal track adds a
chord tone instead of replacing what's there.

## Out of scope

- Chord types beyond major/minor triads (7ths, sus, dim, aug, etc.) — can be
  added later as more buttons in the same panel if wanted.
- A dedicated "chord pen mode" or modifier-key gesture — the always-add Pen
  behavior covers freehand chord entry.
- Changing multi-select track/marquee behavior beyond the overlap-filter fix
  above.
