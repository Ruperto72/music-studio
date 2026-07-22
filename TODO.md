# TODO

Avstämning av vad som saknas i musikeditorn jämfört med README/CLAUDE.md:s
funktionslista, plus önskemål från CoPilot-genomgången och inspiration från
etablerade DAW:ar. `[x]` = klart och verifierat i `index.html`, `[ ]` =
återstår.

## Punkter från CoPilot GitHub

### Fas 1: Grundkvalitet (snabb)
- [x] **Höja samplingshastighet till 48 kHz** — `renderSongToWav()`s
  `const sampleRate` (som styr `new OfflineAudioContext(2, totalSamples,
  sampleRate)`) är nu `48000` istället för `44100`; `audioBufferToWav()`
  läser redan `buffer.sampleRate` dynamiskt så den behövde ingen ändring.
  Live-uppspelningens `AudioContext` lämnades orörd (kör enhetens egen
  standardfrekvens — att tvinga en specifik rate där kan tvinga fram
  onödig resampling hos webbläsaren).
- [x] **Voice Pooling** — `scheduleTone()`/`schedulePortamentoTone()` hämtar nu
  en `GainNode` ur en fast pool (`acquireVoice()`, 16 röster per
  destinationskanal) istället för att skapa en ny per not; oscillator-noden
  skapas fortfarande färsk per not (kan inte startas om enligt spec) men
  gain-noden — och dess koppling till kanalen/eko-bussen — återanvänds så
  fort en tidigare not på samma röst har hunnit klinga ut (`busyUntil`).
  Krossade noter (`note.crush`) undantas medvetet: bitcrush-kurvan
  (`WaveShaperNode.curve`) är en vanlig egenskap, inte en `AudioParam`, och
  kan därför inte schemaläggas för en framtida not — den får en egen
  engångs-`WaveShaperNode` precis som förut. Verifierat: 40 sekventiella
  noter i en tät testlåt skapade bara 4 `GainNode`-instanser (mot 40 utan
  pooling), demo-låten (flera spår samtidigt) spelar igenom utan fel.
- [x] **Enkel wavetable synthesis** — ett nytt vågformsval "NES Tri" bygger en
  kvantiserad/stegad triangelvåg (samma 32-stegs 4-bitars stairstep-sekvens
  som NES-ljudchippets triangelkanal) via en handskriven diskret
  Fourier-transform (`dftToPeriodicWave()`) till en `PeriodicWave`, cachad
  och applicerad med `OscillatorNode.setPeriodicWave()` — samma mönster
  som redan användes för duty-cycle-vågorna. Går att välja i den
  befintliga vågforms-dropdownen på vilket tonspår som helst.

### Fas 2: Pro-syntes (medel)
- [ ] FM-syntes för oscillatorerna (koppla en modulerande `OscillatorNode`s
  utgång direkt till bärvågens `frequency`-`AudioParam`, t.ex.
  `modulator.connect(carrier.frequency)`, istället för till en `GainNode`)
- [x] **Resonant filter per spår med envelope** — varje tonspår har nu en
  `BiquadFilterNode` (lowpass) inkopplad `osc → filter → gain → …` (även
  integrerad i röst-poolen ovan: `.frequency`/`.Q` är `AudioParam`s precis
  som gain, så filtret kan återanvändas mellan noter på samma sätt).
  Cutoff/Q/Env-reglagen bor i samma rad som ADSR-envelopen (döpt om till
  "Envelope & Filter") eftersom filterenvelopen återanvänder exakt samma
  attack/decay/sustain/release-form som redan fanns
  (`applyFilterEnvelope()`/den delade `envelopeTimes()`) — ett "Env"-reglage
  (-100%..+100%) styr hur många oktaver (upp till ±4) cutoff sveps. Cutoff
  ligger som standard vid gehörsgränsen (20 kHz, olik Q) så opåverkade spår
  låter exakt som förut. Cutoff-reglaget är log-skalat
  (`sliderToHz`/`hzToSlider`) eftersom ett linjärt Hz-reglage hade slösat
  bort det mesta av sitt spann på den översta oktaven. Sparas per spår
  (`state.filter`) och ingår nu även i instrument-presets.
