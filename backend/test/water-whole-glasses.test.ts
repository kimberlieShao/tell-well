import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { localDate } from '../src/checkin-log.js';
import { arthritisToday } from '../src/demo-story.js';

// Water is counted in whole glasses. The Meals tab's "Water today" card once showed 2.95135613207547: its slider
// had step "any", so dragging gave a fraction, and nothing rounded it. Now the slider runs 0 to 12 in steps of 1,
// the count is always a whole number in the state as well as on screen, and what is saved is whole glasses too.
// No network and no Gemini: the check-in server is a stub.
const uiUrl = new URL('../../frontend/new-ui.js', import.meta.url).href;
const clientUrl = new URL('../../frontend/checkin-api.js', import.meta.url).href;
const adapterUrl = new URL('../../frontend/version-b-adapter.js', import.meta.url).href;
const recordsUrl = new URL('../../frontend/records.js', import.meta.url).href;
const toggleUrl = new URL('../../frontend/demo-toggle.js', import.meta.url).href;
const readText = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const until = async (check: () => unknown, message = 'the page did not settle') => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), message);
};
const quietDevices = { conversationEnabled: false, speechFactory: () => ({ available: false, cancel() {}, destroy() {} }), speakerFactory: () => ({ stop() {}, destroy() {} }) };

// ---- The card itself, with the demo switch on and off ----
async function withCard(run: (card: any) => Promise<void>, { demo }: { demo: boolean }) {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const window = dom.window as any;
  window.structuredClone = structuredClone; window.scrollTo = () => {};
  const { mountVersionB } = await import(uiUrl);
  const { mountDemoToggle } = await import(toggleUrl);
  const document = window.document as Document;
  const originalFetch = globalThis.fetch;
  const story = arthritisToday(localDate(new Date()));
  globalThis.fetch = (async () => Response.json({ on: demo, name: 'Arthur Itis', story: demo ? story : null })) as typeof fetch;
  const app = mountVersionB(document, quietDevices);
  mountDemoToggle(document);
  if (demo) await until(() => document.body.classList.contains('demo-on'), 'the demo switch never turned on');
  (document.getElementById('desktopMealsNav') as HTMLElement).click();
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  const slider = document.getElementById('waterSlider') as HTMLInputElement;
  const card = {
    app, window, document, slider,
    count: () => document.getElementById('waterCountValue')!.textContent!,
    unit: () => $('#mealsView .water-unit').textContent,
    minus: () => $('[data-action="water-minus"]') as HTMLButtonElement,
    plus: () => $('[data-action="water-plus"]') as HTMLButtonElement,
    drops: () => [...document.querySelectorAll('.water-drop')] as Element[],
    /** What a browser hands the page while the slider is dragged with step "any": a raw fraction. */
    drag: (raw: string) => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!;
      Object.defineProperty(slider, 'value', { configurable: true, get: () => raw, set: (v: string) => proto.set!.call(slider, v) });
      slider.dispatchEvent(new window.Event('input', { bubbles: true }));
      delete (slider as any).value;
    },
    whole: () => Number.isInteger(app.mealState.waterGlasses) && /^\d+$/.test(document.getElementById('waterCountValue')!.textContent!),
  };
  try { await run(card); } finally { app.destroy(); globalThis.fetch = originalFetch; dom.window.close(); }
}

