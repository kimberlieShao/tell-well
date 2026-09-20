import { parsePainScore } from '../../frontend/pain-score.js';
import type { Category, HealthRecord, Question } from './schema.js';

export function questionsFor(record: HealthRecord, { numericPain = false }: { numericPain?: boolean } = {}): Question[] {
  const questions: Question[] = [];
  const add = (category: Category, entityId: string, field: string, text: string, options: string[] = []) => {
    questions.push({ id: `${entityId}:${field}`, category, entityId, field, text,
      type: options.length ? 'single_choice' : 'text', options });
  };
  // Identify unknown medications first. Never fabricate a medication choice list.
  for (const med of record.medications) {
    if (med.name === null) add('medications', med.id, 'name', 'Which medication do you mean? You can say “I’m not sure.”');
  }
  for (const s of record.symptoms) {
    const isPain = /pain|ache|hurt/i.test(s.name);
    if (isPain && !s.location)
      add('symptoms', s.id, 'location', `Where do you feel the ${s.name}?`);
    if (numericPain && isPain && s.severityScore === null)
      add('symptoms', s.id, 'severity', `How severe is your ${s.name} right now, on a scale of 1 to 10?`, Array.from({ length: 10 }, (_, index) => String(index + 1)));
    else if (s.severity === null && s.severityScore === null)
      add('symptoms', s.id, 'severity', `Would you describe your ${s.name} as mild, moderate, or severe?`, ['Mild', 'Moderate', 'Severe']);
    if (numericPain && isPain && s.firstOccurrence == null)
      add('symptoms', s.id, 'firstOccurrence', `Is this the first time you have had this ${s.name}?`, ['Yes, first time', 'No, I have had it before']);
    if (!s.trend && (!(numericPain && isPain) || s.firstOccurrence === false))
      add('symptoms', s.id, 'trend', `Compared with before, is your ${s.name} better, about the same, or worse?`, ['Better', 'Same', 'Worse']);
    if (numericPain && isPain && !s.duration)
      add('symptoms', s.id, 'duration', `How long has this episode of ${s.name} lasted?`);
  }
  for (const med of record.medications) {
    if (med.status === null || med.status === 'mentioned')
      add('medications', med.id, 'status', `Did you take, miss, or stop ${med.name ?? 'that medication'}?`, ['Taken', 'Missed', 'Stopped']);
  }
  for (const vital of record.vitals) {
    if (!vital.value) add('vitals', vital.id, 'value', `What was your ${vital.name} reading?`);
    if (!vital.unit) add('vitals', vital.id, 'unit', `What unit was shown for your ${vital.name} reading?`);
  }
  return questions;
}

export function fieldPath(record: HealthRecord, q: Question): string {
  const index = record[q.category].findIndex(item => item.id === q.entityId);
  return `${q.category}[${index}].${q.field}`;
}

export function isUnknown(value: string): boolean {
  return /^(?:i(?:'|’)?m not sure|not sure|i don(?:'|’)?t know|unknown|skip|prefer not to say)[.!]?$/i.test(value.trim());
}

// Buttons and short voice answers are applied to a named question, never "the first symptom".
// Return false for a complex voice answer so the configured extractor can interpret it.
export function applyAnswer(record: HealthRecord, q: Question, raw: string, fromVoice = false): boolean {
  const value = raw.trim().replace(/[.!]$/, '');
  const normalized = value.toLowerCase();
  const item = record[q.category].find(x => x.id === q.entityId)! as unknown as Record<string, unknown>;
  if (q.field === 'severity') {
    const severity = normalized.match(/^(?:(?:it(?:'s| is)|i(?:'d| would) say) )?(mild|moderate|severe)$/)?.[1];
    if (severity) { item.severity = severity; item.severityScore = null; return true; }
    const spokenScore = parsePainScore(value);
    if (spokenScore !== null) { item.severityScore = spokenScore; item.severity = null; return true; }
    const score = normalized.match(/^(\d+(?:\.\d+)?)(?:\s*(?:\/|out of)\s*10)?$/);
    if (score && Number(score[1]) <= 10) { item.severityScore = Number(score[1]); item.severity = null; return true; }
    return false;
  }
  if (q.field === 'firstOccurrence') {
    if (/^(?:yes(?:,? (?:this is |it is )?(?:the )?first time)?|(?:this is |it is )?(?:the |my )?first time)$/i.test(value)) { item.firstOccurrence = true; return true; }
    if (/^(?:no(?:,? (?:i have|i've) had it before)?|(?:i have|i've) had (?:it|this) before|not (?:the |my )?first time)$/i.test(value)) { item.firstOccurrence = false; return true; }
    return false;
  }
  if (q.field === 'duration') {
    if (!fromVoice || /^(?:(?:it(?:'s| has) been|(?:i have|i've) had (?:it|this)(?: pain)?|for|since|about|around)\s+)*(?:(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a few|several)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)|this morning|last night|yesterday|today)$/i.test(value)) { item.duration = value; return true; }
    return false;
  }
  if (q.field === 'trend') {
    const trend = normalized.replace(/^(?:(?:it(?:'s| is)|i feel|it feels) )/, '').replace(/^(?:getting |a little |much |about the )/, '');
    if (['better', 'same', 'worse'].includes(trend)) { item.trend = trend; return true; }
    return false;
  }
  if (q.field === 'status') {
    const status = normalized.replace(/^i /, '');
    const mapped = ({ taken: 'taken', took: 'taken', missed: 'missed', forgot: 'missed', stopped: 'stopped' } as Record<string, string>)[status];
    if (mapped) { item.status = mapped; return true; }
    return false;
  }
  // A form can supply a reported name, but a guess or pill description must not resolve
  // medication identity. Voice identification goes through the configured extractor.
  if (q.category === 'medications' && q.field === 'name') {
    if (/\b(?:pill|tablet|capsule|white|blue|red|yellow|pink|one)\b/i.test(value)) return false;
    if (/\b(?:maybe|might|possibly|perhaps|probably|think|guess|unsure|uncertain|not sure|don['’]?t know|could be|either|or|not)\b|\?/i.test(value)) return false;
    if (fromVoice) return false;
  }
  if (fromVoice && q.field !== 'functionalImpact' && q.field !== 'location') return false;
  if (fromVoice && /\b(?: and | but |actually|instead)\b/i.test(value)) return false;
  item[q.field] = value;
  return true;
}
