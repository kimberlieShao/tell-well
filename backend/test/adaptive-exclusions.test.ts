import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/app.js';
import type { Extractor } from '../src/extractor.js';
import { analyzeInputSchema, emptyRecord } from '../src/schema.js';

const uiUrl = new URL('../../frontend/new-ui.js', import.meta.url).href;
const apiUrl = new URL('../../frontend/checkin-api.js', import.meta.url).href;

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('The check-in did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('entity skip scope is accepted only for a targeted skip action', () => {
  const sessionId = '0172952f-04cd-4707-ab90-0739fe12e843';
  const skip = { sessionId, version: 1, action: 'skip', questionId: 'some-question', skipScope: 'entity' };
  assert.equal(analyzeInputSchema.safeParse(skip).success, true);
  assert.equal(analyzeInputSchema.safeParse({ ...skip, action: 'review' }).success, false);
  assert.equal(analyzeInputSchema.safeParse({ transcript: 'My knee hurts.', skipScope: 'entity' }).success, false);
  assert.equal(analyzeInputSchema.safeParse({ ...skip, skipScope: 'all' }).success, false);
});

test('seven unchecked topics do not consume the question budget for the retained topic', async () => {
  const plannedContexts: any[] = [];
  const extractor: Extractor = {
    mode: 'gemini', adaptiveQuestions: true,
    async extract(_text, record, question, context) {
      plannedContexts.push(context);
      if (!question) return {
        ...emptyRecord(),
        symptoms: Array.from({ length: 8 }, (_, index) => ({
          id: null, name: `reported pain ${index + 1}`, location: `reported area ${index + 1}`,
          severity: null, severityScore: null, trend: null, functionalImpact: null,
          duration: null, firstOccurrence: null,
        })),
      };
      const symptom = record.symptoms.find(item => item.id === question.entityId)!;
      return { ...emptyRecord(), symptoms: [{ ...symptom, severityScore: 6 }], followUp: {
        action: 'ask', category: 'symptoms', entityId: symptom.id, extractionIndex: null,
        field: 'duration', text: 'How long has that pain lasted?',
      } };
    },
  };
  const server = createApp(extractor).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dom = new JSDOM(await readFile(new URL('../../index.html', import.meta.url), 'utf8'), {
    url: `${baseUrl}/app`, runScripts: 'outside-only',
  });
  dom.window.scrollTo = () => {};
  const [{ createCheckinClient }, { mountVersionB }] = await Promise.all([import(apiUrl), import(uiUrl)]);
  const requests: any[] = [];
  const client = createCheckinClient({ baseUrl, painScale: '1-10', fetchImpl: (url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return fetch(url, init);
  } });
  const app = mountVersionB(dom.window.document, {
    client, conversationEnabled: false,
    speechFactory: ({ textarea }: any) => ({ available: false, isActive: false, mode: 'form',
      async start() {}, async finish() { return textarea.value; }, cancel() {}, destroy() {} }),
    speakerFactory: () => ({ stop() {}, destroy() {} }),
  });
  const click = (selector: string) => {
    const element = dom.window.document.querySelector<HTMLElement>(selector);
    assert.ok(element, selector);
    element.click();
  };
  const ready = () => dom.window.document.getElementById('checkinFlow')!.getAttribute('aria-busy') !== 'true';
  try {
    app.open();
    click('#flowType');
    (dom.window.document.getElementById('flowTranscript') as HTMLTextAreaElement).value = 'Only the last detected topic should be kept.';
    click('.flow-done');
    await until(() => Boolean(client.state) && ready());
    const retainedId = client.state.symptoms[7].id;
    const topicInputs = [...dom.window.document.querySelectorAll<HTMLInputElement>('.flow-detected-list input')];
    assert.equal(topicInputs.length, 8);
    for (const input of topicInputs.slice(0, 7)) input.checked = false;
    click('[data-screen="topics"] [data-next]');
    await until(() => ready() && client.state.nextQuestion?.entityId === retainedId);
    assert.equal(app.getCurrentScreen(), 'pain-score');
    assert.equal(client.state.nextQuestion.field, 'severity');
    assert.equal(app.state.symptoms.length, 1);
    assert.equal(requests.filter(request => request.skipScope === 'entity').length, 7);
    [...dom.window.document.querySelectorAll<HTMLButtonElement>('.pain-score-button')]
      .find(button => button.textContent?.trim() === '6')!.click();
    click('#painScoreContinue');
    await until(() => ready() && client.state.nextQuestion?.field === 'duration');
    assert.equal(client.state.nextQuestion.entityId, retainedId);
    assert.equal(client.state.symptoms.find((item: any) => item.id === retainedId).severityScore, 6);
    assert.equal(plannedContexts.at(-1).excludedEntityIds.length, 7);
    assert.equal(plannedContexts.at(-1).remainingQuestions, 5);
    click('[data-screen="guided"] [data-integration-skip]');
    await until(() => ready() && client.state.status === 'review');
    assert.equal(requests.at(-1).action, 'skip');
    assert.equal(requests.at(-1).skipScope, undefined, 'An explicit question skip keeps its ordinary scope');
  } finally {
    app.destroy(); dom.window.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
