import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Checkins } from '../src/checkins.js';
import { createGeminiExtractor, demoExtractor, type Extractor } from '../src/extractor.js';
import { analyzeInputSchema, emptyRecord, type CheckinResponse, type Extraction } from '../src/schema.js';
const { mealsFromBackend } = await import(new URL('../../frontend/version-b-adapter.js', import.meta.url).href);

const pain = (name = 'arm pain', location = 'arm'): Extraction['symptoms'][number] => ({
  id: null, name, location, severity: null, severityScore: null, functionalImpact: null,
  duration: null, trend: null, firstOccurrence: null,
});
const session = (state: CheckinResponse) => ({ sessionId: state.sessionId, version: state.version });
const details = { action: 'ask', category: 'symptoms', field: 'details', entityId: null,
  extractionIndex: 0, text: 'Could you share a few details about your arm pain using the notes below?' };
const storeWith = (extract: Extractor['extract']) => new Checkins({ mode: 'gemini', adaptiveQuestions: true, extract });

test('brief flow asks once, extracts several details, then finishes despite missing fields and another proposed question', async () => {
  let calls = 0;
  const store = storeWith(async (_text, record, question, context) => {
    assert.equal(context?.flow, 'brief');
    if (++calls === 1) {
      assert.equal(context.remainingQuestions, 1);
      return { ...emptyRecord(), symptoms: [pain()], followUp: details };
    }
    assert.equal(context.remainingQuestions, 0);
    assert.equal(question?.field, 'details');
    assert.equal(question?.text, details.text);
    return { ...emptyRecord(), symptoms: [{ ...record.symptoms[0], location: 'left forearm', severityScore: 2,
      functionalImpact: 'Getting dressed hurts', duration: 'since yesterday' }], followUp: {
      ...details, field: 'trend', entityId: record.symptoms[0].id, extractionIndex: null, text: 'Is the pain better or worse?',
    } };
  });
  const first = await store.analyze({ transcript: 'My arm hurts.', painScale: '1-10', flow: 'brief' });
  assert.equal(first.nextQuestion?.field, 'details');
  const final = await store.analyze({ ...session(first), questionId: first.nextQuestion!.id,
    transcript: 'My left forearm is two out of ten, since yesterday. Getting dressed hurts.' });
  assert.equal(calls, 2);
  assert.equal(final.status, 'review');
  assert.equal(final.nextQuestion, null);
  assert.equal(final.symptoms[0].severityScore, 2);
  assert.equal(final.symptoms[0].functionalImpact, 'Getting dressed hurts');
  assert.equal(final.symptoms[0].trend, null);
  const resumed = await store.analyze({ ...session(final), action: 'resume' });
  assert.equal(resumed.status, 'review');
  assert.equal(store.save({ ...session(resumed), confirmed: true }).symptoms[0].severityScore, 2);
});

test('brief short numeric replies, including STT clock notation, save 2/10 without another model call', async () => {
  for (const value of ["It's 2.", 'two', "It's 2:00.", '2:00']) {
    let calls = 0;
    const store = storeWith(async () => {
      assert.equal(++calls, 1, 'A clear score-only final reply does not need Gemini');
      return { ...emptyRecord(), symptoms: [pain()], followUp: details };
    });
    const first = await store.analyze({ transcript: 'My arm hurts.', painScale: '1-10', flow: 'brief' });
    const final = await store.analyze({ ...session(first), questionId: first.nextQuestion!.id, transcript: value });
    assert.equal(final.status, 'review');
    assert.equal(final.symptoms[0].severityScore, 2);
    assert.equal(final.symptoms[0].duration, null);
    assert.equal(final.reportedAnswers?.at(-1)?.transcript, value, 'Keep the original speech text for review');
    assert.equal(store.save({ ...session(final), confirmed: true }).symptoms[0].severityScore, 2);
  }
});

test('a clock-like answer to an existing severity question is also preserved when Gemini omits its score', async () => {
  let calls = 0;
  const store = storeWith(async (_text, record) => {
    if (++calls === 1) return { ...emptyRecord(), symptoms: [pain()], followUp: { ...details, field: 'severity', text: 'How strong is your arm pain from 1 to 10?' } };
    assert.equal(record.symptoms[0].severityScore, 2);
    return { ...emptyRecord() };
  });
  const first = await store.analyze({ transcript: 'My arm hurts.', painScale: '1-10' });
  assert.equal(first.nextQuestion?.field, 'severity');
  const next = await store.analyze({ ...session(first), questionId: first.nextQuestion!.id, transcript: "It's 2:00." });
  assert.equal(next.symptoms[0].severityScore, 2);
});

test('actual times are extracted as timing, never coerced into a pain score', async () => {
  let calls = 0;
  const store = storeWith(async (_text, record) => ++calls === 1
    ? { ...emptyRecord(), symptoms: [pain()] }
    : { ...emptyRecord(), symptoms: [{ ...record.symptoms[0], duration: 'started at 2:00 PM' }] });
  const first = await store.analyze({ transcript: 'My arm hurts.', flow: 'brief' });
  const final = await store.analyze({ ...session(first), questionId: first.nextQuestion!.id, transcript: 'It started at 2:00 PM.' });
  assert.equal(calls, 2);
  assert.equal(final.symptoms[0].severityScore, null);
  assert.equal(final.symptoms[0].duration, 'started at 2:00 PM');
  assert.equal(final.nextQuestion, null);
});

