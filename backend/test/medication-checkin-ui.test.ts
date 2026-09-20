import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const medication = (id: string, name: string | null, status: string | null = 'taken') => ({
  id, name, status, description: null, dose: null, time: null,
});
const review = (sessionId: string, medications: any[]) => ({
  schemaVersion: '1.0', sessionId, version: 1, status: 'review', extractionMode: 'gemini',
  symptoms: [], medications, diet: [], vitals: [], wellness: null, reportedAnswers: [],
  nextQuestion: null, missingFields: [], skippedFields: [], notices: [],
});
const listed = (id: string, name: string, schedule = 'Morning', dose = '5 mg') => ({ id, name, schedule, dose });
const twiceDaily = [listed('morning', 'Metformin'), listed('afternoon', ' metformin ', 'Afternoon')];
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Medication check-in UI did not settle');
    await new Promise(resolve => setImmediate(resolve));
  }
};

async function withPage(medications: any[], starts: any[], run: (page: any) => Promise<void>) {
  const dom = new JSDOM(await read('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const window = dom.window as any;
  window.scrollTo = () => {};
  window.structuredClone = structuredClone;
  window.eval(await read('frontend/profile-store.js'));
  window.PulsewiseProfile.save({ displayName: 'Kim', onboardingCompleted: true, medications });
  const [{ mountVersionB }, { createCheckinClient }, tracker] = await Promise.all([
    import(new URL('../../frontend/new-ui.js', import.meta.url).href),
    import(new URL('../../frontend/checkin-api.js', import.meta.url).href),
    import(new URL('../../frontend/medications.js', import.meta.url).href),
  ]);
  const document = window.document;
  const page: any = { document, window, tracker, requests: [], failNextSave: false, saveGate: null };
  let response: any;
  const client = createCheckinClient({ flow: 'brief', fetchImpl: async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    page.requests.push({ path, body });
    if (path.endsWith('/save')) {
      if (page.saveGate) await page.saveGate;
      if (page.failNextSave) {
        page.failNextSave = false;
        return Response.json({ error: { code: 'SAVE_FAILED', message: 'Please retry saving.' } }, { status: 502 });
      }
      response = { ...response, ...body.record, status: 'saved', version: response.version + 1 };
    } else if (!body.sessionId) {
      assert.ok(starts.length, 'An expected typed check-in response is available');
      response = structuredClone(starts.shift());
    } else response = { ...response, version: response.version + 1 };
    return Response.json(response);
  } });
  page.client = client;
  page.medicationView = tracker.mountMedications(document);
  page.app = mountVersionB(document, {
    client, mealClient: client, initialProfile: window.PulsewiseProfile.read(), profileStore: window.PulsewiseProfile,
    conversationEnabled: false,
    speechFactory: ({ textarea }: any) => ({ available: false, isActive: false,
      async start() {}, async finish() { return textarea.value; }, cancel() {}, destroy() {} }),
    speakerFactory: () => ({ stop() {}, destroy() {} }),
  });
  page.click = (selector: string) => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    element.click();
  };
  page.fill = (selector: string, value: string) => {
    const element = document.querySelector(selector);
    assert.ok(element, selector);
    element.value = value;
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  page.settle = () => until(() => document.getElementById('checkinFlow').getAttribute('aria-busy') !== 'true');
  page.start = async (transcript = 'I took my medication today.') => {
    page.app.open();
    page.click('#flowType');
    page.fill('#flowTranscript', transcript);
    page.click('.flow-done');
    await page.settle();
    assert.equal(page.app.getCurrentScreen(), 'review');
  };
  page.save = async () => { page.click('#reviewConfirmSave'); await page.settle(); };
  page.progress = () => [...document.querySelectorAll('#medTileValue .med-progress-row')].map((row: any) => ({
    name: row.querySelector('.med-progress-name').textContent.trim(),
    count: row.querySelector('.med-progress-count').textContent.trim(),
    complete: row.classList.contains('is-complete'),
    check: row.querySelector('.med-progress-check')?.textContent ?? null,
    label: row.getAttribute('aria-label'),
  }));
  page.more = () => { page.click('#desktopMoreNav'); page.click('[data-more="medications"]'); };
  page.add = (name: string, schedule = 'Morning', dose = '5 mg') => {
    page.click('[data-action="add-medication"]');
    page.fill('#medFormName', name);
    page.fill('#medFormDose', dose);
    page.fill('#medFormSchedule', schedule);
    page.click('[data-action="save-new-medication"]');
  };
  try { await run(page); }
  finally {
    page.releaseSave?.();
    await page.settle();
    page.app.destroy();
    page.medicationView?.destroy();
    dom.window.close();
  }
}

test('typed check-in waits for confirmation and counts the edited medication names and statuses', async () => {
  await withPage([...twiceDaily, listed('aspirin', 'Aspirin')], [review('edited', [
    medication('correct-name', 'Metformn', 'mentioned'), medication('correct-status', 'Aspirin'),
    medication('unlisted', 'Unlisted medicine'),
  ])], async page => {
    assert.deepEqual(page.progress().map((row: any) => [row.name, row.count]), [['Metformin', '0/2'], ['Aspirin', '0/1']]);
    await page.start('I took Metformin; I missed my Aspirin.');
    assert.equal(page.requests[0].body.transcript, 'I took Metformin; I missed my Aspirin.');
    assert.equal(page.requests.filter((request: any) => request.path.endsWith('/save')).length, 0);
    page.click('#reviewMedications [data-record-id="correct-name"] [data-edit-review]');
    page.fill('[data-record-id="correct-name"][data-record-field="name"]', '  METFORMIN  ');
    page.fill('[data-record-id="correct-name"][data-record-field="status"]', 'taken');
    page.click('#reviewMedications [data-record-id="correct-status"] [data-edit-review]');
    page.fill('[data-record-id="correct-status"][data-record-field="status"]', 'missed');
    assert.deepEqual(page.progress().map((row: any) => row.count), ['0/2', '0/1']);
    await page.save();
    assert.equal(page.client.state.status, 'saved');
    const saved = page.requests.find((request: any) => request.path.endsWith('/save')).body;
    assert.equal(saved.confirmed, true);
    assert.equal(saved.record.medications[0].name, 'METFORMIN');
    assert.equal(saved.record.medications[1].status, 'missed');
    assert.deepEqual(page.progress().map((row: any) => [row.count, row.complete, row.check]), [['1/2', false, null], ['0/1', false, null]]);
    assert.equal(page.progress()[0].label, 'Metformin: 1 of 2 doses recorded today');
    assert.equal(page.window.PulsewiseProfile.read().medications.length, 3, 'Check-ins cannot add medicines to the saved list');
    assert.equal(page.document.querySelectorAll('#medRows tr').length, 3);
  });
});

test('failed saves, duplicate clicks and replay do not count twice; two saved sessions complete two scheduled rows', async () => {
  await withPage(twiceDaily, [
    review('morning-session', [medication('first', 'Metformin'), medication('same-report', 'metformin')]),
    review('afternoon-session', [medication('second', 'METFORMIN')]),
  ], async page => {
    await page.start();
    page.failNextSave = true;
    await page.save();
    assert.equal(page.client.state.status, 'review');
    assert.equal(page.document.getElementById('integrationError').hidden, false);
    assert.equal(page.progress()[0].count, '0/2');
    page.saveGate = new Promise<void>(resolve => { page.releaseSave = resolve; });
    page.click('#reviewConfirmSave');
    page.click('#reviewConfirmSave');
    assert.equal(page.document.getElementById('reviewConfirmSave').disabled, true);
    assert.equal(page.progress()[0].count, '0/2', 'Pending saves do not count');
    page.releaseSave();
    await page.settle();
    assert.equal(page.requests.filter((request: any) => request.path.endsWith('/save')).length, 2, 'One failed request and one successful retry');
    assert.equal(page.progress()[0].count, '1/2', 'Repeated mentions count once per saved session');
    assert.equal(page.progress()[0].complete, false);
    const saved = page.client.state;
    page.tracker.recordMedicationCheckin(page.window, saved);
    page.tracker.recordMedicationCheckin(page.window, { ...saved, version: saved.version + 1 });
    page.medicationView.destroy();
    page.medicationView = page.tracker.mountMedications(page.document);
    assert.equal(page.progress()[0].count, '1/2', 'Deduplication and counts survive tracker remount');
    page.saveGate = null;
    await page.start('I took my afternoon Metformin.');
    assert.equal(page.progress()[0].count, '1/2');
    await page.save();
    assert.equal(page.progress()[0].count, '2/2');
    assert.equal(page.progress()[0].complete, true);
    assert.equal(page.progress()[0].check, '✓');
    assert.equal(page.progress()[0].label, 'Metformin: 2 of 2 doses recorded today. All scheduled doses recorded for today.');
    assert.equal(page.document.querySelector('[data-screen="trends"] p').textContent, 'Metformin: All scheduled doses recorded for today.');
  });
});

test('missed, stopped, mentioned and unknown statuses never count, and matching requires a named saved medicine', async () => {
  await withPage([listed('listed', 'Metformin')], [review('not-taken', [
    ...['missed', 'stopped', 'mentioned', null].map((status, index) => medication(`not-taken-${index}`, 'Metformin', status)),
    medication('unnamed', null), medication('different-name', 'Metformin XR'),
  ])], async page => {
    await page.start('I missed Metformin and mentioned stopping it.');
    await page.save();
    assert.equal(page.client.state.status, 'saved');
    assert.equal(page.progress()[0].count, '0/1');
    assert.equal(page.progress()[0].check, null);
    assert.equal(page.document.querySelectorAll('#medTileValue .med-progress-row').length, 1);
  });
});

test('More and the large medication list stay synchronized through add, edit and delete with a five-name limit', async () => {
  await withPage([
    listed('metformin', 'Metformin'), listed('aspirin', 'Aspirin'),
    listed('loratadine', 'Loratadine'), listed('vitamin', 'Vitamin D'),
  ], [], async page => {
    const stored = () => page.window.PulsewiseProfile.read().medications;
    const tableText = () => page.document.getElementById('medRows').textContent;
    page.more();
    page.click('[data-action="add-medication"]');
    for (const id of ['medFormName', 'medFormDose', 'medFormSchedule'])
      assert.ok(page.document.getElementById(id).labels.length, `${id} has an accessible label`);
    page.fill('#medFormName', 'Metformin');
    page.fill('#medFormDose', '10 mg');
    page.fill('#medFormSchedule', 'Afternoon');
    page.click('[data-action="save-new-medication"]');
    assert.equal(stored().length, 5);
    assert.equal(page.progress()[0].count, '0/2');
    assert.match(tableText(), /Metformin10 mgAfternoon/);

    // Add the fifth distinct name from the other editor, then observe it in More.
    page.click('#desktopHomeNav');
    page.fill('#medName', 'Zinc');
    page.fill('#medDose', '15 mg');
    page.fill('#medWhen', 'Evening');
    page.document.getElementById('medForm').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    page.more();
    assert.equal(stored().length, 6);
    assert.equal(page.document.querySelectorAll('#moreDetailBody [data-action="edit-medication"]').length, 6);
    assert.match(page.document.getElementById('moreDetailBody').textContent, /Zinc/);
    assert.equal(page.progress().length, 5);

    // The cap applies to distinct names, so another scheduled Metformin row is allowed.
    page.add(' METFORMIN ', 'Evening', '10 mg');
    assert.equal(stored().length, 7);
    assert.equal(page.progress()[0].count, '0/3');
    page.add('Magnesium');
    assert.equal(stored().length, 7);
    assert.match(page.document.getElementById('moreMedicationError').textContent, /five|5/i);
    assert.equal(page.progress().length, 5);
    assert.doesNotMatch(tableText(), /Magnesium/);
    page.click('[data-action="cancel-medication-form"]');

    const zincId = stored().find((entry: any) => entry.name === 'Zinc').id;
    page.click(`[data-action="edit-medication"][data-id="${zincId}"]`);
    page.fill('#medFormName', 'Zinc gluconate');
    page.fill('#medFormDose', '20 mg');
    page.fill('#medFormSchedule', 'Afternoon');
    page.click('[data-action="save-medication-edit"]');
    assert.match(tableText(), /Zinc gluconate20 mgAfternoon/);
    assert.equal(stored().find((entry: any) => entry.id === zincId).name, 'Zinc gluconate');
    assert.ok(page.progress().some((row: any) => row.name === 'Zinc gluconate' && row.count === '0/1'));

    page.click('[data-action="edit-medication"][data-id="metformin"]');
    page.click('[data-action="delete-medication"]');
    assert.equal(stored().length, 6);
    assert.equal(page.progress().find((row: any) => row.name.toLowerCase() === 'metformin').count, '0/2');
    assert.equal(page.document.querySelectorAll('#medRows tr').length, 6);
    page.click('#desktopHomeNav');
    page.click('#medRows [aria-label="Remove Aspirin"]');
    page.more();
    assert.equal(stored().length, 5);
    assert.equal(page.progress().length, 4);
    assert.doesNotMatch(page.document.querySelector('#moreDetailBody .more-detail-list').textContent, /Aspirin/);
  });
});

test('a failed More medication write keeps the form retryable and does not change either medication list', async () => {
  await withPage([listed('original', 'Metformin')], [], async page => {
    page.more();
    const patch = page.window.PulsewiseProfile.patch;
    page.window.PulsewiseProfile.patch = () => { throw new Error('Storage unavailable'); };
    page.add('Aspirin');
    assert.equal(page.window.PulsewiseProfile.read().medications.length, 1);
    assert.equal(page.document.querySelectorAll('#medRows tr').length, 1);
    assert.deepEqual(page.progress().map((row: any) => row.name), ['Metformin']);
    assert.match(page.document.getElementById('moreMedicationError').textContent, /sav|retry|storage/i);
    assert.equal(page.document.getElementById('medFormName').value, 'Aspirin');
    page.window.PulsewiseProfile.patch = patch;
    page.click('[data-action="save-new-medication"]');
    assert.equal(page.window.PulsewiseProfile.read().medications.length, 2);
    assert.equal(page.document.querySelectorAll('#medRows tr').length, 2);
    assert.deepEqual(page.progress().map((row: any) => row.name), ['Metformin', 'Aspirin']);
  });
});

test('editing a dose in More preserves custom and unspecified onboarding schedules', async () => {
  await withPage([
    listed('custom-schedule', 'Metformin', 'After breakfast'),
    listed('blank-schedule', 'Aspirin', ''),
  ], [], async page => {
    page.more();
    for (const [id, schedule] of [['custom-schedule', 'After breakfast'], ['blank-schedule', '']]) {
      page.click(`[data-action="edit-medication"][data-id="${id}"]`);
      const select = page.document.getElementById('medFormSchedule');
      assert.equal(select.value, schedule);
      assert.equal(select.selectedOptions[0].textContent, schedule || 'Not specified');
      page.fill('#medFormDose', '10 mg');
      page.click('[data-action="save-medication-edit"]');
      const saved = page.window.PulsewiseProfile.read().medications.find((entry: any) => entry.id === id);
      assert.equal(saved.dose, '10 mg');
      assert.equal(saved.schedule, schedule);
      assert.equal(saved.when, schedule);
      const row = [...page.document.querySelectorAll('#medRows tr')].find((entry: any) => entry.cells[0].textContent === saved.name) as any;
      assert.equal(row.cells[1].textContent, '10 mg');
      assert.equal(row.cells[2].textContent, schedule || '—');
    }
  });
});
