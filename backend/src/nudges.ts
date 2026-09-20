import { addDays, baselineFor, concernZ, formatMetric, formatRange, METRICS, metricKeys, type MetricKey, type WearableDay } from './biometrics.js';
import { ApiError } from './errors.js';

export type Tier = 'note' | 'watch' | 'check_in';

/** One day of check-ins, as the home page's nudge box needs it. */
export interface Day { date: string; symptoms: { name: string }[]; peak: number | null; flare: boolean }
export interface NudgeFeedback { nudgeId: string; date: string; tier: Tier; metrics: MetricKey[]; verdict: 'was_a_flare' | 'not_a_flare' }

// Nudges, not alarms. A nudge needs two things at once: wearable numbers drifting from the
// person's own normal AND symptoms being logged. Biometrics alone never nudge (a hard workout or
// a late night looks the same). Wording is tiered, every nudge says why, and "that wasn't a flare"
// raises the bar for the metrics involved so it learns the person's pattern instead of nagging.
const TIER_RANK: Record<Tier, number> = { note: 1, watch: 2, check_in: 3 };
const TREND_DAYS = 3, TREND_Z = 1.5, SPIKE_Z = 2.5;
const SYMPTOM_WINDOW_DAYS = 5, PRIOR_WINDOW_DAYS = 14, RISING_DELTA = 1.5, COOLDOWN_DAYS = 3;
const NOT_A_FLARE_STEP = 0.25, WAS_A_FLARE_STEP = 0.1, MAX_OFFSET = 1.5, MIN_OFFSET = -0.5;

export interface Signal {
  metric: MetricKey; label: string; recentAverage: number; days: number;
  usualLow: number; usualHigh: number; concernZ: number; thresholdOffset: number;
}
export interface Nudge {
  id: string; date: string; tier: Tier; title: string; message: string; reasons: string[]; signals: Signal[];
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const round2 = (n: number) => Math.round(n * 100) / 100;
const join = (items: string[]) => items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** Per-metric threshold offsets and "wasn't a flare" counts learned from feedback. */
export function calibration(feedback: NudgeFeedback[]) {
  const offsets: Partial<Record<MetricKey, number>> = {}, dismissals: Partial<Record<MetricKey, number>> = {};
  for (const f of feedback) for (const m of f.metrics as MetricKey[]) {
    if (f.verdict === 'not_a_flare') {
      offsets[m] = Math.min(MAX_OFFSET, (offsets[m] ?? 0) + NOT_A_FLARE_STEP);
      dismissals[m] = (dismissals[m] ?? 0) + 1;
    } else if (f.verdict === 'was_a_flare') offsets[m] = Math.max(MIN_OFFSET, (offsets[m] ?? 0) - WAS_A_FLARE_STEP);
  }
  return { offsets, dismissals };
}

export function findSignals(rows: WearableDay[], asOf: string, exclude: Set<string>, offsets: Partial<Record<MetricKey, number>>): Signal[] {
  const signals: Signal[] = [];
  const windowStart = addDays(asOf, -(TREND_DAYS - 1));
  for (const key of metricKeys) {
    // Baseline from the days before the trend window, so the drift can't pull its own baseline along.
    const base = baselineFor(rows, key, windowStart, exclude);
    const recent = rows.filter(r => r.date >= windowStart && r.date <= asOf && r[key] !== null);
    const hasToday = recent.at(-1)?.date === asOf;
    if (!base || (recent.length < 2 && !hasToday)) continue;
    const offset = offsets[key] ?? 0;
    const avg = mean(recent.map(r => r[key]!));
    const trendZ = concernZ(key, avg, base);
    const lastZ = hasToday ? concernZ(key, recent.at(-1)![key]!, base) : 0;
    if ((recent.length >= 2 && trendZ >= TREND_Z + offset) || lastZ >= SPIKE_Z + offset)
      signals.push({ metric: key, label: METRICS[key].label, recentAverage: round2(avg), days: recent.length,
        usualLow: round2(base.usualLow), usualHigh: round2(base.usualHigh), concernZ: round2(Math.max(trendZ, lastZ)), thresholdOffset: offset });
  }
  return signals;
}

export function symptomContext(days: Day[], asOf: string) {
  const recentStart = addDays(asOf, -(SYMPTOM_WINDOW_DAYS - 1)), priorStart = addDays(recentStart, -PRIOR_WINDOW_DAYS);
  const recent = days.filter(d => d.date >= recentStart && d.date <= asOf && d.symptoms.length);
  const prior = days.filter(d => d.date >= priorStart && d.date < recentStart);
  const rp = recent.flatMap(d => d.peak === null ? [] : [d.peak]), pp = prior.flatMap(d => d.peak === null ? [] : [d.peak]);
  const counts = new Map<string, number>();
  for (const s of recent.flatMap(d => d.symptoms)) counts.set(s.name.toLowerCase(), (counts.get(s.name.toLowerCase()) ?? 0) + 1);
  const recentAvg = rp.length ? mean(rp) : null, priorAvg = pp.length >= 3 ? mean(pp) : null;
  return {
    daysLogged: recent.length, maxPeak: rp.length ? Math.max(...rp) : null, recentAvg, priorAvg,
    rising: recentAvg !== null && priorAvg !== null && recentAvg - priorAvg >= RISING_DELTA,
    topSymptoms: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name),
  };
}

