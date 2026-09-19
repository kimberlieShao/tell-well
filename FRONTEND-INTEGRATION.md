# Version B frontend integration

The root `index.html` is the newer UI supplied as `index-2.html`. Its Home, Meals, Trends, More, check-in screens, and 1–10 pain controls remain the final interface. Its local mock health parser is not active.

Shared integration baseline: [`codex/checkpoint-voice-checkin-2026-09-19`](https://github.com/aanya-k/HopHacks/tree/codex/checkpoint-voice-checkin-2026-09-19), commit `5a7fd55`. Authentication/profile contract proposal: `codex/gemini-profile-api` (documentation only). The connected Version B before the conversation update is preserved on `codex/backup-before-voice-2861fbf`. The earlier Version A backup remains `codex/backup-before-new-ui-c222f48`.

## Run

```sh
cd "/Users/toan/HopHacks 2026/HopHacks/backend"
npm install
npm start
```

Open **http://127.0.0.1:3001/app** and keep the terminal running. Control+C stops it. Open the page through this server, not by double-clicking HTML or through Live Server. The text-only API tester remains at `/test/`.

To load this update, restart the backend yourself: in its running terminal press **Control+C**, run **`npm start`**, then refresh `/app`. Refreshing alone does not load the new spoken-question endpoint. Use the same restart procedure after changing `.env`; do not start another copy on port 3001 while the old process is running.

## Voice conversation

Click **Start Daily Check-in** once. ElevenLabs reads the opening question, then the microphone listens. A pause of about two seconds ends your turn automatically. Gemini extracts the reported details, the backend chooses the next missing-field question, and ElevenLabs reads it aloud. The app repeats this sequence until it reaches **Today's Check-in** for review. Microphone capture is off while the assistant speaks.

The existing Version B screens and individual 1–10 pain scores remain visible throughout. You no longer need Continue/Submit between spoken answers. **Confirm & Save remains a deliberate action after reviewing the summary; voice completion never saves automatically.**

Use **Pause** or **Use buttons / typing** to stop voice and edit an answer. **Resume voice conversation** reads the current question again. **Review now**, or the exact spoken command “finish check-in,” ends follow-ups early. Exact “skip” and “pause” commands are also supported. **Type instead** opens the manual flow. The separate Meals voice entry retains its existing manual review controls.

Each recording is limited to 30 seconds. No complete speech, provider errors, or blocked audio playback pause the conversation visibly so you can retry or type. Repeated unresolved questions and the turn limit lead to review with missing information left blank. Starting voice needs a user click and browser microphone permission; it does not listen on page load. The Start/Resume click also unlocks a shared Web Audio context before any spoken question. That context is reused between answers; microphone tracks still stop before each spoken question. Pause, error, review, or closing the flow releases the context. Startup statuses distinguish microphone permission/audio preparation, token preparation, and the ElevenLabs connection. Wait for “I’m listening” before answering. A stalled startup reports the failing stage instead of staying on the generic check-in screen.

For deterministic extraction without Gemini quota, start a second server with `EXTRACTION_MODE=demo PORT=3002 npm start`, then open **http://127.0.0.1:3002/app**. Demo mode changes extraction only: microphone input still uses ElevenLabs if configured. Typing requires no speech service. Gemini errors never silently switch to demo extraction.

## Active files

| File | Responsibility |
| --- | --- |
| `index.html` | Version B layout, screens, and original visual styles |
| `frontend/main.js` | Mounts Version B once |
| `frontend/new-ui.js` | Central state, navigation, check-in events, review, save |
| `frontend/version-b-adapter.js` | API response → `checkinState`; edited state → API record |
| `frontend/checkin-api.js` | API requests, session/version/question IDs, errors |
| `frontend/elevenlabs-speech.js` | Microphone, temporary token, Scribe Realtime, final transcript |
| `frontend/voice-conversation.js` | Speak/listen/request sequence, pause/resume, current question, review |
| `frontend/elevenlabs-speaker.js` | Fetch and play spoken questions; stop playback before listening |
| `frontend/pcm-worklet.js` | Mono 16 kHz PCM audio capture, limited to 30 seconds |
| `frontend/integration.css` | API status, errors, and editable review styles |
| `backend/src/speech.ts` | Private ElevenLabs key → single-use Scribe token |
| `backend/src/tts.ts` | Private ElevenLabs key → spoken-question MP3 |

The old `checkin-controller.js`, `speech.js`, and `checkin.css` remain reference/test files; `main.js` does not load them. Version A used browser speech recognition. Real ElevenLabs integration was added during this merge.

```text
Start Daily Check-in → ElevenLabs spoken opening → microphone
→ ElevenLabs Scribe final turn after silence
→ /api/analyze → Gemini (or explicitly selected demo extraction)
→ normalizeBackendResponse → checkinState → Version B screens
→ backend nextQuestion → ElevenLabs spoken question → microphone → repeat
→ editable review → user confirms → /api/checkin/save
```

Conversation mode uses Scribe voice activity detection (VAD) with a two-second silence threshold. The manual microphone controls still support Done/Continue and wait for a final committed transcript before analysis. Closing/leaving the flow cancels capture and spoken playback. The legacy hidden read-prompt control remains separate; Daily Check-in questions use ElevenLabs text-to-speech.

Daily Check-in starts with `painScale: "1-10"`. Each symptom keeps its own ID/score, and a category such as “mild” does not suppress the numeric pain question. Explicit “I feel fine today” produces `wellness`, not a fake symptom. See [backend/API.md](backend/API.md).

## Keys and storage

Keep both provider keys in `backend/.env`; `.env.example` contains placeholders. The existing `ELEVENLABS_API_KEY` needs both **Speech to Text** and **Text to Speech** access. Optional `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL` select the spoken voice/model; defaults are `JBFqnCBsd6RMkjVDRZzb` and `eleven_flash_v2_5`. No separate ElevenLabs Agents setup is required.

The browser gets a single-use speech token, never an ElevenLabs or Gemini key. Microphone audio goes directly to ElevenLabs. The health backend and Gemini receive transcript text and check-in context. For a spoken question, the browser sends its text to `/api/speech/speak`; the backend requests ElevenLabs audio and returns an MP3.

Saved records live in one server process's memory. Sessions expire after two hours of inactivity; restarting the backend clears everything. Recent Check-ins displays records saved in the current page; refreshing clears that frontend state. Manual profile/Meals controls remain page-local. This branch has no database, accounts, history retrieval, or wearable connection.

## Onboarding/profile work with Kimberly

Read [the proposed authentication/profile contract](backend/PROFILE-AUTH-CONTRACT.md) and [the teammate handoff](backend/KIMBERLY-HANDOFF.md). No auth/profile routes are implemented yet. Kimberly can build isolated modules and a mock `loadProfile` / `saveProfile` adapter from the proposal; agree on it before connecting live endpoints.

Current profile and manual Meals edits are page-local. Do not treat a check-in `sessionId` as login, or copy demo profile values into real accounts. Backend ownership checks, a persistent profile store, and account-switch cleanup are required before user integration. Profile facts must remain separate from today's check-in facts.

The backend teammate owns eventual shared entry-point wiring after coordination. Keep the current `index.html`, state architecture, speech capture, and voice conversation intact while Kimberly develops her modules. Authentication/profile storage must work independently of Gemini.

Gemini status: the local model was changed to `gemini-3.6-flash`; a prior live wellness extraction returned HTTP 200. The user reports that this resolved their model error. No new quota diagnosis or paid provider calls were made for this profile-contract task.

## Future HTML updates

Preserve these includes:

```html
<link rel="stylesheet" href="/frontend/integration.css">
<script type="module" src="/frontend/main.js"></script>
```

Keep the full Version B structure and DOM hooks used by `new-ui.js`: navigation/Meals IDs, `dailyCheckinButton`, `checkinFlow`, `flowIntroMic`, `flowType`, `flowTranscript`, `.flow-done`, `editTopics`, pain/impact controls, review containers, `reviewConfirmSave`, and the `data-screen` sections. The controller also adds the conversation controls and transcript preview at runtime. This is not an exhaustive replacement HTML skeleton. If IDs or screens change, update the controller and integration tests together.

Do not load the old controller alongside Version B or restore its inline mock parser. Continue routing API responses through `normalizeBackendResponse()` into central state and edited records through `toBackendRecord()`.

## Verification

TypeScript checking and all **127 automated tests** passed at checkpoint `5a7fd55`, including the microphone handoff and Gemini adapter changes. This documentation-only profile proposal adds no runtime code or new passing authentication tests. Run `npm run check` and `npm test` inside `backend`. Tests cover extraction cases, actual Version B events against a local API, per-symptom scores, review edits, failed saves, microphone cleanup, simulated audio/WebSockets, automatic multi-turn conversations, VAD, spoken playback, cancellation, and no automatic save.

Earlier live checks verified ElevenLabs with synthetic audio, plus Gemini wellness, separate arm/leg pain, and unnamed missed medication. The earlier browser Gemini flow completed scores 7/3, impact/trend follow-ups, review, and save. Live refusal and meals checks hit provider busy/quota limits (503/429), so not all live cases passed.

For this conversation update, live Gemini wellness returned review, live ElevenLabs text-to-speech returned a valid MP3 response, and a synthetic audio test triggered one VAD turn without manually calling `finish()`. Physical microphone input and the complete live hands-free browser conversation still need a manual check; simulated provider tests do not establish that those live paths passed.

## Connected personal onboarding demo

The wearable-integration branch is combined with Kimberly's auth/onboarding UI on codex/connect-onboarding. Root `/` now opens `/auth/`. Choose **Try demo** (not Sign in) to start. First-time demo setup is `/onboarding/`; after saving choose **Continue to Home** to open `/app`. Completed profiles go directly to Home on subsequent Try demo clicks within the same tab. More links reopen profile, device and settings editors.

Profile persistence is **sessionStorage in the current tab**, not an authenticated account or database. Root index.html and WHOOP/speech services are retained. `frontend/profile-store.js` is shared by onboarding and the app; Home/More medication lists and the visit summary read the demo medication list. Onboarding selections do not create measurements, symptoms, dose events or wearable connections. Auth/profile APIs are still pending. Use backend-served pages rather than file:// so scripts and storage share the same origin.
