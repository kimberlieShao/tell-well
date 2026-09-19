const categories = ['symptoms', 'medications', 'diet', 'vitals'];
const categoryLabels = { symptoms: 'Symptoms', medications: 'Medications', diet: 'Diet', vitals: 'Vitals' };
const categorySymbols = { symptoms: '✳', medications: '+', diet: '◒', vitals: '↗' };
const fieldLabels = {
  name: 'Name', description: 'Description', location: 'Location', severity: 'Severity',
  severityScore: 'Severity / 10', trend: 'Trend', functionalImpact: 'Daily activities',
  duration: 'Duration', dose: 'Dose', status: 'Status', time: 'Time', value: 'Reading', unit: 'Unit',
};
const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'workspace', 'new-button', 'stage-badge', 'mode-badge', 'session-meta', 'request-status',
  'error-box', 'transcript-form', 'transcript', 'analyze-button', 'submitted-section',
  'submitted-transcript', 'question-section', 'question-title', 'question-meta', 'choices',
  'answer-form', 'answer', 'answer-label', 'skip-button', 'review-button', 'review-section',
  'review-title', 'editor-details', 'record-json', 'use-edits', 'save-button', 'resume-button',
  'saved-section', 'saved-title', 'saved-description', 'record-categories', 'record-flags',
  'record-intro', 'item-count', 'notices-section', 'notices', 'request-json', 'response-json',
].map((id) => [id, $(id)]));
const exampleTranscript = ui.transcript.value;
let state = null;
let busy = false;
let blocked = false;
let submittedTranscript = '';

// API strings always enter the page as text, including transcript, questions, and JSON.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function recordFrom(response) {
  return Object.fromEntries(categories.map((category) => [category, response[category]]));
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function setError(message) {
  ui['error-box'].textContent = message;
  ui['error-box'].hidden = !message;
}

function setControls() {
  const locked = busy || blocked;
  ui.workspace.setAttribute('aria-busy', String(busy));
  ui.workspace.querySelectorAll('button, input, textarea').forEach((control) => {
    control.disabled = locked;
  });
  // A stale/uncertain session can only be replaced, never retried against an old version.
  ui['new-button'].disabled = busy;
  ui['record-json'].disabled = locked || !ui['use-edits'].checked;
  ui['analyze-button'].textContent = busy && !state ? 'Analyzing…' : 'Analyze transcript →';
  ui['save-button'].textContent = busy && state?.status === 'review' ? 'Working…' : 'Confirm and save';
}

function renderRecord() {
  ui['record-categories'].replaceChildren();
  let count = 0;
  for (const category of categories) {
    const items = state?.[category] ?? [];
    count += items.length;
    const section = element('section', 'category');
    const header = element('div', 'category-heading');
    const symbol = element('span', 'category-symbol', categorySymbols[category]);
    symbol.setAttribute('aria-hidden', 'true');
    header.append(symbol, element('h3', '', categoryLabels[category]), element('span', 'category-count', items.length));
    section.append(header);
    if (!items.length) section.append(element('p', 'empty-category', state ? 'Nothing reported' : 'Waiting for transcript'));
    for (const item of items) {
      const card = element('article', 'record-item');
      card.append(element('h4', '', item.name ?? item.description ?? 'Unnamed medication'));
      const fields = element('dl');
      for (const [key, value] of Object.entries(item)) {
        if (key === 'id' || key === 'name' || (category === 'diet' && key === 'description')) continue;
        const field = element('div', 'field');
        field.append(element('dt', '', fieldLabels[key] ?? key), element('dd', value === null ? 'unknown' : '', value === null ? 'Unknown' : value));
        fields.append(field);
      }
      // Medication identity must remain visibly unknown even when its description is present.
      if (category === 'medications' && item.name === null) {
        const nameField = element('div', 'field');
        nameField.append(element('dt', '', 'Name'), element('dd', 'unknown', 'Unknown'));
        fields.prepend(nameField);
      }
      const identity = element('details', 'item-id');
      identity.append(element('summary', '', 'Item ID'), element('code', '', item.id));
      card.append(fields, identity);
      section.append(card);
    }
    ui['record-categories'].append(section);
  }
  ui['item-count'].textContent = `${count} ${count === 1 ? 'item' : 'items'}`;
  ui['record-intro'].textContent = state
    ? `Latest ${state.status === 'saved' ? 'saved' : 'backend'} record · Unknown means no value was provided. All four categories are shown.`
    : 'The four categories will appear here after analysis. Missing details are shown as Unknown.';
  ui['record-flags'].replaceChildren();
  ui['record-flags'].hidden = !state;
  if (state) {
    const line = element('p', 'flag-line');
    line.append(element('span', 'flag-dot'), element('span', '', `${state.missingFields.length} missing follow-up ${state.missingFields.length === 1 ? 'field' : 'fields'} · ${state.skippedFields.length} skipped`));
    ui['record-flags'].append(line);
    if (state.needsClarification) ui['record-flags'].append(element('p', 'help-text', 'A medication still needs identification.'));
    for (const [label, fields] of [['Missing fields', state.missingFields], ['Skipped fields', state.skippedFields]]) {
      if (!fields.length) continue;
      const details = element('details', 'field-details');
      const list = element('ul');
      fields.forEach((field) => list.append(element('li', '', field)));
      details.append(element('summary', '', label), list);
      ui['record-flags'].append(details);
    }
  }
  ui.notices.replaceChildren();
  ui['notices-section'].hidden = !state?.notices.length;
  state?.notices.forEach((notice) => ui.notices.append(element('li', '', notice)));
}

