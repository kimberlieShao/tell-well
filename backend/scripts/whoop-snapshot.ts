// Capture real WHOOP nights to backend/demo-data/whoop-snapshot.json, so a deployment that cannot
// reach the connector still shows measured numbers. Run with the connector up:
//   npm run whoop:snapshot            38 nights, the same span the demo person covers
//   npm run whoop:snapshot -- 60      a different number of nights
import { writeFileSync } from 'node:fs';
import { metricKeys, whoopSource } from '../src/biometrics.js';

const nightsWanted = Number(process.argv[2] ?? 38);
if (!Number.isInteger(nightsWanted) || nightsWanted < 1 || nightsWanted > 365) {
  throw new Error('Give a number of nights between 1 and 365.');
}
const base = process.env.WHOOP_URL ?? 'http://127.0.0.1:8000';
const out = new URL('../demo-data/whoop-snapshot.json', import.meta.url);

// Ask for extra: WHOOP has no row for a night you did not wear the band.
const rows = await whoopSource(base).fetchDays(Math.min(365, Math.round(nightsWanted * 2.5)));
const nights = rows
  .filter(row => metricKeys.some(key => row[key] !== null))
  .sort((a, b) => a.date.localeCompare(b.date))
  .slice(-nightsWanted);
if (!nights.length) throw new Error(`The connector at ${base} returned no nights with any readings.`);

writeFileSync(out, JSON.stringify({
  about: 'A snapshot of real WHOOP nights, taken so the deployed app can show real wearable data '
    + 'without reaching the connector. Not generated: every number came from the band. Refresh it '
    + 'with: npm run whoop:snapshot (needs the connector running).',
  capturedAt: new Date().toLocaleDateString('en-CA'),
  nights,
}, null, 2) + '\n');

const missing = metricKeys.filter(key => nights.every(night => night[key] === null));
console.log(`Wrote ${nights.length} nights (${nights[0].date} → ${nights.at(-1)!.date}) to ${out.pathname}`);
if (nights.length < nightsWanted) console.log(`Asked for ${nightsWanted}; WHOOP only had ${nights.length} nights with readings.`);
if (missing.length) console.log(`No readings at all for: ${missing.join(', ')}. The app will show those as "—".`);
