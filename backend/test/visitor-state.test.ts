import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { demoExtractor } from '../src/extractor.js';
import { readCookie, Visitors } from '../src/visitors.js';

// The public deployment (VISITOR_STATE=cookie): each browser has its own demo switch and its own saved
// check-ins, so one judge turning the demo off changes nothing on another judge's screen.
// Demo extraction only: nothing here calls Gemini.

const knees = 'My knees hurt more today and I forgot my prednisone this morning.';

type Browser = { get: (path: string) => Promise<any>; post: (path: string, body: unknown) => Promise<any>; jar: Map<string, string> };

/** A server plus a way to open browsers, each holding its own cookies. */
async function withServer(config: Parameters<typeof createApp>[1], run: (open: (jar?: Map<string, string>, headers?: Record<string, string>) => Browser) => Promise<void>) {
  const app = createApp(demoExtractor, config);
  app.set('trust proxy', 1);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = (jar = new Map<string, string>(), extra: Record<string, string> = {}): Browser => {
    const send = async (path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie();
      for (const line of set) { const [pair] = line.split(';'); const at = pair!.indexOf('='); jar.set(pair!.slice(0, at), pair!.slice(at + 1)); }
      return { status: res.status, set, body: await res.json() };
    };
    return { get: path => send(path), post: (path, body) => send(path, body), jar };
  };
  try { await run(open); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function saveCheckin(browser: Browser) {
  let state = (await browser.post('/api/analyze', { transcript: knees })).body;
  if (state.nextQuestion) state = (await browser.post('/api/analyze', { sessionId: state.sessionId, version: state.version, questionId: state.nextQuestion.id, transcript: 'Moderate' })).body;
  const saved = await browser.post('/api/checkin/save', { sessionId: state.sessionId, version: state.version, confirmed: true });
  assert.equal(saved.status, 200);
}

const cfg = () => ({ demo: { on: true }, visitors: new Visitors() });

test('every visitor starts with the demo on, and turning it off changes nothing for anyone else', async () => {
  await withServer(cfg(), async open => {
    const a = open(), b = open();
    assert.equal((await a.get('/api/demo')).body.on, true);
    assert.equal((await b.get('/api/demo')).body.on, true);
    const off = (await a.post('/api/demo', { on: false })).body;
    assert.equal(off.on, false);
    assert.equal(off.locked, false, 'nothing is locked on the public site');
    assert.equal(off.story, null);
    assert.equal((await a.get('/api/demo')).body.on, false);
    assert.equal((await b.get('/api/demo')).body.on, true, 'the other visitor still sees the demo');
    assert.equal((await b.get('/api/records')).body.source, 'demo');
    assert.equal((await a.post('/api/demo', { on: true })).body.on, true);
  });
});

test('with the demo off, Records is this visitor\'s own empty list, not an error', async () => {
  await withServer(cfg(), async open => {
    const a = open();
    await a.post('/api/demo', { on: false });
    const records = await a.get('/api/records');
    assert.equal(records.status, 200);
    assert.deepEqual(records.body, { source: 'real', name: null, checkins: [], quietDays: [] });
    assert.equal((await a.get('/api/nudges')).status, 200);
    assert.equal((await a.get('/api/biometrics')).status, 200);
  });
});

test('saved check-ins belong to the visitor who saved them', async () => {
  await withServer(cfg(), async open => {
    const a = open(), b = open();
    await a.post('/api/demo', { on: false });
    await b.post('/api/demo', { on: false });
    await saveCheckin(a);
    assert.equal((await a.get('/api/records')).body.checkins.length, 1);
    assert.equal((await b.get('/api/records')).body.checkins.length, 0, 'the other visitor sees none of it');
    await saveCheckin(b);
    await saveCheckin(b);
    assert.equal((await a.get('/api/records')).body.checkins.length, 1);
    assert.equal((await b.get('/api/records')).body.checkins.length, 2);
    // turning the demo on shows the example person, and off again brings the visitor's own back
    await a.post('/api/demo', { on: true });
    assert.equal((await a.get('/api/records')).body.source, 'demo');
    await a.post('/api/demo', { on: false });
    assert.equal((await a.get('/api/records')).body.checkins.length, 1);
  });
});

test('a red-flag alert shows on the home page of the visitor who said it, and no one else\'s', async () => {
  await withServer(cfg(), async open => {
    const a = open(), b = open();
    await a.post('/api/demo', { on: false });
    await b.post('/api/demo', { on: false });
    await a.post('/api/analyze', { transcript: 'I have crushing chest pain and cannot breathe' });
    assert.notEqual((await a.get('/api/nudges')).body.alert, null);
    assert.equal((await b.get('/api/nudges')).body.alert, null);
  });
});

test('the switch lives in the visitor\'s cookie, so a restart keeps it', async () => {
  const jar = new Map<string, string>();
  await withServer(cfg(), async open => {
    const a = open(jar);
    await a.post('/api/demo', { on: false });
    assert.equal(jar.get('tw_demo'), 'off');
  });
  await withServer(cfg(), async open => { // a fresh server that has never heard of this visitor
    assert.equal((await open(jar).get('/api/demo')).body.on, false);
    assert.equal((await open().get('/api/demo')).body.on, true, 'while a new browser gets the default');
  });
});

test('the visitor cookie is private, and secure behind the platform\'s https proxy; a made-up one is replaced', async () => {
  await withServer(cfg(), async open => {
    const plain = await open().get('/api/demo');
    const line = plain.set.find((c: string) => c.startsWith('tw_visitor='))!;
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Lax/);
    assert.doesNotMatch(line, /Secure/, 'a laptop over http cannot use a Secure cookie');
    const proxied = await open(new Map(), { 'X-Forwarded-Proto': 'https' }).get('/api/demo');
    assert.match(proxied.set.find((c: string) => c.startsWith('tw_visitor='))!, /Secure/);
    const forged = open(new Map([['tw_visitor', 'not-a-visitor-id']]));
    await forged.get('/api/demo');
    assert.match(forged.jar.get('tw_visitor')!, /^[0-9a-f-]{36}$/);
    assert.equal(readCookie('a=1; tw_visitor=abc; b=2', 'tw_visitor'), 'abc');
  });
});

test('DEMO_LOCKED still fixes the switch, per visitor or not', async () => {
  await withServer({ demo: { on: true, locked: true }, visitors: new Visitors() }, async open => {
    const a = open();
    assert.equal((await a.post('/api/demo', { on: false })).body.on, true);
    assert.equal((await a.get('/api/demo')).body.on, true);
  });
});

test('too many visitors, or one idle for hours, are forgotten so memory stays bounded', () => {
  let now = 0;
  const visitors = new Visitors({ maxVisitors: 2, idleMs: 1000, now: () => now });
  const first = visitors.get('a').log;
  visitors.get('b'); visitors.get('c');
  assert.equal(visitors.size, 2);
  assert.notEqual(visitors.get('a').log, first, 'the least recently used was dropped, and starts fresh');
  const kept = visitors.get('a').log;
  now = 500; assert.equal(visitors.get('a').log, kept, 'using a visitor keeps it');
  now = 2000; visitors.get('z');
  assert.equal(visitors.size, 1, 'everyone idle past the limit is gone');
});
