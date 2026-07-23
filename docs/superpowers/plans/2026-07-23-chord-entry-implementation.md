# Chord Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the piano roll build real, simultaneous multi-note chords — via the Pen tool (clicking a different pitch at the same time no longer erases what's already there) and via two new "Add Major/Minor Chord" quick buttons in the note inspector — without breaking the existing single-note editing behavior.

**Architecture:** A single invariant change ripples through the whole file: "two notes conflict" currently means "they overlap in time", and becomes "they overlap in time **and** are the same pitch". This touches the shared `clearOverlaps()` helper and three inline reimplementations of the same time-only check (drag-move, resize, keyboard multi-nudge). On top of that, a new UI affordance (two buttons) in the existing note inspector adds the interval notes for a major/minor triad above the selected root note.

**Tech Stack:** Plain DOM/Web Audio JS in `index.html` (no framework, no build step). `verify.js` (this repo's headless-Chrome smoke test, driven over the Chrome DevTools Protocol) is the only automated check available — there is no unit test runner. It is not a substitute for exercising drag gestures in a real browser, so tasks involving mouse-drag interactions are verified manually instead (see Task 3).

## Global Constraints

- No build, lint, or unit-test framework exists in this repo, and none should be introduced. `node verify.js` is the closest thing to an automated regression check.
- `index.html` is listed in `sw.js`'s `SHELL_URLS` precache list. Per this repo's standing rule, bump `CACHE_NAME` in `sw.js` whenever a precached shell file changes, so installed/mobile clients don't get stuck on a stale cached copy — this plan's last task does that bump.
- Don't touch rhythm-track (drum hit) code paths — hits are keyed by row (`type`), not pitch, and already coexist correctly at the same time column across rows.
- On this user's machine, always commit **and push** together in the same step (single dev, own machine, no feature branches) — every task's commit step includes a push.

---

### Task 1: Pitch-aware `clearOverlaps()` — the shared invariant, Pen tool, and paste

**Files:**
- Modify: `index.html:1819-1826` (`clearOverlaps` function)
- Modify: `index.html:3227-3239` (`onCellClick`, the Pen tool's "add a note" handler)
- Modify: `index.html:3392-3405` (`nudgeSelection`'s single-selection branch)
- Modify: `index.html:3430-3440` (`pasteClipboard`'s tonal-note branch)
- Modify: `index.html:704` (in-app help text for the Pen tool)
- Modify: `verify.js` (new step, appended after the existing last step)

**Interfaces:**
- Produces: `clearOverlaps(notes, start, len, freq, exceptIdx = -1)` — note the new
  required `freq` parameter inserted **before** the existing optional
  `exceptIdx`. Every call site in the whole file must pass it; there are
  exactly three call sites, all listed above, all updated in this task.

- [ ] **Step 1: Add the new verify.js step (it will fail — that's expected)**

Open `verify.js` and insert this new `step(...)` call immediately after the
existing `'adds a track via the menu and undoes it'` step (so it runs right
after a fresh, empty tonal track has been added and is active) and before
the `for (const s of steps) await s();` loop:

```js
    step('Pen: clicking a different pitch at the same time in a tonal track adds a chord tone, not a replacement', async () => {
      await cdp.evaluate(`document.querySelector('[data-tool="pen"]').click()`);
      const hasLane = await cdp.evaluate(`!!document.querySelector('.track.active .lane')`);
      if (!hasLane) throw new Error('expected an active tonal track with a .lane element');
      await cdp.evaluate(`
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 20 }));
      `);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 1`);
      await cdp.evaluate(`
        const lane = document.querySelector('.track.active .lane');
        const rect = lane.getBoundingClientRect();
        lane.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 100 }));
      `);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 2`);
    });
```

(The two clicks use the same x — same time column — but y values 80px
apart, which at this app's `ROW_H = 11` px/semitone is guaranteed to land
on a different pitch row, regardless of exact column width.)

- [ ] **Step 2: Run verify.js and confirm the new step fails**

Run: `node verify.js`
Expected: every step passes except the new one, which fails with something
like `expected 2, got 1` (or a timeout waiting for 2 `.note` elements) —
today's code deletes the first note when the second is added at an
overlapping time, regardless of pitch.

- [ ] **Step 3: Make `clearOverlaps` pitch-aware**

Replace (`index.html:1819-1826`):

```js
function clearOverlaps(notes, start, len, exceptIdx = -1) {
  const end = start + len;
  return notes.filter((n, i) => {
    if (i === exceptIdx) return true;
    const nEnd = n.start + n.len;
    return nEnd <= start || n.start >= end;
  });
}
```

with:

```js
function clearOverlaps(notes, start, len, freq, exceptIdx = -1) {
  const end = start + len;
  return notes.filter((n, i) => {
    if (i === exceptIdx) return true;
    if (n.freq !== freq) return true;
    const nEnd = n.start + n.len;
    return nEnd <= start || n.start >= end;
  });
}
```

- [ ] **Step 4: Update `onCellClick` to pass the new note's frequency**

Replace (`index.html:3227-3239`):

```js
function onCellClick(track, midi, col) {
  const notes = state.tracks[track];
  const len = state.grid;
  const cleared = clearOverlaps(notes, col, len);
  cleared.push({
    start: col, len, freq: round2(midiToFreq(midi)), vel: 1,
    bend: null, vib: false, trem: false, duty: null, arp: null,
    porta: false, crush: false, echo: false, chorus: false, reverb: false
  });
  state.tracks[track] = cleared;
  state.selected = { track, index: cleared.length - 1 };
  previewNote(track, cleared[cleared.length - 1]);
  render();
}
```

with:

```js
function onCellClick(track, midi, col) {
  const notes = state.tracks[track];
  const len = state.grid;
  const freq = round2(midiToFreq(midi));
  const cleared = clearOverlaps(notes, col, len, freq);
  cleared.push({
    start: col, len, freq, vel: 1,
    bend: null, vib: false, trem: false, duty: null, arp: null,
    porta: false, crush: false, echo: false, chorus: false, reverb: false
  });
  state.tracks[track] = cleared;
  state.selected = { track, index: cleared.length - 1 };
  previewNote(track, cleared[cleared.length - 1]);
  render();
}
```

(Because an existing note's own DOM element already intercepts clicks on
its own cells via `stopPropagation`, `onCellClick` can now never actually
be reached for a cell that has a same-pitch note under it — so in practice
this makes the Pen tool always add, never replace, matching the chosen
design. The exact-duplicate guard stays in `clearOverlaps` itself as a
defensive invariant for the other two call sites below, where a same-pitch
collision is a real possibility.)

- [ ] **Step 5: Update `nudgeSelection`'s single-selection branch**

Replace (`index.html:3392-3405`):

```js
  if (!state.selected) return;
  const { track, index } = state.selected;
  const notes = state.tracks[track];
  const note = notes[index];
  note.start = quant(Math.max(0, Math.min(COLS - note.len, note.start + dCol)));
  if (dRow) {
    const midi = Math.max(MIDI_MIN, Math.min(MIDI_MAX, freqToMidi(note.freq) + dRow));
    note.freq = round2(midiToFreq(midi));
  }
  const cleared = clearOverlaps(notes, note.start, note.len, notes.indexOf(note));
  state.tracks[track] = cleared;
  state.selected = { track, index: cleared.indexOf(note) };
  render();
}
```

with:

```js
  if (!state.selected) return;
  const { track, index } = state.selected;
  const notes = state.tracks[track];
  const note = notes[index];
  note.start = quant(Math.max(0, Math.min(COLS - note.len, note.start + dCol)));
  if (dRow) {
    const midi = Math.max(MIDI_MIN, Math.min(MIDI_MAX, freqToMidi(note.freq) + dRow));
    note.freq = round2(midiToFreq(midi));
  }
  const cleared = clearOverlaps(notes, note.start, note.len, note.freq, notes.indexOf(note));
  state.tracks[track] = cleared;
  state.selected = { track, index: cleared.indexOf(note) };
  render();
}
```

- [ ] **Step 6: Update `pasteClipboard`'s tonal-note branch**

Replace (`index.html:3430-3440`):

```js
  } else {
    let notes = state.tracks[state.activeTrack];
    const pasted = [];
    for (const it of clipboard.items) {
      const newStart = quant(Math.max(0, Math.min(COLS - it.len, it.start + anchor)));
      notes = clearOverlaps(notes, newStart, it.len);
      const newNote = { ...it, start: newStart, arp: it.arp ? [...it.arp] : null };
      notes.push(newNote);
      pasted.push(newNote);
    }
    state.tracks[state.activeTrack] = notes;
    state.multiSelected = new Set(pasted);
  }
```

with:

```js
  } else {
    let notes = state.tracks[state.activeTrack];
    const pasted = [];
    for (const it of clipboard.items) {
      const newStart = quant(Math.max(0, Math.min(COLS - it.len, it.start + anchor)));
      notes = clearOverlaps(notes, newStart, it.len, it.freq);
      const newNote = { ...it, start: newStart, arp: it.arp ? [...it.arp] : null };
      notes.push(newNote);
      pasted.push(newNote);
    }
    state.tracks[state.activeTrack] = notes;
    state.multiSelected = new Set(pasted);
  }
```

- [ ] **Step 7: Update the in-app help text**

Replace (`index.html:704`):

```html
        <li><b>✏️ Pen</b> — click an empty cell to add a note/hit.</li>
```

with:

```html
        <li><b>✏️ Pen</b> — click an empty cell to add a note/hit. Clicking a different pitch at the same time in a tonal track adds a chord tone, rather than replacing what's already there.</li>
```

- [ ] **Step 8: Run verify.js and confirm everything passes**

Run: `node verify.js`
Expected: `All checks passed, no console errors.`

- [ ] **Step 9: Commit and push**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Make note overlap checks pitch-aware so chords can share a time slot

Only a note at the exact same pitch is treated as a conflict now, so
the Pen tool, paste, and single-note keyboard nudging can all coexist
with a chord instead of deleting its other pitches.
EOF
)"
git push
```

---

### Task 2: "Chord" quick-add buttons in the note inspector

**Files:**
- Modify: `index.html` (`renderInspector()`, insert a new panel section between the existing "Pitch" panel's arp-preset buttons and the "Texture / FX" panel — see anchor comments below)
- Modify: `verify.js` (new step, appended after Task 1's step)

**Interfaces:**
- Consumes: `clearOverlaps(notes, start, len, freq, exceptIdx = -1)` from Task 1.
  `previewNote(track, note)` (existing, `index.html:5126`). `panel(cap)` and
  `el(tag, cls)` helpers already in scope inside `renderInspector()`.
  `MIDI_MIN`/`MIDI_MAX` constants (`index.html:1062`).
- Produces: nothing new consumed by later tasks — this is a leaf feature.

- [ ] **Step 1: Add the new verify.js step (it will fail — that's expected)**

Append this step directly after Task 1's new step in `verify.js` (still
before the `for (const s of steps) await s();` loop). It continues from
the same page state Task 1's step left behind: a tonal track with 2 notes
(different pitches, same time column), the second one currently selected.

```js
    step('Note inspector: "Add Major Chord" adds two real notes and multi-selects the whole chord', async () => {
      await waitFor(`!!Array.from(document.querySelectorAll('.insp-cap')).find(c => c.textContent === 'Chord')`);
      await cdp.evaluate(`
        Array.from(document.querySelectorAll('.insp-panel button')).find(b => b.textContent === 'Add Major Chord').click();
      `);
      await waitFor(`document.querySelectorAll('.track.active .lane .note').length === 4`);
      const multiCount = await cdp.evaluate(`document.querySelectorAll('.track.active .lane .note.multi-selected').length`);
      if (multiCount !== 3) throw new Error(`expected 3 notes multi-selected as the chord group, got ${multiCount}`);
      const inspectorEmpty = await cdp.evaluate(`document.querySelector('.inspector').classList.contains('empty')`);
      if (!inspectorEmpty) throw new Error('expected the single-note inspector to close after the chord is selected as a group');
    });
