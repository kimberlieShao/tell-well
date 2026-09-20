import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const speechModule = new URL('../../frontend/elevenlabs-speech.js', import.meta.url).href;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Expected speech event did not occur');
    await tick();
  }
}

// Emit exactly the supplied provider event. In particular, plain commits must
// never acquire an invented language result through this test fixture.
async function fixture(commitStrategy: 'manual' | 'vad', options: Record<string, any> = {}) {
  const { createElevenLabsSpeechInput } = await import(speechModule);
  const { sessionStarted = { message_type: 'session_started' }, ...speechOptions } = options;
  const dom = new JSDOM('<textarea></textarea>');
  const textarea = dom.window.document.querySelector('textarea')!;
  const sockets: Socket[] = [];
  const turns: string[] = [];
  const statuses: any[] = [];
  let captureOptions: any;
  const capture = {
    cancelled: false, starts: 0,
    start() { this.cancelled = false; this.starts++; captureOptions.onAudio(new Uint8Array([1, 2])); },
    cancel() { this.cancelled = true; },
    async finish() { captureOptions.onAudio(new Uint8Array([1, 2])); },
  };
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    closed = false;
    messages: any[] = [];
    onmessage: ((event: any) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
      queueMicrotask(() => this.emit(sessionStarted));
    }
    emit(message: any) { this.onmessage?.({ data: JSON.stringify(message) }); }
    send(data: string) { this.messages.push(JSON.parse(data)); }
    close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
  }
  const speech = createElevenLabsSpeechInput({
    textarea, commitStrategy,
    onTurn(text: string) {
      assert.equal(speech.isActive, false);
      assert.equal(capture.cancelled, true);
      assert.equal(sockets.at(-1)?.closed, true);
      turns.push(text);
    },
    onStatus: (status: any) => statuses.push(status),
    fetchImpl: async () => Response.json({ token: 'test-language-token' }),
    WebSocketImpl: Socket,
    captureFactory: async (config: any) => { captureOptions = config; return capture; },
    ...speechOptions,
  });
  return { speech, dom, textarea, sockets, turns, statuses, capture,
    close() { speech.destroy(); dom.window.close(); } };
}

const verified = (text: string, language_code: string | undefined = 'en') => ({
  message_type: 'committed_transcript_with_timestamps', text, language_code,
});

