import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createSpeechTokenProvider } from '../src/speech.js';
import { createApp } from '../src/app.js';
import { demoExtractor } from '../src/extractor.js';

const speechModule = new URL('../../frontend/elevenlabs-speech.js', import.meta.url).href;
const pcmModule = new URL('../../frontend/pcm-resampler.js', import.meta.url).href;

test('speech token provider sends credentials only to ElevenLabs and returns only the short-lived token', async () => {
  const provider = createSpeechTokenProvider({ apiKey: 'test-server-secret', fetcher: (async (url, init) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'test-server-secret');
    return Response.json({ token: 'test-single-use-token', extra: 'not returned' });
  }) as typeof fetch });
  assert.deepEqual(await provider(), { token: 'test-single-use-token' });
});

test('speech token provider rejects missing keys, invalid payloads, provider errors and timeout without exposing secrets', async () => {
  await assert.rejects(createSpeechTokenProvider({ apiKey: '' })(), { code: 'SPEECH_NOT_CONFIGURED' });
  for (const response of [Response.json({}), Response.json({ token: '' }), new Response('SECRET provider diagnostic', { status: 401 }), new Response('SECRET quota', { status: 429 })]) {
    const provider = createSpeechTokenProvider({ apiKey: 'SECRET', fetcher: (async () => response) as typeof fetch });
    await assert.rejects(provider(), (error: any) => error.code === 'SPEECH_UNAVAILABLE' && !error.message.includes('SECRET'));
  }
  const provider = createSpeechTokenProvider({ apiKey: 'SECRET', timeoutMs: 5, fetcher: ((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('SECRET timeout')), { once: true });
  })) as typeof fetch });
  await assert.rejects(provider(), (error: any) => error.code === 'SPEECH_UNAVAILABLE' && /too long/.test(error.message) && !error.message.includes('SECRET'));
});

test('speech token route keeps JSON and origin protections and never caches tokens', async () => {
  let calls = 0;
  const server = createApp(demoExtractor, { speechTokenProvider: async () => { calls++; return { token: 'single-use' }; } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const denied = await fetch(`${base}/api/speech/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal(calls, 0);
    const ok = await fetch(`${base}/api/speech/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ok.json(), { token: 'single-use' });
    const page = await fetch(`${base}/app`);
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self' wss:\/\/api\.elevenlabs\.io/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('PCM resampling carries fractional windows across 128-sample blocks at common device rates', async () => {
  const { PcmResampler, encodePcm16 } = await import(pcmModule);
  for (const rate of [16000, 22050, 44100, 48000]) {
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(i / 17) / 2);
    const full = new PcmResampler(rate);
    const expected = [...full.process(input), ...full.flush()];
    const blocked = new PcmResampler(rate);
    const actual: number[] = [];
    for (let offset = 0; offset < input.length; offset += 128) actual.push(...blocked.process(input.slice(offset, offset + 128)));
    actual.push(...blocked.flush());
    assert.equal(actual.length, 16000);
    assert.deepEqual(actual, expected);
  }
  const bytes = encodePcm16([-2, 0, 2, NaN]);
  const view = new DataView(bytes.buffer);
  assert.deepEqual([0, 2, 4, 6].map(index => view.getInt16(index, true)), [-32768, 0, 32767, 0]);
});

test('audio worklet downmixes, flushes its short tail and stops at 30 seconds even if browser timers pause', async () => {
  const { PcmResampler, encodePcm16 } = await import(pcmModule);
  const source = (await readFile(new URL('../../frontend/pcm-worklet.js', import.meta.url), 'utf8')).replace(/^import[^\n]*\n/, '');
  let Processor: any;
  const messages: any[] = [];
  class WorkletBase { port = { onmessage: null, postMessage(data: any) { messages.push(data); } }; }
  runInNewContext(source, { PcmResampler, encodePcm16, AudioWorkletProcessor: WorkletBase, sampleRate: 48000, registerProcessor(_name: string, constructor: any) { Processor = constructor; } });
  const short = new Processor();
  short.process([[new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.5)]]);
  assert.equal(messages.length, 0);
  short.port.onmessage({ data: { type: 'flush' } });
  assert.equal(messages[0].type, 'audio');
  assert.equal(messages[0].buffer.byteLength, 43 * 2);
  assert.ok(new Uint8Array(messages[0].buffer).every(value => value === 0));
  assert.equal(messages[1].type, 'flushed');
  assert.equal(short.process([]), false);
  messages.length = 0;
  const bounded = new Processor();
  const block = [[new Float32Array(128).fill(0.1)]];
  for (let i = 0; i < 48_000 * 35 / 128; i++) bounded.process(block);
  assert.equal(messages.filter(message => message.type === 'limit').length, 1);
  assert.equal(messages.filter(message => message.type === 'audio').reduce((sum, message) => sum + message.buffer.byteLength, 0), 16000 * 30 * 2);
});

