# 🎵 Music Studio

Try it: https://ruperto72.github.io/music-studio/

A browser-based **8-bit chiptune editor**. Compose looping tracks the way you
would in a small studio (Pro Tools–style stacked lanes) — everything is
synthesised live with the Web Audio API, so there are **no audio files and no
dependencies**. It's a single self-contained `index.html` plus a small song-data
module.

It was extracted from the [Frog vs Toad](https://github.com/Ruperto72/frogger-multiplayer)
game, whose soundtrack ships here as the **demo song**.

## Features

- Stacked **tracks** with a shared timeline and playhead
- **Add / rename / remove** tonal tracks (Rhythm is a fixed drum kit)
- Per-track **waveform** (square / triangle / saw / sine), **pan**, **volume**, **mute/solo** and a live **VU meter**
- Per-note **velocity** and effects: bend, vibrato, tremolo, pulse width (duty), arpeggio, portamento, bitcrush, echo, chorus
- Selectable **grid** resolution — 1/4, 1/8, 1/16 and triplets
- **Time signature** (4/4, 3/4, 6/8, …) and named **timeline markers**
- **Loop** range, zoom, multi-select, copy/paste, undo/redo
- **Song library** — load examples or your own saved songs (see below)
- **Export** the current song as `TRACKS` / `RHYTHM_TRACK` JS to drop into a game
- **Installable PWA** — works offline once loaded, and can be added to the
  home screen as a standalone/fullscreen app (Android and other browsers
  that support the install prompt); a **⛶** toolbar button also toggles
  plain browser fullscreen

## Roadmap

Planned audio-engine work, roughly in order of effort (see `TODO.md` for the
full breakdown and the specific Web Audio API interfaces each item builds
on — `AudioWorklet`, `ConvolverNode`, `PeriodicWave`, `AnalyserNode`, and so on):

1. **Quality basics** — 48 kHz export, voice pooling, simple wavetable synthesis
2. **Pro synthesis** — FM synthesis, a resonant filter per track, aux-sends for reverb/delay
3. **Pro mixing** — custom DSP via AudioWorklet, a spectrum analyzer + LUFS metering, parallel compression, sidechain
4. **Sampling & collaboration** — sample playback/granular synthesis, cloud sync and live collaboration

## Run it locally

No build step. Serve the folder over http:// (ES modules don't work from
`file://`):

```bash
node dev-server.js        # then open http://localhost:8080
```

Any static server works too, e.g. `python3 -m http.server 8080`.

## Songs: examples vs. your own

- **Examples** live in `songs/` and are listed in `songs/index.json`. They load
  over the network (from this site) via the **🎵 Songs** menu.
- **Your songs** are saved in the browser's `localStorage` — nothing is
  uploaded. Use **🎵 Songs → Save current** to store the current song under a
  name, and Load/Delete them from the same menu.
- **💾 / 📂** in the toolbar download/upload a song as a `.json` file.

### Add an example song

1. In the editor, build a song and click **💾** to download its `.json`.
2. Drop the file into `songs/` (e.g. `songs/my-tune.json`).
3. Add an entry to `songs/index.json`:
   ```json
   { "file": "my-tune.json", "name": "My Tune", "desc": "One-line description." }
   ```

The included examples are `froggy-hop.json` (the game demo), `cinematic.json`
and `techno.json`.

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
index.html            the editor (self-contained: HTML + CSS + JS + synthesis)
js/song-data.js       the demo song's note data (TRACKS, RHYTHM_TRACK, TEMPO_BPM)
songs/                example songs + index.json
manifest.webmanifest  PWA manifest (name, icons, display mode)
sw.js                 service worker: offline cache for the app shell
icons/                generated app icons (see manifest.webmanifest)
dev-server.js         tiny static server for local use
```
