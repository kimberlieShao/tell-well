import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/app.js';
import { demoExtractor } from '../src/extractor.js';
import { Visitors } from '../src/visitors.js';

// The first-visit tip under the Demo person switch. Public site only: the server says hint: true there.
// Shown while the demo is off, until the person closes it; then this browser never shows it again.

const toggleUrl = new URL('../../frontend/demo-toggle.js', import.meta.url).href;
const TEXT = 'New here? Turn on Demo person to explore 30 days of example data from Arthur, a patient with rheumatoid arthritis.';
const wait = async (check: () => unknown, message: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), message);
};

async function withPage(state: object, run: (page: { document: Document; window: any; hint: () => HTMLElement | null }) => Promise<void>, seed?: (window: any) => void) {
  const dom = new JSDOM(await readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const window = dom.window as any;
  seed?.(window);
  const { mountDemoToggle } = await import(toggleUrl);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ name: 'Arthur Itis', locked: false, story: null, ...state })) as typeof fetch;
  try {
    mountDemoToggle(window.document);
    await new Promise(resolve => setTimeout(resolve, 60));
    await run({ document: window.document, window, hint: () => window.document.getElementById('demoHint') });
  } finally { globalThis.fetch = originalFetch; window.close(); }
}

test('the public site shows the tip while the demo is off: a live region, in the flow after the top bar', async () => {
  await withPage({ on: false, hint: true }, async ({ document, hint }) => {
    await wait(() => hint()?.textContent?.includes('New here?'), 'the tip appears');
    assert.equal(hint()!.getAttribute('role'), 'status');
    assert.equal(hint()!.querySelector('.demo-hint-text')!.textContent, TEXT);
    assert.equal(document.querySelector('.topbar')!.nextElementSibling, hint(), 'it follows the top bar, so it pushes content down rather than covering it');
    assert.equal(hint()!.querySelector('button')!.getAttribute('aria-label'), 'Dismiss this tip');
  });
});

test('no tip while the demo is on', async () => {
  await withPage({ on: true, hint: true, story: null }, async ({ hint }) => {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(hint(), null);
  });
});

test('no tip on a laptop, where the server sends no hint', async () => {
  await withPage({ on: false }, async ({ hint }) => {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(hint(), null);
  });
});

test('closing the tip removes it, and this browser does not show it again', async () => {
  let saved: string | null = null;
  await withPage({ on: false, hint: true }, async ({ window, hint }) => {
    await wait(() => hint()?.querySelector('button'), 'the tip appears');
    hint()!.querySelector('button')!.click();
    assert.equal(hint(), null);
    saved = window.localStorage.getItem('tellwell.demo-hint.dismissed');
    assert.equal(saved, '1');
  });
  await withPage({ on: false, hint: true }, async ({ hint }) => {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(hint(), null, 'already dismissed in this browser');
  }, window => window.localStorage.setItem('tellwell.demo-hint.dismissed', '1'));
});

test('if the browser will not store anything, the tip still shows and closes without an error', async () => {
  await withPage({ on: false, hint: true }, async ({ window, hint }) => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
    await wait(() => hint()?.querySelector('button'), 'the tip appears');
    hint()!.querySelector('button')!.click();
    assert.equal(hint(), null);
  });
});

test('the server sends hint: true only for the per-visitor public deployment', async () => {
  for (const [visitors, expected] of [[new Visitors(), true], [undefined, false]] as const) {
    const server = createApp(demoExtractor, { visitors }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/demo`)).json() as { hint: boolean };
      assert.equal(body.hint, expected);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
