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

- [x] **Ackord i pianorullen** — spåren och ljudmotorn klarade polyfoni sedan
  länge (`songs/cinematic.json`s Strings-spår har tre noter per ackord, och
  `VOICE_POOL_SIZE` är uttryckligen tilltagen "generous for chords/arps"),
  men det gick inte att *skapa* ett ackord från editorn: varje ställe som
  la till/flyttade/storleksändrade en not behandlade "vilken annan not som
  helst som överlappar i tid, oavsett tonhöjd" som något att radera.
  Ackorden i exempelsångerna fanns bara för att de handskrivits direkt i
  JSON. Två delar: (1) all överlappslogik är nu **tonhöjdsmedveten** — en
  not krockar bara med en annan not på *samma* tonhöjd som överlappar i
  tid, vilket är exakt vad ett ackord inte är. `clearOverlaps()` fick en
  `freq`-parameter, och de tre ställen som hade egna inline-kopior av
  tidsfiltret (`nudgeSelection`, `startMoveNote`s pointerup,
  `startResize`s `maxLen` via `nextNoteStart`) fick samma villkor.
  Rytmspår är oberörda — hits är redan nycklade på `type` (vilken rad), så
  två hits i samma kolumn samexisterar över rader sedan tidigare. (2) Ett
  nytt **Chord**-fält i notinspektorn med "Add Major/Minor Chord" som
  lägger till riktiga, separata noter på tersen och kvinten vid samma
  start/längd — till skillnad från Arpeggio-knapparna ovanför, som bara
  sätter en flagga på den enda noten så att den sveper genom ackordtonerna
  i snabb följd. Kantfall vid tonhöjdstaket: om ett intervall klampas mot
  `MIDI_MAX` och landar på en tonhöjd som redan låter (grundtonen, eller
  den andra ackordtonen när båda klampas dit) hoppas den över istället för
  att staplas som en exakt dubblett — `clearOverlaps()` kan inte fånga det
  själv, eftersom den skyddar grundtonen via `exceptIdx` och aldrig ser de
  nya syskontonerna, som ännu inte ligger i spårets array. Ligger
  grundtonen exakt på taket blir knappen en no-op istället för att stänga
  inspektorn i onödan. Tre nya steg i `verify.js` täcker Pen-ackord,
  Add Major Chord, upprepat klick på samma grundton, och taket-fallet
  (verifierat att taket-testet faktiskt fäller den ostädade koden).

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

- [x] **Tre nya vågformer: brus, ringmodulering och half-sine.** Nio totalt nu,
  över två rader i väljaren (nio på en rad hade gett ~19px per knapp, för litet
  för att formen ska gå att läsa; ett femkolumnsrutnät ger ~35px, bredare än de
  sex var).
  - **Noise** var den enda som faktiskt *saknades* — varje klassiskt ljudchip
    har en bruskanal, och appen hade brusbuffertar för trummorna men inget sätt
    att skriva en brusslinga på ett tonalt spår. Den är en loopad 93-sampels
    buffert (NES:ens korta LFSR-period, det som gör att det läget surrar på en
    tonhöjd i stället för att bara väsa), spelad med en `playbackRate` som får
    loopen att gå runt på notens frekvens.
  - **Ring** är en bärvåg multiplicerad med en andra oscillator via en
    `GainNode` vars eget värde ligger på 0 — modulatorn svänger den mellan −1
    och +1, så utsignalen blir produkten och inte den ena som tonar den andra.
    Den återanvänder FM:s Ratio-reglage i Envelope-panelen.
  - **Half sine** är en av OPL2:s operatorvågformer: sinusens positiva halva,
    negativa halvan platt. Till skillnad från ren sinus har den jämna
    övertoner, så den låter ihålig och rörlik.

  **Brus passade inte formen.** De andra åtta är oscillatorer och exponerar
  tonhöjd i Hz på `frequency`; brus är en buffertkälla vars `playbackRate` är i
  en helt annan enhet. Lösningen blev `createVoiceSource()`, som returnerar
  `toPitch` — en omvandling från Hz till källans enhet. Att bägge
  avbildningarna är **linjära** i frekvens är hela skälet till att bend,
  arpeggio, vibrato och FM fungerar på brus utan en andra kopia av
  schemaläggningen: absoluta mål omvandlas direkt, och djup uttryckta som en
  andel av notens egen frekvens omvandlas med samma faktor.

  Två saker som mätningen gav och gissningen inte hade:
  1. **Brus låg 5 dB över de andra** (topp 0.39 mot square 0.22) — att byta
     till Noise hoppade i nivå. Bufferten skalas nu till 0.57.
  2. **FM hashar identiskt med Sine**, vilket först såg ut som en bugg men är
     korrekt: FM:s default-djup är 0, alltså en ren sinus. Testet asserterar
     numera det uttryckligen i stället för att hoppa över det.
- [x] **PWM som tionde vågform.** Fyller den sista platsen i väljarens
  femkolumnsrutnät (tio = exakt två fulla rader). Vald för att den är det enda
  som **rör klangfärgen över tid**: vibrato rör tonhöjd, tremolo rör volym,
  FM-djupet är statiskt per spår, och `square`s duty är ett fast värde. Det är
  svepet som får en chip-lead att sjunga i stället för att stå still.
  Byggd med det klassiska analogtricket — en sågtand minus en fördröjd kopia av
  sig själv är ett pulståg vars bredd är fördröjningen, så en LFO på
  `delayTime` sveper bredden.
  **Den risk jag flaggade försvann under planeringen.** Jag skrev att två
  fasläsade sågtänder var den stora osäkerheten, eftersom Web Audio inte lovar
  att två oscillatorer startade samtidigt ligger i fas. Men den fördröjda vägen
  behöver inte en andra oscillator — den kan matas från *samma*, split i två
  grenar. Då är fasen exakt per konstruktion i stället för något att mäta och
  hoppas på. Värt att minnas: den risken var inte värd att acceptera, den var
  värd att designa bort.
  Två saker mätningen gav:
  1. **Nivån var 4,4 dB för låg** med min gissade skalning 0.62 (topp 0.134 mot
     square 0.223) — jag hade gissat åt fel håll, i tron att saw-minus-saw
     svänger bredare. 0.85 ger 0.184, alltså 1,7 dB från square.
  2. **Svepet bekräftat på en hållen not:** duty rör sig monotont 0.44 → 0.285
     över noten. Första mätningen såg rörig ut, men det var mätfelet — jag hade
     lagt 24 *separata* noter, så måttet läste över notgränser och tystnader.
  Svepet startar om vid varje not, som per-not-vibratot gör. Ett fritt löpande
  svep per spår vore en annan och större ändring. (Gjord — se nästa punkt.)
  Testet asserterar inte duty-kurvan (för brusigt mått för att lita på) utan
  **kopplingen** — att en LFO når `delayTime` — på samma sätt som vibrato-steget
  kollar att en LFO når `osc.frequency`. Det tog två försök: först krävde jag
  att *bara* PWM modulerar en delayTime, men chorus-bussen gör det legitimt vid
  varje rendering, så baslinjen är inte noll. Nu jämförs PWM mot den baslinjen.
- [x] **Fritt löpande PWM-svep per spår.** En LFO per kanal (`chanPwmLfo`),
  startad när kanalen byggs och aldrig omstartad; varje `pwm`-not skalar den
  till sin egen period genom en egen `GainNode` i stället för att skapa en egen
  oscillator. Ett spår utan kanal (inspektorns förhandslyssning) faller tillbaka
  på en not-lokal LFO.
  **Mätningen bekräftade problemet exakt.** Åtta noter i rad, duty läst ur PCM
  (saw-minus-fördröjd-saw är en rektangel vars positiva del varar (1 − duty) av
  perioden, så andelen positiva sampel ger duty direkt):
  - *Före:* 0.533 0.537 0.537 0.537 0.521 0.521 0.521 0.521 — spridning 0.016,
    samma som en ren fyrkantvågs mätbrus. Svepet fanns bara på papperet för
    korta noter.
  - *Efter:* 0.735 0.734 0.537 0.297 0.596 0.721 0.521 0.279 — spridning 0.456,
    alltså hela svepet.
  **Två saker jag hade fel om, båda fångade av mätning:**
  1. **Nivån.** Jag flaggade risken att fritt löpande svep gör noterna hetare,
     och det stämde: 0.85 gav topp 0.253 mot de andra nio vågformernas
     0.210–0.224, alltså ~1,1 dB över den högsta. En smal puls *toppar* 1,5×
     högre än en fyrkantvåg men dess RMS är 1,25 dB *lägre*, så de två ändarna
     drar åt olika håll. `PWM_LEVEL` är nu 0.75 — mittpunkten mellan att matcha
     topp i ytterlägena (0.65) och RMS i mitten (0.85) — och mäter 0.224, mitt
     i klungan.
  2. **Var frånkopplingen hör hemma.** Första versionen släppte notens uttag på
     den delade LFO:n i `stop(t)`. Men `stop(t)` anropas vid *schemaläggning*
     med ett framtida `t`, så den hade kopplat bort svepet innan noten ens
     hördes. Rätt hake är oscillatorns eget `ended`-event.
  Testet asserterar den här gången beteendet, inte kopplingen: åtta noter,
  duty ur PCM, spridningen måste överstiga 0.2 (mot 0.016 för den gamla koden)
  och ingen not får hamna utanför 25–75 %-svepet.
