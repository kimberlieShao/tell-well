import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { demoSource } from '../src/biometrics.js';
import { CheckinLog, localDate } from '../src/checkin-log.js';
import { demoExtractor } from '../src/extractor.js';
import { screenText } from '../src/safety.js';
import type { CheckinResponse } from '../src/schema.js';

test('red-flag screen: urgent wording, negation and the crisis line', () => {
  assert.equal(screenText('I have chest pain and it feels tight').level, 'emergency');
  assert.equal(screenText('No chest pain today, just stiff hands').level, 'none');
  assert.equal(screenText('I fainted at work yesterday').level, 'urgent');
  assert.match(screenText('I keep thinking I want to die').advice!, /988/);
  assert.equal(screenText('My knees hurt a lot today').level, 'none');
});

const savedCheckin = (savedAt: string, name: string, severityScore: number | null) => ({
  schemaVersion: '1.0', sessionId: randomUUID(), version: 2, status: 'saved', extractionMode: 'demo',
  symptoms: [{ id: randomUUID(), name, location: null, severity: null, severityScore, trend: null, functionalImpact: null, duration: null }],
  medications: [], diet: [], vitals: [], wellness: null,
  missingFields: [], skippedFields: [], needsClarification: false, nextQuestion: null, notices: [],
  storage: 'memory', expiresAt: savedAt, savedAt,
} as unknown as CheckinResponse);

async function withApp(run: (api: {
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<{ status: number; body: any }>;
  log: CheckinLog;
}) => Promise<void>) {
  const now = Date.now();
  const today = localDate(new Date(now));
  const log = new CheckinLog(() => now);
  // Example nights, with the latest night drifting away from the usual range.
  const server = createApp(demoExtractor, { log, wearable: demoSource(() => today, [today]) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = {
    get: async (path: string) => (await fetch(base + path)).json(),
    post: async (path: string, body: unknown) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    log,
  };
  try { await run(api); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('a nudge needs wearable drift and logged symptoms, explains itself, and quiets down after feedback', async () => {
  await withApp(async ({ get, post, log }) => {
    const quiet = await get('/api/nudges');
    assert.equal(quiet.wearable, 'connected');
    assert.deepEqual(quiet.nudges, [], 'wearable numbers alone must never nudge');

    log.remember(savedCheckin(new Date().toISOString(), 'joint pain', 6));
    const { nudges } = await get('/api/nudges');
    assert.equal(nudges.length, 1);
    const [nudge] = nudges;
    assert.ok(['note', 'watch', 'check_in'].includes(nudge.tier));
    assert.ok(nudge.reasons.length >= 2, 'every nudge says why');
    assert.ok(nudge.reasons.some((reason: string) => reason.includes('usual range')));
    assert.ok(nudge.signals.length >= 1);

    assert.equal((await post('/api/nudges/feedback', { nudgeId: nudge.id, verdict: 'not_a_flare' })).status, 200);
    assert.deepEqual((await get('/api/nudges')).nudges, [], 'a nudge waits after "not a flare"');

    const bad = await post('/api/nudges/feedback', { nudgeId: 'not-a-real-id', verdict: 'not_a_flare' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'UNKNOWN_NUDGE');
  });
});

test('what someone says in a check-in is screened, and the alert clears once it is read', async () => {
  await withApp(async ({ get, post }) => {
    await post('/api/analyze', { transcript: 'I have chest pain and my knees hurt' });
    const flagged = await get('/api/nudges');
    assert.equal(flagged.alert.level, 'emergency');
    assert.match(flagged.alert.advice, /911/);

    assert.equal((await post('/api/nudges/read-alert', {})).status, 200);
    assert.equal((await get('/api/nudges')).alert, null);
  });
});