async function fixture(options: any = {}) {
  const { createElevenLabsSpeechInput } = await import(speechModule);
  const dom = new JSDOM('<textarea></textarea>');
  const textarea = dom.window.document.querySelector('textarea')!;
  const statuses: { type: string; message: string }[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const sockets: any[] = [];
  let captureOptions: any;
  const capture = {
    startCount: 0, cancelCount: 0, finishCount: 0,
    start() { this.startCount++; },
    cancel() { this.cancelCount++; },
    async finish() { this.finishCount++; captureOptions.onAudio(new Uint8Array([0, 1, 0, 2])); },
  };
  class Socket {
    url: string;
    readyState = 1;
    bufferedAmount = 0;
    onmessage: ((event: any) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    messages: any[] = [];
    closed = false;
    constructor(url: string) { this.url = url; sockets.push(this); queueMicrotask(() => this.emit({ message_type: 'session_started' })); }
    emit(message: any) {
      this.onmessage?.({ data: JSON.stringify(message) });
      if (message.message_type === 'committed_transcript') {
        this.onmessage?.({ data: JSON.stringify({ ...message, message_type: 'committed_transcript_with_timestamps', language_code: 'en' }) });
      }
    }
    send(data: string) { this.messages.push(JSON.parse(data)); }
    close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
  }
  const speech = createElevenLabsSpeechInput({
    textarea,
    onStatus: (status: any) => statuses.push(status),
    fetchImpl: async (url: string, init: RequestInit) => { requests.push({ url, init }); return Response.json({ token: 'single-use-token' }); },
    WebSocketImpl: Socket,
    captureFactory: async (config: any) => { captureOptions = config; return capture; },
    ...options,
  });
  return { speech, textarea, dom, statuses, requests, sockets, capture, get captureOptions() { return captureOptions; } };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Expected event did not occur'); await new Promise(resolve => setTimeout(resolve, 1)); }
}

test('ElevenLabs adapter waits for committed text, flushes audio, sends one commit, and preserves editable text', async () => {
  const f = await fixture();
  try {
    f.textarea.value = 'Earlier note.';
    await f.speech.start();
    const socket = f.sockets[0];
    const url = new URL(socket.url);
    assert.equal(url.hostname, 'api.elevenlabs.io');
    assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
    assert.equal(url.searchParams.get('audio_format'), 'pcm_16000');
    assert.equal(url.searchParams.get('language_code'), 'en');
    assert.equal(url.searchParams.get('include_language_detection'), 'true');
    assert.equal(url.searchParams.has('secondary_languages'), false);
    assert.deepEqual(JSON.parse(String(f.requests[0].init.body)), {});
    assert.equal(f.requests[0].url, '/api/speech/token');
    socket.emit({ message_type: 'partial_transcript', text: 'wrong interim' });
    assert.equal(f.textarea.value, 'Earlier note.');
    let settled = false;
    const done = f.speech.finish();
    assert.equal(f.speech.finish(), done);
    done.then(() => { settled = true; });
    await until(() => socket.messages.some((message: any) => message.commit));
    assert.equal(settled, false);
    assert.equal(f.capture.finishCount, 1);
    assert.equal(socket.messages[0].audio_base_64, 'AAEAAg==');
    assert.equal(socket.messages.filter((message: any) => message.commit).length, 1);
    assert.ok(socket.messages.slice(0, -1).reduce((sum: number, message: any) => sum + Buffer.from(message.audio_base_64, 'base64').length, 0) >= 64000);
    socket.emit({ message_type: 'committed_transcript', text: 'My knee hurts.' });
    assert.equal(await done, 'Earlier note. My knee hurts.');
    assert.equal(socket.closed, true);
    assert.equal(f.speech.isActive, false);
    assert.equal(f.speech.mode, 'spoken');
    f.textarea.value = 'My arm hurts.';
    f.textarea.dispatchEvent(new f.dom.window.Event('input'));
    assert.equal(f.speech.mode, 'form');
    assert.equal(await f.speech.finish(), 'My arm hurts.');
  } finally { f.speech.destroy(); f.dom.window.close(); }
});

test('cancel discards interim text, releases audio, and ignores old socket events', async () => {
  const f = await fixture();
  try {
    await f.speech.start();
    const socket = f.sockets[0];
    socket.emit({ message_type: 'partial_transcript', text: 'unconfirmed phrase' });
    const oldHandler = socket.onmessage;
    f.speech.cancel();
    assert.equal(f.textarea.value, '');
    assert.equal(f.capture.cancelCount, 1);
    assert.equal(socket.closed, true);
    oldHandler({ data: JSON.stringify({ message_type: 'committed_transcript', text: 'late phrase' }) });
    assert.equal(f.textarea.value, '');
  } finally { f.speech.destroy(); f.dom.window.close(); }
});

test('editing live transcript cancels recording but retains the user edit exactly', async () => {
  const f = await fixture();
  try {
    await f.speech.start();
    f.sockets[0].emit({ message_type: 'partial_transcript', text: 'wrong name' });
    f.textarea.value = 'Corrected name';
    f.textarea.dispatchEvent(new f.dom.window.Event('input'));
    assert.equal(f.textarea.value, 'Corrected name');
    assert.equal(f.speech.isActive, false);
    assert.equal(await f.speech.finish(), 'Corrected name');
  } finally { f.speech.destroy(); f.dom.window.close(); }
});

test('pending microphone permission can be canceled immediately and late capture is cleaned up', async () => {
  let grant: (capture: any) => void = () => {};
  let canceled = 0;
  const f = await fixture({ captureFactory: () => new Promise(resolve => { grant = resolve; }) });
  try {
    const starting = f.speech.start();
    f.speech.cancel();
    await assert.rejects(starting, { code: 'SPEECH_CANCELLED' });
    grant({ cancel() { canceled++; } });
    await until(() => canceled === 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.speech.isActive, false);
  } finally { f.speech.destroy(); f.dom.window.close(); }
});

test('native microphone capture stops tracks granted after cancellation', async () => {
  const { createMicrophoneCapture } = await import(speechModule);
  let grant: (stream: any) => void = () => {};
  let stopped = 0;
  let closed = 0;
  class Context {
    state = 'running';
    async resume() {}
    async close() { closed++; this.state = 'closed'; }
  }
  const controller = new AbortController();
  const pending = createMicrophoneCapture({ signal: controller.signal, onAudio() {}, onError() {},
    mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) }, AudioContextImpl: Context, AudioWorkletNodeImpl: class {} });
  controller.abort();
  grant({ getTracks: () => [{ stop() { stopped++; } }] });
  await assert.rejects(pending, { code: 'SPEECH_CANCELLED' });
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
});