- [x] **Bugg från PR #84: portamento fick aldrig spårets Duty.** Jag skrev då
  att vågformsvalet var handskrivet på tre ställen och nu låg i en funktion.
  Det var fyra, och `schedulePortamentoTone` hade kvar sin kopia — som dessutom
  läste `note.duty` direkt i stället för `effectiveDuty()`, så spår-defaulten
  nådde aldrig en glidande not. Nu går den genom `createVoiceSource()` som
  alla andra.
  Testet för det tog två försök att få rätt: första versionen klickade på noten
  för att spela den, men **klick spelar förhandslyssningen, som går via
  `scheduleTone`** — inte portamento-schemaläggaren, som bara körs vid riktig
  uppspelning. Den versionen passerade glatt med buggen medvetet återinförd.
  Den trycker på Play nu.

- [ ] **Kodexport kräver manuell copy.** `#export`-knappen fyller en
  `<textarea id="exportBox">` (tofflar den synlig/dold vid upprepade
  klick) och markerar texten — men saknar en "Kopiera"-knapp
  (`navigator.clipboard`) eller nedladdning av filen direkt.
- [x] **Neon Cathedral knastrade — den klippte.** Mätt, inte gissat: genom att
  patcha `OfflineAudioContext.prototype.startRendering` och läsa
  float-bufferten *före* 16-bitars-avrundningen låg sann topp på **1.2895
  (+2.21 dBFS)** med 1070 sampel över 1.0 (680 klippta i WAV-filen, längsta
  serien 38 sampel) — allt inom Climax-avsnittet (takt 41–56, tätast med 47
  händelser per takt). Låten hade högst summerad spårvolym av alla medföljande
  (5.45) och `masterVol: 0.5`; masterbussens EQ-boost och den parallella
  kompressionsblandningen ovanpå det tryckte den över taket. Fixad genom att
  sänka enbart `masterVol` till **0.26** (0.25 vore snarlikt men ligger inte på
  reglagets `step="0.02"`-rutnät, så det skulle visas som 0.26 ändå): fyra
  renderingar gav −1.5 till −2.3 dBFS med **noll** sampel över.
  Sänkningen är inte linjär — masterkompressorn ligger efter `masterGain`, så
  lägre insignal ger mindre kompression; 0.38 och 0.34 klippte fortfarande.
  Två saker undersöktes och avfärdades: sidechain-duckningen var *inte*
  orsaken (stängd av blev det värre — klippningen gick från 680 till 1316
  sampel, duckningen höll alltså tillbaka nivån), och de "diskontinuiteter"
  som först såg ut som defekter var master-bitcrushen (`masterCrush.amount:
  0.06` → håll 2 sampel) som gör exakt vad den är inställd på.
- [x] **Allt brus är seedat.** Punkten skrevs om
  reverb-impulsen, men den var inte den enda källan: `Math.random()` fyllde
  *tre* buffertar — impulssvaret plus de två trumbrusbuffertarna
  (`ensureNoiseBuffer()` för hi-hat/virvel/rim/shaker,
  `ensureCrashNoiseBuffer()` för crash/öppen hi-hat/ride). Att bara seeda
  reverbet hade alltså inte gett bitidentiska exporter, som var hela poängen.
  Alla tre fylls nu från `mulberry32()`-strömmar med fasta seeds.
  **Varje buffert får en egen generator**, inte en delad ström: en delad hade
  gjort varje bufferts innehåll beroende av vilka andra som råkat byggas
  först, och den ordningen varierar med vilka ljud en låt faktiskt använder —
  en låt utan crash hade fått ett annat reverb. Reverbet får dessutom en egen
  ström per kanal, annars blir de två kanalerna identiska och svansen låter
  mono. `mulberry32` använder bara `Math.imul` och `>>>`, bägge exakt
  specificerade, så strömmen blir densamma i alla motorer.
  Beteendeändringen är värd att notera: reverbet låter nu som *en bestämd*
  slumpsekvens i stället för vilken man råkade få den här sidladdningen. Ingen
  kunde ha förlitat sig på en viss, eftersom den ändrades varje gång — men det
  betyder också att en låt kan låta aningen annorlunda än den gjorde vid ett
  specifikt tillfälle.
- [x] **Skillnaden mellan två renderingar är mätt: den är ohörbar.**
  Uppföljning på punkten nedan. Jag visste att skillnaden fanns men inte hur
  stor den var, vilket är det som avgör om den betyder något. Mätt genom att
  behålla första renderingens buffert och jämföra sampel för sampel mot den
  andra (`Popcorn`, 92 s, 8,8 miljoner sampel):
  - **I flyttalsbufferten:** största enskilda avvikelse ≈ 1·10⁻⁴, alltså
    **−79 dBFS**; avvikelsens RMS ≈ 9·10⁻⁷, alltså **−121 dBFS**. Det är
    **104 dB under signalen** och överstiger aldrig 10⁻³.
  - **I den exporterade 16-bitars-filen:** **0,075 %** av samplen skiljer sig
    (6 617 av 8 832 000), och som mest med **4 LSB av 32767**.
  Slutsats: filerna är *inte* bitidentiska, men de är **hörbart identiska**.
  −121 dBFS RMS ligger ~25 dB under 16-bitarsformatets eget brusgolv. Det här
  är numeriskt brus i sista bitarna, inte en annan mixning — så det är en
  kuriositet, inte en defekt. Punkten nedan står kvar som beskrivning av vad
  som uteslöts, men den är inte värd att jaga vidare om inte avvikelsen växer.
  (Andelen *flyttal* som skiljer sig varierade själv mellan körningarna, 15 %
  respektive 31 %, vilket är precis vad man väntar sig av en liten kaotisk
  numerisk effekt snarare än av ett systematiskt fel.)
  Sidofynd: `Popcorn` toppar på **+0,4 dBFS** med 3 klippta sampel av 8,8
  miljoner. Långt ifrån Neon Cathedrals 680, och ohörbart — men det blev
  ingången till headroom-genomgången nedan.
- [x] **Headroom-genomgång av alla sju medföljande låtar.** Varje låt renderad
  offline, sann topp avläst i flyttalsbufferten *före* 16-bitars-klampningen,
  plus antal sampel över fullskala och längsta obrutna serie. Den sista siffran
  är den som avgör om något faktiskt låter förvrängt — en enstaka topp hörs
  inte, en serie på tjugo gör det.
  **Fyra av sju klippte**, och Neon Cathedral var inte den värsta:

  | låt | masterVol | topp före | över före | längsta | → masterVol | topp efter | över efter |
  |---|---|---|---|---|---|---|---|
  | Cinematic | 0.50 | +3.14 dB | 933 | 16 | **0.30** | −1.13 dB | 0 |
  | Froggy Hop | 0.50 | +2.31 dB | 264 | 27 | **0.34** | −0.93 dB | 0 |
  | Techno | 0.50 | +1.42 dB | 12 | 1 | **0.38** | −0.89 dB | 0 |
  | Popcorn | 0.45 | +0.41 dB | 3 | 1 | **0.38** | −1.01 dB | 0 |
  | Neon Drive | 0.45 | −0.67 dB | 0 | 0 | 0.46 | −0.48 dB | 0 |
  | Deep Vacuum | 0.45 | −1.09 dB | 0 | 0 | 0.46 | −0.94 dB | 0 |
  | Neon Cathedral | 0.26 | −3.54 dB | 0 | 0 | — | −3.54 dB | 0 |

  `Cinematic` klippte alltså värre än `Neon Cathedral` gjorde före sin fix (933
  sampel mot 680, +3.14 mot +2.21 dBFS), och `Froggy Hop` hade serier på 27
  sampel i följd. Bägge är dessutom bland de första låtar någon öppnar.
  **Till skillnad från Neon Cathedral skalade de här linjärt.** Den låten har
  en kompressor på masterbussen, så lägre insignal gav mindre kompression och
  sänkningen krävde tre försök; de fyra här har helt neutral masterbuss (ratio
  1:1, platt EQ, ingen parallellblandning), så toppen är proportionell mot
  `masterVol`. Förutsagt 0.861/0.887/0.895/0.886, uppmätt 0.878/0.899/0.903/
  0.890 — modellen höll, men den *kontrollerades* innan värdena fick stå kvar.
  Två val värda att stå för: `Techno` och `Popcorn` var i praktiken ohörbara
  (12 respektive 3 isolerade sampel, längsta serie 1) och sänktes ändå, för att
  "ingen medföljande låt går över 0 dBFS" är en regel som går att upprätthålla
  medan "lite klippning är okej" inte är det — det kostar dem ~2 dB nivå. Och
  `Neon Drive`/`Deep Vacuum` klippte inte alls men lagrade 0.45, vilket ligger
  utanför masterreglagets `step="0.02"`-rutnät och visas som 0.46; nu lagrar de
  0.46, alltså exakt vad reglaget redan visade. Samma skäl som gjorde att Neon
  Cathedral hamnade på 0.26 i stället för 0.25.
  Kvar att fundera på: `Neon Cathedral` ligger nu klart lägst av alla (−3.54
  dBFS topp), eftersom dess värde sattes innan det fanns någon uppsättning att
  jämföra mot. Den skulle tåla en höjning, men kompressorn gör det olinjärt så
  det kräver ny mätning — inte gjort.
