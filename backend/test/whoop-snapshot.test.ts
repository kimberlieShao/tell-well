import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { metricKeys, snapshotSource } from '../src/biometrics.js';

// Real WHOOP nights captured to a file, so a deployment with no connector still shows measured
// numbers. These guard the file's shape and that it reads back as ordinary wearable days.

const file = new URL('../demo-data/whoop-snapshot.json', import.meta.url);

test('the snapshot holds real nights in the shape the app expects', async () => {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(Array.isArray(parsed.nights) && parsed.nights.length >= 7,
    'a baseline needs at least 7 nights');
  assert.match(parsed.capturedAt, /^\d{4}-\d{2}-\d{2}$/);
  for (const night of parsed.nights) {
    assert.match(night.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const key of metricKeys) {
      const value = night[key];
      assert.ok(value === null || typeof value === 'number',
        `${night.date}: ${key} should be a number or null, got ${JSON.stringify(value)}`);
    }
  }
});

test('the source returns the newest nights, oldest first', async () => {
  const source = snapshotSource(file);
  const all = await source.fetchDays(1000);
  assert.equal(source.name, 'whoop', 'these are measured numbers, not example data');
  assert.equal(source.connectUrl, null, 'there is no connector to link to');
  const dates = all.map(n => n.date);
  assert.deepEqual(dates, [...dates].sort(), 'nights come back oldest first');
  assert.equal(new Set(dates).size, dates.length, 'no night appears twice');

  const seven = await source.fetchDays(7);
  assert.equal(seven.length, Math.min(7, all.length));
  assert.deepEqual(seven, all.slice(-7), 'asking for 7 gives the 7 most recent');
  assert.equal((await source.fetchDays(1)).length, 1);
});

test('every night carries at least one reading', async () => {
  for (const night of await snapshotSource(file).fetchDays(1000)) {
    assert.ok(metricKeys.some(key => night[key] !== null),
      `${night.date} has no readings at all and should not have been captured`);
  }
});

test('a missing or empty snapshot fails with an instruction, not a crash', () => {
  assert.throws(() => snapshotSource(new URL('../demo-data/not-here.json', import.meta.url)),
    /npm run whoop:snapshot/);
});
