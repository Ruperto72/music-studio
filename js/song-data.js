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
const C6 = 1046.50, D6 = 1174.66;
const REST = 0;

// Relativ kanalvolym (mix). Samma tal används av spelet (AudioManager,
// gånger musicGain-mastern) och av music-editor.html — så balansen är
// densamma på båda ställena. Rytmen är lyft (1.4) så trummorna hörs
// tydligt under den täta melodin. Redigerbar via reglagen i editorn.
export const MIX = { lead: 0.9, harmony: 0.5, bass: 0.7, rhythm: 1.4 };

// Klangfärg (oscillatorform) och panorering (stereobild) per kanal. Samma
// tal delas av spelet och music-editor.html så låten låter likadant båda
// ställena. `osc` = vågform för de tonala rösterna ('square' | 'triangle' |
// 'sawtooth' | 'sine'); rytmen har ingen vågform ('kit'). `pan` = -1 (vänster)
// … 0 (mitten) … 1 (höger). Redigerbar via reglagen i editorn.
export const VOICES = {
  lead:    { osc: 'square',   pan: 0 },
  harmony: { osc: 'square',   pan: 0 },
  bass:    { osc: 'triangle', pan: 0 },
  rhythm:  { osc: 'kit',      pan: 0 }
};

// "Froggy Hop" — 32 takter (4× originalet), komponerad i fyra delar som
// byggs upp allt eftersom: del 1 (takt 1-8) = originaltemat med glest
// ackompanjemang (stämma tyst, gles bas/rytm); del 2 (9-16) fylligare med
// nya ackordfärger (C, Em, Am) och tjockare puls; del 3 (17-24) drivande
// utveckling i moll-färg som når styckets högsta toner (C6/D6) med mest grus;
// del 4 (25-32) klimax där alla effekter staplas, följt av en nedtrappning
// och en tunn dominant-turnaround i takt 32 som leder mjukt tillbaka in i
// takt 1 (loopen). d = längd i åttondelar; 8 per takt, 256 totalt per spår.
// Valfria effektflaggor per not (se _scheduleTone/_schedulePortamentoTone):
// `bend` glider tonhöjden mot målfrekvensen under notens sista hälft;
// `vib` = vibrato (tonhöjds-LFO); `trem` = tremolo (volym-LFO); `duty` =
// pulsbredd 0-1 för fyrkantsröster (0.5 = vanlig "square"); `arp` = lista med
// halvtonsoffset som notens grundton snabbt växlar med (chip-ackord);
// `porta` = portamento, en obruten legato-glidning in i nästa nots attack
// utan ny retrigger (skild från `bend`); `crush` = bitcrush (WaveShaperNode);
// `echo` = skickar noten till en delad eko-buss (feedback-DelayNode);
// `chorus` = en andra, lätt feldstämd oscillator ovanpå. Effekterna används
// som kryddor på utvalda noter, tätare och mer intensivt ju längre in i
// styckets uppbyggnad man kommer.
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
];

// Stämma — diatonisk ters under LEAD (tyst under den glesa intron, takt
// 1-4). Odekorerad, precis som originalet.
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
];

// Basgång (triangel) — glest plockad rot i intron (takt 1-4), oom-pah
// (rot/kvint) i mittpartierna, drivande åttondelsbas i utvecklingen
// (17-24), och en tunn dominant (D) i takt 32 som resolverar till G i loopen.
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
];

// Rytm — byggs upp: bara kick i takt 1-2, kick+hi-hat 3-4, full groove med
// backbeat-snare från takt 5, drivande åttondels-hi-hats i utvecklingen
// (17-24), fills vid klimaxen, och en nedåtgående tom-fill i takt 32 som
// leder tillbaka in i den glesa intron. `type` = kick|snare|hihat|tom.
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
];

// Låten som en ordnad lista av tonala röst-spår plus rytmspåret. Editorn
// redigerar exakt den här formen och dess export återskapar den — så spår kan
// läggas till, döpas om och tas bort utan att spelet behöver ändras. Byggs av
// arrayerna ovan så standardlåten är oförändrad. Varje tonalt spår: name,
// osc (vågform), pan (-1..1), mix (relativ volym), notes. Rytmspåret har hits.
export const TRACKS = [
  { name: 'Lead',    osc: VOICES.lead.osc,    pan: VOICES.lead.pan,    mix: MIX.lead,    notes: LEAD },
  { name: 'Harmony', osc: VOICES.harmony.osc, pan: VOICES.harmony.pan, mix: MIX.harmony, notes: HARMONY },
  { name: 'Bass',    osc: VOICES.bass.osc,    pan: VOICES.bass.pan,    mix: MIX.bass,    notes: BASS }
];
export const RHYTHM_TRACK = { name: 'Rhythm', pan: VOICES.rhythm.pan, mix: MIX.rhythm, hits: RHYTHM };

