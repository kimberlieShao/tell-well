// Home page wearable section: last night compared with the person's own usual
// (from /api/biometrics), plus live heart rate over Bluetooth.

// concern: which direction is worth mentioning to a doctor.
export const METRICS = {
  restingHr: { label: 'Resting heart rate', unit: 'bpm', decimals: 0, concern: 'high' },
  hrv: { label: 'Heart rate variability', unit: 'ms', decimals: 0, concern: 'low' },
  sleepHours: { label: 'Sleep', unit: 'h', decimals: 1, concern: 'low' },
  skinTemp: { label: 'Skin temperature', unit: '°C', decimals: 1, concern: 'high' },
  spo2: { label: 'Blood oxygen', unit: '%', decimals: 1, concern: 'low' },
  respiratoryRate: { label: 'Respiratory rate', unit: 'breaths/min', decimals: 1, concern: 'high' },
};

const TILES = [
  { key: 'sleepHours', label: 'Sleep', icon: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="#ec7d68"><path d="M20 15.4 C18.6 19 15 21.6 11 21.6 C5.8 21.6 2 17.4 2 12.4 C2 7.6 5.6 3.6 10.2 3 C7.8 5.2 6.6 8 6.8 11 C7.2 15.8 11.4 19.4 16.2 19 C17.6 18.8 19 18.2 20 17.4 C20.6 17 20.4 16 20 15.4 Z"/></svg>` },
  { key: 'skinTemp', label: 'Skin temp', icon: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="#ec7d68"><path d="M12 2.4 C13.8 2.4 15.2 3.8 15.2 5.6 L15.2 13.4 C16.4 14.4 17.2 15.8 17.2 17.4 C17.2 20.2 14.8 22.4 12 22.4 C9.2 22.4 6.8 20.2 6.8 17.4 C6.8 15.8 7.6 14.4 8.8 13.4 L8.8 5.6 C8.8 3.8 10.2 2.4 12 2.4 Z"/><path d="M12 15.2 C13.4 15.2 14.4 16.2 14.4 17.5 C14.4 18.8 13.4 19.8 12 19.8 C10.6 19.8 9.6 18.8 9.6 17.5 C9.6 16.2 10.6 15.2 12 15.2 Z" fill="#fbe4de"/></svg>` },
  { key: 'spo2', label: 'Blood oxygen', icon: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="#ec7d68"><path d="M9.4 3.6 C13.6 3.6 16.8 7 16.8 11.2 C16.8 15.4 13.6 18.6 9.4 18.6 C5.4 18.6 2.2 15.4 2.2 11.2 C2.2 7 5.4 3.6 9.4 3.6 Z"/><path d="M9.4 7.2 C11.6 7.2 13.2 8.9 13.2 11.1 C13.2 13.3 11.6 15 9.4 15 C7.3 15 5.7 13.3 5.7 11.1 C5.7 8.9 7.3 7.2 9.4 7.2 Z" fill="#fbe4de"/><path d="M18.4 13.4 C20.4 13.4 22 15 22 17 C22 19 20.4 20.6 18.4 20.6 C16.4 20.6 14.8 19 14.8 17 C14.8 15 16.4 13.4 18.4 13.4 Z"/></svg>` },
];

// Red up/down when outside the person's usual range; green arrow pointing at the number when inside it.
export const ARROWS = {
  higher: { symbol: '↑', className: 'up', label: 'Above your usual range' },
  lower: { symbol: '↓', className: 'down', label: 'Below your usual range' },
  usual: { symbol: '←', className: 'in', label: 'Within your usual range' },
};

const NOT_CONNECTED = {
  not_running: "Can't reach your wearable data right now.",
  not_connected: 'No wearable connected yet.',
  not_configured: 'No wearable connected yet.',
  reconnect: 'Your wearable needs to be reconnected.',
};

export function mountWearable(doc, { apiBase = '' } = {}) {
  renderTiles(doc, null);
  matchTileHeights(doc);
  loadNightly(doc, apiBase);
  doc.getElementById('connectHr')?.addEventListener('click', () => connectLive(doc));
}

// Keep the "Today's health" and wearable tiles the same height at every screen width,
// even when a line wraps in one row but not the other.
function matchTileHeights(doc) {
  const home = doc.querySelector('.patient-home');
  if (!home || typeof ResizeObserver === 'undefined') return;
  let frame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      home.style.removeProperty('--tile-height');
      const tallest = Math.max(0, ...[...home.querySelectorAll('.patient-metric')].map(tile => tile.offsetHeight));
      if (tallest) home.style.setProperty('--tile-height', `${tallest}px`);
    });
  }).observe(home);
}

async function loadNightly(doc, apiBase) {
  const status = doc.getElementById('wearableStatus');
  if (!status) return;
  let message = "Wearable data isn't available right now.";
  try {
    const data = await (await fetch(`${apiBase}/api/biometrics`)).json();
    if (data.connected && data.date) {
      const day = new Date(`${data.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      status.textContent = data.source === 'demo' ? `Example data · ${day}` : `Updated ${day}`;
      renderTiles(doc, data.readings ?? {});
      renderTable(doc, data.readings ?? {});
      return;
    }
    message = data.connected ? 'No nights recorded yet.' : NOT_CONNECTED[data.reason] ?? message;
    if (data.message) console.info('Wearable:', data.message);
  } catch { /* keep the generic message */ }
  status.textContent = message;
  renderTiles(doc, {});
  renderTable(doc, null);
}

const el = (doc, tag, className, text = '') => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
};

const format = (key, value) => value == null ? '—' : value.toFixed(METRICS[key].decimals);

