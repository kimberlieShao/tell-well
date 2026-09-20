import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { Checkins } from '../src/checkins.js';
import { createGeminiExtractor, demoExtractor, type Extractor } from '../src/extractor.js';
import { emptyRecord, recordSchema, responseSchema, type CheckinResponse } from '../src/schema.js';

async function withApi(run: (post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>, base: string) => Promise<void>, extractor: Extractor = demoExtractor, store?: Checkins) {
  const server = createApp(extractor, { store }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await run(post, base); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const initialText = 'My knees hurt more today and I forgot my prednisone this morning.';
const session = (state: CheckinResponse) => ({ sessionId: state.sessionId, version: state.version });

test('full transcript → severity answer → review → confirmed save; fixed response shape', async () => {
  await withApi(async post => {
    let r = await post('/api/analyze', { transcript: initialText });
    assert.equal(r.status, 200);
    let state = responseSchema.parse(r.body);
    assert.equal(state.symptoms[0].location, 'knees');
    assert.equal(state.symptoms[0].trend, 'worse');
    assert.equal(state.symptoms[0].severity, null);
    assert.equal(state.medications[0].name, 'Prednisone');
    assert.equal(state.medications[0].dose, null);
    assert.equal(state.medications[0].status, 'missed');
    assert.equal(state.medications[0].time, 'morning');
    assert.deepEqual(state.missingFields, ['symptoms[0].severity']);
    assert.deepEqual(state.diet, []);
    assert.deepEqual(state.vitals, []);
    r = await post('/api/analyze', { ...session(state), questionId: state.nextQuestion!.id, transcript: 'Moderate' });
    state = responseSchema.parse(r.body);
    assert.equal(state.symptoms[0].severity, 'moderate');
    assert.equal(state.status, 'review');
    assert.equal(state.nextQuestion, null);
    assert.equal(state.symptoms.length, 1);
    const saveBody = { ...session(state), confirmed: true };
    r = await post('/api/checkin/save', saveBody);
    assert.equal(r.status, 200);
    assert.equal(responseSchema.parse(r.body).status, 'saved');
    assert.equal(r.body.storage, 'memory');
    assert.ok(r.body.savedAt);
    const retry = await post('/api/checkin/save', saveBody);
    assert.deepEqual(retry.body, r.body);
    assert.equal((await post('/api/analyze', { ...session(r.body), transcript: 'I have a headache.' })).status, 409);
  });
});

test('unknown pill stays unnamed; no fabricated medication list; unknown answer can proceed', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: 'I forgot the white pill.' });
    assert.equal(state.needsClarification, true);
    assert.equal(state.medications[0].name, null);
    assert.equal(state.medications[0].dose, null);
    assert.deepEqual(state.nextQuestion.options, []);
    assert.equal(state.nextQuestion.field, 'name');
    assert.equal((await post('/api/analyze', { ...session(state), answer: { questionId: state.nextQuestion.id, value: 'the white pill' } })).status, 422);
    ({ body: state } = await post('/api/analyze', { ...session(state), transcript: "I'm not sure", questionId: state.nextQuestion.id }));
    assert.equal(state.status, 'review');
    assert.equal(state.needsClarification, true);
    assert.deepEqual(state.skippedFields, ['medications[0].name']);
    assert.deepEqual(state.missingFields, ['medications[0].name']);
  });
});

test('medication clarification preserves missed status and time without inferring dose', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: 'I forgot the white pill this morning.' });
    ({ body: state } = await post('/api/analyze', { ...session(state), transcript: 'Prednisone', questionId: state.nextQuestion.id }));
    assert.equal(state.medications.length, 1);
    assert.equal(state.medications[0].name, 'Prednisone');
    assert.equal(state.medications[0].status, 'missed');
    assert.equal(state.medications[0].time, 'morning');
    assert.equal(state.medications[0].dose, null);
    assert.equal(state.needsClarification, false);
  });
});

