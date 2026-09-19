import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Checkins } from '../src/checkins.js';
import { createGeminiExtractor, demoExtractor } from '../src/extractor.js';
import { emptyRecord } from '../src/schema.js';

const completed = (record: unknown, finishReason = 'STOP') => new Response(JSON.stringify({
  candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(record) }] } }],
}));

test('Gemini 2.5 text models use GenerateContent with the same extraction instructions and schema', async () => {
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']) {
    const extractor = createGeminiExtractor({ apiKey: 'fictional-key', model, fetcher: async (url, init) => {
      assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'fictional-key');
      const body = JSON.parse(String(init?.body));
      assert.match(body.systemInstruction.parts[0].text, /Do not diagnose/);
      assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), {
        latestTranscript: 'I feel fine today.', currentRecord: emptyRecord(), currentQuestion: null,
      });
      assert.equal(body.contents[0].role, 'user');
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.ok(body.generationConfig.responseJsonSchema.properties.symptoms);
      assert.equal(body.generationConfig.candidateCount, 1);
      assert.equal(body.generationConfig.thinkingConfig?.thinkingBudget, model === 'gemini-2.5-pro' ? undefined : 0);
      assert.equal(body.store, undefined);
      assert.equal(body.response_format, undefined);
      assert.ok(!String(init?.body).includes('fictional-key'));
      return completed(emptyRecord());
    } });
    assert.deepEqual(await extractor.extract('I feel fine today.', emptyRecord(), null), emptyRecord());
  }
});

test('Gemini 2.5 wellness follows the existing review and explicit save contract', async () => {
  const record = { ...emptyRecord(), wellness: { status: 'well', statement: 'I feel fine today.' } };
  const store = new Checkins(createGeminiExtractor({ apiKey: 'test', model: 'gemini-2.5-flash', fetcher: async () => completed(record) }));
  const review = await store.analyze({ transcript: 'I feel fine today.', painScale: '1-10' });
  assert.equal(review.status, 'review');
  assert.equal(review.savedAt, null);
  assert.equal(review.nextQuestion, null);
  assert.deepEqual(review.wellness, record.wellness);
  const saved = store.save({ sessionId: review.sessionId, version: review.version, confirmed: true });
  assert.equal(saved.status, 'saved');
});

test('GenerateContent ignores thought parts and joins only final output text', async () => {
  const json = JSON.stringify(emptyRecord());
  const extractor = createGeminiExtractor({ apiKey: 'test', model: 'gemini-2.5-flash', fetcher: async () => new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [
      { text: 'This must not become extracted data', thought: true },
      { text: json.slice(0, 10) }, { text: json.slice(10) },
    ] } }],
  })) });
  assert.deepEqual(await extractor.extract('Hello', emptyRecord(), null), emptyRecord());
});

test('blocked, truncated and invalid GenerateContent results never overwrite an existing record', async () => {
  const initial = await demoExtractor.extract('My arm hurts.', emptyRecord(), null);
  const invalidResponses = [
    () => completed(emptyRecord(), 'MAX_TOKENS'),
    () => completed(emptyRecord(), 'SAFETY'),
    () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })),
    () => new Response(JSON.stringify({ candidates: [] })),
    () => completed({ symptoms: 'invalid' }),
    () => completed({ ...emptyRecord(), diet: Array.from({ length: 21 }, () => ({ id: null, description: 'oatmeal', time: null })) }),
  ];
  for (const invalid of invalidResponses) {
    let calls = 0;
    const store = new Checkins(createGeminiExtractor({ apiKey: 'test', model: 'gemini-2.5-flash',
      fetcher: async () => ++calls === 1 ? completed(initial) : invalid() }));
    const state = await store.analyze({ transcript: 'My arm hurts.' });
    const session = { sessionId: state.sessionId, version: state.version };
    await assert.rejects(store.analyze({ ...session, transcript: 'My leg hurts too.' }), { code: 'EXTRACTION_FAILED' });
    const review = await store.analyze({ ...session, action: 'review' });
    assert.deepEqual(review.symptoms, state.symptoms);
    assert.equal(calls, 2);
  }
});

test('GenerateContent quota and missing-model errors do not silently switch models or endpoints', async () => {
  for (const status of [429, 404]) {
    let calls = 0;
    const extractor = createGeminiExtractor({ apiKey: 'test', model: 'gemini-2.5-flash', fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: status } }), { status });
    } });
    await assert.rejects(extractor.extract('Hello', emptyRecord(), null), { code: 'EXTRACTION_FAILED' });
    assert.equal(calls, 1);
  }
});

test('GenerateContent retains bounded 503 retry behavior', async () => {
  let calls = 0;
  const extractor = createGeminiExtractor({ apiKey: 'test', model: 'gemini-2.5-flash', fetcher: async () =>
    ++calls === 1 ? new Response('busy', { status: 503 }) : completed(emptyRecord()) });
  assert.deepEqual(await extractor.extract('Hello', emptyRecord(), null), emptyRecord());
  assert.equal(calls, 2);
});
