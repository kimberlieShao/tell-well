// Demo switch: shows Arthur Itis, an example person with rheumatoid arthritis, instead of the
// real check-ins. The wearable panel and live heart rate are untouched, so real WHOOP nights and
// the Bluetooth band still work while the example week of symptoms is on screen.

import { setDemoProfile } from './demo-profile.js';
import { rememberRecordsTab } from './records.js';

export function mountDemoToggle(doc, { apiBase = '' } = {}) {
  const box = doc.getElementById('demoToggle');
  if (!box) return;
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.id = 'demoSwitch';
  const label = doc.createElement('label');
  label.htmlFor = 'demoSwitch';
  label.textContent = 'Demo person';
  box.replaceChildren(input, label);

  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      await fetch(`${apiBase}/api/demo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: input.checked }),
      });
      rememberRecordsTab(doc); // if Records is open, the reload comes back to it
      doc.defaultView.location.reload(); // every card reads its data again
    } catch {
      input.disabled = false;
      input.checked = !input.checked;
    }
  });

  fetch(`${apiBase}/api/demo`).then(res => res.json()).then(state => {
    input.checked = !!state.on;
    if (state.locked) { input.disabled = true; label.title = 'Fixed on for this public demo'; }
    if (state.on && state.story) apply(doc, state.story);
  }).catch(() => {});
}

function apply(doc, story) {
  doc.body.classList.add('demo-on');
  setDemoProfile(story.profile); // the Profile page shows the example person while the demo is on
  const heading = doc.querySelector('.patient-greeting h1');
  if (heading) {
    const greeting = heading.textContent.split(',')[0];
    heading.replaceChildren(`${greeting}, `, el(doc, 'span', 'greeting-name', story.name));
  }
  const avatar = doc.querySelector('.topbar .avatar');
  if (avatar) avatar.textContent = story.name.charAt(0);

  // Today's health: blood pressure and medication come from the example week
  const tiles = [...doc.querySelectorAll('.patient-home > .patient-metrics:not(.wearable-tiles) .patient-metric')];
  const bp = story.bloodPressure;
  if (tiles[0] && bp) {
    tiles[0].querySelector('.patient-metric-value').replaceChildren(bp.value, el(doc, 'span', 'metric-unit', bp.unit));
    tiles[0].querySelector('.patient-metric-foot').textContent = `Taken ${bp.time}`;
  }
  // Arthur does not track blood glucose, and Trends says so. Say the same thing here.
  if (tiles[1]) {
    tiles[1].querySelector('.patient-metric-value').textContent = '—';
    tiles[1].querySelector('.patient-metric-foot').textContent = 'Not tracked by this person';
  }
  const missed = story.medications.filter(m => m.status === 'missed');
  if (tiles[2]) {
    // The card shows a plain value here, not the browser's own dose counts, so it takes the same big type as the other tiles.
    const value = tiles[2].querySelector('.patient-metric-value');
    value.classList.remove('med-progress-list');
    value.removeAttribute('aria-label');
    tiles[2].querySelector('.patient-metric-value').textContent = missed.length ? `${missed.length} missed` : 'On track';
    tiles[2].querySelector('.patient-metric-foot').textContent = missed.length
      ? `${missed.map(m => m.name).join(', ')} ${missed[0].time}`
      : story.medications.map(m => `${m.name} ${m.time}`).join(' · ');
  }

  // Medications table: today's doses with the time they were taken
  const rows = doc.getElementById('medRows');
  if (rows) rows.replaceChildren(...story.medications.map(med => {
    const row = doc.createElement('tr');
    for (const text of [med.name, med.dose, med.status === 'missed' ? `Missed · ${med.time}` : `Taken ${med.time}`]) {
      row.append(el(doc, 'td', '', text));
    }
    row.append(el(doc, 'td', 'muted', 'Example'));
    return row;
  }));

  // Recent check-ins, so the doctor summary and the Trends list show the example week
  const history = doc.querySelector('.checkin-history');
  if (history) {
    const perDay = new Map();
    for (const entry of story.checkins) perDay.set(entry.date, (perDay.get(entry.date) ?? 0) + 1);
    history.replaceChildren(...story.checkins.map(entry => {
      const row = el(doc, 'div', 'checkin-history-row');
      const when = new Date(entry.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      // Two check-ins on one day need the time to tell them apart.
      const stamp = perDay.get(entry.date) > 1
        ? `${when}, ${new Date(entry.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : when;
      row.append(el(doc, 'div', 'checkin-history-date', stamp), el(doc, 'div', 'checkin-history-copy', describe(entry)));
      return row;
    }));
  }

  // Possible patterns across the week, with counts rather than claims
  mountTrends(doc, story);

  const patterns = doc.getElementById('demoPatterns');
  if (patterns) {
    patterns.hidden = false;
    const list = el(doc, 'ul');
    for (const line of story.patterns) list.append(el(doc, 'li', '', line));
    patterns.replaceChildren(el(doc, 'strong', '', `Possible patterns · ${story.name}, example data`), list);
  }
}


