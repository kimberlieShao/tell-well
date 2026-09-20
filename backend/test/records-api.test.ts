import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { CheckinLog, localDate } from '../src/checkin-log.js';
import { arthritisProfile, arthritisQuietDays, arthritisRecords } from '../src/demo-story.js';
import { demoExtractor } from '../src/extractor.js';
import { recordSchema, responseSchema, type CheckinResponse } from '../src/schema.js';

// GET /api/records feeds the Records calendar: the example person while the demo is on, otherwise the
// confirmed check-ins the server has kept. Demo extraction only: nothing here calls Gemini.

async function withApi(run: (api: { get: (path: string) => Promise<any>; post: (path: string, body: unknown) => Promise<any> }) => Promise<void>) {
  const server = createApp(demoExtractor).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => { const res = await fetch(base + path); return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() }; };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await run({ get, post }); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

/** A whole check-in through the real routes: describe it, answer the one question, confirm. */
async function saveCheckin(post: (path: string, body: unknown) => Promise<any>, text: string) {
  let state = responseSchema.parse((await post('/api/analyze', { transcript: text })).body);
  if (state.nextQuestion) state = responseSchema.parse((await post('/api/analyze', { sessionId: state.sessionId, version: state.version, questionId: state.nextQuestion.id, transcript: 'Moderate' })).body);
  const saved = await post('/api/checkin/save', { sessionId: state.sessionId, version: state.version, confirmed: true });
  assert.equal(saved.status, 200);
  return responseSchema.parse(saved.body);
}

const knees = 'My knees hurt more today and I forgot my prednisone this morning.';

test('with no check-ins saved, the real records are an empty list', async () => {
  await withApi(async ({ get }) => {
    const res = await get('/api/records');
    assert.equal(res.status, 200);
    assert.equal(res.cache, 'no-store');
    assert.deepEqual(res.body, { source: 'real', name: null, checkins: [], quietDays: [] });
  });
});

test('a confirmed check-in appears in the record format, once, oldest first; an unconfirmed one does not', async () => {
  await withApi(async ({ get, post }) => {
    const first = await saveCheckin(post, knees);
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await saveCheckin(post, 'My knees hurt more today and I forgot my ibuprofen this morning.');
    const pending = responseSchema.parse((await post('/api/analyze', { transcript: 'My back hurts today.' })).body);
    assert.equal(pending.status === 'saved', false);
    // A retried save (the version the person last saw) succeeds again, and must not duplicate the entry.
    assert.equal((await post('/api/checkin/save', { sessionId: first.sessionId, version: first.version - 1, confirmed: true })).status, 200);

    const { body } = await get('/api/records');
    assert.equal(body.source, 'real');
    assert.deepEqual(body.checkins.map((c: any) => c.sessionId), [first.sessionId, second.sessionId]);
    const [one] = body.checkins;
    assert.equal(one.savedAt, first.savedAt);
    const { sessionId, savedAt, ...record } = one;
    const parsed = recordSchema.parse(record); // exactly the fields of a saved record, nothing extra
    assert.equal(parsed.symptoms[0]!.location, 'knees');
    assert.equal(parsed.medications[0]!.name, 'Prednisone');
    assert.ok(parsed.reportedAnswers?.some(answer => answer.transcript === knees && answer.entityId === null));
    assert.deepEqual(Object.keys(one).sort(), ['diet', 'medications', 'reportedAnswers', 'savedAt', 'sessionId', 'symptoms', 'vitals', 'wellness']);
  });
});

test('switching the demo on shows the example person; switching it off brings the real check-ins back', async () => {
  await withApi(async ({ get, post }) => {
    const real = await saveCheckin(post, knees);
    assert.equal((await post('/api/demo', { on: true })).body.on, true);
    const demo = (await get('/api/records')).body;
    assert.equal(demo.source, 'demo');
    assert.equal(demo.name, 'Arthur Itis');
    assert.equal(demo.checkins.length, 10);
    assert.ok(!demo.checkins.some((c: any) => c.sessionId === real.sessionId));
    for (const { sessionId, savedAt, ...record } of demo.checkins) { assert.ok(sessionId && savedAt); recordSchema.parse(record); }
    assert.deepEqual(demo.checkins, JSON.parse(JSON.stringify(arthritisRecords(localDate(new Date())))));

    assert.equal((await post('/api/demo', { on: false })).body.on, false);
    const back = (await get('/api/records')).body;
    assert.equal(back.source, 'real');
    assert.deepEqual(back.checkins.map((c: any) => c.sessionId), [real.sessionId]);
  });
});