function render() {
  const collecting = state?.status === 'collecting';
  const reviewing = state?.status === 'review';
  const saved = state?.status === 'saved';
  ui['transcript-form'].hidden = Boolean(state);
  ui['submitted-section'].hidden = !state;
  ui['submitted-transcript'].textContent = submittedTranscript;
  ui['question-section'].hidden = !collecting;
  ui['review-section'].hidden = !reviewing;
  ui['saved-section'].hidden = !saved;
  ui['stage-badge'].textContent = state ? { collecting: 'Collecting', review: 'Review', saved: 'Saved' }[state.status] : 'Ready';
  ui['mode-badge'].textContent = state ? `Mode: ${state.extractionMode === 'gemini' ? 'Gemini' : 'Demo (phrase rules)'}` : 'Mode: waiting for backend';
  ui['session-meta'].textContent = state
    ? `Version ${state.version} · Memory storage · Expires ${formatTime(state.expiresAt)}`
    : 'Fictional data only · saved records live in server memory';
  ui.choices.replaceChildren();
  if (collecting && state.nextQuestion) {
    const question = state.nextQuestion;
    ui['question-title'].textContent = question.text;
    ui['question-meta'].textContent = `${categoryLabels[question.category]} · ${fieldLabels[question.field] ?? question.field}`;
    ui['answer-label'].textContent = question.options.length ? 'Or type your answer' : 'Your answer';
    ui.answer.value = '';
    ui.answer.placeholder = question.options.length ? 'Enter an answer…' : 'Enter a detail, or skip if unknown…';
    for (const option of question.options) {
      const button = element('button', 'choice', option);
      button.type = 'button';
      button.addEventListener('click', () => submitAnswer(option));
      ui.choices.append(button);
    }
  }
  if (reviewing) {
    ui['record-json'].value = JSON.stringify(recordFrom(state), null, 2);
    ui['use-edits'].checked = false;
    ui['editor-details'].open = false;
  }
  if (saved) ui['saved-description'].textContent = `Confirmed at ${formatTime(state.savedAt)} and stored in server memory. The record on the right is the saved result.`;
  renderRecord();
  setControls();
}

function validateResponse(response) {
  if (!response || typeof response.sessionId !== 'string' || !Number.isInteger(response.version)
      || !['collecting', 'review', 'saved'].includes(response.status)
      || !categories.every((key) => Array.isArray(response[key]))
      || !Array.isArray(response.missingFields) || !Array.isArray(response.skippedFields)
      || !Array.isArray(response.notices)
      || (response.status === 'collecting' && (!response.nextQuestion || !Array.isArray(response.nextQuestion.options)))) {
    throw new Error('The backend returned an unexpected response shape.');
  }
}

