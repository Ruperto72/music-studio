# TODO

Vad som saknas i musikeditorn. Klara punkter ligger inte kvar här — de
flyttas till [`DONE.md`](DONE.md), som är arbetsjournalen med mätningar,
uteslutna hypoteser och varför lösningarna ser ut som de gör.

Ordnat efter hur troligt det är att någon faktiskt saknar det, inte efter
hur roligt det vore att bygga.

## Från UI-granskningen (2026-09-23)

En genomgång av menyer, spårhuvud, inspektor, bottenrad, dialoger och
verktygspaneler (skärmbilder i 1440×900 av startlayouten och en laddad låt,
plus koden). Notinspektorn gjordes om i samma omgång, se `DONE.md`. Inte
granskat: redigeraren i mobilläge, MIDI-import och exportflödena. Ordnat
efter allvar.

- [ ] **Fel: "Back to the player" syns i menyn på desktop och gör ingenting.**
  `.file-menu-item { display: flex }` vinner över `hidden`-attributet, så
  knappen visas alltid. Verify-steget (Mobile) läser `.hidden`-egenskapen,
  som är sann, i stället för om knappen syns — därför passerade det. En
  global `[hidden] { display: none !important; }` stänger hela den klassen av
  fel (samma fälla fick `#arrange-move-row` en egen regel för), och steget
  bör kontrollera renderingen (`offsetParent`/`getClientRects()`).
- [ ] **Osparat arbete kan försvinna utan varning.** Att ladda en låt, starta
  en ny eller stänga/ladda om fliken sker utan fråga. `autosave()` skriver ett
  utkast, men ingenting i appen läser tillbaka det — skyddsnätet går bara att
  nå via devtools. Förslag: en rad "Senast osparade" överst under *My songs*
  i Songs, byggd från utkastet (i linje med att låtval alltid går via Songs),
  plus `beforeunload` och en fråga vid laddning/ny låt när något är osparat.
- [ ] **Spara är utspritt.** Menyn har *Save as .json* (fil); att spara i
  webbläsaren heter *Save current* och ligger längst ned i Songs, under alla
  exempel. Inget Ctrl+S. Förslag: **Save** (Ctrl+S) i menyn som sparar i
  *My songs* under låtens namn, fil-export/-import under en egen rubrik, och
  *My songs* före *Examples* i dialogen.
- [ ] **Chords-dialogen är en återvändsgränd i standardläget.** Startlayouten
  är Chromatic, så alla progressioner är avstängda, och texten hänvisar till
  bottenraden — som ligger bakom den modala dialogen. Förslag: tonart och
  skala direkt i dialogen, samma kontroller som i bottenraden.
- [ ] **Chords och Patterns är ikonknappar utan text** sist i spårhuvudets rad,
  medan Auto/Vel/Env har text. Chords delar dessutom glyfen `scale` med
  Transpose och Keep to scale — mot regeln att olika saker inte delar ikon.
  Förslag: texten "Chords"/"Patterns" och en egen glyf för Chords.
- [ ] **Menyns mittsektion blandar tre sorter.** Split/Heal clip, de fem
  redigeringsverktygen och Add track ligger i en lista utan rubriker, och Add
  track (en grundhandling) finns bara där. Förslag: underrubriker *Noter*
  (Timing, Transpose, Dynamics, Variation), *Låt* (Arrange, Split, Heal),
  *Spår* — och en synlig "+ Add track" under sista spåret.
- [ ] **Verktygspanelerna är textfyllda och följer olika mönster.** I Timing
  står båda reglagen först och båda knapparna sist, så vilket reglage som hör
  till vilken knapp måste gissas; Transpose och Dynamics börjar med en
  designmotivering ("this is the third axis…"). Förslag: samma mönster i alla
  fyra — räckviddsraden, sedan per handling reglage + knapp + en kort rad —
  och motiveringarna till hjälpen.
- [ ] **Raderna under spårhuvudet är inkonsekventa.** Stäng är ett nakent ✕
  på full bredd i Env och Auto men ett litet ✕ i Vel-lanen; Env-radens
  rubrik "Envelope, Filter & Duty" nämner inte Arpeggio Speed som också ligger
  där; knappen heter *Vel* men lanen den öppnar heter *Note*. Förslag: ett
  stäng-kryss uppe till höger överallt, rubriker som stämmer med knapparna.
- [ ] **Tre färger betyder "på".** Blått (verktyg, nottoggles), lila
  (Auto/Vel/Env) och grönt (Loop, Ghost notes, Master FX). Förslag: en
  på-färg för växlingsknappar; rött kvar för inspelning.
