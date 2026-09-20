// "Prepare for your visit": a one-page summary for the doctor with 30–90 days of wearable trends.
// It opens the print window, where "Save as PDF" turns it into a PDF.
import { loadMedications } from './medications.js';
import { ARROWS, METRICS, usualRange } from './wearable.js';

const COMPARED = { higher: 'Above usual', lower: 'Below usual', usual: 'Within usual' };
const DIRECTION = { rising: '↗ Rising', falling: '↘ Falling', steady: '→ Steady' };

export function mountVisitSummary(doc, { apiBase = '' } = {}) {
  const button = doc.getElementById('visitSummaryButton');
  button?.addEventListener('click', async () => {
    const days = Number(doc.getElementById('visitDays')?.value) || 30;
    button.disabled = true;
    button.textContent = 'Preparing…';
    try {
      const wearable = await fetch(`${apiBase}/api/biometrics?days=${days}`).then(res => res.json()).catch(() => ({ connected: false }));
      printSummary(doc, buildSummary(doc, wearable));
    } finally {
      button.disabled = false;
      button.textContent = 'Download PDF summary';
    }
  });
}

export function buildSummary(doc, wearable, now = new Date()) {
  const h = (tag, text = '', className = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  };
  const table = (headers, rows) => {
    const t = h('table');
    const head = h('tr');
    for (const text of headers) head.append(h('th', text));
    t.append(h('thead'), h('tbody'));
    t.tHead.append(head);
    for (const cells of rows) {
      const row = h('tr');
      for (const cell of cells) {
        const td = h('td');
        if (cell instanceof doc.defaultView.Node && cell.classList?.contains('vs-chart')) td.className = 'vs-chart';
        td.append(cell);
        row.append(td);
      }
      t.tBodies[0].append(row);
    }
    return t;
  };
  const value = (key, v) => v == null ? '—' : `${v.toFixed(METRICS[key].decimals)} ${METRICS[key].unit}`;
  const shortDate = date => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const connected = wearable?.connected && wearable.date;
  const readings = connected ? wearable.readings ?? {} : {};
  const nights = connected ? wearable.days ?? [] : [];
  const trends = Object.fromEntries(Object.keys(METRICS).map(key => [key, trendFor(key, nights, readings[key])]));
  const meds = loadMedications();
  // Saved check-ins as the Trends view lists them (rendered by new-ui.js).
  const checkins = [...doc.querySelectorAll('.checkin-history-row')].slice(0, 5)
    .map(row => [row.querySelector('.checkin-history-date')?.textContent ?? '', row.querySelector('.checkin-history-copy')?.textContent ?? '']);
  const greeted = doc.querySelector('.patient-greeting h1')?.textContent ?? '';
  const name = greeted.split(',').slice(1).join(',').trim() || doc.querySelector('.topbar .crumb')?.textContent.split(' / ')[0].trim();

  const summary = h('section', '', 'visit-summary');
  summary.append(h('h1', 'Health summary for your visit'));
  summary.append(h('p', [name, `Prepared ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
    nights.length ? `Covers ${shortDate(nights[0].date)} – ${shortDate(nights.at(-1).date)} (${nights.length} nights)` : ''].filter(Boolean).join(' · '), 'vs-meta'));
  if (wearable?.source === 'demo') summary.append(h('p', 'The wearable numbers below are example data, not a real person.', 'vs-warning'));
  summary.append(h('p', "Wearable numbers are compared with this person's own usual range (the 30 nights before the latest night). A difference or a trend is something to talk about, not a diagnosis.", 'vs-note'));

  summary.append(h('h2', 'Questions to ask'));
  const list = h('ol');
  for (const question of questions(readings, trends, meds, checkins, value, nights.length)) list.append(h('li', question));
  summary.append(list);

  if (!connected) {
    summary.append(h('h2', 'Wearable data'));
    summary.append(h('p', 'No wearable data was available when this summary was made.'));
  } else {
    summary.append(h('h2', `Trend over the last ${nights.length} nights`));
    summary.append(h('p', 'Line = each night. Shaded band = usual range. Dot = latest night (green inside the band, red outside). Rising or falling compares the first and second half of the period.', 'vs-caption'));
    summary.append(table(['Measure', `${shortDate(nights[0].date)} → ${shortDate(nights.at(-1).date)}`, 'Median', 'Lowest–highest', 'Nights outside usual', 'Direction'],
      Object.keys(METRICS).map(key => {
        const t = trends[key];
        const direction = h('span', t?.direction ? DIRECTION[t.direction] : '—', t?.concerning ? 'vs-concern' : '');
        return [METRICS[key].label, sparkline(doc, key, nights, readings[key]), t ? value(key, t.median) : '—',
          t ? `${t.min.toFixed(METRICS[key].decimals)}–${value(key, t.max)}` : '—', t?.outside == null ? '—' : `${t.outside} of ${t.count}`, direction];
      })));

    summary.append(h('h2', `Latest night compared with usual · ${shortDate(wearable.date)}`));
    summary.append(table(['Measure', 'Latest night', 'Usual range', 'Compared with usual'], Object.keys(METRICS).map(key => {
      const r = readings[key];
      const compared = r?.value != null && COMPARED[r.status] ? `${ARROWS[r.status].symbol} ${COMPARED[r.status]}` : r?.status === 'building' ? 'Still learning' : '—';
      return [METRICS[key].label, value(key, r?.value), usualRange(key, r), h('span', compared, r?.status === 'usual' ? 'vs-in' : r?.status === 'higher' || r?.status === 'lower' ? 'vs-out' : '')];
    })));
  }

  summary.append(h('h2', 'Medications'));
  summary.append(meds.length ? table(['Medication', 'Dose', 'When'], meds.map(m => [m.name, m.dose || '—', m.when || '—'])) : h('p', 'None listed.'));

  summary.append(h('h2', 'Recent check-ins'));
  summary.append(checkins.length ? table(['Date', 'What was reported'], checkins) : h('p', 'No check-ins saved yet.'));

  summary.append(h('p', 'Made with Tell-Well from the person’s own check-ins and wearable. Not medical advice.', 'vs-footer'));
  return summary;
}

const median = values => {
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Median, range, nights outside the usual band, and whether the second half of the period
// moved at least half a spread away from the first half.
function trendFor(key, nights, reading) {
  const values = nights.map(n => n[key]).filter(v => v != null);
  if (values.length < 2) return null;
  const half = values.length >> 1;
  const change = median(values.slice(-half)) - median(values.slice(0, half));
  const b = reading?.baseline;
  const shown = v => Number(v.toFixed(METRICS[key].decimals));
  const direction = !b ? null : change >= b.spread / 2 ? 'rising' : change <= -b.spread / 2 ? 'falling' : 'steady';
  return {
    median: median(values), min: Math.min(...values), max: Math.max(...values), count: values.length, direction,
    concerning: direction === (METRICS[key].concern === 'high' ? 'rising' : 'falling'),
    outside: b ? values.filter(v => shown(v) < shown(b.usualLow) || shown(v) > shown(b.usualHigh)).length : null,
  };
}

// A small line chart of every night, with the usual range shaded and the latest night as a dot.
function sparkline(doc, key, nights, reading) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 200, H = 34, P = 3;
  const node = (tag, attrs) => {
    const n = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const wrap = doc.createElement('div');
  wrap.className = 'vs-chart';
  const values = nights.map(n => n[key]);
  const known = values.filter(v => v != null);
  if (known.length < 2) { wrap.textContent = '—'; return wrap; }
  const b = reading?.baseline;
  let lo = Math.min(...known, ...(b ? [b.usualLow] : [])), hi = Math.max(...known, ...(b ? [b.usualHigh] : []));
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const x = i => P + (i / Math.max(1, values.length - 1)) * (W - 2 * P);
  const y = v => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const svg = node('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${METRICS[key].label} over ${values.length} nights` });
  if (b) svg.append(node('rect', { x: P, y: y(b.usualHigh), width: W - 2 * P, height: Math.max(1, y(b.usualLow) - y(b.usualHigh)), fill: '#dcebdf' }));
  let path = '', pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  svg.append(node('path', { d: path.trim(), fill: 'none', stroke: '#174a3b', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }));
  const last = values.findLastIndex(v => v != null);
  svg.append(node('circle', { cx: x(last), cy: y(values[last]), r: 2.6, fill: reading?.status === 'usual' ? '#2f7a4f' : reading?.status === 'higher' || reading?.status === 'lower' ? '#c4453a' : '#174a3b' }));
  wrap.append(svg);
  return wrap;
}

// Up to three plain questions: last night's biggest differences, then worrying trends,
// then check-ins and medications.
function questions(readings, trends, meds, checkins, value, nightCount) {
  const out = Object.entries(readings)
    .filter(([, r]) => r?.value != null && (r.status === 'higher' || r.status === 'lower'))
    .sort((a, b) => Math.abs(b[1].concernZ ?? 0) - Math.abs(a[1].concernZ ?? 0))
    .slice(0, 2)
    .map(([key, r]) => `My ${METRICS[key].label.toLowerCase()} was ${r.status === 'higher' ? 'above' : 'below'} my usual last night (${value(key, r.value)}; usual ${usualRange(key, r)}). Could that be related to how I’ve been feeling?`);
  const worrying = Object.entries(trends).find(([key, t]) => t?.concerning && !out.some(q => q.includes(METRICS[key].label.toLowerCase())));
  if (worrying) out.push(`My ${METRICS[worrying[0]].label.toLowerCase()} has been ${worrying[1].direction} over the last ${nightCount} nights. Should we keep an eye on that?`);
  if (checkins.length) out.push('Looking at my recent check-ins, is there a pattern I should keep tracking?');
  if (meds.length) out.push('Are my current medications and doses still right for me?');
  if (!out.length) out.push('Is there anything you would like me to track before my next visit?');
  return out.slice(0, 3);
}

function printSummary(doc, summary) {
  doc.getElementById('pw-visit-summary')?.remove();
  summary.id = 'pw-visit-summary';
  doc.body.append(summary);
  const title = doc.title;
  doc.title = `Health summary ${new Date().toLocaleDateString('en-CA')}`; // the suggested PDF file name
  doc.body.classList.add('printing-visit-summary');
  window.addEventListener('afterprint', () => {
    doc.body.classList.remove('printing-visit-summary');
    doc.title = title;
  }, { once: true });
  window.print();
}
