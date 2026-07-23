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
- [x] **FM-syntes för oscillatorerna** — ett nytt vågformsval "FM" i samma
  dropdown som Square/Triangle/Saw/Sine/NES Tri. Klassisk 2-operator-FM: en
  sinus-modulator kopplas `modulator → gain → carrier.frequency`
  (`addFmModulator()`), samma koppling som redan användes för vibrato
  (`addVibrato()`) men vid ljudfrekvens istället för ett par Hz. Två nya
  reglage — "Ratio" (modulatorns frekvens som multipel av bärvågens, 0.5–12)
  och "Depth" (0–100 %, moduleringsindex skalat mot notens egen frekvens så
  höga och låga toner får proportionerligt lika mycket sidband) — dyker bara
  upp i Envelope/Filter-panelen (nu döpt till "Envelope, Filter & FM") när
  spårets vågform är satt till FM. Depth 0 gör spåret till en vanlig sinus,
  så "neutral by default"-kontraktet gäller precis som för filtret. Sparas
  per spår (`state.fm`) i samma tre ställen som filtret
  (autosave/JSON-export, `snapshotSong`/`restoreSnapshot`, instrument-presets)
  och testat med tät notplacering + WAV-export utan fel.
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
- [x] **AudioWorklet för custom DSP** — en ny "Downsample"-effekt (lo-fi
  sample-and-hold, en klassisk chiptune-kompanjon till den befintliga
  bitcrush-effekten men för samplingsfrekvens istället för bitdjup) längst
  bak i mastersignalkedjan, innan högtalarna. Detta går inte att göra med
  någon inbyggd nod (`WaveShaperNode` formar bara amplituden per sampel,
  den kan inte hålla kvar ett sampel över flera utgångsramar) så en egen
  `AudioWorkletProcessor`-modulfil (`js/downsample-processor.js`) körs i sin
  egen audio-rendering-tråd via `audioContext.audioWorklet.addModule()` +
  `new AudioWorkletNode(ctx, 'downsample-processor', …)`. Ett "Amt"-reglage
  (0–100%) i 🎛️-panelen styr en `hold`-`AudioParam` (1–16 utgångsramar per
  hållet sampel); 0% håller varje sampel i exakt en ram, dvs. ingen
  förändring alls, samma "neutral by default"-kontrakt som resten av
  mastersteget.

  Eftersom `audioWorklet.addModule()` är asynkron men `ensureCtx()` måste
  förbli synkron (för många anropsställen använder `ctx` direkt efteråt)
  kopplas signalen inledningsvis rakt igenom (bypass) och byts sedan ut mot
  den riktiga `AudioWorkletNode`n så fort modulen har laddats
  (`ensureCrusher()`) — eftersom standardvärdet 0% låter identiskt genom
  båda vägarna märks aldrig den korta väntan i praktiken. WAV-exportens
  offline-rendering (`renderSongToWav()`) är redan `async` och kan invänta
  laddningen rent, utan bypass-trixet.

  **Bugg hittad och fixad under verifiering:** `context.createAudioWorkletNode()`
  finns inte i Web Audio API (till skillnad från `createGain()` m.fl. har
  `AudioWorkletNode` bara sin vanliga konstruktor-form,
  `new AudioWorkletNode(context, name, options)`) — det första försöket
  kraschade WAV-exporten med "createAudioWorkletNode is not a function".
- [x] **Spectrum analyzer + LUFS metering** — en ny "Meter"-grupp i
  🎛️-panelen. Spektrumvyn tappar samma post-FX `finalMix`-nod som VU-mätaren
  via en egen bredare `AnalyserNode` (`spectrumAnalyser`,
  `getByteFrequencyData()`) och ritas som 32 log-spaceade staplar på en
  `<canvas>` (log-spacing eftersom en chiptune-mix mest lever långt under
  Nyquist-frekvensen — en linjär bin-uppdelning hade lämnat det mesta av
  bredden mörk, samma resonemang som filtrets cutoff-reglage). LUFS har
  ingen inbyggd nod i Web Audio API, så en enkel ITU-R BS.1770-inspirerad
  K-viktning byggs av två `BiquadFilterNode` (high-shelf +4dB vid ~1500Hz,
  highpass vid ~38Hz) följt av en `AnalyserNode` med `fftSize 32768` (ett
  brett tidsdomän-fönster) — momentanljudstyrkan räknas ut som
  `-0.691 + 10·log10(medelkvadrat)` på det fönstret. Detta är en
  förenkling (ingen "gating" av tystnad, ingen kanalviktning för surround)
  och inte en certifierad LUFS-mätare, men ger ett rimligt "hur högt låter
  det egentligen"-närmevärde för en stereo chiptune-mix — dokumenterat i
  koden och i mätarens tooltip. Both spektrumritning och
  LUFS-uppdatering är villkorade på att 🎛️-panelen faktiskt är öppen, så
  de kostar ingenting när den är stängd.
