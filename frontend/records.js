// Records page: a month calendar of past check-ins, and a dialog with everything recorded on one day.
//
// The data is a list of saved check-ins in the backend's own field names (see RECORDS-DATA-FORMAT.md):
// each has `savedAt` plus the record's symptoms, medications, diet, vitals and reportedAnswers.
// It comes from GET /api/records, which returns the example person while the demo switch is on and the
// person's own confirmed check-ins otherwise.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TREND = { better: 'Better', same: 'About the same', worse: 'Worse' };
const MEDICATION_STATUS = { taken: 'Taken', missed: 'Missed', stopped: 'Stopped', mentioned: 'Mentioned' };
// Set by the demo switch just before it reloads the page, so the reload lands back on this page.
const RETURN_KEY = 'tellwell.returnTo';

const pad = number => String(number).padStart(2, '0');
const present = value => value !== null && value !== undefined && String(value).trim() !== '';
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const list = value => (Array.isArray(value) ? value : []);

/** YYYY-MM-DD in the viewer's own time zone, which is how a check-in is assigned to a day. */
export const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseKey = key => { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day); };
const monthIndex = date => date.getFullYear() * 12 + date.getMonth();
const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
const longDate = date => date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const timeLabel = date => date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ');

/** Accepts a plain array of check-ins, or `{ checkins: [...] }` as in the data-format file. */
export function normalizeCheckins(input) {
  const checkins = Array.isArray(input) ? input : input?.checkins;
  return list(checkins).filter(checkin => checkin && !Number.isNaN(new Date(checkin.savedAt).getTime()));
}

// Only readings that have a value are shown.
const shownVitals = checkin => list(checkin.vitals).filter(vital => present(vital.value));

// A check-in counts as a record when the day dialog has something to show for it.
const hasContent = checkin => ['symptoms', 'medications', 'diet', 'reportedAnswers'].some(key => list(checkin[key]).length)
  || shownVitals(checkin).length > 0 || present(checkin.wellness?.statement);

/** Check-ins that have something to show, by local day, oldest first. */
export function groupByDay(input) {
  const days = new Map();
  const sorted = normalizeCheckins(input).filter(hasContent)
    .sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));
  for (const checkin of sorted) {
    const key = dateKey(new Date(checkin.savedAt));
    days.set(key, [...(days.get(key) ?? []), checkin]);
  }
  return days;
}

const painLevel = symptom => {
  const score = symptom.severityScore;
  const severity = present(symptom.severity) ? capitalize(symptom.severity) : null;
  if (score !== null && score !== undefined) return severity ? `${score}/10 · ${severity}` : `${score}/10`;
  return severity;
};

const fields = pairs => pairs.filter(([, value]) => present(value)).map(([label, value]) => ({ label, value: String(value) }));

const symptomRow = symptom => ({
  title: symptom.name, summary: painLevel(symptom),
  fields: fields([
    ['Pain level', painLevel(symptom)],
    ['Location', symptom.location],
    ['Since when', symptom.duration],
    ['Activities affected', symptom.functionalImpact],
    ['Trend', TREND[symptom.trend]],
    ['First time', symptom.firstOccurrence === true ? 'Yes' : symptom.firstOccurrence === false ? 'No' : null],
  ]),
});

const medicationRow = medication => {
  const status = MEDICATION_STATUS[medication.status] ?? null;
  return {
    title: present(medication.name) ? medication.name : 'Medication', summary: status,
    fields: fields([['Status', status], ['Purpose', medication.description], ['Dose', medication.dose], ['Time', medication.time]]),
  };
};

const dietRow = item => {
  const glasses = item.waterGlasses;
  const water = glasses === null || glasses === undefined ? null
    : `${glasses} ${glasses === 1 ? 'glass' : 'glasses'}${item.waterMode === 'total' ? ' in total today' : ''}`;
  return { title: item.description, summary: present(item.time) ? item.time : null, fields: fields([['Time', item.time], ['Water', water]]) };
};

const vitalRow = vital => ({
  title: `${present(vital.name) ? vital.name : 'Reading'}: ${[vital.value, vital.unit].filter(present).join(' ')}`,
  summary: null, fields: fields([['Time', vital.time]]),
});

const quoteOf = answer => ({
  question: present(answer.question) ? answer.question : null,
  text: answer.transcript,
  unconfirmed: answer.interpretation === 'unconfirmed',
});

