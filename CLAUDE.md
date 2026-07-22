# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Music Studio — a browser-based 8-bit chiptune editor. Everything is synthesised live with the Web Audio API: no audio files, no dependencies, no build step. The entire app is a single self-contained `index.html` (HTML + CSS + JS in one file) plus a small song-data module.

It was extracted from the [Frog vs Toad](https://github.com/Ruperto72/frogger-multiplayer) game; that game's soundtrack ships here as the demo song.

## Commands

```bash
node dev-server.js        # serve the repo root at http://localhost:8080
```

Any static file server works (e.g. `python3 -m http.server 8080`) — a server is required because ES modules don't load from `file://`. There is no build, lint, or test command; there are no dependencies to install.

## Architecture

- **`index.html`** — the entire application (~3800 lines) inside a single `<script type="module">`. There is no component framework and no bundler; everything is plain DOM manipulation (`createElement`, `addEventListener`) driven by a central `state` object and a `render()` function that rebuilds the DOM from state. Treat this file as several logical sections rather than a list of functions:
  - **State & song model** — `state` holds tracks, notes/hits, selection, playhead, loop range, grid, tempo, mix (gain/pan/mute/solo), per-track automation curves, per-track ADSR envelopes, history stack, etc. Tonal tracks store notes as `{start, dur, ...}`-style objects; rhythm tracks store hits (10 types: kick/snare/rim/hihat/openhat/shaker/tom/clap/crash/ride, `RHYTHM_ROWS`). There can be more than one rhythm track — all share the same fixed 10-piece kit, always stay grouped after every tonal track (`RHYTHM_TRACK_IDS`, mirroring `PITCH_TRACKS`), and at least one always exists. Helper functions like `toColumnNotes`/`fromColumnNotes` and `toColumnHits`/`fromColumnHits` convert between the internal sequence format and the grid-column representation used for editing.
  - **Autosave / undo / history** — `autosave()`/`loadAutosaveIfPresent()` persist the current song to `localStorage`; `commitHistory()`/`undo()`/`redo()` maintain an in-memory snapshot stack (`snapshotSong()`/`restoreSnapshot()`).
  - **Rendering** — `render()` is the single entry point that redraws tracks, timeline, markers, playhead, loop handles, scrollbar, and the Song info panel. Track lanes are rebuilt per-render (`renderTracks`, `renderPitchTrack`, `renderRhythmTrack`), with an optional extra automation-curve row (`renderAutomationRow`) or ADSR-envelope row (`renderAdsrRow`) per track when its panel is toggled open; there is no virtual DOM or diffing.
  - **Interaction** — mouse-driven note/hit placement, drag-move, resize, marquee-select, and multi-select are implemented as manual `mousedown`/`mousemove`/`mouseup` state machines (e.g. `startMoveNote`, `startResize`, `startMarquee`, `startScrub`, `startLoopDrag`, `startAutomationDrag`).
  - **Audio synthesis** — a Web Audio graph is built per note (`OscillatorNode`/`GainNode`, plus a `WaveShaperNode` for bitcrush via `bitcrushCurve()`, and a duplicate detuned oscillator for chorus). Per-note effects (bend, vibrato, tremolo, duty/pulse-width, arpeggio, portamento, bitcrush, echo, chorus) are applied at playback time from properties on the note object itself, not from separate effect tracks. Each track's ADSR envelope (`applyAdsrEnvelope()`) shapes the note's gain; each track's volume/pan automation curve (`state.automation`) is scheduled as native `AudioParam` ramps once per playback chunk (`scheduleAutomationForChunk()`), independent of note-level effects. All channels sum into `masterGain`, which then runs through a song-global 3-band EQ + `DynamicsCompressorNode` (`buildMasterFXChain()`/`applyMasterFX()`, `state.masterEQ`/`state.masterComp`, editable via the 🎛️ panel in the master strip) before `ctx.destination`; defaults are fully neutral (0dB, ratio 1:1) so this is a no-op unless a song explicitly sets it.
  - **Song I/O** — the 🎵 Songs menu loads examples from `songs/` (network fetch) or user songs from `localStorage`; 💾/📂 in the toolbar export/import a song as a `.json` file. A separate "export as code" path serializes the current song into `TRACKS`/`RHYTHM_TRACKS` JS literals (matching `js/song-data.js`'s shape) for embedding back into a game — automation/ADSR/markers/song name aren't representable in that format and are intentionally left out of it. 🎹/🎼 export/import a Standard MIDI File (format 1, own SMF writer/parser, no library — `exportMidiBytes()`/`parseMidiFile()`); per-note effects have no MIDI equivalent and aren't round-tripped, and MIDI import merges all channel-9 (drum) events in a file into the song's first rhythm track. 🔊 renders the whole song offline (`OfflineAudioContext`, same synthesis path as playback — `renderSongToWav()`) and downloads a `.wav`; MP3 was deliberately left out to keep the app dependency-free.
- **`js/song-data.js`** — exports `TRACKS`, `RHYTHM_TRACKS`, `TEMPO_BPM`: the demo song's note data, imported by `index.html` as the default song on load. This is the same data shape songs are exported to/from.
- **`songs/`** — example songs as JSON (`froggy-hop.json`, `cinematic.json`, `techno.json`, `neon-drive.json`) plus `index.json`, which lists `{file, name, desc}` entries consumed by the in-app Songs menu. Adding an example song means dropping a `.json` file here and adding an entry to `index.json`.
- **`dev-server.js`** — a dependency-free static file server (Node `http`/`fs`) used only for local development.
- **`manifest.webmanifest` / `sw.js` / `icons/`** — PWA support: the manifest (linked from `index.html`'s `<head>`) makes the site installable (Android "Add to Home screen", `display_override: ["fullscreen", "standalone"]`); `sw.js` precaches the app shell (index.html, song-data.js, bundled songs, icons) for offline use and is registered from the bottom of `index.html`'s script. Bump `CACHE_NAME` in `sw.js` when precached files change so installed clients pick up the update. Icons were generated with a one-off Node script (not checked in) using a plain PNG encoder — regenerate similarly if they ever need to change.
- **`.github/workflows/pages.yml`** — deploys the whole repo root to GitHub Pages via GitHub Actions on push to `main` (`.nojekyll` ensures files are served as-is).

## Working in `index.html`

Since the whole app lives in one file with no module boundaries beyond `song-data.js`, most changes require understanding how `state` flows into `render()` — mutate `state`, then call `render()` (and usually `autosave()`) rather than patching the DOM directly. Grid/timing math (`snapToGrid`, `quant`, `eighthsPerBar`/`eighthsPerBeat`, `clampCols`) is centralized near the top of the script and used throughout rendering and interaction code — reuse it instead of re-deriving column/pixel conversions locally.