for (const strategy of ['manual', 'vad'] as const) {
  test(`${strategy}: requests language detection and waits for English metadata before displaying or submitting a commit`, async () => {
    const f = await fixture(strategy);
    try {
      f.textarea.value = 'Earlier draft.';
      await f.speech.start();
      const socket = f.sockets[0]!;
      const query = new URL(socket.url).searchParams;
      assert.equal(query.get('language_code'), 'en');
      assert.equal(query.get('include_language_detection'), 'true');
      for (const text of ['У меня болит колено.', "J’ai mal au genou.", 'My knee hurts.']) {
        socket.emit({ message_type: 'partial_transcript', text });
        assert.equal(f.textarea.value, 'Earlier draft.', 'Unverified words must not reach the editable draft');
      }
      let finishing: Promise<string> | undefined;
      let settled = false;
      if (strategy === 'manual') {
        finishing = f.speech.finish();
        finishing!.then(() => { settled = true; });
        await until(() => socket.messages.some(message => message.commit));
      }
      // Even language_code on the plain event is not the requested detector result.
      socket.emit({ message_type: 'committed_transcript', text: 'My knee hurts.', language_code: 'en' });
      await tick();
      assert.equal(settled, false);
      assert.equal(f.speech.isActive, true);
      assert.equal(f.textarea.value, 'Earlier draft.');
      assert.deepEqual(f.turns, []);
      const oldHandler = socket.onmessage!;
      socket.emit(verified('My knee hurts.'));
      if (finishing) assert.equal(await finishing, 'Earlier draft. My knee hurts.');
      else await until(() => f.turns.length === 1);
      oldHandler({ data: JSON.stringify(verified('My knee hurts.')) });
      oldHandler({ data: JSON.stringify({ message_type: 'committed_transcript', text: 'My knee hurts.' }) });
      await tick();
      assert.equal(f.textarea.value, 'Earlier draft. My knee hurts.');
      assert.deepEqual(f.turns, strategy === 'vad' ? ['Earlier draft. My knee hurts.'] : []);
      assert.equal(f.capture.cancelled, true);
      assert.equal(socket.closed, true);
    } finally { f.close(); }
  });

  test(`${strategy}: rejects foreign language or non-Latin words even when the request or detector says English`, async () => {
    for (const [text, language] of [
      ['У меня болит колено.', 'ru'],
      ['Mon genou me fait mal.', 'fr'],
      ['У меня болит колено.', 'en'],
      ['My knee болит.', 'eng'],
      ['我的膝盖疼。', 'en'],
    ]) {
      const f = await fixture(strategy);
      try {
        f.textarea.value = 'Keep this draft.';
        await f.speech.start();
        const socket = f.sockets[0]!;
        const finishing = strategy === 'manual' ? f.speech.finish() : undefined;
        const rejected = finishing ? assert.rejects(finishing, { code: 'SPEECH_ENGLISH_REQUIRED' }) : undefined;
        if (finishing) await until(() => socket.messages.some(message => message.commit));
        socket.emit({ message_type: 'partial_transcript', text });
        assert.equal(f.textarea.value, 'Keep this draft.');
        socket.emit({ message_type: 'committed_transcript', text });
        assert.equal(f.textarea.value, 'Keep this draft.');
        socket.emit(verified(text!, language!));
        if (rejected) await rejected;
        else await assert.rejects(f.speech.finish(), { code: 'SPEECH_ENGLISH_REQUIRED' });
        await tick();
        assert.equal(f.textarea.value, 'Keep this draft.');
        assert.deepEqual(f.turns, []);
        assert.equal(f.speech.isActive, false);
        assert.equal(f.capture.cancelled, true);
        assert.equal(socket.closed, true);
      } finally { f.close(); }
    }
  });

  test(`${strategy}: missing detector language fails closed and preserves the draft`, async () => {
    for (const language_code of [undefined, '', ' ']) {
      const f = await fixture(strategy);
      try {
        f.textarea.value = 'Existing note.';
        await f.speech.start();
        // An enriched event without a language is not confirmation of English.
        f.sockets[0]!.emit({ message_type: 'committed_transcript_with_timestamps', text: 'My knee hurts.', language_code });
        await assert.rejects(f.speech.finish(), { code: 'SPEECH_LANGUAGE_UNVERIFIED' });
        assert.equal(f.textarea.value, 'Existing note.');
        assert.deepEqual(f.turns, []);
        assert.equal(f.sockets[0]!.closed, true);
      } finally { f.close(); }
    }
  });

  test(`${strategy}: a plain final times out without metadata instead of submitting provisional text`, async () => {
    const f = await fixture(strategy, { finishTimeoutMs: 20 });
    try {
      f.textarea.value = 'Existing note.';
      await f.speech.start();
      const socket = f.sockets[0]!;
      const finishing = strategy === 'manual' ? f.speech.finish() : undefined;
      const rejected = finishing ? assert.rejects(finishing, { code: 'SPEECH_LANGUAGE_UNVERIFIED' }) : undefined;
      if (finishing) await until(() => socket.messages.some(message => message.commit));
      socket.emit({ message_type: 'committed_transcript', text: 'Unverified answer.' });
      if (rejected) await rejected;
      else {
        await until(() => !f.speech.isActive);
        await assert.rejects(f.speech.finish(), { code: 'SPEECH_LANGUAGE_UNVERIFIED' });
      }
      assert.equal(f.textarea.value, 'Existing note.');
      assert.deepEqual(f.turns, []);
      assert.equal(f.capture.cancelled, true);
      assert.equal(socket.closed, true);
    } finally { f.close(); }
  });

  test(`${strategy}: cancelling or editing while metadata is pending suppresses late validated output`, async () => {
    for (const action of ['cancel', 'edit', 'destroy']) {
      const f = await fixture(strategy);
      try {
        f.textarea.value = 'Earlier draft.';
        await f.speech.start();
        const socket = f.sockets[0]!;
        socket.emit({ message_type: 'committed_transcript', text: 'Late answer.' });
        const lateHandler = socket.onmessage!;
        const finishing = strategy === 'manual' ? f.speech.finish() : undefined;
        const rejected = finishing ? assert.rejects(finishing, { code: 'SPEECH_CANCELLED' }) : undefined;
        if (finishing) await until(() => socket.messages.some(message => message.commit));
        if (action === 'edit') {
          f.textarea.value = 'My correction.';
          f.textarea.dispatchEvent(new f.dom.window.Event('input'));
        } else f.speech[action]();
        if (rejected) await rejected;
        lateHandler({ data: JSON.stringify(verified('Late answer.')) });
        await tick();
        assert.equal(f.textarea.value, action === 'edit' ? 'My correction.' : 'Earlier draft.');
        assert.deepEqual(f.turns, []);
        assert.equal(socket.closed, true);
      } finally { f.close(); }
    }
  });
}

test('confirmed en/eng accepts English names and Latin accents, and confirmed numeric replies stay usable', async () => {
  for (const [text, language] of [
    ['My knee hurts.', 'en'],
    ['I saw José at the café.', 'eng'],
    ['2:00', 'en'],
    ['6', 'ru'],
    ['2:00', undefined],
  ]) {
    const f = await fixture('vad');
    try {
      await f.speech.start();
      f.sockets[0]!.emit({ message_type: 'committed_transcript_with_timestamps', text, language_code: language });
      await until(() => f.turns.length === 1);
      assert.deepEqual(f.turns, [text]);
      assert.equal(f.textarea.value, text);
    } finally { f.close(); }
  }
});

