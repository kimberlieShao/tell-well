// The browser talks only to our health API. Provider credentials stay on the server.
export class CheckinError extends Error {
  constructor(message, { code = 'CLIENT_ERROR', status = 0, details = [], uncertain = false } = {}) {
    super(message);
    this.name = 'CheckinError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.uncertain = uncertain;
  }
}

const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

const looksLikeState = (value) => value && value.schemaVersion === '1.0'
  && typeof value.sessionId === 'string' && Number.isInteger(value.version) && value.version > 0
  && ['collecting', 'review', 'saved'].includes(value.status)
  && ['symptoms', 'medications', 'diet', 'vitals'].every(key => Array.isArray(value[key]))
  && (value.nextQuestion === null || (typeof value.nextQuestion?.id === 'string'
    && typeof value.nextQuestion?.text === 'string' && Array.isArray(value.nextQuestion?.options)));

export function createCheckinClient({ baseUrl = '', fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const base = baseUrl.replace(/\/$/, '');
  let state = null;
  let busy = false;
  let blocked = false;

  const assertReady = () => {
    if (busy) throw new CheckinError('Please wait for the current request to finish.', { code: 'BUSY' });
    if (blocked) throw new CheckinError('This session cannot safely continue. Start a new check-in.', { code: 'SESSION_BLOCKED' });
  };
  const sessionBody = () => {
    assertReady();
    if (!state) throw new CheckinError('Start a check-in first.', { code: 'NO_SESSION' });
    if (state.status === 'saved') throw new CheckinError('This check-in is already saved. Start a new one to make another entry.', { code: 'ALREADY_SAVED' });
    return { sessionId: state.sessionId, version: state.version };
  };
  const currentQuestion = () => {
    if (state?.status !== 'collecting' || !state.nextQuestion)
      throw new CheckinError('There is no current follow-up question.', { code: 'NO_QUESTION' });
    return state.nextQuestion.id;
  };
  const text = (value) => {
    if (typeof value !== 'string' || !value.trim())
      throw new CheckinError('Enter a response before continuing.', { code: 'EMPTY_TEXT' });
    return value.trim();
  };

  const request = async (path, body) => {
    assertReady();
    const serializedBody = JSON.stringify(body);
    busy = true;
    const controller = new AbortController();
    let timer;
    let response;
    let payload;
    try {
      // Include response-body decoding in the deadline. A lost response may hide a
      // successful server mutation, so retrying with the old version is unsafe.
      await Promise.race([
        (async () => {
          response = await fetchImpl(`${base}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: serializedBody, signal: controller.signal,
          });
          payload = await response.json();
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new CheckinError('The request timed out. Start a new check-in before trying again.', {
              code: 'TIMEOUT', uncertain: true,
            }));
          }, timeoutMs);
        }),
      ]);
      if (!response.ok) {
        if (state && [404, 409].includes(response.status)) blocked = true;
        throw new CheckinError(payload?.error?.message || 'The backend could not complete this request.', {
          code: payload?.error?.code || 'HTTP_ERROR', status: response.status,
          details: Array.isArray(payload?.error?.details) ? payload.error.details : [],
        });
      }
      if (!looksLikeState(payload) || (state && (payload.sessionId !== state.sessionId || payload.version <= state.version))) {
        blocked = true;
        throw new CheckinError('The backend returned an unexpected response. Start a new check-in.', {
          code: 'INVALID_RESPONSE', uncertain: true,
        });
      }
      state = freeze(payload);
      return state;
    } catch (error) {
      if (error instanceof CheckinError) {
        if (error.uncertain) blocked = true;
        throw error;
      }
      blocked = true;
      throw new CheckinError('The connection was interrupted. Your last received record is still shown. Start a new check-in to continue.', {
        code: 'NETWORK_ERROR', uncertain: true,
      });
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  };

  return {
    get state() { return state; },
    get busy() { return busy; },
    get blocked() { return blocked; },
    async start(transcript) {
      assertReady();
      if (state) throw new CheckinError('Reset before starting a new check-in.', { code: 'SESSION_EXISTS' });
      return request('/api/analyze', { transcript: text(transcript) });
    },
    async answer(value, { spoken = false } = {}) {
      const body = sessionBody();
      const questionId = currentQuestion();
      const answer = text(value);
      return request('/api/analyze', spoken
        ? { ...body, questionId, transcript: answer }
        : { ...body, answer: { questionId, value: answer } });
    },
    async skip() {
      const body = sessionBody();
      return request('/api/analyze', { ...body, action: 'skip', questionId: currentQuestion() });
    },
    async review() {
      const body = sessionBody();
      return request('/api/analyze', { ...body, action: 'review' });
    },
    async resume() {
      const body = sessionBody();
      return request('/api/analyze', { ...body, action: 'resume' });
    },
    async save(record) {
      const body = sessionBody();
      if (state.status !== 'review') throw new CheckinError('Review the record before confirming and saving.', { code: 'REVIEW_REQUIRED' });
      return request('/api/checkin/save', { ...body, confirmed: true, ...(record === undefined ? {} : { record }) });
    },
    reset() {
      if (busy) throw new CheckinError('Wait for the current request to finish before starting over.', { code: 'BUSY' });
      state = null;
      blocked = false;
    },
  };
}
