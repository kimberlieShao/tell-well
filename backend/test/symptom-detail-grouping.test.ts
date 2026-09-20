import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Checkins } from '../src/checkins.js';
import type { Extractor } from '../src/extractor.js';
import { emptyRecord, type CheckinResponse, type Extraction, type HealthRecord } from '../src/schema.js';

type SymptomPatch = Extraction['symptoms'][number];
const symptom = (name: string, location: string | null, fields: Partial<SymptomPatch> = {}): SymptomPatch => ({
  id: null, name, location, severity: null, severityScore: null, functionalImpact: null,
  duration: null, trend: null, firstOccurrence: null, ...fields,
});
const session = (state: CheckinResponse) => ({ sessionId: state.sessionId, version: state.version });

async function answerDetails(initial: SymptomPatch[], initialTranscript: string, transcript: string,
  patches: (record: HealthRecord) => SymptomPatch[]) {
  let calls = 0;
  const extract: Extractor['extract'] = async (_text, record, question, context) => {
    assert.equal(context?.flow, 'brief');
    calls++;
    if (calls === 1) return { ...emptyRecord(), symptoms: initial };
    assert.equal(calls, 2, 'The single details answer should need only one extraction request');
    assert.equal(question?.field, 'details');
    assert.equal(context?.remainingQuestions, 0);
    return { ...emptyRecord(), symptoms: patches(record) };
  };
  const store = new Checkins({ mode: 'gemini', adaptiveQuestions: true, extract });
  const first = await store.analyze({ transcript: initialTranscript, painScale: '1-10', flow: 'brief' });
  assert.equal(first.nextQuestion?.field, 'details');
  const result = await store.analyze({ ...session(first), questionId: first.nextQuestion!.id, transcript });
  assert.equal(calls, 2);
  assert.equal(result.status, 'review');
  assert.equal(result.nextQuestion, null);
  assert.equal(result.reportedAnswers?.at(-1)?.transcript, transcript);
  return { store, first, result };
}

test('a single symptom details reply fills one existing record instead of separate itch and activity records', async () => {
  const transcript = "Um, my arm gets really itchy sometime, and it's usually at the elbows. The pain score is two. I got some problems with eating. It started yesterday.";
  const { store, first, result } = await answerDetails([symptom('arm pain', 'arm')], 'My arm hurts.', transcript,
    record => [
      { ...record.symptoms[0], location: 'elbows', severityScore: 2, duration: 'started yesterday' },
      symptom('itchiness', 'elbows'),
      symptom('problems with eating', null, { duration: 'started yesterday' }),
    ]);

  assert.equal(result.symptoms.length, 1, 'Related symptom qualities and activity effects belong in one review table');
  const item = result.symptoms[0];
  assert.equal(item.id, first.symptoms[0].id, 'Refining a symptom must retain its identity');
  assert.match(item.name, /pain/i);
  assert.match(item.name, /itch/i);
  assert.equal(item.location, 'elbows');
  assert.equal(item.severityScore, 2);
  assert.match(item.functionalImpact ?? '', /eating/i);
  assert.equal(item.duration, 'started yesterday');
  assert.equal(item.trend, null, 'An unanswered trend stays unknown');
  assert.equal(item.firstOccurrence, null, 'Started yesterday does not mean the first occurrence');

  const saved = store.save({ ...session(result), confirmed: true });
  assert.equal(saved.status, 'saved');
  assert.deepEqual(saved.symptoms, result.symptoms, 'Saving persists the same single combined symptom');
  assert.equal(saved.reportedAnswers?.at(-1)?.transcript, transcript, 'The original words remain available for review');
});

test('symptom details at a different body region remain distinct reports', async () => {
  for (const extra of [symptom('leg pain', 'leg'), symptom('headache', 'head')]) {
    const { first, result } = await answerDetails([symptom('arm pain', 'arm')], 'My arm hurts.',
      `My arm pain is two out of ten. I also have ${extra.name}.`,
      record => [{ ...record.symptoms[0], severityScore: 2 }, extra]);
    assert.equal(result.symptoms.length, 2, `Do not combine arm pain and ${extra.name}`);
    const original = result.symptoms.find(item => item.id === first.symptoms[0].id)!;
    assert.equal(original.name, 'arm pain');
    assert.equal(original.severityScore, 2);
    const added = result.symptoms.find(item => item.id !== first.symptoms[0].id)!;
    assert.equal(added.name, extra.name);
    assert.equal(added.location, extra.location);
    assert.equal(added.severityScore, null, 'The arm score must not leak into a new symptom');
  }
});

