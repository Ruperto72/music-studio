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
  `DESIGN.md` B.4).
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
  **Vad som återstår:** sluta *plocka loss* raderna i stället för att sluta
  bygga dem — uppdatera stapeln på plats så att en orörd rad behåller sin
  layout. Det är diffning, vilket filen annars inte gör, så det får förtjäna
  sin komplexitet. Steget "off-screen rows keep their real height" i
  `verify.js` finns för att hålla nästa försök ärligt.

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
