import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const uiUrl = new URL('../../frontend/new-ui.js', import.meta.url).href;
const apiUrl = new URL('../../frontend/checkin-api.js', import.meta.url).href;
const symptomId = '87b18fa9-df6f-4015-834c-a14c3a3d9c9c';

async function withQuestion(question: any, run: (page: any) => Promise<void>) {
  const dom = new JSDOM(await readFile(new URL('../../index.html', import.meta.url), 'utf8'), {
    url: 'https://example.test/app', runScripts: 'outside-only',
  });
  dom.window.scrollTo = () => {};
  const [{ mountVersionB }, { createCheckinClient }] = await Promise.all([import(uiUrl), import(apiUrl)]);
  const spoken: string[] = [];
  const client = createCheckinClient({ fetchImpl: async () => Response.json({
    schemaVersion: '1.0', sessionId: '73c1905b-e2d2-4a51-81b2-af8daf641916', version: 1,
    status: 'collecting', extractionMode: 'gemini',
    symptoms: [{ id: symptomId, name: 'knee pain', location: 'left knee', severity: null,
      severityScore: null, functionalImpact: null, firstOccurrence: null, duration: null, trend: null }],
    medications: [], diet: [], vitals: [], wellness: null, nextQuestion: question,
    missingFields: [], skippedFields: [], notices: [], storage: 'memory',
  }) });
  const speechFactory = ({ textarea }: any) => ({
    available: true, isActive: false, mode: 'form',
    async start() {}, async finish() { return textarea.value; }, cancel() {}, destroy() {},
  });
  const app = mountVersionB(dom.window.document, {
    client, speechFactory, conversationEnabled: true,
    speakerFactory: () => ({ async prime() {}, async speak(text: string) { spoken.push(text); }, stop() {}, destroy() {} }),
  });
  try {
    app.open();
    dom.window.document.getElementById('flowType')!.click();
    (dom.window.document.getElementById('flowTranscript') as HTMLTextAreaElement).value = 'My left knee hurts when climbing stairs.';
    dom.window.document.querySelector<HTMLElement>('.flow-done')!.click();
    const deadline = Date.now() + 2000;
    while (dom.window.document.getElementById('checkinFlow')!.getAttribute('aria-busy') === 'true') {
      if (Date.now() >= deadline) throw new Error('Check-in UI did not finish starting.');
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(client.state, 'Initial check-in should be recorded');
    await app.conversation.start({ resume: true });
    await run({ document: dom.window.document, app, client, spoken });
  } finally { app.destroy(); dom.window.close(); }
}

test('adaptive pain wording is identical on the 1–10 screen and in voice', async () => {
  const text = 'Thinking about the stairs you mentioned, how strong is your left knee pain from 1 to 10?';
  const question = { id: `${symptomId}:severity`, category: 'symptoms', entityId: symptomId,
    field: 'severity', text, type: 'single_choice', options: Array.from({ length: 10 }, (_, i) => String(i + 1)) };
  await withQuestion(question, async ({ document, spoken }) => {
    const screen = document.querySelector('[data-screen="pain-score"]');
    assert.equal(screen.hidden, false);
    assert.equal(screen.querySelector('h2').textContent, text);
    assert.deepEqual([...screen.querySelectorAll('.pain-score-button')].map((button: any) => Number(button.textContent)), [1,2,3,4,5,6,7,8,9,10]);
    assert.deepEqual(spoken, [text]);
  });
});

test('adaptive duration questions use a free answer without unrelated fixed choices', async () => {
  const text = 'When did this episode of knee pain start?';
  const question = { id: `${symptomId}:duration`, category: 'symptoms', entityId: symptomId,
    field: 'duration', text, type: 'text', options: [] };
  await withQuestion(question, async ({ document, spoken }) => {
    const screen = document.querySelector('[data-screen="guided"]');
    assert.equal(screen.hidden, false);
    assert.equal(document.querySelector('[data-screen="additional"]').hidden, true);
    assert.equal(screen.querySelector('h2').textContent, text);
    assert.equal(screen.querySelector('#followupAnswer').getAttribute('aria-label'), text);
    assert.equal(screen.querySelectorAll('.integration-question-controls .severity-card').length, 0);
    assert.deepEqual(spoken, [text]);
  });
});
