# Changelog

What changed in each version of Web Audio Studio, for the people using it.
The version is `APP_VERSION` in `index.html`, the one printed at the foot of
the Help page, and each version is tagged in git as `vX.Y.Z`. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
reasoning, measurements and dead ends behind each change are in
[`DONE.md`](DONE.md).

## [1.6.3] – 2026-09-24

### Fixed
- Arrange → Move no longer stacks two hits on one column when a clip beside
  the moved section had material hidden under a trimmed window.
- A clip split in two inside a moved or duplicated section can be healed
  again afterwards.
- A gap in a split track is copied as a gap: the clip ringing across the
  destination no longer stretches over it.

## [1.6.2] – 2026-09-24

### Fixed
- Arrange → Move and Duplicate keep a section's clip boundaries and copy what
  a trimmed clip window hides. Move used to lose hidden material for good.

## [1.6.1] – 2026-09-24

### Fixed
- A second unsaved session no longer replaces the first: up to five are kept,
  each offered back in Songs → My songs.
- Closing the tab right after loading a song no longer brings back the edits
  you had just discarded.
- The empty My songs text points at Save in the menu.

## [1.6.0] – 2026-09-23

### Added
- Save (Ctrl+S) saves to My songs under the song's name.
- Unsaved work is never replaced silently: loading a song, New song and
  closing the tab ask first, and a session that ended unsaved is offered back
  as "Unsaved: name" at the top of My songs.
- The Chords dialog has its own key and scale pickers.
- Add track and Add rhythm track also sit under the last track.

### Changed
- The menu is grouped under headings: Song, Files, Notes, Arrangement,
  Tracks. My songs come before Examples, and file import/export is under
  Files.
- Timing, Transpose, Dynamics and Variation share one layout: what they act
  on, a shared control, then one block per action.
- "Monitor" is called Master volume again: it is saved with the song and
  applies to Export WAV.

## [1.5.2] – 2026-09-23

### Changed
- Chords and Patterns carry text, and Chords has its own icon.
- Every toggle uses one "on" colour; red is kept for Record and Arm.
- The Auto, Note and Env rows close with one small ✕, and the Vel button is
  called Note, after the lane it opens.
- In the bottom bar, Master volume is called Monitor, and In scale, Ghosts and
  Master FX have text labels. "Loop & Zoom" is "Loop, markers & zoom".
- The Inserts Reset button only shows when there are inserts.

### Fixed
- "Back to the player" no longer shows, doing nothing, in the desktop menu.
- The Env row's title lists Arpeggio.

## [1.5.1] – 2026-09-23

### Changed
- Note inspector: Pitch is one choice of how the pitch moves: None, Bend,
  Arpeggio or Glide. They always excluded each other but sat in two panels,
  so picking one could clear another out of sight.
- The on/off timbre toggles and a square track's Duty are gathered in a Sound
  group.
- Add chord is a button beside Delete.

## [1.5.0] – 2026-09-23

### Added
- Arrange → Move: put a section at the start or after another section in one
  step. The song keeps its length.

### Fixed
- Deleting the first or last section no longer leaves an automation curve
  flat on the other side of the cut.
- Duplicate no longer leaves a note droning under the whole copy when it rang
  across the insertion point.

## [1.4.5] – 2026-09-23

### Added
- Phone: "Back to the player" in the ☰ menu after "Open the editor anyway".
  Before, the only way back was clearing site data, which also deleted every
  saved song.

### Fixed
- On a narrow screen, a tool panel no longer slides under the note inspector.

## [1.4.4] – 2026-09-23

### Changed
- Timing, Transpose, Dynamics, Variation and Arrange open as panels beside the
  roll instead of modal dialogs, so you can select, apply and listen without
  closing them. Their "acts on …" line follows the selection.

## [1.4.3] – 2026-09-23

### Changed
- A song no longer needs a rhythm track: the last one can be removed, and a
  song without drums loads without growing an empty one. Cedar Nocturne's
  unused rhythm track is gone.
- Help covers swing, zoom, the pitch lane's mouse wheel and the missing
  shortcuts, corrects what had drifted, and groups the rest by task.

## [1.4.2] – 2026-09-23

### Added
- Help: "From idea to song", an eight-step walkthrough of the composing tools
  in order, with screenshots.

### Changed
- Help groups the composing tools by job: Writing with chords, Drum grooves,
  Arranging.

## [1.4.1] – 2026-09-22

### Fixed
- Chord naming: the sounding notes decide, so chords outside the key,
  pentatonic keys and inversions are named right (E-G-C is C).
- Undoing an Arrange edit restores the markers too.
- Sections span whole bars, and a note ringing across an Arrange edit keeps
  its length, so inserting and then deleting bars gets you back where you
  started.
- Automation stays in place across Arrange edits, and duplicated sections
  carry their curve.
- Changing tempo during playback no longer jumps, and tempo is held to 40–300
  BPM everywhere.
- The Chords dialog remembers only a follow source you picked yourself.

## [1.4.0] – 2026-09-22

