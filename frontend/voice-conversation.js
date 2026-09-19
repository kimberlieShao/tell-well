const initialPrompt = 'How are you feeling today? Tell me about any symptoms, medicines, meals, or measurements you want to record. Pause when you are finished.';
const messageOf = error => error?.message || 'Voice check-in could not continue. Your transcript is still available. Try again or use the buttons.';

// The API remains the only interpreter and question selector. This controller
// sequences speaking, listening, and requests without saving an unreviewed record.
export function createVoiceConversation({
  client,
  speaker,
  speechFactory,
  textarea,
  onRecord = () => {},
  onState = () => {},
  onQuestion = () => {},
  onReview = () => {},
  questionText = question => question.text,
  maxTurns = 24,
  maxRepeats = 2,
} = {}) {
  if (!client || !speaker || typeof speechFactory !== 'function' || !textarea) {
    throw new TypeError('A check-in client, speaker, speech factory, and transcript field are required.');
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || !Number.isInteger(maxRepeats) || maxRepeats < 1) {
    throw new TypeError('Voice turn limits must be positive integers.');
  }
  let active = false;
  let destroyed = false;
  let generation = 0;
  let pending = false;
  let recording = null;
  let turns = 0;
  let repeatedAnswers = 0;
  let phase = 'idle';
  let message = '';
  const snapshot = () => ({ phase, message, active, busy: active || pending || Boolean(client.busy) });
  const report = (nextPhase = phase, nextMessage = message) => {
    phase = nextPhase;
    message = nextMessage;
    if (!destroyed) onState(snapshot());
  };
  const current = id => !destroyed && active && generation === id;
  const cancelAudio = () => {
    // The speech adapter intentionally discards partial text when cancelled;
    // retain the displayed words so the user can edit them in manual mode.
    const draft = textarea.value;
    const previous = recording;
    recording = null;
    previous?.cancel();
    previous?.destroy();
    textarea.value = draft;
    speaker.stop();
  };
  const pause = (reason = 'Voice paused. You can review your words, use the buttons, or resume voice.') => {
    generation++;
    active = false;
    cancelAudio();
    speechFactory.release?.();
    report('paused', reason);
  };
  const fail = (error, id) => {
    if (!current(id)) return;
    generation++;
    active = false;
    cancelAudio();
    speechFactory.release?.();
    report('error', messageOf(error));
  };

  const request = async (work, id) => {
    pending = true;
    report('processing', 'Organizing your check-in…');
    try {
      const result = await work();
      // A request may finish after Pause/Close. Keep the canonical session in
      // sync, but never let its result start another screen or microphone turn.
      if (!destroyed) onRecord(result);
      return result;
    } finally {
      pending = false;
      if (!destroyed) report();
    }
  };

  const showReview = async (response, id, notice = '') => {
    if (!current(id)) return;
    cancelAudio();
    speechFactory.release?.();
    onReview(response);
    report('speaking', notice || 'Your check-in is ready to review.');
    await speaker.speak('Your check-in summary is ready. Please review it on screen and confirm when you are ready to save.');
    if (!current(id)) return;
    active = false;
    report('review', notice || 'Review your check-in, then confirm to save.');
  };

  const requestReview = async (id, notice = '') => {
    if (!current(id)) return;
    if (!client.state) throw new Error('Record a check-in first, then review your summary.');
    const result = client.state.status === 'review'
      ? client.state : await request(() => client.review(), id);
    if (current(id)) await showReview(result, id, notice);
  };

  const advance = async (response, id, answeredQuestionId = null) => {
    if (!current(id)) return;
    const question = response.nextQuestion;
    if (response.status === 'review' || !question) {
      const result = response.status === 'review' ? response : await request(() => client.review(), id);
      if (current(id)) await showReview(result, id);
      return;
    }
    repeatedAnswers = answeredQuestionId && question.id === answeredQuestionId ? repeatedAnswers + 1 : 0;
    if (turns >= maxTurns || repeatedAnswers >= maxRepeats) {
      await requestReview(id, 'Let’s review what you have shared. You can edit or complete any missing details on screen.');
      return;
    }
    onQuestion(question);
    await ask(questionText(question, response), id);
  };

  const receive = async (text, id, turn) => {
    if (!current(id) || turn.received || pending) return;
    turn.received = true;
    const words = typeof text === 'string' ? text.trim() : '';
    if (words) textarea.value = words;
    cancelAudio();
    try {
      if (!words) throw new Error('I did not hear a complete response. Try again or type your answer.');
      const command = words.toLowerCase().replace(/[.!?]+$/g, '').trim();
      if (command === 'pause') { pause(); return; }
      if (['finish check-in', 'finish check in', 'review my check-in', 'review my check in'].includes(command)) {
        await requestReview(id);
        return;
      }
      if (command === 'skip' && !client.state?.nextQuestion) {
        throw new Error('There is no follow-up question to skip. Tell me how you are feeling or use the buttons.');
      }
      const answeredQuestionId = client.state?.nextQuestion?.id || null;
      turns++;
      const response = await request(() => command === 'skip'
        ? client.skip()
        : client.state ? client.answer(words, { spoken: true }) : client.start(words), id);
      if (current(id)) await advance(response, id, answeredQuestionId);
    } catch (error) { fail(error, id); }
  };

  const ask = async (text, id) => {
    if (!current(id)) return;
    cancelAudio();
    // The previous answer is already in the record. Do not show or copy it as
    // a draft for the next question if the user pauses during playback.
    textarea.value = '';
    report('speaking', text);
    await speaker.speak(text);
    if (!current(id)) return;
    const turn = { received: false, draft: '' };
    const next = speechFactory({
      textarea,
      commitStrategy: 'vad',
      vadSilenceThresholdSecs: 2,
      onTurn: words => receive(words, id, turn),
      onStatus: status => {
        if (!current(id) || turn.received) return;
        if (['error', 'unavailable'].includes(status.type)) {
          if (turn.draft) textarea.value = turn.draft;
          fail(new Error(status.message || 'Voice input is unavailable. Type your answer instead.'), id);
        } else if (status.type === 'listening' || status.type === 'transcribing') {
          turn.draft = textarea.value;
          report('listening', status.message || 'Listening. Pause when you are finished.');
        } else if (status.type === 'connecting') {
          report('connecting', status.message || 'Connecting your microphone…');
        } else if (status.type === 'notice') report(phase, status.message);
      },
    });
    recording = next;
    if (!current(id)) { next.destroy(); return; }
    await next.start();
    if (current(id) && !turn.received) report('listening', 'Listening. Pause when you are finished, or say “skip”, “pause”, or “finish check-in”.');
  };

  return {
    get active() { return active; },
    get busy() { return snapshot().busy; },
    get state() { return snapshot(); },
    async start({ resume = false } = {}) {
      if (destroyed || active || pending || client.busy) return;
      const id = ++generation;
      active = true;
      if (!resume) { turns = 0; repeatedAnswers = 0; }
      try {
        // Run before any await so the browser can unlock audio on this click.
        const primed = Promise.all([speaker.prime(), speechFactory.prime?.()]);
        report('starting', 'Starting your voice check-in…');
        await primed;
        if (!current(id)) return;
        if (client.state?.status === 'saved') throw new Error('This check-in is already saved. Start a new check-in to record another.');
        if (client.state?.status === 'review') { await showReview(client.state, id); return; }
        if (client.state?.nextQuestion) {
          onQuestion(client.state.nextQuestion);
          await ask(questionText(client.state.nextQuestion, client.state), id);
        } else await ask(initialPrompt, id);
      } catch (error) { fail(error, id); }
    },
    pause,
    stop() { pause('Voice stopped.'); },
    async review() {
      if (destroyed || pending || client.busy) return;
      generation++;
      active = true;
      const id = generation;
      cancelAudio();
      try { await requestReview(id); } catch (error) { fail(error, id); }
    },
    destroy() {
      generation++;
      active = false;
      destroyed = true;
      cancelAudio();
      speechFactory.release?.();
      speaker.destroy?.();
    },
  };
}
