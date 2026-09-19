# Version B frontend integration

The root `index.html` is the newer UI supplied as `index-2.html`. Its Home, Meals, Trends, More, check-in screens, and 1–10 pain controls remain the final interface. Its local mock health parser is not active.

Work branch: `codex/connect-new-ui`. The earlier committed implementation is preserved on `codex/backup-before-new-ui-c222f48` at commit `c222f48`.

## Run

```sh
cd "/Users/toan/HopHacks 2026/HopHacks/backend"
npm install
npm start
```

Open **http://127.0.0.1:3001/app** and keep the terminal running. Control+C stops it. Open the page through this server, not by double-clicking HTML or through Live Server. The text-only API tester remains at `/test/`.

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
| `frontend/pcm-worklet.js` | Mono 16 kHz PCM audio capture, limited to 30 seconds |
| `frontend/integration.css` | API status, errors, and editable review styles |
| `backend/src/speech.ts` | Private ElevenLabs key → single-use Scribe token |

The old `checkin-controller.js`, `speech.js`, and `checkin.css` remain reference/test files; `main.js` does not load them. Version A used browser speech recognition. Real ElevenLabs integration was added during this merge.

```text
Version B microphone → ElevenLabs Scribe → editable transcript
→ /api/analyze → Gemini (or explicitly selected demo extraction)
→ normalizeBackendResponse → checkinState → Version B screens
→ answers in the same session → editable review → /api/checkin/save
```

Done stops capture and waits for a final committed transcript before analysis. Closing/leaving the flow cancels capture. Clips are limited to 30 seconds; typed input remains available. The existing read-prompt control uses browser speech synthesis, not ElevenLabs text-to-speech.

Daily Check-in starts with `painScale: "1-10"`. Each symptom keeps its own ID/score, and a category such as “mild” does not suppress the numeric pain question. Explicit “I feel fine today” produces `wellness`, not a fake symptom. See [backend/API.md](backend/API.md).

## Keys and storage

Keep both provider keys in `backend/.env`; `.env.example` contains placeholders. The browser gets a single-use speech token, never an ElevenLabs or Gemini key. Audio goes directly to ElevenLabs. The health backend and Gemini receive transcript text and check-in context.

Saved records live in one server process's memory. Sessions expire after two hours of inactivity; restarting the backend clears everything. Recent Check-ins displays records saved in the current page; refreshing clears that frontend state. Manual profile/Meals controls remain page-local. This branch has no database, accounts, history retrieval, or wearable connection.

## Future HTML updates

Preserve these includes:

```html
<link rel="stylesheet" href="/frontend/integration.css">
<script type="module" src="/frontend/main.js"></script>
```

Keep the full Version B structure and DOM hooks used by `new-ui.js`: navigation/Meals IDs, `dailyCheckinButton`, `checkinFlow`, `flowIntroMic`, `flowType`, `flowTranscript`, `.flow-done`, `editTopics`, pain/impact controls, review containers, `reviewConfirmSave`, and the `data-screen` sections. This is not an exhaustive replacement HTML skeleton. If IDs or screens change, update the controller and integration tests together.

Do not load the old controller alongside Version B or restore its inline mock parser. Continue routing API responses through `normalizeBackendResponse()` into central state and edited records through `toBackendRecord()`.

## Verification

TypeScript checking and all 68 automated tests passed at completion of this merge. Run `npm run check` and `npm test` inside `backend`. Tests cover extraction cases, actual Version B events against a local API, per-symptom scores, review edits, failed saves, microphone cleanup, and simulated audio/WebSockets.

Live checks verified ElevenLabs with synthetic audio, plus Gemini wellness, separate arm/leg pain, and unnamed missed medication. The actual browser Gemini flow completed scores 7/3, impact/trend follow-ups, review, and save. Live refusal and meals checks hit provider busy/quota limits (503/429), so not all live cases passed. A physical microphone still needs a manual check in a supported browser on localhost or HTTPS.
