import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { briefFollowUpInstructions, extractionResultSchema, followUpPlanSchema, selectBriefFollowUp, selectFollowUp } from '../src/followups.js';
import { emptyRecord, type HealthRecord } from '../src/schema.js';

const symptom = (changes: Partial<HealthRecord['symptoms'][number]> = {}): HealthRecord['symptoms'][number] => ({
  id: randomUUID(), name: 'knee pain', location: null, severity: null, severityScore: null,
  functionalImpact: null, duration: null, firstOccurrence: null, trend: null, ...changes,
});
const medication = (changes: Partial<HealthRecord['medications'][number]> = {}): HealthRecord['medications'][number] => ({
  id: randomUUID(), name: null, description: 'my pill', dose: null, status: 'missed', time: null, ...changes,
});
const config = (changes: Partial<Parameters<typeof selectFollowUp>[1]> = {}): Parameters<typeof selectFollowUp>[1] => ({
  references: {}, skipped: [], asked: [], numericPain: true, ...changes,
});
const ask = (entityId: string, changes: Record<string, unknown> = {}) => ({
  action: 'ask', category: 'symptoms', entityId, extractionIndex: null,
  field: 'duration', text: 'How long has your knee pain been bothering you?', ...changes,
});
const review = { action: 'review', category: null, entityId: null, extractionIndex: null, field: null, text: null };

test('planning has a strict schema, while bad optional planning does not lose valid facts', () => {
  assert.equal(followUpPlanSchema.safeParse({ ...review, extra: 'not allowed' }).success, false);
  assert.equal(followUpPlanSchema.safeParse(ask(randomUUID(), { extractionIndex: -1 })).success, false);
  assert.equal(followUpPlanSchema.safeParse(ask(randomUUID(), { field: 'functionalImpact' })).success, false);
  const facts = { ...emptyRecord(), symptoms: [{ ...symptom(), id: null }], followUp: { action: 'invented' } };
  assert.deepEqual(extractionResultSchema.parse(facts), facts);
  assert.equal(extractionResultSchema.safeParse({ ...facts, symptoms: [{ name: 'not valid facts' }] }).success, false);
});

test('a generated question targets the specified entity and uses a stable ID', () => {
  const knee = symptom();
  const shoulder = symptom({ name: 'shoulder pain' });
  const record = { ...emptyRecord(), symptoms: [knee, shoulder] };
  const selection = selectFollowUp(record, config({ proposal: ask(shoulder.id, { text: 'How long has the shoulder pain lasted?' }) }));
  assert.equal(selection.reason, 'generated');
  assert.deepEqual(selection.question, {
    id: `${shoulder.id}:duration`, entityId: shoulder.id, category: 'symptoms', field: 'duration',
    text: 'How long has the shoulder pain lasted?', type: 'text', options: [],
  });
});

test('new extracted entities resolve through category-specific references, never array position in the record', () => {
  const old = symptom();
  const created = symptom({ name: 'back pain' });
  const record = { ...emptyRecord(), symptoms: [old, created] };
  const selection = selectFollowUp(record, config({
    proposal: ask(created.id, { entityId: null, extractionIndex: 0, text: 'How long has your back hurt?' }),
    references: { symptoms: [created.id] },
  }));
  assert.equal(selection.reason, 'generated');
  assert.equal(selection.question?.entityId, created.id);
});

test('asked, skipped, and completed fields cannot be re-asked through generated plans', () => {
  const item = symptom({ location: 'left knee' });
  const record = { ...emptyRecord(), symptoms: [item] };
  for (const proposal of [
    ask(item.id, { field: 'location', text: 'Where is your knee pain?' }),
    ask(item.id, { field: 'severity', text: 'How bad is the knee pain on a scale of 1 to 10?' }),
    ask(item.id),
  ]) {
    const result = selectFollowUp(record, config({ proposal, asked: [`${item.id}:severity`], skipped: [`${item.id}:duration`] }));
    assert.equal(result.reason, 'complete');
    assert.equal(result.question, null);
  }
});

