# Pulsewise check-in backend

This is the health-analysis API for the voice teammate to connect to. She owns the voice backend and interface; her system sends **completed transcript text** to this backend and receives a structured health record and one follow-up question. Start with **[HANDOFF.md](HANDOFF.md)** for the ownership split and connection steps.

The check-in flow uses two API routes:

| Route | Purpose |
| --- | --- |
| `POST /api/analyze` | Start/update a check-in, extract details, ask the next question |
| `POST /api/checkin/save` | Save the user-confirmed record in server memory |

## Run it

Node.js 24 or newer is required. Node.js runs the backend code; the terminal is where you type these commands. Open **Terminal** on your Mac, then paste:

```sh
cd "/Users/toan/HopHacks 2026/HopHacks/backend"
npm install
npm start
```

`npm install` downloads this folder's dependencies. You normally only need it after first downloading the project or changing dependencies. `npm start` starts the API. Keep that terminal open. Stop it with **Control+C**.

If you received the review ZIP, open its extracted `pulsewise-backend` folder in a terminal instead of using Toan's path above. Run `npm install` and `npm start` there. It starts in demo mode without keys. For Gemini, first copy `.env.example` to `.env` and set your own key and `EXTRACTION_MODE=gemini` as described below.

The API runs at `http://127.0.0.1:3001`. Open **http://127.0.0.1:3001/app** for the connected frontend. See **[FRONTEND-INTEGRATION.md](../FRONTEND-INTEGRATION.md)** for the connection files and later HTML updates. Open **http://127.0.0.1:3001/test/** in your browser to try the text-only backend tester. Type a fictional transcript, analyze it, answer the follow-up questions, then review and save. The page sends the same POST requests your teammate's voice backend will send. Expand its request/response details to see what went in and what came back. Voice recording remains your teammate's responsibility.

Open a **second terminal** to run the fictional end-to-end example:

```sh
cd "/Users/toan/HopHacks 2026/HopHacks/backend"
npm run demo
```

It sends the knee-pain transcript, answers two questions, and saves the reviewed example. For automatic restart while editing, use `npm run dev` instead of `npm start`.

## Important: two extraction modes

The default `demo` mode works without an API key. It is a limited phrase parser for integration testing, **not an AI medical interpreter**. Every response says `extractionMode: "demo"` and includes a notice. It recognizes example phrases about knee/wrist/hand/ankle/back/joint/shoulder/hip pain, headache, fatigue, nausea, a small set of medication names, simple diet notes and some explicitly stated vital readings. It will miss more complex language. Unsupported or uncertain text may produce an empty record. Keep the original transcript visible in the frontend for review.

To enable real AI extraction, copy `.env.example` to `.env`, change the mode, and enter your Gemini key **in that local file**:

```dotenv
EXTRACTION_MODE=gemini
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.8-flash
```

The example model follows the currently published Google API examples; set `GEMINI_MODEL` to a structured-output model available to your account. Restart the API after changing `.env`. Gemini receives the transcript, current record and question. Use fictional examples during development. The key stays on the server, is ignored by Git, and must never go into the mobile app or an `EXPO_PUBLIC_*` variable. Codex writes code; it is separate from this runtime extraction service.

The Gemini adapter uses Google's Interactions API and has been verified with a live fictional check-in. It sends `store: false` to disable later retrieval of that interaction through Google's API; this does not override Google's broader data-use policies. It validates returned JSON and rejects failed, incomplete, or malformed responses without changing the session. It never silently falls back to demo mode. Structured output cannot guarantee medical accuracy; users review and correct extracted facts before saving.

The provider receives a simplified JSON schema because its constrained output decoder rejects the combined array size limits in the complete schema. The backend still enforces every field, enum, UUID, text length and 20-item limit before accepting a response.

## Connect your partner's frontend

Start with **[HANDOFF.md](HANDOFF.md)**. Your teammate's voice backend calls your health API once it has a transcript. This backend needs only the Gemini key for AI extraction. Your teammate's voice system manages its own ElevenLabs integration.

