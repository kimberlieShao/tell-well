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
| Eligible fields, brief/shared details, and legacy question policy | `src/questions.ts`, `src/followups.ts` |
| Session, review, confirmed save | `src/checkins.ts`, `POST /api/checkin/save` |

Version A used browser speech recognition. Version B uses ElevenLabs Scribe Realtime and ElevenLabs text-to-speech. The main Daily Check-in client starts with `flow: 'brief'` and `painScale: '1-10'`. Gemini extracts reported facts and can propose one shared symptom-details invitation in the same request. `src/followups.ts` validates the invitation and enforces a single answer-or-skip before review, regardless of remaining unknown fields. The legacy hidden read-prompt control is separate.

The opening varies locally as one short question and stays unchanged during pause/retry. If symptoms exist, the details screen lists them together and shows the optional note **Symptom? Location? Pain score (1–10)? Activities? Since when?** The short spoken invitation does not read out this note. There are no separate daily-activity questions. Review uses compact editable symptom tables: unknown facts display **Not Provided**, but edit inputs remain blank/null; non-pain score placeholders use the same **Not Provided** label. Existing reported trend, first occurrence, and non-pain severity remain visible.

Food/water-only brief reports, including optional wellness, log directly and end with one short recorded confirmation. Symptoms, medications, or vitals prevent that automatic save; mixed symptom/food reports get the one details invitation and normal **Confirm & Save** review. Wellness-only records also retain explicit review. Clients that omit `flow` keep the prior adaptive Gemini or deterministic demo behavior, including legacy question limits and explicit save. Restart the backend to activate the changes.

For the brief symptom-details answer, `src/symptom-details.ts` reconciles split extraction fragments with a unique existing complaint. Arm pain followed by itching at the elbows, score 2, problems with eating, and onset yesterday stays one item: both sensations in the name, elbows as location, 2 as score, eating difficulty as activity impact, and yesterday as duration. Unknown fields remain null. Distinct sites/sides, explicit separate problems, conflicting facts, and ambiguous multi-symptom details remain separate; no additional model call is made. Gemini receives the same grouping policy. This backend change requires a restart and a fresh check-in; it does not rewrite previously produced records.

## Integration boundary

The health API accepts transcript text, not audio. Send a completed user turn rather than every interim word. Keep one health session and one outstanding request per check-in.

Another frontend can reuse the browser helper:

```js
import { createCheckinClient } from './frontend/checkin-api.js';
const client = createCheckinClient({ baseUrl: '', painScale: '1-10', flow: 'brief' });
let state = await client.start(completedTranscript);
// Brief mode has at most one shared details question:
if (state.nextQuestion) state = await client.answer(spokenAnswer, { spoken: true });
// Typed replies use client.answer(text); client.skip() also ends that question.
// State is now in review. For health/mixed entries, show editable review
// and wait for Confirm before this call. The main UI directly logs food/water.
state = await client.save(editedRecord);
```

Naturally completed sessions are already in review. `editedRecord` contains all four arrays plus nullable `wellness`; preserve item IDs and optional water metadata. The client adds the latest session/version/question IDs and `confirmed: true` on save. `flow` and `painScale` are initial-request options only. The server always requires review before save, including the frontend's authorized direct food/water logging. See [API.md](API.md) for raw requests.

Map responses into central state before rendering. `frontend/version-b-adapter.js` maps `severityScore` to each symptom's `painScore`, diet `description` to `item`, and vital `name` to `type`; it reverses those aliases on save. Do not run a competing frontend regex health parser.

In brief mode, known breakfast/lunch/dinner entries go to their meal; unknown times appear under Snacks while the record's unknown `time` stays null. Water uses optional structured diet fields `waterGlasses` and `waterMode`. Mode `add` increments the current count; `total` replaces it. Zero, fractions, and counts above 12 are preserved (the slider maximum expands). An unknown glass count stays null with mode `add`, retaining the words without changing the slider. Do not infer glass sizes or convert bottles/volume. Water entries never become snacks. Saved session IDs prevent duplicate meal additions and water increments during render/save retries.

Short scores are interpreted only in question context. A standalone “it's 2:00” means 2/10 for a known pain severity question or a brief details question about exactly one pain symptom. “It started at 2:00 PM” remains timing, and a bare number cannot select between several symptoms. Explicit decimal scores are preserved by the backend's decimal-enabled parser; the existing score buttons still offer whole numbers.

## Voice integration

