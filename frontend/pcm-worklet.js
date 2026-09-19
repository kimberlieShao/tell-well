import { PcmResampler, encodePcm16 } from './pcm-resampler.js';

class CheckinPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new PcmResampler(sampleRate, 16000);
    this.pending = [];
    this.stopped = false;
    this.captured = 0;
    this.atLimit = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== 'flush' || this.stopped) return;
      this.stopped = true;
      if (!this.atLimit) this.pending.push(...this.resampler.flush());
      this.emit();
      this.port.postMessage({ type: 'flushed' });
    };
  }
  emit() {
    if (!this.pending.length) return;
    const bytes = encodePcm16(this.pending);
    this.pending = [];
    this.port.postMessage({ type: 'audio', buffer: bytes.buffer }, [bytes.buffer]);
  }
  process(inputs) {
    if (this.stopped) return false;
    // Audio runs independently of background-tab timers. Bound actual samples too.
    if (this.atLimit) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    const samples = this.resampler.process(mono).slice(0, 480000 - this.captured);
    this.captured += samples.length;
    this.pending.push(...samples);
    if (this.pending.length >= 3200) this.emit();
    if (this.captured >= 480000) {
      this.atLimit = true;
      this.emit();
      this.port.postMessage({ type: 'limit' });
    }
    return true;
  }
}

registerProcessor('checkin-pcm', CheckinPcmProcessor);
