// Continuous box-filter resampling: fractional windows carry across worklet blocks.
// This avoids dropping samples when the device runs at 44.1 or 48 kHz.
export class PcmResampler {
  constructor(inputRate, outputRate = 16000) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new TypeError('Invalid audio sample rate.');
    this.ratio = inputRate / outputRate;
    this.sum = 0;
    this.weight = 0;
  }
  process(input) {
    const output = [];
    for (const value of input) {
      const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      let remaining = 1;
      while (remaining > 1e-9) {
        const amount = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * amount;
        this.weight += amount;
        remaining -= amount;
        if (this.weight >= this.ratio - 1e-9) {
          output.push(this.sum / this.ratio);
          this.sum = 0;
          this.weight = 0;
        }
      }
    }
    return output;
  }
  flush() {
    const output = this.weight > 1e-9 ? [this.sum / this.weight] : [];
    this.sum = 0;
    this.weight = 0;
    return output;
  }
}

export function encodePcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, index) => {
    const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    view.setInt16(index * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
  });
  return bytes;
}
