import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/app.js';
import { demoExtractor, type Extractor } from '../src/extractor.js';

const uiUrl = new URL('../../frontend/new-ui.js', import.meta.url).href;
const apiUrl = new URL('../../frontend/checkin-api.js', import.meta.url).href;
const adapterUrl = new URL('../../frontend/version-b-adapter.js', import.meta.url).href;
const htmlUrl = new URL('../../index.html', import.meta.url);
const cases = {
  wellness: 'I feel fine today.',
  pain: 'My arm and leg hurt.',
  medication: 'My arm hurts and I forgot my medicine.',
  refusal: "I don't want to take my medicine.",
  meals: 'I had oatmeal for breakfast, chicken and rice for lunch, and pasta for dinner.',
};

async function until(check: () => unknown, label: string) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

type Page = {
  dom: JSDOM; document: Document; app: any; client: any; mealClient: any;
  requests: { path: string; body: any }[];
  speech: any[]; failNext: boolean; gate: Promise<void> | null;
  spokenQuestions: string[];
  spokenVoices: string[];
  speakerGate?: Promise<void>;
};

function click(page: Page, selector: string) {
  const node = page.document.querySelector<HTMLElement>(selector);
  assert.ok(node, `Control missing: ${selector}`);
  node.click();
}
function fill(page: Page, selector: string, value: string) {
  const node = page.document.querySelector<HTMLInputElement>(selector);
  assert.ok(node, `Field missing: ${selector}`);
  node.value = value;
  node.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  node.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
}
function ready(page: Page) { return page.document.getElementById('checkinFlow')?.getAttribute('aria-busy') !== 'true'; }
function screen(page: Page) { return page.document.querySelector<HTMLElement>('[data-screen]:not([hidden])')?.dataset.screen; }