### Added
- Arrange: insert and delete bars across the whole song. Sections read from
  the markers can be duplicated, copied to the end or deleted.
- Variation: move a share of the notes to neighbouring scale steps or
  octaves, or thin a part out while keeping the downbeats.

## [1.3.0] – 2026-09-22

### Added
- Tap tempo.
- Euclidean layers in the Patterns dialog, with rotation, 1/8 or 1/16 steps
  and known rhythms as presets.

## [1.2.0] – 2026-09-22

### Added
- Parts that follow another track's chords: the Chords dialog writes a bass
  line or arpeggio from what another track plays.
- Ghost notes: the other tonal tracks' notes drawn faintly in the active
  track's roll, toggled beside Grid.

## [1.1.5] – 2026-09-22

### Added
- Example song "Cedar Nocturne", a fingerstyle nylon-guitar piece.

### Fixed
- Pluck was about 4 dB too loud in real songs and could clip.

## [1.1.4] – 2026-09-22

### Changed
- The pitch range reaches down to E1.

### Fixed
- Pluck was out of tune on every note (a 110 Hz note rang at 84.5 Hz). It is
  now within a few cents.
- Clip windows could overlap a neighbour and hide its notes.
- Recording: moving the arm mid-take, a take reaching the song's end, and
  notes played just before the loop point.
- Echo and reverb tails left behind after a seek.
- Smaller fixes to Transpose, meter change, resize, region repeat, MIDI
  import, export as code, rhythm nudge and Duplicate track (which now keeps
  clips).
- Example songs: bends, duplicate hits and overlapping notes corrected.
- The local dev server no longer crashes on a malformed URL and no longer
  serves `.git`.

## [1.1.3] – 2026-09-22

### Fixed
- Undo right after loading a song or starting a new one no longer puts the
  previous song's tracks back under the new song's name.
- The master bus no longer carries over from one song to the next.
- Removing an armed track no longer leaves the keyboard armed.
- A take no longer brings back notes replaced on a later lap or erased
  mid-take.
- Add chord no longer selects notes on another track.
- The Grab marquee and the note lane could measure the wrong lane and set
  velocity to 10%.
- Automation plays as a smooth curve rather than a staircase.
- Mute and Solo during playback silence a track that has a volume curve.
- Pressing Play or Record while playing no longer starts a second copy of the
  song on top of the first.

## [1.1.2] – 2026-09-22

### Fixed
- Sidechain ducking lost a dip when two kicks were placed back to front.
- Instrument presets keep the hard-sync sweep and the arpeggio speed.
- The Env panel's Reset also resets sync and arpeggio speed, and shows the
  reset values.

## [1.1.1] – 2026-09-21

### Fixed
- Harmonics: the phase slider showed 360° for a phase stored as 0°, and a
  malformed saved preset is rejected instead of breaking playback.

## [1.1.0] – 2026-09-21

### Added
- Harmonics: a 14th waveform built from 16 harmonic sliders, with
  quick-start shapes and a live preview. Saved with presets and songs.
- Pluck: a plucked-string waveform (Karplus-Strong).
- A per-track formant filter, and a better-sounding reverb.
- Example songs "Air" (Bach, BWV 1068), "Derelict Watch", "Retro SFX Bank"
  and "Vowel & String".
- Save file, Export MIDI and Export WAV use the browser's own save dialog
  where it has one, and remember a single project folder.
- Copy and Close buttons on the Export code box.

### Changed
- Help is its own page, opening in a new tab so it can stay open beside the
  editor.
- The menu keeps the file actions together, and the track actions together.
- The app is described as a synth-based music studio rather than an 8-bit
  chiptune editor.

### Fixed
- Pasting rhythm hits dropped their velocity and pan.

## [1.0.1] – 2026-09-01

The first versioned build: the version is shown in Help. Everything before it,
back to 2026-07-19, is unversioned; `DONE.md` is the record of it.

### Added
- Example songs "Canone", "Dodici" and "Sinfonia Quarta", Bach for three SID
  voices.

[1.6.3]: https://github.com/Ruperto72/music-studio/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/Ruperto72/music-studio/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/Ruperto72/music-studio/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/Ruperto72/music-studio/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/Ruperto72/music-studio/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/Ruperto72/music-studio/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/Ruperto72/music-studio/compare/v1.4.5...v1.5.0
[1.4.5]: https://github.com/Ruperto72/music-studio/compare/v1.4.4...v1.4.5
[1.4.4]: https://github.com/Ruperto72/music-studio/compare/v1.4.3...v1.4.4
[1.4.3]: https://github.com/Ruperto72/music-studio/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/Ruperto72/music-studio/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/Ruperto72/music-studio/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/Ruperto72/music-studio/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Ruperto72/music-studio/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Ruperto72/music-studio/compare/v1.1.5...v1.2.0
[1.1.5]: https://github.com/Ruperto72/music-studio/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/Ruperto72/music-studio/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/Ruperto72/music-studio/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/Ruperto72/music-studio/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/Ruperto72/music-studio/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Ruperto72/music-studio/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Ruperto72/music-studio/tree/v1.0.1