Home **Start Daily Check-in** begins voice interaction. The assistant speaks, waits for playback to end, starts listening, and automatically submits the completed turn after about two seconds of silence. Answers retain session/question IDs. After the single optional symptom-details turn, health and mixed entries show editable review and require **Confirm & Save**. Food/water-only brief entries save immediately, update Meals/water, and stop after a short confirmation without another question. The separate Meals panel also directly logs food/water-only brief entries; its existing mixed-entry preview saves only the displayed diet and does not silently save other health categories.

`createVoiceConversation()` in `frontend/voice-conversation.js` coordinates the health client, speaker, and microphone. It exposes `start({ resume })`, `pause()`, `stop()`, `review()`, `destroy()`, and `active`, `busy`, `state` getters. UI hooks are `onRecord(response)`, `onQuestion(question)`, `onReview(response)`, and `onState({ phase, message, active, busy })`. Optional `getInitialPrompt()` reads the cached opening. Optional async `onReadyForReview(response)` lets `new-ui.js` apply its food-only save policy; returning a saved response ends the conversation with `savedMessage(response)`. Without that hook, legacy review behavior is unchanged. The controller does not interpret health facts or decide which records qualify for automatic saving.

`createElevenLabsSpeechInput()` exposes `available`, `isActive`, `mode`, `start()`, `finish()`, `cancel()`, and `destroy()`. The conversation uses `commitStrategy: 'vad'`, `vadSilenceThresholdSecs: 2`, and an `onTurn(text)` callback dispatched once after recording resources stop. Manual controls retain the default manual commit mode: `finish()` waits for a final transcript. Every recording is limited to 30 seconds. Editing a transcript cancels its recording and makes it a form answer.

`createElevenLabsSpeaker()` in `frontend/elevenlabs-speaker.js` exposes `prime()`, `speak(text)`, `stop()`, `destroy()`, and `isSpeaking`. Call `prime()` synchronously from the initiating user click. `speak()` requests `/api/speech/speak` and resolves after audio playback ends; the microphone must remain off until then. Stopping cancels pending audio fetching or playback.

Pause/Use buttons stops recording and playback immediately. Resume asks the current unanswered question without resubmitting a stale transcript. Review now ends questions early. Exact spoken “skip,” “pause,” and “finish check-in” commands are supported. Errors retain the transcript. A failed automatic food/water save leaves a reviewable record for explicit retry. An in-flight save may still finish after Pause/Close, updating the data once, but its late result cannot reopen the modal or restart audio. Duplicate/stale callbacks cannot trigger additional requests.

The backend `.env` contains both private provider keys. The existing ElevenLabs key needs **Speech to Text** and **Text to Speech** access. The browser calls `/api/speech/token` for a single-use token and `/api/speech/speak` for MP3 audio; neither returns the private key. Optional `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL` default to `JBFqnCBsd6RMkjVDRZzb` and `eleven_flash_v2_5`. Never put keys in browser code or Expo `EXPO_PUBLIC_*` settings. Typed check-ins work without ElevenLabs. A separate native Expo interface needs native audio capture; this AudioWorklet adapter is for browsers.

## Share and test

Current work branch: `codex/adaptive-checkin-questions`. Historical conversation work used `codex/voice-conversation`; earlier backup names were `codex/backup-before-voice-2861fbf` and `codex/backup-before-new-ui-c222f48`. Share through the team's commit/push/merge workflow plus the running API's base URL. A GitHub URL is not an API address.

To load the new spoken-question route, restart the backend yourself in its terminal: **Control+C**, **`npm start`**, then refresh `/app`. Refreshing the page alone is insufficient. Use the same procedure after changing `.env`.

The same-Mac address is `http://127.0.0.1:3001`. Other devices need the Mac's LAN address and an appropriate server bind address; see [README.md](README.md). Browser microphone capture requires localhost or HTTPS. There is no authentication or durable storage in this prototype.

Current brief-flow validation: `npm run check` and all **203 automated tests** passed. The four focused brief UI tests also passed after the symptom table retained reported trend/first occurrence/non-pain severity. Coverage includes one-answer completion, partial/ambiguous replies, contextual scores, review/null preservation, food grouping, exact hydration updates, save retry, close during save, and legacy speech behavior.

Offline browser verification covered arm pain → one details note → “It's 2:00.” → score 2 and **Not Provided** fields → confirmed save, and food/water → direct save → Snacks and water slider 3. **No live provider API calls were made for this brief-flow update.** Physical microphone/speaker operation and a full live hands-free session remain unverified.

Historical verification only: earlier updates exercised live Gemini wellness/arm-leg pain/missed medication, ElevenLabs MP3 output, and synthetic VAD audio. An older two-turn Gemini pain test extracted duration and volunteered activity impact; earlier refusal/meals checks encountered busy/quota limits. These earlier results do not verify the current brief interaction.
