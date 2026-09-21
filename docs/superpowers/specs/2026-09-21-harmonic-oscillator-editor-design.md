# Harmonic (additive) oscillator editor

## Problem

Every tonal track picks one of thirteen fixed waveforms (`WAVEFORMS`,
index.html:1959) — the shape is a formula baked into `setOscWave()`
(index.html:10822) or `createVoiceSource()` (index.html:11166). There is no
way to dial in a waveform the app doesn't already ship: whatever timbre you
want has to already be one of the thirteen rows, or be approximated with FM/
filter/duty. The user wants to shape a track's own harmonic content directly
— amplitude and phase per partial — rather than being limited to the built-in
set.

Three of the existing wavetables (`nestri`, `sawtri`, `halfsine`) already
prove the mechanism: a one-cycle sample array run through `dftToPeriodicWave()`
(index.html:10373) into a `PeriodicWave`. This feature goes the other
direction — the user supplies the frequency-domain data (amplitude + phase
per harmonic) directly, so no DFT is needed, only `ctx.createPeriodicWave()`
itself.

## 1. Data model

### `state.harmonics`

New sparse per-track map, added to `SPARSE_TRACK_MAPS` (index.html:3325) so
save/load/undo/track-removal/`autosave()` all pick it up through the existing
shared loop:

```js
state.harmonics[track] = {
  amps:   [1, 0, 0, 0, 0, 0, 0, 0], // harmonics 1..8, each 0..1
  phases: [0, 0, 0, 0, 0, 0, 0, 0], // degrees, 0..360, wraps
};
```

`DEFAULT_HARMONICS` is a plain sine (fundamental at full amplitude, phase 0,
every other harmonic silent) — **absent means default**, the same rule every
other sparse map follows, so a song saved before this feature existed loads
identically. Fixed length 8 (not dynamic) per the earlier decision to keep
this one table-sized control surface rather than an open-ended list.

Tonal-track only, and **track-level, not per-note** — the same scope FM's
ratio/depth and hard sync's sweep already have (`state.fm`, `state.sync`),
not the wider per-note override `duty` gets. Sixteen values are too many to
reasonably override per note, and nothing else in the note inspector works at
that resolution.

`getHarmonicsState(track)` / `setHarmonicAmp(track, i, v)` /
`setHarmonicPhase(track, i, v)` follow the existing accessor pattern
(`getFmState`/`setFmState` at index.html:3837). The two setters clone the
relevant array and replace `state.harmonics[track]` with a new object rather
than mutating in place — this is what lets the audio-engine cache (§2)
invalidate itself for free. A third helper, `setHarmonicsState(track,
{amps, phases})`, replaces both arrays at once for the whole-object cases
(preset load, quick-start buttons) rather than sixteen individual calls.

### New waveform id

`'harmonics'` added to `WAVEFORMS` and `WAVE_LABEL` (`'Harmonics'`,
index.html:1959-1960). `buildFloatingOscMenu()` (index.html:5741) iterates
`WAVEFORMS` generically and calls `glyph(w)`, so the picker needs nothing
beyond the array entry, the label, and a new `GLYPHS.harmonics` glyph — a row
of bars at varying heights (drawbar-style), since unlike every other waveform
this one has no fixed shape to draw; it's the one glyph in the set that
represents "user-defined" rather than a specific curve.

## 2. Audio engine

### Voice plumbing

`DEFAULT_VOICE` and `getTrackVoice()` (index.html:10804) gain a `harmonics`
field, exactly how `sync` was added — `harmonics: getHarmonicsState(track)`.
`createVoiceSource(oscType, duty, freq, fm, sweepLfo, sync, harmonics)` gets a
seventh parameter, threaded from its four call sites (`scheduleTone`'s main
voice and its chorus double, `schedulePortamentoTone`, and wherever else
`voice.sync` is currently passed) the same way `voice.sync` already is.

`setOscWave(osc, oscType, duty, harmonics)` (index.html:10822) gets one more
branch:

```js
else if (oscType === 'harmonics') osc.setPeriodicWave(getHarmonicsWave(harmonics));
```

placed alongside the existing `nestri`/`sawtri`/`halfsine` branches, which is
the natural home since all four end in the same `setPeriodicWave()` call.

### Building and caching the wave

```js
let harmonicsWaveCache = new WeakMap(); // settings object -> PeriodicWave
function getHarmonicsWave(hs) {
  if (harmonicsWaveCache.has(hs)) return harmonicsWaveCache.get(hs);
  const n = hs.amps.length;
  const real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    const a = hs.amps[k - 1], rad = hs.phases[k - 1] * Math.PI / 180;
    real[k] = a * Math.cos(rad);
    imag[k] = -a * Math.sin(rad); // sign convention matches dftToPeriodicWave()
  }
  const wave = ctx.createPeriodicWave(real, imag);
  harmonicsWaveCache.set(hs, wave);
  return wave;
}
```

Keying the cache on the settings object itself (not the track id) means an
edit — which always replaces `state.harmonics[track]` with a new object,
per §1 — is a cache miss handled for free, with no manual invalidation logic
to write or forget. `createPeriodicWave()` normalizes to unit peak by
default (per the Web Audio spec — same as every other `PeriodicWave` this
codebase already builds), so cranking every harmonic to maximum doesn't
produce a hot signal; no separate gain-staging is needed.

`resetAudioCaches()` (index.html:10645) gets one more line —
`harmonicsWaveCache = new WeakMap();` — alongside `nesTriWave = null` etc.,
since a `PeriodicWave` is tied to the `AudioContext` that built it and can't
survive a context swap (the comment already on that function explains why for
the existing caches; this is the same constraint). Note in passing:
`sawTriWave` is conspicuously **not** reset there today — a pre-existing gap,
not something this feature needs to fix, but worth a one-line note since it's
directly adjacent to the code this feature touches.

