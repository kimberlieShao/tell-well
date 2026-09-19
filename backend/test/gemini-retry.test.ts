import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Checkins } from '../src/checkins.js';
import { createGeminiExtractor, demoExtractor } from '../src/extractor.js';
import { emptyRecord } from '../src/schema.js';

const config = { apiKey: 'fictional-test-key', model: 'test-model' };
const completed = (record: unknown) => new Response(JSON.stringify({
  status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(record) }] }],
}));

test('503 recovery retries the same transcript and commits the check-in only once', async () => {
  const requests: RequestInit[] = [];
  const failures: Response[] = [];
  const extraction = await demoExtractor.extract('My arm and leg hurt.', emptyRecord(), null);
  const store = new Checkins(createGeminiExtractor({ ...config, fetcher: async (_url, init) => {
    requests.push(init!);
    if (requests.length < 3) {
      const failure = new Response('unavailable', { status: 503 });
      failures.push(failure);
      return failure;
    }
    return completed(extraction);
  } }));
  const result = await store.analyze({ transcript: 'My arm and leg hurt.', painScale: '1-10' });
  assert.equal(requests.length, 3);
  assert.equal(result.version, 1);
  assert.equal(result.symptoms.length, 2);
  assert.deepEqual(result.symptoms.map(s => s.location), ['arm', 'leg']);
  assert.ok(result.nextQuestion);
  assert.ok(failures.every(response => response.bodyUsed));
  for (const request of requests) {
    assert.equal(request.body, requests[0].body);
    assert.equal(request.signal, requests[0].signal, 'All attempts must share one deadline');
  }
});

test('persistent 503 stops after three attempts and preserves existing session/version', async () => {
  let calls = 0;
  const extraction = await demoExtractor.extract('My knees hurt.', emptyRecord(), null);
  const store = new Checkins(createGeminiExtractor({ ...config, fetcher: async () => {
    calls++;
    return calls === 1 ? completed(extraction) : new Response('unavailable', { status: 503 });
  } }));
  const initial = await store.analyze({ transcript: 'My knees hurt.' });
  const session = { sessionId: initial.sessionId, version: initial.version };
  await assert.rejects(store.analyze({ ...session, transcript: 'My arm hurts too.' }),
    { code: 'EXTRACTION_FAILED', message: /Gemini is temporarily busy/ });
  assert.equal(calls, 4); // One initial success, then three failed attempts.
  const review = await store.analyze({ ...session, action: 'review' });
  assert.deepEqual(review.symptoms, initial.symptoms);
  assert.equal(review.version, initial.version + 1);
});

test('quota, permission and request errors are not automatically retried', async () => {
  for (const status of [429, 401, 403, 400, 404]) {
    let calls = 0;
    const extractor = createGeminiExtractor({ ...config, fetcher: async () => {
      calls++;
      return new Response('private provider response', { status });
    } });
    await assert.rejects(extractor.extract('Hello', emptyRecord(), null), { code: 'EXTRACTION_FAILED' });
    assert.equal(calls, 1, `Status ${status} must not be retried`);
  }
});

test('a quota error after a temporary failure stops further retries', async () => {
  let calls = 0;
  const extractor = createGeminiExtractor({ ...config, fetcher: async () =>
    new Response('error', { status: ++calls === 1 ? 503 : 429 }) });
  await assert.rejects(extractor.extract('Hello', emptyRecord(), null),
    { code: 'EXTRACTION_FAILED', message: /rate or quota limit/ });
  assert.equal(calls, 2);
});

test('long Retry-After seconds or dates do not hold the browser or hammer the provider', async () => {
  for (const retryAfter of ['120', new Date(Date.now() + 120_000).toUTCString()]) {
    let calls = 0;
    const extractor = createGeminiExtractor({ ...config, fetcher: async () => {
      calls++;
      return new Response('busy', { status: 503, headers: { 'Retry-After': retryAfter } });
    } });
    await assert.rejects(extractor.extract('Hello', emptyRecord(), null),
      { code: 'EXTRACTION_FAILED', message: /temporarily busy/ });
    assert.equal(calls, 1);
  }
});

test('the shared deadline cancels backoff without sending another request', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 25_000);
    return controller.signal;
  });
  let calls = 0;
  const extractor = createGeminiExtractor({ ...config, fetcher: async () => {
    calls++;
    setTimeout(() => controller.abort(), 20);
    return new Response('busy', { status: 503 });
  } });
  await assert.rejects(extractor.extract('Hello', emptyRecord(), null),
    { code: 'EXTRACTION_FAILED', message: /took too long/ });
  assert.equal(calls, 1);
});
