// Demo song data for Music Studio — "Froggy Hop", the loop from the Frog vs
// Toad game. Pure data (note frequencies, the per-voice note arrays, and the
// TRACKS/RHYTHM_TRACK assembly the editor loads on start). The editor has its
// own Web Audio synthesis, so no audio engine lives here.

export const TEMPO_BPM = 150;
const EIGHTH_SEC  = 60 / TEMPO_BPM / 2;
const LOOKAHEAD_MS   = 25;   // hur ofta schemaläggaren vaknar
const SCHEDULE_AHEAD = 0.1;  // hur långt fram (sek) den lägger noter i kön

// Not-frekvenser (Hz), G-dur — F blir F# via förtecknet.
const B3 = 246.94;
const C4 = 261.63, D4 = 293.66, E4 = 329.63, Fs4 = 369.99, G4 = 392.00, A4 = 440.00, B4 = 493.88;
const C5 = 523.25, D5 = 587.33, E5 = 659.25, Fs5 = 739.99, G5 = 783.99, A5 = 880.00, B5 = 987.77;
const C3 = 130.81, D3 = 146.83, E3 = 164.81, Fs3 = 185.00, G3 = 196.00, A3 = 220.00;
const C6 = 1046.50, D6 = 1174.66, E6 = 1318.51;
const REST = 0;

// Relativ kanalvolym (mix). Samma tal används av spelet (AudioManager,
// gånger musicGain-mastern) och av music-editor.html — så balansen är
// densamma på båda ställena. Rytmen är lyft (1.4) så trummorna hörs
// tydligt under den täta melodin; Arp och Pad är lågt satta (0.35/0.3) så de
// kryddar utan att konkurrera med huvudmelodin. Redigerbar via reglagen i
// editorn.
export const MIX = { lead: 0.9, harmony: 0.5, bass: 0.7, arp: 0.35, pad: 0.3, rhythm: 1.4 };

// Klangfärg (oscillatorform) och panorering (stereobild) per kanal. Samma
// tal delas av spelet och music-editor.html så låten låter likadant båda
// ställena. `osc` = vågform för de tonala rösterna ('square' | 'triangle' |
// 'sawtooth' | 'sine'); rytmen har ingen vågform ('kit'). `pan` = -1 (vänster)
// … 0 (mitten) … 1 (höger). Arp och Pad panoreras isär (höger/vänster) för en
// bredare stereobild utan att röra de fyra ursprungliga kanalernas mittplacering.
// Redigerbar via reglagen i editorn.
export const VOICES = {
  lead:    { osc: 'square',   pan: 0 },
  harmony: { osc: 'square',   pan: 0 },
  bass:    { osc: 'triangle', pan: 0 },
  arp:     { osc: 'sawtooth', pan: 0.4 },
  pad:     { osc: 'sine',     pan: -0.4 },
  rhythm:  { osc: 'kit',      pan: 0 }
};