## 3. UI

### Panel

Lives in the same row `renderAdsrRow()` (index.html:5152) already builds for
the other waveform-specific groups — the `if (state.waveform[track] ===
'fm' || ... )` block at index.html:5305 gets a fourth arm,
`state.waveform[track] === 'harmonics'`, following the exact structural
pattern the FM/Sync group uses: an `mfx-group` with an `mfx-cap` caption
("Harmonics"), `adsr-field` rows each holding a `<input type=range>` +
label + live value text, `accentColor` set to `trackColor(track)`,
`mousedown` stopping propagation, and `input` writing through
`setHarmonicAmp`/`setHarmonicPhase` + `autosave()`. The row title logic at
index.html:5158-5160 (`'Envelope, Filter & FM'` etc.) gets a matching
`'Envelope, Filter & Harmonics'` case.

Sixteen sliders (8 amplitude 0–1, 8 phase 0–360°) is more than the existing
groups hold, so they're laid out paired — amplitude above phase, one column
per harmonic, labelled H1–H8 — rather than as one flat row; this is a CSS/
layout detail for the implementation pass, not an architectural one.

### Quick-start buttons

Four buttons (Sine, Saw, Square, Triangle) above the sliders, each computing
that waveform's classical partial series into the 8 amplitude/phase pairs —
the same "start from something recognizable, then dial in" pattern the
Arpeggio quick-fill buttons already use (CLAUDE.md's Interaction section).
Amplitude/phase is a polar representation (magnitude ≥ 0, phase carries the
sign and any offset), which is exactly why phase exists as its own control
per the earlier decision to expose it alongside amplitude — a Fourier
coefficient that's conventionally negative is simply amplitude `|a|` at
phase 180°, not a negative amplitude value:

- **Sine**: harmonic 1 at amplitude 1, phase 0; everything else silent
  (`DEFAULT_HARMONICS`).
- **Saw**: every harmonic n=1..8 at amplitude `1/n`, phase alternating 0°/180°
  per harmonic (the sign flip in a sawtooth's series).
- **Square**: odd harmonics only (even ones silent) at amplitude `1/n`,
  phase 0.
- **Triangle**: odd harmonics only at amplitude `1/n²`, phase alternating
  0°/180° every other odd harmonic.

### Live preview

A small `<canvas>` in the group, redrawn on every slider `input` event:
sums the same 8 sine terms the `PeriodicWave` itself is built from (`y(t) =
Σ amps[k]·sin(2π(k+1)t + phases[k])`, one cycle, ~128 points), auto-scaled to
fit the canvas height. Cheap — 8 terms × ~128 points is nothing — and because
it uses the identical formula `getHarmonicsWave()` does, what's drawn tracks
what's heard (modulo the engine's own unit-peak normalization, which only
rescales the vertical scale, not the shape).

## 4. Presets

`BUILTIN_PRESETS` entries (index.html:9293) and `applyPresetToTrack()`
(index.html:9381) gain a sixth optional field, `harmonics`, applied the same
conditional way `fm`/`filter`/`adsr` already are:

```js
if (preset.harmonics) setHarmonicsState(track, preset.harmonics);
```

(`setHarmonicsState` here being a convenience wrapper over the two per-index
setters, for the whole-object case a preset load needs.) The "save current
track as a preset" path, which builds a preset object from a track's live
settings, adds `harmonics: getHarmonicsState(track)` alongside its existing
fields. No new `BUILTIN_PRESETS` rows are required by this feature.

## 5. Serialization / validation

Follows the standard `SPARSE_TRACK_MAPS` path — no new call sites to
hand-edit for save, load, undo snapshots, or track removal.
`applySavedMix()` gets a validation/clamp block for `harmonics` matching the
shape the others already have: array length exactly 8 for both `amps` and
`phases`, amplitude clamped 0..1, phase clamped/wrapped 0..360, dropped
entirely (not partially accepted) if the shape doesn't match — same
"drop the whole entry rather than half-apply it" rule the existing checks
follow.

`verify.js`'s `auditBundledSongs()` step extracts its expected shapes from
`index.html` rather than hand-duplicating them (per CLAUDE.md's note that
"extraction that stops matching throws instead of returning an empty list");
it needs to learn the `harmonics` field's shape the same way it already knows
the other nine. No existing bundled song needs a data change — none has a
`harmonics` field yet, and absent-means-default covers that.

## 6. Testing

New `verify.js` step, scoped to one track (`.closest()`, per the two
established traps in CLAUDE.md's `verify.js` section):

- Switch a track to the Harmonics waveform → the panel's `mfx-group` appears,
  captioned "Harmonics", with 16 sliders and the four quick-start buttons.
- Click "Saw" → sliders update to the expected amplitude series; the preview
  canvas is present and non-blank (has drawn something).
- Drag one amplitude slider → `state.harmonics[track]` reflects the change,
  the live value text updates.
- Save and reload the song (or run it through `applySavedMix()` directly) →
  the harmonics setting round-trips unchanged.

## Out of scope

- More than 8 harmonics, or a variable/expandable count — fixed at 8 per the
  earlier decision; revisit only if it turns out to be a real limitation in
  practice, not a theoretical one.
- Per-note override of any harmonic value — track-level only, like FM/sync.
- Automating harmonic values over time (no entry added to
  `AUTOMATION_PARAMS`) — the automation row already covers volume/pan/sends;
  extending it to sixteen more parameters is a separate, much larger feature
  if it's ever wanted.
- Fixing the pre-existing `sawTriWave` cache-reset gap noted in §2 — flagged,
  not fixed, since it's unrelated to what this feature touches.
