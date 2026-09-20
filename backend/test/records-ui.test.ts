import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { arthritisRecords } from '../src/demo-story.js';
import { recordSchema } from '../src/schema.js';

// The Records page (calendar + day dialog) in jsdom. Times are built in local time so the tests do not
// depend on the machine's time zone, and nothing here calls the network or Gemini.
const recordsUrl = new URL('../../frontend/records.js', import.meta.url).href;
const uiUrl = new URL('../../frontend/new-ui.js', import.meta.url).href;
const visitUrl = new URL('../../frontend/visit-summary.js', import.meta.url).href;
const toggleUrl = new URL('../../frontend/demo-toggle.js', import.meta.url).href;
const readText = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

const NOW = new Date(2026, 8, 20, 10, 0); // Sunday, September 20, 2026
const at = (day: number, hour = 9, minute = 0, month = 8) => new Date(2026, month, day, hour, minute).toISOString();
const symptom = (id: string, name: string, extra: any = {}) => ({ id, name, location: null, severity: null, severityScore: null, trend: null, functionalImpact: null, duration: null, firstOccurrence: null, ...extra });
const medication = (id: string, name: string | null, extra: any = {}) => ({ id, name, description: null, dose: null, status: null, time: null, ...extra });
const diet = (id: string, description: string, extra: any = {}) => ({ id, description, time: null, ...extra });
const answer = (transcript: string, extra: any = {}) => ({ questionId: null, entityId: null, field: null, question: null, transcript, interpretation: 'recorded', ...extra });
const checkin = (savedAt: string, parts: any = {}) => ({ sessionId: `s-${savedAt}`, savedAt, symptoms: [], medications: [], diet: [], vitals: [], wellness: null, reportedAnswers: [], ...parts });

const fixtures = [
  // Sep 4: one check-in
  checkin(at(4, 10), {
    symptoms: [symptom('h1', 'Headache', { severity: 'mild', severityScore: 4, location: 'Forehead' })],
    reportedAnswers: [answer('It started this morning.', { entityId: 'h1', question: 'When did it start?' })],
  }),
  // Sep 11: a sparse symptom and a medication with nothing but a name
  checkin(at(11, 14), { symptoms: [symptom('a1', 'Arm pain', { severityScore: 0 })], medications: [medication('m1', 'Vitamin D')] }),
  // Sep 19: two check-ins
  checkin(at(19, 8, 30), {
    symptoms: [symptom('h2', 'Headache', {
      severity: 'moderate', severityScore: 6, location: 'Behind the eyes', duration: 'Since yesterday', functionalImpact: 'Light bothers me',
      trend: 'worse', firstOccurrence: false,
    })],
    reportedAnswers: [answer('My headache is back.'), answer('Yesterday afternoon.', { entityId: 'h2', question: 'Since when?', interpretation: 'unconfirmed' })],
  }),
  checkin(at(19, 17, 45), {
    medications: [medication('m2', 'Ibuprofen', { status: 'taken', description: 'For the headache', dose: '200 mg' })],
    diet: [diet('d1', 'Soup', { time: 'Dinner', waterGlasses: 3, waterMode: 'total' })],
  }),
];

// `load` stands in for GET /api/records. By default it answers with the given check-ins as the person's own.
async function withRecords(run: (page: any) => Promise<void> | void, checkins: any[] = fixtures, load?: () => Promise<any>, waitForLoad = true) {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const { mountRecords } = await import(recordsUrl);
  const document = dom.window.document;
  const page: any = {
    dom, document,
    mounted: mountRecords(document, { load: load ?? (async () => ({ source: 'real', name: null, checkins })), now: NOW }),
    $: (selector: string) => document.querySelector(selector),
    $$: (selector: string) => [...document.querySelectorAll(selector)],
    day: (n: number, month = 9) => document.querySelector(`[data-date="2026-${String(month).padStart(2, '0')}-${String(n).padStart(2, '0')}"]`),
    press: (key: string) => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })),
    focused: () => (document.activeElement as HTMLElement | null)?.dataset.date,
    title: () => document.getElementById('recordsMonthTitle')!.textContent,
    open: (n: number, month = 9) => { page.day(n, month).click(); },
    rows: () => page.$$('.records-row'),
    labels: (row: Element) => [...row.querySelectorAll('dt')].map(node => node.textContent),
  };
  try { if (waitForLoad) await page.mounted.ready; await run(page); } finally { page.mounted.destroy(); dom.window.close(); }
}

