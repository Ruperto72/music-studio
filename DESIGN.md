# Web Audio Studio — Design Specification

This document specifies the design of **Web Audio Studio**, a browser-based 8-bit
chiptune editor, in two parts: the **GUI** (what the user sees and touches)
and the **backend** (the client-side data model, rendering pipeline, and
audio engine that drive it — there is no server-side backend; "backend" here
means the application's internal architecture).

It describes the system as built, not a proposal — it's a reference for
understanding or extending `index.html`. See `CLAUDE.md` for the shorter
orientation aimed at an editing session, and `TODO.md` for what's
deliberately not built yet.

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
- **Iconography**: emoji throughout (🎵 💾 📂 ⤓ ⛶ ✏️ 🧽 ✋ 🚩 🔍 ▾ ▸ ✕ ✨), no
  icon font/SVG sprite sheet — keeps the app dependency-free.
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
│ header│ (horizontally + vertically scrollable, │  (selected-note │
│ (name,│  playhead line, markers)                │   effects, or   │
│ M/S/  │                                         │   empty state)  │
│ ✕,    │  ...one row per track, plus optional    │                 │
│ wave, │  Automation / Envelope rows when open   │                 │
│ Auto/ │  (the ✨ FX panel expands the header      │                 │
│ Env/  │  in place instead — see A.7)             │                 │
│ FX,   │                                         │                 │
│ vol,  │                                         │                 │
│ pan,  │                                         │                 │
│ VU)   │                                         │                 │
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
| **Menu (☰)** | 🎵 Songs library, 💾 Save file, 📂 Load file, ⤓ Export code (toggles a code box open/closed), 🎹 Export MIDI, 🎼 Import MIDI, 🔊 Export WAV, ＋ Add track, ＋ 🥁 Add rhythm track, ⛶ Fullscreen, ❓ Help |
| **Transport** | Return-to-start (⏮), Stop (⏹), Play (▶), Loop toggle (↺) |
| **Bars\|Beats** | LCD-style counter (bar\|beat\|sub-beat, plus mm:ss) |
| **Tools** | Pen / Eraser / Grab tool segmented control; Undo/Redo |
| **Loop & Zoom** | Full range, ⧉ Repeat (duplicate the loop region forward), 🚩 Add marker, zoom −/100%/+ |

On narrow screens, an "⋯ More" toggle collapses the less-essential panels
(`.tb-extra`) behind a button to keep the primary controls reachable.

### A.4 Track headers & channel strips

Each track's header (`buildHeader()`) is a **sticky-left column** (200px)
with distinct rows, each independently hideable when the track is collapsed:

1. **Top row** (always visible, even collapsed): collapse toggle (▾/▸),
   track name (click-to-... double-click-to-rename, ellipsis-truncated),
   **M**ute, **S**olo, and (hidden when collapsed) **✕** remove.
2. **Waveform row** (hidden when collapsed): for tonal tracks, six icon
   buttons — Square/Triangle/Saw/Sine/NES Tri (wavetable)/FM, each drawn
   as the shape it produces — with the selected one's name spelled out
   underneath; rhythm tracks get a static "Kit" label with its own glyph
   instead. The buttons form a `role="radiogroup"` with `aria-checked`
   (the same pattern as the Pen/Eraser/Grab tool group, since this is one
   choice out of a set), and each carries the waveform's name as its
   `aria-label` because the glyph itself is `aria-hidden`. This replaced a
   `<select>`: the choice is "which of these shapes", which a dropdown can
   only ever show one of at a time — and a native `<option>` cannot carry
   an SVG at all. The six buttons are sized `flex: 1 1 0` so they divide
   the fixed 200px header (`--header-w`) however many waveforms exist.
3. **Tools row** (hidden when collapsed): **〰 Auto** (toggles the
   automation-curve row), **E Env** (toggles the envelope/filter/FM row,
   tonal tracks only — drum hits use fixed per-type envelopes), **✨ FX**
   (toggles the Delay/Chorus/Reverb-send + EQ + Compressor + Bitcrush + Tremolo
   panel — see A.7), and **🎚 Preset** (saves/loads that track's
   waveform+envelope+filter+FM as a named preset, shared across songs via
   `localStorage`).
4. **Volume row** (hidden when collapsed): a slider (0–2) + numeric readout.
5. **Pan row** (hidden when collapsed): a slider (−1–1, double-click to
   re-center) + L/C/R readout.
6. **VU meter** (always visible, even collapsed): a live post-fader level
   bar, silent when muted.

**Collapsed** state (▸) hides rows 2–5 (and the FX panel, if open) and shows
just name/M/S/VU — a slim overview strip so many tracks fit on screen;
**expanded** (▾) shows everything. Collapse state is per-browser
(`localStorage`, keyed by track id), not part of the saved song.

### A.5 Piano roll (pitch lanes) & rhythm grid

- Each tonal track's lane auto-fits its **pitch window** to the notes it
  contains (min span 15 semitones), so lanes stay compact instead of always
  spanning the full MIDI range (33–96).
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

Opened per-track via its header's **〰 Auto** button; renders as an extra
full-width row directly under that track (reusing the `.track-header`/
`.gutter`/`.lane` sticky-positioning trio so it lines up with the grid
above/below it):

- A `<select>` picks the parameter — **Volume** (0–2), **Pan** (−1–1),
  **Delay** (0–100%), **Chorus** (0–100%), or **Reverb** (0–100%) — each
  with its own independent point set. The three send parameters ramp the
  same continuous per-track FX sends the ✨ FX panel's sliders control (see
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
  automation existed for it — driven by the channel strip's (or ✨ FX
  panel's) static slider value for the whole song — fully backward
  compatible.

### A.7 Track FX panel

Opened per-track via its header's **✨ FX** button (see A.4); unlike
Automation/Envelope, this does **not** add a full-width timeline row — every
field in it is a static per-track knob with nothing tied to a timeline
column, so it renders as a compact two-column grid (`buildFxPanel()`)
appended directly into the track header itself, expanding the header's
height in place. Available on every track, tonal or rhythm alike. Five
groups, driven generically by `TRACK_FX_REGISTRY` (see B.6). Each group
opens with a heading — its glyph plus its name — which doubles as the
separator between groups; these replaced the thin dividers that used to
stand there, because abbreviations like Thr/Rat/Atk/Rel only read as a
compressor once you can see which group you are in:

- **Delay / Chorus / Reverb send** (0–100% each): continuous sends to three
  shared global effect buses, independent of the per-note Echo/Chorus/
  Reverb toggle buttons in the note inspector (A.9) — this is a always-on
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
  `0%` = full quality (default).
- **Tremolo** (Rate Hz / Depth %): a per-track amplitude-modulation LFO.
  `Depth: 0%` (default) leaves the level unmodulated regardless of rate.

A **Reset** button restores every field in all five groups to its default
(neutral) value in one click; **✕** closes the panel without changing
anything.

### A.8 Envelope, filter & FM editor

Opened per-track (tonal tracks only) via **E Env**; same full-width-row
placement convention as automation, but its "lane" is a plain flex row of
sliders rather than a column-indexed curve — it doesn't need to scroll
with the timeline:

- **A**ttack, **D**ecay, **R**elease are shown as a **percentage of each
  note's own length** (0–50%, or 2–60% for release) — they scale with short
  vs. long notes rather than needing per-tempo absolute times.
- **S**ustain is the held level (0–100% of the note's peak amplitude).
- A per-track resonant **lowpass filter**: cutoff (60Hz–20kHz, log slider),
  resonance (Q, 0.1–20), and an envelope amount (−1–1) that sweeps the
  cutoff using the same ADSR shape above (0 = filter envelope off, cutoff
  stays at its base value).
- Tracks on the **FM** waveform additionally show modulator **ratio** and
  **depth** sliders (`state.fm`, `DEFAULT_FM`).
- Tracks on the **Square** waveform show a **Duty** select (`state.duty`) —
  the track's pulse width, applying to every note on it. Same rule as the FM
  sliders above: a waveform-specific per-track synth setting, shown only for
  the waveform it applies to. A single note can still override it from the
  inspector (A.9); see B.6 for how the two resolve.
- The row's title reflects what's shown: "Envelope & Filter", or
  "Envelope, Filter & FM" / "Envelope, Filter & Duty" for those waveforms.
- **Reset** restores every default (ADSR, filter, FM, duty); **✕** closes the
  panel without changing anything.

### A.9 Note/effects inspector

The right-hand `.inspector` panel shows either an empty-state hint or the
controls for whatever single item is selected. A **rhythm hit** gets a short
panel of its own (`renderHitInspector()`): the drum's name, its bar and beat,
a **Velocity** slider (10–100%, the same range/step/formatting as the tonal
one below) and Delete. That is the whole list on purpose — a hit has no pitch,
no length and no per-note effect flags, and for drums those effects live on
the track's ✨ FX panel instead, since every kit sound on a track passes
through the one channel node those inserts and sends tap.

A **note** gets the fuller set, grouped into:

- **Selected note**: track-color badge, pitch name + frequency, note length,
  Velocity slider. Velocity is drawn on the grid as brightness (opacity
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
**🎛️** toggle for the **Master FX** panel.

**Song** is the project name, click-to-rename via a prompt (`renameSong()`)
while the strip is expanded; when the strip is collapsed the same name still
shows in the slim label bar but as plain, non-editable text — it's the same
underlying `state.songName`, just rendered as two different elements that
CSS shows/hides based on collapsed state, so the name stays visible either
way but is only editable when there's room for the "click to rename"
affordance. (Adding/removing tracks is a ☰-menu action, not part of this
strip — see A.3.)

The **🎛️** toggle opens the **Master FX** panel:

- **EQ**: 3-band (Lo shelf ~200Hz, Mid peak ~1kHz, Hi shelf ~4kHz, ±12dB).
- **Comp**: a `DynamicsCompressorNode` (threshold, ratio, attack, release).
- **Par Comp**: a parallel ("New York") compression blend — mixes in a
  second, much harder-compressed copy of the signal alongside the main one.
- **Sidechain**: ducks the master bus on every kick/snare hit (on/off +
  depth).
- **Downsample**: a lo-fi sample-and-hold `AudioWorkletNode` on the master
  bus (0 = full quality).
- **Meter**: a live frequency-spectrum canvas plus an approximate momentary
  LUFS readout (ITU-R BS.1770 K-weighting, not a certified meter).

All defaults are neutral (0dB, ratio 1:1, sidechain/downsample off), so an
untouched song's master bus is unaffected — see B.6 for the signal chain.

### A.11 Songs library dialog

Opened via 🎵; three sections:

1. **New song** — name it up front, then either **🎼 Starter tracks**
   (empty Melody/Bass/Rhythm) or **📄 Empty project** (just Rhythm).
2. **Examples** — fetched from `songs/index.json` + one `.json` per entry;
   loading replaces the current editor content (a warning tells the user to
   save first).
3. **My songs** (this browser) — save the current song under a name
   (`localStorage`), or load/delete a previously saved one.

This dialog is the *only* way a song's content gets loaded into the editor
— the page itself always boots into a blank project (see B.8).

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
  that only made sense positionally (**M**/**S**/**✕** per track) name their
  track.
- **State**: Mute/Solo and the per-note effect toggles expose `aria-pressed`;
  the Pen/Eraser/Grab cluster and the waveform picker are each a
  `role="radiogroup"` with `aria-checked`, since both are a single choice
  rather than a row of independent toggles. All of these previously carried
  their state only in a CSS class.
- **Keyboard grid access**: **Shift+←/→** steps the selection through the
  active track and **Home**/**End** jump to its ends, with the selected item
  announced through a polite live region (`announce()`). Plain arrows still
  nudge, so nothing already in muscle memory changed. Notes use a **roving
  tabindex** — only the selected one is a tab stop — so Tab reaches the grid
  without walking through hundreds of blocks.
- **Contrast**: the 8px uppercase panel captions were 3.23:1; they are now
  5.32:1. Body and muted text already passed AA.
- **Icons**: every glyph (A.14) is `aria-hidden`, and the control around it
  keeps its own text label or `aria-label`. The waveform picker, whose buttons
  are icon-only, additionally spells the selected shape's name out below the
  row, so no information is available *only* as a picture.

### A.14 Icon glyphs

One table, `GLYPHS`, holds every inline-SVG shape in the app, and `glyph(name)`
builds the `<svg>`. An entry is either a bare list of path `d` strings — the
wide **24×12** box with y=6 as the zero line, used by the waveform and effect
shapes — or `{ box, paths }` for the square **24×24** interface icons. Which
box a glyph uses is therefore a property of the glyph, not something every
caller has to know. (A list rather than one string because chorus is two
detuned waves and reverb an impulse plus its tail.)

They cover the waveform picker (A.4), the per-note effect toggles (A.9), the
FX panel's group headings (A.7), and the whole toolbar, ☰ menu and dialog set.
Static markup carries `data-glyph="name"` and one boot pass fills them in;
buttons built in JS use `setGlyphLabel(btn, name, label)`. Either way the label
stays a real text node, so the accessible name is what it always was.

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

The waveform glyphs are literal: the NES triangle is drawn as the 16-step
staircase that makes it sound unlike a plain triangle, and FM as a carrier
whose period keeps compressing. The EQ glyph is a response curve rather than
three miniature faders — the faders' knob marks turned into specks at the
18px the panel headings render at.

Not solved: there is no way to *create* a note from the keyboard, and no
spatial model of the grid for a screen reader — you can reach and edit what
exists, but composing from scratch still needs a pointer.

### A.15 Responsive / mobile / PWA UI

- Below ~760px, `.editor-layout` stacks vertically, the inspector becomes a
  bottom sheet, toolbar "extra" panels collapse behind "⋯ More", and a
  rotate-hint banner suggests landscape orientation.
- Touch targets grow under `(pointer: coarse)`.
- The app is installable (`manifest.webmanifest`, `display_override:
  ["fullscreen","standalone"]`) and works offline once loaded
  (`sw.js` precaches the app shell, song-data, bundled example songs, and
  icons).

---

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
  masterEQ, masterComp, masterParallel, masterCrush, // song-global master-bus FX — see A.10/B.6
  sidechain,   // { enabled, depth } — song-global kick/snare-triggered ducking
  swing,       // % (0 = straight 8ths, up to 75 ≈ triplet feel) — swingOffsetCols()
  selected,    // { track, item } | null — the note OR hit object, never an index (B.5)
  multiSelected, // Set<Note|Hit> — group selection within activeTrack
  playhead, loopStart, loopEnd,
  marquee,     // { col0, col1, track } | null, mid-drag only
}
```

`PITCH_TRACKS`/`RHYTHM_TRACK_IDS`/`ALL_TRACKS` (derived id lists) and
module-level `COLS` (song length in eighths) sit alongside `state` rather
than inside it, rebuilt by `refreshTrackArrays()` whenever `trackList`
changes.

A `Note` is `{ start, len, freq, vel, bend, vib, trem, duty, arp, porta,
crush, echo, chorus, reverb }` (columns are in eighth-note units; `MICRO = 1/6`
eighth is the finest shared lattice, so triplet and straight subdivisions
never drift). A `Hit` is `{ start, type, vel? }` where `type` is one of
`RHYTHM_ROWS` and `vel` (0.1–1) is how hard it's struck; **absent means full**,
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
tracks/gains/waveform/pan/mute/solo (and resets automation/adsr) from
whatever `trackList`+`tracks` are present, tolerating old files with no
`trackList` by inferring tonal tracks from the data's keys; `applySavedMix()`
then overlays gains/waveform/pan/mute/solo/markers/automation/adsr and the
four `TRACK_FX_REGISTRY`-driven groups (fxSend/comp/crush/tremolo — see B.6)
from the loaded data where present, validating each field's shape/range.
`cols` is clamped to `[1 bar, MAX_COLS=576]`; if absent, it's derived from
the last note/hit's end, rounded up to a whole bar.

A separate **code-export** path (`⤓ Export`) serializes only
`TRACKS`/`RHYTHM_TRACKS` JS literals matching `js/song-data.js`'s shape, for
pasting back into the originating game — `songName`, `markers`,
`automation`, `adsr`, and all four FX-panel groups have no representation in
that format and are intentionally excluded from it (the game's own audio
engine doesn't read them).

### B.4 Rendering pipeline

```
render()
 ├─ renderTimeline()      → ruler cells, bar numbers, renderMarkers()
 ├─ renderTracks()        → per state.trackList entry:
 │    ├─ renderPitchTrack(id) | renderRhythmTrack(id)
 │    │    └─ buildHeader(id) → ...; if (fxSendOpen.has(id)) appends
 │    │         buildFxPanel(id) in place (not a separate row — see A.7)
 │    ├─ renderAutomationRow(id, param)   if automationOpen.has(id)
 │    └─ renderAdsrRow(id)                if adsrOpen.has(id)
 ├─ positionOverlays()    → updateOverlayHeights(), updatePlayheadPositions(),
 │                          updateLoopPositions(), updateHScroll()
 ├─ renderInspector()     → selected-note effect controls, or empty state
 ├─ updateSongInfo()      → ☰ menu's Tempo/Meter/Length/Track-count text
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

Unlike Automation and Envelope, the ✨ FX panel (`buildFxPanel()`) needs no
timeline-column width — every field in it is a static per-track knob — so
it's built straight into `buildHeader()`'s own left-column header instead
of being appended as a sibling `.track` row; toggling it open/closed just
changes that header's height, not the row count `renderTracks()` iterates.

Two independent `requestAnimationFrame` loops run during playback:
`animatePlayhead()` (repositions the playhead and updates the Bars|Beats
counter — via `textContent` on persistent span elements, not an `innerHTML`
rebuild, since only the numbers change) and the VU-meter loop (throttled to
~30fps — a level meter doesn't need 60Hz to read as smooth, and the
per-channel `AnalyserNode` read is the one per-frame cost that scales with
track count).

### B.5 Interaction state machines

Mouse-driven editing is implemented as manual `mousedown` → `document`-level
`mousemove`/`mouseup` state machines (no drag library):
`startMoveNote`/`startResize`/`startMoveHit` (drag/resize existing
notes/hits), `startMarquee` (rubber-band multi-select), `startScrub`
(playhead), `startLoopDrag` (loop-range handles), `startAutomationDrag`
(automation curve points, generic across all five automatable parameters).
Each captures whatever it needs at gesture start (bounding rects, clamping
bounds from neighboring points/notes), applies `scheduleRender()` during
`mousemove`, and commits with a synchronous `render()` + `autosave()` on
`mouseup`. A drag that produces no net change (e.g., a plain click on an
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
(`nudgeSelection`), pasting (`pasteClipboard`) and the Chord buttons
(`addChordAbove`). That centralisation is load-bearing rather than cosmetic:
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
  attack+decay+release would exceed the note's own duration) → optionally a
  bitcrush `WaveShaperNode` → `chanGain[track]`, with echo/reverb aux sends
  if `note.echo`/`note.reverb` (these are separate, per-track, always-on-if-
  toggled loops — distinct from the continuous Delay/Chorus/Reverb sends in
  A.7, which tap further downstream and apply to the whole track uniformly).
  Vibrato/tremolo are LFOs modulating frequency/gain; bend is a
  `linearRampToValueAtTime` mid-note; arpeggio steps the frequency every
  30ms through the chord tones; chorus adds a second, detuned oscillator
  into the same gain node; portamento glides the oscillator frequency into
  the next contiguous note instead of retriggering. **Voice pooling**
  (`acquireVoice()`, `VOICE_POOL_SIZE = 16` per channel) reuses a fixed pool
  of filter+gain+echoSend+reverbSend node sets across notes instead of
  building fresh ones each time — bitcrushed notes are excluded (their
  `WaveShaperNode.curve` can't be safely reused for a future-scheduled note)
  and get an ad-hoc node set instead.
- **Per-track insert chain** (`chanGain[id] → chanEq[id] → chanComp[id] → chanCrush[id]? →
  chanTremolo[id]`, built by `buildChannelChain()`): a `DynamicsCompressorNode`
  (`createChanComp()`), an optional bitcrush `AudioWorkletNode` reusing the
  master bus's own downsample processor (`ensureTrackCrusher()` — same
  bypass-then-upgrade pattern as the master `ensureCrusher()`, one instance
  per track), and a tremolo `GainNode` whose own `.gain` `AudioParam` is
  modulated by an LFO (`createChanTremolo()`). `chanTremolo[id]` is the
  fixed downstream anchor that `chanPan[id]`, the VU meter, and the three FX
  sends all connect from, so a bitcrushed/tremolo'd track's pan, meter, and
  sends all reflect the final processed signal. All four (Delay/Chorus/
  Reverb send, EQ, Compressor, Bitcrush, Tremolo) share one state-shape/UI
  registry, `TRACK_FX_REGISTRY` (get/set/apply functions plus each field's
  range/format/clamp-on-load rules per group) — both `applySavedMix()`
  (Song I/O load/validate) and `buildFxPanel()` (A.7's UI) iterate this one
  table instead of four hand-written near-duplicate blocks; the underlying
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
- **The track's voice**: the five things a track contributes to a note's sound
  — ADSR, filter, FM, vibrato and the `square` pulse-width default — are
  gathered by `getTrackVoice(track)` into one object that
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
- **Rhythm**: each hit type is a small dedicated synthesis function
  (`scheduleKick`/`scheduleSnare`/`scheduleRim`/`scheduleHihat`/
  `scheduleOpenHat`/`scheduleShaker`/`schedulePuka`(tom)/`scheduleClap`/
  `scheduleCrash`/`scheduleRide`) — filtered noise bursts and/or short
  pitch-swept oscillators, no shared "drum" abstraction since each sound's
  shape is bespoke. They are all reached through one dispatch point,
  `scheduleDrum(type, startAt, destGain, vel)`, used by playback, the
  click-to-place preview and the pattern auditions alike. That is also where
  per-hit **velocity** is applied — as a plain `GainNode` in front of the
  destination, deliberately *not* as an argument threaded into the ten
  functions: each hand-writes its own multi-stage envelope (the snare has two,
  the clap three), so scaling every `exponentialRampToValueAtTime` by hand
  would be ten chances for the same factor to drift. At full velocity no node
  is inserted at all, so an untouched song builds the identical graph it built
  before hits had a velocity — which matters when an offline render schedules
  thousands of them. Each rhythm track routes to its own `chanGain[id]`, so
  multiple rhythm tracks mix, pan, and get FX-processed independently.
- **Seeded noise**: the reverb impulse (`ensureReverbImpulse()`) and the two
  drum noise buffers (`ensureNoiseBuffer()` for hi-hat/snare/rim/shaker,
  `ensureCrashNoiseBuffer()` for crash/open-hat/ride) are filled from
  `mulberry32()` streams with fixed seeds, not `Math.random()`. They used to be
  random per page load, so the reverb tail and every noise-based drum sounded
  slightly different on every reload, and a song's true peak wandered about a
  decibel between renders — enough that measuring headroom took several passes
  to trust. **This does not make a render byte-reproducible**, and the buffers
  were never the only source: two exports of the same song still differ, even
  within one page load. See TODO.md for what that investigation ruled out.
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
  (`js/downsample-processor.js`) → `destination`.
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
nodes for any track added/removed by the undo and reapplies all four
`TRACK_FX_REGISTRY` groups.

### B.8 Persistence & Song I/O

- **Autosave**: every `render()` schedules a debounced (400ms) `localStorage`
  write of the full `currentSongData()`-shaped payload under a fixed key,
  purely as a crash-recovery safety net. It is **write-only** — never read
  back automatically. The page always boots into a blank project (just a
  Rhythm track; the `state` object's own initial literal, not seeded from
  any saved data), so song selection always goes through the explicit 🎵
  Songs menu (A.11) rather than a reload-time prompt.
- **Local songs**: named saves under a second `localStorage` key, an
  object keyed by name; listed/loaded/deleted from the Songs dialog.
- **File save/load**: `💾` downloads `currentSongData()` as a `.json` file
  (name slugified from the song name); `📂` reads a dropped/selected file
  through the same `applySongData()` path as everything else.
- **Examples**: `songs/index.json` lists `{ file, name, desc }`; each
  example is fetched and applied the same way, with the display name
  overridden from the index entry (not the file's own `songName`, so
  renaming a local copy doesn't affect the example's library listing).
- **MIDI**: 🎹/🎼 export/import a Standard MIDI File (format 1, own SMF
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

### B.9 File & module map

| File | Role |
|---|---|
| `index.html` | The entire application — markup, CSS, and the single `<script type="module">` covering state, rendering, interaction, synthesis, and I/O. |
| `js/song-data.js` | `TRACKS`/`RHYTHM_TRACKS`/`TEMPO_BPM` — the demo song's note data, in the same shape the code-export path produces; `index.html` only imports `TEMPO_BPM` from it (a fallback used in a couple of places) — the full demo song is loaded only via the 🎵 Songs menu's "Froggy Hop" example. The only other JS module besides `js/downsample-processor.js`. |
| `js/downsample-processor.js` | The shared `AudioWorkletProcessor` behind the master bus's Downsample control and every per-track Bitcrush insert (A.7, A.10) — a sample-and-hold lo-fi downsampler. |
| `songs/*.json` + `songs/index.json` | Bundled example songs and their Songs-dialog listing. |
| `dev-server.js` | Dependency-free static file server, used for local development and by `verify.js`; stays plain (no auto-open) since it also runs headlessly. |
| `dev.js` | Wraps `dev-server.js` for interactive use — spawns it, polls until it responds, then opens it in the default browser. |
| `start.cmd` | Windows double-click entry point — checks `node` is on `PATH`, then runs `node dev.js`. |
| `verify.js` | A permanent, dependency-free headless-browser smoke test — drives the app over the Chrome DevTools Protocol (`WebSocket` + JSON-RPC, Node built-ins only) through a handful of core interactions and fails on any wrong expectation or console error/exception. Not a full test suite; a reusable regression check. |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA installability and offline caching. |
| `.github/workflows/pages.yml` | Deploys the repo root to GitHub Pages on push to `main`. |