// "Froggy Hop" — 72 takter (~1:55 i 150 BPM), i nio 8-takters avsnitt. Takt
// 1-32 är den ursprungliga låten, oförändrad ton för ton (samma melodi,
// samma ackompanjemang): del 1 (1-8) glest intro-tema, del 2 (9-16) fylligare
// "Theme", del 3 (17-24) drivande moll-"Development" med mest grus, del 4
// (25-32) "Climax" där alla effekter staplas. Takt 33-72 är ny musik byggd
// runt samma tema: en "Bridge" (33-40) som drar ner till ett stillsamt
// chiptune-break där Arp och Pad tar över, en repris av temat ("Theme II",
// 41-48, samma Lead/Harmony/Bas som del 2 men med Arp-glitter och Pad under),
// en större "Climax II" (49-56, samma progression som del 4 men med Arp/Pad
// pålagt och en ny topp-not i takt 55-56), en nedtrappande "Breakdown"
// (57-64) som tunnar ut allt, och till sist en "Outro" (65-72) som bygger en
// stigande fill och sedan tystnar helt i takt 72 — en snygg övergång som
// landar exakt på den ensamma kicken i takt 1 när låten loopar.
// d = längd i åttondelar (kan vara bråkdel, t.ex. 0.5 = en sextondel); 8 per
// takt, 576 totalt per spår. Valfria effektflaggor per not (se
// _scheduleTone/_schedulePortamentoTone): `bend` glider tonhöjden mot
// målfrekvensen under notens sista hälft; `vib` = vibrato (tonhöjds-LFO);
// `trem` = tremolo (volym-LFO); `duty` = pulsbredd 0-1 för fyrkantsröster
// (0.5 = vanlig "square"); `arp` = lista med halvtonsoffset som notens
// grundton snabbt växlar med (chip-ackord) — används flitigt av Arp-spåret
// för snabba brutna ackord utan att skriva ut var sextondel för hand; `porta`
// = portamento, en obruten legato-glidning in i nästa nots attack utan ny
// retrigger (skild från `bend`); `crush` = bitcrush (WaveShaperNode); `echo`
// = skickar noten till en delad eko-buss (feedback-DelayNode); `chorus` = en
// andra, lätt feldstämd oscillator ovanpå; `vel` = notens volym 0.1-1 (utelämnad
// = 1), används här för mjukare dynamik i Breakdown/Outro. Effekterna
// används som kryddor på utvalda noter, tätare och mer intensivt ju längre in
// i styckets uppbyggnad man kommer.
export const LEAD = [
  { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 2, trem: true }, // takt 1
  { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1, bend: G5 }, { f: G5, d: 1, duty: 0.25, crush: true }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 2, chorus: true }, // takt 2
  { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: A4, d: 1 }, { f: G4, d: 1, vib: true, porta: true }, { f: Fs4, d: 2 }, // takt 3
  { f: D4, d: 2, vib: true, echo: true }, { f: REST, d: 2 }, { f: B4, d: 2, vib: true, echo: true }, { f: REST, d: 2 }, // takt 4
  { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: A5, d: 1 }, { f: Fs5, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: A5, d: 2, trem: true }, // takt 5
  { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: A5, d: 1, bend: B5 }, { f: B5, d: 1, duty: 0.25, crush: true }, { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: D5, d: 2, chorus: true }, // takt 6
  { f: A5, d: 1 }, { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: A4, d: 1, vib: true, porta: true }, { f: G4, d: 2 }, // takt 7
  { f: G4, d: 2, echo: true }, { f: REST, d: 2 }, { f: D4, d: 2, arp: [4, 7], crush: true }, { f: G4, d: 2, bend: D5, chorus: true }, // takt 8
  { f: B4, d: 1 }, { f: D5, d: 1 }, { f: G5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: G5, d: 2, duty: 0.5, chorus: true }, // takt 9
  { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: A4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 2, vib: true }, // takt 10
  { f: C5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 2, duty: 0.5 }, // takt 11
  { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: G5, d: 1 }, { f: D5, d: 2, chorus: true }, // takt 12
  { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 2, vib: true }, // takt 13
  { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: A4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: A5, d: 2, trem: true }, // takt 14
  { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: D5, d: 2 }, // takt 15
  { f: A4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: E5, d: 1 }, { f: Fs5, d: 1 }, { f: G5, d: 1 }, { f: A5, d: 2, bend: B5, crush: true }, // takt 16
  { f: E5, d: 1 }, { f: G5, d: 1 }, { f: B5, d: 1 }, { f: G5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 1 }, { f: B5, d: 2, duty: 0.25, crush: true }, // takt 17
  { f: B5, d: 1 }, { f: A5, d: 1 }, { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: E5, d: 2, vib: true }, // takt 18
  { f: C5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 1 }, { f: B5, d: 1 }, { f: C6, d: 1, crush: true }, { f: G5, d: 1 }, { f: E5, d: 2 }, // takt 19
  { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: A5, d: 1 }, { f: D6, d: 1, trem: true, crush: true }, { f: A5, d: 1 }, { f: Fs5, d: 1 }, { f: D5, d: 2 }, // takt 20
  { f: G5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: G5, d: 2, chorus: true }, // takt 21
  { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: A4, d: 1 }, { f: G4, d: 1 }, { f: A4, d: 1 }, { f: B4, d: 2, vib: true }, // takt 22
  { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: A5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 2, porta: true }, // takt 23
  { f: D5, d: 2 }, { f: A4, d: 1 }, { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: D5, d: 1 }, { f: A5, d: 2, bend: B5, echo: true }, // takt 24
  { f: G5, d: 1 }, { f: A5, d: 1 }, { f: B5, d: 1 }, { f: D6, d: 2, trem: true, crush: true, chorus: true }, { f: B5, d: 1 }, { f: A5, d: 1 }, { f: G5, d: 1 }, // takt 25
  { f: C6, d: 2, trem: true, chorus: true }, { f: B5, d: 1 }, { f: A5, d: 1 }, { f: G5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 2 }, // takt 26
  { f: D5, d: 1 }, { f: G5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 2, echo: true }, // takt 27
  { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 2, vib: true }, // takt 28
  { f: C5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 2 }, // takt 29
  { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: D4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 2, chorus: true }, // takt 30
  { f: A4, d: 1 }, { f: Fs4, d: 1 }, { f: D4, d: 1 }, { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 2, arp: [4, 7] }, // takt 31
  { f: G4, d: 2, echo: true }, { f: REST, d: 2 }, { f: A4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 2, chorus: true }, // takt 32
  // --- Bridge (33-40): chiptune-break i Em-C-G-D, Lead tiger tyst och lämnar rummet åt Arp/Pad ---
  { f: REST, d: 8 }, // takt 33
  { f: REST, d: 8 }, // takt 34
  { f: REST, d: 8 }, // takt 35
  { f: REST, d: 4 }, { f: E5, d: 2, vib: true }, { f: G5, d: 2, duty: 0.375 }, // takt 36
  { f: G5, d: 2, trem: true }, { f: D5, d: 2 }, { f: B4, d: 2 }, { f: G4, d: 2, porta: true }, // takt 37
  { f: REST, d: 8 }, // takt 38
  { f: D5, d: 2 }, { f: Fs5, d: 2, bend: A5 }, { f: A5, d: 2, duty: 0.25, crush: true }, { f: REST, d: 2 }, // takt 39
  { f: REST, d: 4 }, { f: Fs4, d: 1 }, { f: G4, d: 1 }, { f: A4, d: 2, porta: true }, // takt 40
  // --- Theme II (41-48): repris av del 2 (samma Lead/Harmony/Bas), Arp-glitter läggs ovanpå ---
  { f: B4, d: 1 }, { f: D5, d: 1 }, { f: G5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: G5, d: 2, duty: 0.5, chorus: true }, // takt 41
  { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: A4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 2, vib: true }, // takt 42
  { f: C5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 2, duty: 0.5 }, // takt 43
  { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: G5, d: 1 }, { f: D5, d: 2, chorus: true }, // takt 44
  { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 2, vib: true }, // takt 45
  { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: A4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: A5, d: 2, trem: true }, // takt 46
  { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: D5, d: 2 }, // takt 47
  { f: A4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: E5, d: 1 }, { f: Fs5, d: 1 }, { f: G5, d: 1 }, { f: A5, d: 2, bend: B5, crush: true }, // takt 48
  // --- Climax II (49-56): repris av del 4 (samma progression) med Arp/Pad pålagt, sedan en ny topp i 55-56 ---
  { f: G5, d: 1 }, { f: A5, d: 1 }, { f: B5, d: 1 }, { f: D6, d: 2, trem: true, crush: true, chorus: true }, { f: B5, d: 1 }, { f: A5, d: 1 }, { f: G5, d: 1 }, // takt 49
  { f: C6, d: 2, trem: true, chorus: true }, { f: B5, d: 1 }, { f: A5, d: 1 }, { f: G5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 2 }, // takt 50
  { f: D5, d: 1 }, { f: G5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 2, echo: true }, // takt 51
  { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 2, vib: true }, // takt 52
  { f: C5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 2 }, // takt 53
  { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: D4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 2, chorus: true }, // takt 54
  { f: E5, d: 1 }, { f: G5, d: 1 }, { f: B5, d: 1 }, { f: E6, d: 2, trem: true, crush: true, chorus: true }, { f: D6, d: 1 }, { f: B5, d: 1 }, { f: G5, d: 1 }, // takt 55
  { f: D6, d: 4, trem: true, crush: true, echo: true, chorus: true, bend: Fs5 }, { f: REST, d: 4 }, // takt 56
  // --- Breakdown (57-64): drar ur allt, G-D-Em-C, mjuka held notes med eko ---
  { f: REST, d: 2 }, { f: G5, d: 2, vib: true, echo: true, vel: 0.7 }, { f: D5, d: 2, vel: 0.7 }, { f: B4, d: 2, porta: true, vel: 0.7 }, // takt 57
  { f: REST, d: 8 }, // takt 58
  { f: REST, d: 2 }, { f: Fs5, d: 2, vib: true, echo: true, vel: 0.7 }, { f: D5, d: 2, vel: 0.7 }, { f: A4, d: 2, porta: true, vel: 0.7 }, // takt 59
  { f: REST, d: 8 }, // takt 60
  { f: REST, d: 2 }, { f: E5, d: 2, vib: true, echo: true, vel: 0.7 }, { f: B4, d: 2, vel: 0.7 }, { f: G4, d: 2, porta: true, vel: 0.7 }, // takt 61
  { f: REST, d: 8 }, // takt 62
  { f: REST, d: 2 }, { f: C5, d: 2, vib: true, echo: true, vel: 0.7 }, { f: G4, d: 2, vel: 0.7 }, { f: E4, d: 2, porta: true, vel: 0.7 }, // takt 63
  { f: REST, d: 4 }, { f: E4, d: 1, vel: 0.6 }, { f: D4, d: 1, vel: 0.6 }, { f: REST, d: 2 }, // takt 64
  // --- Outro (65-72): en sista, tysta hälsning från öppningsmotivet, sedan tystnad rätt in i loopens kick ---
  { f: G4, d: 4, echo: true, chorus: true, vib: true, vel: 0.6 }, { f: REST, d: 4 }, // takt 65
  { f: REST, d: 8 }, // takt 66
  { f: REST, d: 8 }, // takt 67
  { f: REST, d: 8 }, // takt 68
  { f: REST, d: 4 }, { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: A5, d: 1, bend: B5 }, { f: B5, d: 1, duty: 0.25, crush: true }, // takt 69
  { f: A5, d: 0.5 }, { f: B5, d: 0.5 }, { f: D6, d: 0.5 }, { f: E6, d: 0.5, crush: true }, { f: D6, d: 0.5 }, { f: B5, d: 0.5 }, { f: A5, d: 0.5 }, { f: Fs5, d: 0.5 }, { f: REST, d: 4 }, // takt 70
  { f: D6, d: 2, trem: true, crush: true, echo: true, bend: G5 }, { f: REST, d: 6 }, // takt 71
  { f: REST, d: 8 }, // takt 72 — tyst; loopen landar rätt på den ensamma kicken i takt 1
];

