# A new app icon: the PWM sweep, and a command that regenerates it

## Problem

Three separate things are wrong with how this app presents itself, and they
are cheapest to fix together because they all read from the same source.

**The icon says nothing specific.** `icons/icon-512.png` is five green bars
of varying height on `#131316`. It is a competent drawing of "an audio app"
— the same picture a podcast player, a level meter or a bar chart would use.
Nothing in it is about chiptune, about pulse waves, or about this editor.

**The browser tab shows an emoji.** `index.html:7` sets `rel="icon"` to an
inline SVG containing nothing but 🎵:

```html
<link rel="icon" href="data:image/svg+xml,…%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%B5%3C/text%3E…">
```

This app deliberately removed emoji from its interface — DESIGN.md A.1 calls
them "full-colour system pictures pasted into a monochrome stroked
interface", and `verify.js` audits every control against an explicit
keep-list so the split stays a decision rather than a drift. The audit never
looked at the `<head>`, so the one emoji left in the project is the app's
face in every open tab.

**`icons/favicon-32.png` is referenced by nothing.** Not `index.html`, not
`manifest.webmanifest`, not `sw.js`'s `SHELL_URLS`. It is a 32×32 PNG that
ships to every visitor of the repo and is never requested.

Underneath all three: CLAUDE.md records that the icons "were generated with
a one-off Node script (not checked in) using a plain PNG encoder —
regenerate similarly if they ever need to change." That is the same problem
`shots.js` was written to solve for the README screenshots, and the same
argument applies. Re-drawing has to be a command, or the next person to
change the icon is writing a rasteriser from scratch again.

## The mark

One filled path in a 100×100 viewBox:

```
M6 74 H94 V68 H90 V32 H68 V68 H55 V32 H38 V68 H22 V32 H14 V68 H6 Z
```

Read left to right it is three pulses — 8, 17 and 22 units wide — standing
on a 6-unit floor, their tops at `y=32` and the floor's top at `y=68`. The
widths grow while the gaps between them stay in the same range (16 and 13
units), so what changes across the icon is the share of each cycle that is
high. That is duty, and duty is what pulse-width modulation modulates. The
growth is the whole subject of the drawing.

The periods are not held exactly constant, which a strict PWM diagram would
do — the drawing is composed for a 100-unit square first and is a portrait
of the effect rather than a plot of it.

It is filled with a horizontal linear gradient from `#2ff3ff` to `#ff2fb0`
— `TRACK_PALETTE[0]` and `TRACK_PALETTE[1]`, the two colours a user of this
app sees first. The gradient runs the same direction the pulses grow, so a
still image carries a direction.

**Why this shape.** It is the `pwm` entry from `GLYPHS` restated as a filled
shape. That glyph's own comment already states the reasoning — *"Pulses of growing
width — the sweep is the whole point of this one, so the glyph shows the
width changing rather than one fixed duty"* — and what is true of a 24×12
glyph in a track header is true of a 512×512 icon on a home screen. A plain
square wave would be the obvious alternative and was rejected in
brainstorming: it is on every third synth app, whereas a duty sweep is
specifically about pulse-width modulation, which is specifically what this
editor does that a generic sequencer does not.

The corners are sharp. `GLYPHS` strokes with `stroke-linejoin: round`, but
that softens a stroke's outside corner by a fraction of its width; a filled
silhouette has no equivalent, and rounding it would cost the shape its
8-bit squareness for no legibility gain.

## Three framings

The mark is drawn once. What differs between output files is only the
background's shape and the motif's scale, so those two values are the whole
of a "framing" and belong in one table:

| Framing | Background | Motif scale | Feeds |
|---|---|---|---|
| `rounded` | rounded rect, `rx=22`, `#131316` | 1.0 | `icon-192.png`, `icon-512.png`, `favicon-32.png`, `icon.svg` |
| `bleed` | full square, `#131316` | 1.0 | `apple-touch-icon.png` (180×180) |
| `maskable` | full square, `#131316` | 0.8, recentred | `icon-maskable-192.png`, `icon-maskable-512.png`, `icon-maskable.svg` |

