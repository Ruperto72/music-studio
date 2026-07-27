# 🎵 Web Audio Studio

Try it: https://ruperto72.github.io/music-studio/

A browser-based **8-bit chiptune editor**. Compose looping tracks the way you
would in a small studio (Pro Tools–style stacked lanes) — everything is
synthesised live with the Web Audio API, so there are **no audio files and no
dependencies**. It's a single self-contained `index.html` plus a small song-data
module.

It was extracted from the [Frog vs Toad](https://github.com/Ruperto72/frogger-multiplayer)
game, whose soundtrack ships here as the **Froggy Hop** example song.

## Features

### Composing

- Stacked **tracks** with a shared timeline and playhead
- **Add / rename / remove / reorder** tonal tracks, plus one or more **rhythm**
  tracks sharing a fixed 10-piece kit (kick, snare, rim, hi-hat, open hat,
  shaker, tom, clap, crash, ride)
- **Pen / Eraser / Grab** tools; drag to move, drag the right edge to resize,
  drag empty space to marquee-select
- **Chords** — place several pitches in one column, or build a triad from a
  selected note with **Add Major / Minor Chord**
- Selectable **grid** resolution (1/4, 1/8, 1/16 and triplets) and a **swing**
  control for a shuffled 8th feel
- **Time signature** (4/4, 3/4, 6/8, …) and named **timeline markers**
- **Loop** range, zoom, multi-select, copy/paste, undo/redo
- Built-in **rhythm patterns** (Rock, Techno, Disco, Swing, Hip-Hop, House,
  Breakbeat) you can audition and stamp into a rhythm track

### Sound design

- Per-track **waveform** — square, triangle, saw, sine, an **NES triangle**
  wavetable, and **FM** (with modulator ratio/depth)
- Per-track **ADSR envelope** and a resonant **lowpass filter** with its own
  envelope amount; save any track's synth settings as a reusable **preset**
- Per-track **✨ FX**: continuous Delay / Chorus / Reverb sends, a 3-band
  **EQ**, a **compressor**, a **bitcrush** downsampler, a **tremolo**, and a
  **vibrato** on tonal tracks — all neutral by default
- Per-note effects: velocity, bend, vibrato, tremolo, pulse width (duty),
  arpeggio, portamento, bitcrush, echo, chorus and reverb
- **Per-hit velocity** on rhythm tracks — click a drum hit to set how hard
  it's struck, so a pattern can have accents instead of sounding mechanical;
  quieter notes and hits are drawn dimmer
- **Automation curves** per track — draw Volume, Pan, or Delay/Chorus/Reverb
  send over time
- **Master bus**: 3-band EQ, compressor with a parallel ("New York") blend,
  kick/snare **sidechain** ducking, a lo-fi downsampler, and a live spectrum
  plus approximate LUFS meter

### Saving & exporting

- **Song library** — bundled examples or your own songs saved in this browser
- **💾 / 📂** download/upload a song as `.json`
- **🎹 / 🎼** export/import a Standard MIDI File (format 1)
- **🔊** render the whole song offline and download a `.wav`
- **⤓** export the song as `TRACKS` / `RHYTHM_TRACKS` JS literals to drop into
  a game
- **Keyboard & screen reader**: Tab reaches every control with a visible focus
  ring, Shift+←/→ walks the notes of a track and Home/End jump to its ends,
  with each selection announced as pitch and bar/beat
- **Installable PWA** — works offline once loaded, and can be added to the
  home screen as a standalone/fullscreen app; a **⛶** toolbar button also
  toggles plain browser fullscreen

## Roadmap

Most of the original audio-engine roadmap is now built — voice pooling,
wavetable synthesis, FM, a per-track resonant filter, aux sends for
reverb/delay, custom DSP via `AudioWorklet`, spectrum + LUFS metering,
parallel compression and sidechain ducking all ship today.

Still open (see `TODO.md` for the full breakdown):

- **Sampling** — sample playback and granular synthesis
- **Collaboration** — cloud sync and live multi-user editing
- **Accessibility** — the grid is now labelled and keyboard-navigable, but
  notes still can't be *created* without a pointer

## Run it locally

No build step, nothing to install. Serve the folder over http:// (ES modules
don't work from `file://`):

```bash
node dev.js               # starts the server and opens a browser
node dev-server.js        # server only — then open http://localhost:8080
```

On Windows you can double-click `start.cmd` instead of opening a terminal.
Any static server works too, e.g. `python3 -m http.server 8080`.

There's no build or lint step and no test framework. The closest thing to a
test command is:

```bash
node verify.js            # headless-browser smoke test
```

It starts its own server, drives the app through a set of core interactions in
a real headless Chromium over the Chrome DevTools Protocol, and fails if any
expectation is wrong *or* if the page logs a console error at any point. It
needs a Chromium-family browser on the machine (`CHROME_PATH=…` to point at a
specific one).

## Songs: examples vs. your own

- **Examples** live in `songs/` and are listed in `songs/index.json`. They load
  over the network (from this site) via the **🎵 Songs** menu.
- **Your songs** are saved in the browser's `localStorage` — nothing is
  uploaded. Use **🎵 Songs → Save current** to store the current song under a
  name, and Load/Delete them from the same menu.
- **💾 / 📂** in the toolbar download/upload a song as a `.json` file.

The page always starts as a blank project; pick a song explicitly from the
**🎵 Songs** menu. Work is autosaved to this browser in the background purely
as crash recovery — it's never restored automatically.

### Add an example song

1. In the editor, build a song and click **💾** to download its `.json`.
2. Drop the file into `songs/` (e.g. `songs/my-tune.json`).
3. Add an entry to `songs/index.json`:
   ```json
   { "file": "my-tune.json", "name": "My Tune", "desc": "One-line description." }
   ```
4. Bump `CACHE_NAME` in `sw.js` so installed clients pick up the change.

The bundled examples are `froggy-hop.json` (the game demo), `cinematic.json`,
`techno.json`, `neon-drive.json`, `popcorn.json`, `space-miner.json` and
`neon-cathedral.json`.

## Deploy to GitHub Pages

The site is fully static. A ready-to-use workflow lives at
`.github/workflows/pages.yml`; once this folder is the root of its own repo:

1. Push to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**

The workflow publishes the whole folder, so the examples load from the same
origin. (`.nojekyll` is included so Pages serves the files as-is.)

## Installing on Android

This is a [Progressive Web App](https://web.dev/progressive-web-apps/): open
the site in Chrome on Android, then use the browser menu's **Add to Home
screen** / **Install app** option (Chrome may also prompt automatically). The
installed app opens without browser chrome and keeps working offline once
it's been loaded once, since `sw.js` precaches the app shell and the bundled
example songs. `manifest.webmanifest` requests fullscreen display where the
browser supports it (falling back to a standalone app window otherwise); the
in-app **⛶** button toggles fullscreen for regular browser tabs too.

## Layout

```
index.html                  the editor (self-contained: HTML + CSS + JS + synthesis)
js/song-data.js             the demo song's note data (TRACKS, RHYTHM_TRACKS, TEMPO_BPM)
js/downsample-processor.js  AudioWorklet behind the master and per-track bitcrush
songs/                      example songs + index.json
manifest.webmanifest        PWA manifest (name, icons, display mode)
sw.js                       service worker: offline cache for the app shell
icons/                      generated app icons (see manifest.webmanifest)
dev-server.js               tiny static server for local use
dev.js                      starts dev-server.js and opens a browser
start.cmd                   Windows double-click entry point
verify.js                   headless-browser smoke test
docs/                       design notes and implementation plans
```

For a deeper tour, `DESIGN.md` specifies the GUI and the internal architecture,
`CLAUDE.md` is a shorter orientation for editing the code, and `TODO.md` tracks
what's deliberately not built yet.