export function usualRange(key, reading) {
  const { unit, decimals } = METRICS[key];
  if (!reading?.baseline) return reading?.status === 'building' ? 'Learning (needs 7 nights)' : '—';
  return `${reading.baseline.usualLow.toFixed(decimals)}–${reading.baseline.usualHigh.toFixed(decimals)} ${unit}`;
}

function arrow(doc, reading) {
  const a = reading?.value != null && ARROWS[reading.status];
  if (!a) return '';
  const node = el(doc, 'span', `trend-arrow ${a.className}`, a.symbol);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', a.label);
  node.title = a.label;
  return node;
}

// Same markup as the "Today's health" tiles, so both rows are the same size.
function renderTiles(doc, readings) {
  const grid = doc.getElementById('wearableTiles');
  if (!grid) return;
  grid.replaceChildren(...TILES.map(({ key, label, icon }) => {
    const reading = readings?.[key];
    const tile = el(doc, 'article', 'patient-metric');
    const name = el(doc, 'div', 'patient-metric-label');
    const mark = el(doc, 'span', 'patient-metric-icon');
    mark.innerHTML = icon; // a fixed drawing, no data from anywhere
    name.append(mark, label);
    const value = el(doc, 'div', 'patient-metric-value', format(key, reading?.value));
    value.append(el(doc, 'span', 'metric-unit', METRICS[key].unit));
    tile.append(name, value);
    const line = rangeLine(doc, reading);
    if (line) tile.append(line);
    tile.append(el(doc, 'div', 'patient-metric-foot', readings ? (reading?.baseline ? `Usual ${usualRange(key, reading)}` : usualRange(key, reading)) : 'Loading…'));
    return tile;
  }));
}

// The usual range as a shaded band, with a dot for last night: green inside it, red outside.
function rangeLine(doc, reading) {
  const baseline = reading?.baseline;
  if (!baseline || reading.value == null) return null;
  const low = baseline.median - 4 * baseline.spread; // the line spans 4 spreads either side of the median
  const at = v => Math.min(97, Math.max(3, ((v - low) / (8 * baseline.spread)) * 100));
  const line = el(doc, 'div', 'wearable-range');
  line.setAttribute('role', 'img');
  line.setAttribute('aria-label', ARROWS[reading.status]?.label ?? 'Compared with your usual range');
  const band = el(doc, 'span', 'wearable-range-band');
  band.style.left = `${at(baseline.usualLow)}%`;
  band.style.width = `${at(baseline.usualHigh) - at(baseline.usualLow)}%`;
  const dot = el(doc, 'span', reading.status === 'usual' ? 'wearable-range-dot' : 'wearable-range-dot out');
  dot.style.left = `${at(reading.value)}%`;
  line.append(band, dot);
  return line;
}

function renderTable(doc, readings) {
  const body = doc.getElementById('wearableTableBody');
  if (!body) return;
  if (!readings) {
    const row = el(doc, 'tr');
    const cell = el(doc, 'td', 'empty', 'No wearable data yet.');
    cell.colSpan = 3;
    row.append(cell);
    body.replaceChildren(row);
    return;
  }
  body.replaceChildren(...Object.keys(METRICS).map(key => {
    const reading = readings[key];
    const row = el(doc, 'tr');
    const value = el(doc, 'td', 'value', reading?.value == null ? '—' : `${format(key, reading.value)} ${METRICS[key].unit}`);
    value.append(arrow(doc, reading));
    row.append(el(doc, 'td', '', METRICS[key].label), value, el(doc, 'td', 'muted', usualRange(key, reading)));
    return row;
  }));
}

function parseHeartRate(view) {
  const flags = view.getUint8(0);
  const is16bit = flags & 0x01;
  const hasEnergy = flags & 0x08;
  const hasRR = flags & 0x10;

  let offset = 1;
  const bpm = is16bit ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += is16bit ? 2 : 1;
  if (hasEnergy) offset += 2;

  const rrMs = [];
  while (hasRR && offset + 1 < view.byteLength) {
    rrMs.push(Math.round(view.getUint16(offset, true) / 1024 * 1000));
    offset += 2;
  }
  return { bpm, rrMs };
}

async function connectLive(doc) {
  const card = doc.getElementById('liveCard');
  const bpmEl = doc.getElementById('liveBpm');
  const pill = doc.getElementById('livePill');
  const status = doc.getElementById('liveStatus');
  const button = doc.getElementById('connectHr');
  const show = (live, message) => {
    card.classList.toggle('is-live', live);
    pill.textContent = live ? 'Live' : 'Not connected';
    status.textContent = message;
  };
  if (!navigator.bluetooth) { status.textContent = 'Live heart rate needs Chrome on a laptop or Android phone.'; return; }
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    device.addEventListener('gattserverdisconnected', () => {
      bpmEl.textContent = '—';
      show(false, 'Disconnected.');
      button.disabled = false;
      button.textContent = 'Reconnect';
    });
    status.textContent = 'Connecting…';
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const measurement = await service.getCharacteristic('heart_rate_measurement');
    measurement.addEventListener('characteristicvaluechanged', (event) => {
      const { bpm } = parseHeartRate(event.target.value);
      bpmEl.textContent = String(bpm);
      if (bpm > 0) card.style.setProperty('--beat', `${(60 / bpm).toFixed(2)}s`); // the heart pulses at your rate
    });
    await measurement.startNotifications();
    show(true, 'Connected');
    button.textContent = 'Connected';
  } catch (error) {
    show(false, error.name === 'NotFoundError' ? 'No device chosen. Is heart rate broadcast on?' : `Couldn't connect: ${error.message}`);
    button.disabled = false;
    button.textContent = 'Connect device';
  }
}
