import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function withPage(run: (page: any) => Promise<void>) {
  const dom = new JSDOM(await readFile(new URL('../../index.html', import.meta.url), 'utf8'), {
    url: 'https://example.test/app', runScripts: 'outside-only',
  });
  dom.window.scrollTo = () => {};
  const [{ mountVersionB }, { createCheckinClient }] = await Promise.all([
    import(new URL('../../frontend/new-ui.js', import.meta.url).href),
    import(new URL('../../frontend/checkin-api.js', import.meta.url).href),
  ]);
  const captures: any[] = [];
  const client = createCheckinClient({ fetchImpl: async () => { throw new Error('Unexpected API request'); } });
  const speechFactory = ({ textarea, onStatus }: any) => {
    let active = false;
    let ready!: () => void;
    const capture = {
      textarea, available: true, mode: 'spoken',
      get isActive() { return active; },
      start() {
        active = true;
        onStatus?.({ type: 'connecting', message: 'Preparing your microphone…' });
        return new Promise<void>(resolve => { ready = resolve; });
      },
      ready() { ready(); },
      status(type: string) { onStatus?.({ type, message: type }); },
      async finish() { active = false; return textarea.value; },
      // A pending provider operation may still resolve after cancellation.
      cancel() { active = false; },
      destroy() { active = false; },
    };
    captures.push(capture);
    return capture;
  };
  const document = dom.window.document;
  const app = mountVersionB(document, { client, mealClient: client, speechFactory, conversationEnabled: false });
  const page = {
    app, document, dom,
    capture: captures.find(capture => capture.textarea.id === 'flowTranscript'),
    heading: () => document.querySelector('[data-screen="listening"] h2')!.textContent,
    click(selector: string) { document.querySelector<HTMLElement>(selector)!.click(); },
    revisit() { document.querySelector('#checkinForm')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); },
  };
  try { await run(page); }
  finally { app.destroy(); dom.window.close(); }
}

test('Version B does not show Listening when an active microphone is still connecting', async () => {
  await withPage(async page => {
    page.app.open();
    page.click('#flowIntroMic');
    assert.equal(page.capture.isActive, true);
    assert.notEqual(page.heading(), "I'm listening");
    // A screen refresh must use capture readiness, not its pending active state.
    page.revisit();
    assert.notEqual(page.heading(), "I'm listening");
    page.capture.ready();
    await tick();
    assert.equal(page.heading(), "I'm listening");
    page.click('#flowClose');
    page.app.open();
    page.click('#flowType');
    assert.notEqual(page.heading(), "I'm listening");
  });
});

test('Version B ignores microphone readiness that arrives after cancellation', async () => {
  await withPage(async page => {
    page.app.open();
    page.click('#flowIntroMic');
    page.click('#flowClose');
    page.capture.ready();
    await tick();
    assert.notEqual(page.heading(), "I'm listening");
    page.app.open();
    page.click('#flowType');
    assert.notEqual(page.heading(), "I'm listening");
  });
});

for (const status of ['idle', 'error', 'unavailable']) {
  test(`Version B clears microphone readiness after ${status}`, async () => {
    await withPage(async page => {
      page.app.open();
      page.click('#flowIntroMic');
      page.capture.ready();
      await tick();
      assert.equal(page.heading(), "I'm listening");
      page.capture.status(status);
      assert.notEqual(page.heading(), "I'm listening");
      page.click('#flowType');
      assert.notEqual(page.heading(), "I'm listening");
    });
  });
}