for (const demo of [false, true]) {
  const mode = demo ? 'demo on' : 'demo off';

  test(`the slider runs 0 to 12 in steps of 1, before and after every change (${mode})`, async () => {
    await withCard(async card => {
      const shape = () => [card.slider.min, card.slider.max, card.slider.step];
      assert.deepEqual(shape(), ['0', '12', '1']);
      card.plus().click(); card.drag('5.5'); card.minus().click();
      assert.deepEqual(shape(), ['0', '12', '1']); // never "any", and the range does not grow
      assert.match(await readText('index.html'), /id="waterSlider"[^>]*min="0" max="12"[^>]*step="1"/);
    }, { demo });
  });

  test(`dragging to a fraction such as 2.95135613207547 gives a whole number, on screen and in the state (${mode})`, async () => {
    await withCard(async card => {
      const cases: [string, number][] = [['2.95135613207547', 3], ['7.0000001', 7], ['0.4', 0], ['0.5', 1], ['11.6', 12], ['12', 12], ['-0.3', 0], ['not a number', 0]];
      for (const [raw, expected] of cases) {
        card.drag(raw);
        assert.equal(card.app.mealState.waterGlasses, expected, raw);
        assert.equal(card.count(), String(expected), raw);
        assert.ok(card.whole(), raw);
        assert.equal(card.slider.value, String(expected), raw);
      }
      // A drag can never go past the slider's own 12, even if the browser were to report more.
      card.drag('40.2');
      assert.equal(card.app.mealState.waterGlasses, 12);
    }, { demo });
  });

  test(`− and + move by exactly one glass, and stop at 0 and 12 (${mode})`, async () => {
    await withCard(async card => {
      assert.equal(card.count(), '0');
      assert.equal(card.minus().disabled, true);
      card.minus().click(); // does nothing at 0
      assert.equal(card.count(), '0');
      for (let glasses = 1; glasses <= 12; glasses++) {
        card.plus().click();
        assert.equal(card.count(), String(glasses));
        assert.equal(card.app.mealState.waterGlasses, glasses);
        assert.equal(card.slider.value, String(glasses));
        assert.equal(card.drops().length, 12);
        assert.equal(card.drops().filter((drop: Element) => drop.classList.contains('filled')).length, glasses); // one drop per glass
      }
      assert.equal(card.plus().disabled, true);
      card.plus().click(); // does nothing at 12
      assert.equal(card.count(), '12');
      for (let glasses = 11; glasses >= 0; glasses--) {
        card.minus().click();
        assert.equal(card.count(), String(glasses));
        assert.equal(card.drops().filter((drop: Element) => drop.classList.contains('filled')).length, glasses);
      }
      assert.equal(card.minus().disabled, false || card.count() === '0');
      assert.equal(card.plus().disabled, false);
    }, { demo });
  });

  test(`a fraction from a drag is rounded before + and − step from it, so the count never turns fractional (${mode})`, async () => {
    await withCard(async card => {
      card.drag('2.95135613207547');
      card.plus().click();
      assert.equal(card.count(), '4');
      card.drag('6.4');
      card.minus().click();
      assert.equal(card.count(), '5');
    }, { demo });
  });

  test(`through any mix of drags and taps the count stays a whole number from 0 to 12 (${mode})`, async () => {
    await withCard(async card => {
      let seed = 7;
      const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
      for (let i = 0; i < 300; i++) {
        const roll = next();
        if (roll < 0.35) card.plus().click();
        else if (roll < 0.7) card.minus().click();
        else card.drag((next() * 14).toString());
        assert.ok(card.whole(), `step ${i}: ${card.count()}`);
        assert.ok(card.app.mealState.waterGlasses >= 0 && card.app.mealState.waterGlasses <= 12);
        assert.doesNotMatch(card.count(), /[.,e]/);
      }
    }, { demo });
  });

  test(`the unit reads "glass" for one and "glasses" otherwise (${mode})`, async () => {
    await withCard(async card => {
      assert.equal(card.unit(), 'glasses');
      card.plus().click(); assert.equal(card.unit(), 'glass');
      card.plus().click(); assert.equal(card.unit(), 'glasses');
    }, { demo });
  });
}

// ---- Data coming in from a check-in, and going out on save ----
const diet = (id: string, description: string, time: string | null = null, waterGlasses: number | null = null, waterMode: string | null = null) => ({ id, description, time, waterGlasses, waterMode });
const base = (extra: any = {}) => ({ schemaVersion: '1.0', sessionId: 'session', version: 1, status: 'review', extractionMode: 'gemini', symptoms: [], medications: [], diet: [], vitals: [], wellness: null, reportedAnswers: [], nextQuestion: null, missingFields: [], skippedFields: [], needsClarification: false, notices: [], storage: 'memory', expiresAt: '2030-01-01T00:00:00.000Z', savedAt: null, ...extra });

