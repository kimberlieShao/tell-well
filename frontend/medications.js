// Home page medications table. The list is kept in this browser only (a prototype, no account).

const STORAGE_KEY = 'pulsewise.medications';

export function mountMedications(doc) {
  const form = doc.getElementById('medForm');
  const rows = doc.getElementById('medRows');
  if (!form || !rows) return;
  const name = doc.getElementById('medName');
  const dose = doc.getElementById('medDose');
  const when = doc.getElementById('medWhen');
  let meds = loadMedications();

  const render = () => {
    rows.replaceChildren(...(meds.length ? meds.map((med, i) => medRow(doc, med, () => {
      meds = meds.filter((_, j) => j !== i);
      save(meds);
      render();
    })) : [emptyRow(doc)]));
    const count = doc.getElementById('medTileValue');
    const foot = doc.getElementById('medTileFoot');
    if (count) count.textContent = meds.length ? String(meds.length) : '—';
    if (foot) foot.textContent = meds.length ? `${meds.length === 1 ? 'Medication' : 'Medications'} on your list` : 'No entry recorded';
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!name.value.trim()) return;
    meds = [...meds, { name: name.value.trim(), dose: dose.value.trim(), when: when.value }];
    save(meds);
    name.value = '';
    dose.value = '';
    name.focus();
    render();
  });
  render();
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

export function loadMedications() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter(m => typeof m?.name === 'string' && m.name) : [];
  } catch {
    return [];
  }
}

function save(meds) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(meds)); } catch { /* private window: keep it for this visit only */ }
}
