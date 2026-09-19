// Copy this helper into your Expo project. Type-only imports can be copied from src/schema.ts
// or replaced with generated/shared types when frontend and backend become one workspace.
import type { AnalyzeInput, CheckinResponse, HealthRecord } from '../src/schema.js';

export function createCheckinClient(baseUrl: string) {
  async function post(path: string, body: unknown): Promise<CheckinResponse> {
    const res = await fetch(baseUrl.replace(/\/$/, '') + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? 'Check-in request failed.');
    return json as CheckinResponse;
  }
  return {
    analyze: (body: AnalyzeInput) => post('/api/analyze', body),
    start: (transcript: string) => post('/api/analyze', { transcript }),
    answer: (state: CheckinResponse, value: string) => {
      if (!state.nextQuestion) throw new Error('No question to answer.');
      return post('/api/analyze', { sessionId: state.sessionId, version: state.version, answer: { questionId: state.nextQuestion.id, value } });
    },
    answerWithVoice: (state: CheckinResponse, transcript: string) => {
      if (!state.nextQuestion) throw new Error('No question to answer.');
      return post('/api/analyze', { sessionId: state.sessionId, version: state.version, questionId: state.nextQuestion.id, transcript });
    },
    skip: (state: CheckinResponse) => {
      if (!state.nextQuestion) throw new Error('No question to skip.');
      return post('/api/analyze', { sessionId: state.sessionId, version: state.version, action: 'skip', questionId: state.nextQuestion.id });
    },
    review: (state: CheckinResponse) => post('/api/analyze', { sessionId: state.sessionId, version: state.version, action: 'review' }),
    // Call only after the user has reviewed and tapped Confirm. Optionally pass their edits.
    save: (state: CheckinResponse, record?: HealthRecord) => post('/api/checkin/save', { sessionId: state.sessionId, version: state.version, confirmed: true, ...(record ? { record } : {}) }),
  };
}
