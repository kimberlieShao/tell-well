import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { addDays, metricKeys, type BiometricsSource, type WearableDay } from './biometrics.js';
import { localDate } from './checkin-log.js';
import { recordSchema } from './schema.js';

// Arthur Itis: an example person with rheumatoid arthritis, for the demo toggle.
// Everything he "said" and every reading lives in backend/demo-data/arthur-itis.json — edit that file,
// not this one. His check-ins use the same fields as a real saved record, so when the Records
// calendar reads real data it reads the same shape. Every response built here says source: "demo",
// and the app labels it "Example data" on screen.

/** A saved check-in, exactly as the record contract stores one, plus when it was saved. */
const demoCheckinSchema = z.strictObject({
  sessionId: z.uuid(),
  savedAt: z.iso.datetime(),
  ...recordSchema.shape,
});

const demoFileSchema = z.strictObject({
  about: z.string(),
  name: z.string().min(1),
  condition: z.string().min(1),
  anchorDate: z.iso.date(),
  checkins: z.array(demoCheckinSchema).min(1),
  quietDays: z.array(z.strictObject({
    date: z.iso.date(), pain: z.number().nullable(),
    systolic: z.number().nullable(), diastolic: z.number().nullable(),
    taken: z.number(), due: z.number(), note: z.string(),
  })),
  nights: z.array(z.strictObject({
    date: z.iso.date(),
    ...Object.fromEntries(metricKeys.map(key => [key, z.number().nullable()])),
  })),
});

export type DemoFile = z.infer<typeof demoFileSchema>;
export type DemoRecord = z.infer<typeof demoCheckinSchema>;