export function proposeNudge(asOf: string, signals: Signal[], ctx: ReturnType<typeof symptomContext>, dismissals: Partial<Record<MetricKey, number>>): Nudge | null {
  if (!signals.length || ctx.daysLogged === 0) return null;
  const severe = (ctx.maxPeak ?? 0) >= 7, moderate = (ctx.maxPeak ?? 0) >= 5;
  const tier: Tier = signals.length >= 2 && (severe || (ctx.rising && ctx.daysLogged >= 3)) ? 'check_in'
    : signals.length >= 2 || moderate || ctx.rising ? 'watch' : 'note';
  const strongest = [...signals].sort((a, b) => b.concernZ - a.concernZ).map(s => s.label.toLowerCase());
  const what = strongest.length > 3 ? `${strongest.slice(0, 3).join(', ')} and ${strongest.length - 3} more` : join(strongest);
  const verb = signals.length === 1 ? 'has' : 'have';
  const symptoms = ctx.topSymptoms.length ? join(ctx.topSymptoms) : 'symptoms';
  const [title, message] = tier === 'note' ? ['Worth a note for your next visit',
    `Your ${what} ${verb} been outside your usual range for the last few days, and you've been logging ${symptoms} too. It may well be nothing. Pulsewise is pointing out the overlap so you can mention it at your next appointment.`]
    : tier === 'watch' ? ['A pattern worth watching',
    `Your ${what} ${verb} shifted away from your usual range while you've been logging ${symptoms}. Keep logging how you feel over the next few days. If it keeps building, it's worth letting your care team know sooner rather than waiting for your next visit.`]
    : ['Consider checking in with your care team',
    `Several of your numbers (${what}) are outside your usual range, and your symptoms have been more intense lately (up to ${ctx.maxPeak}/10). If this is how your flares tend to start, or things keep getting worse, now may be a good time to contact your provider. If you feel very unwell, don't wait.`];
  const reasons = signals.map(s => {
    const span = s.days > 1 ? `the last ${s.days} days` : 'last night';
    const phrase = METRICS[s.metric].concern === 'low' ? 'lower than usual' : 'higher than usual';
    return `${s.label} averaged ${formatMetric(s.metric, s.recentAverage)} over ${span}, ${phrase}. Your usual range is ${formatRange(s.metric, s.usualLow, s.usualHigh)}.`;
  });
  reasons.push(`You logged symptoms on ${ctx.daysLogged} of the last ${SYMPTOM_WINDOW_DAYS} days${ctx.maxPeak !== null ? `, peaking at ${ctx.maxPeak}/10` : ''}${ctx.topSymptoms.length ? ` (${symptoms})` : ''}.`);
  if (ctx.rising) reasons.push(`Your recent severity (${ctx.recentAvg!.toFixed(1)}/10 on average) is up from ${ctx.priorAvg!.toFixed(1)}/10 over the two weeks before.`);
  for (const s of signals) {
    const n = dismissals[s.metric];
    if (n) reasons.push(`You've said a change like this in ${s.label.toLowerCase()} wasn't a flare ${n} time${n === 1 ? '' : 's'}, so Pulsewise now waits for a bigger change before mentioning it.`);
  }
  reasons.push('These comparisons are against your own last 30 days, not population averages.');
  return { id: `${asOf}:${tier}:${signals.map(s => s.metric).join('+')}`, date: asOf, tier, title, message, reasons, signals };
}

/** Today's nudge, if any, after feedback-based calibration and a cooldown that only escalation can break. */
export function evaluateNudges(rows: WearableDay[], days: Day[], feedback: NudgeFeedback[], asOf: string): Nudge[] {
  const exclude = new Set(days.filter(d => d.flare).map(d => d.date));
  const { offsets, dismissals } = calibration(feedback);
  const nudge = proposeNudge(asOf, findSignals(rows, asOf, exclude, offsets), symptomContext(days, asOf), dismissals);
  if (!nudge) return [];
  const cooling = feedback.some(f => f.date > addDays(asOf, -COOLDOWN_DAYS) && TIER_RANK[f.tier as Tier] >= TIER_RANK[nudge.tier]);
  return cooling ? [] : [nudge];
}

/** Read back the metrics and tier a nudge id carries, so feedback needs only the id. */
export function feedbackFor(nudgeId: string, verdict: NudgeFeedback['verdict']): NudgeFeedback {
  const [date, tier, metrics] = nudgeId.split(':');
  const keys = (metrics ?? '').split('+');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !(tier in TIER_RANK) || !keys.every(k => (metricKeys as readonly string[]).includes(k)))
    throw new ApiError(400, 'UNKNOWN_NUDGE', 'That nudge id is not one this server handed out.');
  return { nudgeId, date, tier: tier as Tier, metrics: keys as MetricKey[], verdict };
}
