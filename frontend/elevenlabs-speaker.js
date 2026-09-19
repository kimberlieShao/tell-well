// Keep one audio element so a click can unlock later spoken questions on mobile.
// No API keys, browser speech synthesis, or text interpretation happens here.
export function createElevenLabsSpeaker({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  audioFactory = () => new Audio(),
  urlApi = globalThis.URL,
  endpoint = '/api/speech/speak',
  timeoutMs = 30_000,
  playbackTimeoutMs = 60_000,
} = {}) {
  let audio = null;
  let active = null;
  let destroyed = false;
  let primed = false;

  const aborted = () => new DOMException('Spoken question cancelled.', 'AbortError');
  const current = (operation) => active === operation && !destroyed;
  function stop() {
    if (active) active.finish(aborted());
    else audio?.pause();
  }
  function operation(kind, limit) {
    stop();
    if (destroyed) throw new Error('Voice playback has been closed.');
    audio ||= audioFactory();
    audio.preload = 'auto';
    const op = { kind, controller: new AbortController(), url: null, timer: null, finish: null, onEnded: null, onError: null, promise: null };
    op.promise = new Promise((resolve, reject) => {
      let settled = false;
      op.finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(op.timer);
        op.controller.abort();
        audio.removeEventListener('ended', op.onEnded);
        audio.removeEventListener('error', op.onError);
        if (active === op) {
          active = null;
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        }
        if (op.url) urlApi.revokeObjectURL(op.url);
        if (error) reject(error); else resolve();
      };
    });
    active = op;
    op.timer = setTimeout(() => op.finish(new Error('The spoken question took too long. Try voice again or continue by typing.')), limit);
    op.onEnded = () => { if (current(op)) { if (op.kind === 'prime') primed = true; op.finish(); } };
    op.onError = () => { if (current(op)) op.finish(new Error('The spoken question could not be played. Try voice again or continue by typing.')); };
    audio.addEventListener('ended', op.onEnded);
    audio.addEventListener('error', op.onError);
    return op;
  }
  function play(op, blob) {
    if (!current(op)) return;
    op.url = urlApi.createObjectURL(blob);
    audio.src = op.url;
    // play() must be invoked synchronously by prime() during the user's click.
    let starting;
    try { starting = audio.play(); } catch (error) { op.finish(playbackError(error)); return; }
    Promise.resolve(starting).then(() => {
      if (current(op) && op.kind === 'prime') { primed = true; op.finish(); }
    }, (error) => { if (current(op)) op.finish(playbackError(error)); });
  }
  function playbackError(error) {
    primed = false;
    return new Error(error?.name === 'NotAllowedError'
      ? 'Your browser blocked voice playback. Tap the voice button again or continue by typing.'
      : 'The spoken question could not be played. Try voice again or continue by typing.');
  }
  function prime() {
    if (destroyed) return Promise.reject(new Error('Voice playback has been closed.'));
    if (primed) return Promise.resolve();
    let op;
    try { op = operation('prime', 5000); play(op, silentWav()); } catch (error) { if (op) op.finish(error); else return Promise.reject(error); }
    return op.promise;
  }
  function speak(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1200) return Promise.reject(new Error('There is no valid question to read.'));
    let op;
    try { op = operation('speech', timeoutMs); } catch (error) { return Promise.reject(error); }
    (async () => {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify({ text: text.trim() }), signal: op.controller.signal,
        });
        if (!current(op)) return;
        if (!response.ok) {
          throw new Error(response.status === 503
            ? 'Spoken questions are unavailable or have reached the service usage limit. Try voice again or continue by typing.'
            : 'The speech service could not read this question. Try voice again or continue by typing.');
        }
        if (!/^audio\/(mpeg|mp3)(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('The speech service returned invalid audio. Continue by typing.');
        const blob = await response.blob();
        if (!current(op)) return;
        if (!blob.size || blob.size > 2 * 1024 * 1024) throw new Error('The speech service returned invalid audio. Continue by typing.');
        clearTimeout(op.timer);
        op.timer = setTimeout(() => op.finish(new Error('Voice playback did not finish. Try voice again or continue by typing.')), playbackTimeoutMs);
        play(op, blob);
      } catch (error) { if (current(op)) op.finish(error?.name === 'AbortError' ? aborted() : new Error(error?.message || 'Spoken questions could not connect. Continue by typing.')); }
    })();
    return op.promise;
  }
  return {
    prime, speak, stop,
    get isSpeaking() { return active?.kind === 'speech'; },
    destroy() { stop(); destroyed = true; audio = null; },
  };
}

function silentWav() {
  const bytes = new Uint8Array(44 + 320);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, 320, true);
  return new Blob([bytes], { type: 'audio/wav' });
}