async function withCheckin(starts: any[], run: (page: any) => Promise<void>) {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  (dom.window as any).scrollTo = () => {};
  const [{ mountVersionB }, { createCheckinClient }] = await Promise.all([import(uiUrl), import(clientUrl)]);
  const requests: { path: string; body: any }[] = [];
  let state: any;
  const client = createCheckinClient({ flow: 'brief', painScale: '1-10', fetchImpl: async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ path, body });
    if (path.endsWith('/save')) state = { ...state, ...(body.record || {}), status: 'saved', version: state.version + 1, nextQuestion: null, savedAt: new Date().toISOString() };
    else if (!body.sessionId) state = structuredClone(starts.shift());
    return Response.json(state);
  } });
  // The same typing-only speech stand-in the other check-in UI tests use.
  const speechFactory = ({ textarea, onTurn }: any) => {
    let active = false;
    return { available: true, mode: 'form', get isActive() { return active; }, async start() { active = true; }, async finish() { active = false; return textarea.value; }, cancel() { active = false; }, destroy() { active = false; }, async turn(text: string) { textarea.value = text; active = false; await onTurn?.(text); }, onTurn };
  };
  const app = mountVersionB(dom.window.document, { client, mealClient: client, conversationEnabled: false, speechFactory, speakerFactory: () => ({ async prime() {}, async speak() {}, stop() {}, destroy() {} }) });
  const document = dom.window.document;
  const page = {
    app, document, requests, dom,
    saves: () => requests.filter(request => request.path.endsWith('/save')),
    click: (selector: string) => { const node = document.querySelector<HTMLElement>(selector); assert.ok(node, selector); node.click(); },
    fill: (selector: string, value: string) => { const node = document.querySelector<HTMLInputElement>(selector); assert.ok(node, selector); node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); },
  };
  try { await run(page); } finally { app.destroy(); dom.window.close(); }
}

test('a daily check-in with 2.95135613207547 glasses of water is shown and saved as 3', async () => {
  await withCheckin([base({ sessionId: 'fraction', diet: [diet('w', 'water', null, 2.95135613207547, 'total')] })], async page => {
    page.app.open(); page.click('#flowType'); page.fill('#flowTranscript', 'I drank water'); page.click('.flow-done');
    await until(() => page.app.client.state?.status === 'saved', 'the check-in was never saved');
    assert.equal(page.saves().length, 1);
    assert.deepEqual(page.saves()[0].body.record.diet.map((entry: any) => entry.waterGlasses), [3]); // what is saved is whole
    assert.equal(page.app.mealState.waterGlasses, 3);
    assert.equal(page.document.getElementById('waterCountValue')!.textContent, '3');
    assert.equal(page.app.client.state.diet[0].waterGlasses, 3);
  });
});

test('"1.5 glasses more" adds two whole glasses, and a fraction below a half counts as none', async () => {
  await withCheckin([base({ sessionId: 'a', diet: [diet('w1', 'water', null, 1.5, 'add')] }), base({ sessionId: 'b', diet: [diet('w2', 'water', null, 0.4, 'total')] })], async page => {
    page.app.open(); page.click('#flowType'); page.fill('#flowTranscript', 'a'); page.click('.flow-done');
    await until(() => page.saves().length === 1);
    assert.deepEqual(page.saves()[0].body.record.diet.map((entry: any) => entry.waterGlasses), [2]);
    assert.equal(page.app.mealState.waterGlasses, 2);
    page.click('#flowClose');
    page.app.open(); page.click('#flowType'); page.fill('#flowTranscript', 'b'); page.click('.flow-done');
    await until(() => page.saves().length === 2);
    assert.deepEqual(page.saves()[1].body.record.diet.map((entry: any) => entry.waterGlasses), [0]);
    assert.equal(page.app.mealState.waterGlasses, 0);
    assert.equal(Number.isInteger(page.app.mealState.waterGlasses), true);
  });
});

test('logging a meal by voice saves a record with whole glasses, and the card shows a whole number', async () => {
  await withCheckin([base({ sessionId: 'voice', diet: [diet('toast', 'toast', 'breakfast'), diet('w', 'water', null, 3.7, 'total')] })], async page => {
    page.click('#desktopMealsNav'); page.click('#mealsVoiceCTA');
    page.fill('#mealsVoiceTranscript', 'Toast for breakfast and about three and a half glasses of water');
    page.click('[data-action="analyze-voice-entry"]');
    await until(() => page.saves().length === 1, 'the meal was never saved');
    const record = page.saves()[0].body.record;
    assert.ok(record, 'the save carries the record, so the saved water is whole');
    assert.deepEqual(record.diet.map((entry: any) => entry.waterGlasses), [null, 4]);
    await until(() => page.app.mealState.waterGlasses === 4);
    assert.equal(page.document.getElementById('waterCountValue')!.textContent, '4');
  });
});

