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

## Lagring / delning

- [ ] **Bara lokalt.** Sparade låtar ligger i `localStorage` i webbläsaren;
  ingen delning via länk och ingen synk mellan enheter. Save file / Load
  file är i dag hela svaret på "flytta en låt någon annanstans".

## Dokumentationsskuld

- [ ] **Spårhuvudets redesign är inte dokumenterad.** PR #111 och de två
  FX-omgångarna efter den byggde om spårhuvudet (Osc/Inserts/Output),
  gjorde vågformsväljaren till en flytande listbox, införde
  `MASTER_FX_REGISTRY` med chips/popovers för mastern, och skrev om
  Envelope & Filter-raden — utan att röra `CLAUDE.md`, `DESIGN.md` eller
  `README.md`. FX-panelen och `activeFx` är ikappskrivna (den här
  omgången), men resten beskriver fortfarande appen som den såg ut innan:
  vågformsväljaren som en `role="radiogroup"`, masterns FX som en rad
  reglage, Envelope-raden med enbokstavsetiketter. `docs/superpowers/`
  har specarna och planerna, så materialet finns — det är
  arkitekturdokumenten som halkat efter.

## Kvalitet

- [ ] **`cdp.send()` kan hänga för evigt — sviten stod still i 25 minuter.**
  Loggen rörde sig inte mitt i `'Duty: a square track has its own default…'`
  medan processen levde. Stegets egna moment kördes sedan för hand och
  fungerade alla (Env-knappen hittas, `.adsr-select` dyker upp, pennklicket
  placerar en not, inspektorn visar den), och en omkörning på identisk kod
  gav 50/50 grönt — så det var varken koden under test eller steget.
  **Var timeouten saknas:** `waitFor()` *har* en (5 s), men den hjälper inte,
  för `waitFor` anropar `cdp.evaluate` → `cdp.send`, och `send()` lägger sitt
  löfte i `pending` utan att någonsin avvisa det. Uteblir CDP-svaret blockeras
  `waitFor` inuti sitt allra första anrop och hinner aldrig räkna ned. Samma
  sak gäller varje annat `cdp.send`-anrop i filen, och `Runtime.evaluate` med
  `awaitPromise: true` hänger om sidans löfte aldrig löses.
  **Åtgärden hör alltså hemma på `send()`**, inte på `waitFor()`: ge varje
  begäran en deadline som avvisar med metodnamnet, så en hängning blir ett
  namngivet fel i stället för tystnad. (En tidigare version av den här posten
  påstod att `waitFor()` saknade timeout — fel, och det pekade åtgärden åt
  fel håll.)
  Vad som utlöser det är fortfarande okänt. Misstanke:
  `Page.addScriptToEvaluateOnNewDocument` staplar på sig, så vid steg 37 bär
  varje ny sida ett tiotal prototyp-patchar (`createPeriodicWave`,
  `createGain`, `startRendering`, `AudioParam`) och någon kombination låser
  sig ibland — men det är en gissning, inte en mätning.

## Småsaker

- [ ] **Kodexport kräver manuell copy.** `#export`-knappen fyller en
  `<textarea id="exportBox">` och markerar texten, men det finns varken en
  Kopiera-knapp (`navigator.clipboard`) eller nedladdning av filen direkt.
- [ ] **Inget MIDI-/USB-tangentbordsstöd.** Noter spelas in från
  datortangentbordet (se `DONE.md`); det finns ingen
  `navigator.requestMIDIAccess`-kod, så ett riktigt klaviatur går inte att
  koppla in.
- [ ] **Endast engelskt UI** (`<html lang="en">`) — ingen lokalisering.

## I ett annat repo

- [ ] **Frog vs Toad-spelets `audio.js` behöver uppdateras manuellt.**
  Formatbrottet `RHYTHM_TRACK` → `RHYTHM_TRACKS` gör att en färsk
  "⤓ Export code"-output inte längre går att klistra in rakt av i spelets
  nuvarande `audio.js`, som fortfarande förväntar sig det gamla enstaka
  `RHYTHM_TRACK`-objektet. Måste göras i
  [frogger-multiplayer](https://github.com/Ruperto72/frogger-multiplayer),
  inte här.