- [x] **Aux-send system för reverb** — en ny per-not "Reverb"-effekt (bredvid
  Bitcrush/Echo/Chorus i noteditorn), som skickar noten till en delad
  `ConvolverNode`-reverb-buss per kanal (`ensureReverb()`), parallellt med
  torrsignalen — precis den send/aux-arkitektur som efterfrågades, till
  skillnad från dagens `echo`-effekt (fortfarande en seriekopplad
  `DelayNode`, oförändrad). Impulsresponsen är genererad (inga ljudfiler i
  appen): exponentiellt avklingande stereo-vitt brus
  (`ensureReverbImpulse()`), en vanlig algoritmisk-reverb-teknik. Integrerad
  i röst-poolen via ett `reverbSend`-gain per röst, samma mönster som den
  redan existerande eko-sänden.

  **Bugg hittad och fixad under verifiering:** `ConvolverNode.buffer` kräver
  (till skillnad från `AudioBufferSourceNode`, som resamplar automatiskt) att
  bufferns samplingsfrekvens exakt matchar kontextens. Eftersom
  `renderSongToWav()` bara nollställer de kontext-bundna cacharna
  (`noiseBuffer`/`pulseWaves`/`nesTriWave`/`chanDelays`/`chanReverbs`/m.fl.,
  nu samlade i `resetAudioCaches()`) via `stopPlayback()` — som bara körs OM
  `playing` redan var sant — kunde en tidigare live-förhandslyssning (annan
  samplingsfrekvens) lämna en cachad reverb-impulsrespons som kraschade
  WAV-exporten (`new OfflineAudioContext(... 48000)`) med "buffer sample
  rate ... does not match the context rate". Fixat genom att
  `renderSongToWav()` nu alltid nollställer cacharna innan den skapar sin
  offline-kontext, oavsett `playing`-läge.

### Fas 3: Pro-mixing (långsamt)
- [ ] AudioWorklet för custom DSP (`audioContext.audioWorklet.addModule()` +
  en separat `AudioWorkletProcessor`-modulfil som körs i sin egen
  audio-rendering-tråd, ansluten via `AudioWorkletNode`)
- [ ] Spectrum analyzer + LUFS metering (`AnalyserNode.getByteFrequencyData()`/
  `getFloatFrequencyData()` — samma nodtyp som redan driver VU-mätarna —
  för spektrumvyn; LUFS har ingen inbyggd nod utan kräver egen
  ITU-R BS.1770-loudness-beräkning ovanpå `AnalyserNode`- eller
  `AudioWorkletProcessor`-samples)
- [ ] Parallell kompressor (två parallella `GainNode`-vägar — en torr, en
  hårt komprimerad via `DynamicsCompressorNode` — summerade i en delad
  buss, inte en seriekopplad insert)
- [ ] Sidechain support (`DynamicsCompressorNode` saknar en inbyggd
  sidokedje-ingång i Web Audio API; måste simuleras genom att schemalägga
  `GainNode.gain`-duckning i takt med triggerspårets kick/snare-träffar,
  vilket redan går eftersom rytmspårets tajming är känd i förväg)

### Fas 4: Samplingar & kolaborering
- [ ] Sample playback + granular syntes (`AudioBufferSourceNode` +
  `decodeAudioData()` för att ladda/spela upp egna ljudfiler, med
  `.loop`/`.playbackRate`; granular syntes byggs av många korta,
  överlappande `AudioBufferSourceNode`-korn schemalagda via upprepade
  `start()`-anrop, eller en dedikerad `AudioWorkletProcessor`)
- [ ] Cloud sync och live collaboration — se "Lagring / delning" nedan
  (inte en Web Audio-fråga, utan nätverk/lagring)

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
- [x] **Rytm-mallar** — en 🥁-knapp i rytmspårets header öppnar en dialog
  med sju inbyggda en-takts-grooves (`RHYTHM_PATTERNS`): Rock, Techno,
  Disco, Swing/Shuffle, Hip-Hop, House, Breakbeat. Varje mall har en
  ▶-förhandslyssning och en Insert-knapp som lägger in mallen upprepad
  från speakerhuvudets takt till låtens slut (ersätter det som låg där;
  det som ligger före speakerhuvudet rörs inte). Mallarna är skrivna för
  4/4 (8 åttondelar/takt) och skalas mot `eighthsPerBar()` för andra
  taktarter. Swing/Shuffle-mallen sätter även Swing-reglaget till 60% för
  den klassiska "spang-a-lang"-känslan.

## Inspirerat av etablerade DAW:ar (Pro Tools m.fl.)

Genomgång av vad ett "riktigt" DAW (Pro Tools, Ableton, FL Studio) har som
denna editor saknar. Prioritetsordning nedan är en rekommendation, inte
ett facit.

- [ ] **Metronom + count-in** — inget stöd vid inspelning/uppspelning; en av
  de mest lågt hängande frukterna, se även "Interaktion / touch" nedan.
