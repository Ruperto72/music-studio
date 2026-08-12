# TODO

Vad som saknas i musikeditorn. Klara punkter ligger inte kvar här — de
flyttas till [`DONE.md`](DONE.md), som är arbetsjournalen med mätningar,
uteslutna hypoteser och varför lösningarna ser ut som de gör.

Ordnat efter hur troligt det är att någon faktiskt saknar det, inte efter
hur roligt det vore att bygga.

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

## Kreativa genvägar (nästa steg)

Tonart, skala, diatoniska ackord, ackordföljder, spårduplicering och
transponering är byggda (se `DONE.md`). Det som står kvar på samma tema, i den
ordning jag skulle ta det:

- [ ] **Överdubbning i loopen.** Loop och inspelning finns var för sig, men
  inte tillsammans: att spela in varv efter varv i samma loop utan att radera
  är hur trumstämmor och riff faktiskt växer fram. Bör vara en flagga på
  inspelningen snarare än en ny mekanism — `recNoteDown()`/`commitNote()`
  gör redan rätt sak, det som saknas är att transporten inte nollställer.
- [ ] **Variation inom ramar.** "Variera den här takten": knuffa några
  velocities, tappa eller lägg till ett slag, oktavflytta en not. Enkel att
  bygga och lätt att göra gimmickig — den ska föreslå, inte skriva över, och
  det är den designfrågan som avgör om den är värd något.
- [ ] **Alternativa tagningar per spår.** Den enda på listan som kräver en ny
  dimension i datamodellen (ett spår får flera stämmor, en aktiv). Medvetet
  framskjuten tills det visar sig att den saknas — undo täcker det mesta av
  "prova något" i dag.

## Inte planerat

- [ ] **Fliksystem i inspektorn** — avfärdat: det finns gott om plats när man
  kör på dator, och vid fem grupper vinner flikar ingenting. Om panelen
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

## Prestanda

- [ ] **Spårraderna byggs om helt vid varje omritning, och det är layouten
  som kostar.** Mätt: ≈9,5 ms per utfällt spår, samma spår hopfällda 1/38 så
  mycket, effekter syns inte alls (siffror i `DONE.md`, tabell och enradare i
  `DESIGN.md` B.4). **Det är inte spårhuvudet** — den attributionen stod här
  och i B.4 och var fel. Instrumenterat, per render vid 24 spår: bygga allt
  81 ms, varav `buildHeader()` för alla 24 är **7 ms**; sammanfogning och
  påtvingad layout **191 ms**. Hopfällt är billigt för att `renderPitchTrack()`
  returnerar innan gutter och lane byggs, inte för att huvudet hoppas över.
  **Två uppenbara lösningar är provade och uteslutna med mätning:**
  - *Cacha spårhuvuden mellan omritningar.* Byggd, med nyckel på allt
    `buildHeader()` läser. **100 % träff, noll vinst** (375 träffar, 0 missar;
    251 ms mot 247 utan). `renderTracks()` tömmer `#tracks`, så en
    återanvänd nod tvingar fram samma layout som en ny. Att bygga DOM:en var
    aldrig kostnaden.
  - *`content-visibility: auto` på `.track`.* **3–4× snabbare** (471 → 155 ms
    vid 48 spår) — och trasig: överhoppade rader rapporterar
    `contain-intrinsic-size` i stället för sin höjd (3660 mot 4130 px över 17
    rader), så speluppspelningslinjen slutade 470 px för tidigt och
    rullningslisten ljög. Platshållaren går inte att sätta rätt heller: en rad
    är så hög som den högsta av lanen (känd) och huvudet (innehållsdrivet).
  - *Låta raden sitta kvar och fylla om den.* Byggd. **Noll vinst** — raderna
    överlevde renderingen 24/24 och tiden stod stilla (250 ms mot 250). Proben
    som pekade dit mätte återinkoppling av noder vars layout redan var
    uträknad, vilket inte är vad en render gör.
  **Vad som återstår, nu med prislapp:** låta raden sitta kvar **och** hoppa
  över rader vars innehåll är oförändrat. Byggd och mätt: **272 ms → 21 ms**
  vid 24 spår, mot ett uppmätt tak på 15 ms. Ändå återställd. Skälet är inte
  vinsten utan säkerheten: signaturen måste namnge varje indata en rad ritar,
  och en glömd betyder en rad som tyst slutar uppdateras. Tre missades först
  och fångades av sviten (`oscPickerOpen`, markeringsrektangeln, radens egen
  plats i listan). Därefter började tre *andra* steg falla oregelbundet —
  master-EQ:ns ratt tappade fokus, step entry-Backspace, mobilens låtlista —
  där samma bygge gick igenom vid omkörning. Om ombyggnaden orsakade dem eller
  bara ändrade tajmingen så att de syntes blev aldrig fastställt, och att
  släppa en ändring i renderkärnan på den grunden går inte att försvara.
  Nästa försök behöver: signaturen härledd ur listor som redan finns
  (`SPARSE_TRACK_MAPS` täcker per-spårskartorna), ett verify-steg som påstår
  *båda* halvorna — att orörda rader återanvänds och att varje sak en rad
  ritar fortfarande tvingar fram en ombyggnad — och en svit som är stabil över
  upprepade körningar *före* ändringen, så att ett nytt oregelbundet fel går
  att härleda. **Det sista villkoret är nu uppfyllt:** varje steg nollställer
  appen själv, varje steg är kört mot en trasig app och bevisat bita, och
  `verify.js --only` gör det billigt att köra ett misstänkt steg tio gånger i
  rad. Det som fällde förra försöket — tre steg som föll oregelbundet utan att
  det gick att avgöra om ombyggnaden orsakade dem — går att avgöra nu. Notera att märka radelementet för att upptäcka en ombyggnad
  inte fungerar: en återanvänd rad *är* samma element, vilket är hela poängen.
  Steget "off-screen rows keep their real height" i `verify.js` finns för att
  hålla nästa försök ärligt.

## Lagring / delning

- [ ] **Bara lokalt.** Sparade låtar ligger i `localStorage` i webbläsaren;
  ingen delning via länk och ingen synk mellan enheter. Save file / Load
  file är i dag hela svaret på "flytta en låt någon annanstans".

## Småsaker

- [ ] **Kodexport kräver manuell copy.** `#export`-knappen fyller en
  `<textarea id="exportBox">` och markerar texten, men det finns varken en
  Kopiera-knapp (`navigator.clipboard`) eller nedladdning av filen direkt.
- [ ] **Endast engelskt UI** (`<html lang="en">`) — ingen lokalisering.

## I ett annat repo

- [ ] **Frog vs Toad-spelets `audio.js` behöver uppdateras manuellt.**
  Formatbrottet `RHYTHM_TRACK` → `RHYTHM_TRACKS` gör att en färsk
  "⤓ Export code"-output inte längre går att klistra in rakt av i spelets
  nuvarande `audio.js`, som fortfarande förväntar sig det gamla enstaka
  `RHYTHM_TRACK`-objektet. Måste göras i
  [frogger-multiplayer](https://github.com/Ruperto72/frogger-multiplayer),
  inte här.