Read **[API.md](API.md)** for the exact request/response contract. **[examples/mobile-client.ts](examples/mobile-client.ts)** includes fetch helpers. Its type-only imports refer to this repo; adapt the import path if moving it into a separate Expo project, or use the plain `fetch` example in API.md.

1. When ElevenLabs commits a complete transcript, call `/api/analyze` with `{ transcript }`. Do not submit every interim transcription fragment.
2. Store the entire latest response in frontend state.
3. Render/speak `nextQuestion.text`. Show its options when present, with a separate Skip button.
4. For each answer, return the latest `sessionId`, `version` and `nextQuestion.id`.
5. When `status` is `review`, show the four arrays and missing/uncertain details for edits. A “Finish and review” button may request review at any time.
6. On the user's Confirm button, call `/api/checkin/save` with `confirmed: true` and optionally their edited record.

Disable the submit button while a request is pending. Keep the previous state if the API returns an error. Do not blindly retry analyze requests with an old version. The save request is safe to retry with exactly the same body.

### Phone connection

`localhost` on a physical phone means **the phone**, not this Mac. To test Expo on a phone over the same trusted Wi-Fi network, set `HOST=0.0.0.0` in `.env`, restart, and use `http://YOUR_MAC_LAN_IP:3001` in the mobile app. Find the Mac's IP under System Settings → Wi-Fi → Details → TCP/IP. An Expo frontend tunnel does not automatically expose this separate API. Another teammate's computer also needs that LAN address; your Mac must stay running.

For Expo web, set `CORS_ORIGINS` to its exact origin (for example `http://localhost:8081`). The integrated HTML demo should be opened at `/app` on this backend, rather than through Live Server or a `file://` page. CORS controls browser origins; it is not authentication.

## Files and checks

| File | What it does |
| --- | --- |
| `src/schema.ts` | Fixed records, allowed fields, request/response validation |
| `src/extractor.ts` | Demo parser and Gemini structured extraction adapter |
| `src/gemini-schema.ts` | Provider-compatible schema; full validation remains on the server |
| `src/questions.ts` | Deterministic follow-up wording, missing-field rules, short answers |
| `src/checkins.ts` | Session Map, safe updates, review, confirmation and save |
| `src/app.ts` | The two check-in API routes, text tester, JSON errors and CORS |
| `src/server.ts` | Starts the server and reads settings |
| `contracts/*.schema.json` | Machine-readable schemas to share with the frontend |

```sh
npm run check
npm test
npm run schema
```

Tests cover the full check-in, unclear medication names, multiple symptoms, skipped questions, review edits, session isolation/expiry, stale/concurrent requests, invalid input, CORS and provider failures. `npm run schema` regenerates the contract files after schema changes.

## MVP limits

This is a local hackathon prototype with no authentication or database. Use fictional data for development; it is not ready for real patient records or public deployment. Sessions expire after two hours without activity (expired entries are removed on the next request); all records disappear on restart. “Saved” means saved in that single Node process's memory. Return the saved record to the frontend if it needs to display it afterward. There is no history/list endpoint, diagnosis, treatment advice, triage, wearable connection, or voice processing in this backend. Your teammate's voice system will connect to these two health endpoints.

Unknown fields remain `null`; absent categories stay `[]`. Missing optional categories do not trigger a questionnaire. Symptom duration and medication dose are recorded when stated but not automatically demanded. Follow-ups collect basic symptom context, unnamed medications, unclear medication status, and missing vital values/units. A skipped field remains visibly missing. Text updates merge non-null facts; clearing a field or removing a mistaken entity is done through the editable final review.

## Implementation references

- [Google: structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google: Interactions API](https://ai.google.dev/api/interactions-api)
- [Zod: JSON Schema generation](https://zod.dev/json-schema)
- [Express: installation](https://expressjs.com/en/starter/installing/)
