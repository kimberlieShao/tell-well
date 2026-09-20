import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const speechModule = new URL('../../frontend/elevenlabs-speech.js', import.meta.url).href;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Expected event did not occur'); await tick(); }
}

async function fixture(options: Record<string, any> = {}) {
  const { createElevenLabsSpeechInput } = await import(speechModule);
  const dom = new JSDOM('<textarea></textarea>');
  const textarea = dom.window.document.querySelector('textarea')!;
  const sockets: Socket[] = [];
  const turns: string[] = [];
  const statuses: any[] = [];
  let captureOptions: any;
  const capture = {
    cancelled: false, finishes: 0,
    start() { this.cancelled = false; },
    cancel() { this.cancelled = true; },
    async finish() { this.finishes++; captureOptions.onAudio(new Uint8Array([1, 2])); },
  };
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    onmessage: ((event: any) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    messages: any[] = [];
    closed = false;
    constructor(public url: string) { sockets.push(this); queueMicrotask(() => this.emit({ message_type: 'session_started' })); }
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
    textarea, commitStrategy: 'vad',
    onTurn(text: string) {
      assert.equal(speech.isActive, false, 'Capture must stop before the application submits this answer');
      assert.equal(capture.cancelled, true);
      assert.equal(sockets.at(-1)?.closed, true);
      turns.push(text);
    },
    onStatus: (status: any) => statuses.push(status),
    fetchImpl: async () => Response.json({ token: 'single-use-test-token' }),
    WebSocketImpl: Socket,
    captureFactory: async (config: any) => { captureOptions = config; return capture; },
    ...options,
  });
  return { speech, textarea, sockets, turns, statuses, capture, dom,
    close() { speech.destroy(); dom.window.close(); } };
}

test('VAD closes recording and delivers exactly one committed answer after cleanup', async () => {
  const f = await fixture();
  try {
    await f.speech.start();
    const socket = f.sockets[0]!;
    const url = new URL(socket.url);
    assert.equal(url.searchParams.get('commit_strategy'), 'vad');
    assert.equal(url.searchParams.get('language_code'), 'en');
    assert.equal(url.searchParams.get('include_language_detection'), 'true');
    assert.equal(url.searchParams.has('secondary_languages'), false);
    assert.equal(url.searchParams.get('vad_silence_threshold_secs'), '2');
    socket.emit({ message_type: 'partial_transcript', text: 'six maybe' });
    await tick();
    assert.deepEqual(f.turns, []);
    const lateHandler = socket.onmessage!;
    socket.emit({ message_type: 'committed_transcript', text: 'Six out of ten.' });
    lateHandler({ data: JSON.stringify({ message_type: 'committed_transcript', text: 'Duplicate.' }) });
    await until(() => f.turns.length === 1);
    assert.deepEqual(f.turns, ['Six out of ten.']);
    assert.equal(await f.speech.finish(), 'Six out of ten.');
    assert.equal(socket.messages.some(message => message.commit), false);
  } finally { f.close(); }
});

test('VAD ignores empty commits and never advances on silent timeout', async () => {
  const f = await fixture({ maxRecordingMs: 15 });
  try {
    await f.speech.start();
    f.sockets[0]!.emit({ message_type: 'committed_transcript', text: ' ' });
    assert.equal(f.speech.isActive, true);
    await until(() => !f.speech.isActive);
    assert.deepEqual(f.turns, []);
    assert.equal(f.capture.cancelled, true);
    await assert.rejects(f.speech.finish(), { code: 'NO_SPEECH' });
  } finally { f.close(); }
});

test('cancel, transcript edit and destroy suppress queued VAD answers', async () => {
  for (const action of ['cancel', 'edit', 'destroy']) {
    const f = await fixture();
    try {
      await f.speech.start();
      f.sockets[0]!.emit({ message_type: 'committed_transcript', text: 'Old answer.' });
      if (action === 'edit') {
        f.textarea.value = 'Correction';
        f.textarea.dispatchEvent(new f.dom.window.Event('input'));
      } else f.speech[action]();
      await tick();
      assert.deepEqual(f.turns, [], action);
    } finally { f.close(); }
  }
});

test('VAD errors discard partial text without delivering an answer', async () => {
  for (const event of ['quota_exceeded', 'close']) {
    const f = await fixture();
    try {
      await f.speech.start();
      const socket = f.sockets[0]!;
      socket.emit({ message_type: 'partial_transcript', text: 'Not final.' });
      if (event === 'close') socket.onclose!();
      else socket.emit({ message_type: event, error: 'Private diagnostic' });
      await tick();
      assert.deepEqual(f.turns, []);
      assert.equal(f.textarea.value, '');
      assert.equal(socket.closed, true);
    } finally { f.close(); }
  }
});

test('VAD recording limit commits a pending answer once and does not accept partial text', async () => {
  const f = await fixture({ maxRecordingMs: 15 });
  try {
    await f.speech.start();
    const socket = f.sockets[0]!;
    socket.emit({ message_type: 'partial_transcript', text: 'Pending response.' });
    await until(() => socket.messages.some(message => message.commit));
    assert.deepEqual(f.turns, []);
    socket.emit({ message_type: 'committed_transcript', text: 'Final response.' });
    await until(() => f.turns.length === 1);
    assert.deepEqual(f.turns, ['Final response.']);
    assert.equal(f.capture.finishes, 1);
  } finally { f.close(); }
});

test('VAD commit can win while explicit finish is flushing without rejecting or double delivery', async () => {
  let beginFlush: (() => void) | undefined;
  let rejectFlush: ((error: any) => void) | undefined;
  const f = await fixture();
  f.capture.finish = async () => {
    beginFlush?.();
    await new Promise<void>((_resolve, reject) => { rejectFlush = reject; });
  };
  try {
    await f.speech.start();
    const flushing = new Promise<void>(resolve => { beginFlush = resolve; });
    const finishing = f.speech.finish();
    await flushing;
    f.sockets[0]!.emit({ message_type: 'committed_transcript', text: 'Six.' });
    rejectFlush!(new Error('Capture was closed by VAD completion'));
    assert.equal(await finishing, 'Six.');
    await until(() => f.turns.length === 1);
    assert.deepEqual(f.turns, ['Six.']);
  } finally { f.close(); }
});

test('a new VAD turn invalidates old queued output and supports a fresh answer', async () => {
  const f = await fixture();
  try {
    await f.speech.start();
    f.sockets[0]!.emit({ message_type: 'committed_transcript', text: 'Previous turn.' });
    f.textarea.value = '';
    await f.speech.start();
    f.sockets[1]!.emit({ message_type: 'committed_transcript', text: 'Current turn.' });
    await until(() => f.turns.length === 1);
    assert.deepEqual(f.turns, ['Current turn.']);
  } finally { f.close(); }
});

test('manual speech mode retains button-driven finalization and never invokes onTurn', async () => {
  const f = await fixture({ commitStrategy: 'manual' });
  try {
    await f.speech.start();
    const socket = f.sockets[0]!;
    assert.equal(new URL(socket.url).searchParams.get('vad_silence_threshold_secs'), null);
    const finishing = f.speech.finish();
    await until(() => socket.messages.some(message => message.commit));
    socket.emit({ message_type: 'committed_transcript', text: 'My knee hurts.' });
    assert.equal(await finishing, 'My knee hurts.');
    await tick();
    assert.deepEqual(f.turns, []);
  } finally { f.close(); }
});