test('uncertain medication form answers do not resolve identity or advance the session', async () => {
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: 'I forgot the white pill this morning.' });
    for (const value of ['Maybe prednisone', 'I think prednisone', 'Prednisone?', 'Prednisone or lisinopril']) {
      const response = await post('/api/analyze', { ...session(state), answer: { questionId: state.nextQuestion.id, value } });
      assert.equal(response.status, 422);
      assert.equal(response.body.error.code, 'INVALID_ANSWER');
    }
    const { body: skipped, status } = await post('/api/analyze', { ...session(state), action: 'skip', questionId: state.nextQuestion.id });
    assert.equal(status, 200);
    assert.equal(skipped.version, state.version + 1);
    assert.equal(skipped.medications[0].name, null);
    assert.equal(skipped.medications[0].status, 'missed');
    assert.equal(skipped.medications[0].time, 'morning');
    assert.equal(skipped.needsClarification, true);
  });
});

test('multiple symptoms use entity-specific questions and reject stale/invalid answers', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: 'My knees hurt more today. I have a headache.' });
    assert.equal(state.symptoms.length, 2);
    const old = state;
    let r = await post('/api/analyze', { ...session(state), answer: { questionId: state.nextQuestion.id, value: 'banana' } });
    assert.equal(r.status, 422);
    ({ body: state } = await post('/api/analyze', { ...session(state), answer: { questionId: state.nextQuestion.id, value: 'Severe' } }));
    assert.equal(state.symptoms[0].severity, 'severe');
    assert.equal(state.symptoms[1].severity, null);
    r = await post('/api/analyze', { ...session(old), transcript: 'Moderate', questionId: old.nextQuestion.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'STALE_VERSION');
    r = await post('/api/analyze', { ...session(state), transcript: 'Moderate', questionId: old.nextQuestion.id });
    assert.equal(r.body.error.code, 'STALE_QUESTION');
  });
});

test('numeric pain score is kept as stated and never converted into a severity category', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: 'My knees hurt.' });
    ({ body: state } = await post('/api/analyze', { ...session(state), questionId: state.nextQuestion.id, transcript: '7 out of 10' }));
    assert.equal(state.symptoms[0].severityScore, 7);
    assert.equal(state.symptoms[0].severity, null);
    assert.ok(!state.missingFields.includes('symptoms[0].severity'));
  });
});

test('sessions are isolated and new facts preserve previous known values', async () => {
  await withApi(async post => {
    const a = (await post('/api/analyze', { transcript: initialText })).body;
    const b = (await post('/api/analyze', { transcript: 'I have nausea.' })).body;
    const updated = (await post('/api/analyze', { ...session(a), transcript: 'My knees hurt.' })).body;
    assert.equal(updated.symptoms.length, 1);
    assert.equal(updated.symptoms[0].trend, 'worse');
    assert.equal(b.symptoms[0].name, 'nausea');
    assert.equal(b.medications.length, 0);
    assert.notEqual(a.sessionId, b.sessionId);
  });
});

test('review can finish early, edits can clear/remove fields, confirmation required', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: initialText });
    assert.equal((await post('/api/checkin/save', { ...session(state), confirmed: true })).body.error.code, 'REVIEW_REQUIRED');
    ({ body: state } = await post('/api/analyze', { ...session(state), action: 'review' }));
    assert.equal(state.nextQuestion, null);
    assert.ok(state.missingFields.length > 0);
    const record = recordSchema.parse({ symptoms: state.symptoms, medications: [], diet: [], vitals: [] });
    record.symptoms[0].location = 'left knee';
    record.symptoms[0].trend = null;
    assert.equal((await post('/api/checkin/save', { ...session(state), record })).status, 400);
    const saved = await post('/api/checkin/save', { ...session(state), record, confirmed: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.symptoms[0].location, 'left knee');
    assert.equal(saved.body.symptoms[0].trend, null);
    assert.deepEqual(saved.body.medications, []);
  });
});