async function request(path, body, progress, successTranscript) {
  if (busy || blocked) return;
  busy = true;
  setError('');
  ui['request-status'].textContent = progress;
  ui['request-json'].textContent = `POST ${path}\n\n${JSON.stringify(body, null, 2)}`;
  ui['response-json'].textContent = 'Waiting for response…';
  setControls();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  let receivedHttpError = false;
  try {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const raw = await response.text();
    let result;
    try { result = JSON.parse(raw); } catch { result = null; }
    ui['response-json'].textContent = `HTTP ${response.status}\n\n${result === null ? raw || '(empty body)' : JSON.stringify(result, null, 2)}`;
    if (!response.ok) {
      receivedHttpError = true;
      blocked = response.status === 409 || (response.status === 404 && Boolean(state));
      const message = result?.error?.message ?? `The backend returned HTTP ${response.status}.`;
      throw new Error(`${result?.error?.code ? `${result.error.code}: ` : ''}${message}${blocked ? ' Start a new check-in to continue; this page has kept the last successful record.' : ''}`);
    }
    validateResponse(result);
    state = result;
    if (successTranscript !== undefined) submittedTranscript = successTranscript;
    render();
    ui['request-status'].textContent = { collecting: 'Record updated. Answer the next question, skip, or finish and review.', review: 'Ready for review. Saving requires your confirmation.', saved: 'Check-in confirmed and saved in server memory.' }[state.status];
    const target = { collecting: 'question-title', review: 'review-title', saved: 'saved-title' }[state.status];
    ui[target].focus();
  } catch (error) {
    if (!receivedHttpError) {
      // A lost response may already have advanced the session; do not reuse its version.
      blocked = true;
      if (ui['response-json'].textContent === 'Waiting for response…') ui['response-json'].textContent = 'No complete response received.';
    }
    const message = error.name === 'AbortError' ? 'The request timed out.' : error.message || 'The request failed.';
    setError(`${message}${!receivedHttpError ? ' The request outcome is unknown. Start a new check-in before submitting again. Your transcript and latest record are still visible.' : ''}`);
    ui['request-status'].textContent = blocked ? 'Session paused. Start a new check-in to continue.' : 'Request failed. Your last successful record and any JSON edits are unchanged.';
  } finally {
    clearTimeout(timeout);
    busy = false;
    setControls();
  }
}

function sessionBody() {
  return { sessionId: state.sessionId, version: state.version };
}

function submitAnswer(value) {
  if (busy || blocked || state?.status !== 'collecting' || !state.nextQuestion) return;
  const trimmed = value.trim();
  if (!trimmed) { setError('Enter an answer, choose an option, or skip this question.'); return; }
  request('/api/analyze', { ...sessionBody(), answer: { questionId: state.nextQuestion.id, value: trimmed } }, 'Submitting answer…');
}

ui['transcript-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  if (state || busy || blocked) return;
  const transcript = ui.transcript.value.trim();
  if (!transcript) { setError('Enter a fictional transcript to start.'); ui.transcript.focus(); return; }
  request('/api/analyze', { transcript }, 'Analyzing transcript…', transcript);
});

ui['answer-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  submitAnswer(ui.answer.value);
});

ui['skip-button'].addEventListener('click', () => {
  if (state?.status !== 'collecting' || !state.nextQuestion) return;
  request('/api/analyze', { ...sessionBody(), action: 'skip', questionId: state.nextQuestion.id }, 'Skipping this question…');
});

ui['review-button'].addEventListener('click', () => {
  if (state?.status !== 'collecting') return;
  request('/api/analyze', { ...sessionBody(), action: 'review' }, 'Preparing review…');
});

ui['resume-button'].addEventListener('click', () => {
  if (state?.status !== 'review') return;
  request('/api/analyze', { ...sessionBody(), action: 'resume' }, 'Returning to questions…');
});

ui['use-edits'].addEventListener('change', setControls);
ui['record-json'].addEventListener('input', () => ui['record-json'].removeAttribute('aria-invalid'));

ui['save-button'].addEventListener('click', () => {
  if (busy || blocked || state?.status !== 'review') return;
  const body = { ...sessionBody(), confirmed: true };
  if (ui['use-edits'].checked) {
    try {
      const record = JSON.parse(ui['record-json'].value);
      if (!record || Array.isArray(record) || typeof record !== 'object'
          || Object.keys(record).length !== categories.length
          || !categories.every((category) => Array.isArray(record[category]))) {
        throw new Error('The record must contain exactly four arrays: symptoms, medications, diet, and vitals.');
      }
      body.record = record;
    } catch (error) {
      setError(`Cannot save the edited record: ${error.message} Your edits have been kept; fix the JSON or turn off edited JSON.`);
      ui['request-status'].textContent = 'Nothing was sent. Correct the JSON before confirming.';
      ui['editor-details'].open = true;
      ui['record-json'].setAttribute('aria-invalid', 'true');
      ui['record-json'].focus();
      return;
    }
  }
  request('/api/checkin/save', body, 'Confirming and saving…');
});

ui['new-button'].addEventListener('click', () => {
  if (busy) return;
  state = null;
  blocked = false;
  submittedTranscript = '';
  ui.transcript.value = exampleTranscript;
  ui['record-json'].value = '';
  ui['record-json'].removeAttribute('aria-invalid');
  ui['use-edits'].checked = false;
  ui['request-json'].textContent = 'No request yet.';
  ui['response-json'].textContent = 'No response yet.';
  ui['request-status'].textContent = 'Ready for a new fictional transcript. Server sessions were not changed.';
  setError('');
  render();
  ui.transcript.focus();
});

render();
