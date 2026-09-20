import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Checkins } from '../src/checkins.js';
import { createGeminiExtractor, type Extractor } from '../src/extractor.js';
import type { ExtractionResult } from '../src/followups.js';
import { emptyRecord, type CheckinResponse, type Extraction } from '../src/schema.js';

const pain = (name = 'head pain', location = 'head'): Extraction['symptoms'][number] => ({
  id: null, name, location, severity: null, severityScore: null, trend: null,
  duration: null, functionalImpact: null, firstOccurrence: null,
});
const review = { action: 'review', category: null, entityId: null, extractionIndex: null, field: null, text: null };
const ask = (field: string, text: string, extractionIndex = 0) => ({
  action: 'ask', category: 'symptoms', entityId: null, extractionIndex, field, text,
});
const facts = (symptoms: Extraction['symptoms'], followUp?: unknown): ExtractionResult => ({ ...emptyRecord(), symptoms, followUp });
const session = (state: CheckinResponse) => ({ sessionId: state.sessionId, version: state.version });
const adaptive = (extract: Extractor['extract']) => new Checkins({ mode: 'gemini', adaptiveQuestions: true, extract });

test('generated question targets the merged entity, survives resume, and uses a multi-detail typed answer', async () => {
  let calls = 0;
  const wording = 'When did your head pain start?';
  const store = adaptive(async (transcript, record, question, context) => {
    calls++;
    if (calls === 1) return facts([pain()], ask('duration', wording));
    assert.equal(transcript, 'Since breakfast. Six out of ten, and reading is difficult.');
    assert.equal(question?.text, wording);
    assert.equal(question?.id, `${record.symptoms[0].id}:duration`);
    assert.deepEqual(context?.askedQuestionIds, [question!.id]);
    assert.equal(context?.remainingQuestions, 5);
    return facts([{ ...record.symptoms[0], duration: 'since breakfast', severityScore: 6, functionalImpact: 'Reading is difficult' }], review);
  });
  const initial = await store.analyze({ transcript: 'My head hurts.', painScale: '1-10' });
  assert.equal(initial.nextQuestion?.text, wording);
  assert.equal(initial.nextQuestion?.entityId, initial.symptoms[0].id);
  const paused = await store.analyze({ ...session(initial), action: 'review' });
  assert.equal(paused.nextQuestion, null);
  const resumed = await store.analyze({ ...session(paused), action: 'resume' });
  assert.deepEqual(resumed.nextQuestion, initial.nextQuestion);
  const final = await store.analyze({ ...session(resumed), answer: {
    questionId: resumed.nextQuestion!.id, value: 'Since breakfast. Six out of ten, and reading is difficult.',
  } });
  assert.equal(calls, 2);
  assert.equal(final.status, 'review');
  assert.equal(final.symptoms[0].severityScore, 6);
  assert.equal(final.symptoms[0].duration, 'since breakfast');
  assert.equal(final.symptoms[0].functionalImpact, 'Reading is difficult');
  assert.equal(final.reportedAnswers?.at(-1)?.question, wording);
  assert.equal(final.savedAt, null);
  assert.equal(store.save({ ...session(final), confirmed: true }).status, 'saved');
});

test('a proposed question about the second symptom never updates the first symptom', async () => {
  let calls = 0;
  const store = adaptive(async (_text, record, question) => {
    if (++calls === 1) return facts([pain('arm pain', 'arm'), pain('leg pain', 'leg')],
      ask('severity', 'On a scale of 1 to 10, how strong is the leg pain?', 1));
    assert.equal(question?.entityId, record.symptoms[1].id);
    return facts([{ ...record.symptoms[1], severityScore: 7 }], review);
  });
  const initial = await store.analyze({ transcript: 'My arm and leg hurt.', painScale: '1-10' });
  assert.equal(initial.symptoms.length, 2);
  assert.equal(initial.nextQuestion?.entityId, initial.symptoms[1].id);
  const final = await store.analyze({ ...session(initial), questionId: initial.nextQuestion!.id, transcript: 'Seven.' });
  assert.equal(final.symptoms[0].severityScore, null);
  assert.equal(final.symptoms[1].severityScore, 7);
});

test('numeric buttons receive contextual planning while skips need no Gemini call and cannot repeat targets', async () => {
  let calls = 0;
  const store = adaptive(async (_text, record) => {
    if (++calls === 1) return facts([pain()], ask('severity', 'How strong is your head pain, from 1 to 10?'));
    assert.equal(record.symptoms[0].severityScore, 5);
    return facts([], { ...ask('duration', 'When did the head pain start?'),
      extractionIndex: null, entityId: record.symptoms[0].id });
  });
  let state = await store.analyze({ transcript: 'My head hurts.', painScale: '1-10' });
  const ids = [state.nextQuestion!.id];
  state = await store.analyze({ ...session(state), answer: { questionId: state.nextQuestion!.id, value: '5' } });
  assert.equal(state.symptoms[0].severityScore, 5);
  assert.equal(state.nextQuestion?.text, 'When did the head pain start?');
  ids.push(state.nextQuestion!.id);
  state = await store.analyze({ ...session(state), action: 'skip' });
  assert.equal(state.status, 'review');
  assert.equal(calls, 2);
  assert.equal(new Set(ids).size, 2);
});

