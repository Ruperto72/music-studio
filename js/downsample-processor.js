// A lo-fi "sample and hold" downsampler: holds each input sample for `hold`
// output frames instead of passing every sample through, imitating a lower
// effective sample rate (classic 8-bit/chiptune "bitcrush" companion effect).
// This can't be done with any native AudioNode — WaveShaperNode reshapes each
// sample's amplitude but can't hold a sample across several output frames —
// so it needs a custom AudioWorkletProcessor running in the audio thread.
// hold=1 (the default) passes every sample through unchanged, so a track that
// never touches this control is untouched, same "neutral by default" contract
// as the rest of the master bus chain.
class DownsampleProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'hold', defaultValue: 1, minValue: 1, maxValue: 32, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this._held = []; // per-channel last-held sample value
    this._counter = 0;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    const hold = Math.max(1, Math.round(parameters.hold[0]));
    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch], outCh = output[ch];
      if (!inCh) continue;
      for (let i = 0; i < outCh.length; i++) {
        if ((this._counter + i) % hold === 0) this._held[ch] = inCh[i];
        outCh[i] = this._held[ch] ?? inCh[i];
      }
    }
    this._counter = (this._counter + (output[0] ? output[0].length : 128)) % hold;
    return true;
  }
}
registerProcessor('downsample-processor', DownsampleProcessor);