- [x] **Parallell kompressor** — `buildMasterFXChain()`s befintliga
  EQ→kompressor-kedja grenar nu ut efter huvudkompressorn i två vägar: en
  torr (`dryGain`) och en hårt komprimerad (`parallelComp`, fasta
  inställningar — tröskel/ratio/attack/release är inte egna reglage, bara
  hur mycket av den blandas in), summerade i en delad `finalMix`-nod innan
  utgången — precis "New York"-kompressionsteknikens parallella (inte
  seriekopplade) uppbyggnad. Ett enda "Blend"-reglage (0–100%) i
  🎛️-panelen; 0% (standard) tystar den hårt komprimerade vägen helt så
  opåverkade låtar låter som förut. VU-mätaren flyttades till att tappa
  `finalMix` istället för kompressorns utgång, så den visar den verkliga
  slutsignalen inklusive den parallella blandningen.
- [x] **Sidechain support** — eftersom `DynamicsCompressorNode` saknar en
  sidokedje-ingång i Web Audio API simuleras duckningen istället genom att
  schemalägga en ren gain-envelope (`scheduleDucking()`) på en ny
  `duckGain`-nod (mellan `masterGain` och EQ/kompressor-kedjan) i takt med
  rytmspårets kick/snare-träffar — samma per-chunk-schemaläggning som
  automationskurvorna redan använder (`scheduleAutomationForChunk()`),
  eftersom rytmspårets tajming för det aktuella schemaläggningsfönstret
  redan är känd. En "Sidechain"-knapp + "Depth"-reglage i 🎛️-panelen; av som
  standard.

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

## Spår-effekter

- [x] **Delay-, Chorus- och Reverb-send per spår** — en ✨ FX-knapp i varje
  spårs header (tonalt eller rytm) öppnar en panel med tre reglage,
  `state.fxSend[track] = { delay, chorus, reverb }` (0-100%,
  `getFxSend()`/`setFxSend()`). Skickar spårets `chanGain[id]` till tre
  delade globala bussar — en tempo-synkad eko-med-feedback, en
  LFO-modulerad kort fördröjning (chorus) och en `ConvolverNode`-reverb
  som återanvänder samma genererade impulsrespons som den befintliga
  per-not-reverben (`ensureReverbImpulse()`) — vars våta signal går
  tillbaka till `masterGain`, aldrig tillbaka till `chanGain[id]` själv
  (det hade slutit en ljud-feedbackslinga genom spårets egen fader, eller
  för reverbens del låtit signalen återupprepas genom sin egen
  impulsrespons om och om igen). Eftersom alla ljud på ett spår redan
  passerar `chanGain[id]` innan `chanPan`/mastern behövdes ingen ändring
  alls i not- eller trumsyntesen (`scheduleTone`, `schedulePortamentoTone`,
  de tio `scheduleKick`/`scheduleSnare`-m.fl.-funktionerna) — det är också
  därför detta blev det första effekt-reglaget som fungerar på rytmspår.
  Separat och oberoende av de befintliga per-not-flaggorna
  Echo/Chorus/Reverb (`note.echo`/`note.chorus`/`note.reverb`), som är
  oförändrade. Reverb lades till efter Delay/Chorus i en egen omgång;
  `reverb`-fältet i `state.fxSend` är valfritt vid inläsning (default 0)
  så låtar sparade innan det fanns fortfarande laddar korrekt.
- [x] **Compressor per spår** — till skillnad från Delay/Chorus/Reverb-
  sändarna ovan är detta en insert, inte en send/return: `chanComp[id]`
  (en `DynamicsCompressorNode`) splitsas in mellan `chanGain[id]` och allt
  som tidigare tappade av den noden direkt (`chanPan[id]`, VU-mätaren,
  och de tre FX-sändarna, som nu tappar av `chanComp[id]` istället —
  `createChanComp()`/`createTrackFxSends()`). Samma fyra parametrar/
  intervall/"neutral by default"-kontrakt (`ratio: 1`) som
  master-kompressorn (`getTrackComp()`/`setTrackComp()`,
  `state.comp[track] = { threshold, ratio, attack, release }`), i samma
  ✨ FX-panel som sändarna, under en delare. Eftersom det bara sätts in i
  kanalkedjan (ingen ändring i not- eller trumsyntesen, precis som
  send-reglagen) fungerar det på rytmspår direkt.