test('malformed planning preserves facts; a reworded already answered field falls back', async () => {
  let calls = 0;
  const store = adaptive(async (_text, record) => {
    if (++calls === 1) return facts([pain()], { action: 'ask', text: 'invalid missing target' });
    return facts([{ ...record.symptoms[0], severityScore: 4 }], {
      ...ask('severity', 'What is the pain level from 1 to 10?'), entityId: record.symptoms[0].id, extractionIndex: null,
    });
  });
  const initial = await store.analyze({ transcript: 'My head hurts.', painScale: '1-10' });
  assert.equal(initial.symptoms[0].name, 'head pain');
  assert.equal(initial.nextQuestion?.field, 'severity');
  const next = await store.analyze({ ...session(initial), questionId: initial.nextQuestion!.id, transcript: 'Four.' });
  assert.equal(next.symptoms[0].severityScore, 4);
  assert.notEqual(next.nextQuestion?.field, 'severity');
});

test('context answer is kept verbatim, not assigned to an invented record field', async () => {
  let calls = 0;
  const wording = 'Have you noticed other symptoms along with your head pain?';
  const store = adaptive(async (_text, _record, question) => {
    if (++calls === 1) return facts([pain()], ask('context', wording));
    assert.equal(question?.field, 'context');
    return facts([], review);
  });
  const first = await store.analyze({ transcript: 'My head hurts.', painScale: '1-10' });
  assert.equal(first.nextQuestion?.text, wording);
  const final = await store.analyze({ ...session(first), answer: { questionId: first.nextQuestion!.id, value: 'Nothing else that I noticed.' } });
  assert.equal(final.status, 'review');
  assert.equal('context' in final.symptoms[0], false);
  const saved = store.save({ ...session(final), confirmed: true });
  assert.equal(saved.reportedAnswers?.at(-1)?.transcript, 'Nothing else that I noticed.');
  assert.equal(saved.reportedAnswers?.at(-1)?.question, wording);
});

test('unavailable provider does not consume the pending question, version or question budget', async () => {
  let calls = 0;
  const store = adaptive(async (_text, record, question, context) => {
    if (++calls === 1) return facts([pain()], ask('duration', 'When did your head pain begin?'));
    assert.equal(context?.askedQuestionIds.length, 1);
    assert.equal(question?.field, 'duration');
    if (calls === 2) throw new Error('temporary provider failure');
    return facts([{ ...record.symptoms[0], duration: 'today' }], review);
  });
  const initial = await store.analyze({ transcript: 'My head hurts.', painScale: '1-10' });
  const input = { ...session(initial), questionId: initial.nextQuestion!.id, transcript: 'Today.' };
  await assert.rejects(store.analyze(input), /temporary provider failure/);
  const final = await store.analyze(input);
  assert.equal(final.version, initial.version + 1);
  assert.equal(final.reportedAnswers?.length, 2);
});

test('six-question cap applies across multiple symptoms and explicit skipped answers', async () => {
  const store = adaptive(async () => facts([pain('arm pain', 'arm'), pain('leg pain', 'leg'), pain()]));
  let state = await store.analyze({ transcript: 'My arm, leg and head hurt.', painScale: '1-10' });
  const ids: string[] = [];
  while (state.nextQuestion) {
    ids.push(state.nextQuestion.id);
    assert.ok(ids.length <= 6);
    state = await store.analyze({ ...session(state), answer: { questionId: state.nextQuestion.id, value: "I'm not sure" } });
  }
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
  assert.equal(state.status, 'review');
});

test('wellness and meal-only reports can finish without opening unrelated categories', async () => {
  for (const extracted of [
    { ...emptyRecord(), wellness: { status: 'well' as const, statement: 'I feel fine today.' } },
    { ...emptyRecord(), diet: [{ id: null, description: 'oatmeal', time: 'breakfast' }] },
  ]) {
    const store = adaptive(async () => ({ ...extracted, followUp: review }));
    const final = await store.analyze({ transcript: 'Fictional check-in.', painScale: '1-10' });
    assert.equal(final.status, 'review');
    assert.equal(final.nextQuestion, null);
    assert.equal(final.symptoms.length, 0);
    assert.equal(final.medications.length, 0);
    assert.equal(final.vitals.length, 0);
  }
});

test('both Gemini endpoints return planning in the same extraction request', async () => {
  for (const model of ['gemini-2.5-flash', 'gemini-3.6-flash']) {
    let calls = 0;
    const output = facts([pain()], ask('duration', 'When did your head pain begin?'));
    const extractor = createGeminiExtractor({ apiKey: 'fictional', model, fetcher: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const generate = model === 'gemini-2.5-flash';
      const schema = generate ? body.generationConfig.responseJsonSchema : body.response_format.schema;
      assert.ok(schema.properties.followUp);
      const input = JSON.parse(generate ? body.contents[0].parts[0].text : body.input);
      assert.equal(input.questionContext.remainingQuestions, 6);
      assert.deepEqual(input.questionContext.askedQuestionIds, []);
      return new Response(JSON.stringify(generate
        ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(output) }] } }] }
        : { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(output) }] }] }));
    } });
    const state = await new Checkins(extractor).analyze({ transcript: 'My head hurts.', painScale: '1-10' });
    assert.equal(calls, 1);
    assert.equal(state.nextQuestion?.text, 'When did your head pain begin?');
  }
});
