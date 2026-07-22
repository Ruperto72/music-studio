# TODO

Kvarstående arbete för musikeditorn, baserat på en genomgång av `index.html`
mot README/CLAUDE.md:s funktionslista. Inget av detta är påbörjat i kod
(inga `TODO`/`FIXME` finns i källan idag) — listan är en avstämning av vad
som saknas, inte ett facit över buggar.

## Näst på tur (efterfrågat)

- [x] **MIDI-import/export** — 🎹/🎼-knapparna i Session-panelen skriver/läser
  Standard MIDI File format 1 (egen SMF-writer/parser, inga beroenden).
  Export: en track per instrumentspår (namn bevaras), tempo/taktart som
  meta-events, rytmspåret mappas till GM-slagverksnoter (kick=36 osv);
  import gör motsvarande baklänges och skapar nya tonspår + fyller på
  rytmspåret, med kolumn-snap (`quant`) och en fråga om man vill anta
  filens tempo om det skiljer sig. Per-not-effekter (bend/vibrato/arp/...)
  har ingen MIDI-motsvarighet och exporteras/importeras inte — samma
  begränsning som kodexporten redan har för automation/ADSR.
- [x] **Ljudfilsexport (WAV)** — 🔊-knappen renderar hela låten offline
  (`OfflineAudioContext`, samma synteskod som uppspelningen) och laddar
  ner en `.wav`. MP3 uteslöts medvetet (se nedan) för att hålla appen
  beroendefri.

## Inspirerat av etablerade DAW:ar (Pro Tools m.fl.)

Genomgång av vad ett "riktigt" DAW (Pro Tools, Ableton, FL Studio) har som
denna editor saknar. Prioritetsordning nedan är en rekommendation, inte
ett facit.

- [ ] **Metronom + count-in** — redan listad under "Interaktion / touch"
  ovan; lyfts fram här som en av de mest lågt hängande frukterna.
- [x] **EQ/kompression på mastern** — 🎛️-knappen i mastersektionen öppnar
  ett litet panel med 3-bands-EQ (low/mid/high shelf/peak,
  `BiquadFilterNode`) och en kompressor (`DynamicsCompressorNode`),
  inkopplade sist i mastergrafen (mastergain → EQ → komp → destination,
  och VU-mätaren tappar post-FX). Standardvärden är helt neutrala (0dB,
  ratio 1:1) så gamla låtar utan dessa fält låter exakt som förut.

## Ljud / export

- **Kodexport kräver manuell copy.** `#export`-knappen (index.html:3712)
  fyller en `<textarea>` (tofflar den synlig/dold vid upprepade klick) och
  markerar texten — men saknar en "Kopiera"-knapp (`navigator.clipboard`)
  eller nedladdning av filen direkt.

## Rytmspår

- [x] **Fler slagverksljud i kittet** — utökat från 6 till 10 ljud:
  kick/snare/rim/hihat/open hi-hat/shaker/tom/clap/crash/ride
  (`RHYTHM_ROWS`/`RHYTHM_LABELS`). Varje ljud har en egen
  syntesfunktion (`scheduleRim`/`scheduleOpenHat`/`scheduleShaker`/
  `scheduleRide` m.fl.) och en egen färg i griden; MIDI-export/import
  mappar dem mot lämpliga GM-slagverksnoter (`GM_DRUM_NOTE`/
  `GM_DRUM_REVERSE`).
- **Bara ett rytmspår med ett fast kit** — inget sätt att lägga till ett
  andra rytmspår med eget kit (id:t `'rhythm'` är hårdkodat på ett
  tjugotal ställen i koden — synthesis, export, klippbord, MIDI-mappning
  m.m. — och skulle behöva generaliseras för att stödja flera
  rytmspår).

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
  (index.html:2226) som redan är porterad till `pointerdown`/`pointermove`.
  Fungerar troligen via mobilwebbläsares syntetiska mus-events, men är
  inte lika robust för pekskärm/penna som en riktig pointer-implementation.
- **Ingen metronom** och inget "count-in" vid inspelning/uppspelning.
- [x] **Svänggrad (swing)** — en Swing-reglage (0-75%) i masterraden
  (`state.swing`/`swingOffsetCols()`) fördröjer den obetonade 8:e-delen
  i varje slag mot en trioltoning vid högre värden, tillämpat vid
  uppspelning/WAV-export utan att flytta noterna i pianorullen. Gäller
  bara enkla taktarter (slag = 2 åttondelar) och bara noter/hits som
  ligger exakt på 8:e-delsgriden — finare underindelningar (16-delar,
  trioler) berörs inte. Grid snappar fortfarande strikt (1/4, 1/8, 1/16,
  triol) — det är bara uppspelningstajmingen som sväng-fördröjs, inte
  var noterna hamnar i redigeringsgriden.

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