```

- [ ] **Step 2: Run verify.js and confirm the new step fails**

Run: `node verify.js`
Expected: the new step fails — there is no "Chord" panel or "Add Major
Chord" button yet, so `waitFor` times out.

- [ ] **Step 3: Add the Chord panel to `renderInspector()`**

Find this existing code (the end of the "Pitch" panel, `index.html`,
shortly before the `// --- Texture / FX ---` comment):

```js
  const presets = el('div', 'arp-presets');
  const arpMajor = document.createElement('button');
  arpMajor.textContent = 'Major triad';
  arpMajor.addEventListener('click', () => { note.arp = [4, 7]; note.bend = null; note.porta = false; render(); });
  const arpMinor = document.createElement('button');
  arpMinor.textContent = 'Minor triad';
  arpMinor.addEventListener('click', () => { note.arp = [3, 7]; note.bend = null; note.porta = false; render(); });
  presets.append(arpMajor, arpMinor);
  pitch.appendChild(presets);

  // --- Texture / FX ---
```

Insert a new panel between them, so the code reads:

```js
  const presets = el('div', 'arp-presets');
  const arpMajor = document.createElement('button');
  arpMajor.textContent = 'Major triad';
  arpMajor.addEventListener('click', () => { note.arp = [4, 7]; note.bend = null; note.porta = false; render(); });
  const arpMinor = document.createElement('button');
  arpMinor.textContent = 'Minor triad';
  arpMinor.addEventListener('click', () => { note.arp = [3, 7]; note.bend = null; note.porta = false; render(); });
  presets.append(arpMajor, arpMinor);
  pitch.appendChild(presets);

  // --- Chord ---
  // Unlike the Arpeggio presets above (which just flag this single note to
  // play its notes in quick succession), these add real, separate notes at
  // the same start/len in this track — a true simultaneous chord, the way
  // e.g. songs/cinematic.json's Strings track is authored.
  const chordPanel = panel('Chord');
  const chordHint = el('div', 'insp-sub');
  chordHint.textContent = 'Adds real notes a third and fifth above, in this track.';
  chordPanel.appendChild(chordHint);
  const chordRow = el('div', 'arp-presets');
  const addChordAbove = (semitoneIntervals) => {
    const rootMidi = freqToMidi(note.freq);
    const newNotes = semitoneIntervals.map((semis) => ({
      start: note.start, len: note.len,
      freq: round2(midiToFreq(Math.max(MIDI_MIN, Math.min(MIDI_MAX, rootMidi + semis)))),
      vel: note.vel, bend: null, vib: false, trem: false, duty: null, arp: null,
      porta: false, crush: false, echo: false, chorus: false, reverb: false,
    }));
    let notes = state.tracks[track];
    for (const n of newNotes) notes = clearOverlaps(notes, n.start, n.len, n.freq);
    notes.push(...newNotes);
    state.tracks[track] = notes;
    for (const n of newNotes) previewNote(track, n);
    state.multiSelected = new Set([note, ...newNotes]);
    state.selected = null;
    render();
  };
  const majorChordBtn = document.createElement('button');
  majorChordBtn.textContent = 'Add Major Chord';
  majorChordBtn.addEventListener('click', () => addChordAbove([4, 7]));
  const minorChordBtn = document.createElement('button');
  minorChordBtn.textContent = 'Add Minor Chord';
  minorChordBtn.addEventListener('click', () => addChordAbove([3, 7]));
  chordRow.append(majorChordBtn, minorChordBtn);
  chordPanel.appendChild(chordRow);

  // --- Texture / FX ---
```

