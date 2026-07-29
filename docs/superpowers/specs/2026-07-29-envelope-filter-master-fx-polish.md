# Envelope & Filter clarity + Master FX visual parity

## Problem

Two loose ends left over from the track-header redesign (PR #111):

1. The per-track Envelope & Filter row (`renderAdsrRow()`) labels its seven
   controls with bare single letters/abbreviations — A, D, S, R, Hz, Q, Env —
   backed only by a `title` tooltip. A user has to already know what ADSR
   stands for, or hover every slider, to know what they're touching.
2. The master track's EQ/Comp/Par Comp/Sidechain/Downsample controls
   (`#master-fx-panel`) are still the flat, always-expanded row of bare
   sliders that predates the FX insert-slots redesign — visually out of step
   with every other track's icon-labelled chip + floating-popover FX panel.

Both are pure presentation work: no DSP, no state-shape change, no new
per-note/per-track capability.

## Part A — Envelope & Filter row

**Labels.** Replace the seven abbreviations with their full words: Attack,
Decay, Sustain, Release / Cutoff, Resonance, Env Amount. `title` tooltips
stay as-is (still useful for the exact parameter description), the visible
label just stops requiring one.

**Grouping.** Split the row into two labelled groups, same visual language
`.master-fx-panel`'s `.mfx-group`/`.mfx-cap` already uses (`Envelope`, then a
divider, then `Filter`) rather than one flat run of seven fields with a
single generic `adsr-divider`. Duty/FM/Ring's extra fields (only shown for
their matching waveform) become a third group, `FM`/`Ring`/`Duty` — same
conditional visibility as today, just captioned instead of bare.

**Per-control icons.** Add seven new entries to `GLYPHS` (same 24×12
wide-box convention as the existing waveform/effect icons — one stroke,
`currentColor`, no fill, `aria-hidden`), placed in `adsr-field` next to each
label the same way `buildFxPopover`'s field/group icons already sit next to
their caption:

```js
attack:    ['M2 10 L20 2'],                                    // steep rise
decay:     ['M2 2 L20 8'],                                     // falls partway, not to zero
sustain:   ['M2 6 H22'],                                       // held flat
release:   ['M2 6 L20 11'],                                    // falls to (near) zero
cutoff:    ['M1 3 H12 C17 3 18 3 22 10'],                       // flat, then rolls off
resonance: ['M1 8 H8 C11 8 11 1 14 1 C17 1 17 8 22 8'],         // rolloff with a resonant peak at the knee
envAmount: ['M1 8 H10 C15 8 15 8 19 3', 'M16 1 L19 3 L17 6'],   // rolloff curve + arrowhead: the knee sweeps
```

The four envelope-stage icons are deliberately drawn as one consistent
family (rises/falls of different steepness and endpoint) so they read
together at a glance; `cutoff`/`resonance` build on the existing `eq` glyph's
curve language (`M1 9.5 C5 9.5 6 1.5 12 1.5 …`) rather than inventing a new
visual idiom for "frequency response." Exact coordinates may get small
adjustments during implementation the way `noise`'s glyph did (see its
comment) — verify legibility with a real screenshot at the size it renders,
not just by reading the path.

**Layout.** Still one row, same height, opened/closed by the existing Env
toolbar toggle — no new disclosure state, no second row. Groups sit
side-by-side exactly where the ungrouped fields do today; only the
captions/icons/dividers/full labels change.

## Part B — Master FX visual parity

Master's five control groups (EQ, Comp, Par Comp, Sidechain, Downsample)
become icon+label **chips that open a floating popover on click** — the same
outer shell as a track's FX insert chip (`.th-fx-chip`/`.th-fx-popover`,
same knob widget, same `document.body`-portal floating-layer mechanism from
the header redesign) — with two deliberate differences from track chips,
because master's effect set isn't the same kind of thing as a track's:

- **Fixed, not addable/removable.** A track's chip list is "whichever
  effects the user chose to insert"; master always has exactly these five.
  No "+ Add effect" menu, no ✕ remove button, no letter prefix (A/B/C… was
  about insert *order* among an open-ended list, which doesn't apply to five
  named, order-fixed groups).
