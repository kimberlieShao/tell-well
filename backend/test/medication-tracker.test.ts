import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const moduleUrl = new URL('../../frontend/medications.js', import.meta.url).href;
const { loadMedications, saveMedications, validateMedicationList, getMedicationProgress, recordMedicationCheckin, mountMedications } = await import(moduleUrl);
const profileScript = await readFile(new URL('../../frontend/profile-store.js', import.meta.url), 'utf8');
const markup = `<article class="patient-metric"><div class="patient-metric-label">Medication</div><div id="medTileValue"></div><div id="medTileFoot"></div></article>
<table><tbody id="medRows"></tbody></table><form id="medForm"><input id="medName"><input id="medDose"><select id="medWhen"><option>Morning</option></select><button>Add</button></form>`;
const med = (name: string, schedule = '') => ({ name, dose: '', schedule });
const taken = (name: string | null, status = 'taken') => ({ name, status });

function setup(profile = true) {
  const dom = new JSDOM(markup, { url: 'https://example.test/app', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window as any;
  const clock = { now: new Date(2026, 8, 20, 12).getTime() };
  window.Date = class extends Date {
    constructor(...args: any[]) { super(args.length ? Reflect.construct(Date, args).getTime() : clock.now); }
    static now() { return clock.now; }
  };
  window.structuredClone = structuredClone;
  if (profile) {
    window.eval(profileScript);
    window.PulsewiseProfile.save({ displayName: 'Test profile', medications: [] });
  }
  const saved = (sessionId: string, medications: any[], extra = {}) => ({
    status: 'saved', sessionId, savedAt: new Date(clock.now).toISOString(), medications, ...extra,
  });
  return { dom, window, clock, saved, document: window.document, close: () => dom.window.close() };
}

test('normalized names group while each list row supplies exactly one daily dose', () => {
  const page = setup();
  try {
    saveMedications([med('  Vitamin   D '), med('vitamin d'), med('Beta', 'Twice daily')], page.window);
    assert.deepEqual(getMedicationProgress(page.window), [
      { key: 'vitamin d', name: 'Vitamin D', taken: 0, required: 2 },
      { key: 'beta', name: 'Beta', taken: 0, required: 1 },
    ]);
    const tracker = mountMedications(page.document);
    assert.equal(page.document.querySelectorAll('#medRows tr').length, 3);
    assert.equal(page.document.querySelectorAll('.med-progress-row').length, 2);
    page.document.querySelector('.remove-med').click();
    assert.equal(getMedicationProgress(page.window)[0].required, 1);
    page.document.querySelector('.remove-med').click();
    assert.deepEqual(getMedicationProgress(page.window).map((item: any) => item.name), ['Beta']);
    tracker.destroy();
  } finally { page.close(); }
});

test('five distinct types allow repeat doses but reject a sixth type on add or rename inline', () => {
  const page = setup();
  try {
    const five = ['A', 'B', 'C', 'D', 'E'].map(name => med(name));
    saveMedications(five, page.window);
    assert.throws(() => validateMedicationList([...five, med('F')]), /up to 5 different medications/);
    assert.throws(() => saveMedications([...five, med('F')], page.window), /up to 5/);
    const sixDoses = saveMedications([...five, med(' a ')], page.window);
    assert.equal(sixDoses.length, 6);
    assert.throws(() => saveMedications(sixDoses.map((item: any, i: number) => i === 5 ? { ...item, name: 'F' } : item), page.window), /up to 5/);
    assert.equal(loadMedications(page.window).length, 6);
    assert.throws(() => validateMedicationList([med('  ')]), /medication name/);
    const tracker = mountMedications(page.document);
    page.document.getElementById('medName').value = 'Sixth type';
    page.document.getElementById('medForm').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
    assert.match(page.document.getElementById('medFormError').textContent, /up to 5/);
    assert.equal(page.document.getElementById('medFormError').hidden, false);
    assert.equal(page.document.querySelectorAll('.med-progress-row').length, 5);
    tracker.destroy();
  } finally { page.close(); }
});

test('oversized older lists stay intact and permit removals without new types', () => {
  const page = setup();
  try {
    page.window.PulsewiseProfile.patch({ medications: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(name => med(name)) });
    const tracker = mountMedications(page.document);
    assert.equal(page.document.querySelectorAll('.med-progress-row').length, 5);
    assert.match(page.document.getElementById('medTileFoot').textContent, /Showing 5/);
    page.document.querySelector('.remove-med').click();
    assert.equal(loadMedications(page.window).length, 6);
    assert.throws(() => saveMedications([...loadMedications(page.window), med('H')], page.window), /up to 5/);
    tracker.destroy();
  } finally { page.close(); }
});

test('only explicit saved taken records with an exact normalized listed name count once', () => {
  const page = setup();
  try {
    saveMedications([med('Alpha'), med('Vitamin D'), med('__proto__')], page.window);
    const entries = [taken('ALPHA'), taken(' alpha '), ...['missed', 'mentioned', 'stopped', 'Taken', ''].map(status => taken('Vitamin D', status)),
      taken(null), taken('medicine'), taken('Maybe Vitamin D'), taken('Alpha 20 mg'), taken('Unknown'), taken('__proto__')];
    assert.equal(recordMedicationCheckin(page.window, page.saved('draft', entries, { status: 'review' })), false);
    assert.equal(recordMedicationCheckin(page.window, page.saved('', entries)), false);
    assert.equal(recordMedicationCheckin(page.window, page.saved('first', entries)), true);
    assert.deepEqual(getMedicationProgress(page.window).map((item: any) => item.taken), [1, 0, 1]);
    assert.equal(recordMedicationCheckin(page.window, page.saved('first', [taken('Alpha')], { version: 99 })), false);
    assert.deepEqual(getMedicationProgress(page.window).map((item: any) => item.taken), [1, 0, 1]);
    const ledger = page.window.PulsewiseProfile.read().medicationTracking;
    assert.deepEqual(Object.keys(ledger).sort(), ['counts', 'date', 'receipts', 'version']);
    assert.deepEqual(ledger.receipts, ['first']);
  } finally { page.close(); }
});

test('separate saved check-ins exceed the target, check only equality, and removal updates live', () => {
  const page = setup();
  try {
    saveMedications([med('Alpha'), med('alpha')], page.window);
    const tracker = mountMedications(page.document);
    for (const [id, expected, complete] of [['one', '1/2', false], ['two', '2/2', true], ['three', '3/2', false]]) {
      recordMedicationCheckin(page.window, page.saved(String(id), [taken('Alpha')]));
      assert.equal(page.document.querySelector('.med-progress-count').textContent, expected);
      assert.equal(!!page.document.querySelector('.med-progress-check'), complete);
      assert.equal(page.document.querySelector('.med-progress-status')?.textContent ?? '', expected === '1/2' ? '' : complete
        ? 'All scheduled doses recorded for today.' : 'More doses recorded than scheduled for today.');
    }
    page.document.querySelector('.remove-med').click();
    assert.equal(page.document.querySelector('.med-progress-count').textContent, '3/1');
    assert.equal(page.document.querySelector('.med-progress-check'), null);
    assert.equal(page.document.querySelector('.med-progress-status').textContent, 'More doses recorded than scheduled for today.');
    page.document.querySelector('.remove-med').click();
    assert.equal(page.document.querySelector('.med-progress-row'), null);
    tracker.destroy();
  } finally { page.close(); }
});

test('local midnight timer, focus and visibility reset daily counts and reject old replays', () => {
  const page = setup();
  try {
    page.clock.now = new Date(2026, 8, 20, 23, 59, 58).getTime();
    let scheduled: (() => void) | undefined;
    let delay: number | undefined;
    page.window.setTimeout = (callback: () => void, ms: number) => { scheduled = callback; delay = ms; return 1; };
    page.window.clearTimeout = () => {};
    saveMedications([med('Alpha')], page.window);
    const old = page.saved('yesterday', [taken('Alpha')]);
    recordMedicationCheckin(page.window, old);
    const tracker = mountMedications(page.document);
    assert.equal(page.document.querySelector('.med-progress-count').textContent, '1/1');
    assert.equal(delay, 2000);
    assert.equal(page.document.querySelector('.med-progress-status').textContent, 'All scheduled doses recorded for today.');
    page.clock.now += 2000;
    scheduled!();
    assert.equal(page.document.querySelector('.med-progress-count').textContent, '0/1');
    assert.equal(page.document.querySelector('.med-progress-status'), null);
    assert.equal(page.document.querySelector('.med-progress-check'), null);
    assert.equal(recordMedicationCheckin(page.window, old), false);
    assert.equal(recordMedicationCheckin(page.window, { ...old, savedAt: undefined }), false);
    recordMedicationCheckin(page.window, page.saved('today', [taken('Alpha')]));
    assert.equal(page.document.querySelector('.med-progress-count').textContent, '1/1');
    page.clock.now = new Date(2026, 8, 22, 1).getTime();
    page.window.dispatchEvent(new page.window.Event('focus'));
    assert.equal(page.document.querySelector('.med-progress-count').textContent, '0/1');
    recordMedicationCheckin(page.window, page.saved('next-day', [taken('Alpha')]));
    page.clock.now = new Date(2026, 8, 23, 1).getTime();
    page.document.dispatchEvent(new page.window.Event('visibilitychange'));
    assert.equal(page.document.querySelector('.med-progress-count').textContent, '0/1');
    assert.equal(recordMedicationCheckin(page.window, page.saved('invalid', [taken('Alpha')], { savedAt: 'not a date' })), false);
    tracker.destroy();
  } finally { page.close(); }
});

test('refresh persists counts and receipts while a replacement profile starts fresh', () => {
  const first = setup();
  const reload = setup();
  try {
    saveMedications([med('Alpha')], first.window);
    const response = first.saved('same-checkin', [taken('Alpha')]);
    recordMedicationCheckin(first.window, response);
    reload.window.sessionStorage.setItem('pulsewise.demo-profile.v1', first.window.sessionStorage.getItem('pulsewise.demo-profile.v1'));
    assert.equal(getMedicationProgress(reload.window)[0].taken, 1);
    assert.equal(recordMedicationCheckin(reload.window, response), false);
    const tracker = mountMedications(reload.document);
    reload.window.PulsewiseProfile.save({ displayName: 'New profile', medications: [med('Alpha')] });
    assert.equal(getMedicationProgress(reload.window)[0].taken, 0);
    assert.equal(reload.document.querySelector('.med-progress-count').textContent, '0/1');
    assert.equal(reload.window.localStorage.getItem('pulsewise.medication-tracking.v1'), null);
    recordMedicationCheckin(reload.window, reload.saved('new-profile', [taken('Alpha')]));
    reload.clock.now = new Date(2026, 8, 21, 0, 1).getTime();
    tracker.destroy();
    const remounted = mountMedications(reload.document);
    assert.equal(reload.document.querySelector('.med-progress-count').textContent, '0/1');
    remounted.destroy();
  } finally { first.close(); reload.close(); }
});

test('legacy localStorage IDs and counts survive reload without leaking into a tab profile', () => {
  const first = setup(false);
  const reload = setup(false);
  try {
    first.window.localStorage.setItem('pulsewise.medications', JSON.stringify([med('Alpha'), med('Alpha')]));
    const legacy = loadMedications(first.window);
    assert.equal(new Set(legacy.map((item: any) => item.id)).size, 2);
    assert.deepEqual(legacy.map((item: any) => item.id), loadMedications(first.window).map((item: any) => item.id));
    saveMedications(legacy, first.window);
    const response = first.saved('legacy-checkin', [taken('Alpha')]);
    recordMedicationCheckin(first.window, response);
    for (const key of ['pulsewise.medications', 'pulsewise.medication-tracking.v1']) reload.window.localStorage.setItem(key, first.window.localStorage.getItem(key));
    assert.equal(getMedicationProgress(reload.window)[0].taken, 1);
    assert.equal(recordMedicationCheckin(reload.window, response), false);
    reload.window.eval(profileScript);
    reload.window.PulsewiseProfile.save({ displayName: 'Profile', medications: [med('Alpha')] });
    assert.equal(getMedicationProgress(reload.window)[0].taken, 0);
    assert.equal(first.window.sessionStorage.getItem('pulsewise.demo-profile.v1'), null);
  } finally { first.close(); reload.close(); }
});

test('storage failure does not mutate the list or consume a saved check-in receipt', () => {
  const page = setup();
  try {
    saveMedications([med('Alpha', 'Morning')], page.window);
    const patch = page.window.PulsewiseProfile.patch;
    page.window.PulsewiseProfile.patch = () => { throw new Error('Storage unavailable'); };
    assert.throws(() => saveMedications([med('Beta')], page.window), /could not be saved/);
    assert.throws(() => recordMedicationCheckin(page.window, page.saved('retry', [taken('Alpha')])), /counts could not be saved/);
    assert.equal(loadMedications(page.window)[0].name, 'Alpha');
    assert.equal(getMedicationProgress(page.window)[0].taken, 0);
    page.window.PulsewiseProfile.patch = patch;
    assert.equal(recordMedicationCheckin(page.window, page.saved('retry', [taken('Alpha')])), true);
    saveMedications(loadMedications(page.window).map((item: any) => ({ ...item, schedule: 'Evening' })), page.window);
    assert.equal(loadMedications(page.window)[0].when, 'Evening');
  } finally { page.close(); }
});

for (const profile of [true, false]) {
  const scope = profile ? 'profile' : 'legacy localStorage';
  const readLedger = (window: any) => profile ? window.PulsewiseProfile.read().medicationTracking
    : JSON.parse(window.localStorage.getItem('pulsewise.medication-tracking.v1'));

  test(`${scope} Reset clears all dose counts and messages, persists across reload, and retains receipt deduplication`, () => {
    const first = setup(profile);
    const reload = setup(profile);
    let tracker: any;
    let reloadedTracker: any;
    try {
      saveMedications([med('Alpha', 'Morning'), med('alpha', 'Afternoon'), med('Beta', 'Evening'), med('Gamma', 'As needed')], first.window);
      const originalMeds = loadMedications(first.window);
      const firstCheckin = first.saved('first-checkin', [taken('Alpha'), taken('Beta')]);
      const secondCheckin = first.saved('second-checkin', [taken('Alpha'), taken('Beta')]);
      recordMedicationCheckin(first.window, firstCheckin);
      recordMedicationCheckin(first.window, secondCheckin);
      const originalReceipts = readLedger(first.window).receipts;
      tracker = mountMedications(first.document);
      assert.deepEqual([...first.document.querySelectorAll('.med-progress-count')].map((element: any) => element.textContent), ['2/2', '2/1', '0/1']);
      assert.equal(first.document.querySelectorAll('.med-progress-check').length, 1);
      assert.equal(first.document.querySelectorAll('.med-progress-status').length, 2);
      assert.equal(first.document.querySelectorAll('.is-over-target').length, 1);
      const reset = first.document.getElementById('medResetCounts');
      assert.ok(reset, 'The tracker creates a Reset button in the tile label');
      assert.equal(reset.type, 'button');
      assert.equal(reset.disabled, false);
      reset.click();
      assert.deepEqual(getMedicationProgress(first.window).map((entry: any) => [entry.taken, entry.required]), [[0, 2], [0, 1], [0, 1]]);
      assert.deepEqual([...first.document.querySelectorAll('.med-progress-count')].map((element: any) => element.textContent), ['0/2', '0/1', '0/1']);
      assert.equal(first.document.querySelectorAll('.med-progress-check, .med-progress-status, .is-complete, .is-over-target').length, 0);
      assert.deepEqual(loadMedications(first.window), originalMeds, 'Reset preserves IDs, names, schedules, doses and target rows');
      assert.deepEqual(readLedger(first.window).receipts, originalReceipts);
      assert.equal(first.document.querySelectorAll('#medRows tr').length, 4);
      assert.equal(reset.disabled, true);
      assert.equal(first.document.getElementById('medResetError').hidden, true);

      if (profile) reload.window.sessionStorage.setItem('pulsewise.demo-profile.v1', first.window.sessionStorage.getItem('pulsewise.demo-profile.v1'));
      else for (const key of ['pulsewise.medications', 'pulsewise.medication-tracking.v1']) reload.window.localStorage.setItem(key, first.window.localStorage.getItem(key));
      reloadedTracker = mountMedications(reload.document);
      assert.deepEqual(getMedicationProgress(reload.window).map((entry: any) => entry.taken), [0, 0, 0]);
      assert.deepEqual(loadMedications(reload.window), originalMeds);
      assert.equal(recordMedicationCheckin(reload.window, firstCheckin), false);
      assert.equal(recordMedicationCheckin(reload.window, secondCheckin), false);
      assert.deepEqual(getMedicationProgress(reload.window).map((entry: any) => entry.taken), [0, 0, 0], 'Replaying pre-reset check-ins cannot restore cleared counts');
      assert.equal(reload.document.querySelector('.med-progress-status'), null);
      assert.equal(recordMedicationCheckin(reload.window, reload.saved('new-checkin', [taken('Alpha'), taken('Beta')])), true);
      assert.deepEqual(getMedicationProgress(reload.window).map((entry: any) => [entry.taken, entry.required]), [[1, 2], [1, 1], [0, 1]]);
      assert.equal(reload.document.querySelectorAll('.med-progress-check').length, 1);
      assert.equal(reload.document.getElementById('medResetCounts').disabled, false);
    } finally {
      tracker?.destroy();
      reloadedTracker?.destroy();
      first.close();
      reload.close();
    }
  });

  test(`${scope} Reset reports storage failure inline without clearing counts and permits retry`, () => {
    const page = setup(profile);
    let tracker: any;
    let restore = () => {};
    try {
      saveMedications([med('Alpha', 'Morning'), med('Beta', 'Evening')], page.window);
      const response = page.saved('already-saved', [taken('Alpha'), taken('Beta')]);
      recordMedicationCheckin(page.window, response);
      const originalLedger = readLedger(page.window);
      const originalMeds = loadMedications(page.window);
      tracker = mountMedications(page.document);
      if (profile) {
        const patch = page.window.PulsewiseProfile.patch;
        page.window.PulsewiseProfile.patch = () => { throw new Error('Storage unavailable'); };
        restore = () => { page.window.PulsewiseProfile.patch = patch; };
      } else {
        const prototype = page.window.Storage.prototype;
        const setItem = prototype.setItem;
        prototype.setItem = function (key: string, value: string) {
          if (key === 'pulsewise.medication-tracking.v1') throw new Error('Storage unavailable');
          return setItem.call(this, key, value);
        };
        restore = () => { prototype.setItem = setItem; };
      }
      const reset = page.document.getElementById('medResetCounts');
      reset.click();
      const error = page.document.getElementById('medResetError');
      assert.equal(error.hidden, false);
      assert.equal(error.getAttribute('role'), 'alert');
      assert.match(error.textContent, /reset|save|retry/i);
      assert.deepEqual(readLedger(page.window), originalLedger);
      assert.deepEqual(loadMedications(page.window), originalMeds);
      assert.deepEqual(getMedicationProgress(page.window).map((entry: any) => entry.taken), [1, 1]);
      assert.equal(page.document.querySelectorAll('.med-progress-check').length, 2);
      assert.equal(page.document.querySelectorAll('.med-progress-status').length, 2);
      assert.equal(reset.disabled, false, 'A failed reset stays retryable');
      restore();
      reset.click();
      assert.equal(error.hidden, true);
      assert.deepEqual(getMedicationProgress(page.window).map((entry: any) => entry.taken), [0, 0]);
      assert.deepEqual(readLedger(page.window).receipts, originalLedger.receipts);
      assert.equal(page.document.querySelector('.med-progress-check'), null);
      assert.equal(page.document.querySelector('.med-progress-status'), null);
      assert.equal(recordMedicationCheckin(page.window, response), false);
      assert.deepEqual(getMedicationProgress(page.window).map((entry: any) => entry.taken), [0, 0]);
      assert.equal(reset.disabled, true);
    } finally {
      restore();
      tracker?.destroy();
      page.close();
    }
  });
}