test('a count above 12 that the person reported is kept; only the slider and + stop at 12', async () => {
  await withCheckin([base({ sessionId: 'lots', diet: [diet('w', '14 glasses today', null, 13.6, 'total')] })], async page => {
    page.app.open(); page.click('#flowType'); page.fill('#flowTranscript', 'lots'); page.click('.flow-done');
    await until(() => page.saves().length === 1);
    assert.equal(page.app.mealState.waterGlasses, 14);
    page.click('#desktopMealsNav');
    const value = () => page.document.getElementById('waterCountValue')!.textContent;
    assert.equal(value(), '14');
    assert.equal(page.document.getElementById('waterSlider').value, '12');
    assert.equal(page.document.getElementById('waterSlider').max, '12');
    assert.equal(page.document.querySelectorAll('.water-drop.filled').length, 12);
    assert.equal((page.document.querySelector('[data-action="water-plus"]') as HTMLButtonElement).disabled, true);
    page.click('[data-action="water-minus"]'); assert.equal(value(), '13'); // one glass at a time
    page.click('[data-action="water-minus"]'); assert.equal(value(), '12');
  });
});

test('the adapter turns glasses into whole numbers on the way in, on the way out, and for the card', async () => {
  const { wholeGlasses, normalizeBackendResponse, toBackendRecord, mealsFromBackend } = await import(adapterUrl);
  const table: [unknown, number | null][] = [[null, null], [undefined, null], ['', null], [0, 0], [2, 2], ['4', 4], [2.95135613207547, 3], [0.4, 0], [0.5, 1], [1.5, 2], [13.5, 14], [-2, 0], ['abc', null], [Infinity, null]];
  for (const [input, expected] of table) assert.equal(wholeGlasses(input), expected, String(input));
  const response = base({ diet: [diet('a', 'water', null, 1.5, 'add'), diet('b', 'toast', 'breakfast')] });
  const state = normalizeBackendResponse(response);
  assert.deepEqual(state.diet.map((entry: any) => entry.waterGlasses), [2, null]);
  assert.deepEqual(state.backendRecord.diet.map((entry: any) => entry.waterGlasses), [2, null]);
  state.diet[0].waterGlasses = 5.4; // edited in the review card
  assert.deepEqual(toBackendRecord(state).diet.map((entry: any) => entry.waterGlasses), [5, null]);
  assert.deepEqual(mealsFromBackend(response).hydration.map((entry: any) => entry.glasses), [2]);
});

// ---- Everywhere else the number appears ----
test('the Records dialog shows glasses as whole numbers, whatever was stored', async () => {
  const { buildDay } = await import(recordsUrl);
  const at = new Date(2026, 8, 19, 9, 0).toISOString();
  const waterOf = (glasses: number | null, mode: string | null = 'total') => buildDay([{ savedAt: at, diet: [{ id: 'w', description: 'Water', time: null, waterGlasses: glasses, waterMode: mode }] }]).groups[0].rows[0].fields.find((field: any) => field.label === 'Water')?.value;
  assert.equal(waterOf(2.95135613207547), '3 glasses in total today');
  assert.equal(waterOf(1.4, 'add'), '1 glass');
  assert.equal(waterOf(0.2, 'add'), '0 glasses');
  assert.equal(waterOf(12), '12 glasses in total today');
  assert.equal(waterOf(null), undefined);
});

for (const demo of [true, false]) {
  test(`Trends' recent check-ins list whole glasses (${demo ? 'demo on' : 'demo off: the list is left to the app'})`, async () => {
    const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
    const document = dom.window.document;
    const { mountDemoToggle } = await import(toggleUrl);
    const originalFetch = globalThis.fetch;
    const story = arthritisToday(localDate(new Date()));
    story.checkins[0]!.diet = [{ description: 'Water', time: null, waterGlasses: 4.6 }]; // the newest
    story.checkins[1]!.diet = [{ description: 'Water', time: null, waterGlasses: 1.2 }];
    story.checkins[2]!.diet = [{ description: 'Water', time: null, waterGlasses: 2.95135613207547 }];
    globalThis.fetch = (async () => Response.json({ on: demo, name: 'Arthur Itis', story: demo ? story : null })) as typeof fetch;
    try {
      mountDemoToggle(document);
      if (!demo) { assert.equal(document.body.classList.contains('demo-on'), false); return; }
      await until(() => document.body.classList.contains('demo-on'));
      const lines = [...document.querySelectorAll('.checkin-history-copy')].slice(0, 3).map(node => node.textContent!);
      assert.match(lines[0]!, /5 glasses of water/);
      assert.match(lines[1]!, /1 glass of water/);
      assert.match(lines[2]!, /3 glasses of water/);
      assert.ok(lines.every(line => !/\d\.\d+ glass/.test(line)), lines.join(' | '));
    } finally { globalThis.fetch = originalFetch; dom.window.close(); }
  });
}
