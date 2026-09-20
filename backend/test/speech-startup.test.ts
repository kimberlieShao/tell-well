import assert from 'node:assert/strict';
import { test } from 'node:test';

const speechModule = new URL('../../frontend/elevenlabs-speech.js', import.meta.url).href;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function settles<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Startup did not settle promptly')), 1000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Expected startup event did not occur');
    await tick();
  }
}

async function adapterFixture(commitStrategy = 'manual', voidStart = false) {
  const { createElevenLabsSpeechInput } = await import(speechModule);
  const statuses: { type: string; message: string }[] = [];
  const tokens: { result: ReturnType<typeof deferred<Response>>; signal: AbortSignal }[] = [];
  const captures: {
    options: any; readiness: ReturnType<typeof deferred<void>>;
    starts: number; cancels: number; start(): Promise<void> | void; cancel(): void; finish(): Promise<void>;
  }[] = [];
  const sockets: Socket[] = [];
  class Socket {
    readyState = 0;
    bufferedAmount = 0;
    closed = false;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    messages: any[] = [];
    constructor(_url: string) { sockets.push(this); }
    emit(message: any) { this.onmessage?.({ data: JSON.stringify(message) }); }
    send(data: string) { this.messages.push(JSON.parse(data)); }
    close() { this.closed = true; this.readyState = 3; }
  }
  const textarea = { value: 'Existing note.', addEventListener() {}, removeEventListener() {} };
  const speech = createElevenLabsSpeechInput({
    textarea, commitStrategy, startTimeoutMs: 5000,
    onStatus: (status: { type: string; message: string }) => statuses.push(status),
    captureFactory: async (options: any) => {
      const capture = {
        options, readiness: deferred<void>(), starts: 0, cancels: 0,
        start() { this.starts++; return voidStart ? undefined : this.readiness.promise; },
        cancel() { this.cancels++; },
        async finish() {},
      };
      captures.push(capture);
      return capture;
    },
    // Deliberately ignore abort so late token responses also exercise isolation.
    fetchImpl: (_url: string, init: { signal: AbortSignal }) => {
      const token = { result: deferred<Response>(), signal: init.signal };
      tokens.push(token);
      return token.result.promise;
    },
    WebSocketImpl: Socket,
  });
  const start = () => {
    const promise: Promise<void> = speech.start();
    promise.catch(() => {});
    return promise;
  };
  const decode = (socket: Socket) => socket.messages.map(message => [...Buffer.from(message.audio_base_64, 'base64')]);
  return { speech, textarea, statuses, captures, tokens, sockets, start, decode };
}

for (const strategy of ['manual', 'vad']) {
  test(`${strategy} preserves beginning audio through token and websocket delays, then sends it exactly once in order`, async () => {
    const f = await adapterFixture(strategy);
    try {
      const starting = f.start();
      await until(() => f.tokens.length === 1);
      const capture = f.captures[0]!;
      assert.equal(capture.starts, 1, 'Capture must start while the token request is pending');
      capture.options.onAudio(new Uint8Array([1, 2, 3, 4]));
      capture.readiness.resolve();
      capture.options.onAudio(new Uint8Array([5, 6]));
      assert.equal(f.speech.isActive, true);
      assert.equal(f.statuses.some(status => status.type === 'listening'), false);

      f.tokens[0]!.result.resolve(Response.json({ token: 'test-token' }));
      await until(() => f.sockets.length === 1);
      const socket = f.sockets[0]!;
      capture.options.onAudio(new Uint8Array([7, 8]));
      assert.deepEqual(socket.messages, [], 'Connecting sockets must never receive queued audio');
      socket.readyState = 1;
      capture.options.onAudio(new Uint8Array([9, 10]));
      await tick();
      assert.deepEqual(socket.messages, [], 'An open socket is not ready until session_started');
      assert.equal(f.statuses.some(status => status.type === 'listening'), false);

      socket.emit({ message_type: 'session_started', config: { language_code: 'en' } });
      await settles(starting);
      capture.options.onAudio(new Uint8Array([11, 12]));
      socket.emit({ message_type: 'session_started', config: { language_code: 'en' } });
      assert.deepEqual(f.decode(socket), [[1, 2, 3, 4], [5, 6], [7, 8], [9, 10], [11, 12]]);
      assert.ok(socket.messages.every((message: any) => message.message_type === 'input_audio_chunk' && message.sample_rate === 16000 && message.commit === false));
      assert.equal(f.statuses.filter(status => status.type === 'listening').length, 1);
      assert.equal(capture.starts, 1);
      assert.equal(f.textarea.value, 'Existing note.');
    } finally { f.speech.destroy(); }
  });
}