**`bleed` exists because of iOS.** Safari composites a transparent
apple-touch-icon against black or white and applies its own squircle, so
supplying our own rounded corners and transparent margin risks a visible
seam against an unknown backdrop. A full square with an opaque background
lets iOS mask it however it likes. The motif is not scaled down for it: the
squircle's corner cut is significant only near the corners, and the motif
spans `y=32..74`, close enough to the vertical middle that the mask is at
full width there.

**`maskable`'s 0.8 is derived, not chosen.** The maskable spec lets a
launcher crop anything outside a centred circle whose diameter is 80% of the
icon, i.e. radius 40 units here. The motif's bounding box is `x=6..94` by
`y=32..74` — 88 × 42 units, half-diagonal `sqrt(44² + 21²) ≈ 48.8`, which
overflows the safe radius by more than a fifth. At scale 0.8 the
half-diagonal is `sqrt(35.2² + 16.8²) = 39.0`, inside 40 with a little to
spare. The motif's own centre is `(50, 53)` rather than `(50, 50)`, because
the floor hangs below the pulses' vertical midpoint, so the transform also
lifts it 3 units to sit centred in the icon:

```
translate(50,50) scale(0.8) translate(-50,-53)
```

## `icons.js` — the generator

A new checked-in `icons.js`, run as `node icons.js`, that:

1. builds each framing's SVG from the one path and the one gradient,
2. writes `icons/icon.svg` and `icons/icon-maskable.svg`,
3. renders each PNG by loading the SVG in headless Chromium at the target
   size and capturing the viewport, and
4. prints one line per file with its size in pixels and kilobytes, the way
   `shots.js` does.

Same constraints as the rest of this repo's tooling: Node built-ins only, no
dependency, browser auto-discovered with `CHROME_PATH` as the override. It
needs no `dev-server.js` — an SVG loads from a `data:` URL, so there is no
static file to serve.

The generated SVGs are checked in. They are outputs, not sources — the
source is the path constant in `icons.js` — but they are what `index.html`
and `sw.js` reference at runtime, so they have to exist on disk.

## `cdp.js` — the extraction

`verify.js` and `shots.js` each carry their own `findBrowser()`, their own
CDP client and their own `waitForHttp()`. **These have already drifted once
with consequences**: `shots.js` shipped without the `staticPaths` fallback
its sibling has, so on a machine where Chrome registers an App Paths key
instead of a PATH entry — or, as on the machine this was written on, where
there is no Chrome at all and Edge is not on PATH either — `findBrowser()`
returned `null` and the tool could not run, while `verify.js` in the same
repo on the same box worked. That was fixed in `73ea6b1` by copying the list
across, which leaves two copies to keep in step. Adding `icons.js` would
make three.

So the shared parts move to a new `cdp.js` in the repo root (flat, like
every other Node-side file here), exporting:

- `findBrowser()` — the `where`/`which` probe, the platform install-path
  list, and the `/opt/pw-browsers` scan.
- `launchChrome(browserPath, opts)` — spawns headless Chromium on an
  ephemeral debugging port with a throwaway profile directory, resolves its
  WebSocket URL, and returns a cleanup function that waits for exit before
  removing the profile and retries the removal.
- `CDP` — the WebSocket/JSON-RPC client: `attach`, `send`, `evaluate`,
  `waitFor`, `close`.
- `waitForHttp(url, timeoutMs)`.

What does **not** move: `verify.js`'s console-error and exception tracking,
its `step()` harness, and `auditBundledSongs()`. Those are that file's own
job. The test of whether something belongs in `cdp.js` is whether all three
callers need it, not whether two happen to share it today.