- [ ] **Var den återstående avvikelsen kommer ifrån är fortfarande okänt.** När jag
  seedade bruset skrev jag att exporten därmed blev reproducerbar. Det stämde
  inte, och jag hann skriva in det i README och DESIGN innan jag hade
  end-to-end-beviset (bägge är rättade nu). Två fullständiga exporter av samma
  låt skiljer sig fortfarande — **även två i rad i samma sidladdning**, vilket
  visar att det som återstår sitter i själva renderingen och inte i vad sidan
  bygger vid uppstart.
  Vad mätningen visar för `Popcorn` (92 s): de första 6 sekunderna är exakt
  lika, sedan skiljer sig 36 av 92 sekunder. Alltså ingen genomgående
  nivåskillnad, utan något som slår till för vissa ljud.
  **Uteslutet, med mätning:** de seedade buffertarna (hashade *under* varje
  rendering — bitidentiska, så seedningen gör exakt vad den ska),
  AudioWorklet-nedsamplaren (blockerad modulladdning → 0 worklets, ändå olika),
  `ConvolverNode` (ersatt med en gain-nod, ändå olika), `DynamicsCompressorNode`
  (likaså) och röstpoolningen (`acquireVoice` tvingad att returnera null, ändå
  olika). Och: **två enkla toner i ett tomt projekt renderas identiskt**, så
  webbläsarens offline-rendering är reproducerbar i sig — det är något låten
  använder som inte är det.
  Kvar att undersöka: per-not-effekterna (echo/chorus/crush-vägarna),
  sidechain-duckningen, automationsramperna, och trumschemaläggningen.
  Storleken *är* nu mätt — se punkten ovan; den är ohörbar, vilket gör det här
  till en öppen nyfikenhetsfråga snarare än en bugg. Skripten som användes
  ligger inte i repot; de renderar en låt två gånger och jämför dels
  FNV-hashar per kanal och per sekund, dels sampel för sampel.

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
- [x] **Bitcrush och Tremolo per spår** — efter en fråga om vilka av
  per-not-effekterna (bend/vibrato/duty/arpeggio/portamento/bitcrush) som
  skulle passa som spår-nivå-effekt, valde vi de två som redan har
  precedens i koden som "hel-kedja"-effekter snarare än ren
  not-artikulation: bitcrush finns redan som en master-bus-insert
  (`DEFAULT_MASTER_CRUSH`, `ensureCrusher()`), och tremolo är ett klassiskt
  helspårs-pedal-insert i riktiga mixerkedjor. Bend/vibrato/duty/arpeggio/
  portamento är genuint per-not-artikulation och fick ingen spår-variant.
  Båda är inserts i samma kedja som Compressorn:
  `chanGain[id] → chanComp[id] → chanCrush[id]? → chanTremolo[id] →
  chanPan[id]/VU-mätaren/de tre FX-sändarna` — sändarna och VU-mätaren
  tappar nu av `chanTremolo[id]` (kedjans sista led) istället för
  `chanComp[id]` direkt, så en crushad/tremolo:ad signal hörs korrekt även
  i sändarna och mätaren. Bitcrush (`state.crush[track] = { amount }`,
  `getTrackCrush()`/`setTrackCrush()`) återanvänder samma
  `AudioWorkletProcessor`/formel som master-crushern
  (`crushAmountToHold()`, `js/downsample-processor.js`) — en instans per
  spår istället för en för hela mixen, med samma bypass-tills-laddad-dans
  (`ensureTrackCrusher()`, jfr `ensureCrusher()`) eftersom `ensureCtx()`
  måste förbli synkron. Tremolo (`state.tremolo[track] = { rate, depth }`,
  `getTrackTremolo()`/`setTrackTremolo()`) är en LFO kopplad till en vanlig
  `GainNode`s egen `.gain`-`AudioParam` (`createChanTremolo()`) — samma
  knep som chorus-bussen redan använder på `delayTime`, fast på gain;
  `depth: 0` gör svängningen till noll så gain ligger fast på exakt 1
  (rate då irrelevant), och vid `depth: 1` svänger gainen mellan 0 (tyst)
  och 1 (spårets egen nivå), aldrig högre — klassiskt förstärkar-tremolo-
  beteende. Independent av per-not-flaggan `note.crush` (en fast
  16-stegs-`WaveShaperNode`, inget reglerbart "amount"); ingen
  per-not-motsvarighet till tremolo finns alls. Båda är medvetet bara
  statiska reglage (som Compressorn), inte automatiserbara över tid.
- [x] **✨ FX-panelen flyttad in i spårhuvudet** — efter feedback (skärmdump)
  om att Delay/Chorus/Reverb/Compressor/Crush/Tremolo-reglagen låg ute på
  samma yta som pianorullen/rytmgriden: "Kan dessa placeras på samma
  ställe som volym och pan-reglagen? Typ när man klickar på fx-knappen
  så expanderade den ytan." Till skillnad från Automation/Envelope (som
  båda genuint behöver pianorullens bredd — en kurva ritas mot
  tidslinjens kolumner, `renderAutomationRow()`/`renderAdsrRow()`) är
  varje FX-reglage bara ett statiskt per-spårs-värde utan tidsaxel, så
  det fanns ingen teknisk anledning att panelen låg i den breda ytan —
  den hamnade där bara för att den återanvände samma "extra
  `.track`-rad"-mekanik som redan fanns. `renderFxSendRow()` (en hel
  bred rad) ersattes av `buildFxPanel()` (ett kompakt rutnät med 2
  kolumner, `.th-fx-panel`) som byggs in direkt i `buildHeader()`s
  vänsterkolumn — headerns höjd expanderar helt enkelt nedåt när man
  klickar ✨ FX, precis som efterfrågat, istället för att lägga till en
  rad. Samma 10 fält/samma logik (`getFxSend`/`setTrackComp`/
  `getTrackCrush`/`getTrackTremolo` m.fl., `apply*()`, `autosave()`)
  återanvänds oförändrat — bara renderingen skrevs om, ingen ändring i
  ljudgrafen. En liten `addFxField()`-hjälpfunktion konsoliderar det
  som tidigare var fyra nästan identiska fält-byggande loopar.
- [x] **Per-spårs EQ** — sista punkten på den ursprungliga önskelistan
  (delay/eko, compressor, chorus, reverb, bitcrush och tremolo var redan
  klara). Tre biquads per kanal med samma band som master-EQ:n (200Hz
  low shelf, 1kHz peak, 4kHz high shelf, ±12dB), placerade **först** i
  insert-kedjan: `chanGain[id]` → `chanEq[id]` → `chanComp[id]` → …, så
  kompressorn reagerar på den formade signalen i stället för råsignalen —
  vanlig konsolordning. `TRACK_FX_REGISTRY` gjorde jobbet den byggdes för:
  en tabellrad gav både panel-UI, inläsning/validering och Reset gratis;
  bara ljudgrafen (`createChanEq()`/`applyTrackEq()`) och Song I/O:s
  handskrivna objektliteraler behövde röras. Två detaljer värda att minnas:
  `chanEq[id]` är ett `{low, mid, high}`-objekt och inte en nod, så
  `removeTrack()`s generiska `disconnect()`-loop kan inte städa den — den
  hanteras explicit. Och formateringen följer master-EQ:ns `6.0dB` i
  stället för `+6.0dB`; ett `+` på boost hade varit lite tydligare på en
  bipolär kontroll, men två olika dB-format i samma app är värre.
  Verifierat att de verkliga `BiquadFilterNode`-instanserna får rätt
  gain genom att patcha `createBiquadFilter` före sidladdning — DOM-testet
  ser bara reglagen, inte ljudgrafen.

### Luckor mellan per-not och per-spår

Efter en genomgång av bägge uppsättningarna: fem effekter finns på bägge
ställena (Tremolo, Bitcrush, Chorus, Reverb, och per-notens Echo mot
spårets Delay), men aldrig som samma implementation — per not är de
binära flaggor med hårdkodade värden, per spår reglerbara sends/inserts,
och de är avsiktligt additiva (se `TRACK_FX_REGISTRY`). Det som återstår
är asymmetrierna, i den ordning de bedöms vara värda att bygga:

