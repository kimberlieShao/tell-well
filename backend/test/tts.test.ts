import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeechAudioProvider } from '../src/tts.js';

const speakerModule = new URL('../../frontend/elevenlabs-speaker.js', import.meta.url).href;
const mp3 = () => new Response(new Uint8Array([73, 68, 51, 0, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });

test('spoken question provider sends only bounded text and server credentials to ElevenLabs', async () => {
  const provider = createSpeechAudioProvider({ apiKey: 'server-secret', fetcher: (async (url, init) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'server-secret');
    assert.deepEqual(JSON.parse(String(init?.body)), { text: 'How severe is your knee pain?', model_id: 'eleven_flash_v2_5' });
    return mp3();
  }) as typeof fetch });
  assert.deepEqual(await provider(' How severe is your knee pain? '), new Uint8Array([73, 68, 51, 0, 0]));
});

test('spoken question presets select fixed voices and preserve the configured default between requests', async () => {
  const urls: string[] = [];
  const provider = createSpeechAudioProvider({ apiKey: 'server-secret', voiceId: 'configured-voice', fetcher: (async url => {
    urls.push(String(url));
    return mp3();
  }) as typeof fetch });
  for (const voice of [undefined, 'sarah', 'river', 'callum', 'harry', 'default', undefined] as const) {
    assert.deepEqual(await provider('How are you?', voice), new Uint8Array([73, 68, 51, 0, 0]));
  }
  assert.deepEqual(urls, ['configured-voice', 'EXAVITQu4vr4xnSDxMaL', 'SAz9YHcvj6GT2YYXdXww', 'N2lVS1w4EtoT3dr4eOWO', 'SOYHLrjzK2X1ezoPC6cr', 'configured-voice', 'configured-voice']
    .map(id => `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`));
});

test('spoken question provider rejects invalid input before making a paid request', async () => {
  let calls = 0;
  const provider = createSpeechAudioProvider({ apiKey: 'server-secret', fetcher: (async () => { calls++; return mp3(); }) as typeof fetch });
  for (const value of ['', '  ', 'a'.repeat(1201), null]) await assert.rejects(provider(value as any), { code: 'INVALID_SPEECH_TEXT' });
  for (const voice of ['', 'Sarah', 'river ', 'unknown', 'EXAVITQu4vr4xnSDxMaL', '../secret', '__proto__', null, 3, {}, ['sarah']]) {
    await assert.rejects(provider('How are you?', voice as any), { status: 400, code: 'INVALID_SPEECH_VOICE' });
  }
  assert.equal(calls, 0);
  await assert.rejects(createSpeechAudioProvider({ apiKey: '' })('Hello'), { code: 'SPEECH_NOT_CONFIGURED' });
  await assert.rejects(createSpeechAudioProvider({ apiKey: 'secret', voiceId: '../secret' })('Hello'), { code: 'SPEECH_NOT_CONFIGURED' });
});

test('spoken question provider rejects provider failures, non-audio, oversized audio and timeout without leaking diagnostics', async () => {
  for (const response of [
    new Response('SECRET invalid key', { status: 401 }), new Response('SECRET quota', { status: 429 }),
    Response.json({ secret: 'SECRET' }), new Response('', { headers: { 'Content-Type': 'audio/mpeg' } }),
    new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'audio/mpeg' } }),
  ]) {
    const provider = createSpeechAudioProvider({ apiKey: 'SECRET', fetcher: (async () => response) as typeof fetch });
    await assert.rejects(provider('How are you?'), (error: any) => error.code === 'SPEECH_UNAVAILABLE' && !error.message.includes('SECRET'));
  }
  const provider = createSpeechAudioProvider({ apiKey: 'SECRET', timeoutMs: 5, fetcher: ((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('SECRET timeout')), { once: true });
  })) as typeof fetch });
  await assert.rejects(provider('How are you?'), (error: any) => /too long/.test(error.message) && !error.message.includes('SECRET'));
  const stalledBody = createSpeechAudioProvider({ apiKey: 'SECRET', timeoutMs: 5, fetcher: (async () => new Response(new ReadableStream(), { headers: { 'Content-Type': 'audio/mpeg' } })) as typeof fetch });
  await assert.rejects(stalledBody('How are you?'), (error: any) => /too long/.test(error.message));
});