test('the log keeps only confirmed check-ins, sorts them, and hands out copies', () => {
  const log = new CheckinLog(() => Date.parse('2026-09-20T12:00:00Z'));
  const saved = (sessionId: string, savedAt: string | null, status: CheckinResponse['status'] = 'saved') => ({
    sessionId, savedAt, status, symptoms: [], medications: [], diet: [], vitals: [], wellness: null, reportedAnswers: [],
  }) as unknown as CheckinResponse;
  log.remember(saved('late', '2026-09-19T20:00:00.000Z'));
  log.remember(saved('early', '2026-09-04T09:00:00.000Z'));
  log.remember(saved('draft', null, 'review'));
  log.remember(saved('late', '2026-09-19T21:00:00.000Z')); // the same session saved again replaces it
  assert.deepEqual(log.savedRecords().map(r => [r.sessionId, r.savedAt]), [['early', '2026-09-04T09:00:00.000Z'], ['late', '2026-09-19T21:00:00.000Z']]);
  log.savedRecords()[0]!.symptoms.push({} as never);
  assert.equal(log.savedRecords()[0]!.symptoms.length, 0);
  assert.equal(log.days().length, 2); // the reminders' view of the same check-ins is unchanged
});

test('the example person also brings his quiet days, in the shape the calendar and Trends read, and real data brings none', async () => {
  await withApi(async ({ get, post }) => {
    assert.deepEqual((await get('/api/records')).body.quietDays, []);
    await post('/api/demo', { on: true });
    const today = localDate(new Date());
    const { source, quietDays, checkins } = (await get('/api/records')).body;
    assert.equal(source, 'demo');
    assert.equal(quietDays.length, 21);
    assert.deepEqual(quietDays, JSON.parse(JSON.stringify(arthritisQuietDays(today))));
    for (const day of quietDays) {
      assert.deepEqual(Object.keys(day).sort(), ['date', 'diastolic', 'note', 'pain', 'systolic', 'taken', 'due'].sort());
      assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(day.date < today, 'quiet days are earlier than the newest check-in day');
    }
    assert.deepEqual(quietDays.map((day: any) => day.date), [...quietDays.map((day: any) => day.date)].sort());
    // A day is either a quiet day or a check-in day, never both, so together they cover the 30 days Trends draws.
    const checkinDays = new Set(checkins.map((c: any) => localDate(new Date(c.savedAt))));
    assert.ok(quietDays.every((day: any) => !checkinDays.has(day.date)));
    assert.equal(new Set([...checkinDays, ...quietDays.map((day: any) => day.date)]).size, 30);
    await post('/api/demo', { on: false });
    assert.deepEqual((await get('/api/records')).body.quietDays, []);
  });
});

test('the example profile holds only what the demo file has: a name, a condition and his medications', async () => {
  const profile = arthritisProfile();
  assert.deepEqual(Object.keys(profile), ['name', 'condition', 'medications']);
  assert.equal(profile.name, 'Arthur Itis');
  assert.equal(profile.condition, 'Rheumatoid arthritis');
  assert.deepEqual(profile.medications.map(m => [m.name, m.dose]), [['Methotrexate', '15 mg'], ['Folic acid', '1 mg'], ['Ibuprofen', '400 mg']]);
  assert.ok(profile.medications.every(m => m.description));
  await withApi(async ({ get, post }) => {
    assert.equal((await get('/api/demo')).body.story, null); // nothing about the example person while the demo is off
    const on = (await post('/api/demo', { on: true })).body;
    assert.deepEqual(on.story.profile, profile);
  });
});
