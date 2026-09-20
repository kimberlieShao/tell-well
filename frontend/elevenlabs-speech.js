import { speechKeyterms } from './speech-terms.js';
const speechError = (code, message) => Object.assign(new Error(message), { code });
const join = (...parts) => parts.map(part => part.trim()).filter(Boolean).join(' ');

// The requested language is a recognition hint, not an output guarantee.
// Check the provider's final language metadata and reject other writing systems
// (including the Cyrillic output that can otherwise slip through an English hint).
const englishTranscriptProblem = (text, languageCode) => {
  const letters = text.replace(/[µμ](?=[gGlL]\b)/gu, '').match(/\p{L}/gu) ?? [];
  if (letters.some(letter => !/\p{Script=Latin}/u.test(letter)))
    return speechError('SPEECH_ENGLISH_REQUIRED', 'That recording was not recognized as English. Please try again in English, or type your answer.');
  // Scores and measurements such as "2:00" or "118/76" have no language.
  if (/\d/.test(text) && /^[\d\s.,:/%+\-–()!?]+$/u.test(text)) return null;
  const language = typeof languageCode === 'string' ? languageCode.trim().toLowerCase() : '';
  if (!language || ['und', 'unknown'].includes(language))
    return speechError('SPEECH_LANGUAGE_UNVERIFIED', 'The recording language could not be confirmed. Please record again in English, or type your answer.');
  if (!/^(?:en|eng)(?:[-_][a-z0-9]+)*$/.test(language))
    return speechError('SPEECH_ENGLISH_REQUIRED', 'That recording was not recognized as English. Please try again in English, or type your answer.');
  return null;
};

const abortable = (promise, signal, problem) => new Promise((resolve, reject) => {
  const onAbort = () => reject(problem());
  if (signal.aborted) { reject(problem()); return; }
  signal.addEventListener('abort', onAbort, { once: true });
  Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
});

