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
