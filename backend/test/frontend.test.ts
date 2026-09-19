import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/app.js';
import { demoExtractor, type Extractor } from '../src/extractor.js';
import { emptyRecord } from '../src/schema.js';

// Exercise the browser modules without running legacy inline code or using a
// real microphone. All network requests use a temporary local demo server.
const controllerUrl = new URL('../../frontend/checkin-controller.js', import.meta.url).href;
const clientUrl = new URL('../../frontend/checkin-api.js', import.meta.url).href;
const speechUrl = new URL('../../frontend/speech.js', import.meta.url).href;
const htmlUrl = new URL('../../index.html', import.meta.url);
const initial = 'My knees hurt more today and I forgot my prednisone this morning.';

async function until(check: () => unknown, message: string) {
  const expires = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > expires) assert.fail(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  onstart: (() => void) | null = null;
  onresult: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  finalOnStop = 'It was prednisone';
  stopCount = 0;
  abortCount = 0;
  lang = '';
  continuous = false;
  interimResults = false;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.onstart?.(); }
  emit(text: string, isFinal = false) {
    const result = Object.assign([{ transcript: text }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
  stop() {
    this.stopCount++;
    queueMicrotask(() => { this.emit(this.finalOnStop, true); this.onend?.(); });
  }
  abort() { this.abortCount++; queueMicrotask(() => this.onend?.()); }
}

type Page = {
  document: Document;
  dom: JSDOM;
  client: any;
  mounted: any;
  requests: { path: string; body: any }[];
  gate: Promise<void> | null;
  failNext: boolean;
};

function input(page: Page, selector: string, value: string) {
  const field = page.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  assert.ok(field, `Expected input ${selector}`);
  field.value = value;
  field.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
}

function click(page: Page, selector: string) {
  const button = page.document.querySelector<HTMLElement>(selector);
  assert.ok(button, `Expected control ${selector}`);
  button.click();
}

function buttonText(page: Page, text: string) {
  const button = [...page.document.querySelectorAll<HTMLButtonElement>('#checkinFlow button')]
    .find(candidate => candidate.textContent?.trim() === text);
  assert.ok(button, `Expected button ${text}`);
  button.click();
}

async function withPage(run: (page: Page) => Promise<void>, extractor: Extractor = demoExtractor) {
  const server = createApp(extractor).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dom = new JSDOM(await readFile(htmlUrl, 'utf8'), { url: `${baseUrl}/app`, runScripts: 'outside-only' });
  const [{ createCheckinClient }, { mountCheckin }] = await Promise.all([import(clientUrl), import(controllerUrl)]);
  const page: Page = { document: dom.window.document, dom, client: null, mounted: null, requests: [], gate: null, failNext: false };
  const fetchImpl = async (url: string, init: RequestInit) => {
    page.requests.push({ path: new URL(url, baseUrl).pathname, body: JSON.parse(String(init.body)) });
    if (page.gate) await page.gate;
    if (page.failNext) {
      page.failNext = false;
      return new Response(JSON.stringify({ error: { code: 'INVALID_ANSWER', message: 'Please give a clear answer.', details: [] } }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, init);
  };
  page.client = createCheckinClient({ baseUrl, fetchImpl });
  page.mounted = mountCheckin(page.document, { client: page.client, Recognition: FakeRecognition });
  try { await run(page); }
  finally {
    page.mounted?.destroy();
    dom.window.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function start(page: Page, transcript = initial) {
  click(page, '#dailyCheckinButton');
  input(page, '#pw-transcript', transcript);
  click(page, '#pw-analyze');
  await until(() => page.client.state && !page.client.busy, 'initial analysis');
  await until(() => page.document.querySelector('#pw-answer') || page.document.querySelector('#pw-save'), 'analysis rendered');
}

test('frontend uses real API for typed numeric answer, corrected review, and confirmed save', async () => {
  await withPage(async page => {
    await start(page);
    input(page, '#pw-answer', '7');
    click(page, '#pw-send');
    await until(() => page.client.state?.symptoms[0]?.severityScore === 7 && !page.client.busy, 'numeric severity accepted');
    input(page, '#pw-answer', 'Making activities harder');
    click(page, '#pw-send');
    await until(() => page.client.state?.status === 'review' && page.document.querySelector('[data-record-field="severityScore"]'), 'review rendered');
    input(page, '[data-record-field="severityScore"]', '4');
    click(page, '#pw-save');
    await until(() => page.client.state?.status === 'saved', 'record saved');
    assert.equal(page.client.state.symptoms[0].severityScore, 4);
    const save = page.requests.find(request => request.path === '/api/checkin/save');
    assert.equal(save?.body.confirmed, true);
    assert.equal(typeof save?.body.record.symptoms[0].severityScore, 'number');
    assert.equal(save?.body.record.symptoms[0].severityScore, 4);
    assert.ok(page.client.state.savedAt);
  });
});

test('spoken follow-up waits for final speech and sends transcript with question ID; options send answer.value', async () => {
  await withPage(async page => {
    await start(page, 'I forgot the white pill this morning.');
    const questionId = page.client.state.nextQuestion.id;
    assert.equal(page.client.state.medications[0].name, null);
    assert.deepEqual(page.client.state.nextQuestion.options, []);
    click(page, '#pw-voice');
    const recognition = FakeRecognition.instances.at(-1)!;
    recognition.emit('It was pre', false);
    click(page, '#pw-send');
    await until(() => page.client.state?.medications[0]?.name === 'Prednisone', 'spoken medication clarification');
    assert.equal(recognition.stopCount, 1);
    const answer = page.requests.at(-1)!.body;
    assert.equal(answer.transcript, 'It was prednisone');
    assert.equal(answer.questionId, questionId);
    assert.equal(answer.answer, undefined);
  });
  await withPage(async page => {
    await start(page);
    buttonText(page, 'Moderate');
    await until(() => page.client.state?.symptoms[0]?.severity === 'moderate', 'choice answer');
    const answer = page.requests.at(-1)!.body;
    assert.equal(answer.answer.value, 'Moderate');
    assert.equal(answer.transcript, undefined);
    assert.ok(answer.answer.questionId);
  });
});

test('close and backdrop cancel follow-up microphone recording', async () => {
  for (const action of ['close', 'backdrop']) {
    await withPage(async page => {
      await start(page);
      click(page, '#pw-voice');
      const recognition = FakeRecognition.instances.at(-1)!;
      if (action === 'close') click(page, '#flowClose');
      else click(page, '#checkinFlow');
      await until(() => recognition.abortCount > 0, `${action} cancels recognition`);
      assert.equal(page.requests.length, 1, 'cancelling must not submit speech');
    });
  }
});

test('unknown medication stays unknown until review removes it from the saved record', async () => {
  await withPage(async page => {
    await start(page, 'My knees hurt more today and I forgot the white pill.');
    const unknownId = page.client.state.medications[0].id;
    assert.equal(page.client.state.medications[0].name, null);
    assert.equal(page.client.state.medications[0].dose, null);
    assert.deepEqual(page.client.state.nextQuestion.options, []);
    click(page, '#pw-skip');
    await until(() => page.client.state.nextQuestion?.category === 'symptoms' && !page.client.busy, 'unknown medication skipped');
    assert.equal(page.client.state.medications[0].name, null);
    click(page, '#pw-review');
    await until(() => page.client.state.status === 'review' && page.document.querySelector(`[data-remove-id="${unknownId}"]`), 'review permits removal');
    click(page, `[data-remove-id="${unknownId}"]`);
    click(page, '#pw-save');
    await until(() => page.client.state.status === 'saved', 'edited partial record saved');
    assert.deepEqual(page.client.state.medications, []);
    assert.equal(page.client.state.symptoms.length, 1);
    assert.deepEqual(page.requests.at(-1)!.body.record.medications, []);
  });
});

test('duplicate clicks make one request and an invalid answer preserves current session and input', async () => {
  await withPage(async page => {
    let release!: () => void;
    page.gate = new Promise<void>(resolve => { release = resolve; });
    click(page, '#dailyCheckinButton');
    input(page, '#pw-transcript', initial);
    click(page, '#pw-analyze');
    click(page, '#pw-analyze');
    await until(() => page.requests.length === 1, 'first request starts');
    assert.equal(page.requests.length, 1);
    release(); page.gate = null;
    await until(() => page.client.state && !page.client.busy, 'initial request completes');
    const version = page.client.state.version;
    const sessionId = page.client.state.sessionId;
    page.failNext = true;
    input(page, '#pw-answer', 'some unclear answer');
    click(page, '#pw-send');
    await until(() => page.requests.length === 2 && !page.client.busy, 'invalid response completes');
    assert.equal(page.client.state.version, version);
    assert.equal(page.client.state.sessionId, sessionId);
    assert.equal((page.document.querySelector('#pw-answer') as HTMLTextAreaElement).value, 'some unclear answer');
    assert.match(page.document.querySelector('#checkinFlow')!.textContent!, /Please give a clear answer/);
  });
});

test('closing and reopening preserves an unsent modal draft over stale dashboard text', async () => {
  await withPage(async page => {
    input(page, '#transcript', 'Old dashboard words');
    click(page, '#dailyCheckinButton');
    assert.equal((page.document.querySelector('#pw-transcript') as HTMLTextAreaElement).value, 'Old dashboard words');
    input(page, '#pw-transcript', 'My corrected words');
    click(page, '#flowClose');
    click(page, '#dailyCheckinButton');
    assert.equal((page.document.querySelector('#pw-transcript') as HTMLTextAreaElement).value, 'My corrected words');
    assert.equal(page.client.state, null);
    assert.equal(page.requests.length, 0);
  });
});

test('failed save keeps numeric review edits and permits a corrected retry', async () => {
  await withPage(async page => {
    await start(page);
    click(page, '#pw-review');
    await until(() => page.client.state.status === 'review' && page.document.querySelector('[data-record-field="severityScore"]'), 'review rendered');
    const version = page.client.state.version;
    input(page, '[data-record-field="severityScore"]', '4');
    page.failNext = true;
    click(page, '#pw-save');
    await until(() => page.requests.some(request => request.path === '/api/checkin/save') && !page.client.busy, 'failed save response');
    assert.equal(page.client.state.status, 'review');
    assert.equal(page.client.state.version, version);
    assert.equal((page.document.querySelector('[data-record-field="severityScore"]') as HTMLInputElement).value, '4');
    assert.equal(page.requests.at(-1)!.body.record.symptoms[0].severityScore, 4);
    input(page, '[data-record-field="severityScore"]', '3');
    click(page, '#pw-save');
    await until(() => page.client.state.status === 'saved', 'corrected save retry');
    assert.equal(page.client.state.symptoms[0].severityScore, 3);
    assert.equal(page.requests.filter(request => request.path === '/api/checkin/save').length, 2);
    assert.equal(page.requests.at(-1)!.body.version, version);
  });
});

test('model-derived HTML is rendered as text throughout check-in and review', async () => {
  const payload = '<img src=x onerror="window.injected=true">';
  const extractor: Extractor = {
    mode: 'demo',
    async extract() {
      return { ...emptyRecord(), diet: [{ id: null, description: payload, time: null }] };
    },
  };
  await withPage(async page => {
    await start(page, 'A fictional meal description.');
    assert.equal(page.client.state.status, 'review');
    const modal = page.document.querySelector('#checkinFlow')!;
    assert.equal(modal.querySelector('img[onerror]'), null);
    assert.equal((page.dom.window as any).injected, undefined);
    const description = modal.querySelector<HTMLInputElement>('[data-record-field="description"]');
    assert.equal(description?.value, payload);
  }, extractor);
});

test('speech finish waits for final text; manual editing cancels recording and changes mode', async () => {
  const { createSpeechInput } = await import(speechUrl);
  const dom = new JSDOM('<textarea></textarea>');
  const textarea = dom.window.document.querySelector('textarea')!;
  const speech = createSpeechInput({ textarea, onStatus() {}, Recognition: FakeRecognition });
  try {
    speech.start();
    const first = FakeRecognition.instances.at(-1)!;
    first.emit('It was pre', false);
    assert.equal(speech.mode, 'spoken');
    assert.equal(await speech.finish(), 'It was prednisone');
    assert.equal(speech.isActive, false);
    speech.start();
    const second = FakeRecognition.instances.at(-1)!;
    textarea.value = 'Typed correction';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(speech.mode, 'form');
    assert.ok(second.abortCount > 0);
    assert.equal(await speech.finish(), 'Typed correction');
  } finally { speech.destroy(); dom.window.close(); }
});

test('cancelled speech ignores delayed results and aborts a delayed start', async () => {
  const { createSpeechInput } = await import(speechUrl);
  const dom = new JSDOM('<textarea></textarea>');
  const textarea = dom.window.document.querySelector('textarea')!;
  textarea.value = 'Keep my existing words';
  const speech = createSpeechInput({ textarea, onStatus() {}, Recognition: FakeRecognition });
  try {
    speech.start();
    const recognition = FakeRecognition.instances.at(-1)!;
    const delayedStart = recognition.onstart!;
    const delayedResult = recognition.onresult!;
    speech.cancel();
    const aborted = recognition.abortCount;
    delayedStart();
    delayedResult({ resultIndex: 0, results: [Object.assign([{ transcript: 'unwanted late words' }], { isFinal: true })] });
    assert.ok(recognition.abortCount > aborted);
    assert.equal(textarea.value, 'Keep my existing words');
    assert.equal(speech.isActive, false);
    assert.equal(speech.mode, 'form');
  } finally { speech.destroy(); dom.window.close(); }
});

test('app serves external modules with strict script CSP and does not expose backend files', async () => {
  const server = createApp(demoExtractor).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/app`);
    assert.equal(page.status, 200);
    const policy = page.headers.get('Content-Security-Policy')!;
    const scripts = policy.split(';').find(directive => directive.trim().startsWith('script-src'))!;
    assert.match(scripts, /'self'/);
    assert.doesNotMatch(scripts, /unsafe-inline|unsafe-eval/);
    const dom = new JSDOM(await page.text());
    assert.equal(dom.window.document.querySelectorAll('script:not([src])').length, 0);
    assert.equal(dom.window.document.querySelector('script[type="module"]')?.getAttribute('src'), '/frontend/main.js');
    dom.window.close();
    for (const path of ['/frontend/main.js', '/frontend/checkin-controller.js', '/frontend/checkin-api.js', '/frontend/speech.js', '/frontend/checkin.css']) {
      const asset = await fetch(base + path);
      assert.equal(asset.status, 200, `${path} must be served`);
      assert.match(asset.headers.get('Content-Type')!, path.endsWith('.css') ? /text\/css/ : /javascript/);
    }
    for (const path of ['/frontend/.env', '/backend/.env', '/frontend/../backend/.env', '/frontend/%2e%2e%2fbackend%2f.env', '/frontend/../backend/src/server.ts']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, `${path} must not be served`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