const TREND = { better: 'better than last time', same: 'about the same', worse: 'worse than last time' };

/** One line describing a check-in. Anything the person did not say is left out, never shown empty. */
function describe(entry) {
  const parts = [];
  for (const s of entry.symptoms) {
    const detail = [
      s.score === null ? null : `${s.score}/10`,
      s.duration, s.impact,
      TREND[s.trend] ?? null,
      s.firstOccurrence ? 'first time' : null,
    ].filter(Boolean);
    parts.push(`${s.name}${s.location ? ` in ${s.location}` : ''}${detail.length ? ` (${detail.join(', ')})` : ''}`);
  }
  if (!entry.symptoms.length && entry.wellness) parts.push(entry.wellness.statement);
  for (const m of entry.medications) {
    if (!m.name) continue;
    const status = m.status === 'missed' ? `missed${m.time ? `, ${m.time}` : ''}` : m.time ? `${m.status} ${m.time}` : m.status;
    parts.push([m.name, m.dose].filter(Boolean).join(' ') + (status ? `: ${status}` : ''));
  }
  for (const v of entry.vitals) {
    if (!v.value) continue;
    parts.push(`${v.name}: ${[v.value, v.unit].filter(Boolean).join(' ')}${v.time ? ` at ${v.time}` : ''}`);
  }
  const water = entry.diet.map(d => d.waterGlasses).filter(g => g !== null).at(-1);
  if (water != null) { const glasses = Math.max(0, Math.round(water)); parts.push(`${glasses} ${glasses === 1 ? 'glass' : 'glasses'} of water`); }
  return parts.join('; ');
}

// ---- Trends tab: pain, blood pressure and medication for the example person ----

const RANGE_DAYS = { '7d': 7, '30d': 30, '3m': 30 };

function mountTrends(doc, story) {
  const buttons = [...doc.querySelectorAll('.trend-range-button')];
  const draw = range => renderTrends(doc, story, RANGE_DAYS[range] ?? 7, range);
  for (const button of buttons) button.addEventListener('click', () => draw(button.dataset.range));
  draw(doc.querySelector('.trend-range-button.active')?.dataset.range ?? '7d');
}

function renderTrends(doc, story, days, range) {
  const series = story.series.slice(-days);
  const painDays = series.filter(d => d.pain !== null);
  const avg = list => list.reduce((a, b) => a + b, 0) / (list.length || 1);
  const label = range === '3m' ? 'Last 30 days (all the example data there is)' : `Last ${days} days`;
  for (const node of doc.querySelectorAll('.trend-range-label')) node.textContent = label;

  // Summary cards. A day with nothing recorded is skipped, not counted as a nought.
  set(doc, 'trendPainAvg', painDays.length ? avg(painDays.map(d => d.pain)).toFixed(1) : '—');
  const firstHalf = avg(painDays.slice(0, Math.floor(painDays.length / 2)).map(d => d.pain));
  const secondHalf = avg(painDays.slice(Math.floor(painDays.length / 2)).map(d => d.pain));
  set(doc, 'trendPainTrend', painDays.length < 2 ? 'Not enough days yet'
    : secondHalf > firstHalf + 0.5 ? 'Rising over this period'
    : secondHalf < firstHalf - 0.5 ? 'Easing over this period' : 'Steady over this period');
  const bpDays = series.filter(d => d.systolic !== null && d.diastolic !== null);
  const latestBP = bpDays.at(-1);
  set(doc, 'trendBPAvg', bpDays.length ? `${Math.round(avg(bpDays.map(d => d.systolic)))}/${Math.round(avg(bpDays.map(d => d.diastolic)))}` : '—');
  set(doc, 'trendBPTrend', latestBP ? `Latest ${latestBP.systolic}/${latestBP.diastolic} mmHg` : 'No readings in this period');
  set(doc, 'trendGlucoseAvg', '—');
  set(doc, 'trendGlucoseTrend', 'Not tracked by this person');
  const taken = series.reduce((sum, d) => sum + d.taken, 0), due = series.reduce((sum, d) => sum + d.due, 0);
  set(doc, 'trendMedAdherence', due ? Math.round((taken / due) * 100) : 0);
  const missedDays = series.filter(d => d.taken < d.due);
  set(doc, 'trendMedMissed', missedDays.length ? `${missedDays.length} day${missedDays.length === 1 ? '' : 's'} with a missed dose` : 'No missed doses');

  // Pain chart
  const bars = doc.getElementById('trendBars');
  if (bars) {
    bars.classList.add('demo-chart-host');
    bars.replaceChildren(lineChart(doc, {
      series, days,
      lines: [{ key: 'pain', colour: '#ec7d68', label: 'Pain' }],
      min: 0, max: 10,
      tip: d => `${niceDate(d.date)} · pain ${d.pain}/10 · ${d.note}`,
    }));
  }

  // Blood pressure chart, in place of the empty list
  const bpPanel = [...doc.querySelectorAll('.trend-panel')].find(p => p.querySelector('.trend-panel-title')?.textContent.trim() === 'Blood Pressure');
  if (bpPanel) {
    bpPanel.querySelector('.trend-panel-meta').replaceChildren(
      'Latest reading: ', el(doc, 'strong', 'demo-strong', latestBP ? `${latestBP.systolic}/${latestBP.diastolic} mmHg` : 'none yet'));
    const holder = bpPanel.querySelector('.trend-bp-list');
    holder.classList.add('demo-chart-host');
    holder.replaceChildren(lineChart(doc, {
      series, days,
      lines: [{ key: 'systolic', colour: '#46702a', label: 'Systolic' }, { key: 'diastolic', colour: '#a0c878', label: 'Diastolic' }],
      min: 60, max: 145,
      tip: d => `${niceDate(d.date)} · ${d.systolic}/${d.diastolic} mmHg`,
    }));
  }

  // Medication: one mark per day, taken or missed
  const medList = doc.getElementById('trendMedAdherenceList');
  if (medList) {
    medList.classList.add('demo-med-strip');
    medList.replaceChildren(...series.map(d => {
      // A day with nothing recorded is not a day taken: it gets its own empty mark.
      const state = d.due === 0 ? ' none' : d.taken < d.due ? ' missed' : '';
      const mark = el(doc, 'span', `demo-med-day${state}`);
      mark.title = `${niceDate(d.date)} · ${d.due === 0 ? 'nothing recorded' : d.taken < d.due ? 'dose missed' : `${d.taken} of ${d.due} taken`}`;
      return mark;
    }));
  }
  set(doc, 'trendMedMeta', `${taken} of ${due} doses taken · ${label.toLowerCase()}`);
  const fill = doc.getElementById('trendAdherenceFill');
  if (fill) fill.style.width = `${due ? Math.round((taken / due) * 100) : 0}%`;
  set(doc, 'trendAdherenceLabel', due ? `${Math.round((taken / due) * 100)}% of doses taken` : 'No doses recorded');
}

