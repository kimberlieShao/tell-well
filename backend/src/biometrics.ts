export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const metricKeys = ['restingHr', 'hrv', 'skinTemp', 'spo2', 'sleepHours', 'respiratoryRate'] as const;
export type MetricKey = typeof metricKeys[number];
export interface MetricSpec { label: string; unit: string; concern: 'high' | 'low'; minSpread: number; decimals: number }
export const METRICS: Record<MetricKey, MetricSpec> = {
  restingHr: { label: 'Resting heart rate', unit: 'bpm', concern: 'high', minSpread: 1, decimals: 0 },
  hrv: { label: 'Heart rate variability', unit: 'ms', concern: 'low', minSpread: 3, decimals: 0 },
  skinTemp: { label: 'Skin temperature', unit: '°C', concern: 'high', minSpread: 0.1, decimals: 1 },
  spo2: { label: 'Blood oxygen', unit: '%', concern: 'low', minSpread: 0.5, decimals: 1 },
  sleepHours: { label: 'Sleep', unit: 'h', concern: 'low', minSpread: 0.3, decimals: 1 },
  respiratoryRate: { label: 'Respiratory rate', unit: '/min', concern: 'high', minSpread: 0.3, decimals: 1 },
};
export const formatMetric = (key: MetricKey, value: number) => {
  const { unit, decimals } = METRICS[key];
  return `${value.toFixed(decimals)}${unit === '%' || unit === '°C' || unit === 'h' ? '' : ' '}${unit}`;
};

export const formatRange = (key: MetricKey, low: number, high: number) => {
  const { unit, decimals } = METRICS[key];
  return `${low.toFixed(decimals)}–${high.toFixed(decimals)}${unit === '%' || unit === '°C' || unit === 'h' ? '' : ' '}${unit}`;
};

export type WearableDay = { date: string } & Record<MetricKey, number | null>;
export interface BiometricsSource {
  name: 'whoop' | 'demo';
  connectUrl: string | null;
  fetchDays(days: number): Promise<WearableDay[]>;
  account(): Promise<string | null>;
}
export class BiometricsUnavailable extends Error {
  constructor(public reason: 'not_running' | 'not_connected' | 'reconnect' | 'not_configured' | 'error', message: string) { super(message); }
}

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function whoopSource(baseUrl: string, fetcher: typeof fetch = fetch): BiometricsSource {
  const base = baseUrl.replace(/\/+$/, '');
  const get = async (path: string) => {
    let res: Response;
    try { res = await fetcher(base + path, { signal: AbortSignal.timeout(30_000) }); } catch {
      throw new BiometricsUnavailable('not_running', `The WHOOP connector isn't running at ${base}. Start it with: cd whoop && python whoop_connect.py`);
    }
    if (res.status === 409) throw new BiometricsUnavailable('not_connected', `WHOOP isn't connected yet. Open ${base} and click Connect WHOOP.`);
    if (res.status === 401) throw new BiometricsUnavailable('reconnect', `WHOOP needs to be reconnected. Open ${base}/login.`);
    if (res.status === 503) throw new BiometricsUnavailable('not_configured', 'The WHOOP connector has no client ID/secret. See whoop/README.md.');
    if (!res.ok) throw new BiometricsUnavailable('error', `The WHOOP connector returned ${res.status}.`);
    return res.json() as Promise<any>;
  };
  return {
    name: 'whoop', connectUrl: base,
    async fetchDays(days) {
      const body = await get(`/daily?days=${Math.min(365, days)}`);
      return (body.rows ?? []).map((r: any): WearableDay => ({
        date: r.date,
        restingHr: num(r.heart_rate?.resting_heart_rate), hrv: num(r.heart_rate?.hrv_rmssd_ms),
        skinTemp: num(r.skin_temp?.skin_temp_celsius), spo2: num(r.spo2?.spo2_percentage),
        sleepHours: num(r.sleep?.hours_asleep), respiratoryRate: num(r.sleep?.respiratory_rate),
      }));
    },
    async account() {
      const status = await get('/status').catch(() => null);
      return status?.user?.first_name ?? null;
    },
  };
}

/** Made-up nights for demos without a band. Every response using it says source: "demo". */
export function demoSource(today: () => string, driftDays: string[] = []): BiometricsSource {
  return {
    name: 'demo', connectUrl: null,
    async fetchDays(days) {
      const rows: WearableDay[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const date = addDays(today(), -i);
        const wobble = (k: number) => Math.sin((i + 1) * (k + 1.7)) * 0.5 + Math.sin((i + 3) * (k * 2.3 + 0.4)) * 0.5;
        const drift = driftDays.includes(date) ? 1 : 0;
        rows.push({
          date,
          restingHr: Math.round(58 + wobble(1) * 2 + drift * 7),
          hrv: Math.round(62 + wobble(2) * 5 - drift * 16),
          skinTemp: Math.round((33.6 + wobble(3) * 0.12 + drift * 0.55) * 100) / 100,
          spo2: Math.round((96.8 + wobble(4) * 0.4 - drift * 0.6) * 10) / 10,
          sleepHours: Math.round((7.3 + wobble(5) * 0.5 - drift * 1.3) * 100) / 100,
          respiratoryRate: Math.round((14.6 + wobble(6) * 0.3 + drift * 1.1) * 10) / 10,
        });
      }
      return rows;
    },
    async account() { return 'Demo'; },
  };
}

export const BASELINE_DAYS = 30;
export const MIN_BASELINE_POINTS = 7;
const MAD_TO_SD = 1.4826;
const USUAL_Z = 1.5; // within 1.5 spreads of the median counts as usual

export interface Baseline { median: number; spread: number; usualLow: number; usualHigh: number; n: number }
export interface MetricReading {
  value: number | null; baseline: Baseline | null;
  /** How far from usual, in the worrying direction (positive = worse). */
  concernZ: number | null;
  status: 'usual' | 'higher' | 'lower' | 'building' | 'missing';
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function baselineFor(rows: WearableDay[], key: MetricKey, asOf: string, exclude: Set<string>): Baseline | null {
  const start = addDays(asOf, -BASELINE_DAYS);
  const values = rows.filter(r => r.date >= start && r.date < asOf && !exclude.has(r.date) && r[key] !== null).map(r => r[key]!);
  if (values.length < MIN_BASELINE_POINTS) return null;
  const m = median(values);
  const spread = Math.max(median(values.map(v => Math.abs(v - m))) * MAD_TO_SD, METRICS[key].minSpread);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { median: r(m), spread: r(spread), usualLow: r(m - USUAL_Z * spread), usualHigh: r(m + USUAL_Z * spread), n: values.length };
}

export const concernZ = (key: MetricKey, value: number, b: Baseline) =>
  ((value - b.median) / b.spread) * (METRICS[key].concern === 'high' ? 1 : -1);

export function reading(rows: WearableDay[], key: MetricKey, day: WearableDay, exclude: Set<string>): MetricReading {
  const value = day[key];
  const baseline = baselineFor(rows, key, day.date, exclude);
  if (value === null) return { value, baseline, concernZ: null, status: 'missing' };
  if (!baseline) return { value, baseline, concernZ: null, status: 'building' };
  // Compare at the precision the app shows, so "96.0 %" is never "below" a range shown as "96.0–97.5 %".
  const shown = (n: number) => Number(n.toFixed(METRICS[key].decimals));
  const status = shown(value) < shown(baseline.usualLow) ? 'lower' : shown(value) > shown(baseline.usualHigh) ? 'higher' : 'usual';
  return { value, baseline, concernZ: Math.round(concernZ(key, value, baseline) * 100) / 100, status };
}