- [x] **EQ/kompression på mastern** — 🎛️-knappen i mastersektionen öppnar
  ett litet panel med 3-bands-EQ (low/mid/high shelf/peak,
  `BiquadFilterNode`) och en kompressor (`DynamicsCompressorNode`),
  inkopplade sist i mastergrafen (mastergain → EQ → komp → destination,
  och VU-mätaren tappar post-FX). Standardvärden är helt neutrala (0dB,
  ratio 1:1) så gamla låtar utan dessa fält låter exakt som förut.

## Ljud / export

- [ ] **Kodexport kräver manuell copy.** `#export`-knappen fyller en
  `<textarea id="exportBox">` (tofflar den synlig/dold vid upprepade
  klick) och markerar texten — men saknar en "Kopiera"-knapp
  (`navigator.clipboard`) eller nedladdning av filen direkt.

## Rytmspår

- [x] **Fler slagverksljud i kittet** — utökat från 6 till 10 ljud:
  kick/snare/rim/hihat/open hi-hat/shaker/tom/clap/crash/ride
  (`RHYTHM_ROWS`/`RHYTHM_LABELS`). Varje ljud har en egen
  syntesfunktion (`scheduleRim`/`scheduleOpenHat`/`scheduleShaker`/
  `scheduleRide` m.fl.) och en egen färg i griden; MIDI-export/import
  mappar dem mot lämpliga GM-slagverksnoter (`GM_DRUM_NOTE`/
  `GM_DRUM_REVERSE`).
- [ ] **Bara ett rytmspår med ett fast kit** — inget sätt att lägga till ett
  andra rytmspår med eget kit (id:t `'rhythm'` är hårdkodat på ett
  tjugotal ställen i koden — synthesis, export, klippbord, MIDI-mappning
  m.m. — och skulle behöva generaliseras för att stödja flera
  rytmspår).

## Spårhantering

- [x] **Omordning av spår** — små ▲/▼-knappar i varje tonspårs header
  (`moveTrack()`) byter plats på spåret med sin granne i `state.trackList`.
  Rytmspåret ligger alltid sist och kan varken flyttas eller flyttas förbi
  (samma invariant som `addTrack()` redan höll), så det får inga
  omordningsknappar alls. Ordningen sparas/laddas som vanligt eftersom den
  bara är `state.trackList`s ordning.
- [x] **Sparade instrument-presets** — en 🎚-knapp per tonspår öppnar en
  dialog (`preset-dialog`, samma list-mönster som låtbiblioteket) där man
  kan spara spårets nuvarande vågform + ADSR-envelope under ett namn och
  senare applicera det namngivna presetet på vilket tonspår som helst, i
  vilken låt som helst. Sparas i `localStorage`
  (`music-studio-instrument-presets`), oberoende av enskilda låtar.

## Interaktion / touch

- [x] **Not-redigering porterad till Pointer Events** — alla drag-gester
  (`startMoveNote`, `startResize`, `startMoveHit`, `startMarquee`,
  `startScrub`, `startLoopDrag`, `startAutomationDrag`) använder nu
  `pointerdown`/`pointermove`/`pointerup` istället för mus-events, samma
  mönster som scrollbaren redan hade. Varje drag filtrerar inkommande
  `pointermove`/`pointerup` på `event.pointerId` så två samtidiga
  pekpunkter (multi-touch) inte kan störa varandras drag. `touch-action:
  none` lades till på de små, alltid-drag-avsedda ytorna (`.note`,
  `.note .handle`, `.hit`, `.automation-point`, `.playhead-grip`,
  `.loop-handle`, `.ruler-cell`) så webbläsarens inbyggda pan/scroll inte
  konkurrerar med draget på pekskärm/penna — medvetet INTE på `.lane`
  (griden i sig), eftersom marquee-drag där bara är aktivt i
  grab-verktyget och en bredare `touch-action:none` hade blockerat
  vanlig touch-scroll över griden i penn-läget.
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

- [ ] **Bara lokalt.** Sparade låtar ligger i `localStorage` i webbläsaren;
  det finns ingen delning via länk/URL eller molnsynk mellan enheter.
- [ ] **Ingen kollaborativ redigering** (flera personer på samma låt samtidigt).

## Kvalitet

- [ ] **Inga automatiska tester.** CLAUDE.md bekräftar att det inte finns
  build/lint/test-kommando — all verifiering är manuell i webbläsaren.
- [ ] **Ingen tillgänglighetsgenomgång** utöver enstaka `aria-*`-attribut på
  knappar; ingen skärmläsarväg för själva pianorullen/rytmgriden.

## Övrigt (mindre, ej verifierat som blockerande)

- [ ] Endast engelskt UI (`<html lang="en">`) — ingen lokalisering.
- [ ] Inget MIDI-/USB-tangentbordsstöd för att spela in noter live
  (ingen `navigator.requestMIDIAccess`/Web MIDI-kod i källan).
