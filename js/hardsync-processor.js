// Hard sync: one oscillator's phase is forced back to zero every time another
// completes a cycle. It is the SID's most recognisable gesture — voice 1 synced
// to voice 3 — and the reason a C64 lead can sound metallic and hollow at once.
//
// It has to be a worklet. Web Audio's OscillatorNode exposes no phase at all,
// and sync is a time-domain reset: there is no waveform table, PeriodicWave or
// combination of nodes that expresses "start this cycle over, now". The repo
// already runs one worklet (js/downsample-processor.js), so the loading and
// graceful-failure machinery this needs was there before it did.
//
// `frequency` is the *heard* pitch, i.e. the resetting oscillator, so bend,
// vibrato and arpeggio land on it and behave as they do on every other voice.
// `ratio` multiplies it for the oscillator being reset, and is what moves the
// timbre — the same meaning `ratio` already has for ring modulation and FM.
//
// The output is a raw phase ramp, not a band-limited one, so it aliases the way
// a digital chip of that era did. That is a choice rather than an oversight in
// an app whose other voices include a 93-sample LFSR and a bitcrusher; if it
// ever needs taming, PolyBLEP at the two discontinuities is the standard fix.
class HardSyncProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 440, minValue: 0, automationRate: 'a-rate' },
      { name: 'ratio', defaultValue: 2, minValue: 0, automationRate: 'a-rate' },
      { name: 'detune', defaultValue: 0, automationRate: 'a-rate' },
      // Stands in for start()/stop(), which an AudioWorkletNode does not have.
      // AudioParam automation on a worklet is sample-accurate, so a note
      // scheduled eight bars ahead still begins exactly on its column.
      { name: 'gate', defaultValue: 0, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    this.phaseSync = 0;
    this.phaseOsc = 0;
    this.wasOn = false;
    this.spent = false;
  }

  process(inputs, outputs, params) {
    const ch = outputs[0] && outputs[0][0];
    if (!ch) return true;
    const f = params.frequency, r = params.ratio, d = params.detune, g = params.gate;
    // A k-rate parameter arrives as a one-element array; an a-rate one as a
    // full block. Reading it either way keeps this correct if a caller ever
    // sets a parameter without automating it.
    const at = (p, i) => (p.length === 1 ? p[0] : p[i]);

    for (let i = 0; i < ch.length; i++) {
      if (at(g, i) < 0.5) {
        // Gated off after having sounded: the note is over and this node can
        // be collected, which is what returning false does.
        if (this.wasOn) this.spent = true;
        ch[i] = 0;
        continue;
      }
      if (!this.wasOn) { this.phaseSync = 0; this.phaseOsc = 0; this.wasOn = true; }
      const hz = Math.max(0, at(f, i)) * Math.pow(2, at(d, i) / 1200);
      this.phaseSync += hz / sampleRate;
      this.phaseOsc += (hz * Math.max(0, at(r, i))) / sampleRate;
      if (this.phaseSync >= 1) {
        this.phaseSync -= 1;
        this.phaseOsc = 0; // the sync itself
      }
      if (this.phaseOsc >= 1) this.phaseOsc -= 1;
      ch[i] = this.phaseOsc * 2 - 1;
    }
    return !this.spent;
  }
}

registerProcessor('hardsync-processor', HardSyncProcessor);
