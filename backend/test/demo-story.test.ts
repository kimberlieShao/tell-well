import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  arthritisCheckins, arthritisNights, arthritisPatterns, arthritisRecords, arthritisSeries, arthritisToday,
} from '../src/demo-story.js';
import { recordSchema } from '../src/schema.js';

// The example person lives in backend/demo-data/arthur-itis.json in the same shape a real saved record
// has, so the Records calendar reads one the same way it reads the other. These guard that shape.

const TODAY = '2026-09-20';
const dataFile = new URL('../demo-data/arthur-itis.json', import.meta.url);

test('every example check-in is a valid health record', async () => {
  const file = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.ok(file.checkins.length >= 5, 'the demo needs a few days of check-ins');
  for (const checkin of file.checkins) {
    const { sessionId, savedAt, ...record } = checkin;
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(!Number.isNaN(Date.parse(savedAt)), `${savedAt} is not a timestamp`);
    recordSchema.parse(record); // throws with the offending field if someone mistypes an edit
  }
});

test('every reported answer points at an entity in its own check-in, or at nothing', async () => {
  const file = JSON.parse(await readFile(dataFile, 'utf8'));
  for (const checkin of file.checkins) {
    const ids = new Set([...checkin.symptoms, ...checkin.medications, ...checkin.diet, ...checkin.vitals].map((e: { id: string }) => e.id));
    for (const answer of checkin.reportedAnswers ?? []) {
      if (answer.entityId !== null) assert.ok(ids.has(answer.entityId), `${answer.entityId} is not in this check-in`);
    }
  }
});

test('the story moves so its newest day is always the day of the demo', () => {
  for (const today of ['2026-09-20', '2026-11-03', '2027-02-14']) {
    const checkins = arthritisCheckins(today);
    assert.equal(checkins.at(-1)!.date, today, `newest check-in should land on ${today}`);
    assert.equal(arthritisNights(today).at(-1)!.date, today);
    assert.equal(arthritisSeries(today, 30).at(-1)!.date, today);
  }
});

test('a day with two check-ins keeps both, and folds into one row of the series', () => {
  const checkins = arthritisCheckins(TODAY);
  const counts = new Map<string, number>();
  for (const c of checkins) counts.set(c.date, (counts.get(c.date) ?? 0) + 1);
  const busiest = [...counts.entries()].find(([, n]) => n > 1);
  assert.ok(busiest, 'the demo should show at least one day with two check-ins');

  const [date] = busiest;
  const rows = arthritisSeries(TODAY, 30).filter(d => d.date === date);
  assert.equal(rows.length, 1, 'one day is one row');
  const both = checkins.filter(c => c.date === date);
  assert.equal(rows[0].taken, both.flatMap(c => c.medications).filter(m => m.status === 'taken').length);
  assert.equal(rows[0].pain, Math.max(...both.flatMap(c => c.symptoms.map(s => s.score ?? 0))));
  assert.ok(both[0].at < both[1].at, 'check-ins on one day stay in order');
});

test('a sparse check-in leaves gaps rather than inventing noughts', () => {
  const sparse = arthritisCheckins(TODAY).find(c => c.symptoms.some(s => s.score === null));
  assert.ok(sparse, 'the demo should include a day with very little filled in');
  assert.equal(sparse.symptoms[0].location, null);
  assert.equal(sparse.symptoms[0].duration, null);
  const row = arthritisSeries(TODAY, 30).find(d => d.date === sparse.date)!;
  assert.equal(row.pain, null, 'an unrated symptom is not a nought');
  assert.equal(row.systolic, null, 'no reading means no reading');
});

test('the series covers every day and carries the fields the Trends tab reads', () => {
  const series = arthritisSeries(TODAY, 30);
  assert.equal(series.length, 30);
  assert.equal(new Set(series.map(d => d.date)).size, 30, 'no day appears twice');
  for (const day of series) {
    assert.ok(day.due >= day.taken, `${day.date}: more doses taken than were due`);
    assert.ok(day.note.length > 0, `${day.date}: every day needs a note for the tooltip`);
  }
  assert.deepEqual(arthritisSeries(TODAY, 7), series.slice(-7), 'the 7-day view is the tail of the 30');
});

test("what the person said is kept, and links back to what it was about", () => {
  const records = arthritisRecords(TODAY);
  const answers = records.flatMap(r => r.reportedAnswers ?? []);
  assert.ok(answers.some(a => a.entityId === null), 'an opening answer belongs to no single entity');
  assert.ok(answers.some(a => a.entityId !== null), 'follow-up answers attach to a symptom or medication');

  const today = arthritisCheckins(TODAY).at(-1)!;
  assert.ok(today.said.length > 0, "the newest check-in should carry the person's own words");
  assert.ok(today.medications.some(m => m.status === 'missed' && m.said.length > 0),
    'the missed dose should keep the answer that reported it');
});

test('the home page gets the newest blood pressure and the doses due that day', () => {
  const story = arthritisToday(TODAY);
  assert.equal(story.name, 'Arthur Itis');
  assert.match(story.bloodPressure!.value!, /^\d{2,3}\/\d{2,3}$/);
  assert.ok(story.medications.some(m => m.status === 'missed'), 'the demo turns on a missed dose');
  assert.equal(story.checkins[0].date, TODAY, 'check-ins are listed newest first');
});

test('patterns count what happened and never claim a cause', () => {
  const patterns = arthritisPatterns(TODAY);
  assert.ok(patterns.length >= 2);
  assert.match(patterns.at(-1)!, /too short to show cause/);
  for (const line of patterns) assert.doesNotMatch(line, /\b(caused|because of|due to)\b/i);
});
