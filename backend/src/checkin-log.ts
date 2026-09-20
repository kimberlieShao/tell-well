import { screenText, type Screen } from './safety.js';
import type { Day, NudgeFeedback } from './nudges.js';
import type { CheckinResponse } from './schema.js';

// What the home page's "Worth a look" box needs: saved check-ins, the latest red-flag screen and
// nudge feedback. Like check-in sessions, this is a prototype store in memory: a restart clears it.

const SEVERITY_SCORE = { mild: 3, moderate: 5, severe: 8 } as const;
const ALERT_HOURS = 24;

export const localDate = (date: Date) => date.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

export class CheckinLog {
  private saved = new Map<string, { date: string; symptoms: { name: string; score: number | null }[] }>();
  private alert: (Screen & { at: number }) | null = null;
  readonly feedback: NudgeFeedback[] = [];
  constructor(private now: () => number = Date.now) {}

  today() { return localDate(new Date(this.now())); }

  /** Screen anything the person said. The newest red flag stays until it is read or a day passes. */
  screen(said: string | undefined) {
    if (!said) return;
    const result = screenText(said);
    if (result.level !== 'none') this.alert = { ...result, at: this.now() };
  }

  currentAlert(): Screen | null {
    if (!this.alert || this.now() - this.alert.at > ALERT_HOURS * 3_600_000) return null;
    const { level, flags, advice } = this.alert;
    return { level, flags, advice };
  }

  dismissAlert() { this.alert = null; }

  /** Remember a confirmed check-in. Saving the same session twice replaces its entry. */
  remember(saved: CheckinResponse) {
    if (saved.status !== 'saved' || !saved.savedAt) return;
    this.saved.set(saved.sessionId, {
      date: localDate(new Date(saved.savedAt)),
      symptoms: saved.symptoms.map(s => ({ name: s.name, score: s.severityScore ?? (s.severity ? SEVERITY_SCORE[s.severity] : null) })),
    });
  }

  days(): Day[] {
    const flares = new Set(this.feedback.filter(f => f.verdict === 'was_a_flare').map(f => f.date));
    const byDate = new Map<string, Day>();
    for (const entry of this.saved.values()) {
      const day = byDate.get(entry.date) ?? { date: entry.date, symptoms: [], peak: null, flare: flares.has(entry.date) };
      for (const symptom of entry.symptoms) {
        day.symptoms.push({ name: symptom.name });
        if (symptom.score !== null) day.peak = Math.max(day.peak ?? 0, symptom.score);
      }
      byDate.set(entry.date, day);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}