test('invalid, unsafe, multiple, and unbound generated questions fall back without altering the record', () => {
  const item = symptom();
  const record = { ...emptyRecord(), symptoms: [item] };
  const before = structuredClone(record);
  const proposals = [
    undefined, null, {}, { action: 'ask' },
    ask(randomUUID()), ask(item.id, { entityId: null, extractionIndex: 7 }),
    ask(item.id, { extractionIndex: 0 }), ask(item.id, { category: 'vitals' }),
    ask(item.id, { field: 'diagnosis' }), ask(item.id, { text: 'a'.repeat(241) }),
    ask(item.id, { text: 'Where is it? How long has it hurt?' }),
    ask(item.id, { text: 'How long has it hurt and where is the pain?' }),
    ask(item.id, { text: 'You should stop taking your medication. How long has it hurt?' }),
    ask(item.id, { text: 'Read https://example.com for advice?' }),
    ask(item.id, { text: '<b>How long has it hurt?</b>' }),
    ask(item.id, { text: '  ' }),
    { ...review, text: 'not a valid review plan' },
  ];
  for (const proposal of proposals) {
    const result = selectFollowUp(record, config({ proposal }));
    assert.equal(result.reason, 'fallback', JSON.stringify(proposal));
    assert.equal(result.question?.id, `${item.id}:location`);
  }
  assert.deepEqual(record, before);
});

test('ambiguous entity IDs cannot be used by generated planning', () => {
  const item = symptom();
  const record = { ...emptyRecord(), symptoms: [item, { ...item }] };
  assert.equal(selectFollowUp(record, config({ proposal: ask(item.id) })).reason, 'fallback');
});