test('opposite sides do not combine merely because both symptoms mention an arm', async () => {
  const { first, result } = await answerDetails([symptom('left arm pain', 'left arm')], 'My left arm hurts.',
    'My left arm pain is two. My right elbow is itchy.',
    record => [{ ...record.symptoms[0], severityScore: 2 }, symptom('itchiness', 'right elbow')]);
  assert.equal(result.symptoms.length, 2);
  const original = result.symptoms.find(item => item.id === first.symptoms[0].id)!;
  assert.equal(original.name, 'left arm pain');
  assert.equal(original.location, 'left arm');
  assert.equal(original.severityScore, 2);
  const added = result.symptoms.find(item => item.id !== first.symptoms[0].id)!;
  assert.equal(added.name, 'itchiness');
  assert.equal(added.location, 'right elbow');
  assert.equal(added.severityScore, null);
});

test('refining an existing site keeps its known side and existing activity effects', async () => {
  const { result } = await answerDetails([symptom('left arm pain', 'left arm', { functionalImpact: 'Dressing is difficult' })],
    'My left arm hurts and dressing is difficult.', 'It is itchy at the elbow. I have problems with eating.', () => [
      symptom('itchiness', 'elbow'), symptom('problems with eating', null),
    ]);
  assert.equal(result.symptoms.length, 1);
  assert.equal(result.symptoms[0].location, 'left elbow');
  assert.match(result.symptoms[0].functionalImpact ?? '', /dressing.*eating/i);
});

test('distinct named positions within the same joint are not silently discarded', async () => {
  const { result } = await answerDetails([symptom('knee pain', 'outside of left knee')],
    'The outside of my left knee hurts.', 'The inside of my left knee is itchy.', () => [symptom('itchiness', 'inside of left knee')]);
  assert.equal(result.symptoms.length, 2);
  assert.deepEqual(result.symptoms.map(item => item.location), ['outside of left knee', 'inside of left knee']);
});

test('an unassigned activity effect is not guessed onto either of multiple existing symptoms', async () => {
  const { first, result } = await answerDetails([symptom('arm pain', 'arm'), symptom('leg pain', 'leg')],
    'My arm and leg hurt.', 'I have some problems with eating. It started yesterday.',
    () => [symptom('problems with eating', null, { duration: 'started yesterday' })]);
  for (const original of first.symptoms) {
    const item = result.symptoms.find(entry => entry.id === original.id);
    assert.ok(item, `Keep the existing ${original.name}`);
    assert.equal(item.name, original.name);
    assert.equal(item.location, original.location);
    assert.equal(item.functionalImpact, null, 'A shared details question does not identify which symptom limits eating');
    assert.equal(item.duration, null, 'Ambiguous timing must not be copied onto either symptom');
    assert.equal(item.severityScore, null);
    assert.equal(item.trend, null);
    assert.equal(item.firstOccurrence, null);
  }
});

test('grouping an associated symptom detail preserves other explicitly extracted categories', async () => {
  let calls = 0;
  const store = new Checkins({ mode: 'gemini', adaptiveQuestions: true, extract: async (_text, record) => {
    if (++calls === 1) return { ...emptyRecord(), symptoms: [symptom('arm pain', 'arm')] };
    return { ...emptyRecord(), symptoms: [
      { ...record.symptoms[0], location: 'elbow', severityScore: 2 },
      symptom('itchiness', 'elbow'),
    ], medications: [{ id: null, name: 'prednisone', description: null, dose: null, status: 'missed' as const, time: null }] };
  } });
  const first = await store.analyze({ transcript: 'My arm hurts.', flow: 'brief', painScale: '1-10' });
  const final = await store.analyze({ ...session(first), questionId: first.nextQuestion!.id,
    transcript: 'It is an itchy pain at my elbow, two out of ten. I also missed my prednisone.' });
  assert.equal(final.status, 'review');
  assert.equal(final.nextQuestion, null);
  assert.equal(final.symptoms.length, 1);
  assert.equal(final.symptoms[0].id, first.symptoms[0].id);
  assert.match(final.symptoms[0].name, /pain/i);
  assert.match(final.symptoms[0].name, /itch/i);
  assert.equal(final.medications.length, 1);
  assert.equal(final.medications[0].name, 'prednisone');
  assert.equal(final.medications[0].status, 'missed');
});

