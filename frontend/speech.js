// Temporary browser speech input. The health API receives transcripts, never audio.
export function createSpeechInput({
  textarea,
  onStatus = () => {},
  Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
  finishTimeoutMs = 2500,
} = {}) {
  if (!textarea) throw new TypeError('A transcript textarea is required.');
  let active = null;
  let mode = 'form';
  let lastError = null;
  let destroyed = false;
  const available = typeof Recognition === 'function';
  const report = (type, message) => onStatus({ type, message });
  const error = (code, message) => Object.assign(new Error(message), { code });
  const join = (...parts) => parts.map(value => value.trim()).filter(Boolean).join(' ');
  const current = (session) => active === session && !destroyed;
  const finalText = (session) => [...session.results.values()].filter(value => value.final).map(value => value.text).join(' ').trim();
  const detach = (session) => {
    clearTimeout(session.timer);
    for (const name of ['onresult', 'onerror', 'onend']) session.recognition[name] = null;
    // Some implementations deliver start after an earlier abort. Keep a guard
    // on that old instance so a delayed start cannot leave its microphone open.
    session.recognition.onstart = () => {
      try { session.recognition.abort(); } catch { /* Already stopped. */ }
    };
  };
  const fail = (session, problem) => {
    if (!current(session)) return;
    textarea.value = join(session.before, finalText(session));
    active = null;
    detach(session);
    lastError = problem;
    session.reject?.(problem);
    try { session.recognition.abort(); } catch { /* Already stopped. */ }
    report('error', problem.message);
  };
  const stop = (session) => {
    if (!current(session) || session.stopCalled || !session.started) return;
    session.stopCalled = true;
    try { session.recognition.stop(); }
    catch { fail(session, error('SPEECH_STOP_FAILED', 'Could not finish recording. Type your response or record it again.')); }
  };

  const cancel = () => {
    lastError = null;
    mode = 'form';
    if (!active) return;
    const session = active;
    active = null; // Invalidate callbacks before abort, including synchronous callbacks.
    textarea.value = join(session.before, finalText(session));
    detach(session);
    session.reject?.(error('SPEECH_CANCELLED', 'Recording was cancelled.'));
    try { session.recognition.abort(); } catch { /* Already stopped. */ }
    report('idle', 'Recording stopped.');
  };
  const onInput = () => {
    // Keep exactly what the user typed, including edits to a visible transcript.
    const edited = textarea.value;
    cancel();
    textarea.value = edited;
    mode = 'form';
    lastError = null;
  };
  textarea.addEventListener('input', onInput);

  return {
    get available() { return available && !destroyed; },
    get isActive() { return active !== null; },
    get mode() { return mode; },
    start() {
      if (destroyed) throw error('SPEECH_DESTROYED', 'This recording control is no longer active.');
      if (!available) {
        const problem = error('SPEECH_UNAVAILABLE', 'Voice input is unavailable in this browser. Type your response instead.');
        report('unavailable', problem.message);
        throw problem;
      }
      if (active) throw error('SPEECH_BUSY', 'Recording is already in progress.');
      lastError = null;
      mode = 'form';
      const recognition = new Recognition();
      const session = { recognition, before: textarea.value.trim(), results: new Map(), started: false, stopping: false, stopCalled: false, promise: null, resolve: null, reject: null, timer: null };
      active = session;
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onstart = () => {
        if (!current(session)) {
          try { recognition.abort(); } catch { /* Already stopped. */ }
          return;
        }
        session.started = true;
        mode = 'spoken';
        report(session.stopping ? 'stopping' : 'listening', session.stopping ? 'Finishing recording…' : 'Listening…');
        if (session.stopping) stop(session);
      };
      recognition.onresult = (event) => {
        if (!current(session)) return;
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          session.results.set(index, { text: result[0]?.transcript || '', final: Boolean(result.isFinal) });
        }
        // Interim results are only a preview; finish waits for the final result.
        textarea.value = join(session.before, [...session.results.values()].map(value => value.text).join(' '));
        mode = 'spoken';
      };
      recognition.onerror = (event) => {
        if (!current(session)) return;
        const denied = event.error === 'not-allowed' || event.error === 'service-not-allowed';
        fail(session, error('SPEECH_ERROR', denied
          ? 'Microphone access was not allowed. Type your response or allow the microphone in your browser.'
          : 'Voice input stopped unexpectedly. Type your response or try recording again.'));
      };
      recognition.onend = () => {
        if (!current(session)) return;
        const transcript = finalText(session);
        if (!transcript) {
          fail(session, error('NO_SPEECH', 'No complete speech was captured. Type your response or try recording again.'));
          return;
        }
        textarea.value = join(session.before, transcript);
        active = null;
        detach(session);
        lastError = null;
        mode = 'spoken';
        session.resolve?.(textarea.value.trim());
        report('idle', 'Recording complete. You can review the words before continuing.');
      };
      try { recognition.start(); }
      catch {
        const problem = error('SPEECH_START_FAILED', 'Could not start voice input. Type your response or try again.');
        fail(session, problem);
        throw problem;
      }
    },
    async finish() {
      if (destroyed) throw error('SPEECH_DESTROYED', 'This recording control is no longer active.');
      if (!active) {
        if (lastError) throw lastError;
        return textarea.value.trim();
      }
      const session = active;
      if (!session.promise) {
        session.promise = new Promise((resolve, reject) => { session.resolve = resolve; session.reject = reject; });
        session.stopping = true;
        session.timer = setTimeout(() => fail(session, error('SPEECH_TIMEOUT', 'Recording did not finish in time. Type your response or record it again.')), finishTimeoutMs);
        report('stopping', 'Finishing recording…');
        stop(session);
      }
      return session.promise;
    },
    cancel,
    destroy() {
      cancel();
      destroyed = true;
      textarea.removeEventListener('input', onInput);
    },
  };
}