test('a numeric plain commit still requires a detector event before it can submit', async () => {
  const f = await fixture('vad', { finishTimeoutMs: 20 });
  try {
    await f.speech.start();
    f.sockets[0]!.emit({ message_type: 'committed_transcript', text: '6' });
    assert.equal(f.textarea.value, '');
    assert.deepEqual(f.turns, []);
    await until(() => !f.speech.isActive);
    await assert.rejects(f.speech.finish(), { code: 'SPEECH_LANGUAGE_UNVERIFIED' });
    assert.deepEqual(f.turns, []);
  } finally { f.close(); }
});

test('manual recording preserves earlier validated words when a later segment is rejected', async () => {
  const f = await fixture('manual');
  try {
    f.textarea.value = 'Earlier draft.';
    await f.speech.start();
    const socket = f.sockets[0]!;
    socket.emit({ message_type: 'committed_transcript', text: 'My knee hurts.' });
    assert.equal(f.textarea.value, 'Earlier draft.');
    socket.emit(verified('My knee hurts.'));
    socket.emit(verified('My knee hurts.'));
    assert.equal(f.textarea.value, 'Earlier draft. My knee hurts.', 'Duplicate detector events must not append the same segment twice');
    assert.equal(f.speech.isActive, true);
    socket.emit({ message_type: 'partial_transcript', text: 'Je suis fatigué.' });
    socket.emit({ message_type: 'committed_transcript', text: 'Je suis fatigué.' });
    socket.emit(verified('Je suis fatigué.', 'fr'));
    await assert.rejects(f.speech.finish(), { code: 'SPEECH_ENGLISH_REQUIRED' });
    assert.equal(f.textarea.value, 'Earlier draft. My knee hurts.');
    assert.deepEqual(f.turns, []);
  } finally { f.close(); }
});

test('manual stop waits for pending language metadata before accepting an empty final acknowledgement', async () => {
  const f = await fixture('manual');
  try {
    await f.speech.start();
    const socket = f.sockets[0]!;
    socket.emit({ message_type: 'committed_transcript', text: 'My knee hurts.' });
    const finishing = f.speech.finish();
    let settled = false;
    finishing.then(() => { settled = true; });
    await until(() => socket.messages.some(message => message.commit));
    socket.emit({ message_type: 'committed_transcript', text: '' });
    await tick();
    assert.equal(settled, false);
    assert.equal(f.textarea.value, '');
    socket.emit(verified('My knee hurts.'));
    assert.equal(await finishing, 'My knee hurts.');
    assert.equal(f.textarea.value, 'My knee hurts.');
    assert.deepEqual(f.turns, []);
  } finally { f.close(); }
});

for (const strategy of ['manual', 'vad'] as const) {
  test(`${strategy}: startup rejects a provider session that did not enable English`, async () => {
    for (const language_code of [null, 'ru']) {
      const f = await fixture(strategy, {
        sessionStarted: { message_type: 'session_started', config: { language_code } },
      });
      try {
        f.textarea.value = 'Existing draft.';
        await assert.rejects(f.speech.start(), { code: 'SPEECH_LANGUAGE_CONFIG' });
        assert.equal(f.speech.isActive, false);
        assert.equal(f.capture.starts, 1, 'Startup audio is captured locally while the provider connects');
        assert.deepEqual(f.sockets[0]!.messages, [], 'A misconfigured provider must never receive buffered microphone audio');
        assert.equal(f.statuses.some(status => status.type === 'listening'), false);
        assert.equal(f.capture.cancelled, true);
        assert.equal(f.sockets[0]!.closed, true);
        assert.equal(f.textarea.value, 'Existing draft.');
        assert.deepEqual(f.turns, []);
      } finally { f.close(); }
    }
  });

  test(`${strategy}: startup accepts en/eng configuration and remains compatible when config is absent`, async () => {
    for (const config of [{ language_code: 'en' }, { language_code: 'eng' }, undefined]) {
      const f = await fixture(strategy, {
        sessionStarted: { message_type: 'session_started', config },
      });
      try {
        await f.speech.start();
        assert.equal(f.speech.isActive, true);
        assert.equal(f.capture.starts, 1);
        assert.equal(f.sockets[0]!.closed, false);
        assert.deepEqual(f.turns, []);
      } finally { f.close(); }
    }
  });
}

test('manual stop accepts an English enriched final without a preceding plain event', async () => {
  const f = await fixture('manual', { finishTimeoutMs: 100 });
  try {
    f.textarea.value = 'Earlier draft.';
    await f.speech.start();
    const socket = f.sockets[0]!;
    const finishing = f.speech.finish();
    await until(() => socket.messages.some(message => message.commit));
    socket.emit(verified('My knee hurts.'));
    assert.equal(await finishing, 'Earlier draft. My knee hurts.');
    assert.equal(f.textarea.value, 'Earlier draft. My knee hurts.');
    assert.equal(f.capture.cancelled, true);
    assert.equal(socket.closed, true);
    assert.deepEqual(f.turns, []);
  } finally { f.close(); }
});
