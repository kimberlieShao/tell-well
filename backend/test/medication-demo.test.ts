import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { localDate } from '../src/checkin-log.js';
import { arthritisToday } from '../src/demo-story.js';

// The Home medication card counts the reader's own doses (medications.js). The demo switch replaces that
// card and the medication table with the example person's (demo-toggle.js). While the demo is on, the
// counting code must leave them alone: it redraws whenever the window gains focus, the page is shown
// again, storage changes and at midnight. Demo data only, and no network.
const medsUrl = new URL('../../frontend/medications.js', import.meta.url).href;
const toggleUrl = new URL('../../frontend/demo-toggle.js', import.meta.url).href;
const readText = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ownList = (...names: string[]) => JSON.stringify(names.map(name => ({ name, dose: '5 mg', when: 'Morning' })));
const wait = async (check: () => unknown, message: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), message);
};

async function withHome(run: (page: any) => Promise<void>, { demo }: { demo: boolean }) {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const window = dom.window as any;
  const document = window.document as Document;
  window.localStorage.setItem('pulsewise.medications', ownList('Prednisone'));
  const { mountMedications } = await import(medsUrl);
  const { mountDemoToggle } = await import(toggleUrl);
  const originalFetch = globalThis.fetch;
  const story = arthritisToday(localDate(new Date()));
  globalThis.fetch = (async () => Response.json({ on: demo, name: 'Arthur Itis', story: demo ? story : null })) as typeof fetch;
  const medications = mountMedications(document);
  mountDemoToggle(document);
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const page = {
    window, document, dom, $,
    tile: () => $('medTileValue'),
    snapshot: () => ({ tile: $('medTileValue').textContent, foot: $('medTileFoot').textContent, rows: $('medRows').textContent }),
    setOwnList: (...names: string[]) => window.localStorage.setItem('pulsewise.medications', ownList(...names)),
    // Everything that makes medications.js redraw on its own.
    wake: () => {
      window.dispatchEvent(new window.Event('focus'));
      window.dispatchEvent(new window.Event('pageshow'));
      window.dispatchEvent(new window.StorageEvent('storage', { key: null }));
      window.dispatchEvent(new window.CustomEvent('pulsewise:medications', { detail: { medications: [] } }));
      document.dispatchEvent(new window.Event('visibilitychange'));
    },
  };
  try {
    if (demo) await wait(() => document.body.classList.contains('demo-on'), 'the demo switch never turned on');
    await run(page);
  } finally { medications.destroy(); globalThis.fetch = originalFetch; dom.window.close(); }
}

test('with the demo on, the example medication card and table survive the events that redraw them', async () => {
  await withHome(async page => {
    const shown = page.snapshot();
    assert.doesNotMatch(shown.tile, /Prednisone/); // the reader's own list is not on the card
    assert.match(shown.tile, /missed|On track/);
    assert.match(shown.rows, /Methotrexate/);
    assert.match(shown.rows, /Example/);
    assert.doesNotMatch(shown.rows, /Prednisone/);

    page.wake();
    assert.deepEqual(page.snapshot(), shown);
    page.setOwnList('Prednisone', 'Metformin'); // the reader's list changes in the background
    page.wake();
    assert.deepEqual(page.snapshot(), shown);
  }, { demo: true });
});

test('the example card takes the same large value type as the other tiles, not the small dose-count type', async () => {
  await withHome(async page => {
    assert.ok(!page.tile().classList.contains('med-progress-list'));
    assert.equal(page.tile().getAttribute('aria-label'), null); // "Medication doses recorded today" would be wrong here
    assert.ok(page.tile().classList.contains('patient-metric-value'));
    assert.match(await readText('frontend/home.css'), /body\.demo-on \.med-reset\s*\{\s*display:\s*none/); // nothing of the example's to reset
  }, { demo: true });
});

test('with the demo off, the same events still redraw the card from the reader\'s own list', async () => {
  await withHome(async page => {
    assert.match(page.snapshot().tile, /Prednisone\s*0\/1/);
    assert.ok(page.tile().classList.contains('med-progress-list'));
    page.setOwnList('Prednisone', 'Metformin');
    page.wake();
    assert.match(page.snapshot().tile, /Prednisone/);
    assert.match(page.snapshot().tile, /Metformin/);
    assert.match(page.snapshot().rows, /Metformin/);
    assert.ok(!page.document.body.classList.contains('demo-on'));
  }, { demo: false });
});