- [x] **Velocity per trumslag.** Rytmspår hade inget per-not-lager alls:
  `state.selected` sattes bara från tonala notvägar, så ett slag öppnade
  aldrig inspektorn. Nu är slag valbara (klick, penna, Shift+piltangent) och
  får en egen kort inspektorpanel — trumma, takt/slag, **Velocity** (10–100%,
  samma intervall/steg/format som den tonala) och Radera. Det är hela listan
  med flit: ett slag har varken tonhöjd, längd eller per-not-flaggor, och för
  trummor bor de effekterna på spårets ✨ FX-panel ändå.
  Tre saker gjordes medvetet:
  1. **`vel` saknas = full.** Inspektorn *tar bort* egenskapen vid 100% i
     stället för att skriva `vel: 1`, så en låt som aldrig rört velocity
     serialiseras byte för byte som förut. `hitVel()` är enda läsaren och
     klampar där, så en handredigerad fil inte kan ge en trasig gain.
  2. **En anropspunkt, inte tio.** All uppspelning går genom
     `scheduleDrum(type, startAt, destGain, vel)`, som lägger velocity som en
     vanlig `GainNode` framför destinationen. Att i stället tråda ett
     `vel`-argument in i de tio schemaläggarna hade betytt att skala varje
     `exponentialRampToValueAtTime` för hand — snaran har två envelopper,
     klappen tre — alltså tio chanser för samma faktor att glida isär. Vid
     full velocity läggs ingen nod in alls, så en orörd låt bygger exakt
     samma graf som förut (viktigt när en offline-rendering schemalägger
     tusentals slag).
  3. **`state.selected` heter nu `{ track, item }`.** Den kan hålla en not
     *eller* ett slag, och `selectItem()`/`deleteItem()` hanterar bägge — en
     tonal och en rytmisk kopia hade bara drivit isär. Omdöpningen avslöjade
     direkt en destrukturering (`const { track, note } = state.selected`) som
     tyst blivit `undefined`; enkelnots-nudgen läste `len`/`freq` och behövde
     en egen rytmgren.
  På vägen: MIDI-velocity round-trippar nu åt bägge håll för både noter och
  slag (parsern läste note-on-velocity och slängde den, så allt importerades
  på full nivå och trummor exporterades med hårdkodat 100), och
  multi-nudgen av slag jämförde `s.start === h.start` inline i stället för
  `hitsConflict` — att flytta en kick in i en kolumn raderade alltså en
  omarkerad hi-hat som redan låg där. Sjätte instansen av precis den bugg de
  delade predikaten finns för.
- [x] **Vibrato per spår.** Tonala spår har nu Rate + Depth (i cent, 100 = en
  halvton) i ✨ FX-panelen. **Min uppskattning om mekanismen var fel**: jag
  skrev att det bara var "en rad i registret plus en LFO i kanalkedjan",
  eftersom `addVibrato()` och `addTremolo()` är nästan identiska funktioner.
  Funktionerna är det, men kopplingen är det inte. En LFO på kanalens gain
  kan forma en redan summerad signal; att böja dess *tonhöjd* går inte att
  göra nedströms — det måste nå varje nots egen oscillator. Alltså är detta
  den enda posten i `TRACK_FX_REGISTRY` som inte är en insert: den trådas in
  i `scheduleTone()`/`schedulePortamentoTone()` bredvid ADSR/filter/FM.
  Samma sak gör den också till registrets enda `tonalOnly`-post — ett
  trumslag har ingen oscillator att böja — vilket krävde ett nytt filter
  (`trackFxFor()`) som både panelen och `applySavedMix()` går igenom.
  Två detaljer värda att minnas: djupet anges i cent och skalas med notens
  egen frekvens, så vibratot är samma musikaliska intervall i alla lägen (i
  Hz hade det varit ohörbart i botten och vilt i toppen); och den *adderas*
  till per-not-flaggan i stället för att ersätta den, eftersom bägge kopplar
  in en LFO i samma `osc.frequency` och `AudioParam`-ingångar summerar — samma
  kontrakt som Crush och Tremolo redan har.
  `apply` är en medveten no-op: en nots LFO skapas med noten, så en ändring
  slår igenom vid nästa schemalagda chunk, precis som en ändring av vågform,
  ADSR eller filter.
- [x] **Duty cycle-default per spår.** Ligger i Envelope-panelen (`E Env`) och
  visas bara för `square`-spår, efter samma regel som FM-reglagen bredvid: en
  vågformsspecifik per-spårs-synthinställning visas bara för den vågform den
  gäller. Notens eget värde vinner fortfarande; `null` på noten betyder ärv.
  Två saker föll ut av det här som är värda att notera:
  1. **Inspektorns två identiska alternativ betyder nu olika saker.** Duty-
     listan hade både `null → "Standard (50%)"` och `0.5 → "50%"`, som gjorde
     exakt samma sak. Nu ärver det första spårets värde och heter "Track
     default (…)" med spårets aktuella siffra i, medan det explicita 50%
     tvingar en vanlig fyrkant oavsett vad spåret står på.
  2. **Vågformsvalet var handskrivet på tre ställen** — huvudoscillatorn,
     chorus-oscillatorn bredvid den, och portamento-schemaläggarens — så att
     lägga till spår-defaulten hade gjort det till tre nästan identiska
     fyrgrenskedjor. Nu en funktion, `setOscWave()`, och upplösningen mellan
     not och spår sker på exakt ett ställe, `effectiveDuty()`.
  Dessutom bundlades de fem sakerna ett spår bidrar med till en nots ljud
  (ADSR, filter, FM, vibrato, duty) till ett `voice`-objekt
  (`getTrackVoice()`). Schemaläggarna tog dem som en svans av fem valfria
  positionsparametrar — duty hade blivit den sjätte, och det är så ett
  argument hamnar ett steg fel. En ny per-spårs-inställning är nu ett fält i
  stället för ännu en plats i ordningen. Duty ingår också i spår-presetarna
  (`'duty' in preset`, inte sanningsvärde — `null` är ett riktigt värde här,
  och presetar sparade före duty saknar nyckeln helt och ska inte nollställa
  den).
- [ ] **Pan per not.** Varje annan mixparameter har en per-not-motsvarighet
  (volym via Velocity), men panorering har ingen — en enskild ton kan inte
  placeras i stereobilden utan att flyttas till ett eget spår. Dyrast av
  punkterna här och den enda jag inte är övertygad om behövs; ligger sist
  medvetet.

Åt andra hållet saknar per-not-lagret EQ, kompressor, ADSR, filter, FM och
vågform. Det är avsiktligt: de hör hemma på kanalen, inte på en ton.

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
- [x] **Velocity och fills i rytm-mallarna.** Mallarna lade in varje träff
  på full styrka och tilade samma takt rakt igenom — funktionellt, men det
  lät som en trumautomat, och det var mallarna som lät så, inte kittet.
  Två tillägg, båda som *data* i `RHYTHM_PATTERNS` snarare än kod:
  1. **Accenter.** Varje träff i varje mall har nu en avsedd styrka:
     backbeat och kick fullt, hi-hats accentuerade på slaget (~0.85) och
     ghostade mellan (~0.45–0.5), texturer (shaker, en fjädrad jazzkick)
     klart under. Värdena följer `hitVel()`s regel — **frånvarande betyder
     full** — och `patternHitAt()` skriver bara ut `vel` när den faktiskt
     ligger under 1, så en instämplad mall serialiseras inte större än
     samma träffar utplacerade för hand. Mätt på Rock: 62 av 93 träffar
     bär en velocity, resten är fulla och alltså egenskapslösa.
  2. **Fills.** Varje mall har en andra en-takts-`fill` som används på
     phrasens sista takt. Phraselängden väljs i dialogen (`FILL_EVERY_CHOICES`
     — aldrig / 2 / 4 / 8 takter, default 4) och räknas från *insättnings*-
     takten, inte från låtens takt 1, så frasindelningen följer var
     spelhuvudet står. Takten *efter* ett fill öppnar med en crash — det är
     hela poängen med ett fill, och utan den låter det som ett misstag i
     stället för en upptakt. Crashen läggs in via `hitsConflict()`, inte
     blint: Breakbeat crashar redan på sin egen etta.
  En dropdown i stället för en per-rad-inställning, eftersom phraselängd är
  en egenskap hos *insättningen*, inte hos en groove. Varje mall fick också
  en egen `▶ fill`-knapp — annars är enda sättet att höra ett fill att
  stämpla in mallen och spela fyra takter.
  Testet asserterar beteendet i griden: takt 1–3 lika, takt 4 annorlunda,
  crash på takt 5 och ingen tidigare, exakt *en* crash på Breakbeats takt 5,
  och med fills avstängda alla takter identiska och noll crasher. Det tog två
  försök att få rätt: första versionen jämförde hela aria-etiketten, som
  innehåller taktnumret — så "takt 1 ≠ takt 2" var sant av fel skäl och
  testet föll mot fungerande kod.
- [x] **Tre mallar till: Funk, Half-time, Bossa Nova.** Sju blev tio. Valda
  för att de ligger *långt* från de befintliga snarare än att vara
  rock-varianter, och de använder olika delar av kittet (rim, ride, shaker,
  tom).
  **Funk tvingade fram en riktig upptäckt om kolumnenheten.** Jag antog
  först att mallarna satt fast på åttondelar, vilket hade gjort funk
  meningslös — ghost notes lever på sextondelar. Men kolumnenheten är en
  åttondel medan positioner re-lattice:as till `MICRO` (1/6 av en), så
  `start: 0.5` *är* en sextondel och `1/3` en triol; griddropdownen erbjuder
  redan bägge. Kontrollerat i node att `quant()` ger tillbaka 0.5, 1.5, 3.5,
  7.5 exakt, och att `quant(8 + 0.5) === 8.5` — annars hade `hitsConflict`s
  `a.start === b.start` blivit opålitlig.
  **Men rendering avslöjade nästa problem:** en träffs block ritas en
  *gridsteg* brett (`renderRhythmTrack`), inte ett kolumnsteg — så på
  default-griden 1/8 hade två sextondelar ritats ovanpå varandra. Grooven
  hade funnits där och varit oläsbar. Lösning: ett valfritt `grid`-fält på
  mallen som sätts vid insättning, exakt som `swing` redan gör. Funk sätter
  `grid: 0.5`.
  Bossa fick ett tredje valfritt fält, `crashAfterFill: false` — dess "fill"
  är en clave-vändning, inte en upptakt, och en crash ovanpå är helt enkelt
  fel genre.
  Testet utökat med fyra assertioner, alla verifierade mot injicerade buggar:
  griden byts till 1/16 vid Funk (*"got 1/8"*), sexton hi-hats i Funks första
  takt — vilket är det som faktiskt pinnar sextondelsplaceringen, eftersom
  åtta åttondelskolumner inte rymmer sexton (*"got 15"*), Bossa lägger in noll
  crasher (*"but one was inserted"*), och varje rad i biblioteket har både
  beskrivning och fill (*"pattern 'Half-time' has no fill"*). Den sista tog
  två försök: första injiceringen lade `fill: null` *före* det riktiga
  `fill:`-fältet i samma objektliteral, så den senare vann och buggen fanns
  aldrig — testet såg ut att missa något det i själva verket fångar.