- [ ] **Step 4: Run verify.js and confirm everything passes**

Run: `node verify.js`
Expected: `All checks passed, no console errors.`

- [ ] **Step 5: Commit and push**

```bash
git add index.html verify.js
git commit -m "$(cat <<'EOF'
Add Major/Minor Chord quick-add buttons to the note inspector

Builds a real triad (root already selected, plus a third and fifth
added as separate notes in the same track) instead of only offering
the existing Arpeggio presets, which play a single note's pitches in
sequence rather than simultaneously.
EOF
)"
git push
```

---

### Task 3: Pitch-aware drag, resize, and multi-note keyboard nudge; cache bump

**Files:**
- Modify: `index.html:3376-3388` (`nudgeSelection`'s multi-selection branch)
- Modify: `index.html:3508-3524` (`startMoveNote`'s pointerup handler)
- Modify: `index.html:3460-3467` (`startResize`'s `onMove` handler)
- Modify: `sw.js:3` (`CACHE_NAME`)

**Interfaces:**
- Consumes: nothing new — these are self-contained one-line filter changes
  to existing functions, independent of Tasks 1 and 2.
- Produces: nothing consumed by later tasks.

These three fixes are mouse-drag and multi-select gestures. This repo has
no automated way to simulate a realistic pointer-drag sequence (pointer
capture, multi-event ordering) through `verify.js`'s CDP harness, and
`CLAUDE.md` is explicit that `verify.js` "is not a substitute for actually
exercising a change in a real browser" — so this task is verified with a
manual checklist (Step 5) instead of a new automated step.

- [ ] **Step 1: Fix `nudgeSelection`'s multi-selection branch**

Replace (`index.html:3376-3388`):

```js
    } else {
      const notes = state.tracks[state.activeTrack];
      const minStart = Math.min(...sel.map(n => n.start));
      const maxEnd   = Math.max(...sel.map(n => n.start + n.len));
      const midis    = sel.map(n => freqToMidi(n.freq));
      const dc = Math.max(-minStart, Math.min(COLS - maxEnd, dCol));
      const dr = Math.max(MIDI_MIN - Math.min(...midis), Math.min(MIDI_MAX - Math.max(...midis), dRow));
      sel.forEach((n, i) => { n.start = quant(n.start + dc); if (dr) n.freq = round2(midiToFreq(midis[i] + dr)); });
      const selSet = state.multiSelected;
      let rest = notes.filter(n => !selSet.has(n));
      for (const n of sel) rest = rest.filter(o => o.start + o.len <= n.start || o.start >= n.start + n.len);
      state.tracks[state.activeTrack] = [...rest, ...sel];
    }
```

with:

```js
    } else {
      const notes = state.tracks[state.activeTrack];
      const minStart = Math.min(...sel.map(n => n.start));
      const maxEnd   = Math.max(...sel.map(n => n.start + n.len));
      const midis    = sel.map(n => freqToMidi(n.freq));
      const dc = Math.max(-minStart, Math.min(COLS - maxEnd, dCol));
      const dr = Math.max(MIDI_MIN - Math.min(...midis), Math.min(MIDI_MAX - Math.max(...midis), dRow));
      sel.forEach((n, i) => { n.start = quant(n.start + dc); if (dr) n.freq = round2(midiToFreq(midis[i] + dr)); });
      const selSet = state.multiSelected;
      let rest = notes.filter(n => !selSet.has(n));
      for (const n of sel) rest = rest.filter(o => o.freq !== n.freq || o.start + o.len <= n.start || o.start >= n.start + n.len);
      state.tracks[state.activeTrack] = [...rest, ...sel];
    }
```

- [ ] **Step 2: Fix `startMoveNote`'s pointerup handler**

Replace (`index.html:3508-3524`):

```js
  function onUp(ev) {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    interacting = false;
    if (!moved) { selectNote(track, idx); return; }
    const groupSet = new Set(group);
    // Read state.tracks[track] fresh here rather than reusing the `notes` closure
    // captured at gesture start — a concurrent touch drag on another note of this
    // same track may have already committed its own array replacement, and filtering
    // against the stale `notes` snapshot would silently discard that other commit.
    let rest = state.tracks[track].filter(n => !groupSet.has(n));
    for (const n of group) rest = rest.filter(o => o.start + o.len <= n.start || o.start >= n.start + n.len);
    state.tracks[track] = [...rest, ...group];
    state.selected = { track, index: state.tracks[track].indexOf(note) };
    render();
  }
```

with:

```js
  function onUp(ev) {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    interacting = false;
    if (!moved) { selectNote(track, idx); return; }
    const groupSet = new Set(group);
    // Read state.tracks[track] fresh here rather than reusing the `notes` closure
    // captured at gesture start — a concurrent touch drag on another note of this
    // same track may have already committed its own array replacement, and filtering
    // against the stale `notes` snapshot would silently discard that other commit.
    let rest = state.tracks[track].filter(n => !groupSet.has(n));
    for (const n of group) rest = rest.filter(o => o.freq !== n.freq || o.start + o.len <= n.start || o.start >= n.start + n.len);
    state.tracks[track] = [...rest, ...group];
    state.selected = { track, index: state.tracks[track].indexOf(note) };
    render();
  }
```

- [ ] **Step 3: Fix `startResize`'s length cap**

Replace (`index.html:3460-3467`):

```js
  function onMove(ev) {
    if (ev.pointerId !== pointerId) return;
    const deltaGrid = Math.round((ev.clientX - startX) / gridPx()) * state.grid;
    const newLen = Math.max(state.grid, startLen + deltaGrid);
    const others = notes.filter((_, i) => i !== idx);
    const maxLen = nextNoteStart(others, note.start) - note.start;
    note.len = quant(Math.min(newLen, Math.max(state.grid, maxLen)));
    scheduleRender();
  }
```

with:

```js
  function onMove(ev) {
    if (ev.pointerId !== pointerId) return;
    const deltaGrid = Math.round((ev.clientX - startX) / gridPx()) * state.grid;
    const newLen = Math.max(state.grid, startLen + deltaGrid);
    const others = notes.filter((n, i) => i !== idx && n.freq === note.freq);
    const maxLen = nextNoteStart(others, note.start) - note.start;
    note.len = quant(Math.min(newLen, Math.max(state.grid, maxLen)));
    scheduleRender();
  }
```

- [ ] **Step 4: Bump the service worker cache name**

Replace (`sw.js:3`):

```js
const CACHE_NAME = 'music-studio-v5';
```

with:

```js
const CACHE_NAME = 'music-studio-v6';
```

- [ ] **Step 5: Manual verification in a real browser**

Run: `node dev.js` (starts the dev server and opens the app)

In the browser:

1. ☰ menu → **＋ Add track** to get a fresh, empty tonal track (it becomes
   the active track).
2. With the **✏️ Pen** tool active, click a cell to add note A. Click a
   different pitch at the same time column to add note B — you should now
   see 2 notes stacked vertically at the same time position (per Task 1).
3. Note B should already be selected — in the inspector's new **Chord**
   panel, click **Add Major Chord**. You should now see 4 notes total, 3 of
   them (note B + the 2 new ones) highlighted as a multi-selected group.
4. Switch to the **✋ Grab** tool (press `3`, or click the Grab button).
   Drag any one of the 3 highlighted chord notes a little to the right and
   release. Expected: all 3 highlighted notes move together by the same
   amount; note A (not selected) stays exactly where it was. Total note
   count is still 4 — nothing was deleted.
5. Click empty space to clear the selection, then click on just one of the
   3 chord notes by itself (a plain single click, not shift-click) to
   select only it. Drag that single note further to the right and release.
   Expected: only that one note moves; the other 2 former chord-mates and
   note A are undisturbed. Total note count is still 4.
6. Grab that same note's right-edge resize handle and drag it rightward,
   past the point in time where one of the other notes (a different pitch)
   sits. Expected: the note's length grows past that point; the
   other-pitch note is not deleted. Total note count is still 4.
7. Click to select a single note, then press the `→` (ArrowRight) key a
   few times to nudge it in time onto another pitch's time range. Expected:
   the note moves; the other-pitch note is not deleted. Total note count is
   still 4 throughout.
8. Reload the page (a plain reload, not a hard reload) and confirm the app
   still loads with no console errors, to sanity-check the `sw.js` edit
   didn't break anything (the version bump alone doesn't change fetch
   behavior, only which cache generation is used).

If any step's "Expected" doesn't hold, stop and re-open the relevant fix
from Steps 1–3 above rather than proceeding.

- [ ] **Step 6: Run verify.js once more as a final regression check**

Run: `node verify.js`
Expected: `All checks passed, no console errors.`

- [ ] **Step 7: Commit and push**

```bash
git add index.html sw.js
git commit -m "$(cat <<'EOF'
Make drag, resize, and multi-note nudge pitch-aware too

Same invariant as the Pen tool and paste: two notes only conflict if
they're the same pitch, so moving, resizing, or nudging one note of a
chord no longer deletes its other pitches. Bumps CACHE_NAME since
index.html (a precached shell file) changed.
EOF
)"
git push
```
