# TODO

Kvarstående arbete för musikeditorn, baserat på en genomgång av `index.html`
mot README/CLAUDE.md:s funktionslista. Inget av detta är påbörjat i kod
(inga `TODO`/`FIXME` finns i källan idag) — listan är en avstämning av vad
som saknas, inte ett facit över buggar.

## Näst på tur (efterfrågat)

- [ ] **MIDI-import/export** — läsa in och skriva `.mid`-filer, inte bara
  `.json`/kod-exporten. Internt är tonhöjder redan MIDI-nummer
  (`MIDI_MIN`/`MIDI_MAX`, `midiToFreq`), så det som saknas är själv
  filformatet (parsning av `.mid` in, och en SMF-writer ut) — ingen
  ändring av notmodellen borde behövas.
- [ ] **Ljudfilsexport (WAV/MP3)** — rendera hela låten till en nedladdningsbar
  ljudfil via `OfflineAudioContext` (samma synteskod som `render()`/uppspelningen
  redan använder, bara mot en offline-kontext istället för `ctx`). WAV är
  rakt fram (PCM-header, inga beroenden); MP3 kräver antingen ett
  encoder-bibliotek eller att man nöjer sig med WAV-only export.

## Inspirerat av etablerade DAW:ar (Pro Tools m.fl.)

Genomgång av vad ett "riktigt" DAW (Pro Tools, Ableton, FL Studio) har som
denna editor saknar. Prioritetsordning nedan är en rekommendation, inte
ett facit.

- [ ] **Metronom + count-in** — redan listad under "Interaktion / touch"
  ovan; lyfts fram här som en av de mest lågt hängande frukterna.
- [ ] **EQ/kompression (t.ex. sidokedjad ducking) på mastern** — genuint
  DAW-territorium. Avvägning: drar appen bort från sin identitet som ett
  lättviktigt, beroendefritt 8-bit-verktyg — lägst prioritet av de två.

## Ljud / export

- **Kodexport kräver manuell copy.** `#export`-knappen (index.html:2973)
  fyller bara en dold `<textarea>` och markerar texten — ingen
  "Kopiera"-knapp (`navigator.clipboard`) eller nedladdning av filen direkt.

## Rytmspår

- **Bara ett rytmspår med ett fast kit** (nu 6 ljud: kick/snare/hihat/tom/
  clap/crash) — inget sätt att lägga till egna/ytterligare slagverksljud
  utöver dessa, eller ett andra rytmspår med eget kit.

## Spårhantering

- **Ingen omordning av spår.** Man kan lägga till/döpa om/ta bort tonspår,
  men inte flytta ett spår upp/ner i listan.
- **Inga sparade instrument-presets.** Varje spår har nu vågform + ADSR-
  envelope, men inget bibliotek av namngivna timbre-recept att återanvända
  mellan spår/låtar — utöver de per-not-effekter som redan finns (bend,
  vibrato, tremolo, duty, bitcrush, echo, chorus).

## Interaktion / touch

- **Not-redigering använder bara mus-events**, inte Pointer Events
  (`mousedown`/`mousemove`/`mouseup` i t.ex. `startMoveNote`, `startResize`,
  `startMarquee`, `startScrub`) — till skillnad från scrollbaren
  (index.html:1657) som redan är porterad till `pointerdown`/`pointermove`.
  Fungerar troligen via mobilwebbläsares syntetiska mus-events, men är
  inte lika robust för pekskärm/penna som en riktig pointer-implementation.
- **Ingen metronom** och inget "count-in" vid inspelning/uppspelning.
- **Ingen svänggrad (swing/groove).** Griden snappar strikt (1/4, 1/8,
  1/16, triol) utan möjlighet att förskjuta jämna/udda steg.

## Lagring / delning

- **Bara lokalt.** Sparade låtar ligger i `localStorage` i webbläsaren;
  det finns ingen delning via länk/URL eller molnsynk mellan enheter.
- **Ingen kollaborativ redigering** (flera personer på samma låt samtidigt).

## Kvalitet

- **Inga automatiska tester.** CLAUDE.md bekräftar att det inte finns
  build/lint/test-kommando — all verifiering är manuell i webbläsaren.
- **Ingen tillgänglighetsgenomgång** utöver enstaka `aria-*`-attribut på
  knappar; ingen skärmläsarväg för själva pianorullen/rytmgriden.

## Övrigt (mindre, ej verifierat som blockerande)

- Endast engelskt UI (`<html lang="en">`) — ingen lokalisering.
- Inget MIDI-/USB-tangentbordsstöd för att spela in noter live.
