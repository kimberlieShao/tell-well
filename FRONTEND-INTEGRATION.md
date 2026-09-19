# Frontend + backend connection

From the VS Code terminal, start the backend:

```sh
cd "/Users/toan/HopHacks 2026/HopHacks/backend"
npm install
npm start
```

Open **http://127.0.0.1:3001/app** and keep the terminal running. The backend serves the page and API together, so do not double-click `index.html` or use Live Server for this version. The text-only API tester remains at `/test/`.

To test the connection without Google availability or quota, run this in a second terminal from the same backend folder:

```sh
EXTRACTION_MODE=demo PORT=3002 npm start
```

Then open **http://127.0.0.1:3002/app**. This uses a limited example parser and is clearly labeled Demo; it does not change `.env` or replace the Gemini server on port 3001. Stop either server with Control+C in its terminal.

Try this fictional example: “My knees hurt more today and I forgot my prednisone this morning.” Answer the follow-ups, finish and review, edit or remove incorrect details, then confirm and save. Your saved check-ins appear in the current page's journal and can be exported as text or printed. Other dashboard measurements and device panels are labeled sample designs.

## Connection files

| File | Responsibility |
| --- | --- |
| `index.html` | Teammate's layout and visual styles |
| `frontend/main.js` | Starts the controller |
| `frontend/checkin-controller.js` | Questions, editable review, save, and current-page journal |
| `frontend/checkin-api.js` | Requests, session ID/version, errors, one request at a time |
| `frontend/speech.js` | Optional browser speech, final transcripts, microphone cleanup |
| `frontend/checkin.css` | Styles for connected controls |
| `backend/src/app.ts` | Serves `/app`, `/frontend/*`, `/test/`, and the two APIs |

The original demo's inline script has been removed. It no longer independently advances mock questions or shows a simulated save.

## When your new index.html arrives

Keep the `frontend` folder and backend. Preserve these elements in the new HTML:

```html
<!-- In <head> -->
<link rel="stylesheet" href="/frontend/checkin.css">

<!-- Start button -->
<button id="dailyCheckinButton">Start Daily Check-in</button>

<!-- Modal populated by the controller -->
<section class="flow-overlay" id="checkinFlow"
  aria-label="Check-in" aria-modal="true" role="dialog"></section>

<!-- Before </body> -->
<script type="module" src="/frontend/main.js"></script>
```

The controller uses the current `.flow-*`, `.transcript`, and `.review-*` styles plus `frontend/checkin.css`. A different design may need styles or controller markup adapted. Do not reintroduce the old inline demo script: it would compete with the API flow. Keep new JavaScript in external files; the page blocks inline scripts and `onclick` attributes.

Optional dashboard IDs: `checkinNav`, `micButton`, `confirmCheckin`, `journalStartButton` launch the dialog; `transcript` supplies initial text; `understoodList`, `logRows`, `symptomChart`, `emptyLog`, `printButton`, and `exportButton` show or export saved check-ins.

## Voice teammate handoff

The current Speak button uses browser speech recognition when supported. **It does not call ElevenLabs.** Your teammate can replace `frontend/speech.js` while keeping the API connection. Its adapter exposes `available`, `isActive`, `mode` (`spoken` or `form`), `start()`, `finish()` (waits for final transcription), `cancel()`, and `destroy()`. Status callbacks receive `{type, message}`.

Her separate interface can also import `createCheckinClient` from `frontend/checkin-api.js`: call `start(finalTranscript)`, then `answer(finalTranscript, {spoken: true})` for spoken follow-ups. Typed field answers and buttons use `answer(value)`. Call `review()` before `save(editedRecord)`. The client attaches session, version and question IDs. Preserve all four record arrays and item IDs. Full schemas are in `backend/API.md`. Keep API keys in server `.env`, never browser JavaScript.

## Checks and limits

Run `npm run check` and `npm test` inside `backend`. Tests exercise the actual controller against a demo HTTP backend and a simulated speech recognizer; they do not test a physical microphone or ElevenLabs.

The server uses your existing extraction setting in `.env`. Demo mode is a limited parser; Gemini mode uses your configured provider. Sessions expire after two hours of inactivity; restarting the backend clears all records. Refreshing the page clears its journal and session reference. No database, authentication, wearable integration, or persistent history was added. Stale sessions and uncertain network failures preserve visible details and require a new check-in instead of blindly replaying updates.