- [x] **Reggae (one drop) och Trap — tolv mallar.** Bägge rena tabellrader.
  **Reggae definieras av en frånvaro:** ingen kick på ettan alls, kick och
  cross-stick tillsammans på trean, och hi-hatens accenter *omvända* — svagt på
  slaget, starkt mellan. Det är den tomma ettan som är stilen; lägger man något
  där blir det ett långsamt rockbeat med annan hi-hat. Testet asserterar just
  frånvaron, eftersom ingen mängd eller spridning fångar den.
  **Trap tvingade fram ett val om rastret.** Det är den enda mallen som blandar
  två underdelningar: sextondelar i hi-hat-linjen och en trioroll. Båda finns på
  MICRO-gittret (1/2 respektive 1/3 av en åttondel) — men *trettiotvåondelar
  finns inte*, en fjärdedels åttondel ligger utanför och `quant()` snäpper den
  till triolen. Så rollen är skriven som trioler, vilket är ett verkligt
  trap-tempo och inte en approximation av ett.
  Griden sätts till `1/3` (1/16 T), inte `0.5`: en träffs block ritas ett
  *gridsteg* brett, så på 1/16 hade triolerna (1/3 isär) överlappat, medan på
  1/16 T är varje block en tredjedels kolumn och både sextondelarna och
  triolerna går att läsa. Kontrollerat i node först att triolpositionerna är
  exakta och skilda från sextondelarna (`quant(7.5) ≠ quant(7⅔)`).
  Trap-testet **mäter** i stället för att lita på tabellen: det läser
  hi-hatarnas ritade x-positioner, tar avstånden mellan dem och kräver att två
  av dem står i förhållandet 3:2 — inget annat i appen producerar det.
  Bägge assertionerna verifierade mot injicerade buggar: en kick på ettan
  (*"found 3 kick(s) there"*) och alla mönsterträffar snäppta till
  sextondelsgittret (*"measured Infinity from [0,8,16]"*). Den andra visade
  också att ett nollavstånd — två hi-hats i samma kolumn, vilket `hitsConflict`
  räknar som krock — förtjänar ett eget felmeddelande i stället för en
  Infinity-kvot, så det lades till.
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

- [x] **Granskning av exempellåtarna, inlagd som första steget i `verify.js`.**
  Efter #96 låg frågan kvar om de sju medföljande låtarna själva bar på skräp.
  De gjorde inte det — alla sju rena, och en körning i webbläsaren där de
  laddades i följd gav exakt matchning mot filerna i alla elva
  inställningskartorna.
  **"0 problem" är dock precis det resultat man inte ska lita på**, så
  granskningen kördes mot en avsiktligt trasig kopia först: okänd trumma,
  `vel: 1` (samma sak som ingen vel alls, alltså dödvikt), träffar efter
  låtens slut, `adsr` utan `release` (hela posten tappas vid laddning),
  tonal-inställning på ett rytmspår, spår-id som inte finns i låten,
  duty utanför de fyra som väljaren erbjuder, EQ/pan utanför sina intervall,
  okänd vågform, automation på en parameter som inte finns, `masterEQ`
  utanför ±12 dB, saknad `masterVol`, och `index.json` kontra filerna på disk
  åt bägge håll. Alla fjorton smällde.
  Två saker som gör att den inte kan ruttna: konstanterna (`WAVEFORMS`,
  `RHYTHM_ROWS`, `DUTY_VALUES`, `AUTOMATION_PARAMS`, `SPARSE_TRACK_MAPS`,
  `TRACK_FX_REGISTRY`s min/max) **läses ur `index.html`** i stället för att
  skrivas av — samma drift-problem som punkten nedan handlar om — och en
  extraktion som slutar matcha **kastar** i stället för att ge en tom lista.
  Verifierat: döp om `SPARSE_TRACK_MAPS` i en kopia och granskningen säger
  *"could not read SPARSE_TRACK_MAPS out of index.html — the audit would pass
  vacuously"* i stället för att glatt godkänna allt.
  Ligger först i sviten, och är enda steget som inte startar någon webbläsare:
  en trasig exempellåt går ut till alla som öppnar Songs-menyn, och att få veta
  det ska kosta sekunder, inte de tretton minuter resten av körningen tar.