class FakeAudio extends EventTarget {
  src = '';
  preload = '';
  playCount = 0;
  pauseCount = 0;
  loadCount = 0;
  playError: Error | null = null;
  play() { this.playCount++; return this.playError ? Promise.reject(this.playError) : Promise.resolve(); }
  pause() { this.pauseCount++; }
  load() { this.loadCount++; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  end() { this.dispatchEvent(new Event('ended')); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(options: any = {}) {
  const { createElevenLabsSpeaker } = await import(speakerModule);
  const audio = new FakeAudio();
  const urls: string[] = [];
  const revoked: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  let audioFactories = 0;
  const speaker = createElevenLabsSpeaker({
    audioFactory: () => { audioFactories++; return audio; },
    fetchImpl: async (url: string, init: RequestInit) => { requests.push({ url, init }); return mp3(); },
    urlApi: { createObjectURL(_blob: Blob) { const url = `blob:audio-${urls.length}`; urls.push(url); return url; }, revokeObjectURL(url: string) { revoked.push(url); } },
    ...options,
  });
  return { speaker, audio, urls, revoked, requests, factories: () => audioFactories };
}

test('speaker primes playback during the click and reuses that audio element for every question', async () => {
  const page = await fixture();
  const unlocking = page.speaker.prime();
  assert.equal(page.audio.playCount, 1, 'play must happen before an async continuation loses the user gesture');
  await unlocking;
  assert.deepEqual(page.revoked, ['blob:audio-0']);
  for (const question of ['How severe is your pain?', 'Does it affect walking?']) {
    let completed = false;
    const speech = page.speaker.speak(question).then(() => { completed = true; });
    await tick();
    assert.equal(page.speaker.isSpeaking, true);
    assert.equal(completed, false, 'play() alone must not open the microphone');
    page.audio.end();
    await speech;
    assert.equal(page.speaker.isSpeaking, false);
  }
  assert.equal(page.factories(), 1);
  assert.equal(page.urls.length, 3);
  assert.deepEqual(page.revoked, page.urls);
  assert.equal(page.requests[0].url, '/api/speech/speak');
  assert.deepEqual(JSON.parse(String(page.requests[0].init.body)), { text: 'How severe is your pain?' });
  assert.equal(new Headers(page.requests[0].init.headers).has('xi-api-key'), false);
  page.speaker.destroy();
});

test('stopping a pending request settles it immediately and ignores a late audio response', async () => {
  let response: (response: Response) => void = () => {};
  let signal: AbortSignal | undefined;
  const page = await fixture({ fetchImpl: (_url: string, init: RequestInit) => { signal = init.signal!; return new Promise(resolve => { response = resolve; }); } });
  const speech = page.speaker.speak('Which medication?');
  const rejection = assert.rejects(speech, { name: 'AbortError' });
  page.speaker.stop();
  await rejection;
  assert.equal(signal?.aborted, true);
  response(mp3());
  await tick();
  assert.equal(page.audio.playCount, 0);
  assert.equal(page.urls.length, 0);
  page.speaker.destroy();
});

test('speaker sends the current selected preset for every question without recreating audio', async () => {
  let voice = 'sarah';
  const page = await fixture({ getVoice: () => voice });
  try {
    for (const selected of ['sarah', 'river', 'callum', 'harry', 'default']) {
      voice = selected;
      const speaking = page.speaker.speak('How do you feel?');
      await tick();
      const body = JSON.parse(String(page.requests.at(-1)!.init.body));
      assert.deepEqual(body, selected === 'default' ? { text: 'How do you feel?' } : { text: 'How do you feel?', voice: selected });
      page.audio.end();
      await speaking;
    }
    assert.equal(page.factories(), 1);
  } finally { page.speaker.destroy(); }
});

test('stopping or superseding playback revokes audio and never resolves the cancelled turn', async () => {
  const page = await fixture();
  const first = page.speaker.speak('First question');
  const firstRejection = assert.rejects(first, { name: 'AbortError' });
  await tick();
  const second = page.speaker.speak('Second question');
  await firstRejection;
  await tick();
  assert.deepEqual(page.revoked, ['blob:audio-0']);
  page.audio.end();
  await second;
  assert.deepEqual(page.revoked, page.urls);
  const last = page.speaker.speak('Another question');
  const lastRejection = assert.rejects(last, { name: 'AbortError' });
  await tick();
  page.speaker.destroy();
  await lastRejection;
  await assert.rejects(page.speaker.speak('Closed'), /closed/);
});

test('speaker propagates service failures and browser autoplay denial without opening the microphone', async () => {
  const unavailable = await fixture({ fetchImpl: async () => new Response('private diagnostic', { status: 503 }) });
  await assert.rejects(unavailable.speaker.speak('How are you?'), /usage limit/);
  assert.equal(unavailable.audio.playCount, 0);
  unavailable.speaker.destroy();
  const invalid = await fixture({ fetchImpl: async () => Response.json({ error: 'Not audio' }) });
  await assert.rejects(invalid.speaker.speak('How are you?'), /invalid audio/);
  invalid.speaker.destroy();
  const blocked = await fixture();
  blocked.audio.playError = new DOMException('browser details', 'NotAllowedError');
  await assert.rejects(blocked.speaker.prime(), /browser blocked/);
  assert.deepEqual(blocked.revoked, blocked.urls);
  blocked.audio.playError = null;
  await blocked.speaker.prime();
  blocked.audio.playError = new DOMException('browser details', 'NotAllowedError');
  await assert.rejects(blocked.speaker.speak('Try again'), /browser blocked/);
  blocked.audio.playError = null;
  const previousPlays = blocked.audio.playCount;
  const reprime = blocked.speaker.prime();
  assert.equal(blocked.audio.playCount, previousPlays + 1, 'a blocked later question must allow a new gesture to unlock playback');
  await reprime;
  blocked.speaker.destroy();
});

test('speaker rejects playback errors and bounded request/playback timeouts', async () => {
  const broken = await fixture();
  const speech = broken.speaker.speak('How are you?');
  const rejected = assert.rejects(speech, /could not be played/);
  await tick();
  broken.audio.dispatchEvent(new Event('error'));
  await rejected;
  assert.deepEqual(broken.revoked, broken.urls);
  broken.speaker.destroy();
  const request = await fixture({ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(request.speaker.speak('How are you?'), /too long/);
  request.speaker.destroy();
  const stalled = await fixture({ playbackTimeoutMs: 5 });
  await assert.rejects(stalled.speaker.speak('How are you?'), /did not finish/);
  assert.deepEqual(stalled.revoked, stalled.urls);
  stalled.speaker.destroy();
});
