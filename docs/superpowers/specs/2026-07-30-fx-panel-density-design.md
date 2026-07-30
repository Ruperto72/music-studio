# FX panel density: shrink the chip row, give the track a real strip

## Problem

Measured on `main` (61767df) at 1600×1000 with Rust Foundry loaded:

| | |
|---|---|
| Track header | 260 × **371 px** — roughly 160 px of it seven insert chips, one per row |
| Track row height | 373 px, driven by the header rather than by the piano roll |
| FX popover | **140 × 109 px** |
| Visible at once | **two tracks** fill the whole 749 px `.daw` viewport; the song has seven |
| `.inspector-column` | 244 px wide, showing "Nothing selected" most of the time |

The popover is not the problem — it is small, and it works. The problem is
that the chip list is a permanent seven-row fixture in **every** track
header, so a seven-track song means scrolling past ~2600 px of headers to
read the arrangement. The screenshot also shows the popover overlaying the
chips *below* the one it belongs to: the panel competes with its own list
for the same 260 px column.

Vertical space in the header column is the scarce resource. Horizontal space
is not — the grid is 1000+ px wide and mostly empty at normal zoom, and the
inspector column sits idle.

A second, smaller problem sits underneath: `state.activeFx` is a *display*
list that reads like an on/off switch, which leaves three places where the
panel's picture of the world and the audio's picture disagree (see Part C).

## Part A — the chip row stops being a column

Insert chips (`.th-fx-panel`, `buildFxChip()`) currently stack one per line.
They become a **wrapping row**: seven pills at ~70 px reflow onto two lines
at 260 px instead of seven. Nothing about the chip itself changes — same
letter prefix, same icon, same bypass/remove buttons, same popover trigger.

Expected: header 371 px → ~210 px, i.e. close to twice as many tracks on
screen for a one-property CSS change.

A tighter variant worth prototyping in the same pass: **letter + icon only**
in the row (`A B C D E F G`), with the effect's name living in the popover
header and the `title`/`aria-label` where it already is. That fits one line
(~40 px) and turns the row into what it is good at — a status strip — but it
costs the at-a-glance readability of the names, so it should be judged from
a screenshot at real size rather than decided here.

The letters stay either way: A/B/C… is insert *order*, which is real
information the wrap preserves.

## Part B — the track's own strip, in the inspector column

`.inspector-column` (244 px, sticky, its own scroll) shows "Nothing
selected" whenever no note or hit is selected — which is most of the time
while mixing. It becomes the **active track's channel strip** in that state:
every effect the track has, all knobs visible at once, no floating layer.

This is "the properties panel follows the selection", not a tab system:

- A note or hit is selected → the note inspector, exactly as today.
- Nothing selected → the active track's strip.

The two are naturally exclusive — you are either editing a note or editing
the track — so nothing needs a tab bar, and the earlier decision against
inspector tabs stands.

Why the inspector column rather than a popup or an expanded header:

- **A popup** covering the grid hides the thing being edited, and inherits
  every light-dismiss edge case the floating layer already had to fix.
- **Expanding the header** in place makes the header column *taller*, which
  is the exact resource that is already exhausted.
- The inspector column is 244 px — the right width for stacked effect
  groups — already scrolls independently, and is in the same place every
  time, so there is no positioning logic and no dismiss behaviour at all.

Seeing EQ and Compressor at the same time is the thing neither the popover
nor a taller header gives you, and it is how mixing decisions actually get
made.

Clicking a chip in the header scrolls the strip to that effect and highlights
it, so the chip row keeps its role as navigation.

### Decision required: does the popover survive?

Two editing surfaces for one value is exactly the class of problem Part C
exists to remove, so this should be settled deliberately rather than by
accident.

- **Recommended: retire `buildFxPopover()`** for track inserts. The chip
  becomes navigation + status; the knob lives in one place. `buildKnob()`,
  `renderFloatingLayer()`, the add-menu and the oscillator picker all stay —
  only the per-insert popover goes.
- **Alternative: keep both**, popover for a quick single tweak, strip for
  working on the whole track. Cheaper (nothing is deleted) but means two
  paths to the same number, and two things to keep in sync.