- [x] **Spårinställningar sparades och lästes in fel — en lista i stället för
  sex handskrivna.** Frågan var enkel ("sparas allt i master och spåren?") och
  svaret visade sig vara *nästan*. Genomgången av `currentSongData()` mot
  `applySavedMix()` gav två fel, det andra värre än det första:
  1. **Duty sparades men lästes aldrig tillbaka.** `data.duty` förekom på
     exakt ett ställe i hela `index.html` — i `restoreSnapshot()`. Alltså
     bevarade undo/redo pulsbredden, men att ladda en sparad låt gjorde det
     inte. Verifierat i webbläsaren: sätt 25 %, spara, ladda om, ladda in →
     tillbaka på Square 50 %. Duty är den enda spårinställningen som är ett
     rent tal i stället för ett objekt, vilket är precis därför den inte åkte
     med i någon delad loop (`TRACK_FX_REGISTRY` hanterar bara objekten).
  2. **Låt A:s inställningar läckte in i låt B.** `restoreTrackList()`
     nollställde `automation` och `adsr` — men inte `filter`, `fm`, `fxSend`,
     `comp`, `crush`, `tremolo`, `vibrato`, `duty` eller `eq`. Och
     `applySavedMix()` *sätter* bara det filen innehåller, den rensar aldrig.
     Alltså överlevde allt det på varje spår-id de två låtarna delade — och
     **varje låt har ett `rhythm`**. Mätt: ladda Neon Cathedral, ladda sedan
     Techno, läs ut vad state faktiskt innehåller och jämför mot
     `techno.json`:
     ```
     fxSend  -> ["pad","lead","brass","bass","rhythm","perc"]
     comp    -> ["brass","bass","rhythm"]
     crush   -> ["lead","rhythm"]
     tremolo -> ["pad"]
     filter  -> ["pad","lead","brass","bass"]
     fm      -> ["brass"]
     ```
     Technos trumspår ärvde alltså Neon Cathedrals kompressor och crush, och
     dess lead/bas ärvde filter. Hörbart, inte teoretiskt.
  Samma lista fanns handskriven på sex ställen och fyra hade drivit isär:
  `restoreTrackList()` rensade två av elva, `createNewSong()` nio (glömde
  `filter` och `fm`), `removeTrack()` tio (glömde `filter`) och
  `applySavedMix()` läste tio (aldrig `duty`). Nu finns `SPARSE_TRACK_MAPS`
  och alla sex går igenom den; `autosave()` skriver `currentSongData()` självt
  i stället för en andra kopia av fältlistan.
  Två nya teststeg, bägge verifierade mot orörd kod: nyckelmängderna efter
  Neon Cathedral → Techno måste vara exakt filens (*"state.fxSend after
  loading Techno is [...]"*), och en Duty måste överleva spara → ladda om →
  ladda in. Det första steget asserterar dessutom **först** att Neon Cathedral
  faktiskt *har* comp och filter — annars hade "inga läckor" varit sant av fel
  skäl på en tom mängd.
  Ett tredje fel dök upp på köpet: velocity-steget letade upp autosave-nyckeln
  som "första nyckeln vars värde innehåller `trackList`". Så fort Duty-steget
  sparade en låt matchade den nyckeln först, en nivå djupare, och steget föll.
  Letar efter `autosave` i nyckelnamnet nu.
- [x] **Sidan startar alltid tomt, inte med en fråga eller Froggy Hop** —
  tidigare frågade sidan vid varje omladdning "Found an unsaved draft...
  Restore it?" (om ett autosave-utkast fanns) eller laddade annars
  spelets demo-låt (`js/song-data.js`s `TRACKS`/`RHYTHM_TRACKS`, via
  `gameDefaults()`) tyst. Efter feedback om att frågan blivit ett
  irritationsmoment vid varje omladdning (autosave triggar på varje
  redigering, så frågan kom nästan alltid) tar sidan nu alltid emot ett
  tomt projekt (bara Rhythm-spåret) direkt — `state`s startvärden själva,
  inget separat steg efter. `autosave()` fortsätter spara i bakgrunden
  som ett skydd mot en kraschad flik, men läses aldrig tillbaka
  automatiskt (`loadAutosaveIfPresent()` och hela bekräftelsedialogen är
  borttagna); ett gammalt utkast ligger kvar oanvänt i `localStorage`
  tills det skrivs över av nästa redigering. Låtval sker istället
  explicit via 🎵 Songs-menyn — Froggy Hop finns kvar där precis som
  innan (`songs/froggy-hop.json`, en separat, mer fullständig fil än
  `js/song-data.js`s råa exportformat). Eftersom `gameDefaults()` bara
  användes för att bygga det startvärde som nu ändå alltid skrivs över
  direkt, togs den och dess enda anropspunkt (`_gd`) samt den nu oanvända
  `TRACKS`/`RHYTHM_TRACKS`-importen bort — `index.html` importerar bara
  `TEMPO_BPM` från `js/song-data.js` numera.
- [x] **Projektnamnet flyttat från ☰-menyn till Master-strippen** — efter
  feedback: "Master-spåret innehåller ju all låt information redan. Så om
  vi bara ser till att namnet syns i master-listen." ☰-menyns
  `.file-menu-info`-block (Song/Tempo/Meter/Length/Tracks, en ren
  read-only sammanfattning av kontroller som redan låg live i
  Master-strippen — `updateSongInfo()`) togs bort helt, precis som
  efterfrågat ("plocka bort all denna information från meny"). Låtnamnet
  (`#song-name-display`) flyttades in i Master-strippens `.mstrip-body`
  som en egen cell — samma `renameSong()`-klick-för-att-döpa-om som förut,
  bara ny plats. Kravet "kollapsat tillstånd är namnet ej editerbart, i
  expanderat ska man kunna ändra namnet" löstes utan ny logik: elementet i
  `.mstrip-body` (klickbart, med ✎-ikon) döljs redan av befintlig CSS när
  strippen är kollapsad (`#master-track.collapsed .mstrip-body { display:
  none }`), så ett andra, rent textuellt `#mstrip-song-name`-`<span>`
  lades till i `.mstrip-collapsed-label` (som redan bara syns när
  strippen ÄR kollapsad) — samma `state.songName`, två element som CSS
  redan växlade mellan, `updateSongNameUI()` uppdaterar båda. Hjälptexten
  uppdaterades på tre ställen för att peka på nya platsen.
- [ ] **Bara lokalt.** Sparade låtar ligger i `localStorage` i webbläsaren;
  det finns ingen delning via länk/URL eller molnsynk mellan enheter.
- [ ] **Ingen kollaborativ redigering** (flera personer på samma låt samtidigt).

## Kvalitet

- [x] **Vågformer och effekter är ritade i stället för enbart namngivna.**
  En tabell, `GLYPHS`, håller små inline-SVG:er i en 24×12-viewBox med y=6
  som nollinje, ritade med `currentColor` så samma glyf funkar på en tänd
  knapp, en dämpad panelrubrik och ett hover-läge utan omfärgade kopior.
  Tre användningar: (1) vågformsväljaren är nu sex ikonknappar
  (`role="radiogroup"` + `aria-checked`, samma mönster som
  Pen/Eraser/Grab) i stället för en `<select>` — valet *är* "vilken av de
  här formerna", och en rullgardin visade bara en form i taget, dessutom
  kan en `<option>` inte bära SVG över huvud taget; (2) per-not-växlarna
  har fått sin effekt ritad ovanför etiketten; (3) ✨ FX-panelens fem
  grupper har fått rubriker med glyf i stället för anonyma hårstreck —
  förkortningar som Thr/Rat/Atk/Rel läser sig som en kompressor först när
  man vet vilken grupp man tittar på.
  Där en per-not-flagga och en per-spårs-kontroll betyder *samma* effekt
  delar de medvetet glyf, för att de ska läsas som samma sak i två
  omfattningar; att den ena är fast och den andra reglerbar är vad
  `title`-texten är till för.
  Glyferna är `aria-hidden` — varje kontroll behåller sitt eget textnamn,
  och det valda vågformsnamnet skrivs dessutom ut under knappraden, så
  ingenting hänger på att känna igen en ikon. Två fällor upptäcktes när
  regressionstestet skrevs: en assertion som jämförde knappens
  `textContent` mot dess etikettelement passerade när *bägge* var tomma
  (den kollade konsekvens, inte att namnet fanns — nu jämförs de sju
  faktiska namnen), och avläsningar som inte var begränsade till ett spår
  läste ihop alla spårs väljare till en enda lista.
  EQ-glyfen ritades först som tre reglage men blev till daggar i 18px, och
  är nu en responskurva som håller sig läsbar i vilken storlek som helst.
- [x] **Hela gränssnittet ritas nu ur samma tabell.** Uppföljning på
  ovanstående: menyn, verktygsfältet, spårhuvudenas knappar och dialogernas
  rubriker körde fortfarande emoji, som renderas i systemets egen färg och
  stil — helfärgade bilder inklistrade i ett monokromt streckat gränssnitt.
  `GLYPHS` fick 22 nya ikoner i en **kvadratisk 24×24-ruta**; en post är
  antingen en naken lista med paths (den breda 24×12-rutan för vågformer och
  effekter) eller `{ box, paths }`, så vilken ruta en glyf använder är en
  egenskap hos glyfen och inte något varje anropspunkt måste veta. Statisk
  markup bär `data-glyph="namn"` och fylls i av ett enda pass vid uppstart;
  JS-byggda knappar använder `setGlyphLabel()`.
  **Behållet med flit:** transporten (`⏮ ■ ▶ ↺`), ångra/gör om, `▾`/`▸`,
  `✕`-stängningarna och `+`/`−`-stegarna. De läser som typografi, inte som
  inklistrade bilder, och en streckad play-triangel ser sämre ut än den
  fyllda alla förväntar sig. `verify.js` granskar varje knapp i verktygsfält,
  meny och spårhuvuden mot en explicit undantagslista, så uppdelningen är ett
  nedskrivet beslut och inte en glömska — och kollar i samma svep att ingen
  knapp tappat sitt tillgängliga namn, eftersom en glyf är `aria-hidden` och
  en ikonknapp utan text eller `aria-label` vore namnlös. Bägge felfallen
  provades genom att införa dem.
  Två ikoner ritades om efter att ha setts i rätt storlek: suddgummit blev en
  klump och repeat korsade sina pilspetsar. Hjälptexten pekade ut knappar med
  deras emoji ("🎵 Songs…"), vilket blev inaktuellt — den namnger dem nu med
  sina etiketter i stället. Markörflaggan är ett CSS-pseudoelement och kan
  inte anropa `glyph()`, så den fick samma form som en inbäddad data-URI.
  **Efterföljare:** rename-pennan efter låtnamnet (`✎` i ett `::after`) blev
  kvar första omgången — knappen är ett riktigt element, så den bär nu en äkta
  `glyph('pen')`, vilket också gör att den ärver `currentColor` och tänds med
  etiketten vid hover (det gjorde det fasta dämpade pseudoelementet aldrig).
  `updateSongNameUI()` skrev tidigare `textContent`, vilket hade raderat ett
  tillagt barn vid varje namnbyte, så namnet ligger i ett eget `<span>` med
  ellipsen på sig — pennan krymper inte hur långt namnet än är.
  Att den överlevde första omgången berodde på två luckor i granskningen, bägge
  nu täppta: den läste bara verktygsfält, meny och spårhuvuden (masterremsan
  och dialogerna låg utanför), och den läste bara `textContent`, som aldrig ser
  ett `::before`/`::after`. Dessutom stod `✎` i undantagslistan från när den
  var avsiktlig — negativtestet passerade tyst tills den togs bort därifrån.

- [x] **Ljudgrafens uppbyggnad var duplicerad på tre ställen** —
  `ensureCtx()` (live-uppspelning), `renderSongToWav()` (WAV-export) och
  `ensureChannelNodes()` (nytt spår mitt i sessionen) byggde var sin
  nästan identiska kopia av både master-bussen (gain/ducking/EQ+komp/
  bitcrush/de tre send-bussarna) och varje spårs kanalkedja (gain →
  komp → bitcrush? → tremolo → panner/mätare/sänder). Efter en fråga om
  vad som skulle designats annorlunda om appen byggdes om från grunden
  pekade vi ut just detta som den konkreta punkten — det är exakt den
  dupliceringen som gjort varje ny per-spårs-effekt (Crush, Tremolo)
  riskabel att lägga till, eftersom man var tvungen att komma ihåg att
  uppdatera kopplingen på alla tre ställen för hand. Bröts ut till två
  delade funktioner, `buildMasterBus(ctx)` och
  `buildChannelChain(ctx, id, withAnalyser)`, som nu anropas från alla
  tre ställena istället. Enda skillnaden mellan live och offline är att
  `ensureCrusher()`/`ensureTrackCrusher()` nu returnerar sitt
  worklet-uppgraderings-`Promise` — `renderSongToWav()` väntar in det
  innan `startRendering()` (en offline-rendering körs en gång,
  deterministiskt, och behöver vara fullt kopplad från start), medan
  live-uppspelning fortfarande struntar i det och låter bypass-kopplingen
  uppgraderas i bakgrunden som förut. Nettoresultat: ~90 rader mindre
  duplicerad kod, verifierat i webbläsaren (live-uppspelning, nytt spår
  mitt i sessionen, WAV-export) utan nya konsol-fel.
- [x] **Varje ny per-spårs-effekt krävde ~8 handpåförda ändringar** — punkt
  #2 från samma retrospektiv-fråga som ovan. Delay/Chorus/Reverb-send,
  Compressor, Bitcrush och Tremolo hade var sin nästan identisk
  inläsnings-/valideringsblock i `applySavedMix()` (~45 rader) och var
  sin nästan identisk fält-renderingskod i `buildFxPanel()` (~60 rader)
  — fyra ställen som båda måste hållas synkade för hand vid varje ny
  effekt eller parameter. Bröts ut till en enda tabell,
  `TRACK_FX_REGISTRY` (en post per `state.*`-slice med `get`/`set`/
  `apply`-funktioner plus varje fälts min/max/steg/format/
  klipp-vid-inläsning-regler), som båda `applySavedMix()` och
  `buildFxPanel()` nu itererar generiskt istället för att var och en
  hårdkoda logiken. Bevarar alla befintliga särdrag exakt (Compressorns
  fyra fält klipps INTE vid inläsning, till skillnad från de
  procent-liknande fälten som klipps till [0,1]; `fxSend.reverb` är
  fortfarande det enda valfria fältet med ett default-värde, för
  bakåtkompatibilitet med låtar sparade innan Reverb-sändningen fanns).
  Medvetet INTE utökat till att även driva ljudgraf-uppkopplingen
  (`createChanComp()`/`createChanTremolo()`/`ensureTrackCrusher()`/
  `createTrackFxSends()` är för olika i form — en vanlig nod jämfört
  med en asynkron worklet-insert jämfört med tre send-tappar — för att
  en delad abstraktion där ska löna sig) eller Song I/O:s andra
  ställen (`currentSongData()`/`autosave()`/`snapshotSong()`/
  `restoreSnapshot()` refererar redan bara `state.fxSend` osv. som
  vanliga objekt-literal-nycklar, redan så enkelt det kan bli).
  Verifierat i webbläsaren: alla fält i alla fyra grupper på både
  tonalt och rytm-spår, spara/ladda-rundtur (inklusive
  reverb-default-fallet), och Reset-knappen, allt utan nya konsol-fel.
- [x] **Ingen återanvändbar regressionskoll fanns kvar i repot** — punkt #3
  från samma retrospektiv-fråga som de två föregående punkterna. Varje
  funktion i den här sessionen krävde att ett engångs-Playwright-skript
  skrevs i en scratchpad för att verifiera att inget gått sönder, och
  kastades sen — samma sak fick uppfinnas om och om igen. Lade till
  `verify.js`, incheckad i repot: startar sin egen `dev-server.js` på
  en engångsport, kör igenom en handfull kärninteraktioner (tomt
  projekt vid start, ladda ett exempel via Songs-menyn,
  Automation-/FX-panelerna, uppspelning, lägg till/ångra ett spår), och
  faller om någon förväntan är fel ELLER om sidan loggar ett
  konsol-fel/en ohanterad exception när som helst under körningen —
  verifierat att den passiva fel-uppsamlingen faktiskt fångar sådant
  (testat med ett medvetet `console.error`/en medveten ohanterad
  exception, båda fångades och fällde körningen korrekt).
  Pratar med webbläsaren direkt via Chrome DevTools Protocol
  (`WebSocket` + JSON-RPC, bara Node:s egna inbyggda moduler) istället
  för ett automationsbibliotek som Playwright — matchar projektets
  "inga beroenden att installera"-regel istället för att introducera
  repots första npm-beroende (och därmed `package.json`/
  `node_modules`); `element.click()`/`dispatchEvent()` via
  `Runtime.evaluate()` ersätter det ett bibliotek annars hade gett,
  och slipper dessutom helt den tidigare i sessionen upptäckta
  klick-missar-p.g.a.-scroll-clipping-buggen eftersom det inte är
  riktiga koordinatbaserade klick genom renderingspipelinen. Hittar en
  lokal Chromium-baserad webbläsare automatiskt (`CHROME_PATH` för att
  override:a). Inte en fullständig testsvit — bara CLAUDE.md:s
  beskrivning av "inget testkommando" uppdaterad till att nämna
  `verify.js` som det närmaste som finns, fortfarande inget
  build/lint-kommando.
- [x] **Tre buggar hittade vid en genomgång av hela koden** (efterfrågad inför
  en merge). Alla tre var äldre än ackord-arbetet, men de två första blev
  åtkomliga/synliga först i och med det:
  1. **Rytmspår raderade hela kolumnen vid placering** —
     `onRhythmCellClick()` filtrerade på `h.start !== col` utan att titta på
     `h.type`, så ett nytt slag tog bort alla andra slag i samma kolumn. Det
     gjorde det omöjligt att för hand lägga kick och hihat på samma slag.
     Syntes inte tidigare eftersom inbyggda 🥁-mallar
     (`insertPatternIntoRhythm()`) skriver arrayen direkt och inlästa låtar
     aldrig går via klick-vägen. Notera att både `DESIGN.md` och ackord-specen
     *påstod* att slag redan samexisterade över rader — det stämde alltså inte
     för klick-vägen. Nu filtreras på `start` **och** `type`, rytm-motsvarigheten
     till samma-tonhöjd-regeln för noter.
  2. **Portamento gick sönder runt ackord** — `scheduleTrackNotes()` letade
     mål som `sorted[i + 1]` i en array sorterad på `start`. Med ackord är
     nästa element oftast ett syskon med samma `start`, vilket gav två fel:
     porta på en ackordton ignorerades helt (spelades som vanlig not), och en
     porta-not som gled in i ett ackord "åt upp" en godtycklig ackordton via
     `i++` så att den bara ljöd som glidningens svans i stället för som egen
     stämma. Nu söks målet på *tid* i stället, tonen närmast i tonhöjd väljs
     (kortaste glidningen, och deterministiskt där array-ordningen inte var),
     och konsumerade mål spåras i ett `Set` i stället för med `i++`.
  3. **Radering kunde flytta markeringen till fel not** — `deleteNote()`
     nollställde `state.selected` bara vid exakt index-träff, men `selected`
     är ett *index* och radering skiftar alla efterföljande ett steg ner.
     Markera not 3, sudda not 1 → inspektorn och `.selected` hoppade till
     not 4, och nästa redigering (velocity, effekter, Delete) träffade fel
     not. Nu återankras markeringen på identitet i stället för index.
  Två regressionstester tillagda i `verify.js` (rytm-kolumnen och
  markeringen), båda verifierade att de faktiskt fäller den ostädade koden.
  Portamento-fixen har ingen DOM-observerbar effekt och testas inte
  automatiskt — den verifierades mot sex scenarier med en fristående
  simulering av schemaläggningsloopen (inte incheckad, eftersom en kopia av
  algoritmen skulle glida isär från `index.html` och ge falsk trygghet).
- [x] **`dev-server.js` sökvägskontroll var för slapp** — `file.startsWith(ROOT)`
  släppte igenom en systermapp med samma prefix via `..`: en förfrågan om
  `/../music-studio-anteckningar/secret.txt` normaliserades till
  `/home/user/music-studio-anteckningar/secret.txt`, som mycket riktigt
  börjar med `/home/user/music-studio` och alltså serverades. Bara
  utvecklingsservern, men den lyssnar på alla gränssnitt. Jämför nu mot
  `ROOT + path.sep`. Verifierat båda hållen mot en riktig systermapp
  (403 efter, 200 före).
- [x] **`startMoveHit()` raderade hela landningskolumnen** — samma buggfamilj
  som `onRhythmCellClick()` ovan, fast vid släpp i stället för vid klick:
  `filter(h => groupSet.has(h) || !group.some(g => g.start === h.start))`
  jämförde bara `start`, inte `type`. Drog man snaren till kickens kolumn
  försvann kicken, trots att de ligger på olika rader. Verifierat i
  webbläsaren: två slag → drag → ett slag kvar. Notera att jag först
  beskrev det här som motsatsen ("deduplicerar inte, staplar dubbletter")
  efter en för snabb läsning — filtret fanns, det var bara för brett.
  Jämför nu på `start` **och** `type`, och `verify.js`-steget för rytm
  täcker även drag-fallet.
- [x] **Kollisionsregeln och markeringen centraliserade** — uppföljning på
  frågan om GUI:t borde skrivas om i React. Slutsatsen blev nej: ingen av de
  buggar vi hittat låg i renderingen, utan i domänlogiken. Två mönster gick
  igen, och båda är nu åtgärdade i stället.
  1. **Kollisionsregeln var handkopierad på sju ställen.** Samma-tonhöjd-
     villkoret fanns i fyra varianter, samma-typ-villkoret i två, och varje
     gång någon skrev om det för hand drev det isär — fem av de buggar vi
     rättat i den här omgången var exakt det. Nu finns `notesConflict(a, b)`
     och `hitsConflict(a, b)` som enda sanning, med `clearOverlaps(notes,
     probe, keep)` som omslag för det vanliga fallet. Alla vägar som placerar,
     drar, knuffar, klistrar in eller släpper går genom dem.
     Refaktoreringen avslöjade en sjätte instans direkt: `pasteClipboard()`s
     rytmgren nycklade på kolumn i stället för kolumn+typ, så en kopierad
     kick+snare-stapel tappade ena raden vid inklistring *och* rensade
     landningskolumnens övriga rader.
  2. **`state.selected` var ett index.** Nu `{ track, note }` med
     notobjektet självt. `renderInspector()` kontrollerar fortfarande att
     noten faktiskt finns kvar i spåret innan den visar reglage, eftersom
     ångra/inklistring/drag kan ha tagit bort den.
  Under verifieringen föll ytterligare en bugg ut, av samma familj:
  `state.multiSelected` är underförstått knuten till `state.activeTrack`, men
  `addTrack()`/`addRhythmTrack()`/MIDI-importen satte `state.activeTrack`
  direkt förbi `setActive()` — som sedan tidig-returnerade eftersom id:t redan
  stämde. Markeringen från det gamla spåret låg alltså kvar, och nästa
  piltangent-knuff **kopierade in rytmspårets slag i det nya tonspåret** som
  trasiga noter (`freq` undefined). Alla tre går nu via `activateTrack()`.
  Fyra nya steg i `verify.js` (12 → 14 totalt), alla verifierade att de
  fäller den ostädade koden.
- [x] **Fler ackordvarianter i notinspektorn** — den ursprungliga specen lämnade
  uttryckligen dörren öppen ("7ths, sus, dim, aug … can be added later as more
  buttons in the same panel"). Nu tio: `5` (kvintackord), `maj`, `min`, `dim`,
  `aug`, `sus2`, `sus4`, `7`, `maj7`, `m7`. Eftersom `addChordAbove()` redan
  var generisk över intervall-listan blev det en datatabell (`CHORD_PRESETS`)
  plus layout — ingen ny logik, och nästa ackord är en rad i tabellen.
  De två breda knapparna ("Add Major Chord") ersattes av ett kompakt rutnät
  med korta etiketter och `title`-tooltips för de fullständiga namnen, samma
  grepp som ✨ FX-panelen redan använder för Thr/Rat/Atk/Rel. `auto-fill` i
  grid:en gör att knapparna flödar om i stället för att spilla över, vilket
  behövs eftersom inspektorn blir en bredare bottenplatta på mobil.
  Verifierat i webbläsaren att alla tio ger rätt intervall (mätt som radavstånd
  i pianorullen, 11px per halvton): `5`→[0,7], `maj`→[0,4,7], `min`→[0,3,7],
  `dim`→[0,3,6], `aug`→[0,4,8], `sus2`→[0,2,7], `sus4`→[0,5,7], `7`→[0,4,7,10],
  `maj7`→[0,4,7,11], `m7`→[0,3,7,10]. Ett nytt `verify.js`-steg täcker att hela
  tabellen renderas, att varje knapp har tooltip, och att `maj7` (den nya
  tre-tons-formen) röstas rätt — de äldre stegen provade bara `maj`.
- [x] **Arpeggio-knapparna använder samma palett** — uppföljning på punkten
  ovan. `note.arp` och `CHORD_PRESETS.intervals` råkade redan använda exakt
  samma konvention (halvtonsavstånd *över* grundtonen — `scheduleTone()`
  lägger själv till `note.freq` först när den cyklar arpeggiot), så det blev
  en direkt mappning utan omräkning. Arpeggio-raden går från två trioler till
  samma tio voicings som Chord-raden, och de delar nu CSS-klass
  (`.arp-presets`/`.chord-presets` → en gemensam `.preset-grid`). Knapparna
  taggas `data-arp` respektive `data-chord` så att både testerna och
  CSS-selektorer kan skilja raderna åt trots delad klass. Skillnaden mellan
  raderna är oförändrad och nu tydligare beskriven i hjälpen: arpeggiot
  behåller *en* not som sveper genom ackordet, Chord lägger till riktiga
  noter. Nytt `verify.js`-steg kollar att båda raderna erbjuder samma
  voicings, att `m7` skriver `3,7,10` i Arpeggio-fältet, att inga noter
  läggs till (det är skillnaden mot Chord) och att ♪-märket dyker upp.
- [x] **Hopfällbara palettnät i notinspektorn** — efter frågan om högerpanelen
  borde få ett fliksystem. Jag mätte panelen först i riktiga fönsterstorlekar:
  745px innehåll, och sektionerna fördelade sig `Selected note` 91px,
  `Modulation` 93px, `Pitch` 235px, `Chord` 149px, `Texture/FX` 93px. Alltså
  var **Pitch + Chord 52% av panelen**, och det var de två tio-knappars-näten
  som just tillkommit. På 1920×1080 och 1440×900 fick den plats med 2px till
  godo; på 1366×768 scrollade den 106px och på 1280×720 154px.
  Slutsatsen blev att problemet inte var "fem sektioner är för många" utan två
  nät, så flikar vore fel verktyg: panelens viktigaste egenskap är att man ser
  på en blick vad som är påslaget (knapparna lyser), och en flik hade gömt ett
  aktivt Vibrato bakom en annan flik. Näten ligger nu bakom en
  `▸ presets`-fällning, förvalt stängd och ihågkommen per webbläsare
  (`openPalettes`/`localStorage`, samma mönster som `collapsedTracks`).
  Resultat: 745px → **548px**, får plats utan scroll på alla testade
  storlekar, och varje tillståndsbärande knapp förblir synlig.
  `togglePalette()` anropar bara `renderInspector()` och inte `render()` —
  inget utanför inspektorn ändras, och en ren UI-växling ska inte bygga om
  griden (5760 celler per rytmspår).
  Två testsaker föll ut: ett kollapsat nät renderar **inga** knappar alls, så
  `verify.js` måste fälla ut paletten först (`openPalette()`) — annars hade
  stegen klickat på element användaren inte kan nå, och `element.click()`
  fungerar även på dolda noder. Och när jag lade till det avslöjades att
  arpeggio-stegets etikettjämförelse passerade **tomt mot tomt**: föregående
  steg stänger inspektorn (ackordknappen nollar `state.selected`), så båda
  listorna var tomma och likhetstestet höll av fel anledning. Steget markerar
  nu en not först och kräver att listan inte är tom.
- [ ] **Fliksystem i inspektorn** — inte gjort, och inte motiverat vid fem
  grupper. Om panelen växer till 8–10 grupper vinner flikar, eftersom man då
  scrollar förbi en växande hög med stängda rubriker. Skissen som togs fram:
  `Selected note` och `Delete` ligger kvar utanför flikarna (identitet
  respektive destruktiv handling), och resten delas i **Sound** (Modulation +
  Texture/FX — alla booleska på/av), **Pitch** (bend/duty/arpeggio) och
  **Chord** (den enda handlingen som skapar noter, till skillnad från allt
  annat som är egenskaper). En prick på fliken när något i den är aktivt
  återställer en del av överblicken, men bara att *något* är på, inte vad.
- [x] **Tillgänglighetsgenomgång** — mätte först i webbläsaren i stället för att
  gissa. Utfallet var blandat: alla 14 reglage, 7 selects och alla knappar
  hade redan tillgängliga namn (via `title`), alla fyra dialoger hade
  rubriker, och `lang="en"` fanns. Fyra verkliga luckor:
  1. **Ingen synlig fokusmarkering.** Ingen `:focus`-regel alls i CSS:en, och
     `outline: none` på det aktiva verktyget tog bort webbläsarens egen. På
     den här paletten försvinner default-ringen ändå. Nu en
     `:focus-visible`-ring i `#7fd4ff` (11.3:1 mot bakgrunden).
  2. **Inga landmärken.** `main:0 nav:0 header:0 aside:0`, ingen `h1`. Nu
     `<main>`/`<aside>`/`role="toolbar"`, en dold `h1` och en skip-länk.
  3. **Griden var osynlig för hjälpmedel** — 1025 noter och 349 slag, noll med
     roll, namn eller fokuserbarhet. Nu har varje lane, not och slag ett
     `aria-label` (tonhöjd/trumma + takt och slag), och **Shift+←/→** stegar
     markeringen genom aktivt spår medan **Home**/**End** hoppar till
     ändarna, annonserat via en `aria-live`-region. Vanliga piltangenter
     knuffar fortfarande, så inget inarbetat ändrades — Shift+piltangenter
     var lediga. Noter använder *roving tabindex* så Tab inte vandrar genom
     hundratals block.
  4. **Tillstånd låg bara i CSS-klasser.** Mute/Solo och per-not-växlarna har
     nu `aria-pressed`; Pen/Eraser/Grab blev en `role="radiogroup"` med
     `aria-checked` eftersom det är ett val och inte tre oberoende växlar.
     Ikonknappar som bara gick att tolka positionellt (M/S/✕ per spår) namnger
     nu sitt spår.
  Dessutom: panelrubrikerna låg på 3.23:1 kontrast (under AA) och är nu
  5.32:1. Brödtext och dämpad text klarade redan AA.
- [ ] **Skapa noter från tangentbordet** — går fortfarande inte. Man kan nå,
  välja och redigera det som finns, men själva komponerandet kräver pekdon.
  Skulle behöva en rumslig modell av griden (markör-position, oktav, kolumn)
  snarare än bara en markering — betydligt större arbete än den här
  genomgången.

## Övrigt (mindre, ej verifierat som blockerande)

- [ ] Endast engelskt UI (`<html lang="en">`) — ingen lokalisering.
- [ ] Inget MIDI-/USB-tangentbordsstöd för att spela in noter live
  (ingen `navigator.requestMIDIAccess`/Web MIDI-kod i källan).