test('skipping the final question reaches review without making up a value', async () => {
  await withApi(async post => {
    let { body: state } = await post('/api/analyze', { transcript: initialText });
    ({ body: state } = await post('/api/analyze', { ...session(state), action: 'skip', questionId: state.nextQuestion.id }));
    assert.equal(state.symptoms[0].severity, null);
    assert.equal(state.nextQuestion, null);
    assert.equal(state.status, 'review');
    assert.deepEqual(state.skippedFields, ['symptoms[0].severity']);
  });
});

test('empty/invalid/oversized/unknown requests have JSON errors', async () => {
  await withApi(async (post, base) => {
    for (const body of [{}, { transcript: '' }, { transcript: 'x', extra: true }, { transcript: 'x', action: 'review' }, { transcript: 'x'.repeat(8001) }]) {
      const r = await post('/api/analyze', body);
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'INVALID_REQUEST');
    }
    assert.equal((await post('/api/analyze', { sessionId: randomUUID(), version: 1, transcript: 'test' })).status, 404);
    const badJson = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json() as any).error.code, 'INVALID_JSON');
    const noJson = await fetch(base + '/api/analyze', { method: 'POST', body: 'test' });
    assert.equal(noJson.status, 415);
    const huge = await post('/api/analyze', { transcript: 'x'.repeat(70000) });
    assert.equal(huge.status, 413);
    assert.equal((await post('/unknown', {})).status, 404);
  });
});

test('CORS permits configured frontend and rejects other browser origins', async () => {
  await withApi(async (post, base) => {
    assert.equal((await post('/api/analyze', { transcript: initialText }, { Origin: 'https://untrusted.example' })).status, 403);
    const preflight = await fetch(base + '/api/analyze', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8081');
  });
});

test('same-origin tester can submit while unrelated origins remain blocked', async () => {
  await withApi(async (post, base) => {
    const success = await post('/api/analyze', { transcript: initialText }, { Origin: base });
    assert.equal(success.status, 200);
    const blocked = await post('/api/analyze', { transcript: initialText }, { Origin: 'http://other-host.example:3001' });
    assert.equal(blocked.status, 403);
  });
});

test('tester serves only its public assets and cannot expose backend settings', async () => {
  await withApi(async (_post, base) => {
    const page = await fetch(base + '/test/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('Content-Type') ?? '', /text\/html/);
    assert.ok(page.headers.get('Content-Security-Policy')?.includes("connect-src 'self'"));
    for (const path of ['/test/.env', '/test/../.env', '/test/../src/server.ts', '/test/%2e%2e%2f.env']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404);
    }
  });
});

test('diet and vital values retain reported text without inventing units/nutrients', async () => {
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: 'I ate oatmeal for breakfast. My temperature was 38.' });
    assert.equal(state.diet[0].description, 'I ate oatmeal for breakfast');
    assert.equal(state.vitals[0].value, '38');
    assert.equal(state.vitals[0].unit, null);
    assert.equal(state.nextQuestion.field, 'unit');
  });
});

test('negated/uncertain symptoms do not become known facts in demo mode', async () => {
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: 'I have no knee pain. Maybe I have nausea. I forgot maybe prednisone.' });
    assert.equal(state.symptoms.length, 0);
    assert.equal(state.medications[0].name, null);
    assert.equal(state.needsClarification, true);
  });
});

test('unsupported transcript is visible as unextracted and an empty record cannot save', async () => {
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: 'Hello there.' });
    assert.equal(state.extractionMode, 'demo');
    assert.ok(state.notices.some((text: string) => text.includes('No new structured')));
    assert.equal((await post('/api/checkin/save', { ...session(state), confirmed: true })).body.error.code, 'EMPTY_RECORD');
  });
});

