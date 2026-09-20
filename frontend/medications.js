// Each list row is one daily dose. Tracking follows the same browser scope as the list.
const STORAGE_KEY = 'pulsewise.medications';
const TRACKING_KEY = 'pulsewise.medication-tracking.v1';
const MAX_MEDICATION_TYPES = 5;

export function normalizeMedicationName(name) {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function displayName(name) {
  return name.trim().replace(/\s+/g, ' ');
}

function profileFor(windowArg) {
  return windowArg.PulsewiseProfile?.read() || null;
}

function listFrom(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set(value.map(med => med?.id).filter(Boolean));
  return value.filter(med => normalizeMedicationName(med?.name)).map((med, index) => {
    let id = med.id || `med-browser-${index}`;
    if (!med.id) {
      while (ids.has(id)) id += '-dose';
      ids.add(id);
    }
    return { ...med, id, name: displayName(med.name), when: med.schedule ?? med.when ?? '' };
  });
}

export function loadMedications(windowArg = window) {
  try {
    const profile = profileFor(windowArg);
    return listFrom(profile ? profile.medications : JSON.parse(windowArg.localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

export function validateMedicationList(meds) {
  if (!Array.isArray(meds) || meds.some(med => !normalizeMedicationName(med?.name))) {
    throw new Error('Enter a medication name for each dose.');
  }
  if (new Set(meds.map(med => normalizeMedicationName(med.name))).size > MAX_MEDICATION_TYPES) {
    throw new Error('You can track up to 5 different medications. Add another dose of one already listed, or remove a medication first.');
  }
  return meds;
}

function notify(windowArg, medications) {
  windowArg.dispatchEvent(new windowArg.CustomEvent('pulsewise:medications', { detail: { medications } }));
}

export function saveMedications(meds, windowArg = window) {
  try { validateMedicationList(meds); }
  catch (error) {
    // Older profiles may already exceed the limit. Let people remove doses or edit
    // their details without introducing any new medication type.
    const existing = new Set(loadMedications(windowArg).map(med => normalizeMedicationName(med.name)));
    if (!Array.isArray(meds) || existing.size <= MAX_MEDICATION_TYPES || meds.some(med => !normalizeMedicationName(med?.name) || !existing.has(normalizeMedicationName(med.name)))) throw error;
  }
  const saved = meds.map(med => ({
    ...med,
    id: med.id || windowArg.crypto.randomUUID(),
    name: displayName(med.name),
    when: med.schedule ?? med.when ?? '',
    schedule: med.schedule ?? med.when ?? '',
  }));
  try {
    if (profileFor(windowArg)) windowArg.PulsewiseProfile.patch({ medications: saved });
    else windowArg.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    throw new Error('Medication changes could not be saved in this browser. Please retry.');
  }
  notify(windowArg, saved);
  return saved;
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function readTracking(windowArg, profile, date) {
  const value = profile ? profile.medicationTracking : JSON.parse(windowArg.localStorage.getItem(TRACKING_KEY) || 'null');
  const receipts = Array.isArray(value?.receipts) ? [...new Set(value.receipts.filter(id => typeof id === 'string'))] : [];
  const counts = value?.date === date && value.counts && typeof value.counts === 'object'
    ? Object.fromEntries(Object.entries(value.counts).filter(([, count]) => Number.isSafeInteger(count) && count >= 0))
    : {};
  return { version: 1, date, counts, receipts };
}

function groupMedications(meds, counts) {
  const groups = new Map();
  for (const med of meds) {
    const key = normalizeMedicationName(med.name);
    if (!groups.has(key)) groups.set(key, { key, name: displayName(med.name), taken: Object.hasOwn(counts, key) ? counts[key] : 0, required: 0 });
    groups.get(key).required += 1;
  }
  return [...groups.values()];
}

export function getMedicationProgress(windowArg = window) {
  const date = localDate(new windowArg.Date());
  const tracking = readTracking(windowArg, profileFor(windowArg), date);
  return groupMedications(loadMedications(windowArg), tracking.counts);
}

export function medicationProgressMessage(med) {
  if (med.required <= 0 || med.taken < med.required) return '';
  return med.taken === med.required
    ? 'All scheduled doses recorded for today.'
    : 'More doses recorded than scheduled for today.';
}

export function resetMedicationCounts(windowArg = window) {
  try {
    const profile = profileFor(windowArg);
    const tracking = readTracking(windowArg, profile, localDate(new windowArg.Date()));
    // Retain receipts so replaying an old saved check-in cannot undo a reset.
    tracking.counts = {};
    if (profile) windowArg.PulsewiseProfile.patch({ medicationTracking: tracking });
    else windowArg.localStorage.setItem(TRACKING_KEY, JSON.stringify(tracking));
  } catch {
    throw new Error('Medication counts could not be reset in this browser. Please retry.');
  }
  notify(windowArg, loadMedications(windowArg));
}

// Call only after a successful backend save. Keep receipt IDs, never transcripts or review drafts.
export function recordMedicationCheckin(windowArg, response) {
  if (response?.status !== 'saved' || typeof response.sessionId !== 'string' || !response.sessionId.trim()) return false;
  const today = localDate(new windowArg.Date());
  if (response.savedAt != null) {
    const savedAt = new windowArg.Date(response.savedAt);
    if (Number.isNaN(savedAt.getTime()) || localDate(savedAt) !== today) return false;
  }
  try {
    const profile = profileFor(windowArg);
    const tracking = readTracking(windowArg, profile, today);
    if (tracking.receipts.includes(response.sessionId)) return false;
    const meds = loadMedications(windowArg);
    const knownNames = new Set(meds.map(med => normalizeMedicationName(med.name)));
    const taken = new Set((Array.isArray(response.medications) ? response.medications : [])
      .filter(med => med?.status === 'taken')
      .map(med => normalizeMedicationName(med.name))
      .filter(name => name && knownNames.has(name)));
    const counts = new Map(Object.entries(tracking.counts));
    for (const name of taken) counts.set(name, (counts.get(name) || 0) + 1);
    tracking.counts = Object.fromEntries(counts);
    tracking.receipts.push(response.sessionId);
    if (profile) windowArg.PulsewiseProfile.patch({ medicationTracking: tracking });
    else windowArg.localStorage.setItem(TRACKING_KEY, JSON.stringify(tracking));
    notify(windowArg, meds);
    return true;
  } catch {
    throw new Error('Your check-in was saved, but today’s medication counts could not be saved in this browser. Please retry.');
  }
}

export function mountMedications(doc) {
  const windowArg = doc.defaultView;
  const form = doc.getElementById('medForm');
  const rows = doc.getElementById('medRows');
  const tile = doc.getElementById('medTileValue');
  const foot = doc.getElementById('medTileFoot');
  if (!windowArg || (!rows && !tile)) return { destroy() {} };
  const name = doc.getElementById('medName');
  const dose = doc.getElementById('medDose');
  const when = doc.getElementById('medWhen');
  const tileHeader = tile?.closest('.patient-metric')?.querySelector('.patient-metric-label');
  let reset = doc.getElementById('medResetCounts');
  let resetError = doc.getElementById('medResetError');
  if (tileHeader && !reset) {
    reset = doc.createElement('button');
    reset.id = 'medResetCounts';
    reset.className = 'med-reset';
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.setAttribute('aria-label', 'Reset today’s medication counts');
    reset.title = 'Set today’s recorded doses to zero';
    tileHeader.append(reset);
  }
  if (tile && !resetError) {
    resetError = doc.createElement('p');
    resetError.id = 'medResetError';
    resetError.className = 'med-form-error';
    resetError.setAttribute('role', 'alert');
    resetError.hidden = true;
    tile.after(resetError);
  }
  let midnightTimer;
  let error = doc.getElementById('medFormError');
  if (form && !error) {
    error = doc.createElement('p');
    error.id = 'medFormError';
    error.className = 'med-form-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.append(error);
  }
  const showError = message => {
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  };
  if (tile) {
    tile.closest('.patient-metric')?.classList.add('medication-metric');
    tile.classList.add('med-progress-list');
    tile.setAttribute('aria-live', 'polite');
    tile.setAttribute('aria-label', 'Medication doses recorded today');
  }

  const render = () => {
    // While the demo person is shown, demo-toggle.js owns this card and the table. Drawing the browser's
    // own list here would wipe the example out the next time the window gains focus.
    if (!doc.body.classList.contains('demo-on')) {
      const meds = loadMedications(windowArg);
      if (rows) rows.replaceChildren(...(meds.length ? meds.map((med, i) => medRow(doc, med, () => {
        try {
          saveMedications(meds.filter((_, index) => index !== i), windowArg);
          showError('');
        } catch (failure) { showError(failure.message); }
      })) : [emptyRow(doc)]));
      try {
        const progress = getMedicationProgress(windowArg);
        if (reset) reset.disabled = !progress.some(med => med.taken > 0);
        const visible = progress.slice(0, MAX_MEDICATION_TYPES);
        if (tile) {
          if (visible.length) tile.replaceChildren(...visible.map(med => progressRow(doc, med)));
          else tile.textContent = '—';
        }
        if (foot) foot.textContent = progress.length > MAX_MEDICATION_TYPES
          ? 'Showing 5 · manage your list below'
          : progress.length ? 'Doses recorded / daily doses' : 'No medications added';
      } catch {
        if (reset) reset.disabled = true;
        if (tile) tile.textContent = '—';
        if (foot) foot.textContent = 'Counts could not be loaded';
      }
    }
    // Construct the next local midnight, including daylight-saving transitions.
    windowArg.clearTimeout(midnightTimer);
    const now = new windowArg.Date();
    const midnight = new windowArg.Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    midnightTimer = windowArg.setTimeout(render, Math.max(1, midnight.getTime() - now.getTime()));
  };
  const onSubmit = event => {
    event.preventDefault();
    try {
      saveMedications([...loadMedications(windowArg), { name: name?.value || '', dose: dose?.value.trim() || '', when: when?.value || '' }], windowArg);
      showError('');
      if (name) { name.value = ''; name.focus(); }
      if (dose) dose.value = '';
    } catch (failure) { showError(failure.message); }
  };
  const onVisibility = () => { if (doc.visibilityState !== 'hidden') render(); };
  const onStorage = event => { if ([STORAGE_KEY, TRACKING_KEY, null].includes(event.key)) render(); };
  const onReset = () => {
    if (resetError) { resetError.hidden = true; resetError.textContent = ''; }
    try { resetMedicationCounts(windowArg); }
    catch (failure) {
      if (resetError) { resetError.textContent = failure.message; resetError.hidden = false; }
    }
  };
  form?.addEventListener('submit', onSubmit);
  reset?.addEventListener('click', onReset);
  windowArg.addEventListener('pulsewise:profile', render);
  windowArg.addEventListener('pulsewise:medications', render);
  windowArg.addEventListener('focus', render);
  windowArg.addEventListener('pageshow', render);
  windowArg.addEventListener('storage', onStorage);
  doc.addEventListener('visibilitychange', onVisibility);
  render();
  return { destroy() {
    windowArg.clearTimeout(midnightTimer);
    form?.removeEventListener('submit', onSubmit);
    reset?.removeEventListener('click', onReset);
    windowArg.removeEventListener('pulsewise:profile', render);
    windowArg.removeEventListener('pulsewise:medications', render);
    windowArg.removeEventListener('focus', render);
    windowArg.removeEventListener('pageshow', render);
    windowArg.removeEventListener('storage', onStorage);
    doc.removeEventListener('visibilitychange', onVisibility);
  } };
}

function progressRow(doc, med) {
  const row = doc.createElement('div');
  row.className = 'med-progress-row';
  row.setAttribute('aria-label', `${med.name}: ${med.taken} of ${med.required} doses recorded today`);
  const name = doc.createElement('span');
  name.className = 'med-progress-name';
  name.textContent = med.name;
  name.title = med.name;
  const count = doc.createElement('span');
  count.className = 'med-progress-count';
  count.textContent = `${med.taken}/${med.required}`;
  row.append(name, count);
  if (med.taken === med.required) {
    row.classList.add('is-complete');
    const check = doc.createElement('span');
    check.className = 'med-progress-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');
    row.append(check);
  }
  const message = medicationProgressMessage(med);
  if (message) {
    const status = doc.createElement('span');
    status.className = 'med-progress-status';
    status.textContent = message;
    row.classList.toggle('is-over-target', med.taken > med.required);
    row.setAttribute('aria-label', `${med.name}: ${med.taken} of ${med.required} doses recorded today. ${message}`);
    row.append(status);
  }
  return row;
}

function medRow(doc, med, onRemove) {
  const row = doc.createElement('tr');
  for (const text of [med.name, med.dose || '—', med.when || '—']) {
    const cell = doc.createElement('td');
    cell.textContent = text;
    row.append(cell);
  }
  const cell = doc.createElement('td');
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-med';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove ${med.name}`);
  remove.addEventListener('click', onRemove);
  cell.append(remove);
  row.append(cell);
  return row;
}

function emptyRow(doc) {
  const row = doc.createElement('tr');
  const cell = doc.createElement('td');
  cell.className = 'empty';
  cell.colSpan = 4;
  cell.textContent = 'No medications added yet.';
  row.append(cell);
  return row;
}
