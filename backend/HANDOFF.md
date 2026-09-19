# Frontend, speech, and health API handoff

The newest Version B frontend is connected in this repository. Run the backend and open `/app`; see [the integration guide](../FRONTEND-INTEGRATION.md). There is no need for a second extraction system.

| Component | Current implementation |
| --- | --- |
| Interface and central state | `index.html`, `frontend/new-ui.js` |
| Audio capture and transcription | `frontend/elevenlabs-speech.js`, `frontend/pcm-worklet.js` |
| Private ElevenLabs key and temporary token | `src/speech.ts`, `POST /api/speech/token` |
| Gemini health extraction | `src/extractor.ts`, `POST /api/analyze` |
| Missing fields and next question | `src/questions.ts` |
| Session, review, confirmed save | `src/checkins.ts`, `POST /api/checkin/save` |

Version A used browser speech recognition. This merge adds real ElevenLabs Scribe Realtime. Spoken AI replies are separate work; the optional read-prompt control uses browser speech synthesis.

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

`createElevenLabsSpeechInput()` exposes `available`, `isActive`, `mode`, `start()`, `finish()`, `cancel()`, and `destroy()`. `finish()` waits for a final transcript. Clips are limited to 30 seconds. Editing the transcript cancels recording and makes it a form answer.

The backend `.env` contains both private provider keys. The browser calls `/api/speech/token` and receives only a single-use token. Never put keys in browser code or Expo `EXPO_PUBLIC_*` settings. Typed check-ins work without ElevenLabs. A separate native Expo interface needs native audio capture; this AudioWorklet adapter is for browsers.

## Share and test

Work branch: `codex/connect-new-ui`. Backup: `codex/backup-before-new-ui-c222f48`. Share through the team's commit/push/merge workflow plus the running API's base URL. A GitHub URL is not an API address.

The same-Mac address is `http://127.0.0.1:3001`. Other devices need the Mac's LAN address and an appropriate server bind address; see [README.md](README.md). Browser microphone capture requires localhost or HTTPS. There is no authentication or durable storage in this prototype.

Test wellness, separate arm/leg pain, unnamed missed medication, medication refusal, and three meals. Test typed input first, then a physical microphone. All 68 automated tests and TypeScript checking passed. Live synthetic ElevenLabs audio and Gemini wellness/arm-leg/missed-medication checks succeeded; the browser arm-leg flow reached confirmed save. Live refusal/meals checks hit provider busy/quota limits. Physical microphone input has not yet been manually verified.