/**
 * Everything the day dialog shows, as plain data: `notes` (well-day statements) and `groups`
 * (Symptoms, Medications, Meals, Vitals, In your own words), each with rows in time order. A row's `fields`
 * hold only values that exist. A time is attached to a row only when the day has several check-ins.
 */
export function buildDay(checkins) {
  const multiple = checkins.length > 1;
  const notes = [];
  const groups = { symptoms: [], medications: [], diet: [], vitals: [], words: [] };
  for (const checkin of checkins) {
    const time = multiple ? timeLabel(new Date(checkin.savedAt)) : null;
    const answers = list(checkin.reportedAnswers).filter(answer => present(answer.transcript));
    const known = new Set();
    for (const [category, toRow] of [['symptoms', symptomRow], ['medications', medicationRow], ['diet', dietRow], ['vitals', vitalRow]]) {
      for (const item of category === 'vitals' ? shownVitals(checkin) : list(checkin[category])) {
        known.add(item.id);
        groups[category].push({ ...toRow(item), time, quotes: answers.filter(answer => answer.entityId === item.id).map(quoteOf) });
      }
    }
    // Words that are not tied to one entry above, such as the opening description of the day.
    const loose = answers.filter(answer => !known.has(answer.entityId));
    if (loose.length) {
      const first = loose[0].transcript.trim();
      groups.words.push({ title: 'In your own words', summary: `“${first.length > 70 ? `${first.slice(0, 67)}…` : first}”`, time, fields: [], quotes: loose.map(quoteOf), standalone: true });
    }
    if (present(checkin.wellness?.statement)) notes.push({ time, text: checkin.wellness.statement });
  }
  return {
    multiple, notes,
    groups: [['symptoms', 'Symptoms'], ['medications', 'Medications'], ['diet', 'Meals'], ['vitals', 'Vitals'], ['words', 'In your own words']]
      .map(([key, title]) => ({ key, title, rows: groups[key] })).filter(group => group.rows.length),
  };
}

const storageOf = doc => { try { return doc.defaultView.sessionStorage; } catch { return null; } };

/** Called by the demo switch just before it reloads the page: if Records is open, the reload comes back to it. */
export function rememberRecordsTab(doc) {
  const view = doc.getElementById('recordsView');
  if (!view || view.hidden) return;
  try { storageOf(doc)?.setItem(RETURN_KEY, 'records'); } catch { /* the reload just lands on Home */ }
}

function takeReturnFlag(doc) {
  try {
    const storage = storageOf(doc);
    const returning = storage?.getItem(RETURN_KEY) === 'records';
    storage?.removeItem(RETURN_KEY);
    return returning;
  } catch { return false; }
}

/**
 * `load` returns `{ source, name, checkins }`; by default it asks GET /api/records. The data is read
 * again every time the Records tab is opened, so a check-in saved a moment ago is there.
 */