test('navigation has five tabs, Records second, on desktop and phone, with the same icon style', async () => {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const window = dom.window as any;
  window.structuredClone = structuredClone; window.scrollTo = () => {};
  window.eval(await readText('frontend/profile-store.js'));
  const { mountVersionB } = await import(uiUrl);
  const { mountRecords } = await import(recordsUrl);
  const document = window.document as Document;
  const app = mountVersionB(document, { conversationEnabled: false, speechFactory: () => ({ available: false, cancel() {}, destroy() {} }), speakerFactory: () => ({ stop() {}, destroy() {} }) });
  const records = mountRecords(document, { load: async () => ({ source: 'real', name: null, checkins: [] }), now: NOW });
  try {
    const names = (selector: string) => [...document.querySelectorAll(selector)].map(node => node.textContent!.trim());
    assert.deepEqual(names('.nav-button'), ['Home', 'Records', 'Trends', 'Meals', 'More']);
    assert.deepEqual(names('.mobile-nav-item'), ['Home', 'Records', 'Trends', 'Meals', 'More']);
    for (const selector of ['#desktopRecordsNav .nav-icon svg', '#recordsNav > svg']) {
      const icon = document.querySelector(selector)!;
      assert.ok(icon, selector);
      assert.equal(icon.getAttribute('viewBox'), '0 0 24 24');
      assert.equal(icon.getAttribute('fill'), '#ec7d68');
    }
    const view = document.getElementById('recordsView') as HTMLElement;
    const home = document.querySelector('.patient-home') as HTMLElement;
    assert.equal(view.hidden, true);
    (document.getElementById('desktopRecordsNav') as HTMLElement).click();
    assert.equal(view.hidden, false); assert.equal(home.hidden, true);
    assert.ok(document.getElementById('desktopRecordsNav')!.classList.contains('active'));
    assert.ok(document.getElementById('recordsNav')!.classList.contains('active'));
    assert.ok(!document.getElementById('desktopHomeNav')!.classList.contains('active'));
    (document.getElementById('desktopTrendsNav') as HTMLElement).click();
    assert.equal(view.hidden, true);
    (document.getElementById('recordsNav') as HTMLElement).click();
    assert.equal(view.hidden, false); assert.ok(document.getElementById('recordsNav')!.classList.contains('active'));
    (document.getElementById('homeNav') as HTMLElement).click();
    assert.equal(view.hidden, true); assert.equal(home.hidden, false);
  } finally { records.destroy(); app.destroy(); dom.window.close(); }
});