Both existing files are rewritten to `require('./cdp.js')` and their copies
deleted. `node verify.js` and `node shots.js` must behave identically
afterwards — this is a refactor with no intended behaviour change, and it
touches the project's only regression net, so it is verified by running
both.

## File-by-file changes

**`index.html`** — the emoji favicon link is replaced by two:

```html
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="icon" sizes="32x32" href="icons/favicon-32.png">
```

The SVG is preferred by every browser that supports SVG favicons and stays
crisp at any tab size; the PNG is the fallback for those that do not, which
is what finally gives `favicon-32.png` a reason to exist rather than a
reason to be deleted. `apple-touch-icon` is unchanged in markup — only its
pixels change.

**`sw.js`** — `./icons/icon.svg` and `./icons/favicon-32.png` join
`SHELL_URLS` (both are now fetched at runtime and both must work offline),
and `CACHE_NAME` goes from `music-studio-v45` to `music-studio-v46` so
installed clients do not keep serving the old icons out of cache.
`icon-maskable.svg` is *not* precached: nothing requests it, it exists as a
readable source for whoever edits the mark next.

**`manifest.webmanifest`** — unchanged. The four entries it lists keep their
names, sizes and purposes; only their contents change.

**`verify.js`** — one new step, placed beside the bundled-songs audit as the
second check that needs no browser, since a missing or mis-sized icon should
be reported in a second rather than after a browser starts. It asserts:

- every icon path named in `manifest.webmanifest`, `index.html` and
  `sw.js`'s `SHELL_URLS` exists on disk;
- every PNG's actual IHDR dimensions match what the manifest declares, and
  `apple-touch-icon.png` is 180×180;
- the `rel="icon"` links do not contain a `data:` URL with a non-ASCII
  character in it — i.e. the emoji favicon cannot come back.

Like `auditBundledSongs()`, the values are read out of the real files rather
than retyped, and a read that finds nothing throws instead of passing
vacuously.

**Documentation** — CLAUDE.md's `manifest.webmanifest / sw.js / icons/`
bullet currently ends "Icons were generated with a one-off Node script (not
checked in) using a plain PNG encoder — regenerate similarly if they ever
need to change." That becomes false the moment `icons.js` lands and is
rewritten to describe the generator, the three framings and the one path.
`icons.js` and `cdp.js` get their own entries in the same file list.
DESIGN.md A.1 gains a short paragraph on the app mark, next to the
iconography it already documents.

## Verification

- `node icons.js` regenerates all six PNGs and both SVGs, and `git diff`
  shows only those files.
- `node verify.js` passes, including the new icon audit. Confirm the audit
  fails against a deliberately broken state (rename an icon, or paste the
  emoji link back) before trusting it — the `Array.prototype.every`
  empty-list trap CLAUDE.md warns about applies here too.
- `node shots.js` still runs, proving the `cdp.js` extraction did not break
  the other caller.
- Look at the rendered `favicon-32.png` and a 16×16 downscale of it. At 16px
  the narrowest pulse is about 1.3px wide. The expectation is that the two
  wider pulses and the gradient carry the silhouette; if they do not, add a
  fourth framing — a tighter one, motif scaled up toward the edges — feeding
  `favicon-32.png` only. **This is deliberately not built in advance.**

## Out of scope

- No in-app logo. The mark is for the tab, the home screen and the installed
  app; the editor's own header does not currently show a wordmark and does
  not need one.
- No change to `GLYPHS`. The mark is derived from the `pwm` glyph but is a
  separate, filled drawing at a different scale; making the glyph table
  serve both would mean parameterising it for a case with one member.
- No `.ico`. Browsers requesting `/favicon.ico` by convention will fall
  through to the declared links; a multi-resolution ICO writer is a
  rasteriser we would have to write and nothing in the supported set needs
  it.
- No new colours. The gradient's two stops are existing `TRACK_PALETTE`
  entries.
