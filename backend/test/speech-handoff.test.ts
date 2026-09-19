import assert from 'node:assert/strict';
import { test } from 'node:test';

const speechModule = new URL('../../frontend/elevenlabs-speech.js', import.meta.url).href;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function settles<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Operation remained pending after cancellation/timeout')), 1000);
      }),
    ]);
  } finally { clearTimeout(timer!); }
}

function contextFixture() {
  let insideClick = false;
  const contexts: Context[] = [];
  class Context {
    state = 'suspended';
    closes = 0;
    resumes = 0;
    constructor() { contexts.push(this); }
    resume() {
      this.resumes++;
      if (insideClick || this.state === 'running') {
        this.state = 'running';
        return Promise.resolve();
      }
      // Model a browser that requires user activation to unlock Web Audio.
      return new Promise<void>(() => {});
    }
    async close() { this.closes++; this.state = 'closed'; }
  }
  return {
    Context, contexts,
    click<T>(work: () => T): T {
      insideClick = true;
      try { return work(); } finally { insideClick = false; }
    },
  };
}

test('voice capture is unlocked in the Start click and shares one context across later turns', async () => {
  const { createVoiceSpeechFactory } = await import(speechModule);
  const f = contextFixture();
  const seen: any[] = [];
  const factory = createVoiceSpeechFactory({
    AudioContextImpl: f.Context,
    inputFactory: (options: any) => options,
    captureFactory: async (options: any) => {
      assert.equal(options.audioContext.state, 'running');
      seen.push(options.audioContext);
      return { cancel() {} };
    },
  });
  try {
    const ready = f.click(() => factory.prime());
    assert.equal(f.contexts.length, 1, 'Context creation must happen before the click returns');
    assert.equal(f.contexts[0]!.state, 'running', 'resume must run before user activation is lost');
    await settles(ready);
    // Both captures happen after speech playback, outside any click handler.
    const first = await factory({}).captureFactory({});
    first.cancel();
    const second = await factory({}).captureFactory({});
    second.cancel();
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.equal(f.contexts[0]!.closes, 0, 'Finishing a turn must not discard the unlocked context');
    factory.release();
    await tick();
    assert.equal(f.contexts[0]!.closes, 1);
    await settles(f.click(() => factory.prime()));
    assert.equal(f.contexts.length, 2, 'A newly started conversation must get a fresh context');
    assert.equal(f.contexts[1]!.state, 'running');
  } finally { factory.release(); }
});

test('releasing voice while audio unlocking is pending rejects promptly and closes the context', async () => {
  const { createVoiceSpeechFactory } = await import(speechModule);
  const f = contextFixture();
  const factory = createVoiceSpeechFactory({ AudioContextImpl: f.Context });
  const pending = factory.prime(); // Deliberately outside user activation.
  const rejected = assert.rejects(settles(pending), (error: any) => {
    assert.doesNotMatch(error.message, /remained pending/);
    return true;
  });
  factory.release();
  await rejected;
  assert.equal(f.contexts[0]!.closes, 1);
});

test('audio unlocking times out visibly and releases its suspended context', async () => {
  const { createVoiceSpeechFactory } = await import(speechModule);
  const f = contextFixture();
  const factory = createVoiceSpeechFactory({ AudioContextImpl: f.Context, primeTimeoutMs: 10 });
  try {
    await assert.rejects(settles(factory.prime()), (error: any) => {
      assert.doesNotMatch(error.message, /remained pending/);
      return true;
    });
    assert.equal(f.contexts[0]!.closes, 1);
    await settles(f.click(() => factory.prime()));
    assert.equal(f.contexts.length, 2, 'A timeout must not poison a later gesture-triggered retry');
    assert.equal(f.contexts[1]!.state, 'running');
  } finally { factory.release(); }
});

test('native capture releases tracks and nodes but leaves an externally owned context available for the next answer', async () => {
  const { createMicrophoneCapture } = await import(speechModule);
  let stopped = 0;
  let closed = 0;
  let portClosed = 0;
  const node = () => ({ connect() {}, disconnect() {} });
  const context = {
    state: 'running',
    async resume() {},
    async close() { closed++; this.state = 'closed'; },
    audioWorklet: { async addModule() {} },
    createMediaStreamSource: node,
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    destination: {},
  };
  class Worklet {
    port = { onmessage: null, close() { portClosed++; } };
    onprocessorerror = null;
    connect() {}
    disconnect() {}
  }
  const options = {
    audioContext: context,
    onAudio() {}, onError() {},
    mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() { stopped++; } }] }; } },
    AudioContextImpl: class { constructor() { throw new Error('Must reuse the provided context'); } },
    AudioWorkletNodeImpl: Worklet,
  };
  const first = await createMicrophoneCapture(options);
  first.start();
  first.cancel();
  const second = await createMicrophoneCapture(options);
  second.start();
  second.cancel();
  assert.equal(stopped, 2);
  assert.equal(portClosed, 2);
  assert.equal(closed, 0);
  assert.equal(context.state, 'running');
});

test('aborting native capture while AudioContext.resume is pending settles without waiting for a browser gesture', async () => {
  const { createMicrophoneCapture } = await import(speechModule);
  let resumeStarted = false;
  let stopped = 0;
  let closed = 0;
  class Context {
    state = 'suspended';
    resume() { resumeStarted = true; return new Promise<void>(() => {}); }
    async close() { closed++; this.state = 'closed'; }
  }
  const controller = new AbortController();
  const pending = createMicrophoneCapture({
    signal: controller.signal, onAudio() {}, onError() {},
    mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() { stopped++; } }] }; } },
    AudioContextImpl: Context,
    AudioWorkletNodeImpl: class {},
  });
  await tick(); // Permission resolved; capture is now waiting for resume().
  assert.equal(resumeStarted, true);
  const rejected = assert.rejects(settles(pending), { code: 'SPEECH_CANCELLED' });
  controller.abort();
  await rejected;
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
});


test('startup timeout identifies permission, token, or ElevenLabs connection instead of a generic hang', async () => {
  const { createElevenLabsSpeechInput } = await import(speechModule);
  for (const stage of ['permission', 'token', 'connection']) {
    const statuses: any[] = [];
    const field = { value: '', addEventListener() {}, removeEventListener() {} };
    const cancelled: string[] = [];
    const speech = createElevenLabsSpeechInput({
      textarea: field, startTimeoutMs: 15,
      onStatus: (status: any) => statuses.push(status),
      captureFactory: async () => stage === 'permission'
        ? new Promise(() => {})
        : { start() {}, cancel() { cancelled.push('capture'); } },
      fetchImpl: async (_url: string, init: any) => stage === 'token'
        ? new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled'))))
        : Response.json({ token: 'test-token' }),
      WebSocketImpl: class {
        onmessage = null; onerror = null; onclose = null;
        close() { cancelled.push('socket'); }
      },
    });
    try {
      await assert.rejects(settles(speech.start()), { code: 'SPEECH_START_TIMEOUT' });
      const last = statuses.at(-1);
      assert.equal(last.type, 'error');
      assert.match(last.message, stage === 'permission' ? /permission is still pending/ : stage === 'token' ? /backend could not prepare/ : /ElevenLabs did not connect/);
      assert.equal(speech.isActive, false);
      if (stage !== 'permission') assert.ok(cancelled.includes('capture'));
      if (stage === 'connection') assert.ok(cancelled.includes('socket'));
    } finally { speech.destroy(); }
  }
});
