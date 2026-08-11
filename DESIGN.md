# Web Audio Studio — Design Specification

This document specifies the design of **Web Audio Studio**, a browser-based 8-bit
chiptune editor, in two parts: the **GUI** (what the user sees and touches)
and the **backend** (the client-side data model, rendering pipeline, and
audio engine that drive it — there is no server-side backend; "backend" here
means the application's internal architecture).

It describes the system as built, not a proposal — it's a reference for
understanding or extending `index.html`. See `CLAUDE.md` for the shorter
orientation aimed at an editing session, `TODO.md` for what's deliberately
not built yet, and `DONE.md` for the working journal behind what is — the
measurements, the ruled-out hypotheses, and why a solution looks the way it
does rather than like the obvious alternative.

Where this document quotes the **Web Audio API**, it means
[Web Audio 1.1](https://www.w3.org/TR/webaudio-1.1/). Several things in B.6
look like arbitrary fudge factors and are not — a 5 ms pad before a voice is
reused, `0.0001` instead of `0` in an envelope, an LFO left connected to a
node that outlives it — so the normative sentence behind each is quoted at
the point it matters, rather than left as something a later reader has to
rediscover by breaking it. The spec's own source is
[`index.bs` in WebAudio/web-audio-api](https://github.com/WebAudio/web-audio-api/blob/main/index.bs),
which is greppable when the published version is inconvenient to search.

---

## Part A — GUI Specification

### A.1 Visual design system

- **Palette** (CSS custom properties, `:root`): `--bg #131316` (page
  background), `--panel #1c1c20` / `--panel2 #24242a` (panel surfaces),
  `--strip #202027` / `--strip2 #191920` (channel-strip gradient stops),
  `--grid #2a2a30` (cell borders), `--bar #45454f` (bar-line borders),
  `--ink #e8e8ee` (primary text), `--muted #9a9aa6` (secondary text/labels),
  `--subgrid rgba(120,200,255,0.16)` (sub-beat guide lines), `--rhythm
  #39ff6a` (the drum kit's base color, still referenced by `.hit`'s default
  background).
- **Track colors** are *not* CSS — every track (including the four
  originally-hardcoded ones) gets its color from `state.trackList[i].color`,
  drawn from `TRACK_PALETTE` (10 hex colors) and applied as inline styles by
  JS (`trackColor(id)`) wherever a track's color shows up: note fill, header
  left-border, name text, volume/pan slider accent, automation curve stroke,
  ADSR panel accent. This is what lets user-added tracks (arbitrary ids) get
  a consistent color with no per-id CSS.
- **Typography**: system UI font stack (no webfont — dependency-free), 11–13px
  for controls, monospace (`Menlo`/`Consolas`) for the LCD counter and note
  frequency readout.
- **Iconography**: one hand-drawn set of inline SVG paths (`GLYPHS`, see
  A.14), stroked with `currentColor` at a uniform weight, covering the
  waveform picker, the per-note effect toggles, the FX panel headings and
  the whole toolbar/menu/dialog set. No icon font and no sprite sheet —
  the paths live in the one file, so this stays dependency-free. The only
  characters kept as characters are the plain geometric ones that already
  matched the drawing: the transport (`⏮ ■ ▶ ↺`), undo/redo, the `▾`/`▸`
  disclosures, the `✕` closes and the `+`/`−` steppers. **This replaced an
  all-emoji UI** — full-colour system pictures pasted into a monochrome
  stroked interface — and `verify.js` audits every control against an
  explicit keep-list so the split stays a decision rather than a drift.
- **App mark**: the icon is not part of `GLYPHS` — it is a filled restatement
  of the `pwm` glyph at icon scale, drawn once in `icons.js`. Three pulses of
  growing width (8, 17 and 22 units in a 100-unit square) on a floor, filled
  with a horizontal gradient from `#2ff3ff` to `#ff2fb0` — `TRACK_PALETTE[0]`
  and `[1]`. What grows across the mark is the share of each cycle that is
  high, which is duty; a plain square wave was rejected in design as being on
  every third synth app, whereas duty modulation is specific to what this
  editor does.
- **Density**: the whole UI targets information density over whitespace —
  compact toolbar panels, an 11px-per-semitone piano roll, and 17px rhythm
  rows, so a full song's structure is visible without excessive scrolling.

### A.2 Application shell & layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Toolbar (sticky top): Menu | Transport | Bars|Beats | Tools |    │
│                       Loop & Zoom                                 │
├───────────────────────────────────────────────┬─────────────────┤
│ BARS  │ ruler (bar numbers, loop region)       │                 │
│ ──────┼────────────────────────────────────────┤                 │
│ Track │ piano roll / rhythm grid               │   Inspector     │
│ header│ (horizontally + vertically scrollable, │  (the selected  │
│ (name,│  playhead line, markers)                │   note or hit — │
│ M/S/R,│                                         │   or, with      │
│ ✕;    │  ...one row per track, plus optional    │   nothing       │
│ Osc / │  Automation / Envelope rows when open   │   selected, the │
│Inserts│                                         │   active track's│
│/Output│                                         │   FX strip)     │
│ )     │                                         │                 │
├───────┴────────────────────────────────────────┤                 │
│ Master bar (sticky bottom): Master · Output ·   │                 │
│ Tempo · Meter · Length · Grid · ＋ Add track     │                 │
└─────────────────────────────────────────────────┴─────────────────┘
```

- `.editor-layout` is a flex row: `.rolls-column` (the DAW surface + master
  bar) on the left, `.inspector-column` (just the Inspector — the project
  name lives in the Master strip instead, see A.10) on the right, both
  **`position: sticky`** so they stay in view while the page scrolls
  vertically past a tall track list.
- `.daw` (the scrollable grid surface) has a **bounded `max-height`**
  computed from the viewport minus the sticky toolbar/master-bar heights, so
  it scrolls *internally* — the toolbar and master bar never move.
- A **custom horizontal scrollbar** (`#hscroll`) sits under the grid, driven
  by `daw.scrollLeft`, since the native one would be hidden under
  `max-height`+`overflow` in some browsers.
- Overlays that need to visually span every track row (playhead line,
  marker lines/flags, loop region tint, loop drag handles) are built **once**
  and repositioned on every render, rather than being children of individual
  track rows — this keeps them present and correctly clipped/z-ordered as
  the sticky headers scroll underneath them.

### A.3 Toolbar panels

Each panel is a `.panel` (dark rounded box with an uppercase `.panel-cap`
label) laid out left to right:

| Panel | Contents |
|---|---|
| **Menu** | Songs library, Save file, Load file, Export code (toggles a code box open/closed), Export MIDI, Import MIDI, Export WAV, Add track, Add rhythm track, Fullscreen, Help |
| **Transport** | Return-to-start (⏮), Stop (■), Play (▶), **Record** (a filled circle — arms nothing itself, it rolls the armed track's capture after a bar of count-in), Loop toggle (↺), **Metronome** toggle (a metronome glyph) — see A.16 |
| **Bars\|Beats** | LCD-style counter (bar\|beat\|sub-beat, plus mm:ss) |
| **Tools** | Pen / Eraser / Grab tool segmented control; Undo/Redo |
| **Loop & Zoom** | Full range, Repeat (duplicate the loop region forward), Add marker, zoom −/100%/+ |

On narrow screens, an "⋯ More" toggle collapses the less-essential panels
(`.tb-extra`) behind a button to keep the primary controls reachable.

### A.4 Track headers & channel strips

Each track's header (`buildHeader()`) is a **sticky-left column** (260px):
an identity row, then three **captioned sections** — Osc, Inserts, Output —
each a small uppercase `.th-section-label` over its controls, separated by a
hairline rule. It reads as a mixer channel strip rather than a list of
controls, which is what the sections are for; before them it was an
unlabelled vertical stack in a 200px column.

1. **Identity row** (always visible, even collapsed): collapse toggle (▾/▸),
   reorder ▲/▼ (within-kind — a tonal track's neighbours are only ever
   tonal), track name (double-click to rename, ellipsis-truncated),
   **M**ute, **S**olo, **R** (record-arm — see A.16), and (hidden when
   collapsed) **✕** remove.
2. **Osc**: the waveform picker plus the tool toggles — **Auto** (opens the
   automation-curve row, A.6), **Env** (opens the envelope/filter row, A.8;
   tonal only — drum hits use fixed per-type envelopes) and **Preset**
   (saves/loads waveform+envelope+filter+FM as a named preset, shared across
   songs via `localStorage`). A rhythm track has a static **Kit** label
   instead of the picker, and keeps Auto but swaps Env/Preset for a
   **Patterns** button (A.11b).
3. **Inserts**: the FX chip row and its **+** and **Reset** buttons — see
   A.7. The knobs are *not* here.
4. **Output**: volume (0–2) and pan (−1–1, double-click to re-centre) with
   their readouts. The live post-fader **VU meter** sits just below, a
   sibling of the section rather than inside it, so that collapsing the
   track keeps the meter while hiding the faders.

**The waveform picker is a trigger button that opens a floating listbox**
(`buildFloatingOscMenu()`): the trigger shows the current shape's glyph, its
name and a `▾`; the listbox lists all ten — Square, PWM, Triangle, Saw,
Sine, Half sine, NES Tri (wavetable), Noise, Ring, FM — each as its own
glyph plus name, with the current one marked. It replaced a ten-button
`role="radiogroup"` grid that cost two rows of the header's height, and the
design spec's own proposal of a plain `<select>` was tried and dropped: a
native `<option>` cannot carry an SVG, and seeing each waveform *as its
shape* was the whole point of the buttons it would have replaced. A
trigger + listbox keeps the glyphs and costs one row. It is `role="listbox"`
with `role="option"` items and `aria-selected`, and the trigger carries
`aria-haspopup="listbox"`/`aria-expanded` plus a real `aria-label`.

**Collapsed** state (▸) hides all three sections (and the ✕) and shows just
name/M/S/R/VU — a slim overview strip so many tracks fit on screen;
**expanded** (▾) shows everything. Collapse state is per-browser
(`localStorage`, keyed by track id), not part of the saved song.

**Floating menus (shared mechanism).** The waveform listbox and the Inserts
**+** menu (`buildFloatingAddMenu()`) are both built into one
`#floating-layer` by `renderFloatingLayer()`, which runs after
`renderTracks()` and rebuilds the layer from scratch each frame — it locates
each popup's trigger by `data-track`/`data-key` in the just-rebuilt DOM and
anchors the popup 6px under it, `position: fixed`, clamped away from the
viewport edges. Only menus live here now: master's FX popovers used it too
until master moved to the inspector strip (A.10), and nothing in the app
floats a set of knobs any more. They live at `document.body` level for one concrete
reason: `.daw`'s `overflow-x: auto` computes `overflow-y: auto` too, so
anything nested inside it that extends past its box is **clipped**, and no
z-index can undo an ancestor's overflow clip. The `+` menu used to render
invisibly for exactly that reason. Light dismiss is by hand
(`anyFloatingMenuOpen()`/`closeAllFloatingMenus()`): outside click, Escape,
or `.daw` scrolling — but scrolling only on the **vertical** axis, since
`.track-header` is `position: sticky; left: 0` and doesn't move sideways;
closing on either axis fired on `followPlayhead()`'s auto-scroll and
cancelled in-progress knob drags mid-playback.

### A.5 Piano roll (pitch lanes) & rhythm grid

- Each tonal track's lane auto-fits its **pitch window** to the notes it
  contains (min span 15 semitones), so lanes stay compact instead of always
  spanning the full MIDI range (33–96). An **empty** lane returns that
  minimum span directly, starting at middle C, rather than going through the
  ±3-semitone padding — there are no notes to pad around. It used to open at
  28 semitones, which was fine when a new project was one rhythm lane and
  became 300px of blank grid per track once it starts with four tonal ones.
  The wheel pans the window; the first note placed hands it back to auto-fit.
- Notes render as colored blocks (`.note`), width = duration × zoom,
  brightness = velocity; small badges/border styles indicate active effects
  (arpeggio ♪ badge; `.bend`/`.vib`/`.trem`/`.porta`/`.crush`/`.echo`/
  `.chorus`/`.reverb` classes for a subtle visual cue).
- Each rhythm track has one fixed row per hit type (Kick/Snare/Rim/Hi-hat/
  Open hat/Shaker/Tom/Clap/Crash/Ride — `RHYTHM_ROWS`), 17px tall; hits are
  short colored blocks, one color per type. **There can be more than one
  rhythm track** (all sharing this same fixed 10-piece kit); rhythm tracks
  always stay grouped together after every tonal track in `trackList`, and
  at least one always exists — it can't be removed below one, only added to.
- **Tools**: Pen (click an empty cell to add a note/hit at the current grid
  resolution — clicking a *different* pitch in a column that already has a
  note adds a chord tone rather than replacing it, see B.5), Eraser (click
  to remove), Grab (drag to move, drag the right edge to resize, drag empty
  space to marquee-select).
- **Multi-select**: Shift+click adds/removes from selection in any tool;
  marquee-select (Grab tool) rubber-bands a rectangular region; a selection
  moves/deletes/copies-pastes as a group.
- **Grid resolution** (Grid control, master bar): 1/4, 1/8, 1/16, 1/8
  triplet, 1/16 triplet — governs snap for placing, moving, resizing, and
  nudging; finer resolutions draw extra sub-beat guide lines.

### A.6 Automation curve editor

Opened per-track via its header's **Auto** button; renders as an extra
full-width row directly under that track (reusing the `.track-header`/
`.gutter`/`.lane` sticky-positioning trio so it lines up with the grid
above/below it):

- A `<select>` picks the parameter — **Volume** (0–2), **Pan** (−1–1),
  **Delay** (0–100%), **Chorus** (0–100%), or **Reverb** (0–100%) — each
  with its own independent point set. The three send parameters ramp the
  same continuous per-track FX sends the FX panel's sliders control (see
  A.7) — drawing a curve here is an alternative to that panel's static
  slider, not a separate effect; whichever value is in effect at a given
  moment (curve or static slider) is what's actually sent.
- The lane draws bar-line guides, an SVG polyline through the current
  points (flat before the first / after the last point — the standard
  automation-curve convention), and draggable point handles colored to
  match the track.
- **Click** empty lane space to add a point at that column/value; **drag**
  a point to move it (clamped between its neighbors' columns); **double-
  click** a point to delete it; **Clear** removes every point for the
  current parameter (only that parameter's points — switching the dropdown
  and clicking Clear again removes another parameter's points
  independently; there's no "clear all parameters" action).
- With **no points** for a parameter, it behaves exactly as before
  automation existed for it — driven by the channel strip's (or the FX
  strip's) static knob value for the whole song — fully backward
  compatible.
- A send **with** points shows its chip even at level 0
  (`visibleFxFor()`/`fxHasAutomation()`): a curve is audibly doing
  something, so the panel has to say so. Removing that effect takes the
  curve with it (`removeFxChip()`/`clearFxAutomation()`) — removal is not
  bypass, and `scheduleAutomationForChunk()` gates only on
  `isFxBypassed()`, so a curve left behind would keep playing with nothing
  on screen to explain it. `FX_AUTOMATION_PARAM` names the three sends as
  the only automatable inserts, once, next to `AUTOMATION_PARAMS`.

### A.7 Track FX: header chips, inspector-column strip

Split across two places, deliberately.

**In the track header** (`buildFxPanel()`/`buildFxChip()`): a wrapping row
of **chips**, one per effect in use, each a letter (A, B, C… by current
position, recomputed every render) and an icon. Status and navigation only
— there are no knobs here. A chip click points the inspector column's strip
at that effect; it never toggles off, because with a note selected the
strip is not on screen and a "toggle" would read as a dead click.

**In the inspector column** (`renderTrackStrip()`/`buildStripSection()`):
the actual controls. When no note is selected, the column shows the active
track's whole insert chain — every effect, every knob, at once — instead of
"Nothing selected". Each section carries the effect's letter, icon and name,
its **bypass** and **remove** buttons, and its knobs.

Why the split: the chips used to carry the knobs too, via a floating
popover per effect. Measured, a seven-effect track's chip row was 152 px
over six lines and the header 260 × 371 px, so two tracks filled the whole
DAW viewport. Vertical space in a 260 px column is the scarce resource;
the inspector column is 244 px wide, scrolls on its own, sits in the same
place every time (no positioning logic, no light-dismiss) and was showing
"Nothing selected" most of the time while mixing. Letter + icon chips are
44 px, so seven fit two lines (46 px), and the header is 265 px.

Seeing EQ and Compressor at once is the thing neither the popover nor a
taller header gave you, and it is how mixing decisions get made.

There is deliberately **one** editing surface per value: the per-insert
popover was retired rather than kept alongside the strip. The master bus
now follows the same rule and shares the same column (A.10), so the
floating FX popover — and its `.th-fx-popover*` CSS — is gone from the app
entirely.

Available on every track, tonal or rhythm alike. Six groups, listed here in
`TRACK_FX_REGISTRY` order — which is the order the panel renders them in,
not a signal order, since the sends tap the end of the chain and Vibrato is
not in the chain at all. Both come from that one table (see B.6). Each group
opens with a heading — its glyph plus its name — which doubles as the
separator between groups; these replaced the thin dividers that used to
stand there, because abbreviations like Thr/Rat/Atk/Rel only read as a
compressor once you can see which group you are in:

- **Delay / Chorus / Reverb send** (0–100% each): continuous sends to three
  shared global effect buses, independent of the per-note Echo/Chorus/
  Reverb toggle buttons in the note inspector (A.9) — this is an always-on
  per-track level, not a per-note flag. Any of the three can instead be
  driven by a drawn curve from the Automation panel (A.6); the slider here
  is the value used wherever no curve point covers a column.
- **EQ** (Lo/Mid/Hi, ±12dB): a per-track 3-band insert with the same bands as
  the master EQ (A.10) — 200Hz low shelf, 1kHz peak, 4kHz high shelf. First in
  the insert chain, so the compressor after it reacts to the shaped signal
  rather than the raw one, the usual console order.
- **Compressor** (Thr/Rat/Atk/Rel): a per-track insert, same four
  parameters/ranges as the master Compressor (A.10) but applied before that
  track's signal is summed into the mix.
- **Bitcrush** (Amount %): a per-track lo-fi downsampler insert, reusing the
  same `AudioWorkletNode` processor as the master bus's own Downsample
  control — independent of the per-note Bitcrush toggle, which is a fixed
  always-on `WaveShaperNode` effect rather than a dial-able amount.
  `0%` = full quality (default).
- **Tremolo** (Rate Hz / Depth %): a per-track amplitude-modulation LFO.
  `Depth: 0%` (default) leaves the level unmodulated regardless of rate.

- **Vibrato** (Rate, Depth in cents; **tonal tracks only**): pitch wobble on
  every note of the track. The one entry in `TRACK_FX_REGISTRY` that is *not*
  an insert — an LFO on the channel gain can shape an already-summed signal,
  but bending its pitch cannot be done downstream, so this is threaded into
  `scheduleTone()` and reaches each note's own oscillator (see B.6). That is
  also why it is tonal-only: a drum hit has no oscillator to bend, so
  `trackFxFor(track)` filters the whole group out of a rhythm track's panel
  and `applySavedMix()` skips it there. It **adds to** the per-note Vibrato
  toggle rather than replacing it — both connect an LFO into the same
  `osc.frequency`, and `AudioParam` inputs sum — matching the same
  "independent of the per-note flag" contract Crush and Tremolo have.
  `Depth: 0` cents (default) leaves the pitch alone regardless of rate.
Adding and removing: the header's **+** opens a floating menu of the effects
this track isn't showing yet, and the strip lists the same ones at its foot
under **Not in use**. Either way the wording is "show a control", not
"insert a node" — every effect already exists in the audio graph for every
track (`createTrackFxSends()` builds all three sends unconditionally, the
inserts are neutral by default), so `state.activeFx` records only which
effects the panel *shows* and each one's bypass flag. **Bypass** and
**remove** live in the strip section's head and nowhere else; they used to
sit on both the chip and the popover, which was two of everything to keep in
step. The header's **Reset** clears the whole chain at once — every insert
and send back to default, each one's automation curve with it.

### A.8 Envelope, filter & FM editor

Opened per-track (tonal tracks only) via **Env**; same full-width-row
placement convention as automation, but its "lane" is a plain flex row of
sliders rather than a column-indexed curve — it doesn't need to scroll
with the timeline.

The row is divided into **captioned groups** — Envelope, Filter, and (for
the waveforms that have them) Duty / FM / Ring — using the same
`.mfx-group`/`.mfx-cap` language the master strip uses, and each control
carries **its full word and its own glyph**: Attack, Decay, Sustain,
Release, Cutoff, Resonance, Env Amount. It was seven bare letters —
A/D/S/R/Hz/Q/Env — with the meaning only in a `title` tooltip, so you had to
already know what ADSR stood for, or hover every slider, to know what you
were touching. `Thr`-style abbreviations only read as a compressor once you
can see which group you are in; the same is true here.

- **Attack**, **Decay** and **Release** are a **percentage of each note's own
  length** (0–50%, or 2–60% for release) — they scale with short vs. long
  notes rather than needing per-tempo absolute times.
- **Sustain** is the held level (0–100% of the note's peak amplitude).
- **Filter** — a per-track resonant lowpass: Cutoff (60Hz–20kHz, log
  slider), Resonance (Q, 0.1–20), and Env Amount (−1–1), which sweeps the
  cutoff using the same ADSR shape above (0 = filter envelope off, cutoff
  stays at its base value).
- Tracks on the **FM** waveform get an **FM** group — modulator **Ratio** and
  **Depth** (`state.fm`, `DEFAULT_FM`). **Ring** modulation gets the same
  Ratio and no Depth: the multiplication is always full, so a depth there
  would mean nothing.
- Tracks on the **Square** waveform get a **Duty** group — a Width select
  (`state.duty`), the track's pulse width, applying to every note on it. Same
  rule as the FM sliders above: a waveform-specific per-track synth setting,
  shown only for the waveform it applies to. A single note can still override
  it from the inspector (A.9); see B.6 for how the two resolve.
- The row's title reflects what's shown: "Envelope & Filter", or
  "Envelope, Filter & FM" / "& Ring" / "& Duty" for those waveforms.
- **Reset** restores every default (ADSR, filter, FM, duty); **✕** closes the
  panel without changing anything.

### A.9 Note/effects inspector

The right-hand `.inspector` panel shows either an empty-state hint or the
controls for whatever single item is selected. A **rhythm hit** gets a short
panel of its own (`renderHitInspector()`): the drum's name, its bar and beat,
**Velocity** (10–100%) and **Pan** sliders — the same range/step/formatting as
the tonal ones below, and the same delete-when-neutral rule — and Delete. That is the whole list on purpose — a hit has no pitch,
no length and no per-note effect flags, and for drums those effects live on
the track's FX panel instead, since every kit sound on a track passes
through the one channel node those inserts and sends tap.

A **note** gets the fuller set, grouped into:

- **Selected note**: track-color badge, pitch name + frequency, note length,
  Velocity and **Pan** sliders. Pan is −1..1 on top of the track's own pan,
  double-click to re-centre, and re-centring *deletes* the property rather
  than writing 0 — the same rule per-hit velocity follows, so a note that was
  never panned serialises as it always did. Velocity is drawn on the grid as brightness (opacity
  `0.4 + 0.6 × vel`) for notes and hits alike, so an accent is visible without
  opening anything.
- **Modulation**: Vibrato / Tremolo toggle buttons, Portamento toggle
  (glides into the next contiguous note). Each toggle draws its effect as a
  small glyph above its label — see A.14.
- **Pitch**: Bend (semitones, glides partway through the note), Duty cycle
  (pulse-width for square waves — its first option, "Track default (…)",
  inherits the track's own Duty from A.8 and names its current value, while
  the explicit percentages below override it for this note), Arpeggio (comma-separated semitone
  offsets, with the same ten `CHORD_PRESETS` quick-fill buttons the Chord
  panel below uses — both store offsets above the root, so one voicing table
  serves both).
- **Chord**: a grid of quick-add voicings — `5` (power chord), `maj`, `min`,
  `dim`, `aug`, `sus2`, `sus4`, `7`, `maj7`, `m7`. Unlike the Arpeggio presets
  above (which only flag this one note to sweep through its chord tones),
  these add *real, separate* notes above the selected root, at the same
  start/length in the same track, then multi-select the whole chord as a group
  (which closes this single-note inspector). Chord tones are added with
  neutral effect flags, so each can be tuned individually afterward. An
  interval that clamps at the pitch ceiling onto a pitch already sounding is
  skipped rather than stacked as a duplicate. The voicings are a data table
  (`CHORD_PRESETS`) shared with the Arpeggio row above, and `addChordAbove()`
  is generic over the interval list, so adding one is a row in that table
  rather than another hand-wired button in either place.
- **Texture / FX**: Bitcrush, Echo, Chorus, Reverb toggle buttons, glyphed the same way.
- **Delete note** button.

Both preset grids sit behind a **`▸ presets`** disclosure and are collapsed by
default, remembered per-browser (`openPalettes`, `localStorage`) the same way
per-track collapse is. Expanded they were 384px of a 745px panel, which pushed
everything below them off a 1366×768 screen; collapsed the inspector is 548px
and fits without scrolling. The split is deliberate rather than uniform: the
palettes are picked from once while building a part, whereas the toggles around
them report state that has to stay readable at a glance — which is also why
these are disclosures and not tabs, since a tab would hide an active Vibrato
behind another tab.

On narrow screens the inspector becomes a fixed bottom sheet that only
appears while a note is selected (with a "✕ Done" pill to dismiss it).

### A.10 Master bar

Sticky bottom strip, collapsible to a slim label bar (▾, remembered
per-browser): the project **Song** name, **Master** volume + **Output** VU,
**Tempo** (BPM number input), **Meter** (time-signature select), **Length**
(±1 bar, trims/pads notes, hits, and markers past the new end when
shrinking), **Grid** (note snap resolution — see A.5), **Swing**, and a
**Master FX** toggle for the master-bus panel.

**Song** is the project name, click-to-rename via a prompt (`renameSong()`)
while the strip is expanded; when the strip is collapsed the same name still
shows in the slim label bar but as plain, non-editable text — it's the same
underlying `state.songName`, just rendered as two different elements that
CSS shows/hides based on collapsed state, so the name stays visible either
way but is only editable when there's room for the "click to rename"
affordance. (Adding/removing tracks is a menu action, not part of this
strip — see A.3.)

The **Master FX** toggle opens that panel: a row of five **chips**
(`renderMasterFxChips()`/`buildMasterFxChip()`) that work exactly like a
track's insert chips — status and navigation, no knobs. Clicking one hands
the **inspector column** to the master bus, which then shows all five groups
at once (`renderMasterStrip()`/`buildMasterStripSection()`), the same strip a
track gets:

- **EQ**: 3-band (Lo shelf ~200Hz, Mid peak ~1kHz, Hi shelf ~4kHz, ±12dB).
- **Comp**: a `DynamicsCompressorNode` (threshold, ratio, attack, release).
- **Par Comp**: a parallel ("New York") compression blend — mixes in a
  second, much harder-compressed copy of the signal alongside the main one.
- **Sidechain**: ducks the master bus on every kick/snare hit (on/off +
  depth).
- **Downsample**: a lo-fi sample-and-hold `AudioWorkletNode` on the master
  bus (0 = full quality).
- **Meter**: a live frequency-spectrum canvas plus an approximate momentary
  LUFS readout (ITU-R BS.1770 K-weighting, not a certified meter). **Not a
  chip** — it's a readout, not a setting, so it sits beside the chip row and
  is simply visible whenever the panel is open.

**Selecting the bus.** The master bar is mostly *song* settings (Tempo,
Meter, Length, Grid, Swing), so it is not selectable as a whole — only the
two cells that are the master *channel*, **Master** (volume) and **Output**
(VU), plus the Master FX button and its chips. Those carry the same
selected outline `.track.active` draws on a track header.

**One column, one owner**, and the code says so in one value:
`inspectorOwner` is a track id or the literal `'master'`, and
`stripFocusKey` is a bare effect key belonging to whoever that names.
Changing the owner clears the focus in the same function
(`setInspectorOwner()`), so there is no state where the master cells draw as
selected while the inspector still shows Lead's chain — which is exactly what
the pair this replaced could reach, since it spelled the owner out twice (a
`masterStripOpen` flag *and* an `owner::effectKey` prefix) and needed
mirrored calls at both ends plus a regression test to keep them agreeing.

The **volume slider inside the Master cell is exempt**, matching a track:
`buildHeader()`'s slider stops the header's own mousedown, so dragging a
track's fader doesn't activate that track. Without the same exemption here,
nudging the master fader would select the bus and throw away the note the
user had selected. The guard matches any nested `input`/`button`/`select`
rather than `#master-vol` by name, so a control added to these cells later
inherits it.

The cells are a **pointer convenience, not the only path**: they wrap a
slider and a meter, so making them a `role="button"` would nest a focusable
control inside a button. The keyboard path is the Master FX button — a real
`<button>` in the tab order that selects the bus on both edges of its
toggle, so Tab-and-Enter reaches the same state whichever way the panel was
sitting. `selectMaster()` announces itself into `#a11y-status`, since the
column that changed owner is nowhere near the control that was used and, on
the keyboard path, focus doesn't move at all. It is a
separate value rather than `state.activeTrack = 'master'`, because every
nudge, paste, step-entry and pattern path reads `state.activeTrack` as a real
track id and a sentinel there would be an id that indexes nothing. The two
travel together for tracks — every path that moves `activeTrack` calls
`setInspectorOwner()` with it — and diverge only when the bus takes the
column.

Three deliberate differences from a track's chips and sections, because
master's effect set isn't the same kind of thing. They are **fixed**: master
always has exactly these five, so there is no **+** menu, no ✕ remove, no
A/B/C letter (lettering names a position in an open-ended list) and no "Not
in use" row — there is never a group waiting to be revealed. Instead of a
bypass toggle they **dim when neutral** (`isMasterFxActive()`, computed
fresh against `MASTER_FX_FIELD_DEFAULTS`, never stored): EQ, Comp, Par Comp
and Downsample are already neutral-by-default, so a bypass button would add
nothing that turning the knobs back down doesn't already do. **Sidechain is
the one exception** — its ducking is a discrete on/off rather than a knob
resting at zero, so it keeps a real On/Off button in its section head, where
a track's bypass sits.

That dim state is also why master's knobs commit differently. A track
section's dim is a stored bypass flag that a knob move cannot change; the
master's is recomputed from the live value, so a commit has to refresh the
chip row and the section's own class. Both are patched **in place** rather
than through `render()` — a full render would rebuild the very element the
pointer is still dragging, and (as `verify.js` pins) would drop keyboard
focus off the dial, letting the next arrow key fall through to nudging
notes.

The five come from `MASTER_FX_REGISTRY`, a table parallel to
`TRACK_FX_REGISTRY` (B.6) but deliberately separate — despite sharing a
couple of icons, master's groups are fixed and order-bound and have none of
the per-track bypass/remove machinery, so folding them into one table would
mean a table of exceptions. `buildKnob()` *is* shared: it takes an explicit
label and default rather than a track/effect pair, so both callers reuse one
drag/keyboard/paint implementation.

All defaults are neutral (0dB, ratio 1:1, sidechain/downsample off), so an
untouched song's master bus is unaffected — see B.6 for the signal chain.

### A.11 Songs library dialog

Opened from the menu's **Songs** item; three sections:

1. **New song** — name it up front, then either **Starter tracks** (the
   `STARTER_TRACKS` layout, empty) or **Empty project** (just Rhythm).
2. **Examples** — fetched from `songs/index.json` + one `.json` per entry;
   loading replaces the current editor content (a warning tells the user to
   save first).
3. **My songs** (this browser) — save the current song under a name
   (`localStorage`), or load/delete a previously saved one.

This dialog is the *only* way a song's content gets loaded into the editor
— the page itself always boots into the starter layout (see B.8).

### A.11b Rhythm patterns dialog

Opened from the **Patterns** button on a rhythm track's header (rhythm tracks only —
`insertPatternIntoRhythm()` refuses anything else). Lists the built-in
grooves from `RHYTHM_PATTERNS`, each with a name, a one-line description
and three buttons: **▶** auditions the groove bar, **▶ fill** the fill bar,
**Insert** stamps the pattern from the playhead's bar to the end of the
song, replacing whatever was there.

Above the list, one **Fill every** dropdown (`FILL_EVERY_CHOICES`: never /
2 / 4 / 8 bars, default 4) sets the phrase length for the insert, and a
**Spread the kit in stereo** checkbox (default on, remembered per browser)
decides whether the insert applies `KIT_PAN`. Both are single controls
rather than per-row ones because they are properties of *this insert*, not
of a groove — every pattern has a fill, and a hi-hat sits where a hi-hat
sits regardless of which groove is playing it.

Three things carry the musical weight here, all data rather than code:

- **Velocity.** Every hit in every pattern is authored with an intended
  strength — backbeat and kick full, hats accented on the beat and ghosted
  off it, textures (shaker, a jazz kick) well below. A groove where every
  hit lands at full is the one thing that reads as a machine no matter how
  good the placement is. The authored values follow `hitVel()`'s **absent
  means full** rule, and `patternHitAt()` only writes `vel` through when it
  is actually below 1 — so a stamped pattern serialises no larger than the
  same hits placed by hand.
- **Fills.** Each pattern carries a second one-bar authoring, `fill`, used
  on the last bar of each phrase. Fills keep the groove through the first
  half of the bar and then crescendo, and the bar *after* a fill opens with
  a crash — that is what a fill is for, and leaving the crash out makes it
  sound like a mistake rather than a lead-in. The crash goes in through
  `hitsConflict()`, since Breakbeat already crashes on its own downbeat.
- **Stereo position.** `KIT_PAN` gives each of the ten pieces a place in
  the field, applied on insert: kick and snare hold the centre because they
  carry the pulse, hi-hat and ride open to the right, shaker, toms and
  crash to the left. It is one table keyed on the *drum*, not a `pan` on
  every hit of every pattern — a hi-hat is off to one side in every groove
  that has one, so per-hit values would be twelve patterns' worth of the
  same numbers to keep in step. A pattern's own hit can still override it.
  `patternPan()` is the single resolver, so the dialog's ▶ preview and
  **Insert** cannot disagree about where a piece sits; like velocity it
  writes nothing at centre, so a centred kit serialises exactly as before.
  The amounts are deliberately modest — a kit in a room, not a ping-pong
  effect.

Phrases are counted from the bar the insert starts on, not from bar 1 of
the song, so the phrasing lines up with wherever the playhead was left.

A pattern can also bring editor state along, because a few grooves are not
the same groove without it:

- `swing` → `state.swing`. Shuffle only reads as shuffle once the off-8th
  is pushed toward the triplet position.
- `grid` → `state.grid`. A `start` may be fractional (the column unit is an
  eighth, positions re-lattice to 1/6 of one, so `0.5` is a 16th and `1/3`
  a 16th triplet), but a hit's block is drawn one *grid step* wide — on the
  default 1/8 grid two 16ths would render one on top of the other. Funk
  sets `grid: 0.5`; its ghost notes are the groove and they have to be
  visible and editable. Trap is the one pattern using two subdivisions at
  once, and it sets `grid: 1/3` rather than `0.5` for that reason: at 1/3
  every block is a third of a column, so its 16ths and its triplet roll are
  both readable, whereas at 0.5 the triplets (1/3 apart) would overlap.
  32nds are not available — a quarter of an eighth is off the 1/6 lattice
  and `quant()` snaps it onto the triplet — so trap's roll is written as
  triplets, which is a real trap rate rather than an approximation.
- `crashAfterFill: false`. Bossa nova's fill flips the clave to its other
  side rather than building to anything, and a crash on top of that is
  simply the wrong genre.

The library covers twelve grooves: Rock, Techno, Disco, Swing/Shuffle,
Hip-Hop, House, Breakbeat, Funk, Half-time, Bossa Nova, Reggae (one drop)
and Trap. Each is one table row — nothing about phrasing, velocity or grid
handling is per-pattern code.

### A.12 Help dialog

A single scrollable reference covering: overview, tracks & channel strips,
tools, multi-select, note effects, the master bar, saving & exporting, and
a keyboard-shortcut table (Space play/stop; 1/2/3 tool select; Delete;
arrow-key nudge; Ctrl/Cmd+C/V copy-paste; Ctrl/Cmd+Z / Shift+Z or Y
undo/redo; Esc deselect/close).

### A.13 Accessibility

The editor is a grid of positioned `<div>`s, so nothing about it is accessible
by default — these are the deliberate additions:

- **Structure**: a visually-hidden `<h1>`, a skip link to the grid, and
  `<main>`/`<aside>`/`role="toolbar"` landmarks, so the page can be navigated
  by region instead of only linearly.
- **Focus**: a high-contrast `:focus-visible` ring (`#7fd4ff`, 11.3:1 on the
  page background). The browser default all but vanishes on this palette, and
  one `outline: none` on the active tool button had removed it entirely.
- **Names**: every lane carries an `aria-label` (track name + what it is +
  how many items), and every note and hit carries one describing pitch or drum
  plus bar and beat — `noteAriaLabel()`/`hitAriaLabel()`. Repeated icon buttons
  that only made sense positionally (**M**/**S**/**R**/**✕** per track) name
  their track.
- **State**: Mute/Solo, record-arm and the per-note effect toggles expose
  `aria-pressed`; the Pen/Eraser/Grab cluster is a `role="radiogroup"` with
  `aria-checked`, since it is a single choice rather than a row of
  independent toggles. All of these previously carried their state only in a
  CSS class. The waveform picker was that same radiogroup until it became a
  floating listbox (A.4); it now names itself the way a listbox does —
  `aria-haspopup="listbox"`/`aria-expanded` on the trigger, `role="option"`
  plus `aria-selected` on each choice.
- **Keyboard grid access**: **Shift+←/→** steps the selection through the
  active track and **Home**/**End** jump to its ends, with the selected item
  announced through a polite live region (`announce()`). Plain arrows still
  nudge, so nothing already in muscle memory changed. Notes use a **roving
  tabindex** — only the selected one is a tab stop — so Tab reaches the grid
  without walking through hundreds of blocks.
- **Keyboard note entry and a grid cursor**: arming a track (**R**) turns the
  letter keys into step entry (A.16) — notes at the playhead, `←`/`→` through
  time, `↑`/`↓` between tracks, `Home`/`End` to the ends, `Backspace` to
  clear the last step. Every move is spoken through the same live region with
  the position **and** the contents, so the grid can be surveyed as well as
  written to. This is the piece that makes *composing* possible without a
  pointer rather than only editing what a pointer already placed.
- **Contrast**: the 8px uppercase panel captions were 3.23:1; they are now
  5.32:1. Body and muted text already passed AA.
- **Two modes in one column**: the inspector `<aside>` shows the selected
  note's panel, or — with nothing selected — the active track's FX strip
  (A.7). Properties-follow-selection rather than a tab bar, since the two
  are mutually exclusive. On a narrow layout the column is a fixed bottom
  sheet hidden while `.empty`, so the strip deliberately does **not** open
  it merely because a track is active; there it appears only on an explicit
  chip tap.
- **Icons**: every glyph (A.14) is `aria-hidden`, and the control around it
  keeps its own text label or `aria-label`. The waveform picker spells its
  shape's name out beside the glyph — on the trigger and on every option —
  so no information is available *only* as a picture.

Solved since: notes can now be **created** from the keyboard as well as
reached and edited, and the grid has a cursor that can be moved around it
rather than only stepped between the items that already exist. Arm a track
with its **R** button and the letter keys place notes a step at a time,
`←`/`→` move through time, `↑`/`↓` between tracks, `Home`/`End` to the
start of the song or the end of this track's part — and every move is
spoken with the position *and* what is already there (A.16 — step entry,
deliberately separate from the real-time take, which needs both hands and
a sense of timing and so is not on its own an answer here).

### A.14 Icon glyphs

One table, `GLYPHS`, holds every inline-SVG shape in the app, and `glyph(name)`
builds the `<svg>`. An entry is either a bare list of path `d` strings — the
wide **24×12** box with y=6 as the zero line, used by the waveform and effect
shapes — or `{ box, paths }` for the square **24×24** interface icons. Which
box a glyph uses is therefore a property of the glyph, not something every
caller has to know. (A list rather than one string because chorus is two
detuned waves and reverb an impulse plus its tail.)

They cover the waveform picker (A.4), the per-note effect toggles (A.9), the
FX chips and strip sections (A.7), the master chips (A.10), the individual
envelope and filter controls (A.8 — Attack/Decay/Sustain/Release drawn as
one family of rises and falls, Cutoff/Resonance/Env Amount as response
curves built on the EQ glyph's own idiom), and the whole toolbar, menu and
dialog set.
Static markup carries `data-glyph="name"` and one boot pass fills them in;
buttons built in JS use `setGlyphLabel(btn, name, label)`. Either way the label
stays a real text node, so the accessible name is what it always was.

The record dot is the one **filled** glyph, opted into by the `GLYPHS` entry
itself (`fill: true`) rather than by a caller. Everywhere else a stroke is
right; there, its neighbours are ▶ and ■ — solid shapes — and a lone ring
among them read as a different kind of control rather than the third member
of a transport. The transport buttons are a flex box for the same reason the
glyph is: a plain character is centred by the button's own text centring,
while an inline SVG sits on the text baseline instead, which left Record and
the metronome measurably 10.5px left of centre.

**Emoji were removed from controls on purpose.** They rendered in the system's
own colour and style — full-colour pictures pasted into a monochrome stroked
UI — and looked nothing like the rest of the app. What stayed is the plain
geometric characters that already matched: the transport (`⏮ ■ ▶ ↺`), undo and
redo, the `▾`/`▸` disclosures, the `✕` closes and the `+`/`−` steppers. A
stroked play triangle reads worse than the filled one everyone expects.
`verify.js` audits every button in the toolbar, menu and track headers for
leftover emoji against an explicit keep-list, so that split is a recorded
decision rather than an oversight — and checks in the same pass that no button
lost its accessible name, since a glyph is `aria-hidden` and an icon-only
button with neither text nor `aria-label` would be nameless.

Two properties make one table enough. The paths are stroked with
`currentColor`, so a single copy works on a lit blue toggle, a muted grey
heading and a hover state without recoloured variants. And where a per-note
flag and a per-track control mean the same effect — Crush, Tremolo, Chorus,
Reverb, and per-note Echo against per-track Delay — they deliberately share a
glyph, so the two panels read as the same effect at two scopes; that one is
a fixed flag and the other a dial-able amount is what the `title` text says.

Sharing stops there. **No two different effects share an icon**: the three
sends used to draw one generic `send` arrow, so Delay, Chorus and Reverb
were three chips distinguishable only by their letter — which is the one
thing on a chip that means position rather than identity. They now reuse
the per-note Echo/Chorus/Reverb glyphs (the same-effect-two-scopes rule
above), and Par Comp got its own `parcomp` — two curves converging, the
blend — rather than borrowing Comp's.

The waveform glyphs are literal: the NES triangle is drawn as the 16-step
staircase that makes it sound unlike a plain triangle, and FM as a carrier
whose period keeps compressing. The EQ glyph is a response curve rather than
three miniature faders — the faders' knob marks turned into specks at the
18px the panel headings render at.

### A.15 Responsive / mobile / PWA UI

**Below 760px the page is a player, not a small editor.** Nobody composes on
a phone with this app; people do listen on one, and the PWA is installable on
Android, so that is the screen the player belongs on. `body.player-mode`
hides the toolbar, the whole editor layout and the scrollbar **as a group**,
so a control added to the toolbar later cannot leak into the player by being
forgotten. `#player` carries the song's name, tempo/meter/length, a draggable
position bar with elapsed/total times, a transport, a level meter, and a list
of songs — the bundled examples plus this browser's saved ones, the same two
sources the Songs dialog offers, because "which songs are there" should not
have two answers.

It is laid out as an **app shell rather than a page**: `#player` is one
viewport tall with `overflow: hidden`, the card, the "Songs" caption and the
editor link are fixed-size flex items, and the song list is the only thing
that scrolls (`flex: 1 1 auto; min-height: 0; overflow-y: auto`). Thumbing
down a long list otherwise carried Play and the position bar off the top —
the two controls you reach for *while* something is playing and you are
looking for the next thing. Two details are load-bearing rather than
decorative: **`min-height: 0`**, because a flex item's default
`min-height: auto` lets the list grow to fit every song and push the card
away instead of scrolling inside its own box; and **`height: 100%` rather than any viewport unit**,
chained from `<html>` via a `player-shell` class set alongside
`player-mode`. Installed as a PWA the page runs in standalone/fullscreen
(`display_override`), and there the viewport units do not mean what they mean
in a tab with an address bar — the same build that looked right in Chrome
came out with the song list squeezed and each description cut through the
middle of its glyphs. A percentage asks the actual containing block how tall
it is, in every display mode. The song buttons and their description spans
are both `flex: 0 0 auto` for the same reason: a flex item with
`overflow: hidden` has a *zero* automatic minimum, so the span is the one
thing here that can silently lose half a line. `overscroll-behavior: contain` keeps a fling that reaches the end
of the list from continuing into the page behind it.

The editor is **hidden, not unbuilt**: `render()` still runs, and the player
reads `visualPlayhead`, `COLS` and the master meter rather than keeping a
second copy of the transport's state. Hiding costs a class; a second playback
path would cost correctness. Its transport buttons *click the editor's own*
for the same reason. The per-frame update hangs off `onPlayheadMove`, a hook
in `updatePlayheadPositions()` rather than a direct call, because the player's
bindings live at the end of the module and that function runs during the boot
render — a named call there would read them inside their temporal dead zone
and take the whole script down.

There is a **way back**: "Open the editor anyway" sets a `localStorage` flag
and gives today's mobile editor layout, remembered per browser. A phone in
landscape and a small tablet land under the same breakpoint, so a hard block
would strand anyone who genuinely wanted to fix one note.

- With the editor opted into below ~760px, `.editor-layout` stacks vertically,
  the inspector becomes a bottom sheet, toolbar "extra" panels collapse behind
  "⋯ More", and a rotate-hint banner suggests landscape orientation.
- Touch targets grow under `(pointer: coarse)`.
- The app is installable (`manifest.webmanifest`, `display_override:
  ["fullscreen","standalone"]`) and works offline once loaded
  (`sw.js` precaches the app shell, song-data, bundled example songs, and
  icons).

### A.16 Recording, MIDI input & metronome

Notes can be played in from the computer keyboard, or from a **MIDI
keyboard** (A.16b), rather than clicked in. Three controls make that up:

- **R** on a track header (A.4) **arms** that track. There is one keyboard,
  so there is one armed track: arming another moves the arm rather than
  adding to it, and clicking R again disarms. An armed track's R button is
  red and carries `aria-pressed="true"`.
- **Record** in the transport starts **one bar of count-in** (clicks on
  every beat of a bar, whether or not the metronome is on — you asked to
  record, so you get the beat you are recording against), then rolls the
  transport and captures. Pressing it again, or Stop, ends the take.
  `<body>` carries `counting-in` during the count-in and `playing` after, so
  the two states are visually distinct. Nothing is armed ⇒ the button
  announces "Arm a track with its R button first" and does nothing else.
- **Metronome** in the transport toggles a click on every beat, a fifth
  higher on the downbeat so the bar is findable without counting. It is a
  rehearsal aid, not part of the mix (B.6), and is remembered per browser
  in `localStorage` rather than saved with the song.

**Key layout** (tracker-style, so it is already in the fingers of anyone who
has typed music before), on a **tonal** armed track:

| Row | Keys |
|---|---|
| Lower octave | `Z S X D C V G B H N J M` = C C♯ D D♯ E F F♯ G G♯ A A♯ B |
| Octave up | `Q 2 W 3 E R 5 T 6 Y 7 U I` = the same run an octave higher |
| Octave shift | `[` / `]` (range 1–7, announced) |

On a **rhythm** armed track the lower row plays the kit instead:
`Z X C V B N M , . /` = the ten `RHYTHM_ROWS` in the order the grid shows
them. Keys are mapped by **`event.code`, not `event.key`**, so the layout is
positional and a non-US keyboard plays the same notes from the same places.

Every key sounds immediately through the armed track's own channel — so
what you hear while playing is the waveform, envelope and FX the note will
have — whether or not the transport is rolling. While **recording**, a note
is committed on **key up** with a length taken from how long the key was
held, floored at one grid step; a drum hit has no length and commits on key
down. Both snap to the current grid resolution and go through the same
collision predicates (B.5) as a mouse-placed note, so recording over an
existing part replaces same-pitch/same-drum items rather than stacking on
them.

**Step entry.** With the transport **stopped**, the same keys write into the
song a step at a time: each one places a note at the playhead and moves it
on one grid step, so a part can be typed out at your own pace instead of
played in time. This — not the real-time take, which needs both hands and a
sense of timing — is what makes composing without a pointer possible, so
every step announces what landed through the same live region the grid
selection uses (A.13).

- **Chords are one gesture.** Keys pressed together land on one column and
  the playhead moves once, at the release of the last of them. Advancing
  per key would spell a chord out as an arpeggio.
- **A stepped note commits on key down** with a fixed one-step length: with
  no clock running, how long you lean on a key can't mean anything.
- **The arrows move the cursor in both dimensions** — `←`/`→` through time
  (`→` leaves a rest), `↑`/`↓` from track to track (the arm moves with it,
  since there is only one) — with `Home`/`End` jumping to the start of the
  song or to **one step past this track's last item**, which is where you
  would carry on writing rather than the end of the song. **`Backspace`**
  steps back and clears that step, leaving the cursor there so the next key
  fills the gap. All of these shadow the selection nudge, jump and delete,
  which is the same trade the letter keys already make.
- **Every move reports what it lands on**, not only where it is
  (`stepContentsLabel()`/`announceStep()`): "bar 2 beat 3, C4, E4", or
  "empty". A cursor that only says where it is tells you how far you have
  walked but nothing about what you walked over — which is the difference
  between navigating a part and counting bars in the dark. Chords read low
  to high so the order is stable, and moving to another track names it.
- **Only when nothing is rolling.** Plain Play with a track armed means
  "listen", not "type into the song"; only Record captures.

Note keys are live **only while a track is armed**, which is what leaves the
plain letter shortcuts (`M` metronome, tool keys) and the selection arrows
working the rest of the time. Arming also **activates** the track, so the
lane the tools and inspector act on is the one being typed into.

---

### A.16b MIDI keyboard input

`navigator.requestMIDIAccess()` (Web MIDI), reached from **Connect MIDI
keyboard** in the ☰ menu. Explicit rather than automatic: the browser prompts
for MIDI access, and a prompt nobody asked for is noise. The menu item then
names what it found ("MIDI: Fake Keys") and reads
`MIDI input unavailable in this browser` where Web MIDI does not exist —
Safari, most notably.

**Omni: every input, every channel.** A device picker would be one more thing
to choose, and to re-choose whenever something is unplugged, for the common
case of one keyboard on the desk. `onstatechange` picks up devices plugged in
later and releases held notes when one is pulled out, so a disconnected
keyboard cannot leave a note sounding forever.

Everything downstream is the computer keyboard's own path
(`recNoteDown`/`recDrumDown`/`recKeyUp`), so live monitoring, recording
against the grid and step entry all behave identically and a note becomes a
note in exactly one place. Two things differ:

- **Velocity is real.** A MIDI note-on carries 1–127; `midiVelToVel()` maps
  it onto the editor's 0.1–1, rounded to the 0.05 step the Velocity sliders
  offer so the value lands on something a slider can represent. That is the
  same function MIDI *file* import uses — a file and a live take have no
  business disagreeing about how hard the same 96 is. It reaches the
  monitoring voice too, not just the stored note: playing softly has to
  *sound* soft, or the velocity is invisible until after the take. Hits
  follow the usual **absent means full** rule, so a kit played at full level
  serialises exactly as it did before velocity could reach it.
- **Drums come through the General MIDI map** (`GM_DRUM_REVERSE`, shared with
  file import). A note that maps to no kit piece is dropped rather than
  folded onto the nearest one, which would put hits on the grid that were
  never played.

A note-on with **velocity 0 is a note off** — a real and common encoding
rather than an edge case, since many keyboards never send `0x80` at all;
treating it as a press leaves every note stuck on. Pitch bend, the modulation
wheel and the sustain pedal are **not** read: the app's `bend` is a per-note
flag with a fixed shape, not a continuous curve, so those need a new model
for how a bend is stored rather than just new parsing.

## Part B — Backend / Architecture Specification

### B.1 Runtime model

There is no application server. `dev-server.js` is a dependency-free static
file server used only for local development (ES modules don't load from
`file://`); `dev.js` wraps it to also open a browser once it's responding,
and `start.cmd` is a Windows double-click entry point that runs `dev.js`.
In production the whole repo is served as static files (GitHub Pages). All
state, rendering, and audio synthesis run entirely in the browser. The only
network activity is fetching example-song JSON from `songs/` on demand.
`verify.js` is a headless-browser smoke test used during development (see
B.9) — it is not part of the runtime.

### B.2 State model

A single mutable `state` object is the source of truth; every interaction
mutates it and then calls `render()` (which also autosaves and checkpoints
undo history) — there's no reactive framework, no virtual DOM, no diffing.

```js
state = {
  trackList,   // [{ id, name, color, kind: 'tone'|'rhythm' }], ordered;
               // rhythm entries always stay grouped after every tonal entry
  tracks,      // id -> Note[] (tonal) | Hit[] (rhythm)
  gains, waveform, pan, mute, solo,  // id -> value, the mixer
  tempo,       // BPM
  songName,    // display name (not song "content" — excluded from undo)
  masterVol,   // editor-preview-only master level
  activeTrack, // id of the track tools currently edit
  tool,        // 'pen' | 'eraser' | 'grab'
  grid,        // eighths per snap step
  timeSig,     // { num, den }
  markers,     // [{ col, name }]
  automation,  // id -> { gain?, pan?, delay?, chorus?, reverb?: Point[] } — see A.6
  adsr,        // id -> { attack, decay, sustain, release } (tonal only)
  filter,      // id -> { cutoff, q, envAmount } (tonal only) — DEFAULT_FILTER
  fm,          // id -> { ratio, depth } (tonal only, waveform === 'fm') — DEFAULT_FM
  fxSend,      // id -> { delay, chorus, reverb } (0..1 each, any track kind) — DEFAULT_FX_SEND, see A.7
  comp,        // id -> { threshold, ratio, attack, release } (any track kind) — DEFAULT_TRACK_COMP
  crush,       // id -> { amount } (0..1, any track kind) — DEFAULT_TRACK_CRUSH
  tremolo,     // id -> { rate, depth } (any track kind) — DEFAULT_TREMOLO
  vibrato,     // id -> { rate, depth } (tonal only) — DEFAULT_VIBRATO, see A.7/B.6
  duty,        // id -> pulse width (tonal, `square` waveform only); absent = plain 50% square
  eq,          // id -> { low, mid, high } dB (any track kind) — DEFAULT_TRACK_EQ
  activeFx,    // id -> { [effectKey]: { bypassed } } — which effects the panel
               // shows, plus each one's bypass flag. NOT an on/off switch for
               // the effect itself: every effect exists in the graph for every
               // track already (createTrackFxSends builds all three sends
               // unconditionally, the inserts are neutral by default), and only
               // isFxBypassed() ever reaches the audio. See A.7.
  masterEQ, masterComp, masterParallel, masterCrush, // song-global master-bus FX — see A.10/B.6
  sidechain,   // { enabled, depth } — song-global kick/snare-triggered ducking
  swing,       // % (0 = straight 8ths, up to 75 ≈ triplet feel) — swingOffsetCols()
  selected,    // { track, item } | null — the note OR hit object, never an index (B.5)
  multiSelected, // Set<Note|Hit> — group selection within activeTrack
  playhead, loopStart, loopEnd,
  marquee,     // { col0, col1, track } | null, mid-drag only
  recTrack,    // id of the record-armed track | null — one keyboard, one arm (A.16);
               // also gates step entry, and arming activates the track
  metronome,   // bool — click on every beat; per-browser, not song content
}
```

`recTrack` and `metronome` are **editor state, not song content**: neither
is serialised into a save file, written by `autosave()`, or captured in an
undo snapshot (`metronome` is remembered per browser under its own
`localStorage` key, the way per-track collapse state is). The rest of the
recording engine's own state — which keys are down, the octave, whether the
transport is capturing, where the step cursor's current chord is landing —
lives in module-level variables (`heldKeys`, `recOctave`, `recording`,
`countingIn`, `stepAnchor`) rather than in `state`, since none of it
survives a render, let alone a reload.

`PITCH_TRACKS`/`RHYTHM_TRACK_IDS`/`ALL_TRACKS` (derived id lists) and
module-level `COLS` (song length in eighths) sit alongside `state` rather
than inside it, rebuilt by `refreshTrackArrays()` whenever `trackList`
changes.

A `Note` is `{ start, len, freq, vel, bend, vib, trem, duty, arp, porta,
crush, echo, chorus, reverb, pan? }` (`pan` −1..1, **absent means centred** —
see `notePan()`) (columns are in eighth-note units; `MICRO = 1/6`
eighth is the finest shared lattice, so triplet and straight subdivisions
never drift). A `Hit` is `{ start, type, vel?, pan? }` where `type` is one of
`RHYTHM_ROWS`, `vel` (0.1–1) is how hard it's struck and `pan` (−1..1, absent
= centred, `hitPan()`) is where it sits; for velocity **absent means full**,
so every song written before hits had a velocity loads and sounds unchanged,
and the inspector deletes the property rather than writing `vel: 1` back.
`hitVel()` is the one reader, and clamps there so a hand-edited file can't
produce a broken gain. Multiple hits (or, in the pad/strings/stab style, multiple
tonal notes) can share the same `start` in one track to voice a chord or
layer percussion — and the editor creates them that way too: every
note-editing interaction is **pitch-aware**, so a note only ever conflicts
with another note at the *same* pitch overlapping it in time (see B.5).

### B.3 Song data schema (JSON, `version: 2`)

The shape returned by `currentSongData()` / accepted by `applySongData()`
— this is both the save-file format and the Songs-library example format:

```json
{
  "version": 2,
  "songName": "string",
  "tempo": 120,
  "cols": 576,
  "grid": 1,
  "timeSig": { "num": 4, "den": 4 },
  "markers": [{ "col": 0, "name": "Intro" }],
  "trackList": [{ "id": "lead", "name": "Lead", "color": "#2ff3ff", "kind": "tone" }],
  "gains": { "lead": 0.9 }, "waveform": { "lead": "square" }, "pan": { "lead": 0 },
  "masterVol": 0.45,
  "mute": { "lead": false }, "solo": { "lead": false },
  "tracks": { "lead": [/* Note[] */], "rhythm": [/* Hit[] */] },
  "automation": { "lead": { "gain": [{ "col": 0, "value": 0.9 }], "delay": [{ "col": 0, "value": 0.2 }] } },
  "adsr": { "lead": { "attack": 0.05, "decay": 0.15, "sustain": 0.7, "release": 0.15 } },
  "filter": { "lead": { "cutoff": 20000, "q": 0.707, "envAmount": 0 } },
  "fm": { "lead": { "ratio": 2, "depth": 0 } },
  "fxSend": { "lead": { "delay": 0, "chorus": 0, "reverb": 0 } },
  "comp": { "lead": { "threshold": -24, "ratio": 1, "attack": 0.01, "release": 0.25 } },
  "crush": { "lead": { "amount": 0 } },
  "tremolo": { "lead": { "rate": 5, "depth": 0 } },
  "vibrato": { "lead": { "rate": 5.5, "depth": 0 } },
  "duty": { "lead": 0.25 },
  "eq": { "lead": { "low": 0, "mid": 0, "high": 0 } },
  "sidechain": { "enabled": false, "depth": 0.5 },
  "masterEQ": { "low": 0, "mid": 0, "high": 0 },
  "masterComp": { "threshold": -24, "ratio": 1, "attack": 0.01, "release": 0.25 },
  "masterParallel": { "blend": 0 },
  "masterCrush": { "amount": 0 },
  "swing": 0
}
```

Loading is defensive/additive: `restoreTrackList()` rebuilds
tracks/gains/waveform/pan/mute/solo from whatever `trackList`+`tracks` are
present (tolerating old files with no `trackList` by inferring tonal tracks
from the data's keys) and clears every sparse per-track map through
`SPARSE_TRACK_MAPS` — it has to, because `applySavedMix()` only *sets* what
the file contains, so anything left behind would survive into the next song
(see the end of B.8). `applySavedMix()` then overlays
gains/waveform/pan/mute/solo/markers/automation/adsr/duty and the six
`TRACK_FX_REGISTRY`-driven groups (fxSend/eq/comp/crush/tremolo/vibrato —
see B.6) from the loaded data where present, validating each field's
shape/range.
`cols` is clamped to `[1 bar, MAX_COLS=576]`; if absent, it's derived from
the last note/hit's end, rounded up to a whole bar.

A separate **code-export** path (**Export code**) serializes only
`TRACKS`/`RHYTHM_TRACKS` JS literals matching `js/song-data.js`'s shape, for
pasting back into the originating game — `songName`, `markers`,
`automation`, `adsr`, and all six FX-panel groups have no representation in
that format and are intentionally excluded from it (the game's own audio
engine doesn't read them).

### B.4 Rendering pipeline

```
render()
 ├─ renderTimeline()      → ruler cells, bar numbers, renderMarkers()
 ├─ renderTracks()        → per state.trackList entry:
 │    ├─ renderPitchTrack(id) | renderRhythmTrack(id)
 │    │    └─ buildHeader(id) → identity row + Osc / Inserts / Output
 │    │         sections; buildFxPanel(id) is the Inserts one, built
 │    │         in place rather than as a separate row (see A.7)
 │    ├─ renderAutomationRow(id, param)   if automationOpen.has(id)
 │    └─ renderAdsrRow(id)                if adsrOpen.has(id)
 ├─ renderMasterFxChips() → the master strip's five chips (A.10)
 ├─ renderFloatingLayer() → #floating-layer: the "+" menu and the waveform
 │                          listbox — anchored to triggers in the DOM that
 │                          renderTracks() just built, so it runs after it
 ├─ positionOverlays()    → updateOverlayHeights(), updatePlayheadPositions(),
 │                          updateLoopPositions(), updateHScroll()
 ├─ renderInspector()     → the selected note/hit, or the active track's
 │                          FX strip (renderTrackStrip), or the empty state
 ├─ autosave()            → debounced localStorage write
 └─ checkpointHistory()   → debounced undo-stack push if state changed
```

Every track lane is fully rebuilt on every render (`innerHTML` reset +
rebuild) — there's no incremental patching. Drag interactions call
`scheduleRender()` (coalesced to one `render()` per animation frame) during
the gesture and a synchronous final `render()` on release, so dragging
stays smooth without spamming full rebuilds. Persistent chrome that must
never flicker mid-drag (playhead, marker layer, loop region/handles) is
created once by `createOverlays()` and only *repositioned*, never rebuilt,
by `positionOverlays()`.

**What that rebuild costs, measured.** A `render()` is what a drag waits for,
so the ceiling on a session's size is render time rather than any limit in
the data — nothing caps the track count, and `MAX_COLS` (576 eighths, 72 bars
in 4/4) caps only length. Timed in a headless container with no GPU, so read
the ratios rather than the absolute numbers:

| tracks, expanded, no notes | render |
|---|---|
| 5 | 61 ms |
| 12 | 122 ms |
| 24 | 247 ms |
| 48 | 471 ms |

Linear, about **9.5 ms per expanded track**. Two things that measurement
settled, both against the intuition that effects or note counts are what
hurts:

- **Effects are free per frame.** With every effect in `TRACK_FX_REGISTRY`
  switched on for every track, render time stayed within noise of the same
  song with none — sometimes lower. An effect is audio-graph nodes plus a
  chip, and a repaint does not touch the audio graph. Sends, EQ, compressor,
  bitcrush, tremolo and vibrato on thirty tracks cost nothing a drag can feel.
- **The expanded track *row* is the cost, not the grid contents — but it is
  not the header.** Forty-eight empty expanded tracks render in 471 ms; the
  *same* forty-eight collapsed render in **12.5 ms** — a 38× difference with no
  note removed. That measurement is right; the attribution first written here
  ("each header rebuilds a picker, a chip row, two sliders and a VU meter")
  was **wrong**, and instrumenting the phases settled it. Per render at 24
  tracks: building everything is 81 ms, of which `buildHeader()` for all
  twenty-four is **7 ms**; the reconcile and forced layout are **191 ms**.
  Collapsing is cheap because `renderPitchTrack()` returns before building the
  gutter and the lane, not because it skips the header. This also explains the
  header cache below: it cached the one part that was never expensive.

So the practical lever is per-track collapse (A.4), not fewer effects.

**It is the layout, not the rebuild** — which took two failed attempts to
establish, and is worth recording because both look obviously right:

- **Caching headers across renders buys nothing.** A cache keyed on
  everything `buildHeader()` reads, reusing the node when nothing changed,
  measured a **100% hit rate and no change in render time** (375 hits, 0
  misses, 251 ms at 25 tracks against 247 ms without it). `renderTracks()`
  clears `#tracks`, so re-appending a recycled node forces the same layout a
  fresh one does. Constructing the DOM was never the cost.
- **`content-visibility: auto` on `.track` is a 3–4× speed-up that breaks the
  overlays.** 471 → 155 ms at 48 tracks, 247 → 56 at 24. But the playhead,
  markers and loop region are all sized from `daw.scrollHeight`, and a skipped
  row reports its `contain-intrinsic-size` instead of its real height:
  **3660 px against 4130 over 17 rows**, so the playhead stopped 470 px short
  of the last track and the scrollbar lied. The placeholder cannot simply be
  set correctly either — a row is as tall as the taller of its lane (known at
  build time) and its header (content-driven, varying with the chip count).

**Built, measured at 13×, and reverted — twice over.** Two things had to be
true together, and only the pair works:

- *Keeping the row attached and refilling it* buys **nothing**. Measured: rows
  survived a render 24/24, and the time did not move (250 ms before, 250 ms
  after). The probe that suggested it would — "detach and re-attach the same
  nodes costs 194 ms of the 265" — measured re-attaching nodes whose layout was
  already computed, which is not what a render does. A second probe was
  misleading the same way: "replace every lane in place: 30 ms" used an
  `innerHTML` round-trip, nothing like 24 591 `createElement` calls.
- *Also skipping rows whose contents are unchanged* is where the win is.
  With a per-row signature deciding that, **272 ms → 21 ms** at 24 tracks,
  against a measured ceiling of 15 ms for touching only the one row that
  changed.

So the design is settled and the prize is real. What sent it back was the
cost of being *sure*: the signature must name every input a row draws, and a
forgotten one is a row that silently stops updating. Three were missed on the
first attempt and caught by the suite (`oscPickerOpen`, the marquee, and the
row's own index — the reorder arrows disable at the ends of the list). Then
three *different* steps began failing intermittently — the master EQ knob
losing focus, step-entry Backspace, the mobile song list — where the same
build passed on a re-run. Whether the render rework caused those or merely
changed the timing enough to expose them was not established, and shipping a
change to the render core on that footing is not defensible. The measurements
are kept here; the code is not.

Anything that tries again needs: the signature derived from lists that already
exist (`SPARSE_TRACK_MAPS` covers the per-track maps), a verify step asserting
both halves — that unchanged rows really are reused *and* that each thing a row
draws still forces a rebuild — and a suite that is stable across repeated runs
*before* the change, so a new intermittent failure is attributable. Note that
tagging the row element to detect a rebuild does not work: a reused row is the
same element, which is the entire point.

`verify.js`'s "off-screen rows keep their real height" step exists to keep
whatever does it honest.

Re-measure on any machine by timing what a real click costs, which is the
same path a drag takes:

```js
(() => { const hs = [...document.querySelectorAll('.track-header:not(.automation-header)')], t = [];
  for (let i = 0; i < 15; i++) { const a = performance.now();
    hs[i % 2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); t.push(performance.now() - a); }
  t.sort((x, y) => x - y); return t[7].toFixed(1) + ' ms per render'; })()
```

Past 16.7 ms a render drops a frame at 60fps, which is when a drag starts to
feel notchy.

Unlike Automation and Envelope, the FX chips (`buildFxPanel()`) need no
timeline-column width — they are status, not a curve — so they're built
straight into `buildHeader()`'s own left-column header instead of being
appended as a sibling `.track` row, and the knobs they point at live in the
inspector column (A.7) rather than in the grid at all.

`#floating-layer` is the one piece of chrome that is neither in a track row
nor rebuilt incrementally: `renderFloatingLayer()` clears and refills it each
frame, like `renderTracks()` does for `#tracks` and unlike `createOverlays()`'s
build-once-then-reposition pattern. The distinction is that the playhead and
loop chrome are always exactly one of each, while the floating layer's
contents vary in count — at most one add menu, at most one waveform
listbox, and often neither.

Two independent `requestAnimationFrame` loops run during playback:
`animatePlayhead()` (repositions the playhead and updates the Bars|Beats
counter — via `textContent` on persistent span elements, not an `innerHTML`
rebuild, since only the numbers change) and the VU-meter loop (throttled to
~30fps — a level meter doesn't need 60Hz to read as smooth, and the
per-channel `AnalyserNode` read is the one per-frame cost that scales with
track count).

### B.5 Interaction state machines

Direct editing is implemented as manual `pointerdown` → `window`-level
`pointermove`/`pointerup` state machines (no drag library). **Pointer
events, not mouse events** — one code path then covers mouse, touch and pen,
which is what makes the grid editable on a phone at all; the remaining
`mousedown` listeners in the file are only `stopPropagation()` guards that
keep a slider or select from starting a drag underneath it. The machines:
`startMoveNote`/`startResize`/`startMoveHit` (drag/resize existing
notes/hits), `startMarquee` (rubber-band multi-select), `startScrub`
(playhead), `startLoopDrag` (loop-range handles), `startAutomationDrag`
(automation curve points, generic across all five automatable parameters).
Each captures whatever it needs at gesture start (bounding rects, clamping
bounds from neighboring points/notes), applies `scheduleRender()` during
`pointermove`, and commits with a synchronous `render()` + `autosave()` on
`pointerup`.

**Read geometry before anything that can re-render.** `render()` rebuilds
track lanes wholesale, so a handler attached to a lane is left holding a
detached element — whose `getBoundingClientRect()` is all zeros. Both Pen
handlers used to call `setActive(track)` first and read the rect after, so
the *first* click into a lane belonging to some other track landed at
whatever row and column the raw viewport coordinates happened to divide
into (measured: a click meant for the snare on bar 1 placed a ride on bar 3;
in a pitch lane, G#0 instead of B4). It was unreachable while a new project
had a single always-active track, and immediate once the editor starts with
five. A drag that produces no net change (e.g., a plain click on an
automation point) deliberately skips the render/commit step — necessary so
a `dblclick` (used to delete) doesn't get its target element swapped out
mid-gesture by an intervening rebuild.

**What counts as a collision.** Two predicates decide it, and nothing
re-derives the rule locally:

- `notesConflict(a, b)` — same pitch *and* overlapping in time. Different
  pitches overlapping in time are exactly what a chord is, so they are never
  auto-removed. `clearOverlaps(notes, probe, keep)` wraps it for the common
  "drop this note in, displacing what it collides with" case, where `keep` is
  the note being edited in place so it survives its own check.
- `hitsConflict(a, b)` — same drum type *and* same column, so hits stack
  freely across rows: a kick and a hi-hat on one beat.

Every editing path routes through these — placing (`onCellClick`,
`onRhythmCellClick`), dragging (`startMoveNote`, `startMoveHit`), nudging
(`nudgeSelection`), pasting (`pasteClipboard`), the Chord buttons
(`addChordAbove`) and keyboard recording (`commitNote`/`commitHit`, A.16). That centralisation is load-bearing rather than cosmetic:
when each site spelled the comparison out inline the variants drifted, and
every drift silently deleted the user's notes or hits — five distinct bugs
traced back to it.

**Selection identity.** `state.selected` is `{ track, item }` and holds the
selected *object* — a note or a rhythm hit, since both are selectable; it is
never an array index, since deleting or reordering anything earlier in a
track would otherwise silently re-point it at a different item.
`renderInspector()` still confirms the item is present in the track before
editing it, because a paste, drag or undo can remove it. `selectItem()` and
`deleteItem()` handle both kinds — only the audition preview differs — so
there is no separate tonal and rhythm copy to drift apart.
`state.multiSelected` is a Set of objects implicitly scoped to
`state.activeTrack`, so every track switch has to clear it — go through
`activateTrack()` (or `setActive()`, which wraps it) rather than assigning
`state.activeTrack` directly, or a later nudge will pull the previous track's
items into the new one.

**Keyboard recording** (A.16) is a fourth state machine, driven by
`keydown`/`keyup` instead of pointer events. `heldKeys` maps `event.code` →
the note started by that key, so it is a per-key machine rather than a
global one and a chord is just several entries. `keydown` sounds the note
immediately (`monitorNote()` through the armed track's own channel, so the
monitor is the sound the note will have) and, while capturing, records its
start column; `keyup` commits with the length the key was held, floored at
one grid step. Auto-repeat (`e.repeat`) is swallowed — a held note is one
note, not a stream of them. Audio time becomes a column through
`ctxTimeToCol()`, which reuses the same `playStartCol`/`playStartCtxTime`
anchor the playhead animation does, then snaps to the current grid — which
is what makes a part played by hand line up with one placed by mouse.
`releaseAllKeys()` runs on window `blur` and from `stopPlayback()`: a key
held when the window loses focus never sends its `keyup`, and its note
would otherwise stay down and be committed with an absurd length later —
and `stopPlayback()` tears down the very clock those lengths are measured
against, so anything still held has to be resolved *before* that happens.

**Step entry** (A.16) reuses that machine with the clock taken out.
`stepEntryActive()` gates it on a track being armed and *nothing* rolling.
The cursor is a single `stepAnchor`: `beginStep()` fixes it on the first
key of a group, `endStepIfDone()` advances it only once `heldKeys` is
empty again — which is what makes a held chord one column instead of an
arpeggio, and why `endStepIfDone()` sits outside `recKeyUp()`'s
commit guard (a stepped key carries no `startCol` to commit against).
`setStepPlayhead()` deliberately uses `quant()` rather than `seekTo()`'s
`Math.round()`: rounding the playhead to whole eighths would drop every
other step back onto the previous one on a 1/16 or triplet grid.
`stepBack()` clears whatever starts within the step it moves back onto,
and drops those items from `state.selected`/`state.multiSelected` so no
stale reference survives — the same rule every other deletion path follows
(see "Selection identity" above).

### B.6 Audio synthesis engine

Built fresh each time playback starts (`ensureCtx()`), torn down on stop.
`buildMasterBus(c)` and `buildChannelChain(c, id, withAnalyser)` are the two
shared functions that construct this graph — called from all three places a
context gets (re)built: `ensureCtx()` (live playback), `ensureChannelNodes(id)`
(adding a track mid-session), and `renderSongToWav()` (offline export). Both
functions return a `Promise` (from `ensureCrusher()`/`ensureTrackCrusher()`'s
bypass-then-upgrade `AudioWorkletNode` loading — see below) that live
playback ignores fire-and-forget, but `renderSongToWav()` awaits before
calling `startRendering()`, since an offline render happens once,
deterministically, unlike live playback where the bypass-then-upgrade swap
can happen in place over an inaudible handful of milliseconds.

```
per-note oscillator (+ resonant lowpass filter, optional bitcrush
WaveShaper / detuned 2nd osc for chorus)
  └─► note gain (ADSR shape)
        ├─► echoSend ─► per-track delay ─┐
        ├─► reverbSend ─► per-track convolver ─┤ (both return into chanGain,
        │                                        the note-level Echo/Reverb
        │                                        toggles — A.9)
        └─► chanGain[track] (◄───────────────────┘)
              └─► chanEq[track] (insert, 3 biquads: lo shelf/mid peak/hi shelf)
                    └─► chanComp[track] (insert)
                          └─► chanCrush[track]? (insert, AudioWorklet, bypassed
                          │     until loaded — ensureTrackCrusher())
                          └─► chanTremolo[track] (insert, LFO on a GainNode's
                                own gain param)
                                ├─► chanPan[track] ─► masterGain
                                ├─► chanAnalyser[track] (VU meter)
                                ├─► trackDelaySend[track] ─► fxDelayBus  ─┐
                                ├─► trackChorusSend[track] ─► fxChorusBus ┤ (cont.
                                └─► trackReverbSend[track] ─► fxReverbBus┘  per-track
                                                                            sends — A.7)
fxDelayBus/fxChorusBus/fxReverbBus each feed their own effect (delay+feedback,
LFO-modulated chorus delay, convolver reverb) and return their wet signal to
masterGain.

masterGain ─► duckGain (sidechain ducking) ─► Master FX chain: EQ → Comp →
  parallel-comp blend ─► masterAnalyser (spectrum/LUFS) ─► downsampler
  (AudioWorklet) ─► destination

previewGain taps in separately (click-to-hear), bypassing mute/solo.
```

- **Per note**: `scheduleTone()`/`schedulePortamentoTone()` build an
  `OscillatorNode` (a `PeriodicWave` for pulse-width square waves, or a
  detuned oscillator pair for the `fm` waveform) → a per-track resonant
  lowpass `BiquadFilterNode` (`applyFilterEnvelope()` sweeps its cutoff
  using the track's ADSR shape when `filterState.envAmount !== 0`) →
  `GainNode`, shaped by `applyAdsrEnvelope()` (scaled down proportionally if
  attack+decay+release would exceed the note's own duration; note its
  `0.0001` floors are load-bearing rather than cosmetic — an exponential ramp
  cannot reach or leave zero. Web Audio 1.1: "If \(V_0\) and \(V_1\) have
  opposite signs or if \(V_0\) is zero, then \(v(t) = V_0\) … This also
  implies an exponential ramp to 0 is not possible." Starting the attack at 0
  would pin the whole envelope there, silencing every note) → optionally a
  bitcrush `WaveShaperNode` → `chanGain[track]`, with echo/reverb aux sends
  if `note.echo`/`note.reverb` (these are separate, per-track, always-on-if-
  toggled loops — distinct from the continuous Delay/Chorus/Reverb sends in
  A.7, which tap further downstream and apply to the whole track uniformly).
  Vibrato/tremolo are LFOs modulating frequency/gain; bend is a
  `linearRampToValueAtTime` mid-note; arpeggio steps the frequency every
  30ms through the chord tones; chorus adds a second, detuned oscillator
  into the same gain node; portamento glides the oscillator frequency into
  the next contiguous note instead of retriggering. **Pan** is a
  `StereoPannerNode` inserted last, just before the destination, so it places
  the note inside whatever the track's own pan has already done rather than
  fighting it; the echo and reverb taps come off the *pre-pan* node
  deliberately, so a hard-panned note doesn't drag its own tail across the
  field with it. At centre no panner is built at all — the same "no node when
  neutral" contract a full-velocity drum hit keeps, so a song that never
  touched pan builds the graph it always did.
  **Voice pooling** (`acquireVoice()`/`voiceGainFor()`, `VOICE_POOL_SIZE = 16`
  per channel) reuses a fixed pool of filter+gain+echoSend+reverbSend node sets
  across notes instead of building fresh ones each time — 24 filters carried
  117 notes of the demo song's first lookahead window, against 108 unpooled.
  Bitcrushed notes are excluded (their `WaveShaperNode.curve` is a plain
  property, not an `AudioParam`, so it can't be scheduled for a future note
  without retroactively corrupting whichever earlier note is still playing
  through that node) and panned ones too (a pooled voice is wired to the
  destination once, so it has nowhere to put a panner); both fall back to an
  ad-hoc gain+filter pair, as does an exhausted pool.
  A voice frees up at `startAt + dur + VOICE_RELEASE_PAD`, **not** at
  `startAt + dur`. `envelopeTimes()` ends the release exactly at `startAt +
  dur`, so reusing at that instant makes `voiceGainFor()`'s
  `cancelScheduledValues(startAt)` land on the release ramp's own end event and
  delete it — the gain then jumps from the sustain level straight to silence
  instead of ramping there, which is a click on every pair of back-to-back
  notes. The pad costs at most a voice or two per channel.
  That the end event is caught rather than spared is the spec's wording rather
  than an inference: `cancelScheduledValues` "cancels all scheduled parameter
  changes with times **greater than or equal to** `cancelTime`", and cancelling
  an active automation "may cause discontinuities because the original value
  (from before such automation) is restored immediately" (Web Audio 1.1,
  §AudioParam). A click at that boundary is a documented hazard of reusing a
  node at the exact instant its ramp lands; the pad steps around it.
  The tremolo LFO a note may have connected into a pooled gain is never
  disconnected, and does not need to be: "after a source has been stopped …
  the source MUST then output silence (0)" (§AudioScheduledSourceNode), and
  `AudioParam` inputs sum, so a spent LFO contributes zero to whichever note
  reuses the voice next.
  `resetAudioCaches()` clears `voicePools` whenever the context is torn down or
  swapped, which is what keeps an offline render (a different `AudioContext`,
  and its nodes cannot be mixed with a live one's) from ever seeing a live
  context's voices or vice versa.
- **Per-track insert chain** (`chanGain[id] → chanEq[id] → chanComp[id] → chanCrush[id]? →
  chanTremolo[id]`, built by `buildChannelChain()`): a `DynamicsCompressorNode`
  (`createChanComp()`), an optional bitcrush `AudioWorkletNode` reusing the
  master bus's own downsample processor (`ensureTrackCrusher()` — same
  bypass-then-upgrade pattern as the master `ensureCrusher()`, one instance
  per track), and a tremolo `GainNode` whose own `.gain` `AudioParam` is
  modulated by an LFO (`createChanTremolo()`). `chanTremolo[id]` is the
  fixed downstream anchor that `chanPan[id]`, the VU meter, and the three FX
  sends all connect from, so a bitcrushed/tremolo'd track's pan, meter, and
  sends all reflect the final processed signal. All six (Delay/Chorus/
  Reverb send, EQ, Compressor, Bitcrush, Tremolo, Vibrato) share one
  state-shape/UI registry, `TRACK_FX_REGISTRY` (get/set/apply functions plus
  each field's range/format/clamp-on-load rules per group) — both
  `applySavedMix()` (Song I/O load/validate) and A.7's UI —
  `buildFxPanel()`'s chips and `buildStripSection()`'s knobs alike —
  iterate this one table instead of six hand-written near-duplicate blocks; the underlying
  audio-graph wiring itself stays as separate functions (too heterogeneous —
  an async worklet insert vs. three send taps vs. a compressor insert — to
  be worth unifying further).
- **Automation**: `scheduleAutomationForChunk()` schedules a track's
  gain/pan/delay-send/chorus-send/reverb-send curves as native `AudioParam`
  ramps (`setValueAtTime` + `linearRampToValueAtTime`) directly on
  `chanGain`/`chanPan`/`trackDelaySend`/`trackChorusSend`/`trackReverbSend`,
  once per scheduling chunk (re-anchoring itself from each chunk's starting
  value) — independent of individual notes, so it keeps working correctly
  across chunk boundaries, loop points, and seeks.
- **The track's voice**: the six things a track contributes to a note's sound
  — ADSR, filter, FM, vibrato, the `square` pulse-width default, and the
  free-running PWM sweep LFO (`chanPwmLfo`, see the PWM paragraph below) —
  are gathered by `getTrackVoice(track)` into one object that
  `scheduleTone()`/`schedulePortamentoTone()` take as a single parameter.
  They used to be a tail of five optional positional arguments, which is how
  one ends up a slot off; a new per-track synth setting is now a field rather
  than another slot. `setOscWave(osc, oscType, duty)` picks the oscillator's
  shape in one place — that four-branch chain was previously written out three
  times (the main oscillator, the chorus oscillator beside it, and the
  portamento scheduler's).
- **Duty (pulse width)**: a per-track default for `square` tracks, resolved
  against the note's own value in exactly one place,
  `effectiveDuty(note, voice)` — the note wins, and `null` on the note means
  inherit. That inheritance is what finally separates the note inspector's two
  previously-identical choices: its first option now reads "Track default
  (…)" and names whatever the track is set to, while the explicit 50% below it
  forces a plain square regardless.
- **Per-track vibrato**: the exception to the insert-chain pattern above.
  `scheduleTone()`/`schedulePortamentoTone()` take the track's vibrato
  settings alongside its ADSR/filter/FM and call `addTrackVibrato()`, which
  connects an LFO into that note's `osc.frequency` — depth converted from
  cents by `centsToRatio()` and scaled by the note's own frequency, so the
  wobble is the same musical interval at every pitch. The per-note Vibrato
  flag connects a second LFO into the same param; `AudioParam` inputs sum, so
  the two add rather than one winning. At depth 0 nothing is created at all.
- **The note's sound source**: `createVoiceSource(oscType, duty, freq, fm)` is
  the one place a waveform is turned into nodes. Most are an `OscillatorNode`;
  **Noise** is a looping 93-sample buffer — the NES's short-mode LFSR period,
  which is what makes that mode buzz at a pitch instead of hissing — played at
  a `playbackRate` that brings the loop round at the note's frequency; **Ring**
  is a carrier multiplied by a second oscillator through a `GainNode` whose own
  value sits at 0, so the modulator swings it between −1 and +1 and the output
  is the product rather than one fading the other.
  It returns `{ out, pitch, toPitch, detune, start, stop }`. `out` is what
  connects onward and is not always the node being pitched (ring mod's output
  is the multiplying gain). `toPitch` converts Hz into whatever unit that
  source's pitch parameter uses, and **both mappings are linear in frequency**
  — which is the whole reason bend, arpeggio, vibrato and FM work on noise
  without a second copy of the scheduling code: absolute targets convert
  directly, and depths expressed as a fraction of the note's own frequency
  convert by the same factor.
  **PWM** is the classic analogue trick: a sawtooth minus a delayed copy of
  itself is a pulse train whose width is that delay as a fraction of the
  period, so sweeping the delay sweeps the width. An LFO on `delayTime` does
  the sweeping — the same trick the chorus bus uses. That LFO lives on the
  *channel* (`chanPwmLfo`), not the note: one free-running oscillator per
  track, started when the channel is built and never restarted, which each
  `pwm` note scales into its own period. A per-note LFO starts at phase 0 every
  time, so every note began at the same 50% width and only notes long enough to
  cover much of a 0.8Hz cycle moved at all — a run of eighth notes was a plain
  square wave. Measured over eight consecutive notes, the per-note version
  started them all within 0.02 duty of each other; the shared one spreads them
  across 0.28–0.74, the full sweep. Crucially the delayed path
  is fed from the *same* oscillator rather than a second one started alongside
  it: two oscillators would have to stay in phase for the width to hold steady,
  which Web Audio does not promise, and splitting one makes it exact by
  construction. The delay is set from the note's starting frequency, so a bend
  or vibrato moves the pitch without moving the duty proportionally — the same
  compromise ring modulation's fixed modulator makes.
  The noise buffer is scaled to 0.57 rather than full ±1: resampling a random
  step sequence overshoots, and unscaled it measured about 5 dB above the
  oscillators, so switching a track to Noise jumped in level.

  **The waveforms are levelled on peak, so their RMS differs — by design.**
  That is what crest factor means: a square is 1, a sine 1.41. Measured
  against square at C5: sine/FM −1.5, NES Tri −2.9, triangle −3.2, PWM/half
  sine −3.4, noise −4.5, saw −4.7, ring −6.2 dB. Every one of those figures is
  flat across the range — all ten within 0.05 dB between C5 and E4 — while
  *peak* swings up to 4 dB for noise and ring, because the noise loop is 93
  samples whose phase against the envelope shifts with `playbackRate` and ring
  mod's peak follows the carrier/modulator beat. A peak spread across pitch is
  therefore not a levelling fault, and reading one as such is how a
  non-existent "noise and ring aren't levelled across pitch" item briefly got
  filed as audio work (the retraction is in DONE.md). `verify.js` checks
  both: RMS in a −7…+0.5 dB band (tight, pitch-stable, and where a loudness
  drift shows) and peak in a wider
  −6…+1.5 dB one (headroom, and where the original hot-buffer bug showed).
- **Rhythm**: each hit type is a small dedicated synthesis function
  (`scheduleKick`/`scheduleSnare`/`scheduleRim`/`scheduleHihat`/
  `scheduleOpenHat`/`scheduleShaker`/`schedulePuka`(tom)/`scheduleClap`/
  `scheduleCrash`/`scheduleRide`) — filtered noise bursts and/or short
  pitch-swept oscillators, no shared "drum" abstraction since each sound's
  shape is bespoke. They are all reached through one dispatch point,
  `scheduleDrum(type, startAt, destGain, vel, pan, kitId)`, used by playback,
  the click-to-place preview and the pattern auditions alike. That is also where
  per-hit **velocity** and **pan** are applied — a plain `GainNode` and a
  `StereoPannerNode` in front of the destination, built backwards so pan ends
  up last, deliberately *not* as arguments threaded into the ten
  functions: each hand-writes its own multi-stage envelope (the snare has two,
  the clap three), so scaling every `exponentialRampToValueAtTime` by hand
  would be ten chances for the same factor to drift. At full velocity no node
  is inserted at all, so an untouched song builds the identical graph it built
  before hits had a velocity — which matters when an offline render schedules
  thousands of them. Each rhythm track routes to its own `chanGain[id]`, so
  multiple rhythm tracks mix, pan, and get FX-processed independently.
- **Velocity is tone, not only level.** Below full, `scheduleDrum` inserts a
  second node after the gain: a lowpass whose cutoff `velocityCutoff()` maps
  the 0.1–1 velocity range onto 900 Hz–18 kHz *exponentially*, because pitch
  and brightness are heard in ratios rather than in hertz. A real drum struck
  gently gives you less of the sharp top end as well as less of everything, so
  a ghost note at 0.2 now sits behind the beat instead of being a scale model
  of the accent. It follows the same **absent means neutral** rule as the gain
  beside it — at velocity 1 neither node is built, so the untouched-song
  guarantee above is unchanged, and one filter per quiet hit is the same order
  of cost as the gain stage that was already there.
- **Three drum kits**, one table. `DRUM_KITS` holds `retro` (the default),
  `eighties` and `acoustic`, each a plain object of the frequencies, decays
  and levels the ten schedulers read; every scheduler now takes `(startAt,
  destGain, kit)` and reads `kit.snare.noiseDecay` where it used to carry the
  number inline. `retro` carries *exactly* today's numbers, so the default kit
  is unchanged by construction rather than by ear. A kit is therefore a table
  row, not a tenth synthesis path: the pieces, the rows, the patterns and
  every hit already written stay identical, and switching kits re-voices a
  part without editing it. It is per rhythm track (`state.kit`, in
  `SPARSE_TRACK_MAPS`, so save/load/undo/remove came free), **absent means
  `DEFAULT_KIT`** — an older song file has no `kit` key and loads as retro,
  which is what it was written as. What the numbers actually buy: the 80s kit
  is the gated snare (noise decay 0.34 against retro's 0.09), a crash that
  rings 1.6 s, and a wider clap; the acoustic kit is a lower, slower kick
  (110→48 Hz over 0.05 s) and a snare with more body than sizzle. Three of the
  schedulers had to start setting `src.loop`, since a decay that outlasts the
  shared noise buffer would otherwise fall silent mid-tail. The picker *is* the waveform
  trigger: a track has a waveform or a kit and never both, so the two share
  `.th-osc-trigger`, `oscPickerOpen` and the floating-listbox machinery, with
  `renderFloatingLayer()` choosing the list from the track's kind. The section
  is captioned **Kit** rather than **Osc**, since a rhythm track has no
  oscillator. None of that is cosmetic — two earlier versions were worse in
  ways that only showed up in use. A half-width `<select>` under an "Osc"
  heading was reported as the feature being *absent*. Widening it fixed that
  and left a second problem: a native `<option>` cannot carry an SVG, so the
  three kits were distinguishable only by reading their names, on a track
  whose tonal neighbours all show their waveform's own shape. Each kit now
  names a glyph in its own `DRUM_KITS` row, so a kit is still one row picture
  included, and the three draw the shape of a hit's decay — a narrow spike, a
  tail chopped by a vertical wall, a long smooth taper — over a shared
  baseline and strike line, which is the one thing that actually separates
  them.
- **A track row says what kind it is.** `data-kind="pitch"`/`"rhythm"` on the
  `.track` element. It exists because the alternative was in use and failed:
  everything that needed to tell the two apart inferred it from a control the
  header happened to carry ("no waveform trigger, therefore rhythm"), and the
  moment the kit picker adopted that trigger, five verify steps timed out at
  once against working code. Inference from an incidental UI detail is a
  coupling nothing warns you about until it breaks.
- **Seeded noise**: the reverb impulse (`ensureReverbImpulse()`) and the two
  drum noise buffers (`ensureNoiseBuffer()` for hi-hat/snare/rim/shaker,
  `ensureCrashNoiseBuffer()` for crash/open-hat/ride) are filled from
  `mulberry32()` streams with fixed seeds, not `Math.random()`. They used to be
  random per page load, so the reverb tail and every noise-based drum sounded
  slightly different on every reload, and a song's true peak wandered about a
  decibel between renders — enough that measuring headroom took several passes
  to trust. **This does not make a render byte-reproducible**, and the buffers
  were never the only source: two exports of the same song still differ, even
  within one page load. Measured, that difference is **−121 dBFS RMS, peaking
  at −79 dBFS** — 104 dB below the signal, and 0.075% of the exported 16-bit
  samples differing by at most 4 LSB. Audibly identical, in other words;
  numerical noise in the last bits rather than a different mix. See TODO.md for
  what the investigation ruled out.
  Each buffer gets its
  **own** generator rather than sharing one stream: a shared one would make
  each buffer's contents depend on which others had already been built, and
  that order varies with which sounds a song uses. `mulberry32` relies only on
  `Math.imul` and `>>>`, both exactly specified, so the stream is identical in
  every engine.
- **Global FX buses** (`createGlobalFxBuses()`, part of `buildMasterBus()`):
  a shared tempo-synced delay, a shared LFO-modulated chorus, and a shared
  convolver reverb (reusing `ensureReverbImpulse()`'s impulse response) —
  each track taps in at its own send level via `createTrackFxSends()`
  (`trackDelaySend`/`trackChorusSend`/`trackReverbSend`), and every tap's
  wet signal returns to `masterGain`.
- **Master bus** (`buildMasterFXChain()`/`applyMasterFX()`, all optional —
  neutral defaults are a no-op): `masterGain` → `duckGain` (gain node
  ducked on every kick/snare hit by `scheduleDucking()` when sidechain is
  enabled) → 3-band EQ → `DynamicsCompressorNode` → a parallel-compression
  dry/wet blend → `masterAnalyser` (drives the spectrum canvas + LUFS
  estimate) → a lo-fi sample-and-hold `AudioWorkletNode`
  (`js/downsample-processor.js`) → `destination`. Its five control groups'
  state shape and UI come from `MASTER_FX_REGISTRY` — a second table beside
  `TRACK_FX_REGISTRY`, deliberately not folded into it (A.10) — while the
  chain construction above stays hand-written for the same reason the
  per-track wiring does.
- **Metronome** (`ensureMetronomeBus()`/`scheduleClick()`, A.16): a 35 ms
  square blip — 1800 Hz on a bar's downbeat, 1200 Hz otherwise — on its own
  `metroGain` connected **straight to `ctx.destination`**, deliberately
  bypassing `masterGain` and the whole master chain. It is a rehearsal aid,
  not part of the mix, so it must not be EQ'd, compressed, ducked or
  metered with the song — and it must not exist in an offline render at
  all: the guarantee there is simply that `renderSongToWav()` never calls
  `scheduleMetronomeForChunk()`, so a click can never reach an exported
  file. Clicks are scheduled per chunk alongside the notes, on every beat
  that falls inside it, with **swing deliberately not applied** — the
  metronome is the straight reference the swung part is played against.
  `metroGain` is nulled in both context-teardown paths beside `masterGain`.
- **Playback scheduling**: `startPlaybackFrom(col)` schedules one bounded
  "chunk" (`SCHEDULE_LOOKAHEAD_BARS` = 8 bars, capped to the loop end or
  song end if closer) ahead of time via Web Audio's own clock
  (`ctx.currentTime` + lookahead), then re-arms via `setTimeout` for the
  next chunk once the current one is about to finish — not a real-time
  per-frame scheduler, so it stays sample-accurate regardless of
  `requestAnimationFrame` jitter. Capping each chunk keeps every scheduling
  burst bounded regardless of total song length — scheduling the whole
  remaining song in one synchronous call (the original design) creates
  enough `AudioNode`s for a long, dense song to visibly freeze the page for
  a moment on a weaker mobile CPU. The visual playhead is driven by a
  separate `requestAnimationFrame` loop that just interpolates position
  from the audio clock, so it advances smoothly across chunk boundaries
  without needing to know about them.

### B.7 Undo/history

`snapshotSong()` serializes the undo-relevant subset of state — `tempo`,
`cols`, `tracks`, `trackList`, `gains`/`waveform`/`pan`/`mute`/`solo`,
`automation`, `adsr`, `filter`, `fm`, `fxSend`, `comp`, `crush`, `tremolo`,
`eq`
— to a JSON string (*not* `songName`, `markers`, the song-global `masterEQ`/
`masterComp`/`masterParallel`/`sidechain`/`masterCrush`/`swing` settings, or
view-only state like collapsed tracks — these are treated as project-level
settings or presentation state rather than undo-able edits).
`checkpointHistory()` (debounced 400ms from `render()`) pushes the previous
snapshot onto `undoStack` if it differs from the last committed one, capped
at 100 entries; `undo()`/`redo()` swap between `undoStack` and `redoStack`
and call `restoreSnapshot()`, which also rebuilds the audio graph's channel
nodes for any track added/removed by the undo and reapplies the
`TRACK_FX_REGISTRY` groups that have something to reapply — every one but
Vibrato, whose `apply` is a deliberate no-op because a note's LFO is built
with the note and so picks the change up on the next scheduled chunk.

### B.8 Persistence & Song I/O

- **Autosave**: every `render()` schedules a debounced (400ms) `localStorage`
  write of the full `currentSongData()`-shaped payload under a fixed key,
  purely as a crash-recovery safety net. It is **write-only** — never read
  back automatically. The page always boots into the **starter layout**
  (`STARTER_TRACKS`, built by `starterProject()` — never seeded from saved
  data), so song selection always goes through the explicit Songs menu
  (A.11) rather than a reload-time prompt.
- **Local songs**: named saves under a second `localStorage` key, an
  object keyed by name; listed/loaded/deleted from the Songs dialog.
- **File save/load**: **Save file** downloads `currentSongData()` as a `.json`
  file (name slugified from the song name); **Load file** reads a selected file
  through the same `applySongData()` path as everything else.
- **Examples**: `songs/index.json` lists `{ file, name, desc }`; each
  example is fetched and applied the same way, with the display name
  overridden from the index entry (not the file's own `songName`, so
  renaming a local copy doesn't affect the example's library listing).
- **MIDI**: **Export/Import MIDI** move a Standard MIDI File (format 1, own SMF
  writer/parser, no library). Per-note effects have no MIDI equivalent and
  aren't round-tripped; import merges all channel-9 (drum) events in a file
  into the song's first rhythm track. Velocity *does* round-trip in both
  directions for notes and hits alike — the parser had always read the
  note-on velocity and then discarded it, so before this everything came in
  at full level and drum hits went out at a hardcoded 100. Imported values
  are rounded to the 0.05 step the Velocity sliders offer, so an imported
  item lands on a value the slider can actually represent.
- **Code export**: see B.3 — a distinct, narrower serialization for pasting
  into the originating game's own audio module.

**One list names the per-track settings.** The per-track song state splits
in two. The *seeded* maps — `tracks`, `gains`, `waveform`, `pan`, `mute`,
`solo` — get one entry per track with a real default, so a load rebuilds
them from the track list. The *sparse* maps — `automation`, `adsr`,
`filter`, `fm`, `fxSend`, `comp`, `crush`, `tremolo`, `vibrato`, `duty`,
`eq`, `activeFx` — treat an absent entry as the default, so a load has to
clear them wholesale before applying the file. Those twelve are named once, in
`SPARSE_TRACK_MAPS`, and `currentSongData()`, `snapshotSong()`,
`restoreSnapshot()`, `restoreTrackList()`, `createNewSong()` and
`removeTrack()` all walk it. **A new per-track setting goes in that list,
not into six call sites.**

It is a list because it used to be six hand-written ones, and four had
drifted apart — invisibly, since nothing about a missing key looks wrong:

- `restoreTrackList()` cleared two of them, so loading song B kept
  song A's filter, FM, sends, EQ, compressor, crush and tremolo on every
  track id the two shared. Every song has a `rhythm`, so this always had
  something to land on.
- `createNewSong()` cleared nine, forgetting `filter` and `fm`.
- `removeTrack()` deleted ten, forgetting `filter`.
- `applySavedMix()` restored ten, never reading `duty` — so a per-track
  pulse width was written into every saved file and silently discarded on
  load. `duty` is the one per-track setting that is a bare number rather
  than an object, which is exactly why it rode along in no shared loop.

`autosave()` writes `currentSongData()` itself rather than repeating its
field list, for the same reason: a crash-recovery net that quietly saves
less than a save does is worth very little.

### B.9 File & module map

| File | Role |
|---|---|
| `index.html` | The entire application — markup, CSS, and the single `<script type="module">` covering state, rendering, interaction, synthesis, and I/O. |
| `js/song-data.js` | `TRACKS`/`RHYTHM_TRACKS`/`TEMPO_BPM` — the demo song's note data, in the same shape the code-export path produces; `index.html` only imports `TEMPO_BPM` from it (a fallback used in a couple of places) — the full demo song is loaded only via the Songs menu's "Froggy Hop" example. The only other JS module besides `js/downsample-processor.js`. |
| `js/downsample-processor.js` | The shared `AudioWorkletProcessor` behind the master bus's Downsample control and every per-track Bitcrush insert (A.7, A.10) — a sample-and-hold lo-fi downsampler. |
| `songs/*.json` + `songs/index.json` | Bundled example songs and their Songs-dialog listing. |
| `dev-server.js` | Dependency-free static file server, used for local development and by `verify.js`; stays plain (no auto-open) since it also runs headlessly. |
| `dev.js` | Wraps `dev-server.js` for interactive use — spawns it, polls until it responds, then opens it in the default browser. |
| `start.cmd` | Windows double-click entry point — checks `node` is on `PATH`, then runs `node dev.js`. |
| `cdp.js` | Shared Chrome DevTools Protocol plumbing — `findBrowser()`, `launchChrome()`, `openPage()`, the `CDP` class — behind `verify.js`, `shots.js` and `icons.js`. Exists because the same ~120 lines were hand-copied into two tools and drifted (`shots.js` shipped without the hardcoded browser install-path list its sibling had); a third copy was about to be written when this was pulled out instead. |
| `shots.js` | Regenerates `docs/img/*.png`, the screenshots README.md links to. Same shape as `verify.js` — own dev-server, headless Chromium over CDP, Node built-ins only — and checked in for the same reason the test is: a picture of a UI goes stale loudly, so re-shooting has to be a command rather than an afternoon. Each shot names the viewport it is framed for and reaches its state through the app's real gestures (the Songs menu, a chip click), so a screenshot cannot show something the app can't actually reach. |
| `icons.js` | Draws the app icon and writes every file the manifest, `index.html` and `sw.js` declare — `icons/icon.svg`/`icon-maskable.svg` written directly, the six PNGs screenshotted off them via `cdp.js`. Checked in for the same reason `shots.js` is: the previous icons came from a one-off script nobody kept, so changing the icon meant writing a PNG encoder from scratch. Now it's `node icons.js`. It is both a command and a module: it draws only under `require.main === module`, and exports `MARK`/`markup()`/`OUTPUTS` so `verify.js`'s icon audit can compare the committed SVGs against the drawing itself rather than trusting that they look plausible. |
| `verify.js` | A permanent, dependency-free headless-browser smoke test — drives the app over the Chrome DevTools Protocol (`WebSocket` + JSON-RPC, Node built-ins only) through a handful of core interactions and fails on any wrong expectation or console error/exception. Not a full test suite; a reusable regression check. Its first two steps never open a browser: `auditBundledSongs()` reads `songs/*.json` and checks every field against what `applySavedMix()` accepts, and `auditIcons()` checks the manifest, `index.html`'s `<link>`s and `sw.js`'s `SHELL_URLS` both against each other and against `icons/` on disk — each with its constants extracted from the real files so the audit cannot drift from what the app actually does. They run first because a bad example ships to everyone who opens the Songs menu, and because hearing about either costs seconds rather than the browser run's minutes. |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA installability and offline caching — the icon set itself is `icons.js`'s output, not hand-drawn. |
| `TODO.md` / `DONE.md` | What is left to build, and the working journal behind what is. A finished item moves from one to the other rather than staying as a `[x]` in a list of what remains — `TODO.md` is meant to be read start to finish, which it stops being once four fifths of it is done. `DONE.md` carries the measurements, the hypotheses that were ruled out and how, and why each solution looks the way it does rather than like the obvious alternative; several entries record a claim that turned out to be wrong, which is the part that is most expensive to discover twice. |