test('numeric severity preserves canonical 1–10 options and rejects conflicting scale wording', () => {
  const item = symptom({ location: 'left knee' });
  const record = { ...emptyRecord(), symptoms: [item] };
  const result = selectFollowUp(record, config({ proposal: ask(item.id, {
    field: 'severity', text: 'On a scale of 1–10, how strong is that knee pain right now?',
  }) }));
  assert.equal(result.reason, 'generated');
  assert.equal(result.question?.type, 'single_choice');
  assert.deepEqual(result.question?.options, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  const conflicting = selectFollowUp(record, config({ proposal: ask(item.id, {
    field: 'severity', text: 'Is the knee pain mild, moderate, or severe?',
  }) }));
  assert.equal(conflicting.reason, 'fallback');
  assert.deepEqual(conflicting.question?.options, result.question?.options);
});

test('a reported numeric severity, including a decimal, is complete and never rounded', () => {
  const item = symptom({ severityScore: 6.5 });
  const record = { ...emptyRecord(), symptoms: [item] };
  const result = selectFollowUp(record, config({ proposal: ask(item.id, { field: 'severity', text: 'What is the pain from 1 to 10?' }) }));
  assert.equal(result.reason, 'fallback');
  assert.notEqual(result.question?.field, 'severity');
  assert.equal(record.symptoms[0]!.severityScore, 6.5);
});

test('generated nonseverity questions use free text while severity keeps categorical options when configured', () => {
  const item = symptom();
  const record = { ...emptyRecord(), symptoms: [item] };
  const duration = selectFollowUp(record, config({ proposal: ask(item.id) }));
  assert.equal(duration.reason, 'generated');
  assert.equal(duration.question?.type, 'text');
  assert.deepEqual(duration.question?.options, []);
  const severity = selectFollowUp(record, config({ numericPain: false, proposal: ask(item.id, { field: 'severity', text: 'Is your knee pain mild, moderate, or severe?' }) }));
  assert.equal(severity.reason, 'generated');
  assert.deepEqual(severity.question?.options, ['Mild', 'Moderate', 'Severe']);
});

test('a medication refusal or mere mention does not trigger a status or identification checklist', () => {
  const med = medication({ status: 'mentioned' });
  const record = { ...emptyRecord(), medications: [med] };
  const result = selectFollowUp(record, config({ proposal: ask(med.id, {
    category: 'medications', field: 'status', text: 'Did you take, miss, or stop the medication?',
  }) }));
  assert.equal(result.question, null);
  assert.equal(selectFollowUp(record, config({ proposal: ask(med.id, {
    category: 'medications', field: 'name', text: 'What is the medication called?',
  }) })).question, null);
  const concern = selectFollowUp(record, config({ proposal: ask(med.id, {
    category: 'medications', field: 'context', text: 'What concerns do you have about that medication?',
  }) }));
  assert.equal(concern.reason, 'generated');
  assert.equal(concern.question?.id, `${med.id}:context`);
});

test('generated planning stays with the reported item rather than unrelated category surveys or coaching', () => {
  const item = symptom();
  const record = { ...emptyRecord(), symptoms: [item] };
  for (const proposal of [
    ask(item.id, { text: 'How is your mood today?' }),
    ask(item.id, { text: 'What are your fitness goals?' }),
    ask(item.id, { field: 'context', text: 'Do you have a meditation routine to help with the pain?' }),
    ask(item.id, { field: 'context', text: 'How many servings of vegetables do you eat every day?' }),
    ask(item.id, { field: 'functionalImpact', text: 'What exercise routine could improve your work-life balance?' }),
  ]) {
    const result = selectFollowUp(record, config({ proposal }));
    assert.equal(result.reason, 'fallback', JSON.stringify(proposal));
    assert.equal(result.question?.id, `${item.id}:location`);
  }
});

test('unknown medication identity is a fallback only for an actual taken, missed, or stopped report', () => {
  for (const status of ['taken', 'missed', 'stopped', 'mentioned', null] as const) {
    const med = medication({ status });
    const result = selectFollowUp({ ...emptyRecord(), medications: [med] }, config());
    assert.equal(result.question?.field ?? null, status && status !== 'mentioned' ? 'name' : null);
  }
});

test('one relevant context question is allowed per symptom and never repeats after an unknown answer', () => {
  const item = symptom();
  const record = { ...emptyRecord(), symptoms: [item] };
  const proposal = ask(item.id, { field: 'context', text: 'Do you notice any other symptoms along with the knee pain?' });
  const first = selectFollowUp(record, config({ proposal }));
  assert.equal(first.reason, 'generated');
  assert.equal(first.question?.id, `${item.id}:context`);
  const next = selectFollowUp(record, config({ proposal, asked: [first.question!.id] }));
  assert.equal(next.reason, 'fallback');
  assert.notEqual(next.question?.id, first.question?.id);
  const repeatedField = selectFollowUp(record, config({ proposal: ask(item.id, { field: 'context', text: 'Where is the knee pain?' }) }));
  assert.equal(repeatedField.reason, 'fallback');
});

test('context is not allowed for diet or vital records', () => {
  const vital = { id: randomUUID(), name: 'temperature', value: '99', unit: 'F', time: null };
  const result = selectFollowUp({ ...emptyRecord(), vitals: [vital] }, config({ proposal: ask(vital.id, {
    category: 'vitals', field: 'context', text: 'Do you notice any other symptoms with that reading?',
  }) }));
  assert.equal(result.question, null);
});

test('a valid review plan can stop early with unknown fields', () => {
  const record = { ...emptyRecord(), symptoms: [symptom()] };
  assert.deepEqual(selectFollowUp(record, config({ proposal: review })), { question: null, reason: 'complete' });
  assert.equal(record.symptoms[0]!.severityScore, null);
});

test('wellness-only and meal-only reports have no follow-up questions', () => {
  const records: HealthRecord[] = [
    { ...emptyRecord(), wellness: { status: 'well', statement: 'I feel good today' } },
    { ...emptyRecord(), diet: [{ id: randomUUID(), description: 'oatmeal', time: null }] },
  ];
  for (const record of records) assert.deepEqual(selectFollowUp(record, config()), { question: null, reason: 'complete' });
});

test('fallback priorities exclude routine first occurrence and trend busywork', () => {
  const item = symptom();
  const record = { ...emptyRecord(), symptoms: [item] };
  assert.equal(selectFollowUp(record, config()).question?.field, 'location');
  item.location = 'left knee';
  assert.equal(selectFollowUp(record, config()).question?.field, 'severity');
  item.severityScore = 4;
  assert.equal(selectFollowUp(record, config()).question?.field, 'duration');
  item.duration = 'since yesterday';
  assert.deepEqual(selectFollowUp(record, config()), { question: null, reason: 'complete' });
  assert.equal(item.functionalImpact, null);
});

test('daily-activity impact cannot return through context or another field', () => {
  const item = symptom();
  const record = { ...emptyRecord(), symptoms: [item] };
  const proposals = [
    ask(item.id, { field: 'functionalImpact', text: 'Is the pain affecting your eating?' }),
    ask(item.id, { field: 'context', text: 'Do you notice the pain interfering with dressing?' }),
    ask(item.id, { field: 'context', text: 'Do you have trouble sleeping with the pain?' }),
    ask(item.id, { field: 'context', text: 'Do you feel unable to change clothes with the pain?' }),
    ask(item.id, { field: 'context', text: 'Can you still walk with the pain?' }),
    ask(item.id, { field: 'severity', text: 'On a scale of 1 to 10, how much does the pain affect daily activities?' }),
    ask(item.id, { field: 'duration', text: 'How long has the pain made eating difficult?' }),
    ask(item.id, { field: 'location', text: 'Where does the pain stop you from walking?' }),
    ask(item.id, { field: 'context', text: 'Do you notice pain disrupting your work?' }),
  ];
  for (const proposal of proposals) {
    const result = selectFollowUp(record, config({ proposal }));
    assert.equal(result.reason, 'fallback', JSON.stringify(proposal));
    assert.equal(result.question?.id, `${item.id}:location`);
  }
});

test('activity-impact restrictions preserve simple symptom and medication clarification', () => {
  const item = symptom({ name: 'stomach pain after eating' });
  const record = { ...emptyRecord(), symptoms: [item] };
  for (const proposal of [
    ask(item.id, { field: 'location', text: 'Where is the stomach pain after eating?' }),
    ask(item.id, { field: 'severity', text: 'How severe is the pain after eating on a scale of 1 to 10?' }),
    ask(item.id, { field: 'duration', text: 'How long has the pain after eating lasted?' }),
  ]) assert.equal(selectFollowUp(record, config({ proposal })).reason, 'generated', JSON.stringify(proposal));
  const sleep = symptom({ name: 'trouble sleeping' });
  assert.equal(selectFollowUp({ ...emptyRecord(), symptoms: [sleep] }, config({ numericPain: false,
    proposal: ask(sleep.id, { field: 'context', text: 'Do you notice any other symptoms with the trouble sleeping?' }),
  })).reason, 'generated');
  const med = medication({ description: 'sleeping pill' });
  assert.equal(selectFollowUp({ ...emptyRecord(), medications: [med] }, config({
    proposal: ask(med.id, { category: 'medications', field: 'name', text: 'What is the sleeping pill called?' }),
  })).reason, 'generated');
});

test('volunteered daily-activity impact is preserved in extracted facts without creating a question', () => {
  const item = symptom({ location: 'left knee', severityScore: 4, duration: 'since yesterday', functionalImpact: 'Walking is difficult' });
  const facts = { ...emptyRecord(), symptoms: [{ ...item, id: null }], followUp: review };
  assert.equal(extractionResultSchema.parse(facts).symptoms[0]!.functionalImpact, 'Walking is difficult');
  assert.deepEqual(selectFollowUp({ ...emptyRecord(), symptoms: [item] }, config()), { question: null, reason: 'complete' });
});

test('vital fallback asks for the reading before its unit', () => {
  const vital = { id: randomUUID(), name: 'temperature', value: null as string | null, unit: null, time: null };
  const record = { ...emptyRecord(), vitals: [vital] };
  assert.equal(selectFollowUp(record, config()).question?.field, 'value');
  vital.value = '99';
  assert.equal(selectFollowUp(record, config()).question?.field, 'unit');
});

test('the global cap stops even a valid generated question', () => {
  const item = symptom();
  const asked = Array.from({ length: 6 }, (_, index) => `${randomUUID()}:field${index}`);
  const result = selectFollowUp({ ...emptyRecord(), symptoms: [item] }, config({ proposal: ask(item.id), asked }));
  assert.deepEqual(result, { question: null, reason: 'limit' });
});

test('the per-entity cap prefers an available second entity, then stops when only capped work remains', () => {
  const first = symptom();
  const second = symptom({ name: 'shoulder pain' });
  const asked = ['location', 'severity', 'context'].map(field => `${first.id}:${field}`);
  const selection = selectFollowUp({ ...emptyRecord(), symptoms: [first, second] }, config({ proposal: ask(first.id), asked }));
  assert.equal(selection.reason, 'fallback');
  assert.equal(selection.question?.entityId, second.id);
  assert.deepEqual(selectFollowUp({ ...emptyRecord(), symptoms: [first] }, config({ proposal: ask(first.id), asked })), { question: null, reason: 'limit' });
});

test('brief flow asks one free-text invitation for every symptom together', () => {
  const first = symptom();
  const second = symptom({ name: 'headache' });
  const record = { ...emptyRecord(), symptoms: [first, second] };
  const proposal = ask(second.id, { field: 'details', text: 'Please share any other details about your symptoms using the checklist.' });
  assert.equal(followUpPlanSchema.safeParse(proposal).success, true);
  const result = selectBriefFollowUp(record, config({ proposal }));
  assert.equal(result.reason, 'generated');
  assert.deepEqual(result.question, {
    id: `${first.id}:details`, entityId: first.id, category: 'symptoms', field: 'details',
    type: 'text', options: [], text: proposal.text,
  });
});

test('brief flow resolves generated new-symptom references without changing the first anchor', () => {
  const first = symptom();
  const second = symptom({ name: 'headache' });
  const result = selectBriefFollowUp({ ...emptyRecord(), symptoms: [first, second] }, config({
    proposal: ask(second.id, { entityId: null, extractionIndex: 0, field: 'details', text: 'Tell me more about your symptoms.' }),
    references: { symptoms: [second.id] },
  }));
  assert.equal(result.reason, 'generated');
  assert.equal(result.question?.id, `${first.id}:details`);
});

test('brief generated invitations cannot narrow a multiple-symptom report to only one symptom', () => {
  const first = symptom();
  const second = symptom({ name: 'headache' });
  const result = selectBriefFollowUp({ ...emptyRecord(), symptoms: [first, second] }, config({
    proposal: ask(first.id, { field: 'details', text: 'Tell me more about the knee pain.' }),
  }));
  assert.equal(result.reason, 'fallback');
  assert.match(result.question!.text, /symptom|feeling/);
});

test('brief flow reaches review after the details invitation even with unknowns or a new symptom', () => {
  const first = symptom();
  const record = { ...emptyRecord(), symptoms: [first, symptom({ name: 'headache' })] };
  const proposal = ask(first.id, { field: 'details', text: 'Please share more about your symptoms.' });
  for (const changes of [
    { asked: [`${first.id}:details`] },
    { skipped: [`${first.id}:details`] },
    { asked: [`${randomUUID()}:details`] },
  ]) assert.deepEqual(selectBriefFollowUp(record, config({ proposal, ...changes })), { question: null, reason: 'complete' });
  assert.equal(record.symptoms[0]!.severityScore, null);
  assert.equal(record.symptoms[1]!.duration, null);
});

test('brief flow permits a replacement invitation after root excludes a hidden target from history', () => {
  const first = symptom();
  const hidden = symptom();
  const retainedHistory = [`${hidden.id}:details`].filter(id => !id.startsWith(`${hidden.id}:`));
  const result = selectBriefFollowUp({ ...emptyRecord(), symptoms: [first] }, config({ asked: retainedHistory, skipped: [] }));
  assert.equal(result.question?.id, `${first.id}:details`);
});

test('brief flow never follows up on food, water, medications, vitals, or wellness alone', () => {
  const records: HealthRecord[] = [
    { ...emptyRecord(), diet: [{ id: randomUUID(), description: 'rice and vegetables', time: null }] },
    { ...emptyRecord(), diet: [{ id: randomUUID(), description: 'two glasses of water', time: null }] },
    { ...emptyRecord(), medications: [medication()] },
    { ...emptyRecord(), vitals: [{ id: randomUUID(), name: 'temperature', value: null, unit: null, time: null }] },
    { ...emptyRecord(), wellness: { status: 'well', statement: 'I feel good today' } },
  ];
  for (const record of records) assert.deepEqual(selectBriefFollowUp(record, config({
    proposal: ask(randomUUID(), { field: 'details', text: 'Tell me more about your symptoms.' }),
  })), { question: null, reason: 'complete' });
});

test('brief flow gives the one invitation even when a model proposes early review or every symptom field is filled', () => {
  const item = symptom({ location: 'left knee', severityScore: 3, duration: 'one day', functionalImpact: 'walking normally', firstOccurrence: true, trend: 'same' });
  const result = selectBriefFollowUp({ ...emptyRecord(), symptoms: [item] }, config({ proposal: review }));
  assert.equal(result.reason, 'fallback');
  assert.equal(result.question?.field, 'details');
  assert.deepEqual(result.question?.options, []);
});

test('brief invitations vary across sessions while staying stable for retries', () => {
  const variants = new Set<string>();
  for (let index = 0; index < 12; index++) {
    const item = symptom({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
    const record = { ...emptyRecord(), symptoms: [item] };
    const result = selectBriefFollowUp(record, config());
    assert.equal(result.question?.type, 'text');
    assert.ok(result.question!.text.length <= 180);
    variants.add(result.question!.text);
    assert.deepEqual(selectBriefFollowUp(record, config()), result);
  }
  assert.ok(variants.size >= 4, `Expected diverse invitations, received ${variants.size}`);
});

test('brief flow rejects unsafe, unrelated, unbound, and individual-field proposals', () => {
  const item = symptom();
  const record = { ...emptyRecord(), symptoms: [item] };
  const invitation = { field: 'details', text: 'Tell me more about your symptoms.' };
  const proposals = [
    ask(item.id),
    ask(randomUUID(), invitation),
    ask(item.id, { ...invitation, entityId: null, extractionIndex: 5 }),
    ask(item.id, { ...invitation, extractionIndex: 0 }),
    ask(item.id, { ...invitation, category: 'medications' }),
    ask(item.id, { ...invitation, text: 'Tell me more about your symptoms. '.repeat(6) }),
    ask(item.id, { ...invitation, text: 'Tell me how severe the pain is on a scale of 1 to 10.' }),
    ask(item.id, { ...invitation, text: 'Tell me how long the pain has lasted.' }),
    ask(item.id, { ...invitation, text: 'Tell me more about your symptoms and your income.' }),
    ask(item.id, { ...invitation, text: 'You should take aspirin. Tell me more about your symptoms.' }),
    ask(item.id, { ...invitation, text: 'Tell me more about your symptoms, and drink more water.' }),
    ask(item.id, { ...invitation, text: 'Tell me why your symptoms might indicate diabetes.' }),
    ask(item.id, { ...invitation, text: 'Tell me more about your symptoms? Where is it?' }),
    ask(item.id, { ...invitation, text: 'Tell me more at https://example.com about your symptoms.' }),
    ask(item.id, { ...invitation, text: '<b>Tell me more about your symptoms.</b>' }),
    ask(item.id, { ...invitation, text: 'Tell me how your symptoms are affecting daily activities.' }),
  ];
  for (const proposal of proposals) {
    const result = selectBriefFollowUp(record, config({ proposal }));
    assert.equal(result.reason, 'fallback', JSON.stringify(proposal));
    assert.equal(result.question?.field, 'details');
    assert.notEqual(result.question?.text, proposal.text);
  }
});

test('brief instructions put activity effect in the note box and stop after one reply', () => {
  assert.match(briefFollowUpInstructions, /symptom, location, score, activity effect, duration/);
  assert.match(briefFollowUpInstructions, /choose review immediately/);
  assert.match(briefFollowUpInstructions, /ALL included symptoms together/);
});
