import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { demoExtractor, type Extractor } from '../src/extractor.js';

// CHECKIN_DAILY_TOTAL: the demo opens only so many check-ins a day in all, so a public deployment cannot
// drain the owner's Gemini quota, and nobody is turned away because of who else shares their network.
// Demo extraction only: nothing here calls Gemini.

const knees = 'My knees hurt more today and I forgot my prednisone this morning.';
const usedUp = "Today's demo check-ins are used up. Explore Arthur's 30 days of example data in Records and Trends.";

async function withApi(config: Parameters<typeof createApp>[1], run: (call: (path: string, body?: unknown, from?: string) => Promise<any>) => Promise<void>, extractor: Extractor = demoExtractor) {
  const app = createApp(extractor, config);
  app.set('trust proxy', 1);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, from = '203.0.113.1') => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try { await run(call); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('with no limit set, any number of check-ins can be opened, as on a laptop', async () => {
  await withApi({}, async call => {
    for (let i = 0; i < 5; i++) assert.equal((await call('/api/analyze', { transcript: knees })).status, 200);
    assert.deepEqual(await call('/api/checkin/limit'), { status: 200, body: { dailyTotal: null, used: 0, remaining: null } });
  });
});

test('once the day\'s total is opened, the next check-in is refused with the message, and the last one before it is not', async () => {
  await withApi({ checkinLimit: 3 }, async call => {
    for (let i = 0; i < 3; i++) assert.equal((await call('/api/analyze', { transcript: knees })).status, 200);
    assert.deepEqual((await call('/api/checkin/limit')).body, { dailyTotal: 3, used: 3, remaining: 0 });
    const refused = await call('/api/analyze', { transcript: knees });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, 'DAILY_CHECKIN_LIMIT');
    assert.equal(refused.body.error.message, usedUp);
  });
});

test('the total is shared by everyone: visitors on one network, or many, draw from the same day', async () => {
  await withApi({ checkinLimit: 3 }, async call => {
    // Three judges on one Wi-Fi share an address, and each still gets a check-in.
    for (let i = 0; i < 3; i++) assert.equal((await call('/api/analyze', { transcript: knees }, '198.51.100.7')).status, 200);
    // The next person, from anywhere, finds the day used up.
    assert.equal((await call('/api/analyze', { transcript: knees }, '203.0.113.99')).status, 429);
  });
});

test('answering the questions of a check-in already open does not use up another', async () => {
  await withApi({ checkinLimit: 1 }, async call => {
    const opened = (await call('/api/analyze', { transcript: knees })).body;
    assert.ok(opened.nextQuestion, 'the example leaves one question to answer');
    const answered = await call('/api/analyze', { sessionId: opened.sessionId, version: opened.version, questionId: opened.nextQuestion.id, transcript: 'Moderate' });
    assert.equal(answered.status, 200);
    assert.equal((await call('/api/checkin/save', { sessionId: opened.sessionId, version: answered.body.version, confirmed: true })).status, 200);
    assert.equal((await call('/api/analyze', { transcript: knees })).status, 429, 'but a new check-in is refused');
  });
});

test('a request that is invalid, or fails before a check-in opens, does not use up the day', async () => {
  const failing: Extractor = { mode: 'demo', async extract() { throw new Error('provider down'); } };
  await withApi({ checkinLimit: 1 }, async call => {
    assert.equal((await call('/api/analyze', { transcript: '   ' })).status, 400);
    assert.equal((await call('/api/analyze', { transcript: knees })).status, 500);
    assert.equal((await call('/api/checkin/limit')).body.remaining, 1);
  }, failing);
});