This is a taste call about how the app should feel, and it discards work
that shipped yesterday, so it is the author's rather than mine.
Master FX chips are **out of scope either way** — master has one strip
already and its five groups are fixed.

## Part C — make the panel report what is actually happening

Three symptoms, one cause: `activeFx` is a presence list maintained
separately from the thing it claims to describe.

1. **`visibleFxFor()` also consults `state.automation`.** A chip shows when
   the effect is non-default **or** when a curve exists for one of its
   params. Today you can draw a Delay curve on a track with no Delay chip
   — verified: a fresh track reports `chips: []` while the Auto dropdown
   still offers `gain, pan, delay, chorus, reverb` — and hear it move while
   the panel shows nothing. Only the three sends have automatable params
   (`AUTOMATION_PARAMS`), so this is a lookup for `sendDelay`/`sendChorus`/
   `sendReverb` only.
2. **`removeFxChip()` also clears that effect's automation.** It currently
   resets the value and drops the `activeFx` entry but leaves
   `state.automation[track].delay` untouched, and since removal is not
   bypass, the curve keeps playing after the chip is gone. Removing an
   effect should remove all of it.
3. **"+ Add effect" becomes "+", meaning "show a control I have not touched
   yet."** Adding never inserted anything — `createTrackFxSends()` builds
   all three send nodes for every track unconditionally, and `get()`/
   `apply()` never consult `activeFx`; only `isFxBypassed()` does. The menu
   lists the effects that are currently at their defaults. With (1) and (2)
   in place, `activeFx` shrinks to what it really is: **bypass flags**, plus
   "user asked to see this one while it is still neutral."

Also in this pass, one stale string: the automation toggle's label still
reads "Automation (volume/pan over time)" though it has offered five
parameters since Delay/Chorus/Reverb became automatable.

### Old songs

`applySavedMix()`'s `activeFx` validation stays exactly as it is — it
already drops unknown effect keys and tonal-only effects on rhythm tracks,
and coerces `bypassed` to a boolean. Nothing about the stored shape changes,
so songs saved yesterday load unchanged.

The fallback clause in `visibleFxFor()` that made pre-`activeFx` songs show
their real chips is **kept and extended**, not replaced: a song with no
`activeFx` at all still shows a chip for every non-default effect, and now
also for every automated send.

## Mobile

Below ~760 px, `.editor-layout` stacks and `.inspector` becomes a fixed
bottom sheet, hidden entirely while empty (`.inspector.empty { display:
none }`). Giving the column a second job has to not resurrect that sheet
permanently:

- The **track strip does not open the bottom sheet by itself.** On narrow
  layouts the strip is reachable by tapping a chip (which opens the sheet
  the way selecting a note does) and dismissed by the existing close
  affordance.
- `.inspector.empty` keeps meaning "nothing to show" — the strip is
  content, so a track strip is not `empty`, but the sheet only appears on
  an explicit tap rather than because a track happens to be active.

Part A's benefit applies unchanged on mobile, and matters more there.

## Out of scope

- **No DSP or audio-graph changes.** Every value, range, default and node
  stays as it is; this is presentation plus the three `activeFx` semantics
  fixes in Part C.
- **No new automatable parameters.** EQ/Comp/Crush/Tremolo are not becoming
  curves in this pass, and per-track **Vibrato cannot be** — it is threaded
  into each note at schedule time rather than being an insert, and its
  `apply` is deliberately a no-op, so there is no downstream node to ramp.
- **No song-file changes.** `activeFx` keeps its shape;
  `currentSongData()`/`applySavedMix()` are untouched apart from nothing.
- **No master FX changes** (see Part B).
- **Not the failing verify step.** `FX: a real trusted click through the
  grid…` fails on `main` today because it clicks at `lane.left + 200,
  lane.top + 60`, which lands on `.inspector` in an 800×600 headless window
  — the same click places no note with no popover open at all, so
  light-dismiss is not eating it. That is a test-geometry fix and belongs in
  its own change, but it should land **before** this one: Part B moves what
  lives at that coordinate.
