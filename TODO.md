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

- [ ] **Klipp (clips) — en inspelning som ett eget objekt på tidslinjen.**
  I dag löses en tagning upp i lösnoter i samma ögonblick den landar:
  `state.tracks[id]` är en platt lista med absoluta `start`-kolumner, och vill
  man flytta tagningen markerar man den med marquee och drar. Den grupperingen
  är tillfällig — den finns tills man klickar någon annanstans. Det finns
  ingenting som *är* tagningen.
  **Modellen som efterfrågas är Pro Tools, och den har tre fält, inte två:**
  `{ start, len, offset, content }`. En not ljuder på
  `clip.start + (note.start - clip.offset)`, men bara innanför fönstret.
  `offset` är hjärtat: ett klipp är inte noterna utan ett **fönster** in i
  dem, vilket är precis det som gör trim icke-destruktivt — drar man in kanten
  raderas ingenting, och drar man ut den igen kommer noterna tillbaka. Utan
  `offset` har man "en grupp noter man kan dra", vilket är en annan funktion
  som råkar se likadan ut. Läkningsvillkoret faller dessutom ut gratis ur
  samma fält: två klipp går att slå ihop precis när
  `A.content === B.content && A.offset + A.len === B.offset && A.start + A.len === B.start`
  — samma källa, angränsande i innehållet, angränsande på tidslinjen. Det
  är Pro Tools egen regel, inte ett specialfall att koda.
  **Mätt spridning:** ≈115 läsningar av `.start` som datafält, fördelat på
  ett fyrtiotal funktioner. (Rå-grep ger fler — 27 rader är `osc.start()`,
  Web Audio och irrelevant. Funktionsattributionen är ungefärlig, gjord med
  awk mot närmast föregående `function`, så pilfunktioner kan hamna på fel
  namn.) **Den siffran är inte det dyra** — mekaniska omskrivningar är trista
  och säkra, och sviten täcker 76 steg av dem.
  **Det dyra är besluten modellen tvingar fram, som koden i dag inte har
  någon åsikt om:** får klipp överlappa på ett spår (Pro Tools säger nej i
  en lane — annars slutar `notesConflict()` betyda något på spårnivå)? Vad
  händer när en not dras förbi klippets kant — lämnar den klippet, växer
  klippet, eller tar den emot? Skapar inspelning alltid ett nytt klipp, och
  vad händer vid inspelning ovanpå ett befintligt? Opererar
  quantize/transponering på ett noturval, ett klipputval eller båda? Klipps
  en not som börjar innanför och slutar utanför (Pro Tools: ja, vid kanten)?
  Plus formatbrottet: `state.tracks[id]` går från `Note[]` till `Clip[]`,
  alltså `version` 2 → 3 i `currentSongData()`, med migrering för de
  medföljande låtarna i `songs/`, `js/song-data.js` och allt någon sparat —
  `auditBundledSongs()` validerar de första och måste följa med.
  **Konflikten med husets grepp är värd att säga rakt ut:** hela filosofin är
  "ett nytt X är en tabellrad", "en konvertering, en korrigering", "en
  redigeringsyta per värde". Ett klipplager är motsatsen — en ny dimension som
  varje befintlig yta måste växa en åsikt om. Det är samma sak som posten om
  alternativa tagningar säger om sig själv, fast större: den lägger en axel
  *ovanpå* `state.tracks[id]`, medan klipp bygger om själva notlagringen och
  ändrar vad varje redigeringsgest betyder.
  **Vägen, i två steg — och risken med att dela upp det.** Steg 1: klipp som
  fönster med noterna kvar absoluta, `state.clips[trackId]` som ett additivt
  och valfritt fält. Ger synliga block, dra-som-enhet, split och merge; ger
  *inte* icke-destruktiv trim. Passar kodbasen ovanligt väl, eftersom en låt
  utan `clips` då beter sig exakt som i dag — samma "absent means the
  default"-regel som `vel`, `pan`, `kit` och `duty` redan följer, och inget
  format bryts. Steg 2: `offset` och klipprelativt innehåll, alltså den
  riktiga modellen, och det är här de fyrtio funktionerna får betala.
  **Risken är att steg 1 kommer kännas 80 % rätt och att steg 2 aldrig blir
  av** — kvar blir den billiga modellen i den dyras kläder: block man kan dra,
  men trim som fortfarande raderar. Den som tar upp det här igen bör bestämma
  i förväg om steg 1 är ett mål eller bara en etapp.
  **Vad det gör med uppspelningen — den axeln avgör om det här får byggas.**
  Att materialet spelas upp utan störningar går före funktionen; hackar
  ljudet är klippen inte värda något. Uppdelat på de tre ställen kostnaden
  kan hamna:
  - *Ljudtråden: oförändrad.* Ett klipp är ett datamodellsbegrepp. Samma
    noter ger samma oscillatorer och gain-noder, röstpoolen
    (`VOICE_POOL_SIZE = 16` per kanal) är orörd, grafen är identisk. Det som
    faktiskt renderar ljud vet inte om att clips finns.
  - *Schemaläggningen: troligen en vinst.* `scheduleTrackNotes()` inleder i
    dag med `[...notes].sort(...)`, alltså en full kopia och sortering av
    spårets **hela** notlista vid varje chunk och för varje spår, trots att
    bara noterna i fönstret ska schemaläggas — en kostnad som skalar med
    låtens längd i stället för med fönstret. Med klipp hoppas hela klipp som
    inte överlappar fönstret över utan att deras noter rörs. Offset-räkningen
    (`clip.start + (note.start - clip.offset)` plus en fönsterkoll per not)
    är två additioner och en jämförelse — försumbart mot det.
  - *Renderingen: dyrare, och det är den som hotar ljudet här.* Kedjan är
    `loopTimer` (en vanlig `setTimeout` på huvudtråden) → `SCHEDULE_AHEAD_SEC
    = 0.3`, alltså hela marginalen JS har på sig att hinna schemalägga nästa
    chunk innan den ska låta. Instrumenterad render vid 24 spår är 81 ms
    bygge + 191 ms sammanfogning och layout = **272 ms**, alltså större delen
    av marginalen i *en* omritning. Appen ligger redan på den kanten: att
    dra en not anropar `scheduleRender()` per `pointermove`, coalescerat till
    en full `render()` per animationsruta. Klippdrag kostar exakt detsamma —
    inte värre — men klipprelativt→absolut per not läggs till i just den
    loop som redan är flaskhalsen.
  **Slutsatsen, och skälet att inte behandla det här som två arbeten:**
  ett klipp är en klart bättre enhet för radsignaturen i prestandaposten
  nedan än en platt notlista — `{start, len, offset}` plus en
  innehållsidentitet är några få fält, mot "varje not i spåret". Den
  optimeringen är redan byggd och mätt (**272 ms → 21 ms** vid 24 spår) och
  återställd enbart för att signaturen inte gick att göra säker. Klipp gör
  den lättare, inte svårare, och ger dessutom en optimering den platta
  modellen inte kan: ett klipp utanför vyn ritas som en enda ruta utan sitt
  innehåll. Bygger man klippen utan att röra renderingen får man en app som
  hackar vid ungefär samma spårantal som i dag, marginellt tidigare; bygger
  man dem tillsammans med radsignaturen hackar den *senare* än i dag. Knyt
  ihop de två.
  Andra ordningens effekt att hålla ögonen på: klipp gör det trivialt att
  duplicera material, så låtar blir tätare fortare, och täthet driver antalet
  samtidiga röster. Det är användaren som skriver mer musik snarare än
  modellen som slösar, men det är där taket kommer märkas först.

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
  **Se även klipp-posten ovan.** Signaturen är hela svårigheten här, och ett
  klipp är en bättre enhet för den än en platt notlista — `{start, len,
  offset}` plus en innehållsidentitet i stället för "varje not i spåret".
  Byggs klipp någon gång bör det här försöket göras i samma omgång, inte
  före och inte efter.

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
