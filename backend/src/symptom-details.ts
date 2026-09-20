import type { Extraction, HealthRecord } from './schema.js';

type Symptom = Extraction['symptoms'][number];
const normalized = (value: string) => value.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const location = (value: string | null) => {
  const text = normalized(value ?? '').replace(/\b(elbows|arms|legs|knees|wrists|hands|ankles|shoulders|hips|fingers|toes)\b/g, word => word.slice(0, -1));
  const sides = [...text.matchAll(/\b(left|right|both|bilateral)\b/g)].map(match => match[0]);
  const parts = [...text.matchAll(/\b(upper arm|forearm|elbow|arm|thigh|calf|shin|knee|leg|wrist|hand|finger|ankle|foot|toe|shoulder|hip|head|scalp|neck|back)\b/g)].map(match => match[0]);
  return { text, side: sides[0] ?? null, part: parts[0] ?? text,
    position: text.match(/\b(inner|outer|inside|outside|front|behind|top|bottom)\b/)?.[0] ?? null,
    compound: new Set(sides).size > 1 || new Set(parts).size > 1 };
};
const refinements: Record<string, string[]> = {
  arm: ['upper arm', 'forearm', 'elbow'], leg: ['thigh', 'calf', 'shin', 'knee'], head: ['scalp'],
};
function sameArea(a: string | null, b: string | null): boolean {
  const left = location(a), right = location(b);
  if (!left.text || !right.text || left.compound || right.compound) return false;
  if (left.side && right.side && left.side !== right.side) return false;
  if (left.position && right.position && left.position !== right.position) return false;
  return left.text === right.text || left.part === right.part
    || Boolean(refinements[left.part]?.includes(right.part) || refinements[right.part]?.includes(left.part));
}
function moreSpecific(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const first = location(a), second = location(b);
  if (refinements[first.part]?.includes(second.part)) {
    if (first.position) return `${a}; ${b}`;
    return first.side && !second.side ? `${first.side} ${b}` : b;
  }
  if (refinements[second.part]?.includes(first.part)) {
    if (second.position) return `${a}; ${b}`;
    return second.side && !first.side ? `${second.side} ${a}` : a;
  }
  if (!first.position && second.position) return first.side && !second.side ? `${first.side} ${b}` : b;
  return !first.side && second.side ? `${second.side} ${a}` : a;
}
function joinFacts(a: string | null, b: string | null, separator: string): string | null {
  if (!a) return b;
  if (!b) return a;
  if (` ${normalized(a)} `.includes(` ${normalized(b)} `)) return a;
  if (` ${normalized(b)} `.includes(` ${normalized(a)} `)) return b;
  return `${a}${separator}${b}`;
}
const genericActivity = (name: string) => /^(?:(?:some )?(?:problems?|trouble|difficulty|difficulties) (?:with |in )?(?:eating|dressing|getting dressed|walking|sleeping|working|daily activities)|(?:eating|dressing|walking|sleeping|working) (?:problems?|difficulty))$/i.test(name.trim());
const sensation = (name: string) => /\b(?:pain|ache|aching|hurt|hurting|itch|itchy|itching|itchiness|sore|soreness|discomfort|tingling|burning)\b/i.test(name);
function conflicts(a: Symptom, b: Symptom): boolean {
  // Distinct scores/timing must not silently become one complaint. Leave the
  // entries available for review when association would discard a fact.
  return (['severityScore', 'severity', 'trend', 'duration', 'firstOccurrence'] as const).some(key =>
    a[key] != null && b[key] != null && normalized(String(a[key])) !== normalized(String(b[key])));
}

/** Reconcile fragments of the ONE details reply, never unrelated initial topics.
 * Gemini remains responsible for extraction; this only groups already extracted
 * facts with a unique existing complaint and moves generic activity effects into
 * their field. Raw speech is retained by Checkins for review.
 */
export function reconcileSymptomDetails<T extends Extraction>(extraction: T, record: HealthRecord, transcript: string, excludedIds: string[] = []): T {
  if (/\b(?:separate|unrelated|different problem|another problem)\b/i.test(transcript)) return extraction;
  const existing = record.symptoms.filter(item => !excludedIds.includes(item.id));
  if (!existing.length) return extraction;
  const effective = new Map<string, Symptom>(existing.map(item => [item.id, structuredClone(item)]));
  for (const patch of extraction.symptoms) {
    const target = patch.id ? effective.get(patch.id) : undefined;
    if (target) for (const [key, value] of Object.entries(patch)) if (value != null) Object.assign(target, { [key]: value });
  }
  const removed = new Set<Symptom>();
  const changed = new Set<string>();
  const originalById = new Map(existing.map(item => [item.id, item]));
  const compatibleArea = (target: Symptom, patch: Symptom) => {
    const original = originalById.get(target.id!)!;
    const oldLocation = location(original.location);
    if (oldLocation.compound) return false;
    const oldSide = oldLocation.side, newSide = location(patch.location).side;
    return !(oldSide && newSide && oldSide !== newSide) && sameArea(target.location, patch.location);
  };
  const combine = (target: Symptom, patch: Symptom, activity: boolean) => {
    if (conflicts(target, patch)) return false;
    const next = { ...target };
    for (const [key, value] of Object.entries(patch))
      if (!['id', 'name', 'location', 'functionalImpact'].includes(key) && value != null) Object.assign(next, { [key]: value });
    if (!activity) {
      next.name = joinFacts(target.name, patch.name, ' and ')!;
      next.location = moreSpecific(target.location, patch.location);
    }
    next.functionalImpact = joinFacts(target.functionalImpact,
      activity ? joinFacts(patch.name, patch.functionalImpact, '; ') : patch.functionalImpact, '; ');
    if (next.name.length > 500 || (next.location?.length ?? 0) > 500 || (next.functionalImpact?.length ?? 0) > 500) return false;
    Object.assign(target, next);
    changed.add(target.id!);
    removed.add(patch);
    return true;
  };
  // A descriptor at the same site (or a clear refinement such as arm→elbow)
  // enriches one existing complaint. Different sites/sides remain independent.
  for (const patch of extraction.symptoms) {
    if (patch.id || genericActivity(patch.name) || !sensation(patch.name)) continue;
    const candidates = [...effective.values()].filter(target => compatibleArea(target, patch));
    if (candidates.length === 1) combine(candidates[0]!, patch, false);
  }
  const newComplaints = extraction.symptoms.filter(patch => !patch.id && !removed.has(patch) && !genericActivity(patch.name));
  for (const patch of extraction.symptoms) {
    if (patch.id || !genericActivity(patch.name)) continue;
    const candidates = [...effective.values()].filter(target => !patch.location || compatibleArea(target, patch));
    // An unlocalized activity effect is safe only with one complaint in this
    // reply. Never attach it to the first of several symptoms by array order.
    const competing = newComplaints.some(item => !patch.location || !item.location || sameArea(item.location, patch.location));
    if (candidates.length === 1 && !competing) combine(candidates[0]!, patch, true);
  }
  return { ...extraction, symptoms: [
    ...extraction.symptoms.filter(patch => !removed.has(patch)),
    ...[...changed].map(id => effective.get(id)!),
  ] };
}
