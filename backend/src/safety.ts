// Deterministic red-flag screen. It runs on every chat message before any model sees it, so
// urgent guidance never depends on a model's judgement. Deliberately over-inclusive: a false
// positive costs one extra line of advice; a miss could cost much more.
export type Level = 'none' | 'urgent' | 'emergency';
const RANK: Record<Level, number> = { none: 0, urgent: 1, emergency: 2 };
export interface RedFlag { code: string; level: Level; label: string }

const rule = (code: string, level: Level, label: string, pattern: string) => ({ flag: { code, level, label }, pattern: new RegExp(pattern, 'gi') });
const RULES = [
  // emergency: go now
  rule('chest_pain', 'emergency', 'chest pain or pressure',
    String.raw`\bchest\b.{0,20}\b(pain|pressure|tight(ness)?|crushing|hurts?)\b|\b(pain|pressure|tightness) in (my )?chest\b`),
  rule('cant_breathe', 'emergency', 'trouble breathing',
    String.raw`\b(can'?t|cannot|couldn'?t|struggling to|hard to|trouble|difficulty) (catch my )?breath(e|ing)?\b|\bgasping\b`),
  rule('stroke_signs', 'emergency', 'possible stroke signs',
    String.raw`\b(face|facial|mouth)\b.{0,15}\bdroop|\bslurr(ed|ing) (my )?(speech|words)\b|\bsudden(ly)?\b.{0,30}\b(weak|numb|paraly[sz]ed)\b.{0,30}\b(one side|left side|right side)\b`),
  rule('thunderclap_headache', 'emergency', 'sudden severe headache', String.raw`\bworst headache\b|\bthunderclap\b`),
  rule('self_harm', 'emergency', 'thoughts of self-harm',
    String.raw`\b(kill(ing)? myself|suicid\w*|end(ing)? my life|want to die|don'?t want to (be alive|live|wake up)|self[- ]harm|hurt(ing)? myself)\b`),
  rule('vomiting_blood', 'emergency', 'vomiting or coughing up blood, or black stools',
    String.raw`\b(vomit(ing|ed)?|throwing up|threw up|coughing up|coughed up) blood\b|\b(black|tarry),? (tarry )?(stools?|poop)\b`),
  rule('seizure', 'emergency', 'seizure', String.raw`\bseizures?\b|\bconvuls\w*`),
  rule('anaphylaxis', 'emergency', 'severe allergic reaction',
    String.raw`\b(throat|tongue|lips?)\b.{0,15}\b(swell\w*|swollen|closing)\b|\banaphyla\w*`),
  rule('bladder_bowel_loss', 'emergency', 'sudden loss of bladder or bowel control',
    String.raw`\b(lost|losing|loss of|can'?t) control (of |over )?(my )?(bladder|bowels?)\b`),
  rule('sudden_vision_loss', 'emergency', 'sudden loss of vision',
    String.raw`\b(sudden(ly)?|lost|losing|loss of)\b.{0,15}\b(vision|sight)\b|\b(went|gone|going) blind\b|\bcan'?t see (out of|anything)\b`),
  // urgent: contact a clinician today
  rule('fainting', 'urgent', 'fainting or passing out',
    String.raw`\b(passed out|pass(ing)? out|fainted|faint(ing)? spells?|blacked out|lost consciousness)\b`),
  rule('fever', 'urgent', 'fever', String.raw`\bfever(ish)?\b|\b(temperature|temp) of (1\d\d|3[89])|\b(10[0-5]|3[89](\.\d)?) ?(degrees|°)`),
  rule('short_of_breath', 'urgent', 'shortness of breath', String.raw`\bshort(ness)? of breath\b|\bbreathless\w*\b|\bwinded\b`),
  rule('blood_in_stool', 'urgent', 'blood in stool',
    String.raw`\bblood\w* (in|on) (my |the )?(stool|poop|toilet)\b|\bbloody (stools?|diarrh\w*|poop)\b|\bbleeding from (my )?(bottom|rectum)\b`),
  rule('vision_change', 'urgent', 'vision changes', String.raw`\b(double|blurr(y|ed)) vision\b|\bseeing double\b|\bpain(ful)? (when )?(moving )?(my )?eyes?\b`),
  rule('confusion', 'urgent', 'new confusion', String.raw`\b(confused|confusion|disoriented)\b`),
  rule('cant_keep_fluids', 'urgent', "can't keep fluids down",
    String.raw`\bcan'?t keep (anything|fluids|water|food) down\b|\bvomit\w* (all day|non-?stop|constantly)\b`),
  rule('severe_abdominal_pain', 'urgent', 'severe abdominal pain',
    String.raw`\b(severe|excruciating|worst|unbearable)\b.{0,15}\b(abdominal|stomach|belly|tummy) pain\b`),
];

// A negation cue shortly before the match, inside the same clause, cancels it ("no chest pain").
const NEGATION = /\b(no|not|never|without|don'?t have|didn'?t( have)?|haven'?t( had)?|isn'?t|wasn'?t|denies|no more|free of)\b[^.;,!?]*$/i;
const CLAUSE_BREAK = /[.;!?]|\bbut\b/i;
const negated = (text: string, start: number) => NEGATION.test(text.slice(Math.max(0, start - 40), start).split(CLAUSE_BREAK).at(-1) ?? '');

export interface Screen { level: Level; flags: RedFlag[]; advice: string | null }

export function screenText(raw: string, emergencyNumber = '911', crisisLine = '988'): Screen {
  const text = raw.replace(/[’‘]/g, "'");
  let level: Level = 'none';
  const flags: RedFlag[] = [];
  for (const { flag, pattern } of RULES) {
    for (const m of text.matchAll(pattern)) {
      if (negated(text, m.index!)) continue;
      flags.push(flag);
      if (RANK[flag.level] > RANK[level]) level = flag.level;
      break;
    }
  }
  const labels = flags.map(f => f.label).join(', ');
  const advice = level === 'none' ? null
    : flags.some(f => f.code === 'self_harm')
      ? `It sounds like you might be having thoughts of harming yourself. You deserve support right now: call or text ${crisisLine} (Suicide & Crisis Lifeline, US), or call ${emergencyNumber} if you're in immediate danger. If you're outside the US, contact your local emergency number.`
    : level === 'emergency'
      ? `You mentioned ${labels}. That can need emergency care. If it's happening now, call ${emergencyNumber} (or your local emergency number) or go to the nearest emergency department. Don't wait to log it or to hear back from your usual care team.`
      : `You mentioned ${labels}. It's worth contacting your provider today, or an urgent care / out-of-hours line if you can't reach them. If it gets suddenly worse, call ${emergencyNumber}.`;
  return { level, flags, advice };
}
