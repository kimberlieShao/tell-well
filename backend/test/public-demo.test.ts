import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/app.js';
import { demoSource, snapshotSource } from '../src/biometrics.js';
import { demoExtractor } from '../src/extractor.js';

// The public deployment: WEARABLE_MODE=snapshot, DEMO_DEFAULT=on, DEMO_LOCKED=1. The demo switch lives in
// this process's memory, so on the public site it is fixed by the environment, not by whoever clicked last.
// Demo extraction only: nothing here calls Gemini.

async function withApi(config: Parameters<typeof createApp>[1], run: (api: { get: (path: string) => Promise<any>; post: (path: string, body: unknown) => Promise<any> }) => Promise<void>) {
  const server = createApp(demoExtractor, config).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => { const res = await fetch(base + path); return { status: res.status, body: await res.json() }; };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try { await run({ get, post }); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('with no environment settings the demo starts off and the switch works, as it does on a laptop', async () => {
  await withApi({}, async ({ get, post }) => {
    const before = (await get('/api/demo')).body;
    assert.equal(before.on, false);
    assert.equal(before.locked, false);
    assert.equal((await post('/api/demo', { on: true })).body.on, true);
    assert.equal((await get('/api/demo')).body.on, true);
    assert.equal((await post('/api/demo', { on: false })).body.on, false);
  });
});

test('DEMO_DEFAULT=on starts with the example person already showing, with no click needed', async () => {
  await withApi({ demo: { on: true } }, async ({ get }) => {
    const state = (await get('/api/demo')).body;
    assert.equal(state.on, true);
    assert.equal(state.locked, false);
    assert.ok(state.story, 'the example week is there');
    const records = (await get('/api/records')).body;
    assert.equal(records.source, 'demo');
    assert.ok(records.checkins.length > 0);
  });
});

test('DEMO_LOCKED=1 keeps the demo on, whoever asks for it off', async () => {
  await withApi({ demo: { on: true, locked: true } }, async ({ get, post }) => {
    const res = await post('/api/demo', { on: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.on, true);
    assert.equal(res.body.locked, true);
    assert.equal((await get('/api/demo')).body.on, true);
    assert.equal((await get('/api/records')).body.source, 'demo');
  });
});

test('a snapshot wearable reports that it is not live; a real band or example nights do not say so', async () => {
  await withApi({ wearable: snapshotSource() }, async ({ get }) => {
    const res = (await get('/api/biometrics?days=7')).body;
    assert.equal(res.connected, true);
    assert.equal(res.source, 'whoop');
    assert.equal(res.live, false);
  });
  await withApi({ wearable: demoSource(() => '2026-09-20') }, async ({ get }) => {
    assert.equal((await get('/api/biometrics?days=7')).body.live, true);
  });
});

test('the live heart rate card explains itself when the wearable is a snapshot, and shows no error', async () => {
  const dom = new JSDOM(await readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const document = dom.window.document;
  const { mountWearable } = await import(new URL('../../frontend/wearable.js', import.meta.url).href);
  const originalFetch = globalThis.fetch;
  const nights = await snapshotSource().fetchDays(38);
  globalThis.fetch = (async () => Response.json({ connected: true, source: 'whoop', live: false, date: nights.at(-1)!.date, readings: {}, days: [] })) as typeof fetch;
  try {
    mountWearable(document);
    const card = document.getElementById('liveCard')!;
    for (let i = 0; i < 200 && !card.classList.contains('no-live-source'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(card.classList.contains('no-live-source'));
    assert.equal(card.querySelector('.wearable-live-note')?.textContent, 'Live heart rate appears when a WHOOP band is connected');
    assert.equal(document.getElementById('livePill')?.textContent, 'Not connected');
  } finally { globalThis.fetch = originalFetch; }
});