test('finalization timeout rejects instead of submitting interim text and stops all resources', async () => {
  const f = await fixture({ finishTimeoutMs: 10 });
  try {
    await f.speech.start();
    f.sockets[0].emit({ message_type: 'partial_transcript', text: 'not final' });
    await assert.rejects(f.speech.finish(), { code: 'SPEECH_TIMEOUT' });
    assert.equal(f.textarea.value, '');
    assert.equal(f.speech.isActive, false);
    assert.equal(f.sockets[0].closed, true);
    await assert.rejects(f.speech.finish(), { code: 'SPEECH_TIMEOUT' });
  } finally { f.speech.destroy(); f.dom.window.close(); }
});

test('provider errors and premature close never accept partial transcripts', async () => {
  for (const event of ['quota_exceeded', 'close']) {
    const f = await fixture();
    try {
      await f.speech.start();
      f.sockets[0].emit({ message_type: 'partial_transcript', text: 'not final' });
      if (event === 'close') f.sockets[0].onclose();
      else f.sockets[0].emit({ message_type: event, error: 'private provider diagnostic' });
      assert.equal(f.textarea.value, '');
      assert.equal(f.speech.isActive, false);
      await assert.rejects(f.speech.finish());
      assert.ok(!JSON.stringify(f.statuses).includes('private provider diagnostic'));
    } finally { f.speech.destroy(); f.dom.window.close(); }
  }
});

test('recording limit finishes for review without invoking any analysis endpoint', async () => {
  const f = await fixture({ maxRecordingMs: 10 });
  try {
    await f.speech.start();
    await until(() => f.sockets[0].messages.some((message: any) => message.commit));
    f.sockets[0].emit({ message_type: 'committed_transcript', text: 'I feel fine today.' });
    await until(() => !f.speech.isActive);
    assert.equal(f.textarea.value, 'I feel fine today.');
    assert.ok(f.statuses.some(status => status.type === 'notice' && /limit/.test(status.message)));
    assert.deepEqual(f.requests.map(request => request.url), ['/api/speech/token']);
  } finally { f.speech.destroy(); f.dom.window.close(); }
});