// Stämma — diatonisk ters under LEAD (tyst under den glesa intron, takt
// 1-4, samt under Bridge/Development/Breakdown/Outro där Arp eller Pad har
// rummet istället). Odekorerad, precis som originalet.
export const HARMONY = [
  { f: REST, d: 8 }, // takt 1
  { f: REST, d: 8 }, // takt 2
  { f: REST, d: 8 }, // takt 3
  { f: REST, d: 8 }, // takt 4
  { f: B4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 2 }, // takt 5
  { f: B4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: G5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 2 }, // takt 6
  { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: Fs4, d: 1 }, { f: E4, d: 2 }, // takt 7
  { f: E4, d: 2 }, { f: REST, d: 2 }, { f: B3, d: 2 }, { f: E4, d: 2 }, // takt 8
  { f: G4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 2 }, // takt 9
  { f: C5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: Fs4, d: 1 }, { f: G4, d: 1 }, { f: C5, d: 2 }, // takt 10
  { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 2 }, // takt 11
  { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 1 }, { f: B4, d: 2 }, // takt 12
  { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 2 }, // takt 13
  { f: D5, d: 1 }, { f: C5, d: 1 }, { f: B4, d: 1 }, { f: Fs4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 2 }, // takt 14
  { f: E5, d: 1 }, { f: D5, d: 1 }, { f: C5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: B4, d: 2 }, // takt 15
  { f: Fs4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: C5, d: 1 }, { f: D5, d: 1 }, { f: E5, d: 1 }, { f: Fs5, d: 2 }, // takt 16
  { f: C5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 2 }, // takt 17
  { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: D5, d: 1 }, { f: C5, d: 1 }, { f: B4, d: 1 }, { f: C5, d: 2 }, // takt 18
  { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: G5, d: 1 }, { f: A5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 2 }, // takt 19
  { f: B4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: B5, d: 1 }, { f: Fs5, d: 1 }, { f: D5, d: 1 }, { f: B4, d: 2 }, // takt 20
  { f: E5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 2 }, // takt 21
  { f: C5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: Fs4, d: 1 }, { f: E4, d: 1 }, { f: Fs4, d: 1 }, { f: G4, d: 2 }, // takt 22
  { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: Fs5, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: Fs4, d: 2 }, // takt 23
  { f: B4, d: 2 }, { f: Fs4, d: 1 }, { f: D4, d: 1 }, { f: Fs4, d: 1 }, { f: B4, d: 1 }, { f: Fs5, d: 2 }, // takt 24
  { f: E5, d: 1 }, { f: Fs5, d: 1 }, { f: G5, d: 1 }, { f: B5, d: 2 }, { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: E5, d: 1 }, // takt 25
  { f: A5, d: 2 }, { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 2 }, // takt 26
  { f: B4, d: 1 }, { f: E5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 2 }, // takt 27
  { f: C5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: C4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 2 }, // takt 28
  { f: A4, d: 1 }, { f: C5, d: 1 }, { f: B4, d: 1 }, { f: A4, d: 1 }, { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 2 }, // takt 29
  { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: B3, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 2 }, // takt 30
  { f: Fs4, d: 1 }, { f: D4, d: 1 }, { f: B3, d: 1 }, { f: D4, d: 1 }, { f: Fs4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 2 }, // takt 31
  { f: E4, d: 2 }, { f: REST, d: 2 }, { f: Fs4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 2 }, // takt 32
  // --- Bridge (33-40): tyst, låter Arp/Pad äga texturen; kommer in bara i pickupen till Theme II ---
  { f: REST, d: 8 }, // takt 33
  { f: REST, d: 8 }, // takt 34
  { f: REST, d: 8 }, // takt 35
  { f: REST, d: 8 }, // takt 36
  { f: REST, d: 8 }, // takt 37
  { f: REST, d: 8 }, // takt 38
  { f: REST, d: 8 }, // takt 39
  { f: REST, d: 4 }, { f: Fs4, d: 2 }, { f: A4, d: 2 }, // takt 40
  // --- Theme II (41-48): repris av del 2, oförändrad ---
  { f: G4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 2 }, // takt 41
  { f: C5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: Fs4, d: 1 }, { f: G4, d: 1 }, { f: C5, d: 2 }, // takt 42
  { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 2 }, // takt 43
  { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: E5, d: 1 }, { f: B4, d: 2 }, // takt 44
  { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 1 }, { f: A4, d: 1 }, { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 2 }, // takt 45
  { f: D5, d: 1 }, { f: C5, d: 1 }, { f: B4, d: 1 }, { f: Fs4, d: 1 }, { f: B4, d: 1 }, { f: D5, d: 1 }, { f: Fs5, d: 2 }, // takt 46
  { f: E5, d: 1 }, { f: D5, d: 1 }, { f: C5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: B4, d: 2 }, // takt 47
  { f: Fs4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 1 }, { f: C5, d: 1 }, { f: D5, d: 1 }, { f: E5, d: 1 }, { f: Fs5, d: 2 }, // takt 48
  // --- Climax II (49-56): repris av del 4, oförändrad — Arp/Pad bär det extra trycket ---
  { f: E5, d: 1 }, { f: Fs5, d: 1 }, { f: G5, d: 1 }, { f: B5, d: 2 }, { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: E5, d: 1 }, // takt 49
  { f: A5, d: 2 }, { f: G5, d: 1 }, { f: Fs5, d: 1 }, { f: E5, d: 1 }, { f: C5, d: 1 }, { f: E5, d: 2 }, // takt 50
  { f: B4, d: 1 }, { f: E5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 2 }, // takt 51
  { f: C5, d: 1 }, { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: C4, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 2 }, // takt 52
  { f: A4, d: 1 }, { f: C5, d: 1 }, { f: B4, d: 1 }, { f: A4, d: 1 }, { f: Fs4, d: 1 }, { f: A4, d: 1 }, { f: C5, d: 2 }, // takt 53
  { f: B4, d: 1 }, { f: G4, d: 1 }, { f: E4, d: 1 }, { f: B3, d: 1 }, { f: E4, d: 1 }, { f: G4, d: 1 }, { f: B4, d: 2 }, // takt 54
  { f: REST, d: 2 }, { f: B4, d: 2, vib: true }, { f: D5, d: 2 }, { f: G5, d: 2, chorus: true }, // takt 55
  { f: REST, d: 4 }, { f: A4, d: 2, trem: true }, { f: D5, d: 2, echo: true }, // takt 56
  // --- Breakdown (57-64): sparsamma terser under Leads långa toner ---
  { f: REST, d: 4 }, { f: D5, d: 2, vib: true, vel: 0.7 }, { f: B4, d: 2, vel: 0.7 }, // takt 57
  { f: REST, d: 8 }, // takt 58
  { f: REST, d: 4 }, { f: Fs4, d: 2, vib: true, vel: 0.7 }, { f: A4, d: 2, vel: 0.7 }, // takt 59
  { f: REST, d: 8 }, // takt 60
  { f: REST, d: 4 }, { f: G4, d: 2, vib: true, vel: 0.7 }, { f: B4, d: 2, vel: 0.7 }, // takt 61
  { f: REST, d: 8 }, // takt 62
  { f: REST, d: 4 }, { f: E4, d: 2, vib: true, vel: 0.7 }, { f: G4, d: 2, vel: 0.7 }, // takt 63
  { f: REST, d: 8 }, // takt 64
  // --- Outro (65-72): tyst, förutom en gnutta stöd under den stigande fillen ---
  { f: REST, d: 8 }, // takt 65
  { f: REST, d: 8 }, // takt 66
  { f: REST, d: 8 }, // takt 67
  { f: REST, d: 8 }, // takt 68
  { f: REST, d: 8 }, // takt 69
  { f: REST, d: 4 }, { f: Fs4, d: 2 }, { f: A4, d: 2 }, // takt 70
  { f: REST, d: 2 }, { f: D5, d: 2, trem: true, echo: true }, { f: REST, d: 4 }, // takt 71
  { f: REST, d: 8 }, // takt 72
];

