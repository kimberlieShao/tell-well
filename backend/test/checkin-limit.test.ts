import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { demoExtractor, type Extractor } from '../src/extractor.js';

// CHECKIN_DAILY_LIMIT: each visitor may open only so many check-ins a day, so a public deployment
// cannot be used to drain the owner's Gemini quota. Demo extraction only: nothing here calls Gemini.

const knees = 'My knees hurt more today and I forgot my prednisone this morning.';

async function withApi(config: Parameters<typeof createApp>[1], run: (api: (path: string, body?: unknown, visitor?: string) => Promise<any>, base: string) => Promise<void>, extractor: Extractor = demoExtractor) {
  const app = createApp(extractor, config);
  app.set('trust proxy', 1); // as behind the platform's proxy: the visitor is the address it forwards
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, visitor = '203.0.113.1') => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': visitor },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try { await run(call, base); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('with no limit set, a visitor can open as many check-ins as they like', async () => {
  await withApi({}, async call => {
    for (let i = 0; i < 5; i++) assert.equal((await call('/api/analyze', { transcript: knees })).status, 200);
    assert.deepEqual((await call('/api/checkin/limit')).body.perDay, null);
  });
});

test('the fourth check-in of the day is refused with a plain message, and the first three are not', async () => {
  await withApi({ checkinLimit: 3 }, async call => {
    for (let i = 0; i < 3; i++) assert.equal((await call('/api/analyze', { transcript: knees })).status, 200);
    const refused = await call('/api/analyze', { transcript: knees });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, 'DAILY_CHECKIN_LIMIT');
    assert.match(refused.body.error.message, /3 check-ins per visitor per day/);
    const left = (await call('/api/checkin/limit')).body;
    assert.deepEqual([left.perDay, left.used, left.remaining], [3, 3, 0]);
  });
});

test('answering the questions of a check-in already open does not use up another', async () => {
  await withApi({ checkinLimit: 1 }, async call => {
    const opened = (await call('/api/analyze', { transcript: knees })).body;
    assert.ok(opened.nextQuestion, 'the example leaves one question to answer');
    const answered = await call('/api/analyze', { sessionId: opened.sessionId, version: opened.version, questionId: opened.nextQuestion.id, transcript: 'Moderate' });
    assert.equal(answered.status, 200);
    const saved = await call('/api/checkin/save', { sessionId: opened.sessionId, version: answered.body.version, confirmed: true });
    assert.equal(saved.status, 200);
    assert.equal((await call('/api/analyze', { transcript: knees })).status, 429, 'but a new check-in is refused');
  });
});

test('the allowance is per visitor, by the address the proxy forwards', async () => {
  await withApi({ checkinLimit: 1 }, async call => {
    assert.equal((await call('/api/analyze', { transcript: knees }, '203.0.113.1')).status, 200);
    assert.equal((await call('/api/analyze', { transcript: knees }, '203.0.113.1')).status, 429);
    assert.equal((await call('/api/analyze', { transcript: knees }, '203.0.113.2')).status, 200);
    assert.equal((await call('/api/checkin/limit', undefined, '203.0.113.3')).body.remaining, 1);
  });
});

test('a request that is invalid, or fails before a check-in opens, does not use up the allowance', async () => {
  const failing: Extractor = { mode: 'demo', async extract() { throw new Error('provider down'); } };
  await withApi({ checkinLimit: 1 }, async call => {
    assert.equal((await call('/api/analyze', { transcript: '   ' })).status, 400);
    assert.equal((await call('/api/analyze', { transcript: knees })).status, 500);
    assert.equal((await call('/api/checkin/limit')).body.remaining, 1);
  }, failing);
  await withApi({ checkinLimit: 1 }, async call => {
    assert.equal((await call('/api/analyze', { transcript: knees })).status, 200);
  });
});

test('with CLIENT_IP_HEADER set, the visitor is the address the platform reports, whatever else the request claims', async () => {
  await withApi({ checkinLimit: 1, clientIpHeader: 'x-real-ip' }, async (_call, base) => {
    const open = (headers: Record<string, string>) => fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ transcript: knees }) }).then(res => res.status);
    assert.equal(await open({ 'X-Real-IP': '198.51.100.1', 'X-Forwarded-For': '203.0.113.9' }), 200);
    assert.equal(await open({ 'X-Real-IP': '198.51.100.1', 'X-Forwarded-For': '203.0.113.10' }), 429, 'a made-up X-Forwarded-For is no new visitor');
    assert.equal(await open({ 'X-Real-IP': '198.51.100.2', 'X-Forwarded-For': '203.0.113.9' }), 200, 'another reported address is another visitor');
  });
});
