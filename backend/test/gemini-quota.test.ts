import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geminiQuotaReason } from '../src/gemini-quota.js';
import { createGeminiExtractor } from '../src/extractor.js';
import { emptyRecord } from '../src/schema.js';

const response = (error: unknown, headers = {}) => new Response(JSON.stringify({ error }), { status: 429, headers });
const quota = (quotaId: string, quotaValue = '20') => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaId, quotaValue, quotaDimensions: { model: 'ignored', project: 'private-project' } }],
});

test('Interactions errors distinguish daily quota from short-term throttling', async () => {
  const daily = await geminiQuotaReason(response({ code: 'quota_exceeded' }), 'test-model');
  assert.match(daily, /daily quota limit/);
  assert.match(daily, /Waiting a few minutes will not reset/);
  assert.match(daily, /Gemini model: test-model/);
  for (const code of ['rate_limit_exceeded', 'too_many_requests']) {
    const message = await geminiQuotaReason(response({ code }), 'test-model');
    assert.match(message, /short-term rate limit/);
    assert.doesNotMatch(message, /daily quota/);
  }
});

test('structured quota details identify daily, per-minute, and zero allowance limits', async () => {
  const daily = await geminiQuotaReason(response({ code: 429, details: [quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier')] }), 'test-model');
  assert.match(daily, /daily quota limit/);
  const minute = await geminiQuotaReason(response({ code: 429, details: [quota('GenerateContentInputTokensPerMinutePerModel')] }), 'test-model');
  assert.match(minute, /per-minute rate limit/);
  const zero = await geminiQuotaReason(response({ code: 'quota_exceeded', details: [quota('GenerateRequestsPerDay', '0')] }), 'test-model');
  assert.match(zero, /quota limit of zero/);
  assert.doesNotMatch(zero, /waiting at least|Waiting a few minutes/);
});

test('retry hints are bounded and do not suggest short waits for daily quotas', async () => {
  const details = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37.4s' }];
  const message = await geminiQuotaReason(response({ code: 'too_many_requests', details }, { 'Retry-After': '60' }), 'test-model');
  assert.match(message, /at least 60 seconds/);
  const rounded = await geminiQuotaReason(response({ code: 'too_many_requests', details }), 'test-model');
  assert.match(rounded, /at least 38 seconds/);
  const daily = await geminiQuotaReason(response({ code: 'quota_exceeded', details }), 'test-model');
  assert.doesNotMatch(daily, /at least.*seconds/);
  const invalid = await geminiQuotaReason(response({ code: 'too_many_requests' }, { 'Retry-After': 'private-data' }), 'test-model');
  assert.doesNotMatch(invalid, /private-data|seconds/);
});

test('malformed and unknown errors keep diagnosis unspecified without exposing raw data', async () => {
  for (const r of [
    new Response('secret-upstream-text', { status: 429 }),
    response({ code: 'secret-code', message: 'secret-api-key transcript', details: [null, 1, { secret: 'private' }] }),
    response(null),
  ]) {
    const message = await geminiQuotaReason(r, 'test-model');
    assert.match(message, /did not identify which limit/);
    assert.doesNotMatch(message, /secret|transcript|private/);
  }
});

test('oversized upstream error bodies are bounded and canceled', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { canceled = true; },
  });
  const message = await geminiQuotaReason(new Response(body, { status: 429 }), 'test-model');
  assert.match(message, /did not identify which limit/);
  assert.equal(canceled, true);
});

test('extractor reports the specific quota without another request or leaking provider text', async () => {
  let calls = 0;
  const extractor = createGeminiExtractor({ apiKey: 'fictional-key', model: 'test-model', fetcher: async () => {
    calls++;
    return response({ code: 'quota_exceeded', message: 'private provider diagnostic with key' });
  } });
  await assert.rejects(extractor.extract('fictional transcript', emptyRecord(), null), (error: any) => {
    assert.equal(error.code, 'EXTRACTION_FAILED');
    assert.match(error.message, /daily quota limit/);
    assert.match(error.message, /existing record was not changed/);
    assert.doesNotMatch(error.message, /private|fictional/);
    return true;
  });
  assert.equal(calls, 1);
});