export function mountRecords(doc, { apiBase = '', load, now = new Date() } = {}) {
  const grid = doc.getElementById('recordsGrid');
  const overlay = doc.getElementById('recordsDay');
  if (!grid || !overlay) return null;
  const title = doc.getElementById('recordsMonthTitle');
  const previous = doc.getElementById('recordsPrev');
  const next = doc.getElementById('recordsNext');
  const dayTitle = doc.getElementById('recordsDayTitle');
  const dayBody = doc.getElementById('recordsDayBody');
  const closeButton = doc.getElementById('recordsDayClose');
  const status = doc.getElementById('recordsStatus');
  const openers = ['desktopRecordsNav', 'recordsNav'].map(id => doc.getElementById(id)).filter(Boolean);
  const fetchRecords = load ?? (async () => {
    const response = await fetch(`${apiBase}/api/records`);
    if (!response.ok) throw new Error(`Records request failed (${response.status})`);
    return response.json();
  });

  const today = new Date(now);
  const todayKey = dateKey(today);
  let days = new Map();
  let requests = 0;
  let latest = null;
  let view = new Date(today.getFullYear(), today.getMonth(), 1);
  let focusKey = todayKey;
  let opener = null;
  let rowCount = 0;

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const isFuture = date => dateKey(date) > todayKey;
  const atCurrentMonth = () => monthIndex(view) >= monthIndex(today);
  const defaultFocus = () => (monthIndex(view) === monthIndex(today) ? todayKey : dateKey(view));

  function dayButton(date) {
    const key = dateKey(date);
    const future = isFuture(date);
    const has = !future && days.has(key);
    const button = el('button', `records-day${key === todayKey ? ' is-today' : ''}${has ? ' has-records' : ''}${future ? ' is-future' : ''}`);
    button.type = 'button';
    button.dataset.date = key;
    button.tabIndex = key === focusKey ? 0 : -1;
    button.setAttribute('aria-label', [longDate(date), future ? 'upcoming' : has ? 'has records' : 'no records', key === todayKey ? 'today' : null].filter(Boolean).join(', '));
    if (future) button.setAttribute('aria-disabled', 'true');
    if (key === todayKey) button.setAttribute('aria-current', 'date');
    button.append(el('span', 'records-day-number', String(date.getDate())));
    if (has) {
      const dot = el('span', 'records-dot');
      dot.setAttribute('aria-hidden', 'true');
      button.append(dot);
    }
    return button;
  }

  function renderCalendar() {
    const year = view.getFullYear();
    const month = view.getMonth();
    if (monthIndex(parseKey(focusKey)) !== monthIndex(view)) focusKey = defaultFocus();
    title.textContent = view.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    next.setAttribute('aria-disabled', String(atCurrentMonth()));
    const header = el('div', 'records-week records-weekdays');
    header.setAttribute('role', 'row');
    for (const weekday of WEEKDAYS) {
      const cell = el('div', 'records-weekday', weekday.slice(0, 3));
      cell.setAttribute('role', 'columnheader');
      cell.setAttribute('aria-label', weekday);
      header.append(cell);
    }
    const cells = Array.from({ length: view.getDay() }, () => null);
    for (let day = 1; day <= daysInMonth(year, month); day++) cells.push(new Date(year, month, day));
    while (cells.length % 7) cells.push(null);
    const weeks = [header];
    for (let start = 0; start < cells.length; start += 7) {
      const week = el('div', 'records-week');
      week.setAttribute('role', 'row');
      for (const date of cells.slice(start, start + 7)) {
        const cell = el('div', 'records-cell');
        cell.setAttribute('role', 'gridcell');
        if (date) cell.append(dayButton(date));
        week.append(cell);
      }
      weeks.push(week);
    }
    grid.replaceChildren(...weeks);
  }

  /** Move keyboard focus to a day, switching month when needed. Nothing after the current month exists. */
  function focusDay(date) {
    if (monthIndex(date) > monthIndex(today)) return;
    focusKey = dateKey(date);
    if (monthIndex(date) !== monthIndex(view)) { view = new Date(date.getFullYear(), date.getMonth(), 1); renderCalendar(); }
    for (const button of grid.querySelectorAll('.records-day')) button.tabIndex = button.dataset.date === focusKey ? 0 : -1;
    grid.querySelector(`.records-day[data-date="${focusKey}"]`)?.focus();
  }
  const shiftDays = (date, count) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
  const shiftMonths = (date, count) => {
    const first = new Date(date.getFullYear(), date.getMonth() + count, 1);
    return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), daysInMonth(first.getFullYear(), first.getMonth())));
  };

  function changeMonth(count) {
    view = new Date(view.getFullYear(), view.getMonth() + count, 1);
    focusKey = defaultFocus();
    renderCalendar();
  }

  function renderRow(row) {
    const id = `records-row-${++rowCount}`;
    const expandable = row.fields.length > 0 || row.quotes.length > 0;
    const wrap = el('div', 'records-row');
    const head = el(expandable ? 'button' : 'div', 'records-row-head');
    const text = el('span', 'records-row-text');
    text.append(el('span', 'records-row-title', row.title));
    if (row.summary) text.append(el('span', 'records-row-summary', row.summary));
    head.append(text);
    if (row.time) head.append(el('span', 'records-time', row.time));
    wrap.append(head);
    if (!expandable) return wrap;
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', id);
    const chevron = el('span', 'records-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    head.append(chevron);
    const panel = el('div', 'records-row-body');
    panel.id = id;
    panel.hidden = true;
    if (row.fields.length) {
      const details = el('dl', 'records-fields');
      for (const { label, value } of row.fields) details.append(el('dt', '', label), el('dd', '', value));
      panel.append(details);
    }
    if (row.quotes.length) {
      const quotes = el('div', 'records-quotes');
      if (!row.standalone) quotes.append(el('div', 'records-quotes-title', 'In your own words'));
      for (const quote of row.quotes) {
        const block = el('blockquote', 'records-quote');
        if (quote.question) block.append(el('span', 'records-quote-question', quote.question));
        block.append(el('span', 'records-quote-text', quote.text));
        if (quote.unconfirmed) block.append(el('span', 'records-quote-note', 'Recorded as you said it; not confirmed.'));
        quotes.append(block);
      }
      panel.append(quotes);
    }
    wrap.append(panel);
    return wrap;
  }

  function renderDay(key) {
    const checkinsOfDay = days.get(key);
    if (!checkinsOfDay) { dayBody.replaceChildren(el('p', 'records-empty', 'No check-ins recorded on this day.')); return; }
    const day = buildDay(checkinsOfDay);
    const nodes = day.notes.map(note => el('p', 'records-note', [note.time, note.text].filter(Boolean).join(' · ')));
    for (const group of day.groups) {
      const section = el('section', 'records-group');
      section.append(el('h3', 'records-group-title', group.title), ...group.rows.map(renderRow));
      nodes.push(section);
    }
    dayBody.replaceChildren(...nodes);
  }

  function openDay(key, trigger) {
    opener = trigger;
    dayTitle.textContent = parseKey(key).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    renderDay(key);
    overlay.classList.add('open');
    closeButton.focus();
  }
  function closeDay() {
    if (!overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    opener?.focus();
    opener = null;
  }

  function showStatus(text, failed) {
    if (!status) return;
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('is-error', failed);
  }

  /** Read the records again. Only the newest request is used, so a slow old answer cannot overwrite a newer one. */
  function refresh() {
    const mine = ++requests;
    latest = (async () => {
      try {
        const data = await fetchRecords();
        if (mine !== requests) return;
        days = groupByDay(data);
        showStatus(data?.source === 'demo' ? `Example data · ${data.name ?? 'demo person'}` : '', false);
        closeDay();
        renderCalendar();
      } catch {
        if (mine === requests) showStatus('Your records could not be loaded. Open this page again to try again.', true);
      }
    })();
    return latest;
  }

  grid.addEventListener('click', event => {
    const button = event.target.closest?.('.records-day');
    if (!button || button.getAttribute('aria-disabled') === 'true') return;
    focusKey = button.dataset.date;
    for (const other of grid.querySelectorAll('.records-day')) other.tabIndex = other === button ? 0 : -1;
    openDay(button.dataset.date, button);
  });
  grid.addEventListener('keydown', event => {
    const button = event.target.closest?.('.records-day');
    if (!button) return;
    const date = parseKey(button.dataset.date);
    const target = {
      ArrowLeft: () => shiftDays(date, -1), ArrowRight: () => shiftDays(date, 1),
      ArrowUp: () => shiftDays(date, -7), ArrowDown: () => shiftDays(date, 7),
      Home: () => shiftDays(date, -date.getDay()), End: () => shiftDays(date, 6 - date.getDay()),
      PageUp: () => shiftMonths(date, -1), PageDown: () => shiftMonths(date, 1),
    }[event.key];
    if (!target) return;
    event.preventDefault();
    focusDay(target());
  });
  previous.addEventListener('click', () => changeMonth(-1));
  next.addEventListener('click', () => { if (!atCurrentMonth()) changeMonth(1); });

  dayBody.addEventListener('click', event => {
    const head = event.target.closest?.('button.records-row-head');
    if (!head) return;
    const open = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', String(!open));
    head.parentElement.classList.toggle('open', !open);
    doc.getElementById(head.getAttribute('aria-controls')).hidden = open;
  });
  closeButton.addEventListener('click', closeDay);
  overlay.addEventListener('click', event => { if (event.target === overlay) closeDay(); });
  const keydown = event => {
    if (!overlay.classList.contains('open')) return;
    if (event.key === 'Escape') { closeDay(); return; }
    if (event.key !== 'Tab') return;
    // Keep Tab inside the open dialog.
    const stops = [...overlay.querySelectorAll('button')];
    const first = stops[0];
    const last = stops.at(-1);
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  doc.addEventListener('keydown', keydown);

  for (const opener of openers) opener.addEventListener('click', refresh);
  renderCalendar();
  // After the demo switch reloads the page, opening the tab loads the data; otherwise load it now.
  if (takeReturnFlag(doc) && openers[0]) openers[0].click(); else refresh();
  return {
    refresh,
    get ready() { return latest; },
    destroy() {
      doc.removeEventListener('keydown', keydown);
      for (const opener of openers) opener.removeEventListener('click', refresh);
      requests++;
    },
  };
}
