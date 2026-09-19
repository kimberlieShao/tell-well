import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createVoiceConversation } = await import(new URL('../../frontend/voice-conversation.js', import.meta.url).href);
const defer = () => {
  let resolve!: (value?: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const question = (id = 'arm:severity') => ({ id, text: `Question ${id}?`, options: [], field: 'severity', entityId: id.split(':')[0] });
const record = (nextQuestion: any = null, version = 1) => ({
  schemaVersion: '1.0', sessionId: 'session-a', version, status: nextQuestion ? 'collecting' : 'review',
  symptoms: [], medications: [], diet: [], vitals: [], wellness: null, nextQuestion,
});

function harness({ responses = [record()], initial = null, maxTurns, maxRepeats }: any = {}) {
  const log: string[] = [];
  const fields = { value: '' };
  const captures: any[] = [];
  const records: any[] = [];
  const states: any[] = [];
  const questions: any[] = [];
  const reviews: any[] = [];
  const calls: any[] = [];
  let speaking = false;
  const speakingStarted = defer();
  let speakGate: ReturnType<typeof defer> | null = null;
  let apiGate: ReturnType<typeof defer> | null = null;
  let apiFailure: Error | null = null;
  let speechFailure: Error | null = null;
  const client: any = {
    state: initial,
    busy: false,
    async request(method: string, ...args: any[]) {
      assert.equal(client.busy, false, 'API calls must never overlap');
      client.busy = true;
      calls.push({ method, args });
      log.push(`api:${method}`);
      try {
        if (apiGate) await apiGate.promise;
        if (apiFailure) { const error = apiFailure; apiFailure = null; throw error; }
        const response = responses.shift();
        assert.ok(response, `Missing fake response for ${method}`);
        client.state = response;
        return response;
      } finally { client.busy = false; }
    },
    start: (...args: any[]) => client.request('start', ...args),
    answer: (...args: any[]) => client.request('answer', ...args),
    skip: (...args: any[]) => client.request('skip', ...args),
    review: (...args: any[]) => client.request('review', ...args),
    save: (...args: any[]) => client.request('save', ...args),
  };
  const speaker = {
    prime() { log.push('prime'); },
    async speak(text: string) {
      assert.equal(captures.some(capture => capture.listening), false, 'Microphone must be off while the assistant speaks');
      log.push(`speak:${text}`);
      speaking = true;
      speakingStarted.resolve();
      if (speakGate) await speakGate.promise;
      speaking = false;
    },
    stop() { log.push('speaker:stop'); speaking = false; },
    destroy() { log.push('speaker:destroy'); },
  };
  const speechFactory = (options: any) => {
    assert.equal(options.commitStrategy, 'vad');
    assert.equal(options.vadSilenceThresholdSecs, 2);
    const capture: any = {
      options, listening: false, cancelled: false,
      async start() {
        assert.equal(speaking, false, 'Speech playback must finish before microphone starts');
        if (speechFailure) throw speechFailure;
        log.push('microphone:start');
        capture.listening = true;
        options.onStatus({ type: 'listening', message: 'Listening' });
      },
      partial(text: string) { fields.value = text; options.onStatus({ type: 'transcribing', message: 'Transcribing' }); },
      async say(text: string) {
        fields.value = text;
        capture.listening = false;
        return options.onTurn(text);
      },
      cancel() { capture.listening = false; capture.cancelled = true; log.push('microphone:cancel'); },
      destroy() { capture.listening = false; log.push('microphone:destroy'); },
    };
    captures.push(capture);
    return capture;
  };
  speechFactory.prime = () => { log.push('microphone:prime'); };
  speechFactory.release = () => { log.push('microphone:release'); };
  const flow = createVoiceConversation({
    client, speaker, speechFactory, textarea: fields,
    onRecord: (value: any) => records.push(value),
    onState: (value: any) => states.push({ ...value, transcript: fields.value }),
    onQuestion: (value: any) => questions.push(value),
    onReview: (value: any) => reviews.push(value),
    questionText: (value: any, response: any) => `For ${response.sessionId}: ${value.text}`,
    ...(maxTurns ? { maxTurns } : {}), ...(maxRepeats ? { maxRepeats } : {}),
  });
  return {
    flow, client, fields, captures, records, states, questions, reviews, calls, log, speakingStarted: speakingStarted.promise,
    get capture() { return captures.at(-1); },
    setSpeakGate(value: ReturnType<typeof defer> | null) { speakGate = value; },
    setApiGate(value: ReturnType<typeof defer> | null) { apiGate = value; },
    failApi(error: Error) { apiFailure = error; },
    failSpeech(error: Error) { speechFailure = error; },
  };
}

test('conversation unlocks audio synchronously and completes multiple questions in the same session without saving', async () => {
  const arm = record(question(), 1);
  const leg = record(question('leg:severity'), 2);
  const final = record(null, 3);
  const h = harness({ responses: [arm, leg, final] });
  const starting = h.flow.start();
  assert.deepEqual(h.log.slice(0,2), ['prime','microphone:prime']);
  assert.equal(h.captures.length, 0);
  await starting;
  h.capture.partial('My arm');
  assert.equal(h.states.at(-1).transcript, 'My arm');
  await h.capture.say('My arm and leg hurt.');
  assert.equal(h.questions[0].id, 'arm:severity');
  await h.capture.say('Seven');
  assert.equal(h.questions[1].id, 'leg:severity');
  await h.capture.say('Three');
  assert.deepEqual(h.calls.map(call => call.method), ['start', 'answer', 'answer']);
  assert.deepEqual(h.calls[1].args, ['Seven', { spoken: true }]);
  assert.equal(h.reviews[0], final);
  assert.equal(h.flow.state.phase, 'review');
  assert.ok(h.log.includes('microphone:release'));
  assert.equal(h.log.filter(item=>item==='microphone:prime').length,1,'Audio is primed once, not after each question');
  assert.equal(h.flow.busy, false);
  assert.equal(h.captures.length, 3);
  assert.ok(h.log.includes('speak:For session-a: Question arm:severity?'));
  assert.equal(h.calls.some(call => call.method === 'save'), false);
});

test('wellness goes directly to review without invented questions or automatic save', async () => {
  const final = { ...record(), wellness: { status: 'well', statement: 'I feel fine today.' } };
  const h = harness({ responses: [final] });
  await h.flow.start();
  await h.capture.say('I feel fine today.');
  assert.equal(h.questions.length, 0);
  assert.equal(h.reviews[0].wellness.statement, 'I feel fine today.');
  assert.equal(h.captures.length, 1);
  assert.equal(h.flow.active, false);
});

test('pause cancels playback and ignores late completion before starting another microphone', async () => {
  const h = harness();
  const gate = defer();
  h.setSpeakGate(gate);
  const starting = h.flow.start();
  await h.speakingStarted;
  assert.equal(h.flow.state.phase, 'speaking');
  h.flow.pause();
  gate.resolve();
  await starting;
  assert.equal(h.captures.length, 0);
  assert.equal(h.flow.state.phase, 'paused');
  h.setSpeakGate(null);
  await h.flow.start({ resume: true });
  assert.equal(h.captures.length, 1);
  assert.equal(h.calls.length, 0);
});

test('pause during API request stays busy until settlement and preserves the result without advancing the UI', async () => {
  const h = harness({ responses: [record(question())] });
  await h.flow.start();
  const gate = defer();
  h.setApiGate(gate);
  const sending = h.capture.say('My arm hurts.');
  h.flow.pause();
  assert.equal(h.flow.active, false);
  assert.equal(h.flow.busy, true);
  assert.equal(h.states.at(-1).busy, true);
  await h.flow.start({ resume: true });
  assert.equal(h.captures.length, 1);
  gate.resolve();
  await sending;
  assert.equal(h.records.length, 1);
  assert.equal(h.questions.length, 0);
  assert.equal(h.reviews.length, 0);
  assert.equal(h.flow.busy, false);
  assert.equal(h.flow.state.phase, 'paused');
  h.setApiGate(null);
  await h.flow.start({ resume: true });
  assert.equal(h.questions[0].id, 'arm:severity');
  assert.equal(h.calls.length, 1, 'Resume must not resubmit the previous transcript');
  assert.equal(h.captures.length, 2);
});

test('duplicate turn callbacks and callbacks after stop never submit duplicate requests', async () => {
  const h = harness({ responses: [record(question())] });
  await h.flow.start();
  const capture = h.capture;
  const gate = defer();
  h.setApiGate(gate);
  const first = capture.say('My arm hurts.');
  await capture.say('My arm hurts.');
  assert.equal(h.calls.length, 1);
  h.flow.stop();
  gate.resolve();
  await first;
  await capture.say('Seven');
  assert.equal(h.calls.length, 1);
  assert.equal(h.captures.length, 1);
});

test('provider failures pause visibly, preserve transcript, and retry only after another response', async () => {
  const h = harness({ responses: [record()] });
  h.failApi(new Error('Gemini is temporarily busy.'));
  await h.flow.start();
  await h.capture.say('I feel fine today.');
  assert.equal(h.flow.state.phase, 'error');
  assert.match(h.flow.state.message, /temporarily busy/);
  assert.equal(h.fields.value, 'I feel fine today.');
  assert.equal(h.flow.busy, false);
  await h.flow.start({ resume: true });
  assert.equal(h.calls.length, 1);
  await h.capture.say('I feel fine today.');
  assert.equal(h.calls.length, 2);
  assert.equal(h.reviews.length, 1);
});

test('speech errors retain the last partial transcript and blank turns never reach the API', async () => {
  const h = harness();
  await h.flow.start();
  h.capture.partial('My knee has been hurting');
  h.fields.value = '';
  h.capture.options.onStatus({ type: 'error', message: 'Speech connection interrupted.' });
  assert.equal(h.fields.value, 'My knee has been hurting');
  assert.equal(h.flow.state.phase, 'error');
  assert.equal(h.capture.cancelled, true);
  assert.equal(h.calls.length, 0);
  await h.flow.start({ resume: true });
  await h.capture.say('   ');
  assert.equal(h.flow.state.phase, 'error');
  assert.match(h.flow.state.message, /complete response/);
  assert.equal(h.calls.length, 0);
});

test('microphone startup and playback errors never proceed to an API request', async () => {
  const h = harness();
  h.failSpeech(new Error('Microphone permission denied.'));
  await h.flow.start();
  assert.equal(h.flow.state.phase, 'error');
  assert.match(h.flow.state.message, /permission denied/);
  assert.equal(h.calls.length, 0);
  const other = harness();
  const gate = defer();
  other.setSpeakGate(gate);
  const starting = other.flow.start();
  await Promise.resolve();
  gate.reject(new Error('Audio playback is blocked.'));
  await starting;
  assert.equal(other.flow.state.phase, 'error');
  assert.equal(other.captures.length, 0);
});

test('unresolved question skips only that field; total turn limit still ends at review', async () => {
  const q = question();
  const h = harness({ responses: [record(q), record(q, 2), record(q, 3), record(null, 4)] });
  await h.flow.start();
  await h.capture.say('My arm hurts.');
  await h.capture.say('I am unsure.');
  await h.capture.say('Still unsure.');
  assert.deepEqual(h.calls.map(call => call.method), ['start', 'answer', 'answer', 'skip']);
  assert.equal(h.captures.length, 3);
  assert.equal(h.reviews.length, 1);
  assert.ok(h.log.some(entry=>entry.includes('leave it unconfirmed')));
  const limited = harness({ maxTurns: 1, responses: [record(q), record(null, 2)] });
  await limited.flow.start();
  await limited.capture.say('My arm hurts.');
  assert.deepEqual(limited.calls.map(call => call.method), ['start', 'review']);
  assert.equal(limited.captures.length, 1);
});

test('only exact voice commands skip, pause, or request review', async () => {
  const q = question();
  const h = harness({ initial: record(q), responses: [record(question('leg:severity'), 2), record(null, 3)] });
  await h.flow.start({ resume: true });
  await h.capture.say('Skip.');
  assert.equal(h.calls[0].method, 'skip');
  await h.capture.say('Finish check-in.');
  assert.equal(h.calls[1].method, 'review');
  assert.equal(h.reviews.length, 1);
  const other = harness({ responses: [record(q)] });
  await other.flow.start();
  await other.capture.say('I want to skip my medicine today.');
  assert.equal(other.calls[0].method, 'start');
  assert.equal(other.calls[0].args[0], 'I want to skip my medicine today.');
  await other.capture.say('Pause.');
  assert.equal(other.flow.state.phase, 'paused');
  assert.equal(other.calls.length, 1);
});

test('Review action stops an active microphone and requires an existing record', async () => {
  const h = harness({ initial: record(question()), responses: [record(null, 2)] });
  await h.flow.start({ resume: true });
  const capture = h.capture;
  await h.flow.review();
  assert.equal(capture.cancelled, true);
  assert.deepEqual(h.calls.map(call => call.method), ['review']);
  assert.equal(h.reviews.length, 1);
  await capture.say('Seven');
  assert.equal(h.calls.length, 1);
  const empty = harness();
  await empty.flow.review();
  assert.equal(empty.flow.state.phase, 'error');
  assert.equal(empty.calls.length, 0);
});

test('destroy cancels devices and ignores late API or recorder callbacks', async () => {
  const h = harness({ responses: [record(question())] });
  await h.flow.start();
  const capture = h.capture;
  const gate = defer();
  h.setApiGate(gate);
  const sending = capture.say('My arm hurts.');
  h.flow.destroy();
  const stateCount = h.states.length;
  gate.resolve();
  await sending;
  await capture.say('Seven');
  await h.flow.start();
  assert.equal(h.states.length, stateCount);
  assert.equal(h.records.length, 0);
  assert.equal(h.questions.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.captures.length, 1);
  assert.ok(h.log.includes('speaker:destroy'));
});


test('unknown medication does not block the remaining pain questions',async()=>{
 const med={...question('med:name'),category:'medications',field:'name'};
 const pain=question('arm:severity');
 const h=harness({responses:[record(med),record(med,2),record(med,3),record(pain,4)]});
 await h.flow.start();await h.capture.say('My arm hurts and I took medicine.');
 await h.capture.say('An unknown medication');await h.capture.say('The same medication');
 assert.deepEqual(h.calls.map(call=>call.method),['start','answer','answer','skip']);
 assert.equal(h.reviews.length,0);assert.equal(h.questions.at(-1).id,'arm:severity');
 assert.equal(h.flow.state.phase,'listening');
});