// Basgång (triangel) — glest plockad rot i intron (takt 1-4), oom-pah
// (rot/kvint) i mittpartierna, drivande åttondelsbas i utvecklingen
// (17-24), en tunn dominant (D) i takt 32 som leder in i Bridgen, portamento-
// glidande ackordrötter genom Bridge/Breakdown (33-40, 57-64), och till sist
// en utdragen dominant-pedal (D) i takt 69-71 som tystnar helt i takt 72.
export const BASS = [
  { f: G3, d: 2 }, { f: REST, d: 6 }, // takt 1
  { f: G3, d: 2 }, { f: REST, d: 6 }, // takt 2
  { f: D3, d: 2 }, { f: REST, d: 6 }, // takt 3
  { f: G3, d: 2 }, { f: REST, d: 6 }, // takt 4
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 5
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 6
  { f: D3, d: 2 }, { f: A3, d: 2 }, { f: D3, d: 2 }, { f: A3, d: 2 }, // takt 7
  { f: G3, d: 2 }, { f: REST, d: 2 }, { f: G3, d: 2 }, { f: G3, d: 2 }, // takt 8
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 9
  { f: E3, d: 2 }, { f: B3, d: 2 }, { f: E3, d: 2 }, { f: B3, d: 2 }, // takt 10
  { f: C3, d: 2 }, { f: G3, d: 2 }, { f: C3, d: 2 }, { f: G3, d: 2 }, // takt 11
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 12
  { f: A3, d: 2 }, { f: E4, d: 2 }, { f: A3, d: 2 }, { f: E4, d: 2 }, // takt 13
  { f: D3, d: 2 }, { f: A3, d: 2 }, { f: D3, d: 2 }, { f: A3, d: 2 }, // takt 14
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 15
  { f: D3, d: 2 }, { f: A3, d: 2 }, { f: D3, d: 2 }, { f: A3, d: 2 }, // takt 16
  { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, // takt 17
  { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, // takt 18
  { f: C3, d: 1 }, { f: G3, d: 1 }, { f: C3, d: 1 }, { f: G3, d: 1 }, { f: C3, d: 1 }, { f: G3, d: 1 }, { f: C3, d: 1 }, { f: G3, d: 1 }, // takt 19
  { f: D3, d: 1 }, { f: A3, d: 1 }, { f: D3, d: 1 }, { f: A3, d: 1 }, { f: D3, d: 1 }, { f: A3, d: 1 }, { f: D3, d: 1 }, { f: A3, d: 1 }, // takt 20
  { f: G3, d: 1 }, { f: D4, d: 1 }, { f: G3, d: 1 }, { f: D4, d: 1 }, { f: G3, d: 1 }, { f: D4, d: 1 }, { f: G3, d: 1 }, { f: D4, d: 1 }, // takt 21
  { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, { f: E3, d: 1 }, { f: B3, d: 1 }, // takt 22
  { f: A3, d: 1 }, { f: E4, d: 1 }, { f: A3, d: 1 }, { f: E4, d: 1 }, { f: A3, d: 1 }, { f: E4, d: 1 }, { f: A3, d: 1 }, { f: E4, d: 1 }, // takt 23
  { f: D3, d: 1 }, { f: A3, d: 1 }, { f: D3, d: 1 }, { f: A3, d: 1 }, { f: D3, d: 1 }, { f: A3, d: 1 }, { f: D3, d: 1 }, { f: A3, d: 1 }, // takt 24
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 25
  { f: C3, d: 2 }, { f: G3, d: 2 }, { f: C3, d: 2 }, { f: G3, d: 2 }, // takt 26
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 27
  { f: E3, d: 2 }, { f: B3, d: 2 }, { f: E3, d: 2 }, { f: B3, d: 2 }, // takt 28
  { f: C3, d: 2 }, { f: G3, d: 2 }, { f: C3, d: 2 }, { f: G3, d: 2 }, // takt 29
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 30
  { f: D3, d: 2 }, { f: A3, d: 2 }, { f: D3, d: 2 }, { f: A3, d: 2 }, // takt 31
  { f: D3, d: 4 }, { f: REST, d: 4 }, // takt 32
  // --- Bridge (33-40): pedaler med glidande ackordrötter ---
  { f: E3, d: 4, porta: true }, { f: B3, d: 4 }, // takt 33
  { f: E3, d: 4 }, { f: B3, d: 4, porta: true }, // takt 34
  { f: C3, d: 4, porta: true }, { f: G3, d: 4 }, // takt 35
  { f: C3, d: 4 }, { f: G3, d: 4, porta: true }, // takt 36
  { f: G3, d: 4, porta: true }, { f: D4, d: 4 }, // takt 37
  { f: G3, d: 4 }, { f: D4, d: 4, porta: true }, // takt 38
  { f: D3, d: 4, porta: true }, { f: A3, d: 4 }, // takt 39
  { f: D3, d: 4 }, { f: A3, d: 4, porta: true }, // takt 40
  // --- Theme II (41-48): repris av del 2, oförändrad ---
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 41
  { f: E3, d: 2 }, { f: B3, d: 2 }, { f: E3, d: 2 }, { f: B3, d: 2 }, // takt 42
  { f: C3, d: 2 }, { f: G3, d: 2 }, { f: C3, d: 2 }, { f: G3, d: 2 }, // takt 43
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 44
  { f: A3, d: 2 }, { f: E4, d: 2 }, { f: A3, d: 2 }, { f: E4, d: 2 }, // takt 45
  { f: D3, d: 2 }, { f: A3, d: 2 }, { f: D3, d: 2 }, { f: A3, d: 2 }, // takt 46
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 47
  { f: D3, d: 2 }, { f: A3, d: 2 }, { f: D3, d: 2 }, { f: A3, d: 2 }, // takt 48
  // --- Climax II (49-56): repris av del 4, oförändrad, med en sista tung dominant-pedal i 56 ---
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 49
  { f: C3, d: 2 }, { f: G3, d: 2 }, { f: C3, d: 2 }, { f: G3, d: 2 }, // takt 50
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 51
  { f: E3, d: 2 }, { f: B3, d: 2 }, { f: E3, d: 2 }, { f: B3, d: 2 }, // takt 52
  { f: C3, d: 2 }, { f: G3, d: 2 }, { f: C3, d: 2 }, { f: G3, d: 2 }, // takt 53
  { f: G3, d: 2 }, { f: D4, d: 2 }, { f: G3, d: 2 }, { f: D4, d: 2 }, // takt 54
  { f: E3, d: 2 }, { f: B3, d: 2 }, { f: E3, d: 2 }, { f: B3, d: 2 }, // takt 55
  { f: D3, d: 8 }, // takt 56
  // --- Breakdown (57-64): utdragna pedaler, en per takt ---
  { f: G3, d: 8 }, // takt 57
  { f: G3, d: 4, porta: true }, { f: D3, d: 4 }, // takt 58
  { f: D3, d: 8 }, // takt 59
  { f: D3, d: 4, porta: true }, { f: A3, d: 4 }, // takt 60
  { f: E3, d: 8 }, // takt 61
  { f: E3, d: 4, porta: true }, { f: B3, d: 4 }, // takt 62
  { f: C3, d: 8 }, // takt 63
  { f: C3, d: 4 }, { f: D3, d: 4 }, // takt 64
  // --- Outro (65-72): tystnar helt i takt 72, precis innan loopens kick ---
  { f: G3, d: 8 }, // takt 65
  { f: G3, d: 8 }, // takt 66
  { f: C3, d: 8 }, // takt 67
  { f: C3, d: 8 }, // takt 68
  { f: D3, d: 8 }, // takt 69
  { f: D3, d: 8 }, // takt 70
  { f: D3, d: 8 }, // takt 71
  { f: REST, d: 8 }, // takt 72
];

// Arp (sawtooth, pan höger) — nytt spår. Tyst genom hela originaltemat utom
// några lätta accenter i del 2 (9-16); äger rummet i Bridgen (33-40) med
// brutna ackord via `arp`-flaggan, glittrar igen i Theme II (41-48), är som
// mest aktiv i Climax II (49-56, med en snabb sextondels-körning i takt 56),
// och avslutar med en stigande löpning upp mot E6 i takt 70 innan den tystnar.
export const ARP = [
  { f: REST, d: 8 }, // takt 1
  { f: REST, d: 8 }, // takt 2
  { f: REST, d: 8 }, // takt 3
  { f: REST, d: 8 }, // takt 4
  { f: REST, d: 8 }, // takt 5
  { f: REST, d: 8 }, // takt 6
  { f: REST, d: 8 }, // takt 7
  { f: REST, d: 8 }, // takt 8
  { f: REST, d: 6 }, { f: G4, d: 2, arp: [4, 7], duty: 0.5 }, // takt 9
  { f: REST, d: 6 }, { f: E4, d: 2, arp: [3, 7] }, // takt 10
  { f: REST, d: 6 }, { f: C4, d: 2, arp: [4, 7] }, // takt 11
  { f: REST, d: 6 }, { f: G4, d: 2, arp: [4, 7] }, // takt 12
  { f: REST, d: 6 }, { f: A3, d: 2, arp: [3, 7] }, // takt 13
  { f: REST, d: 6 }, { f: D4, d: 2, arp: [4, 7] }, // takt 14
  { f: REST, d: 6 }, { f: G4, d: 2, arp: [4, 7] }, // takt 15
  { f: REST, d: 6 }, { f: D4, d: 2, arp: [4, 7], crush: true }, // takt 16
  { f: REST, d: 8 }, // takt 17
  { f: REST, d: 8 }, // takt 18
  { f: REST, d: 8 }, // takt 19
  { f: REST, d: 8 }, // takt 20
  { f: REST, d: 8 }, // takt 21
  { f: REST, d: 8 }, // takt 22
  { f: REST, d: 8 }, // takt 23
  { f: REST, d: 8 }, // takt 24
  { f: REST, d: 8 }, // takt 25
  { f: REST, d: 8 }, // takt 26
  { f: REST, d: 8 }, // takt 27
  { f: REST, d: 8 }, // takt 28
  { f: REST, d: 8 }, // takt 29
  { f: REST, d: 8 }, // takt 30
  { f: REST, d: 8 }, // takt 31
  { f: REST, d: 8 }, // takt 32
  // --- Bridge (33-40): brutna ackord tar över texturen ---
  { f: E4, d: 4, arp: [3, 7], duty: 0.25, crush: true }, { f: REST, d: 4 }, // takt 33
  { f: REST, d: 4 }, { f: E4, d: 4, arp: [3, 7], duty: 0.375, crush: true }, // takt 34
  { f: C4, d: 4, arp: [4, 7], duty: 0.25, crush: true }, { f: REST, d: 4 }, // takt 35
  { f: REST, d: 4 }, { f: C4, d: 4, arp: [4, 7], duty: 0.5, crush: true }, // takt 36
  { f: G4, d: 4, arp: [4, 7], duty: 0.25, crush: true }, { f: REST, d: 4 }, // takt 37
  { f: REST, d: 4 }, { f: G4, d: 4, arp: [4, 7], duty: 0.5, crush: true }, // takt 38
  { f: D4, d: 4, arp: [4, 7], duty: 0.25, crush: true }, { f: REST, d: 4 }, // takt 39
  { f: REST, d: 2 }, { f: D4, d: 1 }, { f: Fs4, d: 1 }, { f: A4, d: 2, arp: [4, 7], duty: 0.375, crush: true }, { f: REST, d: 2 }, // takt 40
  // --- Theme II (41-48): glittrande accenter ovanpå reprisen ---
  { f: REST, d: 4 }, { f: G4, d: 2, arp: [4, 7], duty: 0.375 }, { f: D5, d: 2, arp: [4, 7] }, // takt 41
  { f: REST, d: 4 }, { f: E4, d: 2, arp: [3, 7] }, { f: B4, d: 2, arp: [3, 7] }, // takt 42
  { f: REST, d: 4 }, { f: C4, d: 2, arp: [4, 7] }, { f: G4, d: 2, arp: [4, 7] }, // takt 43
  { f: REST, d: 4 }, { f: G4, d: 2, arp: [4, 7] }, { f: D5, d: 2, arp: [4, 7] }, // takt 44
  { f: REST, d: 4 }, { f: A3, d: 2, arp: [3, 7] }, { f: E4, d: 2, arp: [3, 7] }, // takt 45
  { f: REST, d: 4 }, { f: D4, d: 2, arp: [4, 7] }, { f: A4, d: 2, arp: [4, 7] }, // takt 46
  { f: REST, d: 4 }, { f: G4, d: 2, arp: [4, 7] }, { f: D5, d: 2, arp: [4, 7] }, // takt 47
  { f: REST, d: 4 }, { f: D4, d: 2, arp: [4, 7], crush: true }, { f: A4, d: 2, arp: [4, 7], crush: true }, // takt 48
  // --- Climax II (49-56): som mest aktiv, effekterna staplas precis som i Lead ---
  { f: G4, d: 4, arp: [4, 7], duty: 0.25, crush: true, trem: true }, { f: D5, d: 4, arp: [4, 7], duty: 0.25, crush: true, chorus: true }, // takt 49
  { f: C4, d: 4, arp: [4, 7], crush: true, trem: true }, { f: G4, d: 4, arp: [4, 7], crush: true, chorus: true }, // takt 50
  { f: G4, d: 4, arp: [4, 7], crush: true, trem: true }, { f: D5, d: 4, arp: [4, 7], crush: true, chorus: true }, // takt 51
  { f: E4, d: 4, arp: [3, 7], crush: true, trem: true }, { f: B4, d: 4, arp: [3, 7], crush: true, chorus: true }, // takt 52
  { f: C4, d: 4, arp: [4, 7], crush: true, trem: true }, { f: G4, d: 4, arp: [4, 7], crush: true, chorus: true }, // takt 53
  { f: G4, d: 4, arp: [4, 7], crush: true, trem: true }, { f: D5, d: 4, arp: [4, 7], crush: true, chorus: true }, // takt 54
  { f: B4, d: 2, arp: [3, 7], crush: true }, { f: E5, d: 2, arp: [3, 7], crush: true, trem: true }, { f: B4, d: 2, arp: [3, 7] }, { f: E5, d: 2, arp: [3, 7], crush: true, trem: true, echo: true }, // takt 55
  { f: D5, d: 0.5, arp: [4, 7] }, { f: Fs5, d: 0.5, arp: [4, 7] }, { f: A5, d: 0.5, arp: [4, 7] }, { f: D6, d: 0.5, arp: [4, 7], crush: true }, { f: A5, d: 0.5 }, { f: Fs5, d: 0.5 }, { f: D5, d: 0.5 }, { f: A4, d: 0.5, crush: true }, { f: REST, d: 4 }, // takt 56
  { f: REST, d: 8 }, // takt 57
  { f: REST, d: 8 }, // takt 58
  { f: REST, d: 8 }, // takt 59
  { f: REST, d: 8 }, // takt 60
  { f: REST, d: 8 }, // takt 61
  { f: REST, d: 8 }, // takt 62
  { f: REST, d: 8 }, // takt 63
  { f: REST, d: 8 }, // takt 64
  { f: REST, d: 8 }, // takt 65
  { f: REST, d: 8 }, // takt 66
  { f: REST, d: 8 }, // takt 67
  { f: REST, d: 8 }, // takt 68
  { f: REST, d: 4 }, { f: D5, d: 1 }, { f: Fs5, d: 1 }, { f: A5, d: 2, arp: [4, 7], crush: true }, // takt 69
  { f: A5, d: 0.5 }, { f: B5, d: 0.5 }, { f: D6, d: 0.5 }, { f: E6, d: 0.5, crush: true }, { f: D6, d: 0.5 }, { f: B5, d: 0.5 }, { f: A5, d: 0.5 }, { f: Fs5, d: 0.5 }, { f: REST, d: 4 }, // takt 70
  { f: D6, d: 2, crush: true, trem: true, echo: true, bend: G5 }, { f: REST, d: 6 }, // takt 71
  { f: REST, d: 8 }, // takt 72
];

// Pad (sine, pan vänster) — nytt spår. Håller långa, ackordbärande toner:
// mjukt i intron (från takt 3), måttligt genom Theme, tyst genom den råa
// Developmenten (17-24) som får förbli exponerad, brett i Climax, som
// mest bärande genom Bridgen, och tonar ut genom Breakdown/Outro innan den
// bygger en sista stigande svepning i takt 69-71.
export const PAD = [
  { f: REST, d: 8 }, // takt 1
  { f: REST, d: 8 }, // takt 2
  { f: REST, d: 4 }, { f: D4, d: 4, chorus: true }, // takt 3
  { f: G4, d: 8, chorus: true, trem: true }, // takt 4
  { f: G4, d: 8, chorus: true, trem: true }, // takt 5
  { f: G4, d: 8, chorus: true, trem: true }, // takt 6
  { f: D4, d: 8, chorus: true, trem: true }, // takt 7
  { f: G4, d: 8, chorus: true, trem: true }, // takt 8
  { f: G4, d: 8, chorus: true }, // takt 9
  { f: E4, d: 8, chorus: true }, // takt 10
  { f: C4, d: 8, chorus: true }, // takt 11
  { f: G4, d: 8, chorus: true }, // takt 12
  { f: A3, d: 8, chorus: true }, // takt 13
  { f: D4, d: 8, chorus: true }, // takt 14
  { f: G4, d: 8, chorus: true }, // takt 15
  { f: D4, d: 8, chorus: true }, // takt 16
  { f: REST, d: 8 }, // takt 17
  { f: REST, d: 8 }, // takt 18
  { f: REST, d: 8 }, // takt 19
  { f: REST, d: 8 }, // takt 20
  { f: REST, d: 8 }, // takt 21
  { f: REST, d: 8 }, // takt 22
  { f: REST, d: 8 }, // takt 23
  { f: REST, d: 8 }, // takt 24
  { f: G4, d: 8, chorus: true, trem: true }, // takt 25
  { f: C4, d: 8, chorus: true, trem: true }, // takt 26
  { f: G4, d: 8, chorus: true, trem: true }, // takt 27
  { f: E4, d: 8, chorus: true, trem: true }, // takt 28
  { f: C4, d: 8, chorus: true, trem: true }, // takt 29
  { f: G4, d: 8, chorus: true, trem: true }, // takt 30
  { f: D4, d: 8, chorus: true, trem: true }, // takt 31
  { f: D4, d: 8, chorus: true, trem: true, echo: true }, // takt 32
  // --- Bridge (33-40): huvudbärare av texturen tillsammans med Arp ---
  { f: E4, d: 8, chorus: true, trem: true }, // takt 33
  { f: E4, d: 8, chorus: true, trem: true }, // takt 34
  { f: C4, d: 8, chorus: true, trem: true }, // takt 35
  { f: C4, d: 8, chorus: true, trem: true }, // takt 36
  { f: G4, d: 8, chorus: true, trem: true }, // takt 37
  { f: G4, d: 8, chorus: true, trem: true }, // takt 38
  { f: D4, d: 8, chorus: true, trem: true }, // takt 39
  { f: D4, d: 8, chorus: true, trem: true }, // takt 40
  // --- Theme II (41-48): måttligt, som i originalets Theme ---
  { f: G4, d: 8, chorus: true }, // takt 41
  { f: E4, d: 8, chorus: true }, // takt 42
  { f: C4, d: 8, chorus: true }, // takt 43
  { f: G4, d: 8, chorus: true }, // takt 44
  { f: A3, d: 8, chorus: true }, // takt 45
  { f: D4, d: 8, chorus: true }, // takt 46
  { f: G4, d: 8, chorus: true }, // takt 47
  { f: D4, d: 8, chorus: true }, // takt 48
  // --- Climax II (49-56): som bredast ---
  { f: G4, d: 8, chorus: true, trem: true }, // takt 49
  { f: C4, d: 8, chorus: true, trem: true }, // takt 50
  { f: G4, d: 8, chorus: true, trem: true }, // takt 51
  { f: E4, d: 8, chorus: true, trem: true }, // takt 52
  { f: C4, d: 8, chorus: true, trem: true }, // takt 53
  { f: G4, d: 8, chorus: true, trem: true }, // takt 54
  { f: E4, d: 8, chorus: true, trem: true }, // takt 55
  { f: D4, d: 8, chorus: true, trem: true, echo: true }, // takt 56
  // --- Breakdown (57-64): tonar ut en oktav ner, tystnar helt i takt 64 ---
  { f: G4, d: 8, chorus: true }, // takt 57
  { f: G3, d: 8, chorus: true, vel: 0.7 }, // takt 58
  { f: D4, d: 8, chorus: true }, // takt 59
  { f: D3, d: 8, chorus: true, vel: 0.7 }, // takt 60
  { f: E4, d: 8, chorus: true }, // takt 61
  { f: E3, d: 8, chorus: true, vel: 0.7 }, // takt 62
  { f: C4, d: 8, chorus: true }, // takt 63
  { f: REST, d: 8 }, // takt 64
  // --- Outro (65-72): tyst tills den sista stigande svepningen ---
  { f: REST, d: 8 }, // takt 65
  { f: G4, d: 4, chorus: true, vel: 0.6 }, { f: REST, d: 4 }, // takt 66
  { f: REST, d: 8 }, // takt 67
  { f: REST, d: 8 }, // takt 68
  { f: D4, d: 8, chorus: true, trem: true }, // takt 69
  { f: D4, d: 4, chorus: true, trem: true }, { f: D5, d: 4, bend: Fs5, chorus: true, trem: true, echo: true }, // takt 70
  { f: D5, d: 2, trem: true, echo: true, bend: G4 }, { f: REST, d: 6 }, // takt 71
  { f: REST, d: 8 }, // takt 72
];

// Rytm — byggs upp: bara kick i takt 1-2, kick+hi-hat 3-4, full groove med
// backbeat-snare från takt 5, drivande åttondels-hi-hats i utvecklingen
// (17-24), fills vid klimaxen, en nedåtgående tom-fill i takt 32 som leder in
// i Bridgen, en tillbakadragen half-time-groove i Bridgen (33-40) som byggs
// upp igen, en repris av grooven i Theme II/Climax II (41-56, med en ny
// snare-rulle-fill i takt 56), en utglesad kick/hi-hat-groove i Breakdown
// (57-64), och till sist en hi-hat-rullande stegring (69-70) och en stor
// tom-fill (71) som slutar i total tystnad genom takt 72 — rätt in i den
// ensamma kicken som öppnar loopen. `type` = kick|snare|hihat|tom.
export const RHYTHM = [
  { type: 'kick', d: 8 }, // takt 1
  { type: 'kick', d: 8 }, // takt 2
  { type: 'kick', d: 4 }, { type: 'hihat', d: 4 }, // takt 3
  { type: 'kick', d: 4 }, { type: 'hihat', d: 4 }, // takt 4
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 5
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, // takt 6
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 7
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'tom', d: 2 }, // takt 8
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 9
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, // takt 10
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 11
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'tom', d: 2 }, // takt 12
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 13
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, // takt 14
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 15
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'tom', d: 2 }, // takt 16
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, // takt 17
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, // takt 18
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, // takt 19
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, // takt 20
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, // takt 21
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, // takt 22
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, // takt 23
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'tom', d: 1 }, { type: 'tom', d: 1 }, { type: 'snare', d: 1 }, { type: 'tom', d: 1 }, // takt 24
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'tom', d: 1 }, // takt 25
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'kick', d: 1 }, { type: 'tom', d: 1 }, { type: 'snare', d: 1 }, { type: 'tom', d: 1 }, // takt 26
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 27
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 28
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 29
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 30
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'tom', d: 2 }, // takt 31
  { type: 'tom', d: 2 }, { type: 'tom', d: 2 }, { type: 'snare', d: 2 }, { type: 'kick', d: 2 }, // takt 32
  // --- Bridge (33-40): halveras ner, byggs sedan upp igen mot Theme II ---
  { type: 'kick', d: 8 }, // takt 33
  { type: 'kick', d: 8 }, // takt 34
  { type: 'kick', d: 4 }, { type: 'hihat', d: 4 }, // takt 35
  { type: 'kick', d: 4 }, { type: 'hihat', d: 4 }, // takt 36
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, // takt 37
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, // takt 38
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 39
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, { type: 'hihat', d: 1 }, // takt 40
  // --- Theme II (41-48): repris av del 2, oförändrad ---
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 41
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, // takt 42
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 43
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'tom', d: 2 }, // takt 44
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 45
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, { type: 'hihat', d: 2 }, // takt 46
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 47
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'tom', d: 2 }, // takt 48
  // --- Climax II (49-56): repris av del 4, med en ny snare-rulle-fill i takt 56 ---
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'tom', d: 1 }, // takt 49
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'kick', d: 1 }, { type: 'tom', d: 1 }, { type: 'snare', d: 1 }, { type: 'tom', d: 1 }, // takt 50
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 51
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 52
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 53
  { type: 'kick', d: 2 }, { type: 'hihat', d: 2 }, { type: 'snare', d: 2 }, { type: 'hihat', d: 2 }, // takt 54
  { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, { type: 'kick', d: 1 }, { type: 'hihat', d: 1 }, { type: 'snare', d: 1 }, { type: 'hihat', d: 1 }, // takt 55
  { type: 'snare', d: 0.5 }, { type: 'snare', d: 0.5 }, { type: 'snare', d: 0.5 }, { type: 'snare', d: 0.5 }, { type: 'snare', d: 0.5 }, { type: 'snare', d: 0.5 }, { type: 'snare', d: 0.5 }, { type: 'snare', d: 0.5 }, { type: 'kick', d: 4 }, // takt 56
  // --- Breakdown (57-64): utglesad, tystare för varje takt ---
  { type: 'kick', d: 8 }, // takt 57
  { type: 'kick', d: 4 }, { type: 'hihat', d: 4 }, // takt 58
  { type: 'kick', d: 8 }, // takt 59
  { type: 'kick', d: 4 }, { type: 'hihat', d: 4 }, // takt 60
  { type: 'kick', d: 8 }, // takt 61
  { type: 'kick', d: 4 }, { type: 'hihat', d: 4 }, // takt 62
  { type: 'kick', d: 8 }, // takt 63
  { type: 'kick', d: 8 }, // takt 64
  // --- Outro (65-72): rullande stegring och en sista stor fill rakt in i tystnaden ---
  { type: 'kick', d: 8 }, // takt 65
  { type: 'kick', d: 8 }, // takt 66
  { type: 'kick', d: 8 }, // takt 67
  { type: 'kick', d: 8 }, // takt 68
  { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, // takt 69
  { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, { type: 'hihat', d: 0.5 }, // takt 70
  { type: 'tom', d: 1 }, { type: 'tom', d: 1 }, { type: 'tom', d: 1 }, { type: 'tom', d: 1 }, { type: 'snare', d: 1 }, { type: 'snare', d: 1 }, { type: 'kick', d: 1 }, { type: 'kick', d: 9 }, // takt 71-72 (tyst hela takt 72 — loopen landar rätt på takt 1:s ensamma kick)
];

// Låten som en ordnad lista av tonala röst-spår plus rytmspåret. Editorn
// redigerar exakt den här formen och dess export återskapar den — så spår kan
// läggas till, döpas om och tas bort utan att spelet behöver ändras. Byggs av
// arrayerna ovan så standardlåten är oförändrad. Varje tonalt spår: name,
// osc (vågform), pan (-1..1), mix (relativ volym), notes. Rytmspåret har hits.
export const TRACKS = [
  { name: 'Lead',    osc: VOICES.lead.osc,    pan: VOICES.lead.pan,    mix: MIX.lead,    notes: LEAD },
  { name: 'Harmony', osc: VOICES.harmony.osc, pan: VOICES.harmony.pan, mix: MIX.harmony, notes: HARMONY },
  { name: 'Bass',    osc: VOICES.bass.osc,    pan: VOICES.bass.pan,    mix: MIX.bass,    notes: BASS },
  { name: 'Arp',     osc: VOICES.arp.osc,     pan: VOICES.arp.pan,     mix: MIX.arp,     notes: ARP },
  { name: 'Pad',     osc: VOICES.pad.osc,     pan: VOICES.pad.pan,     mix: MIX.pad,     notes: PAD }
];
export const RHYTHM_TRACK = { name: 'Rhythm', pan: VOICES.rhythm.pan, mix: MIX.rhythm, hits: RHYTHM };