// The browser captures audio; no provider key is present in this module.
export async function createMicrophoneCapture({
  onAudio,
  onError,
  onLimit = () => {},
  onStatus = () => {},
  audioContext = null,
  signal,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeImpl = globalThis.AudioWorkletNode,
} = {}) {
  let stream, context, source, worklet, gain, flushResolve, flushReject, flushTimer;
  let startPromise, startResolve, startReject;
  let closed = false;
  let started = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(flushTimer);
    signal?.removeEventListener('abort', cancel);
    stream?.getTracks().forEach(track => track.stop());
    for (const node of [source, worklet, gain]) { try { node?.disconnect(); } catch { /* Already disconnected. */ } }
    if (worklet) { worklet.port.onmessage = null; worklet.onprocessorerror = null; worklet.port.close(); }
    if (!audioContext && context && context.state !== 'closed') void context.close().catch(() => {});
  };
  const cancel = () => {
    const problem = speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
    startReject?.(problem);
    flushReject?.(problem);
    cleanup();
  };
  const guard = () => {
    if (closed || signal?.aborted) throw speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    guard();
    if (!mediaDevices?.getUserMedia || (!audioContext && !AudioContextImpl) || !AudioWorkletNodeImpl) {
      throw speechError('SPEECH_UNAVAILABLE', 'Voice input needs a supported browser on HTTPS or localhost. Type your check-in instead.');
    }
    // Manual capture resumes on its click. Conversation capture reuses the
    // context unlocked on Start, before any awaited spoken question.
    context = audioContext || new AudioContextImpl();
    const resumed = context.state === 'running' ? Promise.resolve() : context.resume();
    resumed.catch(() => {});
    onStatus({ stage: 'permission', message: 'Waiting for microphone permission…' });
    stream = await mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (closed || signal?.aborted) {
      stream.getTracks().forEach(track => track.stop());
      guard();
    }
    onStatus({ stage: 'audio', message: 'Starting microphone audio…' });
    await (signal ? abortable(resumed, signal, () => speechError('SPEECH_CANCELLED', 'Recording was cancelled.')) : resumed);
    guard();
    onStatus({ stage: 'worklet', message: 'Preparing your microphone…' });
    await context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url).href);
    guard();
    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNodeImpl(context, 'checkin-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    gain = context.createGain();
    gain.gain.value = 0;
    worklet.port.onmessage = ({ data }) => {
      if (closed) return;
      if (data?.type === 'audio' && data.buffer instanceof ArrayBuffer && data.buffer.byteLength) {
        onAudio(new Uint8Array(data.buffer));
        // Connecting the graph is not proof that the microphone is running.
        // Silence counts as input too; users need not speak to become ready.
        startResolve?.();
      }
      if (data?.type === 'limit') onLimit();
      if (data?.type === 'flushed') { flushResolve?.(); cleanup(); }
    };
    worklet.onprocessorerror = () => {
      const problem = speechError('SPEECH_CAPTURE_FAILED', 'Audio capture stopped. Type your response or record it again.');
      startReject?.(problem);
      flushReject?.(problem);
      cleanup();
      onError(problem);
    };
    return {
      start() {
        guard();
        if (started) return startPromise;
        started = true;
        startPromise = new Promise((resolve, reject) => { startResolve = resolve; startReject = reject; });
        // Some callers only use cancellation; the returned promise still
        // rejects for callers awaiting startup, without an unhandled rejection.
        startPromise.catch(() => {});
        try {
          source.connect(worklet);
          worklet.connect(gain);
          gain.connect(context.destination);
        } catch (error) {
          startReject(error);
          cleanup();
        }
        return startPromise;
      },
      async finish() {
        guard();
        if (!started) { cleanup(); return; }
        // Stop capture immediately; the worklet flushes only audio already received.
        stream.getTracks().forEach(track => track.stop());
        source.disconnect();
        await new Promise((resolve, reject) => {
          flushResolve = resolve;
          flushReject = reject;
          flushTimer = setTimeout(() => {
            cleanup();
            reject(speechError('SPEECH_CAPTURE_TIMEOUT', 'Audio could not finish safely. Review or type your transcript.'));
          }, 2000);
          worklet.port.postMessage({ type: 'flush' });
        });
      },
      cancel,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function createElevenLabsSpeechInput({
  textarea,
  onStatus = () => {},
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  captureFactory = createMicrophoneCapture,
  tokenUrl = '/api/speech/token',
  startTimeoutMs = 20000,
  finishTimeoutMs = 12000,
  maxRecordingMs = 30000,
  commitStrategy = 'manual',
  keyterms = null,
  vadSilenceThresholdSecs = 2,
  onTurn = () => {},
} = {}) {
  if (!textarea) throw new TypeError('A transcript textarea is required.');
  if (!['manual', 'vad'].includes(commitStrategy)) throw new TypeError('Unknown speech commit strategy.');
  if (!Number.isFinite(vadSilenceThresholdSecs) || vadSilenceThresholdSecs < 0.3 || vadSilenceThresholdSecs > 3) {
    throw new TypeError('The speech silence threshold must be between 0.3 and 3 seconds.');
  }
  let active = null;
  let destroyed = false;
  let generation = 0;
  let mode = 'form';
  let lastError = null;
  const report = (type, message) => onStatus({ type, message });
  const current = session => active === session && !destroyed;
  const stable = session => join(session.before, ...session.committed);
  const available = typeof fetchImpl === 'function' && typeof WebSocketImpl === 'function'
    && (captureFactory !== createMicrophoneCapture || Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && (globalThis.AudioContext || globalThis.webkitAudioContext) && globalThis.AudioWorkletNode));
  const cleanup = session => {
    clearTimeout(session.startTimer);
    clearTimeout(session.finishTimer);
    clearTimeout(session.limitTimer);
    clearTimeout(session.languageTimer);
    session.pendingAudio.length = 0;
    session.pendingAudioBytes = 0;
    session.controller.abort();
    session.capture?.cancel();
    if (session.socket) {
      session.socket.onmessage = null;
      session.socket.onerror = null;
      session.socket.onclose = null;
      try { session.socket.close(); } catch { /* Already closed. */ }
    }
  };
  const fail = (session, problem) => {
    if (!current(session)) return;
    textarea.value = stable(session);
    active = null;
    lastError = problem;
    session.problem = problem;
    session.readyReject?.(problem);
    session.finalReject?.(problem);
    cleanup(session);
    report('error', problem.message);
  };
  const waitForLanguage = session => {
    if (session.languageTimer) return;
    session.languageTimer = setTimeout(() => fail(session, speechError('SPEECH_LANGUAGE_UNVERIFIED',
      'The recording language could not be confirmed. Please record again in English, or type your answer.')), finishTimeoutMs);
  };
  const complete = session => {
    if (!current(session)) return;
    if (!session.committed.length) {
      fail(session, speechError('NO_SPEECH', 'No complete speech was captured. Type your response or record it again.'));
      return;
    }
    const text = stable(session);
    textarea.value = text;
    session.result = text;
    active = null;
    cleanup(session);
    session.finalResolve?.(text);
    report('idle', commitStrategy === 'vad' ? 'Your response is ready.' : 'Recording complete. Review the words before continuing.');
    if (commitStrategy === 'vad') {
      // Dispatch only after all recording resources have stopped. Cancelling,
      // editing, or starting another turn invalidates an already queued callback.
      queueMicrotask(() => {
        if (destroyed || generation !== session.generation || session.turnDelivered) return;
        session.turnDelivered = true;
        Promise.resolve().then(() => {
          if (!destroyed && generation === session.generation) return onTurn(text);
        }).catch(() => {
          if (!destroyed && generation === session.generation) report('error', 'Your response could not continue. Review the transcript and try again.');
        });
      });
    }
  };
  const sendAudio = (session, bytes, commit = false) => {
    if (!current(session) || session.socket?.readyState !== 1) throw speechError('SPEECH_CONNECTION_LOST', 'The speech connection stopped. Review or type your transcript.');
    // Bound buffering rather than silently dropping words on a slow connection.
    if (session.socket.bufferedAmount > 512000) throw speechError('SPEECH_CONNECTION_SLOW', 'The speech connection is too slow. Review or type your transcript.');
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    session.socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: btoa(binary), sample_rate: 16000, commit }));
    session.samples += bytes.length / 2;
  };
  const captureAudio = (session, bytes) => {
    if (!current(session) || !bytes.length) return;
    try {
      if (session.socketReady) sendAudio(session, bytes);
      else {
        // Keep the beginning of the reply while the token/socket connects.
        // Cap at the existing 30-second mono PCM limit; never drop early words.
        if (session.pendingAudioBytes + bytes.length > 30 * 16000 * 2)
          throw speechError('SPEECH_CONNECTION_SLOW', 'The speech connection took too long. Please record your answer again or type it.');
        session.pendingAudio.push(bytes.slice());
        session.pendingAudioBytes += bytes.length;
      }
    } catch (problem) { fail(session, problem); }
  };

  const cancel = () => {
    generation++;
    lastError = null;
    mode = 'form';
    if (!active) return;
    const session = active;
    active = null;
    textarea.value = stable(session);
    const problem = speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
    session.problem = problem;
    session.readyReject?.(problem);
    session.finalReject?.(problem);
    cleanup(session);
    report('idle', 'Recording stopped.');
  };
  const onInput = () => {
    const edited = textarea.value;
    cancel();
    textarea.value = edited;
  };
  textarea.addEventListener('input', onInput);

  const finish = () => {
    if (destroyed) return Promise.reject(speechError('SPEECH_DESTROYED', 'This recording control is no longer active.'));
    if (!active) return lastError ? Promise.reject(lastError) : Promise.resolve(textarea.value.trim());
    const session = active;
    if (session.finishPromise) return session.finishPromise;
    clearTimeout(session.limitTimer);
    report('stopping', 'Finishing your transcript…');
    session.finishPromise = (async () => {
      try {
        await session.startPromise;
        if (session.result !== undefined) return session.result;
        if (!current(session)) throw speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
        // Install the waiter before sending commit, including for synchronous test sockets.
        const final = new Promise((resolve, reject) => { session.finalResolve = resolve; session.finalReject = reject; });
        final.catch(() => {});
        session.finishTimer = setTimeout(() => fail(session, session.unverified.length
          ? speechError('SPEECH_LANGUAGE_UNVERIFIED', 'The recording language could not be confirmed. Please record again in English, or type your answer.')
          : speechError('SPEECH_TIMEOUT', 'The speech service did not finish in time. Review or type your transcript.')), finishTimeoutMs);
        await session.capture.finish();
        // VAD can deliver the final segment while the worklet is flushing.
        if (session.result !== undefined) return session.result;
        if (!current(session)) throw speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
        // Scribe starts processing after two seconds. Pad a short reply with silence.
        if (session.samples < 32000) sendAudio(session, new Uint8Array((32000 - session.samples) * 2));
        session.commitSent = true;
        sendAudio(session, new Uint8Array(0), true);
        return await final;
      } catch (error) {
        // Cleanup may reject a concurrent capture flush after VAD already won.
        if (session.result !== undefined) return session.result;
        if (current(session)) fail(session, error.code ? error : speechError('SPEECH_FAILED', 'Recording could not finish. Review or type your transcript.'));
        throw error;
      }
    })();
    return session.finishPromise;
  };
  const reachedLimit = session => {
    if (!current(session)) return;
    if (commitStrategy === 'vad' && !session.heardSpeech) {
      fail(session, speechError('NO_SPEECH', 'I did not hear a complete response. Try the microphone again or type your answer.'));
      return;
    }
    report('notice', 'The 30-second recording limit was reached. Finishing your transcript for review.');
    void finish().catch(() => {});
  };

  return {
    get available() { return available && !destroyed; },
    get isActive() { return active !== null; },
    get mode() { return mode; },
    start() {
      if (destroyed) return Promise.reject(speechError('SPEECH_DESTROYED', 'This recording control is no longer active.'));
      if (active) return Promise.reject(speechError('SPEECH_BUSY', 'Recording is already in progress.'));
      if (!available) return Promise.reject(speechError('SPEECH_UNAVAILABLE', 'Voice input needs a supported browser on HTTPS or localhost. Type your check-in instead.'));
      lastError = null;
      mode = 'form';
      const session = { controller: new AbortController(), before: textarea.value.trim(), committed: [], unverified: [], lastVerifiedText: null, finishCommitObserved: false, samples: 0, commitSent: false, heardSpeech: false, pendingAudio: [], pendingAudioBytes: 0, socketReady: false, generation: ++generation };
      active = session;
      const connecting = (stage, message) => {
        if (!current(session)) return;
        session.startStage = stage;
        report('connecting', message);
      };
      connecting('permission', 'Preparing your microphone…');
      const startupErrors = {
        permission: 'Microphone permission is still pending. Allow microphone access in your browser, then try voice again.',
        audio: 'Your browser did not start microphone audio. Tap the voice button again or continue by typing.',
        worklet: 'Your microphone could not finish starting. Reload the page or continue by typing.',
        token: 'The backend could not prepare ElevenLabs transcription in time. Try voice again or continue by typing.',
        connection: 'ElevenLabs did not connect in time. Check your connection, then try voice again or continue by typing.',
      };
      session.startTimer = setTimeout(() => fail(session, speechError('SPEECH_START_TIMEOUT', startupErrors[session.startStage])), startTimeoutMs);
      session.startPromise = (async () => {
        try {
          const capturePending = Promise.resolve(captureFactory({ signal: session.controller.signal, onStatus: status => connecting(status.stage, status.message), onAudio: bytes => captureAudio(session, bytes), onError: problem => fail(session, problem), onLimit: () => reachedLimit(session) }));
          // Permission dialogs cannot be programmatically dismissed. The caller can
          // still cancel immediately, and a subsequently granted stream is released.
          capturePending.then(capture => { if (!current(session)) capture.cancel(); }, () => {});
          session.capture = await abortable(capturePending, session.controller.signal, () => session.problem ?? speechError('SPEECH_CANCELLED', 'Recording was cancelled.'));
          if (!current(session)) { session.capture.cancel(); throw speechError('SPEECH_CANCELLED', 'Recording was cancelled.'); }
          // Start as soon as the microphone is available (after spoken prompts
          // finish), while the token and WebSocket connect independently.
          const captureReady = Promise.resolve(session.capture.start());
          captureReady.catch(problem => fail(session, problem));
          if (!current(session)) throw session.problem ?? speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
          session.limitTimer = setTimeout(() => reachedLimit(session), Math.min(maxRecordingMs, 30000));
          connecting('token', 'Preparing ElevenLabs transcription…');
          const response = await abortable(fetchImpl(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: session.controller.signal }), session.controller.signal, () => session.problem ?? speechError('SPEECH_CANCELLED', 'Recording was cancelled.'));
          if (!response.ok) throw speechError('SPEECH_UNAVAILABLE', 'ElevenLabs could not start. Check the backend voice configuration or type your check-in.');
          const result = await abortable(response.json(), session.controller.signal, () => session.problem ?? speechError('SPEECH_CANCELLED', 'Recording was cancelled.'));
          if (!current(session)) throw speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
          if (typeof result.token !== 'string' || !result.token.trim()) throw speechError('SPEECH_UNAVAILABLE', 'The speech service could not start. Type your check-in instead.');
          // Wait for the delayed language result before publishing any speech.
          const query = new URLSearchParams({ model_id: 'scribe_v2_realtime', token: result.token, audio_format: 'pcm_16000', language_code: 'en', include_language_detection: 'true', commit_strategy: commitStrategy });
          for (const term of keyterms ?? speechKeyterms()) query.append('keyterms', term); // bias towards medication and symptom names
          if (commitStrategy === 'vad') query.set('vad_silence_threshold_secs', String(vadSilenceThresholdSecs));
          connecting('connection', 'Connecting to ElevenLabs…');
          const socket = new WebSocketImpl(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`);
          session.socket = socket;
          const ready = new Promise((resolve, reject) => { session.readyResolve = resolve; session.readyReject = reject; });
          socket.onmessage = ({ data }) => {
            if (!current(session)) return;
            let message;
            try { message = JSON.parse(data); } catch { fail(session, speechError('SPEECH_INVALID_RESPONSE', 'The speech service returned an invalid response. Type your check-in instead.')); return; }
            if (message.message_type === 'session_started') {
              if (message.config && Object.hasOwn(message.config, 'language_code')
                  && !/^(?:en|eng)$/i.test(String(message.config.language_code ?? ''))) {
                fail(session, speechError('SPEECH_LANGUAGE_CONFIG', 'English transcription could not be enabled. Refresh and try again, or type your answer.'));
                return;
              }
              session.readyResolve(); return;
            }
            if (message.message_type === 'partial_transcript' && typeof message.text === 'string') {
              if (message.text.trim()) session.heardSpeech = true;
              // Partial results have no language metadata; keep the last
              // verified words visible instead of briefly displaying foreign text.
              report('transcribing', 'Listening in English…');
              return;
            }
            if (message.message_type === 'committed_transcript' && typeof message.text === 'string') {
              const text = message.text.trim();
              if (session.commitSent) session.finishCommitObserved = true;
              if (text) {
                session.heardSpeech = true;
                session.unverified.push(text);
                waitForLanguage(session);
                report('transcribing', 'Checking your English transcript…');
              } else if (session.commitSent && !session.unverified.length) complete(session);
              return;
            }
            if (message.message_type === 'committed_transcript_with_timestamps' && typeof message.text === 'string') {
              const text = message.text.trim();
              if (!text) return;
              // Normal and enriched commits describe the same segment. A
              // duplicate enriched notification must not append it again.
              if (!session.unverified.length && text === session.lastVerifiedText) return;
              const problem = englishTranscriptProblem(text, message.language_code);
              if (problem) { fail(session, problem); return; }
              // Some providers may send only the enriched final. Do not make
              // that valid final wait for a separate plain notification.
              if (!session.unverified.length && session.commitSent) session.finishCommitObserved = true;
              session.unverified.shift();
              session.committed.push(text);
              session.lastVerifiedText = text;
              clearTimeout(session.languageTimer);
              session.languageTimer = null;
              if (session.unverified.length) waitForLanguage(session);
              textarea.value = stable(session);
              mode = 'spoken';
              if (!session.unverified.length && ((session.commitSent && session.finishCommitObserved)
                  || commitStrategy === 'vad')) complete(session);
              return;
            }
            if (message.message_type === 'warning') { report('notice', 'The speech service sent a notice.'); return; }
            if (typeof message.error === 'string' || ['error', 'auth_error', 'quota_exceeded', 'rate_limited', 'input_error', 'invalid_request', 'commit_throttled', 'transcriber_error', 'unaccepted_terms', 'queue_overflow', 'resource_exhausted', 'session_time_limit_exceeded', 'chunk_size_exceeded', 'insufficient_audio_activity'].includes(message.message_type)) {
              fail(session, speechError('SPEECH_PROVIDER_ERROR', 'ElevenLabs stopped transcription. Review or type your transcript and check the service configuration.'));
            }
          };
          socket.onerror = () => fail(session, speechError('SPEECH_CONNECTION_LOST', 'The speech connection failed. Type your check-in instead.'));
          socket.onclose = () => fail(session, speechError('SPEECH_CONNECTION_LOST', 'The speech connection ended before your transcript was ready. Review or type it.'));
          await ready;
          if (!current(session)) throw speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
          session.socketReady = true;
          const queuedAudio = session.pendingAudio.splice(0);
          session.pendingAudioBytes = 0;
          for (const bytes of queuedAudio) {
            if (!current(session)) break;
            sendAudio(session, bytes);
          }
          if (session.result !== undefined) return;
          connecting('audio', 'Starting microphone audio…');
          await abortable(captureReady, session.controller.signal, () => session.problem ?? speechError('SPEECH_CANCELLED', 'Recording was cancelled.'));
          if (session.result !== undefined) return;
          if (!current(session)) throw session.problem ?? speechError('SPEECH_CANCELLED', 'Recording was cancelled.');
          clearTimeout(session.startTimer);
          mode = 'spoken';
          report('listening', 'Listening in English with ElevenLabs…');
        } catch (error) {
          const problem = session.problem ?? (typeof error.code === 'string' ? error : speechError('SPEECH_START_FAILED', error.name === 'NotAllowedError'
            ? 'Microphone access was not allowed. Allow it in your browser or type your check-in.'
            : 'Voice input could not start. Type your check-in instead.'));
          if (current(session)) fail(session, problem);
          throw problem;
        }
      })();
      return session.startPromise;
    },
    finish,
    cancel,
    destroy() { cancel(); destroyed = true; textarea.removeEventListener('input', onInput); },
  };
}

// Unlock Web Audio during the Start/Resume click, then keep just that context
// across turns. Each turn still releases its microphone tracks before TTS plays.
export function createVoiceSpeechFactory({
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  captureFactory = createMicrophoneCapture,
  inputFactory = createElevenLabsSpeechInput,
  primeTimeoutMs = 8000,
} = {}) {
  let context = null;
  let priming = null;
  const cancelled = () => speechError('SPEECH_CANCELLED', 'Voice input was cancelled.');
  const blocked = () => speechError('SPEECH_AUDIO_BLOCKED', 'Your browser did not enable microphone audio. Tap the voice button again or continue by typing.');
  const release = () => {
    const previous = context;
    context = null;
    priming?.controller.abort();
    priming = null;
    if (previous && previous.state !== 'closed') void previous.close().catch(() => {});
  };
  const factory = options => inputFactory({
    ...options,
    captureFactory: config => {
      if (!context || context.state === 'closed') throw blocked();
      return captureFactory({ ...config, audioContext: context });
    },
  });
  factory.prime = () => {
    if (context?.state === 'running') return Promise.resolve();
    if (priming) return priming.promise;
    if (!AudioContextImpl) return Promise.reject(speechError('SPEECH_UNAVAILABLE', 'This browser does not support voice input. Continue by typing.'));
    const operation = { controller: new AbortController(), promise: null, timer: null, timedOut: false };
    try {
      context ||= new AudioContextImpl();
      // Keep this synchronous: awaiting the speaker first loses the click gesture.
      const resumed = context.resume();
      priming = operation;
      operation.timer = setTimeout(() => {
        operation.timedOut = true;
        operation.controller.abort();
      }, primeTimeoutMs);
      operation.promise = abortable(resumed, operation.controller.signal, () => operation.timedOut ? blocked() : cancelled())
        .then(() => {
          if (operation.controller.signal.aborted || priming !== operation) throw cancelled();
          if (context?.state !== 'running') throw blocked();
        })
        .catch(error => { if (priming === operation) release(); throw error; })
        .finally(() => { clearTimeout(operation.timer); if (priming === operation) priming = null; });
      return operation.promise;
    } catch (error) { release(); return Promise.reject(error); }
  };
  factory.release = release;
  return factory;
}
