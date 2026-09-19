// Fictional example only. Run the API in another terminal first.
const baseUrl = process.env.API_URL ?? 'http://127.0.0.1:3001';
async function post(path, body) {
  const response = await fetch(baseUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(json));
  return json;
}
let state = await post('/api/analyze', { transcript: 'My knees hurt more today and I forgot my prednisone this morning.' });
console.log('1. Transcript analyzed:', JSON.stringify(state, null, 2));
while (state.nextQuestion) {
  const question = state.nextQuestion;
  const value = ({ severity: 'Moderate', functionalImpact: 'Making activities harder', trend: 'Worse' })[question.field];
  state = await post('/api/analyze', {
    sessionId: state.sessionId, version: state.version,
    ...(value ? { answer: { questionId: question.id, value } } : { action: 'skip', questionId: question.id }),
  });
  console.log(`2. Answered ${question.field}; status: ${state.status}`);
}
state = await post('/api/checkin/save', { sessionId: state.sessionId, version: state.version, confirmed: true });
console.log('3. Fictional record saved in memory:', JSON.stringify(state, null, 2));
