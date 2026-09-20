import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { createGeminiExtractor, demoExtractor, type Extractor } from '../src/extractor.js';
import { emptyRecord, recordSchema, responseSchema, type CheckinResponse } from '../src/schema.js';

async function withApi(run: (post: (path: string, body: unknown) => Promise<{ status: number; body: any }>) => Promise<void>, extractor: Extractor = demoExtractor) {
  const server = createApp(extractor).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (path, body) => {
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const session = (state: CheckinResponse) => ({ sessionId: state.sessionId, version: state.version });

test('explicit wellbeing is a savable check-in without inventing a symptom', async () => {
  await withApi(async post => {
    const { status, body } = await post('/api/analyze', { transcript: 'I feel fine today.' });
    assert.equal(status, 200);
    const state = responseSchema.parse(body);
    assert.equal(state.status, 'review');
    assert.deepEqual(state.symptoms, []);
    assert.deepEqual(state.wellness, { status: 'well', statement: 'I feel fine today' });
    assert.equal(state.notices.some(notice => notice.includes('No new structured')), false);
    const { symptoms, medications, diet, vitals, wellness } = state;
    const saved = await post('/api/checkin/save', { ...session(state), confirmed: true, record: { symptoms, medications, diet, vitals, wellness } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status, 'saved');
    assert.deepEqual(saved.body.wellness, state.wellness);
  });
});

test('wellness defaults are backward compatible and unrelated or negated statements cannot save empty records', async () => {
  assert.deepEqual(recordSchema.parse({ symptoms: [], medications: [], diet: [], vitals: [] }), emptyRecord());
  await withApi(async post => {
    for (const transcript of ['Hello there.', "I don't feel fine today.", "I don't think I feel fine today.", 'Maybe I feel fine today.']) {
      const { body: state } = await post('/api/analyze', { transcript });
      assert.equal(state.wellness, null);
      assert.deepEqual(state.symptoms, []);
      assert.equal((await post('/api/checkin/save', { ...session(state), confirmed: true })).body.error.code, 'EMPTY_RECORD');
    }
    const { body: normal } = await post('/api/analyze', { transcript: 'I feel normal today.' });
    assert.equal(normal.wellness.status, 'normal');
  });
});

test('arm and leg pain retain separate IDs through independent numeric follow-ups and save', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: 'My arm and leg hurt.' });
    assert.deepEqual(state.symptoms.map((symptom: any) => symptom.name), ['arm pain', 'leg pain']);
    assert.deepEqual(state.symptoms.map((symptom: any) => symptom.location), ['arm', 'leg']);
    const [armId, legId] = state.symptoms.map((symptom: any) => symptom.id);
    assert.notEqual(armId, legId);
    assert.equal(state.nextQuestion.entityId, armId);
    assert.equal(state.nextQuestion.field, 'severity');
    ({ body: state } = await post('/api/analyze', { ...session(state), answer: { questionId: state.nextQuestion.id, value: '7' } }));
    assert.equal(state.symptoms[0].severityScore, 7);
    assert.equal(state.symptoms[1].severityScore, null);
    while (state.nextQuestion.entityId === armId) {
      ({ body: state } = await post('/api/analyze', { ...session(state), action: 'skip', questionId: state.nextQuestion.id }));
    }
    assert.equal(state.nextQuestion.entityId, legId);
    ({ body: state } = await post('/api/analyze', { ...session(state), questionId: state.nextQuestion.id, transcript: '3 out of 10' }));
    ({ body: state } = await post('/api/analyze', { ...session(state), action: 'review' }));
    const saved = await post('/api/checkin/save', { ...session(state), confirmed: true });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.symptoms.map((symptom: any) => [symptom.id, symptom.severityScore, symptom.severity]), [[armId, 7, null], [legId, 3, null]]);
  });
});

test('coordinated negated and uncertain pain never becomes positive pain in demo mode', async () => {
  for (const transcript of ['I have no arm and leg pain.', 'Maybe my arm and leg hurt.', 'My arm and leg do not hurt.']) {
    const extracted = await demoExtractor.extract(transcript, emptyRecord(), null);
    assert.deepEqual(extracted.symptoms, [], transcript);
  }
});