test('network startup proceeds while capture readiness is pending, and listening waits for both', async () => {
  const f = await adapterFixture();
  try {
    let completed = false;
    const starting = f.start();
    starting.then(() => { completed = true; }, () => {});
    await until(() => f.tokens.length === 1);
    const capture = f.captures[0]!;
    assert.equal(capture.starts, 1);
    f.tokens[0]!.result.resolve(Response.json({ token: 'test-token' }));
    await until(() => f.sockets.length === 1);
    const socket = f.sockets[0]!;
    socket.readyState = 1;
    socket.emit({ message_type: 'session_started' });
    await tick();
    assert.equal(completed, false);
    assert.equal(f.statuses.some(status => status.type === 'listening'), false);
    capture.options.onAudio(new Uint8Array([13, 14]));
    capture.readiness.resolve();
    await settles(starting);
    assert.equal(completed, true);
    assert.deepEqual(f.decode(socket), [[13, 14]]);
    assert.equal(f.statuses.filter(status => status.type === 'listening').length, 1);
  } finally { f.speech.destroy(); }
});

test('legacy capture factories with a void start remain supported', async () => {
  const f = await adapterFixture('manual', true);
  try {
    const starting = f.start();
    await until(() => f.tokens.length === 1);
    f.captures[0]!.options.onAudio(new Uint8Array([15, 16]));
    f.tokens[0]!.result.resolve(Response.json({ token: 'test-token' }));
    await until(() => f.sockets.length === 1);
    const socket = f.sockets[0]!;
    socket.readyState = 1;
    socket.emit({ message_type: 'session_started' });
    await settles(starting);
    assert.deepEqual(f.decode(socket), [[15, 16]]);
    assert.equal(f.statuses.at(-1)!.type, 'listening');
  } finally { f.speech.destroy(); }
});

test('VAD waits for every pending language result before completing consecutive early segments', async () => {
  const f = await adapterFixture('vad');
  try {
    const starting = f.start();
    await until(() => f.tokens.length === 1);
    f.captures[0]!.readiness.resolve();
    f.tokens[0]!.result.resolve(Response.json({ token: 'test-token' }));
    await until(() => f.sockets.length === 1);
    const socket = f.sockets[0]!;
    socket.readyState = 1;
    socket.emit({ message_type: 'session_started' });
    await settles(starting);
    socket.emit({ message_type: 'committed_transcript', text: 'My first words.' });
    socket.emit({ message_type: 'committed_transcript', text: 'The rest of my answer.' });
    socket.emit({ message_type: 'committed_transcript_with_timestamps', text: 'My first words.', language_code: 'en' });
    assert.equal(f.speech.isActive, true, 'The second captured segment still awaits language verification');
    assert.equal(socket.closed, false);
    socket.emit({ message_type: 'committed_transcript_with_timestamps', text: 'The rest of my answer.', language_code: 'en' });
    assert.equal(await f.speech.finish(), 'Existing note. My first words. The rest of my answer.');
    assert.equal(socket.closed, true);
  } finally { f.speech.destroy(); }
});

for (const failure of ['cancel-token', 'cancel-socket', 'connection-error', 'capture-error']) {
  test(`${failure} releases startup capture and never replays its queued audio into a retry`, async () => {
    const f = await adapterFixture();
    try {
      const starting = f.start();
      await until(() => f.tokens.length === 1);
      const capture = f.captures[0]!;
      capture.options.onAudio(new Uint8Array([21, 22]));
      if (failure !== 'cancel-token') {
        f.tokens[0]!.result.resolve(Response.json({ token: 'old-token' }));
        await until(() => f.sockets.length === 1);
      }
      const oldSocket = f.sockets[0];
      const oldMessageHandler = oldSocket?.onmessage;
      if (failure.startsWith('cancel')) f.speech.cancel();
      else if (failure === 'connection-error') oldSocket!.onerror!();
      else capture.readiness.reject(Object.assign(new Error('Microphone failed before its first frame'), { code: 'SPEECH_CAPTURE_FAILED' }));
      await assert.rejects(settles(starting), {
        code: failure.startsWith('cancel') ? 'SPEECH_CANCELLED' : failure === 'connection-error' ? 'SPEECH_CONNECTION_LOST' : 'SPEECH_CAPTURE_FAILED',
      });
      assert.ok(capture.cancels > 0);
      assert.equal(f.tokens[0]!.signal.aborted, true);
      assert.equal(f.speech.isActive, false);
      assert.equal(f.textarea.value, 'Existing note.');
      if (oldSocket) assert.equal(oldSocket.closed, true);

      const retry = f.start();
      await until(() => f.tokens.length === 2);
      const nextCapture = f.captures[1]!;
      nextCapture.options.onAudio(new Uint8Array([31, 32]));
      nextCapture.readiness.resolve();
      // Browser/network callbacks can still arrive after cancellation.
      capture.options.onAudio(new Uint8Array([23, 24]));
      capture.readiness.resolve();
      f.tokens[0]!.result.resolve(Response.json({ token: 'late-old-token' }));
      oldMessageHandler?.({ data: JSON.stringify({ message_type: 'session_started' }) });
      f.tokens[1]!.result.resolve(Response.json({ token: 'new-token' }));
      await until(() => f.sockets.length === (oldSocket ? 2 : 1));
      const nextSocket = f.sockets.at(-1)!;
      nextSocket.readyState = 1;
      nextSocket.emit({ message_type: 'session_started' });
      await settles(retry);
      assert.deepEqual(f.decode(nextSocket), [[31, 32]]);
      if (oldSocket) assert.deepEqual(oldSocket.messages, []);
      assert.equal(f.statuses.filter(status => status.type === 'listening').length, 1);
    } finally { f.speech.destroy(); }
  });
}