- [ ] **Bottenraden:** *Master*-reglaget är bara förhandslyssningens volym
  (påverkar inte exporten) men står bredvid mastereffekterna — döp om till
  *Monitor*. Keep to scale, Ghost notes och Master FX är bara ikoner; ge dem
  en kort textetikett.
- [ ] **Småsaker:** Inserts *Reset* visas även utan inserts och tar bort alla
  utan fråga — dölj den när det inte finns något att nollställa.
  Markörknappen ligger under "Loop & Zoom" fast markörer nu styr sektionerna —
  döp om gruppen till "Loop, markers & zoom".
- [ ] **Hjälpens menybild är inaktuell** — `menu-open.png` saknar Variation
  och Arrange. Tas om med `node shots.js --only menu-open`.

## Arrangering, uppföljning

- [ ] **Move och Duplicate flyttar material, inte klippstruktur.**
  `duplicateSpan()` kopierar det som syns (`trackNotes()`), och kopian läggs
  i de fönster som täcker målet. Klippgränser inne i sektionen följer inte
  med, och det ett trimmat fönster döljer inne i sektionen kopieras inte.
  För Duplicate är det ofarligt (originalet behåller sitt), men Move skär
  sedan bort källan med allt i den, så **dolt material i en flyttad sektion
  försvinner** — att dra ut fönsterkanten efteråt visar ingenting. Undo tar
  tillbaka det. Rätt lösning är att kopiera fönstren inom spannet med sina
  noter (dolda inräknade) i stället för de synliga objekten, vilket också
  skulle låta en delad sektion behålla sina delningar när den flyttas.

## Framskjutet (medvetet, inte glömt)

- [ ] **Sampling** — uppspelning av egna ljudfiler och granular syntes
  (`decodeAudioData()` + `AudioBufferSourceNode` med `.loop`/`.playbackRate`;
  granular byggs av många korta, överlappande korn schemalagda via upprepade
  `start()`-anrop, eller en egen `AudioWorkletProcessor`).
  **Designfrågan som måste avgöras först:** ett sample måste lagras
  *någonstans*. Base64 i låt-JSON:en gör filerna enorma (en sekund stereo
  ≈ 350 kB som text) och bryter mot "inga ljudfiler"; alternativet är att
  samplet bara lever i webbläsaren (IndexedDB) och att en delad låtfil
  refererar till det utan att bära det — då låter samma låt olika hos olika
  personer. Lutar åt base64 med hård längdgräns (~2 s mono, nedsamplat), så
  att en låt fortfarande är *en* fil.
- [ ] **Molnsynk och live-redigering** (flera personer i samma låt samtidigt).
  Kräver en server, vilket appen i dag inte har och inte kan få utan att
  bryta grundregeln om noll beroenden och statisk drift på GitHub Pages.
  Det som *går* utan server är delningslänkar: hela låten komprimerad i ett
  URL-fragment, så en låt kan skickas vidare utan att laddas upp någonstans.
  Se även "Lagring / delning" nedan.

- [ ] **Alternativa tagningar per spår.** Ett spår får flera stämmor, en aktiv
  — "spela in en till version av refrängen utan att förlora den här".
  Den återstående punkten ur omgången kreativa genvägar (tonart, skala,
  diatoniska ackord, ackordföljder, spårduplicering, transponering,
  överdubbning och dynamik är byggda — se `DONE.md`), och den enda som kräver
  en **ny dimension i datamodellen**: allt annat där var en tabellrad eller en
  ny läsning av något som redan fanns. Det slår igenom i låtformatet, i
  `SPARSE_TRACK_MAPS`, i undo-ögonblicksbilden och i exporten.
  Uppskjuten på beslut, inte på oklarhet: undo täcker det mesta av "prova
  något" i dag, och duplicera spår täcker resten — vill man ha två versioner
  kan man ha två spår och stänga av det ena. Tas upp igen när det visar sig
  att den saknas i praktiken snarare än i teorin.

- [ ] **MIDI-learn för trumpaddar.** Inkommande trumnoter går genom en fast
  General MIDI-tabell (`GM_DRUM_REVERSE`), som inte går att ändra i appen —
  träffar din klaviaturs paddar inte de noterna får du fel ljud eller inget
  alls. Uppkom med en Akai MPK mini: dess paddar visade sig skicka rätt noter
  i en av bankarna, så det gick att lösa på enheten, men bara av tur.
  **Två delar, varav den andra är den viktigare:**
  1. En mappning per webbläsare (`localStorage`, som andra editor-inställningar
     snarare än låtdata): slå på en pad, välj kit-ljud. Slås upp före
     `GM_DRUM_REVERSE`, som blir kvar som förval så filimporten är oförändrad.
  2. **En omappad not är i dag helt tyst** — pad:en gör ingenting och säger
     ingenting, så det går inte att skilja "kom inte fram" från "kändes inte
     igen". Den bör annonseras (`announce()`) med sitt notnummer, vilket
     dessutom är exakt det man behöver veta för att mappa den.
  Notera också att åtta paddar inte täcker tio kit-ljud; shaker (82) ligger
  långt från de andra och är den som oftast hamnar utanför.

