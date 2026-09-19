# Frontend, speech, and health API handoff

The newest Version B frontend is connected in this repository. Run the backend and open `/app`; see [the integration guide](../FRONTEND-INTEGRATION.md). There is no need for a second extraction system.

| Component | Current implementation |
| --- | --- |
| Interface and central state | `index.html`, `frontend/new-ui.js` |
| Audio capture and transcription | `frontend/elevenlabs-speech.js`, `frontend/pcm-worklet.js` |
| Automatic speak/listen/answer sequence | `frontend/voice-conversation.js` |
| Spoken questions | `frontend/elevenlabs-speaker.js`, `src/tts.ts`, `POST /api/speech/speak` |
| Private ElevenLabs key and temporary token | `src/speech.ts`, `POST /api/speech/token` |
| Gemini health extraction | `src/extractor.ts`, `POST /api/analyze` |
| Missing fields and next question | `src/questions.ts` |
| Session, review, confirmed save | `src/checkins.ts`, `POST /api/checkin/save` |

Version A used browser speech recognition. Version B now uses real ElevenLabs Scribe Realtime and ElevenLabs text-to-speech for Daily Check-in questions. Gemini extracts the reported information, while existing backend rules choose the next question. The legacy hidden read-prompt control is separate from this conversation flow.

## Integration boundary

The health API accepts transcript text, not audio. Send a completed user turn rather than every interim word. Keep one health session and one outstanding request per check-in.

Another frontend can reuse the browser helper:

```js
import { createCheckinClient } from './frontend/checkin-api.js';
const client = createCheckinClient({ baseUrl: '', painScale: '1-10' });
let state = await client.start(completedTranscript);
// When state.nextQuestion exists:
state = await client.answer(spokenAnswer, { spoken: true });
// Buttons/field answers use client.answer('7'); skipping uses client.skip().
state = await client.review();
// Show editable review; wait for the user's Confirm action.
state = await client.save(editedRecord);
```

Naturally completed sessions are already in review. `editedRecord` contains all four arrays plus nullable `wellness`; preserve item IDs. The client adds the latest session/version/question IDs. See [API.md](API.md) for raw requests.

Map responses into central state before rendering. `frontend/version-b-adapter.js` maps `severityScore` to each symptom's `painScore`, diet `description` to `item`, and vital `name` to `type`; it reverses those aliases on save. Do not run a competing frontend regex health parser.

## Voice integration

Home **Start Daily Check-in** begins voice interaction. The assistant speaks, waits for playback to end, starts listening, and automatically submits the completed turn after about two seconds of silence. Answers retain the current session/question IDs. Version B's question screens, separate 1–10 pain scores, and final review remain in place. No Continue/Submit click is needed between spoken answers. **Confirm & Save is still required after reviewing the final summary.** The separate Meals entry keeps its manual review flow.

`createVoiceConversation()` in `frontend/voice-conversation.js` coordinates this flow using the existing health client, a speaker, and the microphone adapter. It exposes `start({ resume })`, `pause()`, `stop()`, `review()`, `destroy()`, and `active`, `busy`, `state` getters. UI hooks are `onRecord(response)`, `onQuestion(question)`, `onReview(response)`, and `onState({ phase, message, active, busy })`. `new-ui.js` maps records into central state and renders the existing screens. The controller does not save or create another NLP system.

`createElevenLabsSpeechInput()` exposes `available`, `isActive`, `mode`, `start()`, `finish()`, `cancel()`, and `destroy()`. The conversation uses `commitStrategy: 'vad'`, `vadSilenceThresholdSecs: 2`, and an `onTurn(text)` callback dispatched once after recording resources stop. Manual controls retain the default manual commit mode: `finish()` waits for a final transcript. Every recording is limited to 30 seconds. Editing a transcript cancels its recording and makes it a form answer.

`createElevenLabsSpeaker()` in `frontend/elevenlabs-speaker.js` exposes `prime()`, `speak(text)`, `stop()`, `destroy()`, and `isSpeaking`. Call `prime()` synchronously from the initiating user click. `speak()` requests `/api/speech/speak` and resolves after audio playback ends; the microphone must remain off until then. Stopping cancels pending audio fetching or playback.

Pause/Use buttons stops recording and playback immediately. Resume asks the current question again without resubmitting a stale transcript. Review now ends follow-ups early. Exact spoken “skip,” “pause,” and “finish check-in” commands are supported. Errors pause visibly with the transcript retained. Duplicate/stale callbacks cannot trigger additional requests; unresolved repeated questions and turn limits lead to review with missing fields left blank.

The backend `.env` contains both private provider keys. The existing ElevenLabs key needs **Speech to Text** and **Text to Speech** access. The browser calls `/api/speech/token` for a single-use token and `/api/speech/speak` for MP3 audio; neither returns the private key. Optional `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL` default to `JBFqnCBsd6RMkjVDRZzb` and `eleven_flash_v2_5`. Never put keys in browser code or Expo `EXPO_PUBLIC_*` settings. Typed check-ins work without ElevenLabs. A separate native Expo interface needs native audio capture; this AudioWorklet adapter is for browsers.

## Share and test

Work branch: `codex/voice-conversation`. Backup before this update: `codex/backup-before-voice-2861fbf`. The older Version A backup remains `codex/backup-before-new-ui-c222f48`. Share through the team's commit/push/merge workflow plus the running API's base URL. A GitHub URL is not an API address.

To load the new spoken-question route, restart the backend yourself in its terminal: **Control+C**, **`npm start`**, then refresh `/app`. Refreshing the page alone is insufficient. Use the same procedure after changing `.env`.

The same-Mac address is `http://127.0.0.1:3001`. Other devices need the Mac's LAN address and an appropriate server bind address; see [README.md](README.md). Browser microphone capture requires localhost or HTTPS. There is no authentication or durable storage in this prototype.

Test wellness, separate arm/leg pain, unnamed missed medication, medication refusal, and three meals. Test typed input first, then a physical microphone. All **102 automated tests** and TypeScript checking passed after the conversation update. Tests include sequential voice questions, distinct pain scores, VAD, TTS, cancellation, provider failures, late callbacks, and final review without automatic saving.

For this update, live Gemini wellness returned review, live ElevenLabs text-to-speech returned a valid MP3, and synthetic VAD audio produced one completed turn without a manual `finish()`. Earlier live Gemini arm/leg and missed-medication checks succeeded, and the earlier browser arm/leg flow reached confirmed save. Earlier live refusal/meals checks hit provider busy/quota limits. Physical microphone input and the complete live hands-free browser conversation still need manual verification.