async function withPage(run: (page: Page) => Promise<void>, extractor: Extractor = demoExtractor, conversationEnabled = false) {
  const server = createApp(extractor).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dom = new JSDOM(await readFile(htmlUrl, 'utf8'), { url: `${baseUrl}/app`, runScripts: 'outside-only' });
  dom.window.scrollTo = () => {};
  const page = { dom, document: dom.window.document, requests: [], speech: [], spokenQuestions: [], failNext: false, gate: null } as unknown as Page;
  const [{ createCheckinClient }, { mountVersionB }] = await Promise.all([import(apiUrl), import(uiUrl)]);
  const fetchImpl = async (url: string, init: RequestInit) => {
    page.requests.push({ path: new URL(url, baseUrl).pathname, body: JSON.parse(String(init.body)) });
    if (page.gate) await page.gate;
    if (page.failNext) {
      page.failNext = false;
      return Response.json({ error: { code: 'TEST_FAILURE', message: 'Test provider temporarily unavailable.', details: [] } }, { status: 502 });
    }
    return fetch(url, init);
  };
  page.client = createCheckinClient({ baseUrl, fetchImpl, painScale: '1-10' });
  page.mealClient = createCheckinClient({ baseUrl, fetchImpl, painScale: '1-10' });
  const speechFactory = ({ textarea, onStatus = () => {}, onTurn }: any) => {
    let active = false;
    let mode = 'form';
    let cancelled = 0;
    const input = () => { active = false; mode = 'form'; };
    textarea.addEventListener('input', input);
    const capture = {
      textarea, available: true, finalText: '', finishGate: null as Promise<void> | null,
      get isActive() { return active; }, get mode() { return mode; }, get cancelled() { return cancelled; },
      async start() { active = true; mode = 'spoken'; onStatus({ type: 'listening', message: 'Listening' }); },
      status(value:any) { onStatus(value); },
      async turn(text: string) { textarea.value=text;active=false;return onTurn?.(text); },
      async finish() {
        const generation = cancelled;
        if (capture.finishGate) await capture.finishGate;
        if (generation !== cancelled) throw new Error('Recording cancelled.');
        if (active && capture.finalText) textarea.value = capture.finalText;
        active = false;
        onStatus({ type: 'idle', message: 'Complete' });
        return textarea.value.trim();
      },
      cancel() { active = false; cancelled++; },
      destroy() { capture.cancel(); textarea.removeEventListener('input', input); },
    };
    page.speech.push(capture);
    return capture;
  };
  page.spokenVoices = [];
  const speakerFactory = ({ getVoice = () => 'default' } = {}) => ({
    prime: async () => {},
    speak: async (text: string) => { assert.ok(page.speech.every(input => !input.isActive), 'microphone must be off while speaking');page.spokenQuestions.push(text);page.spokenVoices.push(getVoice());if(page.speakerGate)await page.speakerGate; },
    stop() {},destroy() {},
  });
  page.app = mountVersionB(page.document, { client: page.client, mealClient: page.mealClient, speechFactory, speakerFactory, conversationEnabled });
  try { await run(page); }
  finally {
    page.app?.destroy();
    dom.window.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function analyze(page: Page, transcript: string) {
  click(page, '#dailyCheckinButton');
  click(page, '#flowType');
  fill(page, '#flowTranscript', transcript);
  click(page, '.flow-done');
  await until(() => page.client.state && !page.client.busy && ready(page) && screen(page) === 'topics', 'backend topics');
}

test('Version B retains its original CSS, navigation, screen structure and 1–10 scale', async () => {
  const dom = new JSDOM(await readFile(htmlUrl, 'utf8'));
  try {
    const css = dom.window.document.querySelector('style')!.textContent!;
    assert.equal(createHash('sha256').update(css).digest('hex'), 'c614c1dccddab9fb0bccb2e2edeba76a01c636bc92d473e16110c113c3efb3e4');
    for (const id of ['desktopHomeNav', 'desktopMealsNav', 'desktopTrendsNav', 'desktopMoreNav', 'mealsView', 'trendsView', 'moreView'])
      assert.ok(dom.window.document.getElementById(id), id);
    assert.deepEqual([...dom.window.document.querySelectorAll('.pain-score-button')].map(node => Number(node.textContent)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(dom.window.document.querySelector('[data-screen="review"] #reviewConfirmSave'));
    assert.equal(dom.window.document.querySelectorAll('script:not([src])').length, 0);
  } finally { dom.window.close(); }
});

test('Version B wellness check-in reaches review and saves without invented symptoms or vitals', async () => {
  await withPage(async page => {
    await analyze(page, cases.wellness);
    assert.equal(page.app.state.noSymptoms, true);
    assert.equal(page.app.state.symptoms.length, 0);
    assert.equal(page.app.state.vitals.length, 0);
    click(page, '[data-screen="topics"] [data-next]');
    await until(() => ready(page) && screen(page) === 'review', 'wellness review');
    assert.equal(page.document.getElementById('reviewWellnessSection')!.hidden, false);
    click(page, '#reviewConfirmSave');
    await until(() => page.client.state.status === 'saved' && screen(page) === 'trends', 'wellness saved');
    assert.equal(page.client.state.wellness.status, 'well');
    assert.match(page.document.querySelector('.checkin-history')!.textContent!, /I feel fine today/);
    assert.doesNotMatch(page.document.querySelector('.checkin-history')!.textContent!, /No check-ins/);
  });
});

test('Version B maps both pain locations and keeps each numeric score on its own entity', async () => {
  await withPage(async page => {
    await analyze(page, cases.pain);
    assert.equal(page.app.state.symptoms.length, 2);
    assert.equal(page.document.querySelectorAll('.flow-detected-list input[data-category="symptoms"]').length, 2);
    click(page, '[data-screen="topics"] [data-next]');
    await until(() => ready(page) && screen(page) === 'pain-score', 'first numeric pain question');
    for (let guard = 0; page.client.state.status !== 'review' && guard < 12; guard++) {
      const q = page.client.state.nextQuestion;
      const before = page.client.state.version;
      if (q.field === 'severity') {
        const symptom = page.client.state.symptoms.find((item: any) => item.id === q.entityId);
        const value = /arm/i.test(symptom.location || symptom.name) ? '7' : '3';
        const button = [...page.document.querySelectorAll<HTMLButtonElement>('.pain-score-button')].find(node => node.textContent === value)!;
        button.click();
        click(page, '#painScoreContinue');
      } else {
        // Exercise the UI skip action rather than bypassing it through the API.
        const skip = page.document.querySelector<HTMLButtonElement>('[data-screen]:not([hidden]) [data-integration-skip]');
        assert.ok(skip, `Skip button needed for ${q.field}`);
        skip.click();
      }
      await until(() => page.client.state.version > before && !page.client.busy && ready(page), 'next question');
    }
    await until(() => ready(page) && screen(page) === 'review', 'multi-pain review');
    const scores = Object.fromEntries(page.app.state.symptoms.map((item: any) => [item.location, item.painScore]));
    assert.equal(scores.arm, 7);
    assert.equal(scores.leg, 3);
    click(page, '#reviewConfirmSave');
    await until(() => page.client.state.status === 'saved', 'multi-pain saved');
    assert.deepEqual(page.client.state.symptoms.map((item: any) => item.severityScore), [7, 3]);
    await until(() => ready(page), 'history rendered');
    const history = page.document.querySelector('.checkin-history')!.textContent!;
    assert.match(history, /Arm pain \(7\/10\)/);
    assert.match(history, /Leg pain \(3\/10\)/);
  });
});

test('Version B retains a symptom and missed unnamed medication without invented medication choices', async () => {
  await withPage(async page => {
    await analyze(page, cases.medication);
    assert.equal(page.app.state.symptoms.length, 1);
    assert.equal(page.app.state.medications.length, 1);
    assert.equal(page.app.state.medications[0].name, null);
    assert.equal(page.app.state.medications[0].status, 'missed');
    click(page, '[data-screen="topics"] [data-next]');
    await until(() => ready(page) && screen(page) === 'medication', 'medication question');
    assert.doesNotMatch(page.document.getElementById('medList')!.textContent!, /Prednisone|Lisinopril|5 mg|10 mg/);
  });
});

test('Version B does not label medication refusal as taken', async () => {
  await withPage(async page => {
    await analyze(page, cases.refusal);
    assert.ok(page.app.state.medications.length);
    assert.ok(page.app.state.medications.every((item: any) => item.status !== 'taken'));
    assert.doesNotMatch(page.document.querySelector('.flow-detected-list')!.textContent!, /Medication Taken/);
  });
});

test('Version B saves three explicit meals and updates its existing Meals view', async () => {
  await withPage(async page => {
    await analyze(page, cases.meals);
    assert.equal(page.app.state.diet.length, 3);
    assert.deepEqual(page.app.state.diet.map((item: any) => item.time), ['breakfast', 'lunch', 'dinner']);
    click(page, '[data-screen="topics"] [data-next]');
    await until(() => ready(page) && screen(page) === 'review', 'meal review');
    click(page, '#reviewConfirmSave');
    await until(() => page.client.state.status === 'saved' && screen(page) === 'trends', 'meals saved');
    click(page, '#flowClose');
    click(page, '#desktopMealsNav');
    assert.equal(page.document.getElementById('mealsView')!.hidden, false);
    const names = (type: string) => page.app.mealState.meals[type].map((item: any) => item.name).join(' ').toLowerCase();
    assert.match(names('breakfast'), /oatmeal/);
    assert.match(names('lunch'), /chicken.*rice/);
    assert.match(names('dinner'), /pasta/);
  });
});

test('Version B awaits final speech, keeps transcript editable, and retains it on provider failure', async () => {
  await withPage(async page => {
    click(page, '#dailyCheckinButton');
    click(page, '#flowIntroMic');
    await until(() => ready(page) && page.speech.some(capture => capture.isActive), 'microphone start');
    const capture = page.speech.find(capture => capture.isActive);
    capture.textarea.value = 'I feel fi';
    capture.finalText = cases.wellness;
    let release!: () => void;
    capture.finishGate = new Promise<void>(resolve => { release = resolve; });
    page.failNext = true;
    click(page, '.flow-done');
    click(page, '.flow-done');
    assert.equal(page.requests.length, 0, 'no interim text submitted');
    release();
    await until(() => page.requests.length === 1 && !page.client.busy && ready(page), 'final text request');
    assert.equal(page.requests[0].body.transcript, cases.wellness);
    assert.equal(screen(page), 'listening');
    assert.equal(page.document.querySelector<HTMLTextAreaElement>('#flowTranscript')!.value, cases.wellness);
    fill(page, '#flowTranscript', 'I feel normal today.');
    click(page, '.flow-done');
    await until(() => ready(page) && screen(page) === 'topics', 'corrected transcript retried');
    assert.equal(page.app.state.generalStatus, 'normal');
  });
});

test('Version B keeps Home, Meals, Trends, and More navigation functional', async () => {
  await withPage(async page => {
    for (const [button, view] of [['desktopMealsNav', 'mealsView'], ['desktopTrendsNav', 'trendsView'], ['desktopMoreNav', 'moreView']]) {
      click(page, `#${button}`);
      assert.equal(page.document.getElementById(view)!.hidden, false);
    }
    click(page, '#desktopHomeNav');
    assert.equal(page.document.querySelector<HTMLElement>('.patient-home')!.hidden, false);
  });
});

test('choosing a follow-up option stops speech before the request, including a failed request', async () => {
  await withPage(async page => {
    await analyze(page, 'My arm hurts.');
    click(page, '[data-screen="topics"] [data-next]');
    await until(() => ready(page) && screen(page) === 'pain-score', 'numeric score');
    click(page, '#painScoreSkip');
    await until(() => ready(page) && screen(page) === 'guided', 'first occurrence question');
    const repeat=[...page.document.querySelectorAll<HTMLButtonElement>('.integration-question-controls .severity-card')].find(button=>button.textContent==='No, I have had it before')!;
    repeat.click();
    await until(()=>ready(page)&&page.client.state.nextQuestion.field==='trend','trend question');
    click(page, '#followupVoice');
    await until(() => ready(page), 'speech started');
    const speech = page.speech.at(-1);
    assert.equal(speech.isActive, true);
    let release!: () => void;
    page.gate = new Promise<void>(resolve => { release = resolve; });
    page.failNext = true;
    const same = [...page.document.querySelectorAll<HTMLButtonElement>('.integration-question-controls .severity-card')].find(button => button.textContent === 'Same')!;
    same.click();
    assert.equal(speech.isActive, false);
    release();
    await until(() => ready(page), 'provider error shown');
    assert.equal(speech.isActive, false);
    assert.equal(page.document.getElementById('integrationError')!.hidden, false);
    assert.equal(page.client.state.nextQuestion.field, 'trend');
  });
});

test('Version B adapter preserves null corrections, numeric scores, IDs and safe meal grouping', async () => {
  const { normalizeBackendResponse, toBackendRecord, mealsFromBackend } = await import(adapterUrl);
  const response = {
    symptoms: [{ id: 'symptom', name: 'arm pain', location: 'arm', severity: null, severityScore: 7, trend: null, functionalImpact: null, duration: null }],
    medications: [], diet: [{ id: 'meal', description: '<img src=x onerror=alert(1)>', time: null }], vitals: [], wellness: null,
    sessionId: 'session', version: 1, status: 'review', nextQuestion: null, missingFields: [], notices: [], extractionMode: 'demo',
  };
  const state = normalizeBackendResponse(response);
  state.symptoms[0].painScore = null;
  assert.equal(toBackendRecord(state).symptoms[0].severityScore, null);
  assert.equal(toBackendRecord(state).symptoms[0].id, 'symptom');
  assert.equal(mealsFromBackend(response).meals[0].mealType, 'unspecified');
  assert.equal(normalizeBackendResponse(response, { excludedIds: new Set(['symptom']) }).symptoms.length, 0);
});

test('Meals voice confirmation saves only diet shown in its preview', async () => {
  await withPage(async page => {
    click(page, '#desktopMealsNav');
    click(page, '#mealsVoiceCTA');
    fill(page, '#mealsVoiceTranscript', 'I ate oatmeal for breakfast and my arm hurts.');
    click(page, '[data-action="analyze-voice-entry"]');
    await until(() => page.document.querySelector('[data-action="save-voice-entry"]') && !page.mealClient.busy, 'meal-only preview');
    click(page, '[data-action="save-voice-entry"]');
    await until(() => page.mealClient.state?.status === 'saved', 'meal save');
    assert.ok(page.mealClient.state.diet.length);
    assert.deepEqual(page.mealClient.state.symptoms, []);
    assert.deepEqual(page.mealClient.state.medications, []);
    assert.deepEqual(page.mealClient.state.vitals, []);
  });
});

test('review locks edits during save, preserves corrections on error, and retries without losing numbers', async () => {
  await withPage(async page => {
    await analyze(page, 'My arm pain is 7 out of 10.');
    click(page, '[data-screen="topics"] [data-next]');
    await until(() => screen(page) === 'guided' && ready(page), 'first occurrence question');
    click(page, '[data-screen="guided"] [data-integration-review]');
    await until(() => screen(page) === 'review' && ready(page), 'review');
    click(page, '#reviewSymptoms [data-edit-review]');
    fill(page, '[data-record-field="severityScore"]', '4');
    let release!: () => void;
    page.gate = new Promise<void>(resolve => { release = resolve; });
    page.failNext = true;
    click(page, '#reviewConfirmSave');
    assert.equal(page.document.querySelector<HTMLInputElement>('[data-record-field="severityScore"]')!.disabled, true);
    click(page, '#reviewConfirmSave');
    release();
    await until(() => ready(page), 'failed save settled');
    assert.equal(page.document.querySelector<HTMLInputElement>('[data-record-field="severityScore"]')!.value, '4');
    assert.equal(page.client.state.status, 'review');
    assert.equal(page.document.getElementById('integrationError')!.hidden, false);
    page.gate = null;
    click(page, '#reviewConfirmSave');
    await until(() => page.client.state.status === 'saved', 'save retry');
    assert.equal(page.client.state.symptoms[0].severityScore, 4);
    assert.equal(page.requests.filter(request => request.path === '/api/checkin/save').length, 2);
  });
});

test('unchecked topics are excluded from both follow-ups and the saved record', async () => {
  await withPage(async page => {
    await analyze(page, cases.pain);
    const removed = page.app.state.symptoms.find((item: any) => item.location === 'arm');
    const input = page.document.querySelector<HTMLInputElement>(`.flow-detected-list input[data-key="${removed.id}"]`)!;
    input.checked = false;
    click(page, '[data-screen="topics"] [data-next]');
    await until(() => ready(page) && screen(page) === 'pain-score', 'remaining leg question');
    assert.notEqual(page.client.state.nextQuestion.entityId, removed.id);
    assert.equal(page.app.state.symptoms.length, 1);
    click(page, '[data-screen="pain-score"] [data-integration-review]');
    await until(() => ready(page) && screen(page) === 'review', 'filtered review');
    click(page, '#reviewConfirmSave');
    await until(() => page.client.state.status === 'saved', 'filtered save');
    assert.equal(page.client.state.symptoms.length, 1);
    assert.equal(page.client.state.symptoms[0].location, 'leg');
  });
});

test('wellness is visible in review even when the same check-in has a symptom', async () => {
  const extractor: Extractor = {
    mode: 'gemini',
    async extract(transcript, record, question) {
      const extraction = await demoExtractor.extract('My arm hurts.', record, question);
      extraction.wellness = {status: 'well', statement: 'I feel generally fine today.'};
      return extraction;
    },
  };
  await withPage(async page => {
    await analyze(page, 'I feel generally fine today but my arm hurts.');
    click(page, '[data-screen="topics"] [data-next]');
    await until(() => ready(page) && screen(page) === 'pain-score', 'pain question');
    click(page, '[data-screen="pain-score"] [data-integration-review]');
    await until(() => ready(page) && screen(page) === 'review', 'mixed review');
    assert.equal(page.document.getElementById('reviewWellnessSection')!.hidden, false);
    assert.match(page.document.getElementById('reviewWellness')!.textContent!, /generally fine/);
    assert.equal(page.document.getElementById('reviewSymptomsSection')!.hidden, false);
  }, extractor);
});

test('the Home voice choice reaches spoken check-in questions and can change between check-ins', async () => {
  await withPage(async page => {
    for (const voice of ['sarah', 'river', 'callum', 'harry', 'default']) {
      fill(page, '#checkinVoiceSelect', voice);
      assert.equal(page.app.conversation.active, false);
      click(page, '#dailyCheckinButton');
      await until(() => page.app.conversation.state.phase === 'listening', 'selected voice listening');
      assert.equal(page.spokenVoices.at(-1), voice);
      click(page, '#flowClose');
    }
  }, demoExtractor, true);
});

test('one click starts a spoken conversation that reaches the existing review without Continue clicks', async () => {
  await withPage(async page => {
    click(page, '#dailyCheckinButton');
    await until(() => page.app.conversation.state.phase === 'listening', 'initial listening');
    const opening=page.document.querySelector('[data-screen="intro"] h2')!.textContent!;
    assert.equal(page.document.querySelector('.patient-prompt')!.textContent,opening);
    assert.equal(page.spokenQuestions[0],opening);
    assert.ok(opening.split(/\s+/).length<=8,'Opening is one short question');
    await page.speech.at(-1).turn('My arm and leg hurt.');
    assert.equal(screen(page), 'pain-score');
    assert.equal(page.client.state.symptoms.length, 2);
    assert.match(page.spokenQuestions.at(-1)!, /arm/);
    assert.equal((page.document.getElementById('voiceReview') as HTMLButtonElement).disabled, false);
    for (const answer of ['seven out of ten', 'No, I have had it before', 'same', 'For three days', 'three', 'No, I have had it before', 'worse', 'Since yesterday']) {
      await until(() => page.app.conversation.state.phase === 'listening', `ready for ${answer}`);
      await page.speech.at(-1).turn(answer);
    }
    assert.equal(screen(page), 'review');
    assert.equal(page.app.conversation.active, false);
    assert.equal(page.client.state.status, 'review');
    assert.equal(page.app.state.transcript, 'My arm and leg hurt.');
    assert.deepEqual(page.app.state.symptoms.map((item: any) => item.painScore), [7,3]);
    assert.deepEqual([...page.document.querySelectorAll<HTMLInputElement>('[data-record-field="severityScore"]')].map(input=>input.value), ['7','3']);
    assert.equal(page.document.querySelector('[data-record-field="severity"]'),null);
    assert.match(page.document.getElementById('reviewReportedAnswers')!.textContent!, /seven out of ten|7/);
    assert.match(page.document.getElementById('reviewReportedAnswers')!.textContent!, /Since yesterday/);
    assert.equal(page.spokenQuestions.filter((text:string)=>/scale of 1 to 10/.test(text)).length,2);
    assert.equal(page.requests.filter(request => request.path.endsWith('/save')).length, 0);
    assert.ok(page.speech.every(input => !input.isActive));
    click(page, '#reviewConfirmSave');
    await until(() => page.client.state.status === 'saved', 'explicitly confirmed save');
  }, demoExtractor, true);
});

test('voice Pause returns to manual controls and Close prevents late audio from advancing', async () => {
  await withPage(async page => {
    click(page, '#dailyCheckinButton');
    await until(() => page.app.conversation.state.phase === 'listening', 'listening');
    const old = page.speech.at(-1);
    click(page, '#voicePause');
    assert.equal(page.app.conversation.active, false);
    assert.equal(ready(page), true);
    assert.equal((page.document.querySelector('.flow-done') as HTMLButtonElement).disabled, false);
    assert.equal(old.isActive, false);
    click(page, '#flowClose');
    await old.turn('My knee hurts.');
    assert.equal(page.requests.length, 0);
    assert.equal(page.document.getElementById('checkinFlow')!.classList.contains('open'), false);
    click(page, '#typeCheckinButton');
    fill(page, '#flowTranscript', 'I feel fine today.');
    click(page, '.flow-done');
    await until(() => ready(page) && screen(page) === 'topics', 'manual recovery');
    assert.equal(page.app.state.noSymptoms, true);
  }, demoExtractor, true);
});

for (const retry of ['voice', 'typing']) {
  test(`a voice provider error appears once and permits ${retry} retry with the transcript intact`, async () => {
    await withPage(async page => {
      click(page, '#dailyCheckinButton');
      await until(() => page.app.conversation.state.phase === 'listening', 'initial listening');
      page.failNext = true;
      await page.speech.at(-1).turn('My arm hurts.');
      assert.equal(page.app.conversation.state.phase, 'error');
      assert.equal(page.app.conversation.active, false);
      assert.equal(ready(page), true);
      const error = page.document.getElementById('integrationError')!;
      const status = page.document.getElementById('integrationStatus')!;
      assert.equal(error.hidden, false);
      assert.equal(error.getAttribute('role'), 'alert');
      assert.equal(error.textContent, 'Test provider temporarily unavailable.');
      assert.equal(status.textContent, 'Voice paused.');
      const visibleCopies = [...page.document.querySelectorAll<HTMLElement>('#checkinFlow [role="alert"], #checkinFlow [role="status"]')]
        .filter(element => !element.hidden && element.textContent === error.textContent);
      assert.equal(visibleCopies.length, 1, 'The actionable error has one visible announcement');
      assert.equal((page.document.getElementById('flowTranscript') as HTMLTextAreaElement).value, 'My arm hurts.');
      assert.equal((page.document.getElementById('voiceResume') as HTMLButtonElement).disabled, false);
      assert.equal((page.document.querySelector('.flow-done') as HTMLButtonElement).disabled, false);

      if (retry === 'voice') {
        click(page, '#voiceResume');
        assert.equal(error.hidden, true);
        await until(() => page.app.conversation.state.phase === 'listening', 'voice retry listening');
        await page.speech.at(-1).turn('My arm hurts.');
        assert.equal(screen(page), 'pain-score');
      } else {
        click(page, '.flow-done');
        assert.equal(error.hidden, true);
        await until(() => ready(page) && screen(page) === 'topics', 'typed retry topics');
      }
      assert.equal(error.hidden, true);
      assert.notEqual(status.textContent, 'Voice paused.');
      assert.equal(page.requests.length, 2);
      assert.equal(page.requests[1].body.transcript, 'My arm hurts.');
      assert.equal(page.client.state.symptoms.length, 1);
    }, demoExtractor, true);
  });
}

test('pausing during analysis reconciles the manual screen with the eventual next question', async () => {
  await withPage(async page => {
    click(page,'#dailyCheckinButton');
    await until(()=>page.app.conversation.state.phase==='listening','listening');
    await page.speech.at(-1).turn('My arm hurts.');
    assert.equal(screen(page),'pain-score');
    let release!:()=>void;
    page.gate=new Promise<void>(resolve=>{release=resolve;});
    const turn=page.speech.at(-1).turn('6');
    await until(()=>page.client.busy,'score request sent');
    click(page,'#voicePause');
    assert.equal(ready(page),false);
    release();await turn;
    assert.equal(ready(page),true);
    assert.equal(page.client.state.nextQuestion.field,'firstOccurrence');
    assert.equal(screen(page),'guided');
    assert.equal((page.document.getElementById('followupAnswer') as HTMLTextAreaElement).value,'');
    assert.equal(page.app.conversation.active,false);
  },demoExtractor,true);
});

test('pausing the next spoken question does not paste a prior answer into its manual input',async()=>{
  await withPage(async page=>{
    click(page,'#dailyCheckinButton');
    await until(()=>page.app.conversation.state.phase==='listening','listening');
    await page.speech.at(-1).turn('My arm hurts.');
    let release!:()=>void;
    page.speakerGate=new Promise<void>(resolve=>{release=resolve;});
    const turn=page.speech.at(-1).turn('7');
    await until(()=>screen(page)==='guided'&&page.app.conversation.state.phase==='speaking','speaking next question');
    click(page,'#voicePause');
    assert.equal((page.document.getElementById('followupAnswer') as HTMLTextAreaElement).value,'');
    assert.equal(page.client.state.symptoms[0].severityScore,7);
    release();await turn;
    assert.ok(page.speech.every(input=>!input.isActive));
  },demoExtractor,true);
});


test('voice screen distinguishes microphone connection from ready to listen', async () => {
  await withPage(async page => {
    click(page, '#dailyCheckinButton');
    await until(() => page.app.conversation.state.phase === 'listening', 'voice listening');
    const input = page.speech.at(-1);
    input.status({type:'connecting',message:'Starting microphone audio…'});
    assert.equal(page.document.querySelector('[data-screen="listening"] h2')?.textContent, 'Connecting your microphone…');
    assert.equal(page.document.getElementById('integrationStatus')?.textContent, 'Starting microphone audio…');
    assert.equal((page.document.querySelector('.voice-wave') as HTMLElement).hidden, true);
    input.status({type:'listening',message:'Listening with ElevenLabs…'});
    assert.equal(page.document.querySelector('[data-screen="listening"] h2')?.textContent, "I'm listening");
    assert.equal((page.document.querySelector('.voice-wave') as HTMLElement).hidden, false);
    click(page, '#voicePause');
  }, demoExtractor, true);
});