test('matching a score or duration does not resolve an ambiguous association between same-area complaints', async () => {
  const initial = [
    symptom('arm pain', 'arm', { severityScore: 2, duration: 'since yesterday' }),
    symptom('arm tingling', 'arm', { severityScore: 7, duration: 'for a week' }),
  ];
  const { first, result } = await answerDetails(initial, 'My arm hurts and tingles.',
    'I have an itchy feeling in the arm, two out of ten, since yesterday.',
    () => [symptom('itchiness', 'arm', { severityScore: 2, duration: 'since yesterday' })]);
  assert.equal(result.symptoms.length, 3,
    'A conflict with one candidate is not evidence that the other candidate owns this detail');
  for (const original of first.symptoms) {
    assert.deepEqual(result.symptoms.find(item => item.id === original.id), original);
  }
  const added = result.symptoms.find(item => !first.symptoms.some(original => original.id === item.id))!;
  assert.equal(added.name, 'itchiness');
  assert.equal(added.severityScore, 2);
  assert.equal(added.duration, 'since yesterday');
});

test('a compound body location is retained instead of being reduced to the first matching arm', async () => {
  for (const [initialLocation, detailLocation, transcript] of [
    ['left arm', 'left and right arms', 'Both my left and right arms feel itchy.'],
    ['arm', 'arm and leg', 'My arm and leg feel itchy.'],
  ]) {
    const { first, result } = await answerDetails([symptom('arm pain', initialLocation)],
      `I have pain in my ${initialLocation}.`, transcript,
      () => [symptom('itchiness', detailLocation)]);
    assert.equal(result.symptoms.length, 2, detailLocation);
    assert.deepEqual(result.symptoms.find(item => item.id === first.symptoms[0].id), first.symptoms[0]);
    const added = result.symptoms.find(item => item.id !== first.symptoms[0].id)!;
    assert.equal(added.name, 'itchiness');
    assert.equal(added.location, detailLocation, 'Keep every explicitly reported site');
  }
});

test('an explicitly separate same-area complaint is not folded into the existing symptom', async () => {
  for (const relation of ['a separate issue', 'an unrelated problem']) {
    const { first, result } = await answerDetails([symptom('arm pain', 'arm')], 'My arm hurts.',
      `The itchy feeling in my arm is ${relation}.`, () => [symptom('itchiness', 'arm')]);
    assert.equal(result.symptoms.length, 2, relation);
    assert.deepEqual(result.symptoms.find(item => item.id === first.symptoms[0].id), first.symptoms[0]);
    assert.equal(result.symptoms.find(item => item.id !== first.symptoms[0].id)?.name, 'itchiness');
  }
});

test('conflicting numeric scores are preserved in separate records instead of overwritten', async () => {
  const { first, result } = await answerDetails([symptom('arm pain', 'arm', { severityScore: 2 })],
    'My arm pain is two out of ten.', 'There is itching at my elbow, seven out of ten.',
    () => [symptom('itchiness', 'elbow', { severityScore: 7 })]);
  assert.equal(result.symptoms.length, 2);
  assert.deepEqual(result.symptoms.find(item => item.id === first.symptoms[0].id), first.symptoms[0]);
  const added = result.symptoms.find(item => item.id !== first.symptoms[0].id)!;
  assert.equal(added.name, 'itchiness');
  assert.equal(added.severityScore, 7);
});

test('swallowing difficulty remains a symptom even at the same site as an existing complaint', async () => {
  const { first, result } = await answerDetails([symptom('throat pain', 'throat')], 'My throat hurts.',
    'I have difficulty swallowing in my throat. It started yesterday.',
    () => [symptom('difficulty swallowing', 'throat', { duration: 'started yesterday' })]);
  assert.equal(result.symptoms.length, 2);
  assert.deepEqual(result.symptoms.find(item => item.id === first.symptoms[0].id), first.symptoms[0]);
  const added = result.symptoms.find(item => item.id !== first.symptoms[0].id)!;
  assert.equal(added.name, 'difficulty swallowing');
  assert.equal(added.location, 'throat');
  assert.equal(added.duration, 'started yesterday');
  assert.equal(added.functionalImpact, null);
});
