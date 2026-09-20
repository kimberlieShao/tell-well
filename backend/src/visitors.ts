import { CheckinLog } from './checkin-log.js';

// On a public deployment every visitor's browser gets its own demo switch and its own saved check-ins.
// The switch itself lives in the visitor's cookie. The check-ins live here, in memory like the sessions:
// a restart clears them. Least recently used visitors are dropped once there are too many or one has
// been idle for a while, so a crowd of visitors cannot fill the server's memory.

export const VISITOR_COOKIE = 'tw_visitor';
export const DEMO_COOKIE = 'tw_demo';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isVisitorId = (value: string | undefined): value is string => value !== undefined && UUID.test(value);

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

export interface VisitorEntry { log: CheckinLog; seeded: boolean; seen: number }

export class Visitors {
  private entries = new Map<string, VisitorEntry>();
  constructor(private options: { maxVisitors?: number; idleMs?: number; now?: () => number } = {}) {}
  private now() { return this.options.now?.() ?? Date.now(); }

  get size() { return this.entries.size; }

  /** This visitor's entry, created on first use. Using it makes it the most recent. */
  get(id: string): VisitorEntry {
    const now = this.now();
    const idleMs = this.options.idleMs ?? 2 * 60 * 60 * 1000;
    for (const [other, entry] of this.entries) {
      if (now - entry.seen <= idleMs) break; // oldest first: the rest are newer
      this.entries.delete(other);
    }
    const entry = this.entries.get(id) ?? { log: new CheckinLog(this.options.now), seeded: false, seen: now };
    entry.seen = now;
    this.entries.delete(id);
    this.entries.set(id, entry);
    const max = this.options.maxVisitors ?? 300;
    while (this.entries.size > max) this.entries.delete(this.entries.keys().next().value!);
    return entry;
  }
}