test('session expiry and capacity are bounded', async () => {
  let time = Date.now();
  const store = new Checkins(demoExtractor, { now: () => time, ttlMs: 100, maxSessions: 1 });
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: initialText });
    assert.equal((await post('/api/analyze', { transcript: initialText })).status, 503);
    time += 101;
    assert.equal((await post('/api/analyze', { ...session(state), action: 'review' })).body.error.code, 'SESSION_NOT_FOUND');
    assert.equal((await post('/api/analyze', { transcript: initialText })).status, 200);
  }, demoExtractor, store);
});

test('Gemini adapter validates structured output and sends a JSON schema with server-side key', async () => {
  let request: any;
  const extractor = createGeminiExtractor({ apiKey: 'fictional-test-key', model: 'test-model', fetcher: async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    request = init;
    return new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(emptyRecord()) }] }] }));
  } });
  assert.deepEqual(await extractor.extract('Hello', emptyRecord(), null), emptyRecord());
  const payload = JSON.parse(request.body);
  assert.equal(payload.response_format.mime_type, 'application/json');
  assert.equal(payload.store, false);
  assert.equal(payload.model, 'test-model');
  assert.deepEqual(payload.generation_config, { max_output_tokens: 4096, thinking_level: 'low' });
  assert.ok(payload.response_format.schema.properties.symptoms);
  const sentSchema = JSON.stringify(payload.response_format.schema);
  for (const unsupported of ['"minLength"', '"maxLength"', '"pattern"', '"maxItems"', '"format":"uuid"', '"$schema"'])
    assert.ok(!sentSchema.includes(unsupported), `Provider schema must omit ${unsupported}`);
  assert.equal(request.headers['x-goog-api-key'], 'fictional-test-key');
  for (const response of [
    new Response('provider error', { status: 429 }),
    new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"symptoms":"bad"}' }] }] })),
    new Response(JSON.stringify({ status: 'incomplete', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(emptyRecord()) }] }] })),
  ]) {
    const broken = createGeminiExtractor({ apiKey: 'test', model: 'test', fetcher: async () => response });
    await assert.rejects(() => broken.extract('hello', emptyRecord(), null), { code: 'EXTRACTION_FAILED' });
  }
});

test('provider schema simplification does not weaken record length validation', async () => {
  const oversized = { ...emptyRecord(), diet: Array.from({ length: 21 }, () => ({ id: null, description: 'oatmeal', time: null })) };
  const extractor = createGeminiExtractor({ apiKey: 'test', model: 'test', fetcher: async () => new Response(JSON.stringify({
    status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(oversized) }] }],
  })) });
  await assert.rejects(() => extractor.extract('fictional example', emptyRecord(), null), { code: 'EXTRACTION_FAILED' });
});

test('AI errors and invalid entity references leave session state unchanged', async () => {
  let calls = 0;
  const extractor: Extractor = { mode: 'gemini', async extract(text, record, q) {
    calls++;
    const result = await demoExtractor.extract(text, record, q);
    if (calls === 2) result.symptoms[0].id = randomUUID();
    return result;
  } };
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: initialText });
    const failed = await post('/api/analyze', { ...session(state), transcript: 'My knees hurt.' });
    assert.equal(failed.status, 502);
    const { body: reviewed } = await post('/api/analyze', { ...session(state), action: 'review' });
    assert.equal(reviewed.symptoms[0].trend, 'worse');
    assert.equal(reviewed.version, state.version + 1);
  }, extractor);
});

test('overlapping requests cannot overwrite one another', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const extractor: Extractor = { mode: 'demo', async extract(text, record, q) {
    if (++calls === 2) { entered(); await gate; }
    return demoExtractor.extract(text, record, q);
  } };
  await withApi(async post => {
    const { body: state } = await post('/api/analyze', { transcript: initialText });
    const first = post('/api/analyze', { ...session(state), transcript: 'I have a headache.' });
    await started;
    const second = await post('/api/analyze', { ...session(state), action: 'review' });
    assert.equal(second.body.error.code, 'SESSION_BUSY');
    release();
    assert.equal((await first).status, 200);
  }, extractor);
});