test('the stylesheet uses the existing light coral for today and makes room for five phone tabs', async () => {
  const css = await readText('frontend/records.css');
  assert.match(css, /--blush:\s*#fbe4de/i);
  assert.match(css, /\.records-day\.is-today\s*\{[^}]*background:\s*var\(--blush\)/);
  assert.match(css, /\.mobile-nav\s*\{[^}]*repeat\(5, 1fr\)/);
  assert.match(await readText('frontend/home.css'), /\.more-card-icon \{ background: #fbe4de/i); // the colour is not new
});

test('the calendar shows September 2026 with Sunday-first weeks and a dot on days with records', async () => {
  await withRecords(page => {
    assert.equal(page.title(), 'September 2026');
    assert.deepEqual(page.$$('.records-weekday').map((node: Element) => node.textContent), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    assert.equal(page.$$('.records-day').length, 30);
    const firstWeek = page.$$('.records-week')[1].querySelectorAll('.records-cell');
    assert.equal(firstWeek[2].querySelector('.records-day')!.dataset.date, '2026-09-01'); // Tuesday
    assert.equal(firstWeek[0].children.length, 0);
    assert.deepEqual(page.$$('.records-day.has-records').map((node: HTMLElement) => node.dataset.date), ['2026-09-04', '2026-09-11', '2026-09-19']);
    for (const cell of page.$$('.records-day')) assert.equal(cell.querySelectorAll('.records-dot').length, cell.classList.contains('has-records') ? 1 : 0);
    assert.equal(page.$$('.records-day.is-today').length, 1);
    assert.equal(page.day(20).classList.contains('is-today'), true);
    assert.equal(page.day(20).getAttribute('aria-current'), 'date');
  });
});

test('each day has an aria-label that says whether it has records', async () => {
  await withRecords(page => {
    assert.equal(page.day(19).getAttribute('aria-label'), 'September 19, 2026, has records');
    assert.equal(page.day(18).getAttribute('aria-label'), 'September 18, 2026, no records');
    assert.equal(page.day(20).getAttribute('aria-label'), 'September 20, 2026, no records, today');
    assert.equal(page.day(21).getAttribute('aria-label'), 'September 21, 2026, upcoming');
    assert.ok(page.$$('.records-day').every((node: Element) => node.tagName === 'BUTTON'));
  });
});

test('future days are shown but cannot be opened', async () => {
  await withRecords(page => {
    for (const n of [21, 25, 30]) {
      assert.equal(page.day(n).classList.contains('is-future'), true);
      assert.equal(page.day(n).getAttribute('aria-disabled'), 'true');
      page.day(n).click();
      assert.equal(page.$('#recordsDay').classList.contains('open'), false);
    }
    assert.equal(page.day(25).querySelector('.records-dot'), null); // no dot on days that have not happened
    assert.equal(page.day(20).getAttribute('aria-disabled'), null);
  }, [...fixtures, checkin(at(25, 9), { symptoms: [symptom('f1', 'Future entry')] })]);
});

test('the arrows move between months, and the next arrow stops at the current month', async () => {
  await withRecords(page => {
    const next = page.$('#recordsNext');
    const previous = page.$('#recordsPrev');
    assert.equal(next.getAttribute('aria-disabled'), 'true');
    next.click();
    assert.equal(page.title(), 'September 2026');
    previous.click();
    assert.equal(page.title(), 'August 2026');
    assert.equal(page.$$('.records-day').length, 31);
    assert.equal(page.$$('.records-day.is-future').length, 0);
    assert.equal(page.$$('.records-day.is-today').length, 0);
    assert.equal(next.getAttribute('aria-disabled'), 'false');
    previous.click();
    assert.equal(page.title(), 'July 2026');
    next.click(); next.click();
    assert.equal(page.title(), 'September 2026');
    assert.equal(page.$$('.records-day.has-records').length, 3);
    assert.equal(next.getAttribute('aria-disabled'), 'true');
  });
});

test('days in another month show their records, grouped by the viewer\'s local date', async () => {
  await withRecords(page => {
    page.$('#recordsPrev').click();
    assert.deepEqual(page.$$('.records-day.has-records').map((node: HTMLElement) => node.dataset.date), ['2026-08-30', '2026-08-31']);
    page.open(30, 8);
    assert.equal(page.$('#recordsDayTitle').textContent, 'Sunday, August 30');
    assert.match(page.$('#recordsDayBody').textContent, /Night cough/);
    assert.doesNotMatch(page.$('#recordsDayBody').textContent, /Next day/);
  }, [checkin(at(30, 23, 50, 7), { symptoms: [symptom('n1', 'Night cough')] }), checkin(at(31, 0, 5, 7), { symptoms: [symptom('n2', 'Next day')] })]);
});

test('the calendar works from the keyboard: one tab stop, arrows, Home/End and Page keys', async () => {
  await withRecords(page => {
    assert.deepEqual(page.$$('.records-day').filter((node: HTMLElement) => node.tabIndex === 0).map((node: HTMLElement) => node.dataset.date), ['2026-09-20']);
    page.day(20).focus();
    page.press('ArrowLeft'); assert.equal(page.focused(), '2026-09-19');
    page.press('ArrowUp'); assert.equal(page.focused(), '2026-09-12');
    page.press('ArrowDown'); assert.equal(page.focused(), '2026-09-19');
    page.press('Home'); assert.equal(page.focused(), '2026-09-13'); // Sunday of that week
    page.press('End'); assert.equal(page.focused(), '2026-09-19'); // Saturday
    page.press('ArrowRight'); assert.equal(page.focused(), '2026-09-20');
    assert.deepEqual(page.$$('.records-day').filter((node: HTMLElement) => node.tabIndex === 0).map((node: HTMLElement) => node.dataset.date), ['2026-09-20']);
    page.press('ArrowDown'); assert.equal(page.focused(), '2026-09-27'); // future days can be reached
    page.press('ArrowDown'); assert.equal(page.focused(), '2026-09-27'); // October does not exist
    page.press('PageDown'); assert.equal(page.focused(), '2026-09-27'); assert.equal(page.title(), 'September 2026');
    page.press('PageUp'); assert.equal(page.focused(), '2026-08-27'); assert.equal(page.title(), 'August 2026');
    page.press('PageDown'); assert.equal(page.focused(), '2026-09-27'); assert.equal(page.title(), 'September 2026');
    page.day(1).focus();
    page.press('ArrowLeft'); assert.equal(page.focused(), '2026-08-31'); assert.equal(page.title(), 'August 2026');
    page.press('ArrowRight'); assert.equal(page.focused(), '2026-09-01'); assert.equal(page.title(), 'September 2026');
    page.press('x'); assert.equal(page.focused(), '2026-09-01');
  });
});

test('opening a day shows its date, closes with × or Escape, and returns focus to the day', async () => {
  await withRecords(page => {
    const overlay = page.$('#recordsDay');
    assert.equal(overlay.classList.contains('open'), false);
    page.open(19);
    assert.equal(overlay.classList.contains('open'), true);
    assert.equal(overlay.getAttribute('role'), 'dialog');
    assert.equal(overlay.getAttribute('aria-modal'), 'true');
    assert.equal(page.$('#recordsDayTitle').textContent, 'Saturday, September 19');
    assert.equal(page.document.activeElement, page.$('#recordsDayClose'));
    assert.equal(page.$('#recordsDayClose').getAttribute('aria-label'), 'Close day details');
    page.$('#recordsDayClose').click();
    assert.equal(overlay.classList.contains('open'), false);
    assert.equal(page.document.activeElement, page.day(19));
    page.open(4);
    page.document.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(overlay.classList.contains('open'), false);
    assert.equal(page.document.activeElement, page.day(4));
    page.open(4);
    overlay.click();
    assert.equal(overlay.classList.contains('open'), false);
  });
});

test('Tab stays inside the open dialog', async () => {
  await withRecords(page => {
    page.open(19);
    const buttons = [...page.$('#recordsDay').querySelectorAll('button')];
    buttons.at(-1).focus();
    const tab = new page.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    page.document.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(page.document.activeElement, buttons[0]);
  });
});

test('a day without check-ins says so', async () => {
  await withRecords(page => {
    page.open(18);
    assert.equal(page.$('#recordsDayTitle').textContent, 'Friday, September 18');
    assert.equal(page.$('#recordsDayBody').textContent, 'No check-ins recorded on this day.');
    page.open(20); // today, nothing yet
    assert.equal(page.$('#recordsDayBody').textContent, 'No check-ins recorded on this day.');
  });
});

test('the day lists records by category, and times appear only when the day has several check-ins', async () => {
  await withRecords(page => {
    page.open(19);
    assert.deepEqual(page.$$('.records-group-title').map((node: Element) => node.textContent), ['Symptoms', 'Medications', 'Meals', 'In your own words']);
    const rows = page.rows();
    assert.deepEqual(rows.map((row: Element) => row.querySelector('.records-row-title')!.textContent), ['Headache', 'Ibuprofen', 'Soup', 'In your own words']);
    assert.deepEqual(rows.map((row: Element) => row.querySelector('.records-time')?.textContent), ['8:30 AM', '5:45 PM', '5:45 PM', '8:30 AM']);
    page.$('#recordsDayClose').click();
    page.open(4);
    assert.equal(page.$$('.records-time').length, 0);
    assert.deepEqual(page.$$('.records-group-title').map((node: Element) => node.textContent), ['Symptoms']);
  });
});

test('a row opens to show its details and closes again', async () => {
  await withRecords(page => {
    page.open(19);
    const [row] = page.rows();
    const head = row.querySelector('.records-row-head') as HTMLButtonElement;
    const body = row.querySelector('.records-row-body') as HTMLElement;
    assert.equal(head.tagName, 'BUTTON');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    assert.equal(body.hidden, true);
    assert.equal(head.getAttribute('aria-controls'), body.id);
    head.click();
    assert.equal(head.getAttribute('aria-expanded'), 'true');
    assert.equal(body.hidden, false);
    assert.deepEqual(page.labels(row), ['Pain level', 'Location', 'Since when', 'Activities affected', 'Trend', 'First time']);
    assert.deepEqual([...row.querySelectorAll('dd')].map(node => node.textContent), ['6/10 · Moderate', 'Behind the eyes', 'Since yesterday', 'Light bothers me', 'Worse', 'No']);
    head.click();
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    assert.equal(body.hidden, true);
  });
});

test('only fields that have a value are shown; a score of 0 counts, and a row with nothing to show cannot open', async () => {
  await withRecords(page => {
    page.open(11);
    const [arm, vitaminD] = page.rows();
    arm.querySelector('.records-row-head').click();
    assert.deepEqual(page.labels(arm), ['Pain level']);
    assert.equal(arm.querySelector('dd').textContent, '0/10');
    assert.equal(vitaminD.querySelector('.records-row-title').textContent, 'Vitamin D');
    assert.equal(vitaminD.querySelector('button'), null);
    assert.equal(vitaminD.querySelector('.records-row-body'), null);
    assert.equal(vitaminD.querySelector('.records-chevron'), null);
  });
});

test('medications show name, taken or missed and purpose; meals show time and water', async () => {
  await withRecords(page => {
    page.open(19);
    const [, medicine, meal] = page.rows();
    assert.equal(medicine.querySelector('.records-row-summary').textContent, 'Taken');
    medicine.querySelector('.records-row-head').click();
    assert.deepEqual(page.labels(medicine), ['Status', 'Purpose', 'Dose']);
    assert.deepEqual([...medicine.querySelectorAll('dd')].map((node: Element) => node.textContent), ['Taken', 'For the headache', '200 mg']);
    meal.querySelector('.records-row-head').click();
    assert.deepEqual([...meal.querySelectorAll('dt')].map((node: Element) => node.textContent), ['Time', 'Water']);
    assert.equal(meal.querySelectorAll('dd')[1].textContent, '3 glasses in total today');
  });
  await withRecords(page => {
    page.open(11);
    page.rows()[0].querySelector('.records-row-head').click();
    assert.equal(page.rows()[0].querySelector('.records-row-summary').textContent, 'Missed');
    assert.deepEqual(page.labels(page.rows()[0]), ['Status']);
  }, [checkin(at(11, 9), { medications: [medication('m9', 'Blood pressure pill', { status: 'missed' })] })]);
});

test('the person\'s own words sit in the row they are about; the rest is listed at the bottom', async () => {
  await withRecords(page => {
    page.open(19);
    const [headache, , , words] = page.rows();
    headache.querySelector('.records-row-head').click();
    const quote = headache.querySelector('.records-quote')!;
    assert.equal(quote.querySelector('.records-quote-text')!.textContent, 'Yesterday afternoon.');
    assert.equal(quote.querySelector('.records-quote-question')!.textContent, 'Since when?');
    assert.match(quote.querySelector('.records-quote-note')!.textContent!, /not confirmed/);
    assert.equal(headache.querySelectorAll('.records-quote').length, 1);
    assert.equal(words.querySelector('.records-row-summary')!.textContent, '“My headache is back.”');
    words.querySelector('.records-row-head').click();
    assert.deepEqual([...words.querySelectorAll('.records-quote-text')].map((node: Element) => node.textContent), ['My headache is back.']);
    page.$('#recordsDayClose').click();
    page.open(4);
    const [only] = page.rows();
    only.querySelector('.records-row-head').click();
    assert.equal(only.querySelector('.records-quotes-title').textContent, 'In your own words');
    assert.equal(only.querySelector('.records-quote-text').textContent, 'It started this morning.');
    assert.equal(only.querySelector('.records-quote-note'), null);
  });
});

test('a well day shows its statement, and check-in text is never treated as HTML', async () => {
  await withRecords(page => {
    assert.equal(page.day(16).classList.contains('has-records'), true);
    page.open(16);
    assert.equal(page.$('.records-note').textContent, 'I feel fine today.');
    page.$('#recordsDayClose').click();
    page.open(17);
    assert.equal(page.$('#recordsDayBody img'), null);
    assert.equal(page.$('.records-row-title').textContent, '<img src=x onerror=alert(1)>');
  }, [
    checkin(at(16, 9), { wellness: { status: 'well', statement: 'I feel fine today.' } }),
    checkin(at(17, 9), { symptoms: [symptom('x1', '<img src=x onerror=alert(1)>')] }),
  ]);
});

test('check-ins without a date or without anything to show are ignored, and { checkins } is accepted', async () => {
  const { groupByDay, normalizeCheckins } = await import(recordsUrl);
  assert.equal(normalizeCheckins(null).length, 0);
  assert.equal(normalizeCheckins({ checkins: [{ savedAt: 'not a date' }, { symptoms: [] }, fixtures[0]] }).length, 1);
  const vital = (extra: any) => ({ id: 'v', name: 'Pulse', value: '70', unit: 'bpm', time: null, ...extra });
  const days = groupByDay({ checkins: [
    checkin(at(5, 9)), // nothing at all
    checkin(at(6, 9), { vitals: [vital({ value: null })] }), // a reading with no value
    checkin(at(7, 9), { vitals: [vital({})] }), // a reading with a value counts
    fixtures[0],
  ] });
  assert.deepEqual([...days.keys()], ['2026-09-04', '2026-09-07']);
});

const vitalOf = (id: string, name: string, value: string | null, extra: any = {}) => ({ id, name, value, unit: null, time: null, ...extra });

test('vitals get their own group, one line per reading such as "Blood pressure: 128/82 mmHg", and only readings with a value', async () => {
  await withRecords(page => {
    assert.equal(page.day(12).classList.contains('has-records'), true); // a day with only vitals still has a dot
    page.open(12);
    assert.deepEqual(page.$$('.records-group-title').map((node: Element) => node.textContent), ['Vitals']);
    assert.deepEqual(page.rows().map((row: Element) => row.querySelector('.records-row-title')!.textContent), ['Blood pressure: 128/82 mmHg', 'Pulse: 71']);
    const [pressure, pulse] = page.rows();
    assert.equal(pulse.querySelector('button'), null); // nothing more to show, so it does not open
    pressure.querySelector('.records-row-head').click();
    assert.deepEqual(page.labels(pressure), ['Time']);
    assert.equal(pressure.querySelector('dd').textContent, '8:20 am');
    assert.equal(pressure.querySelector('.records-quote-text').textContent, 'It was a bit high yesterday.');
    assert.equal(page.$('.records-group-title').closest('section').querySelectorAll('.records-row').length, 2);
    page.$('#recordsDayClose').click();
    page.open(13); // readings without a value are not shown, and do not make a dot
    assert.equal(page.day(13).classList.contains('has-records'), false);
  }, [
    checkin(at(12, 9), {
      vitals: [vitalOf('v1', 'Blood pressure', '128/82', { unit: 'mmHg', time: '8:20 am' }), vitalOf('v2', 'Pulse', '71'), vitalOf('v3', 'Temperature', null)],
      reportedAnswers: [answer('It was a bit high yesterday.', { entityId: 'v1' })],
    }),
    checkin(at(13, 9), { vitals: [vitalOf('v4', 'Blood pressure', null)] }),
  ]);
});

test('with several check-ins on a day, each vital carries its time, in the same place as the other groups', async () => {
  await withRecords(page => {
    page.open(12);
    assert.deepEqual(page.$$('.records-group-title').map((node: Element) => node.textContent), ['Symptoms', 'Vitals']);
    assert.deepEqual(page.rows().map((row: Element) => row.querySelector('.records-time')?.textContent), ['8:00 AM', '6:15 PM']);
  }, [
    checkin(at(12, 8), { symptoms: [symptom('s1', 'Stiffness')] }),
    checkin(at(12, 18, 15), { vitals: [vitalOf('v1', 'Blood pressure', '120/80', { unit: 'mmHg' })] }),
  ]);
});

test('the records are read from the server when the page starts and again each time the tab is opened', async () => {
  let calls = 0;
  let answerWith: any = { source: 'real', name: null, checkins: [] };
  await withRecords(async page => {
    assert.equal(calls, 1);
    assert.equal(page.$$('.records-day.has-records').length, 0);
    assert.equal(page.$('#recordsStatus').hidden, true);
    answerWith = { source: 'real', name: null, checkins: fixtures }; // a check-in saved in the meantime
    page.$('#desktopRecordsNav').click();
    await page.mounted.ready;
    assert.equal(calls, 2);
    assert.equal(page.$$('.records-day.has-records').length, 3);
    page.$('#recordsNav').click(); // the phone's tab does the same
    await page.mounted.ready;
    assert.equal(calls, 3);
  }, [], async () => { calls++; return answerWith; });
});

test('the example person is labelled, and the label goes when the real records are back', async () => {
  let payload: any = { source: 'demo', name: 'Arthur Itis', checkins: fixtures };
  await withRecords(async page => {
    const status = page.$('#recordsStatus');
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, 'Example data · Arthur Itis');
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(page.$$('.records-day.has-records').length, 3);
    payload = { source: 'real', name: null, checkins: [] };
    page.$('#desktopRecordsNav').click();
    await page.mounted.ready;
    assert.equal(status.hidden, true);
    assert.equal(page.$$('.records-day.has-records').length, 0); // the calendar changed without a page reload
  }, [], async () => payload);
});

test('when the records cannot be loaded, the calendar still shows and says so, and the next visit tries again', async () => {
  let fail = true;
  await withRecords(async page => {
    const status = page.$('#recordsStatus');
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /could not be loaded/);
    assert.ok(status.classList.contains('is-error'));
    assert.equal(page.title(), 'September 2026');
    assert.equal(page.$$('.records-day').length, 30);
    fail = false;
    page.$('#desktopRecordsNav').click();
    await page.mounted.ready;
    assert.equal(status.hidden, true);
    assert.equal(page.$$('.records-day.has-records').length, 3);
  }, [], async () => { if (fail) throw new Error('offline'); return { source: 'real', name: null, checkins: fixtures }; });
});

test('an old answer that arrives late cannot replace a newer one', async () => {
  const gates: ((value: any) => void)[] = [];
  let n = 0;
  await withRecords(async page => {
    page.$('#desktopRecordsNav').click(); // second request
    gates[1]!({ source: 'real', name: null, checkins: fixtures }); // the newer answer arrives first
    await page.mounted.ready;
    assert.equal(page.$$('.records-day.has-records').length, 3);
    gates[0]!({ source: 'demo', name: 'Old', checkins: [] }); // then the slow first one
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(page.$$('.records-day.has-records').length, 3);
    assert.equal(page.$('#recordsStatus').hidden, true);
  }, [], () => new Promise(resolve => { gates[n++] = resolve; }), false); // the first answer is held back on purpose
});

test('the default loader asks GET /api/records, and a failing request shows the message', async () => {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const originalFetch = globalThis.fetch;
  const { mountRecords } = await import(recordsUrl);
  const requested: string[] = [];
  let status = 200;
  globalThis.fetch = (async (url: string) => { requested.push(String(url)); return Response.json({ source: 'real', name: null, checkins: fixtures }, { status }); }) as typeof fetch;
  const records = mountRecords(dom.window.document, { apiBase: 'http://api.test', now: NOW });
  try {
    await records.ready;
    assert.deepEqual(requested, ['http://api.test/api/records']);
    assert.equal(dom.window.document.querySelectorAll('.records-day.has-records').length, 3);
    status = 500;
    await records.refresh();
    assert.equal(dom.window.document.getElementById('recordsStatus')!.hidden, false);
  } finally { records.destroy(); globalThis.fetch = originalFetch; dom.window.close(); }
});

// The demo switch reloads the page (every card reads its data again). From Records, the reload comes back to Records.
async function withDemoSwitch(run: (ctx: any) => Promise<void>, { openRecords, remember = true }: { openRecords: boolean; remember?: boolean }) {
  const reloads: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { if (/navigation/i.test(error.message)) reloads.push(error.message); }); // jsdom cannot reload; it reports it
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only', virtualConsole });
  const window = dom.window as any;
  window.structuredClone = structuredClone; window.scrollTo = () => {};
  window.eval(await readText('frontend/profile-store.js'));
  const originalFetch = globalThis.fetch;
  const posted: any[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return Response.json({ on: posted.at(-1).on }); }
    return Response.json({ on: false });
  }) as typeof fetch;
  const { mountVersionB } = await import(uiUrl);
  const { mountRecords } = await import(recordsUrl);
  const { mountDemoToggle } = await import(toggleUrl);
  const document = window.document as Document;
  const app = mountVersionB(document, { conversationEnabled: false, speechFactory: () => ({ available: false, cancel() {}, destroy() {} }), speakerFactory: () => ({ stop() {}, destroy() {} }) });
  const loads: number[] = [];
  const records = mountRecords(document, { load: async () => { loads.push(1); return { source: 'real', name: null, checkins: [] }; }, now: NOW });
  mountDemoToggle(document);
  try {
    if (openRecords) (document.getElementById('desktopRecordsNav') as HTMLElement).click();
    await records.ready;
    await run({ document, window, dom, reloads, posted, loads, flag: () => window.sessionStorage.getItem('tellwell.returnTo') });
  } finally { records.destroy(); app.destroy(); globalThis.fetch = originalFetch; dom.window.close(); }
}
const flip = async (ctx: any) => {
  const box = ctx.document.getElementById('demoSwitch') as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  for (let i = 0; i < 100 && !ctx.reloads.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
};

test('switching the demo on while Records is open reloads the page and leaves a note to come back to Records', async () => {
  await withDemoSwitch(async ctx => {
    assert.equal(ctx.flag(), null);
    await flip(ctx);
    assert.deepEqual(ctx.posted, [{ on: true }]);
    assert.equal(ctx.reloads.length, 1); // the whole page reloads, as the demo switch always did
    assert.equal(ctx.flag(), 'records');
  }, { openRecords: true });
});

test('switching the demo from another tab leaves no note, so the reload lands on Home as before', async () => {
  await withDemoSwitch(async ctx => {
    await flip(ctx);
    assert.equal(ctx.reloads.length, 1);
    assert.equal(ctx.flag(), null);
  }, { openRecords: false });
});

test('a page that starts with the note opens on Records, loads once, and clears the note', async () => {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const window = dom.window as any;
  window.structuredClone = structuredClone; window.scrollTo = () => {};
  window.eval(await readText('frontend/profile-store.js'));
  window.sessionStorage.setItem('tellwell.returnTo', 'records');
  const { mountVersionB } = await import(uiUrl);
  const { mountRecords } = await import(recordsUrl);
  const document = window.document as Document;
  const app = mountVersionB(document, { conversationEnabled: false, speechFactory: () => ({ available: false, cancel() {}, destroy() {} }), speakerFactory: () => ({ stop() {}, destroy() {} }) });
  let loads = 0;
  const records = mountRecords(document, { load: async () => { loads++; return { source: 'demo', name: 'Arthur Itis', checkins: fixtures }; }, now: NOW });
  try {
    await records.ready;
    assert.equal((document.getElementById('recordsView') as HTMLElement).hidden, false);
    assert.equal((document.querySelector('.patient-home') as HTMLElement).hidden, true);
    assert.ok(document.getElementById('desktopRecordsNav')!.classList.contains('active'));
    assert.equal(loads, 1);
    assert.equal(window.sessionStorage.getItem('tellwell.returnTo'), null);
    assert.equal(document.getElementById('recordsStatus')!.textContent, 'Example data · Arthur Itis');
    assert.equal(document.querySelectorAll('.records-day.has-records').length, 3);
  } finally { records.destroy(); app.destroy(); dom.window.close(); }
});

test('the doctor summary moved from Home to Records, below the calendar, and still works', async () => {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const document = dom.window.document;
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as any).window;
  const requested: string[] = [];
  let printed = 0;
  (dom.window as any).print = () => { printed++; };
  (globalThis as any).window = dom.window;
  globalThis.fetch = (async (url: string) => { requested.push(String(url)); return Response.json({ connected: false }); }) as typeof fetch;
  try {
    const { mountVisitSummary } = await import(visitUrl);
    mountVisitSummary(document);
    const button = document.getElementById('visitSummaryButton')!;
    assert.equal(document.querySelector('.patient-home #visitSummaryButton'), null);
    assert.doesNotMatch(document.querySelector('.patient-home')!.textContent!, /Doctor summary|Prepare for your visit/);
    assert.ok(document.getElementById('recordsView')!.contains(button));
    assert.ok(document.querySelector('.records-calendar')!.compareDocumentPosition(button) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the button comes after the calendar');
    assert.equal(button.textContent, 'Download doctor summary');
    const days = document.getElementById('visitDays') as HTMLSelectElement;
    assert.deepEqual([...days.options].map(option => option.value), ['30', '60', '90']);
    assert.equal(days.value, '30');
    const finished = async () => { for (let i = 0; i < 200 && (button as HTMLButtonElement).disabled; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
    button.click();
    assert.equal(button.textContent, 'Preparing…');
    await finished();
    assert.match(requested[0]!, /\/api\/biometrics\?days=30$/);
    assert.equal(printed, 1);
    assert.equal(button.textContent, 'Download doctor summary');
    days.value = '90';
    button.click(); await finished();
    assert.match(requested[1]!, /days=90$/);
    assert.equal(printed, 2);
  } finally {
    globalThis.fetch = originalFetch; (globalThis as any).window = originalWindow; dom.window.close();
  }
});

// The placeholder data and the example in RECORDS-DATA-FORMAT.md must stay valid backend check-ins,
// so a real or fake JSON file in that format can replace them without touching the screen.
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertBackendShape(checkins: any[]) {
  for (const { sessionId, savedAt, ...record } of checkins) {
    assert.match(sessionId, uuid);
    assert.match(savedAt, isoDate);
    recordSchema.parse(record);
  }
}

test('the placeholder data is gone, and main.js no longer refers to it', async () => {
  assert.equal(existsSync(new URL('../../frontend/records-placeholder.js', import.meta.url)), false);
  assert.doesNotMatch(await readText('frontend/main.js'), /placeholder/i);
  assert.match(await readText('frontend/main.js'), /mountRecords\(document\)/);
  assert.doesNotMatch(await readText('frontend/records.js'), /placeholder/i);
});

test('the example person from the backend shows on the calendar, with Vitals and two check-ins on one day', async () => {
  const records = JSON.parse(JSON.stringify(arthritisRecords('2026-09-20')));
  assertBackendShape(records);
  const dayOf = (savedAt: string) => { const d = new Date(savedAt); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const days = [...new Set<string>(records.map((item: any) => dayOf(item.savedAt)))].sort();
  const withReadings = records.filter((item: any) => item.vitals.some((vital: any) => vital.value));
  assert.ok(withReadings.length >= 5, 'the example person has blood pressure readings');
  await withRecords(page => {
    assert.equal(page.$('#recordsStatus').textContent, 'Example data · Arthur Itis');
    const marked = page.$$('.records-day.has-records').map((node: HTMLElement) => node.dataset.date);
    assert.deepEqual(marked.filter((date: string) => date.startsWith('2026-09')), days.filter((date: any) => date.startsWith('2026-09')));
    const newest = records.at(-1);
    page.open(Number(dayOf(newest.savedAt).slice(-2)));
    assert.ok(page.$$('.records-group-title').some((node: Element) => node.textContent === 'Vitals'));
    assert.match(page.$$('.records-row-title').map((node: Element) => node.textContent).join('|'), /Blood pressure: \d+\/\d+ mmHg/);
    const twice = days.find((day: string) => records.filter((item: any) => dayOf(item.savedAt) === day).length > 1);
    if (twice) { page.$('#recordsDayClose').click(); page.open(Number(twice.slice(-2))); assert.ok(page.$$('.records-time').length >= 2); }
  }, [], async () => ({ source: 'demo', name: 'Arthur Itis', checkins: records }));
});

test('the example in RECORDS-DATA-FORMAT.md is a valid list of check-ins', async () => {
  const doc = await readText('RECORDS-DATA-FORMAT.md');
  const example = /```json\n([\s\S]*?)\n```/.exec(doc);
  assert.ok(example, 'the document should contain a JSON example');
  const parsed = JSON.parse(example[1]!);
  assert.ok(parsed.checkins.length >= 1);
  assertBackendShape(parsed.checkins);
  await withRecords(page => {
    assert.equal(page.$$('.records-day.has-records').length, 1);
    page.open(19);
    assert.deepEqual(page.$$('.records-group-title').map((node: Element) => node.textContent), ['Symptoms', 'Medications', 'Meals', 'Vitals', 'In your own words']);
    assert.ok(page.$$('.records-row-title').some((node: Element) => node.textContent === 'Blood pressure: 128/82 mmHg'));
    page.rows()[0].querySelector('.records-row-head').click();
    assert.equal(page.rows()[0].querySelectorAll('.records-quote').length, 1);
  }, parsed.checkins.map((item: any) => ({ ...item, savedAt: at(19, 8, 30) })));
});
