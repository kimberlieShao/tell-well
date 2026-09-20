import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Checkins } from '../src/checkins.js';
import { demoExtractor } from '../src/extractor.js';
import { recordSchema } from '../src/schema.js';

test('removing the first symptom preserves a shared details answer for remaining symptoms', async () => {
  const store = new Checkins(demoExtractor);
  const first = await store.analyze({ transcript: 'My arm and leg hurt.', flow: 'brief', painScale: '1-10' });
  assert.equal(first.symptoms.length, 2);
  const response = await store.analyze({ sessionId: first.sessionId, version: first.version,
    questionId: first.nextQuestion!.id, transcript: 'My leg has hurt since yesterday.' });
  const record = recordSchema.parse({ symptoms: response.symptoms, medications: response.medications,
    diet: response.diet, vitals: response.vitals, wellness: response.wellness });
  record.symptoms = record.symptoms.filter(item => item.id !== first.nextQuestion!.entityId);
  const saved = store.save({ sessionId: response.sessionId, version: response.version, confirmed: true, record });
  assert.equal(saved.reportedAnswers?.at(-1)?.transcript, 'My leg has hurt since yesterday.');
  assert.equal(saved.reportedAnswers?.at(-1)?.entityId, null);
});

test('a short explicit decimal score remains exact in brief symptom review', async () => {
  for (const transcript of ['2.5', '2.5/10', "It's 2.5 out of ten."]) {
    const store = new Checkins(demoExtractor);
    const first = await store.analyze({ transcript: 'My arm hurts.', flow: 'brief', painScale: '1-10' });
    const result = await store.analyze({ sessionId: first.sessionId, version: first.version,
      questionId: first.nextQuestion!.id, transcript });
    assert.equal(result.symptoms[0].severityScore, 2.5);
    assert.equal(result.status, 'review');
    assert.equal(result.reportedAnswers?.at(-1)?.transcript, transcript);
  }
});