- [x] **Delay/Chorus/Reverb-send automatiserbara över tid** — efter
  användarfeedback (skärmdump av ✨ FX-panelen bredvid den befintliga
  Automation-panelen: "kan man inte reglera procenten över tidslinjen som
  för volym?") gick vi hellre den vägen än att bara flytta de statiska
  reglagen till vänsterpanelen (7 reglage hade blivit trångt i den ~150px
  smala spalten, och hade ändå inte löst det egentliga önskemålet).
  Automation-dropdownen (som redan hade Volume/Pan) fick tre nya poster,
  `AUTOMATION_PARAMS = ['gain','pan','delay','chorus','reverb']` — hela
  den befintliga kurveditorn (`renderAutomationRow`, drag/dubbelklick,
  SVG-ritningen, `scheduleParamAutomation()`) var redan helt
  parametergenerisk, så själva utökningen blev nästan bara
  konfiguration: nya poster i `AUTOMATION_RANGE`/`AUTOMATION_LABEL`, nya
  formatterare för axel-etiketter/punkt-tooltips (`AUTOMATION_AXIS_FORMAT`/
  `AUTOMATION_POINT_FORMAT`, ersätter en `param === 'gain' ? ... : ...`
  som bara var skriven för två parametrar), tre nya rader i
  `scheduleAutomationForChunk()` som rampar `trackDelaySend[id].gain`
  m.fl. precis som volym/pan redan rampar `chanGain[id].gain`, och en
  bugg-fix i `applySavedMix()` som hårdkodade `['gain','pan']` (utan den
  hade sparade Delay/Chorus/Reverb-kurvor tystats bort vid inläsning).
  Den statiska ✨ FX-panelens reglage rördes inte alls — de fungerar
  redan som basvärde när ingen kurva finns, exakt som volym/pan-
  reglagen i spårhuvudet redan gör. Compressorns fyra parametrar är
  medvetet fortfarande bara statiska reglage (mindre naturligt att
  automatisera ratio/attack/release).
- [ ] Möjligen per-spårs **EQ**, i samma anda som master-EQ:n — enda
  kvarvarande punkten på den ursprungliga önskelistan (delay/eko,
  compressor, chorus, reverb är nu alla klara, och sändarna dessutom
  automatiserbara över tid).

## Rytmspår

- [x] **Fler slagverksljud i kittet** — utökat från 6 till 10 ljud:
  kick/snare/rim/hihat/open hi-hat/shaker/tom/clap/crash/ride
  (`RHYTHM_ROWS`/`RHYTHM_LABELS`). Varje ljud har en egen
  syntesfunktion (`scheduleRim`/`scheduleOpenHat`/`scheduleShaker`/
  `scheduleRide` m.fl.) och en egen färg i griden; MIDI-export/import
  mappar dem mot lämpliga GM-slagverksnoter (`GM_DRUM_NOTE`/
  `GM_DRUM_REVERSE`).
- [x] **Flera rytmspår (delat kit)** — en ＋ 🥁 Add rhythm track-knapp
  bredvid ＋ Add track (`addRhythmTrack()`) lägger till fler rytmspår.
  Alla delar samma fasta 10-delars kit (`RHYTHM_ROWS`/syntesfunktionerna
  är fortfarande globala) men är annars helt egna spår: egna träffar,
  egen volym/pan/mute/solo, kan tas bort (`canRemoveTrack()` — minst ett
  rytmspår måste alltid finnas) och flyttas (`moveTrack()` tillåter nu
  ombyte inom samma "kind"; tonala spår kan aldrig hoppa förbi ett
  rytmspår eller tvärtom). De dryga femtio ställena som antog exakt ett
  spår med id:t `'rhythm'` (rendering, syntesens fasta
  `chanGain.rhythm`-destination — nu en `destGain`-parameter på alla tio
  `scheduleX()`-funktionerna — urklipp, nudge, region-repeat,
  JSON-spara/ladda) generaliserades till att loopa över det nya
  `RHYTHM_TRACK_IDS` (mirror av `PITCH_TRACKS`) eller läsa det aktiva
  spårets id; undo/autosave/`snapshotSong()` behövde inga ändringar
  eftersom de redan serialiserade `trackList`/`tracks` generiskt.
  MIDI-export fungerade redan generiskt (varje rytmspår blir en egen
  namngiven MIDI-track på kanal 10); MIDI-import slår fortsatt ihop alla
  kanal-10-händelser i en fil till det första rytmspåret, eftersom GM
  inte har någon standard för att skilja flera trumspår åt inom en fil.
  "Export as code" bytte format från ett enda `RHYTHM_TRACK`-objekt till
  en `RHYTHM_TRACKS`-array (även uppdaterat i `js/song-data.js`) — ett
  medvetet formatbrott mot Frog vs Toad-spelets nuvarande kod, som ligger
  i ett separat repo utanför den här kodbasen.
- [ ] **Frog vs Toad-spelets `audio.js` behöver uppdateras manuellt.**
  Ovanstående formatbrott (`RHYTHM_TRACK` → `RHYTHM_TRACKS`) gör att en
  färsk "⤓ Export code"-output inte längre går att klistra in rakt av i
  spelets nuvarande `audio.js`, som fortfarande förväntar sig det gamla
  enstaka `RHYTHM_TRACK`-objektet. Måste göras i
  [frogger-multiplayer](https://github.com/Ruperto72/frogger-multiplayer)
  (separat repo), inte här.

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
