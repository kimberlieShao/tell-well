import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const symptom = (extra: Record<string, unknown> = {}) => ({
  id: 'arm', name: 'arm pain', location: null, severity: null, severityScore: null,
  functionalImpact: null, duration: null, trend: null, firstOccurrence: null, ...extra,
});

async function review(symptoms: any[], run: (page: any) => Promise<void> | void) {
  const dom = new JSDOM(await readFile(new URL('../../index.html', import.meta.url), 'utf8'), {
    url: 'https://example.test/app', runScripts: 'outside-only',
  });
  dom.window.scrollTo = () => {};
  const [{ mountVersionB }, { createCheckinClient }] = await Promise.all([
    import(new URL('../../frontend/new-ui.js', import.meta.url).href),
    import(new URL('../../frontend/checkin-api.js', import.meta.url).href),
  ]);
  let saved: any;
  const state = { schemaVersion: '1.0', sessionId: 'review', version: 1, status: 'review',
    extractionMode: 'gemini', symptoms, medications: [], diet: [], vitals: [], wellness: null,
    reportedAnswers: [], nextQuestion: null, missingFields: [], skippedFields: [], notices: [] };
  const client = createCheckinClient({ flow: 'brief', fetchImpl: async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (path.endsWith('/save')) {
      saved = body.record;
      return Response.json({ ...state, ...saved, status: 'saved', version: 2 });
    }
    return Response.json(state);
  } });
  const document = dom.window.document;
  const app = mountVersionB(document, { client, mealClient: client, conversationEnabled: false,
    speechFactory: ({ textarea }: any) => ({ available: true, mode: 'form', isActive: false,
      async start() {}, async finish() { return textarea.value; }, cancel() {}, destroy() {} }),
  });
  const settle = async () => {
    const deadline = Date.now() + 2000;
    while (document.getElementById('checkinFlow')!.getAttribute('aria-busy') === 'true') {
      if (Date.now() > deadline) throw new Error('Review did not settle');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  };
  try {
    app.open();
    document.getElementById('flowType')!.click();
    const transcript = document.getElementById('flowTranscript') as HTMLTextAreaElement;
    transcript.value = 'My arm hurts.';
    transcript.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    document.querySelector<HTMLElement>('.flow-done')!.click();
    await settle();
    assert.equal(app.getCurrentScreen(), 'review');
    const rows = (index = 0) => Object.fromEntries([...document.querySelectorAll('.brief-symptom-table')[index].querySelectorAll('tr')]
      .map(row => [row.querySelector('th')!.textContent, row.querySelector('td')!.textContent]));
    await run({ app, document, rows, settle, get saved() { return saved; } });
  } finally { app.destroy(); dom.window.close(); }
}

test('one consolidated complaint renders one populated table with consistent unknown values', async () => {
  await review([symptom({ name: 'arm pain and itchiness', location: 'elbows', severityScore: 2,
    functionalImpact: 'problems with eating', duration: 'started yesterday' })], page => {
    assert.equal(page.document.querySelectorAll('.brief-symptom-table').length, 1);
    assert.deepEqual(page.rows(), {
      Symptom: 'arm pain and itchiness', Location: 'elbows', 'Pain score (1–10)': '2',
      Activities: 'problems with eating', 'Since when': 'started yesterday',
      Trend: 'Not Provided', 'First time': 'Not Provided',
    });
  });
});

test('pain and nonpain use the same missing-value label without storing that label as health data', async () => {
  await review([symptom(), symptom({ id: 'nausea', name: 'nausea', severity: 'mild' })], async page => {
    for (const index of [0, 1]) {
      const rows = page.rows(index);
      for (const field of ['Location', 'Pain score (1–10)', 'Activities', 'Since when', 'Trend', 'First time'])
        assert.equal(rows[field], 'Not Provided', `${index}: ${field}`);
    }
    assert.equal(page.rows(1).Severity, 'mild');
    const reviewSection = page.document.getElementById('reviewSymptoms');
    assert.doesNotMatch(reviewSection.textContent, /N\/A|Not provided/);
    for (const option of reviewSection.querySelectorAll('option[value=""]')) assert.equal(option.textContent, 'Not Provided');
    page.document.getElementById('reviewConfirmSave').click();
    await page.settle();
    assert.equal(page.saved.symptoms[0].severityScore, null);
    assert.equal(page.saved.symptoms[1].location, null);
    assert.doesNotMatch(JSON.stringify(page.saved), /Not Provided/);
  });
});

test('the review renderer retains zero and false values instead of treating them as missing', async () => {
  // Rendering must faithfully preserve received values; validation is separate.
  await review([symptom({ severityScore: 0, firstOccurrence: false, functionalImpact: '   ' })], page => {
    assert.equal(page.rows()['Pain score (1–10)'], '0');
    assert.equal(page.rows()['First time'], 'No');
    assert.equal(page.rows().Activities, 'Not Provided');
  });
});