- **Dim-when-neutral instead of a bypass toggle**, for four of the five.
  EQ/Comp/Par Comp/Downsample are already "neutral by default" (0dB, ratio
  1:1, 0% blend, 0% amount does nothing) — the same contract every per-track
  insert already has — so there is nothing a bypass button would add beyond
  what turning the knobs back down already does. Instead, a chip gets the
  existing `.th-fx-chip.bypassed` dimmed style purely as a display cue when
  its values are all at default, computed fresh each render the same way
  `isEffectDefault()` already does for track chips — every field equal to
  its `MASTER_FX_FIELD_DEFAULTS` entry (`isMasterFxActive(effect)`), not
  stored. **Sidechain is the one real
  exception**: its ducking is a discrete on/off, not a knob resting at zero,
  so it keeps a real toggle — the existing `state.sidechain.enabled` — shown
  as an On/Off button in its popover's header (where a bypass button would
  sit on a track chip), and its chip also dims when `enabled` is false.

**Implementation shape.** A new `MASTER_FX_REGISTRY` (separate array from
`TRACK_FX_REGISTRY` — despite reusing a couple of the same *icons*, e.g.
`comp` for both Comp and Par Comp the same way the three per-track sends
already share one `send` icon, it is a distinct table with its own
`MASTER_FX_FIELD_DEFAULTS`, never mixed with the per-track one) drives:

- `buildMasterFxChip(effect)` / `buildMasterFxPopover(effect)` — new,
  parallel to `buildFxChip`/`buildFxPopover` but without the
  track-id-keyed bypass/remove machinery those use.
- `buildKnob()` loses its `track`/`effect` parameters in favour of an
  explicit `ariaLabel` string and `defaultValue` passed in by the caller
  (both existing per-track call sites and the new master ones build their
  own label/default before calling it) — the drag/keyboard/paint logic
  itself is unchanged and unduplicated.
- A new `masterFxPopoverOpen` Set (parallel to `fxPopoverOpen`, keyed just
  by effect key since there's one master) feeds into the existing
  `renderFloatingLayer()` pass, and `anyFloatingMenuOpen()`/
  `closeAllFloatingMenus()` grow to include it — so Escape/outside-click/
  `.daw`-scroll-close all cover master popovers for free.
- Each registry entry's `get`/`set` reuse the existing
  `getMasterEQ`/`getMasterComp`/`getMasterParallel`/`getSidechain`/
  `getMasterCrush` accessors; `set` gets small new
  `setMasterEQ`/`setMasterComp`/`setMasterParallel`/`setSidechain`/
  `setMasterCrush` wrappers that merge into the relevant `state.masterX`
  field (mirroring `setTrackEq` etc.), and `apply` calls the existing
  `applyMasterFX(...)`/`applyMasterCrush(...)` (Sidechain's `apply` is a
  no-op — the ducking scheduler already reads `getSidechain()` live on every
  hit, nothing to push).
- The static `#master-fx-panel` markup (the six `.mfx-group` blocks) is
  replaced by an empty container that a new `renderMasterFxChips()` (called
  from `render()`, same as every other dynamic section) fills with the five
  chips each frame. The Meter group (spectrum canvas + LUFS) is **not** a
  chip — it's a live readout, not a setting — so it stays a plain element
  appended after the chip row, visible whenever the panel is open, exactly
  as today.
- The existing `master-fx-toggle` button keeps its current job — show/hide
  the whole area — unchanged.

## Out of scope

- No DSP/audio-graph changes anywhere in this document — every value, range,
  and default stays exactly as it is today.
- No change to `state.activeFx`, `TRACK_FX_REGISTRY`, or any per-track FX
  behaviour — Part B adds a second, separate registry rather than folding
  master into the per-track one.
- No new song-file fields; `state.masterEQ`/`masterComp`/`masterParallel`/
  `sidechain`/`masterCrush` keep their current shape and
  `applySavedMix`/`currentSongData` load/save logic is untouched.
- No draggable/repositionable popups, no multi-monitor concerns — same
  "flytande, men förankrad" floating behaviour already shipped for tracks.
