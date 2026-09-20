import { createCheckinClient } from './checkin-api.js';
import { createSpeechInput } from './speech.js';

const fields = {
  symptoms: ['name', 'location', 'severity', 'severityScore', 'trend', 'functionalImpact', 'duration'],
  medications: ['name', 'description', 'dose', 'status', 'time'],
  diet: ['description', 'time'],
  vitals: ['name', 'value', 'unit', 'time'],
};
const choices = { severity: ['mild', 'moderate', 'severe'], trend: ['better', 'same', 'worse'], status: ['taken', 'missed', 'stopped', 'mentioned'] };
const labels = { severityScore: 'Severity score (0–10)', functionalImpact: 'Effect on daily activities' };
const recordOf = state => Object.fromEntries(Object.keys(fields).map(category => [category, structuredClone(state[category])]));

// Public mounting point: keep API state independent from your teammate's design.
export function mountCheckin(document, { client = createCheckinClient(), Recognition } = {}) {
  const window = document.defaultView;
  const overlay = document.getElementById('checkinFlow');
  if (!overlay) throw new Error('The page needs a #checkinFlow container. See FRONTEND-INTEGRATION.md.');
  const cleanups = [];
  let speech = null;
  let working = false;
  let generation = 0;
  let originalTranscript = '';
  let reviewDraft = null;
  let opener = null;
  let previousOverflow = '';
  let destroyed = false;
  const savedRecords = [];

  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const listen = (node, name, handler) => {
    if (!node) return;
    node.addEventListener(name, handler);
    cleanups.push(() => node.removeEventListener(name, handler));
  };
  const button = (id, text, handler, className = 'flow-secondary') => {
    const node = el('button', text, className);
    if (id) node.id = id;
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  };
  const panel = el('div', undefined, 'flow-panel pw-panel');
  const top = el('div', undefined, 'flow-top');
  const back = button('flowBack', '←', () => close(), 'flow-back');
  back.setAttribute('aria-label', 'Go back to dashboard');
  const title = el('span', 'Daily Check-in', 'flow-title');
  title.id = 'pw-title';
  const step = el('span', '', 'flow-step');
  step.id = 'flowStep';
  const closeButton = button('flowClose', '×', () => close(), 'flow-close');
  closeButton.setAttribute('aria-label', 'Close check-in');
  top.append(back, title, step, closeButton);
  const error = el('div', '', 'flow-warning');
  error.id = 'pw-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');
  const busyStatus = el('p', '', 'pw-status');
  busyStatus.setAttribute('role', 'status');
  const body = el('section', undefined, 'flow-screen pw-content');
  const restart = button('pw-new', 'Start a new check-in', () => {
    if (working || client.busy) return;
    client.reset();
    originalTranscript = '';
    reviewDraft = null;
    render();
  });
  restart.hidden = true;
  panel.append(top, error, busyStatus, body, restart);
  overlay.replaceChildren(panel);
  overlay.setAttribute('aria-labelledby', 'pw-title');
  overlay.setAttribute('aria-hidden', 'true');

  function cancelSpeech() { speech?.destroy(); speech = null; }
  function showError(problem) {
    const details = Array.isArray(problem.details) ? problem.details.map(item => `${item.path}: ${item.message}`).join('; ') : '';
    error.textContent = `${problem.message || 'Could not complete the request.'}${details ? ` ${details}` : ''}${client.blocked ? ' Start a new check-in to continue. Your visible details have been kept.' : ''}`;
    error.hidden = false;
    restart.hidden = !client.blocked;
  }
  function refreshBusy() {
    panel.setAttribute('aria-busy', String(working));
    for (const node of body.querySelectorAll('button,input,textarea,select')) {
      node.disabled = working || client.blocked || node.dataset.unavailable === 'true';
    }
    restart.disabled = working;
    busyStatus.textContent = working ? 'Working… Please wait.' : '';
  }
  async function perform(action) {
    if (working || client.busy || destroyed) return;
    working = true;
    error.hidden = true;
    refreshBusy();
    try { await action(); if (!destroyed) render(); }
    catch (problem) { if (!destroyed) showError(problem); }
    finally { working = false; if (!destroyed) refreshBusy(); }
  }
  function close() {
    generation += 1;
    speech?.cancel();
    if (!client.state) originalTranscript = body.querySelector('#pw-transcript')?.value ?? originalTranscript;
    window.speechSynthesis?.cancel();
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = previousOverflow;
    opener?.focus();
  }
  function open(transcript) {
    if (destroyed) return;
    opener = document.activeElement;
    if (!overlay.classList.contains('open')) previousOverflow = document.body.style.overflow;
    if (!client.state && !originalTranscript && !body.querySelector('#pw-transcript')?.value && typeof transcript === 'string' && transcript.trim()) {
      originalTranscript = transcript;
      const input = body.querySelector('#pw-transcript');
      if (input) input.value = transcript;
    }
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    body.querySelector('textarea, input, button')?.focus();
  }
  function attachSpeech(textarea, target) {
    const status = el('p', '', 'pw-status');
    status.id = 'pw-voice-status';
    status.setAttribute('role', 'status');
    const mic = button('pw-voice', 'Speak', async () => {
      if (working || client.blocked) return;
      try {
        if (speech.isActive) await speech.finish();
        else speech.start();
      } catch (problem) { showError(problem); }
    });
    speech = createSpeechInput({ textarea, Recognition, onStatus: ({ type, message }) => {
      status.textContent = message;
      mic.textContent = type === 'listening' ? 'Stop recording' : type === 'stopping' ? 'Finishing…' : 'Speak';
    } });
    if (!speech.available) {
      mic.disabled = true;
      mic.dataset.unavailable = 'true';
      status.textContent = 'Voice input is unavailable in this browser. You can type below.';
    } else status.textContent = 'Browser speech input. You can edit the transcript before sending.';
    target.append(mic, status);
  }
  function showRecord(record, target) {
    for (const category of Object.keys(fields)) {
      if (!record[category]?.length) continue;
      target.append(el('h3', category[0].toUpperCase() + category.slice(1)));
      for (const item of record[category]) {
        const card = el('div', undefined, 'review-card');
        card.append(el('strong', item.name || item.description || 'Unidentified medication'));
        const description = fields[category].filter(field => field !== 'name' && item[field] !== null)
          .map(field => `${labels[field] || field}: ${item[field]}`).join(' · ');
        card.append(el('p', description));
        target.append(card);
      }
    }
  }
  function render() {
    cancelSpeech();
    body.replaceChildren();
    error.hidden = true;
    restart.hidden = !client.blocked;
    const state = client.state;
    step.textContent = state ? (state.status === 'saved' ? 'Saved' : state.status === 'review' ? 'Review' : 'Follow-up') : 'Start';
    if (!state) renderStart();
    else {
      const notice = el('p', `${state.extractionMode === 'demo' ? 'Demo extraction (limited examples)' : 'Gemini extraction'} · Temporary server memory`, 'pw-note');
      body.append(notice);
      if (originalTranscript) {
        const detail = el('details');
        detail.append(el('summary', 'Your original words'), el('p', originalTranscript));
        body.append(detail);
      }
      for (const noticeText of state.notices ?? []) body.append(el('p', noticeText, 'pw-note'));
      if (state.status === 'saved') renderSaved(state);
      else if (state.status === 'review') renderReview(state);
      else renderQuestion(state);
    }
    refreshBusy();
  }
  function renderStart() {
    body.append(el('h2', 'How are you feeling today?'), el('p', 'Tell us about symptoms, medications, food, or a measurement you took.'));
    const form = el('form');
    const textarea = el('textarea', undefined, 'transcript flow-transcript');
    textarea.id = 'pw-transcript';
    textarea.setAttribute('aria-label', 'Your check-in transcript');
    textarea.placeholder = 'For example: My knees hurt more today and I forgot my prednisone this morning.';
    textarea.maxLength = 10000;
    textarea.value = originalTranscript;
    textarea.addEventListener('input', () => { originalTranscript = textarea.value; });
    attachSpeech(textarea, form);
    form.append(textarea);
    const analyze = button('pw-analyze', 'Analyze check-in', () => {}, 'flow-primary');
    analyze.type = 'submit';
    form.append(analyze);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const activeSpeech = speech;
      const attempt = generation;
      void perform(async () => {
        const text = await activeSpeech.finish();
        if (attempt !== generation) throw new Error('Recording cancelled. Your check-in was not sent.');
        if (!text.trim()) throw new Error('Speak or type your check-in first.');
        originalTranscript = text;
        await client.start(text);
      });
    });
    body.append(form, el('p', 'Prototype: use fictional examples. You will review the extracted details before saving.', 'pw-note'));
  }
  function renderQuestion(state) {
    const question = state.nextQuestion;
    if (question) {
      body.append(el('h2', question.text));
      const options = el('div', undefined, 'pw-options');
      for (const value of question.options ?? []) {
        const option = button('', value, () => {
          if (working) return;
          speech?.cancel();
          void perform(() => client.answer(value));
        });
        option.dataset.answer = value;
        options.append(option);
      }
      body.append(options);
      const form = el('form');
      const answer = el('textarea', undefined, 'transcript');
      answer.id = 'pw-answer';
      answer.maxLength = 500;
      answer.setAttribute('aria-label', 'Your answer');
      answer.placeholder = 'Or type your answer…';
      attachSpeech(answer, form);
      form.append(answer);
      const submit = button('pw-send', 'Send answer', () => {}, 'flow-primary');
      submit.type = 'submit';
      form.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const activeSpeech = speech;
        const attempt = generation;
        void perform(async () => {
          const text = await activeSpeech.finish();
          if (attempt !== generation) throw new Error('Recording cancelled. Your answer was not sent.');
          if (!text.trim()) throw new Error('Speak or type an answer first.');
          await client.answer(text, { spoken: activeSpeech.mode === 'spoken' });
        });
      });
      body.append(form, button('pw-skip', 'Skip this question', () => {
        if (working) return;
        speech?.cancel();
        void perform(() => client.skip());
      }));
    } else body.append(el('h2', 'Your details are ready to review.'));
    body.append(button('pw-review', 'Finish and review', () => {
      if (working) return;
      speech?.cancel();
      void perform(() => client.review());
    }));
    const facts = el('details');
    facts.append(el('summary', 'Details captured so far'));
    showRecord(state, facts);
    body.append(facts);
  }
  function renderReview(state) {
    if (!reviewDraft) reviewDraft = recordOf(state);
    body.append(el('h2', 'Review your check-in'), el('p', 'Correct any details or remove an incorrect item. Empty fields stay unknown.'));
    if (state.missingFields.length) body.append(el('p', `Some details are still unknown: ${state.missingFields.join(', ')}. You may save an incomplete record.`, 'pw-note'));
    const form = el('form');
    for (const category of Object.keys(fields)) {
      form.append(el('h3', category[0].toUpperCase() + category.slice(1)));
      if (!reviewDraft[category].length) form.append(el('p', 'None reported.', 'pw-note'));
      for (const item of reviewDraft[category]) {
        const card = el('fieldset', undefined, 'review-card pw-record');
        card.append(el('legend', item.name || item.description || 'Unidentified medication'));
        for (const field of fields[category]) {
          const wrapper = el('label', labels[field] || field[0].toUpperCase() + field.slice(1), 'flow-field');
          const input = el(choices[field] ? 'select' : 'input');
          if (choices[field]) for (const value of ['', ...choices[field]]) {
            const option = el('option', value || 'Unknown');
            option.value = value;
            input.append(option);
          }
          else if (field === 'severityScore') { input.type = 'number'; input.min = '0'; input.max = '10'; input.step = 'any'; }
          else { input.type = 'text'; input.maxLength = 500; }
          input.value = item[field] ?? '';
          input.dataset.recordCategory = category;
          input.dataset.recordId = item.id;
          input.dataset.recordField = field;
          input.required = (field === 'name' && ['symptoms', 'vitals'].includes(category)) || (field === 'description' && category === 'diet');
          input.addEventListener('input', () => {
            const value = input.value.trim();
            item[field] = value === '' ? null : field === 'severityScore' ? Number(value) : value;
          });
          input.addEventListener('change', () => {
            const value = input.value.trim();
            item[field] = value === '' ? null : field === 'severityScore' ? Number(value) : value;
          });
          wrapper.append(input);
          card.append(wrapper);
        }
        const remove = button('', 'Remove item', () => {
          if (working) return;
          reviewDraft[category] = reviewDraft[category].filter(entry => entry.id !== item.id);
          render();
        });
        remove.dataset.removeId = item.id;
        remove.dataset.removeCategory = category;
        card.append(remove);
        form.append(card);
      }
    }
    const save = button('pw-save', 'Confirm and save', () => {}, 'flow-primary');
    save.type = 'submit';
    form.append(save);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void perform(async () => {
        if (!Object.values(reviewDraft).some(items => items.length)) throw new Error('There are no details to save. Start a new check-in.');
        await client.save(structuredClone(reviewDraft));
        if (!savedRecords.some(record => record.sessionId === client.state.sessionId)) savedRecords.unshift(structuredClone(client.state));
        updateJournal();
      });
    });
    body.append(form, el('p', 'Saved records live in this running backend only. Restarting the backend clears them. This page shows check-ins saved since it was opened.', 'pw-note'));
    restart.hidden = false;
  }
  function renderSaved(state) {
    body.append(el('h2', 'Check-in saved'), el('p', 'Your reviewed details were saved to temporary server memory.'));
    showRecord(state, body);
    body.append(button('pw-done', 'Done', () => close(), 'flow-primary'));
    restart.hidden = false;
  }
  function updateJournal() {
    const rows = document.getElementById('logRows');
    const chart = document.getElementById('symptomChart');
    rows?.replaceChildren();
    chart?.replaceChildren();
    for (const record of savedRecords) {
      const row = el('tr');
      const date = new Date(record.savedAt).toLocaleString();
      const summary = Object.keys(fields).flatMap(category => record[category].map(item => item.name || item.description || 'Unidentified medication')).join(', ');
      const score = record.symptoms.find(item => item.severityScore !== null)?.severityScore;
      row.append(el('td', date), el('td', summary), el('td', score === undefined ? 'Unknown' : `${score} / 10`));
      rows?.append(row);
      if (chart && score !== undefined) {
        const bar = el('div', undefined, 'mini-bar');
        bar.style.height = `${Math.max(2, score * 10)}%`;
        bar.title = `${date}: ${score} / 10`;
        bar.append(el('span', String(score)));
        chart.append(bar);
      }
    }
    const empty = document.getElementById('emptyLog');
    if (empty) { empty.hidden = savedRecords.length > 0; empty.textContent = 'Check-ins saved during this page visit will appear here.'; }
    const latest = document.getElementById('understoodList');
    if (latest) {
      latest.replaceChildren();
      if (savedRecords[0]) showRecord(savedRecords[0], latest);
      else latest.append(el('p', 'Your saved check-in will appear here.'));
    }
    for (const id of ['printButton', 'exportButton']) { const node = document.getElementById(id); if (node) node.disabled = !savedRecords.length; }
  }
  function exportSummary() {
    if (!savedRecords.length) return;
    const paragraphs = ['Tell-Well — user-reviewed check-ins', 'Temporary prototype records; not a diagnosis.', ''];
    for (const record of savedRecords) {
      paragraphs.push(new Date(record.savedAt).toLocaleString());
      for (const category of Object.keys(fields)) for (const item of record[category]) {
        paragraphs.push(`${category}: ${fields[category].map(field => `${labels[field] || field}: ${item[field] ?? 'unknown'}`).join('; ')}`);
      }
      paragraphs.push('');
    }
    const url = window.URL.createObjectURL(new window.Blob([paragraphs.join('\n')], { type: 'text/plain' }));
    const link = el('a');
    link.href = url;
    link.download = 'pulsewise-checkins.txt';
    link.click();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  }
  for (const id of ['dailyCheckinButton', 'checkinNav', 'micButton', 'journalStartButton']) listen(document.getElementById(id), 'click', () => open(document.getElementById('transcript')?.value));
  listen(document.getElementById('confirmCheckin'), 'click', () => open(document.getElementById('transcript')?.value));
  listen(overlay, 'click', event => { if (event.target === overlay) close(); });
  listen(document, 'keydown', event => {
    if (!overlay.classList.contains('open')) return;
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('button,input,select,textarea,summary')].filter(node => !node.disabled && !node.hidden);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  listen(document.getElementById('homeNav'), 'click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  for (const id of ['trendsNav', 'moreNav']) listen(document.getElementById(id), 'click', () => document.getElementById('journal')?.scrollIntoView({ behavior: 'smooth' }));
  listen(document.getElementById('exportButton'), 'click', exportSummary);
  // Print only reviewed records, not the decorative sample dashboard.
  listen(document.getElementById('printButton'), 'click', () => {
    if (!savedRecords.length) return;
    const previous = document.getElementById('pw-print-summary');
    previous?.remove();
    const print = el('section');
    print.id = 'pw-print-summary';
    print.append(el('h1', 'Tell-Well — reviewed check-ins'));
    for (const record of savedRecords) { print.append(el('h2', new Date(record.savedAt).toLocaleString())); showRecord(record, print); }
    document.body.append(print);
    window.print();
  });
  listen(document.getElementById('speakPrompt'), 'click', () => {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new window.SpeechSynthesisUtterance('How are you feeling today? You can mention symptoms, medications, food, or measurements.'));
  });
  listen(window, 'pagehide', () => { cancelSpeech(); window.speechSynthesis?.cancel(); });
  render();
  updateJournal();
  return { client, open, destroy() { close(); cancelSpeech(); destroyed = true; for (const cleanup of cleanups) cleanup(); } };
}