function set(doc, id, text) {
  const node = doc.getElementById(id);
  if (node) node.textContent = text;
}

const niceDate = date => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** A small line chart with a dot per day; hovering a dot shows the reading. */
function lineChart(doc, { series, lines, min, max, tip }) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 640, H = 170, padX = 14, padY = 16;
  const node = (tag, attrs) => {
    const n = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const wrap = doc.createElement('div');
  wrap.className = 'demo-chart';
  const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, class: 'demo-chart-svg', role: 'img', 'aria-label': `${lines.map(l => l.label).join(' and ')} over ${series.length} days` });
  const x = i => padX + (i / Math.max(1, series.length - 1)) * (W - 2 * padX);
  const y = v => H - padY - ((v - min) / (max - min)) * (H - 2 * padY);
  for (const gridline of [0.25, 0.5, 0.75]) {
    svg.append(node('line', { x1: padX, x2: W - padX, y1: padY + gridline * (H - 2 * padY), y2: padY + gridline * (H - 2 * padY), stroke: '#e7e3cb', 'stroke-width': 1 }));
  }
  const tooltip = el(doc, 'div', 'demo-tip');
  for (const line of lines) {
    const points = series.map((d, i) => [x(i), d[line.key] == null ? null : y(d[line.key])]);
    let path = '', pen = false;
    for (const [px, py] of points) {
      if (py == null) { pen = false; continue; }
      path += `${pen ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)} `;
      pen = true;
    }
    svg.append(node('path', { d: path.trim(), fill: 'none', stroke: line.colour, 'stroke-width': 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    points.forEach(([px, py], i) => {
      if (py == null) return;
      const dot = node('circle', { cx: px, cy: py, r: 4.2, fill: line.colour, class: 'demo-dot', tabindex: '0' });
      const show = () => {
        tooltip.textContent = tip(series[i]);
        tooltip.style.left = `${Math.min(88, Math.max(12, (px / W) * 100))}%`; // keep it inside the card
        tooltip.hidden = false;
      };
      dot.addEventListener('mouseenter', show);
      dot.addEventListener('focus', show);
      dot.addEventListener('mouseleave', () => { tooltip.hidden = true; });
      dot.addEventListener('blur', () => { tooltip.hidden = true; });
      svg.append(dot);
    });
  }
  tooltip.hidden = true;
  const legend = el(doc, 'div', 'demo-legend');
  for (const line of lines) {
    const item = el(doc, 'span', 'demo-legend-item', line.label);
    item.style.setProperty('--dot', line.colour);
    legend.append(item);
  }
  const ends = el(doc, 'div', 'demo-axis');
  ends.append(el(doc, 'span', '', niceDate(series[0].date)), el(doc, 'span', '', niceDate(series.at(-1).date)));
  wrap.append(svg, tooltip, ends, legend);
  return wrap;
}

function el(doc, tag, className, text = '') {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
