# Pulsewise backend and connected frontend

This server runs Version B at `/app`, Gemini health extraction, check-in sessions, and ElevenLabs transcription and spoken questions. Daily Check-in uses a brief flow: one shared invitation for symptom details, then editable review. Food/water-only entries are logged directly and end with a short confirmation. See [FRONTEND-INTEGRATION.md](../FRONTEND-INTEGRATION.md) for the UI files and [HANDOFF.md](HANDOFF.md) for teammate integration.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/analyze` | Extract transcript details, update session, return the next question |
| `POST /api/checkin/save` | Validate and save a reviewed record with `confirmed: true` in memory |
| `POST /api/speech/token` | Return a single-use ElevenLabs Scribe Realtime token |
| `POST /api/speech/speak` | Convert question text to an MP3 using the private ElevenLabs key |

## Start locally

Node.js 24 or newer is required. In a terminal:

```sh
cd "/Users/toan/HopHacks 2026/HopHacks/backend"
npm install
npm start
```

For a different clone, use its backend folder. `npm install` downloads dependencies; `npm start` runs the server. Keep the terminal open; Control+C stops it. `npm run dev` restarts automatically while editing.

Open **http://127.0.0.1:3001/app** for the connected UI, or **http://127.0.0.1:3001/test/** for the text-only API tester. Do not open root HTML as a local file. `npm run demo` in a second terminal exercises a fictional transcript/answer/save flow against the running server.

After this update, restart your existing server with **Control+C**, **`npm start`**, then refresh `/app`. A page refresh alone cannot load the new `/api/speech/speak` server route. If port 3001 is already in use, stop the previous server in its terminal before starting again.

## Provider configuration

For a new setup only, copy `.env.example` to `.env`; do not overwrite an existing configured `.env`. Set keys locally:

```dotenv
EXTRACTION_MODE=gemini
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-3.8-flash
ELEVENLABS_API_KEY=your_elevenlabs_key
# Optional; defaults shown:
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
```

Both keys stay server-side and out of Git. Never put them in frontend JavaScript or Expo `EXPO_PUBLIC_*` variables. Restart after changing settings. Set `GEMINI_MODEL` to a compatible model available to your account.

For `gemini-2.5-flash`, `gemini-2.5-flash-lite`, and `gemini-2.5-pro`, the adapter uses Google's stateless `models/{model}:generateContent` endpoint with JSON Schema output. Other model IDs retain the Interactions route described below. Both paths validate the same health record and preserve follow-up/session handling. Model-list availability is not a guarantee of quota or successful generation; the 2.5 route is covered by mocked compatibility tests, but the live account restriction below prevents using it here.

Account compatibility check (September 19, 2026): `gemini-2.5-flash` appeared in ListModels but its generation request returned 404 with Google's explanation that the model is no longer available to new users. Google recommended `gemini-3.6-flash` through Interactions. One live wellness extraction with that replacement succeeded; the local `.env` was updated to `GEMINI_MODEL=gemini-3.6-flash`. A backend restart is needed to load it. The 2.5 adapter remains for accounts that retain access, but is not a working alternative for this account.

- **Gemini** receives completed transcript text, the current record, question, and flow context. It extracts facts and can propose a question in the same request; the server validates the result and enforces the selected flow. The Interactions route uses `store: false`. This disables interaction retrieval through that API, not all provider data processing. Temporary HTTP 503 failures are retried up to twice with roughly 1- and 2-second delays (or a longer provider-requested delay), within one 25-second deadline. Quota/access errors are not retried. Failure does not trigger an automatic demo fallback or modify an existing session.
- **ElevenLabs** transcribes browser microphone audio and reads the backend's questions aloud. The same key needs **Speech to Text** and **Text to Speech** access. The browser streams mono 16 kHz PCM directly to Scribe v2 Realtime using a single-use token. Conversation mode uses voice activity detection with a two-second silence threshold; each recording is limited to 30 seconds. The backend's TTS route returns MP3 audio, and the microphone starts only after question playback ends. Typed input remains available without speech configuration. This uses the Scribe and text-to-speech APIs, without an ElevenLabs Agents configuration.
- **Demo extraction** (`EXTRACTION_MODE=demo`, the default) is a limited phrase parser. It supports the documented fictional cases, not general medical language. Responses identify it as demo. To run beside Gemini: `EXTRACTION_MODE=demo PORT=3002 npm start`, then open port 3002. ElevenLabs voice still needs its key in demo extraction mode.

Gemini 429 messages show the configured model and distinguish daily quotas, short-term rate limits, and zero allowance when Google's structured error fields identify them. Provider retry delays are displayed when applicable. Unspecified errors remain explicitly unspecified; raw provider messages, project identifiers, and secrets are never shown. Diagnostics do not make additional API calls.

## Check-in contract

See [API.md](API.md) and `contracts/*.schema.json` for complete formats. The frontend sends a transcript, keeps the latest response, and submits follow-ups with the same session plus the latest version/question ID. All responses contain four arrays: symptoms, medications, diet, vitals. Unknown fields remain null; absent categories remain empty.

The additive nullable `wellness` object represents an explicit report such as “I feel fine today.” It makes a no-symptom check-in savable without inventing a symptom. Unrelated empty text still cannot save. Medication refusal is retained as a mention and description, not falsely classified as taken.

The main Version B client starts with `flow: "brief"` and `painScale: "1-10"`; both are start-only preferences. When symptoms are present, the server returns one shared `details` question. The screen names all symptoms and shows the optional note **Symptom? Location? Pain score (1–10)? Activities? Since when?** The spoken invitation is short and does not read the note aloud. One answer or skip ends the questions, even when some fields remain unknown. There are no separate activity-impact questions.

Symptom review uses compact tables, displays unknown values as **Not Provided**, and leaves their edit fields blank so they remain `null`. Non-pain scores use the same **Not Provided** placeholder. Users can correct/remove facts before **Confirm & Save**. Each symptom keeps its own ID and score. A standalone score such as “it's 2:00” is interpreted as 2/10 only in a known pain-score context, or a brief details question with exactly one pain symptom; “it started at 2:00 PM” remains timing. A bare score is not assigned arbitrarily between multiple symptoms. The backend also preserves explicitly supplied decimal scores rather than rounding them; the existing score buttons remain whole numbers.

Brief reports without symptoms go directly to review. If they contain food or water and no symptoms, medications, or vitals, the frontend automatically submits the save request and ends with “Food recorded,” “Water recorded,” or “Food and water recorded.” An accompanying wellness statement is allowed. Other records, including mixed symptom/food entries, retain editable review and explicit confirmation. This is frontend behavior: the API itself still requires a review state and `confirmed: true` to save.

Structured diet entries retain optional `waterGlasses` and `waterMode`. A water count with `waterMode: "add"` increments the slider; `"total"` replaces it. Zero and fractional counts are preserved, and the slider expands above 12 instead of clamping the reported count. Water without a stated glass count uses `waterGlasses: null`, `waterMode: "add"`: its words are recorded without changing the slider or creating a snack. No bottle/volume-to-glass conversion occurs. Food with an explicit breakfast/lunch/dinner time goes to that meal; unknown meal times go to Snacks in brief mode. Each saved session is applied once, so rendering or retrying cannot add its food/water again.

An exact repeated save request is idempotent. Keep one request in flight, retain data on errors, and do not blindly replay analyze requests after an uncertain network failure. A failed direct food/water save leaves a reviewable record for retry. Closing or pausing during an in-flight save permits data reconciliation but cannot restart audio or reopen the modal.

### Legacy flow when `flow` is omitted

Clients omitting `flow` retain the earlier behavior. Gemini proposes one relevant question or review alongside fact extraction in the **same request**. It uses the current record, exact previous question, prior answers, and asked/skipped targets. Questions stay within the reported health categories; the app does not survey unrelated categories. Wellness-only and meal-only reports can go directly to review, but these legacy clients do not receive the main frontend's brief-mode automatic food/water save.

The server validates every proposed target, rejects already answered/asked/skipped fields, and limits the flow to six follow-ups overall and three per item. It stores the exact accepted question for both the screen and ElevenLabs audio. Invalid proposals use a short deterministic fallback without discarding valid extracted facts. Unchecked topics are excluded from subsequent questions without using the visible question budget. Typed and spoken answers both receive contextual extraction/planning, including answers that supply several details at once.

Unknown values remain blank. Contextual answers that do not map to a structured field remain in `reportedAnswers` for review. Demo mode uses deterministic questions. In this legacy flow, `painScale: "1-10"` requests the numeric severity question; omitting it retains categorical severity questions. Questions collect information; this is not a diagnostic or clinical triage system. Gemini failures preserve the existing session and pause visibly. No new API key is needed; restart the backend after updating the code.

The opening is one short question, selected locally from six variations and held constant during pause/retry. The spoken prompt matches the displayed opening without a trailing category list or instructions. Both Gemini and demo mode omit daily-activity impact follow-ups (eating, getting dressed, walking, etc.); explicitly volunteered activity effects can still appear in the record.

Click **Start Daily Check-in** to begin the voice conversation, or **Type instead** for manual entry. Pause, resume, use buttons/typing, or review early using the displayed controls. Exact spoken “skip,” “pause,” and “finish check-in” commands are supported. The frontend sends each completed answer to the same session, and the backend enforces the selected brief or legacy policy. Provider failures pause the flow with the transcript retained; nothing is silently switched to mock interpretation.

## Phone or separate frontend

`localhost` on a phone refers to the phone. A native Expo app on the same trusted network needs the Mac's LAN address; set `HOST=0.0.0.0` and use `http://YOUR_MAC_LAN_IP:3001`. Find the address in System Settings → Wi-Fi → Details → TCP/IP. An Expo tunnel does not expose this separate API. Keep the Mac/server running.

Browser microphone capture requires localhost or HTTPS; plain HTTP to a LAN address may reach the API but cannot enable browser audio capture. A native app requires native audio capture rather than this browser AudioWorklet adapter. For another web origin, configure exact `CORS_ORIGINS`. CORS is not authentication.

## Files and checks

| File | Purpose |
| --- | --- |
| `src/schema.ts` | Records and request/response validation |
| `src/extractor.ts` | Gemini adapter and explicit demo parser |
| `src/gemini-schema.ts` | Provider-compatible JSON schema |
| `src/questions.ts` | Eligible fields, fallback wording, and targeted answers |
| `src/followups.ts` | Gemini question policy, validation, category boundaries, and limits |
| `src/checkins.ts` | In-memory sessions, review, save |
| `src/speech.ts` | Single-use ElevenLabs tokens |
| `src/tts.ts` | ElevenLabs question audio, timeouts, and safe errors |
| `src/app.ts` | API routes, static frontend/tester, CORS, error handling |
| `src/server.ts` | Server settings and startup |

```sh
npm run check
npm test
npm run schema
```

`npm run check` and all **203 automated tests** passed for the brief-flow update. Automated coverage includes one-answer completion, contextual numeric replies, independent pain scores, review corrections, exact food/water updates, direct-save failures, cancellation during save, legacy behavior, simulated speech/audio, VAD, and TTS. The four focused brief UI tests also passed after retaining reported trend/first occurrence/non-pain severity in the table. Offline browser checks verified “It's 2:00.” becoming 2/10 after the shared pain-details question, editable missing values, confirmed save, and direct food/water logging into Snacks with slider 3. No live provider API calls were made for this update. `npm run schema` regenerates machine-readable health contracts; speech response formats are documented separately in [API.md](API.md).

Historical verification, before the brief flow: synthetic ElevenLabs audio, Gemini wellness, separate arm/leg pain, and unnamed missed medication succeeded. An earlier browser Gemini check-in completed independent scores 7/3, the then-current impact/trend questions, review, and save. Earlier refusal and meals checks encountered provider busy/quota limits (503/429). These results do not verify the new brief interaction.

An earlier conversation update also passed a live Gemini wellness-to-review check, an ElevenLabs TTS check returning MP3 audio, and synthetic VAD transcription. Physical microphone capture and a complete live hands-free browser conversation remain unverified for the brief-flow update.

## Prototype limits

No authentication, database, wearable integration, diagnosis, treatment advice, or triage is implemented. Sessions expire after two hours of inactivity, with a maximum of 200; restarting the server clears all records. Saved means one Node process's memory. There is no history retrieval endpoint. Recent Check-ins displays records saved in the current page; refreshing clears that frontend history. Manual profile and Meals edits are also page-local. Use fictional data during development; this is not a public patient-record service.

## References

- [Google structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google Interactions API](https://ai.google.dev/api/interactions-api)
- [Zod JSON Schema](https://zod.dev/json-schema)