test('startup buffering accepts 30 seconds of PCM and fails visibly before dropping leading audio', async () => {
  const f = await adapterFixture();
  try {
    const starting = f.start();
    await until(() => f.tokens.length === 1);
    const capture = f.captures[0]!;
    assert.equal(capture.starts, 1);
    capture.options.onAudio(new Uint8Array(30 * 16000 * 2));
    assert.equal(f.speech.isActive, true, 'The full recording limit fits in the startup queue');
    capture.options.onAudio(new Uint8Array([1, 2]));
    await assert.rejects(settles(starting), (error: any) => {
      assert.match(error.code, /^SPEECH_/);
      return true;
    });
    assert.equal(f.statuses.at(-1)!.type, 'error');
    assert.equal(f.speech.isActive, false);
    assert.ok(capture.cancels > 0);
    f.tokens[0]!.result.resolve(Response.json({ token: 'late-token' }));
    await tick();
    assert.deepEqual(f.sockets, []);
  } finally { f.speech.destroy(); }
});

async function nativeFixture() {
  const { createMicrophoneCapture } = await import(speechModule);
  const audio: number[][] = [];
  const errors: any[] = [];
  const controller = new AbortController();
  let stopped = 0;
  let closed = 0;
  let portClosed = 0;
  let worklet!: Worklet;
  const node = () => ({ connect() {}, disconnect() {} });
  class Context {
    state = 'running';
    audioWorklet = { async addModule() {} };
    destination = {};
    createMediaStreamSource = node;
    createGain = () => ({ ...node(), gain: { value: 1 } });
    async close() { this.state = 'closed'; closed++; }
  }
  class Worklet {
    port = { onmessage: null as ((event: { data: any }) => void) | null, close() { portClosed++; } };
    onprocessorerror: (() => void) | null = null;
    constructor() { worklet = this; }
    connect() {}
    disconnect() {}
    emit(data: any) { this.port.onmessage?.({ data }); }
  }
  const capture = await createMicrophoneCapture({
    signal: controller.signal,
    onAudio: (bytes: Uint8Array) => audio.push([...bytes]),
    onError: (error: any) => errors.push(error),
    mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() { stopped++; } }] }; } },
    AudioContextImpl: Context, AudioWorkletNodeImpl: Worklet,
  });
  return { capture, worklet, controller, audio, errors, counts: () => ({ stopped, closed, portClosed }) };
}

test('native start waits for a real nonempty PCM frame and preserves the first frame', async () => {
  const f = await nativeFixture();
  try {
    let ready = false;
    const starting = f.capture.start();
    assert.equal(typeof starting?.then, 'function');
    starting.then(() => { ready = true; }, () => {});
    f.worklet.emit({ type: 'audio', buffer: new ArrayBuffer(0) });
    f.worklet.emit({ type: 'audio', buffer: 'invalid' });
    f.worklet.emit({ type: 'unrelated' });
    await tick();
    assert.equal(ready, false, 'Empty or malformed messages do not prove microphone capture is running');
    f.worklet.emit({ type: 'audio', buffer: new Uint8Array([41, 42]).buffer });
    await settles(starting);
    assert.equal(ready, true);
    assert.deepEqual(f.audio, [[41, 42]]);
    await settles(f.capture.start());
    f.worklet.emit({ type: 'audio', buffer: new Uint8Array([43, 44]).buffer });
    assert.deepEqual(f.audio, [[41, 42], [43, 44]]);
  } finally { f.capture.cancel(); }
});

for (const action of ['cancel', 'abort', 'processor-error']) {
  test(`native ${action} rejects pending first-frame readiness and releases resources`, async () => {
    const f = await nativeFixture();
    try {
      const starting = f.capture.start();
      assert.equal(typeof starting?.then, 'function');
      const rejected = assert.rejects(settles(starting), { code: action === 'processor-error' ? 'SPEECH_CAPTURE_FAILED' : 'SPEECH_CANCELLED' });
      const oldHandler = f.worklet.port.onmessage;
      if (action === 'cancel') f.capture.cancel();
      else if (action === 'abort') f.controller.abort();
      else f.worklet.onprocessorerror!();
      await rejected;
      assert.deepEqual(f.counts(), { stopped: 1, closed: 1, portClosed: 1 });
      oldHandler?.({ data: { type: 'audio', buffer: new Uint8Array([51, 52]).buffer } });
      assert.deepEqual(f.audio, []);
      assert.equal(f.errors.length, action === 'processor-error' ? 1 : 0);
    } finally { f.capture.cancel(); }
  });
}