test('numeric pain preference persists and asks for a score even when mild was reported', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: 'I have mild arm pain.', painScale: '1-10' });
    assert.equal(state.symptoms[0].severity, 'mild');
    assert.equal(state.symptoms[0].severityScore, null);
    assert.equal(state.nextQuestion.field, 'severity');
    assert.deepEqual(state.nextQuestion.options, Array.from({ length: 10 }, (_, index) => String(index + 1)));
    assert.match(state.nextQuestion.text, /scale of 1 to 10/);
    ({ body: state } = await post('/api/analyze', { ...session(state), action: 'review' }));
    ({ body: state } = await post('/api/analyze', { ...session(state), action: 'resume' }));
    assert.equal(state.nextQuestion.field, 'severity');
    assert.equal(state.nextQuestion.options.length, 10);
    const invalidPreferenceChange = await post('/api/analyze', { ...session(state), painScale: '1-10', answer: { questionId: state.nextQuestion.id, value: '4' } });
    assert.equal(invalidPreferenceChange.status, 400);
    ({ body: state } = await post('/api/analyze', { ...session(state), answer: { questionId: state.nextQuestion.id, value: '4' } }));
    assert.equal(state.symptoms[0].severityScore, 4);
    assert.equal(state.nextQuestion.field, 'firstOccurrence');

    const legacy = (await post('/api/analyze', { transcript: 'I have mild arm pain.' })).body;
    assert.equal(legacy.nextQuestion.field, 'trend');
    const nonPain = (await post('/api/analyze', { transcript: 'I have nausea.', painScale: '1-10' })).body;
    assert.deepEqual(nonPain.nextQuestion.options, ['Mild', 'Moderate', 'Severe']);
  });
});

test('arm pain plus missed unnamed medicine preserves both topics and asks for identity', async () => {
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: 'My arm hurts and I forgot my medicine.' });
    assert.equal(state.symptoms[0].name, 'arm pain');
    assert.equal(state.medications.length, 1);
    assert.equal(state.medications[0].name, null);
    assert.equal(state.medications[0].status, 'missed');
    assert.equal(state.medications[0].dose, null);
    assert.equal(state.nextQuestion.entityId, state.medications[0].id);
    assert.equal(state.nextQuestion.field, 'name');
    assert.deepEqual(state.nextQuestion.options, []);
  });
});

test('medication refusal retains reported intent without inventing a dose event', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: "I don't want to take my medicine." });
    assert.equal(state.medications[0].name, null);
    assert.equal(state.medications[0].status, 'mentioned');
    assert.equal(state.medications[0].description, "I don't want to take my medicine");
    ({ body: state } = await post('/api/analyze', { ...session(state), action: 'review' }));
    const saved = await post('/api/checkin/save', { ...session(state), confirmed: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.medications[0].status, 'mentioned');
  });
});

test('three explicitly reported meals become three entries with chicken and rice together', async () => {
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: 'I had oatmeal for breakfast, chicken and rice for lunch, and pasta for dinner.' });
    assert.deepEqual(state.diet.map(({ description, time }: any) => ({ description, time })), [
      { description: 'I had oatmeal for breakfast', time: 'breakfast' },
      { description: 'chicken and rice for lunch', time: 'lunch' },
      { description: 'pasta for dinner', time: 'dinner' },
    ]);
    assert.equal(state.status, 'review');
    assert.equal((await post('/api/checkin/save', { ...session(state), confirmed: true })).status, 200);
  });
});

test('Gemini structured wellness output passes the same review/save contract without a local parser', async () => {
  let calls = 0;
  const expected = { ...emptyRecord(), wellness: { status: 'well', statement: 'I feel fine today.' } };
  const extractor = createGeminiExtractor({ apiKey: 'fictional-test-key', model: 'test-model', fetcher: async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    assert.equal(JSON.parse(request.input).latestTranscript, 'I feel fine today.');
    assert.ok(request.response_format.schema.properties.wellness);
    assert.match(request.system_instruction, /Separate distinct symptom locations/);
    assert.match(request.system_instruction, /Never turn refusal/);
    assert.match(request.system_instruction, /separate diet entry for each meal/);
    return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(expected) }] }] }));
  } });
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: 'I feel fine today.' });
    assert.equal(state.extractionMode, 'gemini');
    assert.deepEqual(state.wellness, expected.wellness);
    assert.equal((await post('/api/checkin/save', { ...session(state), confirmed: true })).status, 200);
    assert.equal(calls, 1);
  }, extractor);
});