## Inte planerat

- [ ] **Fliksystem i inspektorn** — avfärdat: det finns gott om plats när man
  kör på dator, och vid tre grupper vinner flikar ingenting. Grupperingen ur
  skissen nedan är sedan gjord *utan* flikar (Pitch, Sound och Add chord som
  handling, se `DONE.md`), med två avvikelser: portamento hör till Pitch,
  eftersom det utesluter bend och arpeggio, och duty till Sound, eftersom
  pulsbredd är klang. Om panelen
  någon gång växer till 8–10 grupper är det värt att ta upp igen, eftersom
  man då scrollar förbi en växande hög med stängda rubriker. Skissen som
  togs fram: `Selected note` och `Delete` ligger kvar utanför flikarna
  (identitet respektive destruktiv handling), och resten delas i **Sound**
  (Modulation + Texture/FX — alla booleska på/av), **Pitch**
  (bend/duty/arpeggio) och **Chord** (den enda handlingen som *skapar*
  noter, till skillnad från allt annat som är egenskaper). En prick på
  fliken när något i den är aktivt återställer en del av överblicken, men
  bara att *något* är på, inte vad.

## Öppna frågor

- [ ] **Var den återstående avvikelsen i WAV-exporten kommer ifrån är okänt.**
  När jag seedade bruset skrev jag att exporten därmed blev reproducerbar.
  Det stämde inte, och jag hann skriva in det i README och DESIGN innan jag
  hade end-to-end-beviset (bägge är rättade). Två fullständiga exporter av
  samma låt skiljer sig fortfarande — **även två i rad i samma sidladdning**,
  vilket visar att det som återstår sitter i själva renderingen och inte i
  vad sidan bygger vid uppstart.
  Vad mätningen visade för `Popcorn` (92 s): de första 6 sekunderna var exakt
  lika, sedan skilde sig 36 av 92 sekunder. Alltså ingen genomgående
  nivåskillnad, utan något som slår till för vissa ljud. (`Popcorn` togs
  senare bort ur biblioteket — mätningen står som den gjordes, men vill man
  köra om den får man välja en annan låt.)
  **Uteslutet, med mätning:** de seedade buffertarna (hashade *under* varje
  rendering — bitidentiska, så seedningen gör exakt vad den ska),
  AudioWorklet-nedsamplaren (blockerad modulladdning → 0 worklets, ändå
  olika), `ConvolverNode` (ersatt med en gain-nod, ändå olika),
  `DynamicsCompressorNode` (likaså) och röstpoolningen (`acquireVoice`
  tvingad att returnera null, ändå olika). Och: **två enkla toner i ett tomt
  projekt renderas identiskt**, så webbläsarens offline-rendering är
  reproducerbar i sig — det är något låten använder som inte är det.
  Kvar att undersöka: per-not-effekterna (echo/chorus/crush-vägarna),
  sidechain-duckningen, automationsramperna, och trumschemaläggningen.
  Storleken *är* mätt och är ohörbar, vilket gör det här till en öppen
  nyfikenhetsfråga snarare än en bugg. Skripten ligger inte i repot; de
  renderar en låt två gånger och jämför dels FNV-hashar per kanal och per
  sekund, dels sampel för sampel.

## Lagring / delning

- [ ] **Bara lokalt.** Sparade låtar ligger i `localStorage` i webbläsaren;
  ingen delning via länk och ingen synk mellan enheter. Save file / Load
  file är i dag hela svaret på "flytta en låt någon annanstans".

## Småsaker

- [ ] **Endast engelskt UI** (`<html lang="en">`) — ingen lokalisering.

## I ett annat repo

- [ ] **Frog vs Toad-spelets `audio.js` behöver uppdateras manuellt.**
  Formatbrottet `RHYTHM_TRACK` → `RHYTHM_TRACKS` gör att en färsk
  "⤓ Export code"-output inte längre går att klistra in rakt av i spelets
  nuvarande `audio.js`, som fortfarande förväntar sig det gamla enstaka
  `RHYTHM_TRACK`-objektet. Måste göras i
  [frogger-multiplayer](https://github.com/Ruperto72/frogger-multiplayer),
  inte här.