test('an unassigned bare score never guesses between multiple symptoms', async () => {
  let calls = 0;
  const store = storeWith(async () => {
    assert.equal(++calls, 1);
    return { ...emptyRecord(), symptoms: [pain(), pain('leg pain', 'leg')] };
  });
  const first = await store.analyze({ transcript: 'My arm and leg hurt.', flow: 'brief' });
  const final = await store.analyze({ ...session(first), questionId: first.nextQuestion!.id, transcript: "It's 2:00." });
  assert.deepEqual(final.symptoms.map(item => item.severityScore), [null, null]);
  assert.equal(final.reportedAnswers?.at(-1)?.interpretation, 'unconfirmed');
  assert.equal(final.status, 'review');
});

test('a partial answer or a skip ends the brief question without forcing unknown fields', async () => {
  for (const unknown of [false, true]) {
    const store = new Checkins(demoExtractor);
    const first = await store.analyze({ transcript: 'My arm hurts.', flow: 'brief', painScale: '1-10' });
    const final = await store.analyze({ ...session(first), questionId: first.nextQuestion!.id,
      ...(unknown ? { transcript: "I'm not sure" } : { action: 'skip' as const }) });
    assert.equal(final.status, 'review');
    assert.equal(final.symptoms[0].severityScore, null);
    assert.equal(final.nextQuestion, null);
  }
});

test('brief symptom-free check-ins finish without questions in demo mode', async () => {
  for (const transcript of ['I ate pizza.', 'I feel fine today.', 'I forgot my prednisone.', 'My heart rate is 70 bpm.', 'I drank two glasses of water.']) {
    const response = await new Checkins(demoExtractor).analyze({ transcript, flow: 'brief' });
    assert.equal(response.status, 'review', transcript);
    assert.equal(response.nextQuestion, null, transcript);
  }
});

test('water counts are structured without assuming glass size or turning other drinks into water', async () => {
  const cases = [
    ['I drank two glasses of water.', 2, 'add'],
    ['I drank five glasses of water today.', 5, 'total'],
    ['I drank two more glasses of water today.', 2, 'add'],
    ['I drank 1.5 glasses of water.', 1.5, 'add'],
    ['I drank 500 ml of water.', null, 'add'],
    ['I drank water.', null, 'add'],
  ] as const;
  for (const [transcript, count, mode] of cases) {
    const store = new Checkins(demoExtractor);
    const result = await store.analyze({ transcript, flow: 'brief' });
    assert.equal(result.diet[0].waterGlasses, count, transcript);
    assert.equal(result.diet[0].waterMode, mode, transcript);
    assert.equal(store.save({ ...session(result), confirmed: true }).diet[0].waterGlasses, count);
  }
  const coffee = await demoExtractor.extract('I drank two cups of coffee.', emptyRecord(), null);
  assert.equal(coffee.diet[0].waterGlasses, undefined);
  const negative = await demoExtractor.extract("I didn't drink water.", emptyRecord(), null);
  assert.equal(negative.diet.length, 0);
});

test('demo separates a combined breakfast food and water report without moving food to Snacks', async () => {
  const store = new Checkins(demoExtractor);
  const result = await store.analyze({ transcript: 'I ate oatmeal and drank two glasses of water for breakfast.', flow: 'brief' });
  assert.equal(result.status, 'review');
  assert.equal(result.nextQuestion, null);
  assert.equal(result.diet.length, 2);
  const logs = mealsFromBackend(result, { unknownMeal: 'snacks' });
  assert.deepEqual(logs.meals, [{ mealType: 'breakfast', items: ['I ate oatmeal'] }]);
  assert.equal(logs.hydration.length, 1);
  assert.equal(logs.hydration[0].glasses, 2);
  assert.equal(logs.hydration[0].mode, 'add');
  assert.deepEqual(store.save({ ...session(result), confirmed: true }).diet, result.diet);
});

test('demo keeps an additional coordinated water count when the drinking verb is shared', async () => {
  const store = new Checkins(demoExtractor);
  const result = await store.analyze({ transcript: 'I drank one glass of water and two more glasses of water.', flow: 'brief' });
  assert.equal(result.nextQuestion, null);
  assert.deepEqual(result.diet.map(entry => [entry.waterGlasses, entry.waterMode]), [[1, 'add'], [2, 'add']]);
  const logs = mealsFromBackend(result, { unknownMeal: 'snacks' });
  assert.deepEqual(logs.meals, []);
  assert.equal(logs.hydration.reduce((sum: number, entry: { glasses: number | null }) => sum + (entry.glasses ?? 0), 0), 3);
  assert.deepEqual(store.save({ ...session(result), confirmed: true }).diet, result.diet);
});

test('brief flow is selected once and cannot be changed mid-session', () => {
  assert.equal(analyzeInputSchema.safeParse({ transcript: 'My arm hurts.', flow: 'brief' }).success, true);
  assert.equal(analyzeInputSchema.safeParse({ sessionId: '89135247-e837-4d71-a568-b88e4ab8989e', version: 1,
    transcript: 'Two.', flow: 'brief' }).success, false);
});

test('Gemini receives the brief policy and hydration schema in the existing extraction request', async () => {
  let calls = 0;
  const store = new Checkins(createGeminiExtractor({ apiKey: 'fictional', model: 'gemini-2.5-flash', fetcher: async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    const input = JSON.parse(request.contents[0].parts[0].text);
    assert.equal(input.questionContext.flow, 'brief');
    assert.match(request.systemInstruction.parts[0].text, /one|ONE/);
    assert.ok(request.generationConfig.responseJsonSchema.properties.diet.items.properties.waterGlasses);
    const extraction = { ...emptyRecord(), diet: [{ id: null, description: 'two glasses of water', time: null, waterGlasses: 2, waterMode: 'add' }] };
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(extraction) }] } }] });
  } }));
  const final = await store.analyze({ transcript: 'I drank two glasses of water.', flow: 'brief' });
  assert.equal(calls, 1);
  assert.equal(final.nextQuestion, null);
  assert.equal(final.diet[0].waterGlasses, 2);
});