function load(): DemoFile {
  const path = new URL('../demo-data/arthur-itis.json', import.meta.url);
  const parsed = demoFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`backend/demo-data/arthur-itis.json does not match the record contract:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

const file = load();
export const DEMO_NAME = file.name;
export const DEMO_CONDITION = file.condition;

const SEVERITY_SCORE = { mild: 3, moderate: 5, severe: 8 } as const;
const DAY_MS = 86_400_000;
const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** How far the plain calendar rows (nights, quiet days) move to land on the day of the demo. */
const shiftFor = (today: string) => daysBetween(file.anchorDate, today);

// A check-in is an instant, and the calendar files it under the local day it happened on. Anchor it
// on that same local day, so the newest one lands on the demo day in any timezone, not just this one.
const newestCheckin = file.checkins.reduce((a, b) => Date.parse(a.savedAt) >= Date.parse(b.savedAt) ? a : b);
const checkinAnchor = localDate(new Date(newestCheckin.savedAt));
const shiftForCheckins = (today: string) => daysBetween(checkinAnchor, today);

const scoreOf = (s: DemoRecord['symptoms'][number]) =>
  s.severityScore ?? (s.severity ? SEVERITY_SCORE[s.severity] : null);

/** The stored records, moved onto the demo week. Oldest first. */
export function arthritisRecords(today: string): DemoRecord[] {
  const shift = shiftForCheckins(today);
  const moved = shift
    ? file.checkins.map(c => ({ ...c, savedAt: new Date(Date.parse(c.savedAt) + shift * DAY_MS).toISOString() }))
    : file.checkins;
  return moved.slice().sort((a, b) => a.savedAt.localeCompare(b.savedAt));
}

/** A day with no check-in but a short daily reading, as the Trends tab draws it. Dates are moved onto the demo week. */
export type QuietDay = DemoFile['quietDays'][number];

export function arthritisQuietDays(today: string): QuietDay[] {
  const shift = shiftFor(today);
  return file.quietDays.map(day => ({ ...day, date: addDays(day.date, shift) }));
}

/** What the Profile page shows for the example person: only what the demo file actually holds. */
export interface DemoProfile {
  name: string;
  condition: string;
  medications: { name: string; dose: string | null; description: string | null }[];
}

export function arthritisProfile(): DemoProfile {
  // The medication list is what he reports across his check-ins, in the order he first mentions each one.
  const medications = new Map<string, DemoProfile['medications'][number]>();
  for (const checkin of file.checkins.slice().sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
    for (const med of checkin.medications) {
      if (!med.name) continue;
      const key = med.name.trim().toLowerCase();
      const known = medications.get(key);
      medications.set(key, { name: known?.name ?? med.name, dose: med.dose ?? known?.dose ?? null, description: med.description ?? known?.description ?? null });
    }
  }
  return { name: DEMO_NAME, condition: DEMO_CONDITION, medications: [...medications.values()] };
}

// ── What the home page and Trends tab read ──────────────────────────────────

export interface DemoCheckin {
  sessionId: string;
  at: string;   // full timestamp, so two check-ins on one day keep their order
  date: string; // local day, which is how the calendar groups them
  said: string; // the opening answer, in the person's own words
  symptoms: { name: string; location: string | null; score: number | null; duration: string | null;
              impact: string | null; trend: string | null; firstOccurrence: boolean | null; said: string[] }[];
  medications: { name: string | null; description: string | null; dose: string | null;
                 status: string | null; time: string | null; said: string[] }[];
  diet: { description: string; time: string | null; waterGlasses: number | null }[];
  vitals: { name: string; value: string | null; unit: string | null; time: string | null }[];
  wellness: { status: string; statement: string } | null;
}

export function arthritisCheckins(today: string): DemoCheckin[] {
  return arthritisRecords(today).map(record => {
    const answers = record.reportedAnswers ?? [];
    const saidAbout = (id: string) => answers.filter(a => a.entityId === id).map(a => a.transcript);
    return {
      sessionId: record.sessionId,
      at: record.savedAt,
      date: localDate(new Date(record.savedAt)),
      said: answers.filter(a => a.entityId === null).map(a => a.transcript).join(' '),
      symptoms: record.symptoms.map(s => ({
        name: s.name, location: s.location, score: scoreOf(s), duration: s.duration,
        impact: s.functionalImpact, trend: s.trend, firstOccurrence: s.firstOccurrence ?? null,
        said: saidAbout(s.id),
      })),
      medications: record.medications.map(m => ({
        name: m.name, description: m.description, dose: m.dose, status: m.status, time: m.time,
        said: saidAbout(m.id),
      })),
      diet: record.diet.map(d => ({ description: d.description, time: d.time, waterGlasses: d.waterGlasses ?? null })),
      vitals: record.vitals.map(v => ({ name: v.name, value: v.value, unit: v.unit, time: v.time })),
      wellness: record.wellness,
    };
  });
}

/** Steady nights, then the last few drifting the way an inflammatory flare tends to look. */
export function arthritisNights(today: string): WearableDay[] {
  const shift = shiftFor(today);
  return file.nights.map(night => ({ ...night, date: addDays(night.date, shift) } as WearableDay));
}

export function arthritisSource(today: () => string): BiometricsSource {
  return {
    name: 'demo', connectUrl: null,
    async fetchDays(days) { return arthritisNights(today()).slice(-Math.min(days, file.nights.length)); },
    async account() { return DEMO_NAME; },
  };
}

// ── The daily series behind the Trends tab ──────────────────────────────────

export interface DemoDay {
  date: string;
  pain: number | null;
  systolic: number | null;
  diastolic: number | null;
  taken: number;
  due: number;
  note: string;
}

const bpOf = (checkin: DemoCheckin) => {
  const reading = checkin.vitals.findLast(v => /blood pressure/i.test(v.name))?.value;
  const [systolic, diastolic] = (reading ?? '').split('/').map(Number);
  return Number.isFinite(systolic) && Number.isFinite(diastolic) ? { systolic, diastolic } : null;
};

/** One row per day: the check-ins where there are any, the quiet days where there are not. */
export function arthritisSeries(today: string, days = 30): DemoDay[] {
  const shift = shiftFor(today);
  const byDate = new Map<string, DemoDay>();
  for (const quiet of file.quietDays) byDate.set(addDays(quiet.date, shift), { ...quiet, date: addDays(quiet.date, shift) });

  // A day can hold more than one check-in, so fold them together.
  for (const checkin of arthritisCheckins(today)) {
    const day = byDate.get(checkin.date) ?? { date: checkin.date, pain: null, systolic: null, diastolic: null, taken: 0, due: 0, note: '' };
    const scores = checkin.symptoms.map(s => s.score).filter((s): s is number => s !== null);
    if (scores.length) day.pain = Math.max(day.pain ?? 0, ...scores);
    else if (!checkin.symptoms.length && day.pain === null) day.pain = 0; // nothing reported is a nought, not a gap
    const bp = bpOf(checkin);
    if (bp) { day.systolic = bp.systolic; day.diastolic = bp.diastolic; }
    day.taken += checkin.medications.filter(m => m.status === 'taken').length;
    day.due += checkin.medications.filter(m => m.status === 'taken' || m.status === 'missed').length;
    const named = checkin.symptoms.map(s => s.location ? `${s.name}, ${s.location}` : s.name);
    const note = named.join('; ') || checkin.wellness?.statement || 'No symptoms reported';
    day.note = day.note && day.note !== note ? `${day.note}; ${note}` : note;
    byDate.set(checkin.date, day);
  }

  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return rows.slice(-days);
}

/** Plain counts across the recorded days. They can show what happened together, never a cause. */
export function arthritisPatterns(today: string, nights: WearableDay[] = arthritisNights(today)): string[] {
  const checkins = arthritisCheckins(today);
  const sleepByDate = new Map(nights.map(n => [n.date, n.sleepHours]));
  const worst = (c: DemoCheckin) => Math.max(0, ...c.symptoms.map(s => s.score ?? 0));
  const shortNights = checkins.filter(c => (sleepByDate.get(c.date) ?? 9) < 6.5);
  const soreAfterShort = shortNights.filter(c => worst(c) >= 5).length;
  const missed = checkins.flatMap(c => c.medications.filter(m => m.status === 'missed').map(m => ({ ...m, date: c.date })));
  const patterns: string[] = [];
  if (shortNights.length) patterns.push(`On ${soreAfterShort} of the ${shortNights.length} nights under 6.5 hours of sleep, pain the next day was 5/10 or worse.`);
  if (missed.length) {
    const days = new Set(missed.map(m => m.date)).size;
    patterns.push(`${missed.length} missed dose${missed.length === 1 ? '' : 's'} across ${days} day${days === 1 ? '' : 's'}: ${[...new Set(missed.map(m => m.name))].filter(Boolean).join(', ')}.`);
  }
  const readings = checkins.map(bpOf).filter(bp => bp !== null);
  if (readings.length >= 2) patterns.push(`Blood pressure went from ${readings[0]!.systolic} to ${readings.at(-1)!.systolic} systolic over these check-ins.`);
  const rated = checkins.flatMap(c => c.symptoms.map(s => s.score)).filter((s): s is number => s !== null);
  if (rated.length >= 4) {
    const half = rated.length >> 1;
    const early = round(rated.slice(0, half).reduce((a, b) => a + b, 0) / half, 1);
    const late = round(rated.slice(-half).reduce((a, b) => a + b, 0) / half, 1);
    patterns.push(`Reported pain averaged ${early}/10 earlier on and ${late}/10 more recently.`);
  }
  patterns.push('A few weeks is too short to show cause. These are patterns to watch and to mention to your doctor.');
  return patterns;
}

/** Everything the home page needs when the demo switch is on. */
export function arthritisToday(today: string, nights?: WearableDay[]) {
  const checkins = arthritisCheckins(today);
  const latestDate = checkins.at(-1)!.date;
  const latestToday = checkins.filter(c => c.date === latestDate);
  return {
    name: DEMO_NAME,
    condition: DEMO_CONDITION,
    bloodPressure: latestToday.flatMap(c => c.vitals).findLast(v => /blood pressure/i.test(v.name)) ?? null,
    medications: latestToday.flatMap(c => c.medications),
    checkins: checkins.slice().reverse(),
    patterns: arthritisPatterns(today, nights),
    profile: arthritisProfile(),
    series: arthritisSeries(today, 30),
    metrics: metricKeys,
  };
}
