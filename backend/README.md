# Pulsewise backend and connected frontend

This server runs Version B at `/app`, Gemini health extraction, check-in sessions, and an ElevenLabs speech-token endpoint. See [FRONTEND-INTEGRATION.md](../FRONTEND-INTEGRATION.md) for the UI files and [HANDOFF.md](HANDOFF.md) for teammate integration.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/analyze` | Extract transcript details, update session, return the next question |
| `POST /api/checkin/save` | Validate and save a user-confirmed record in memory |
| `POST /api/speech/token` | Return a single-use ElevenLabs Scribe Realtime token |

## Start locally

Node.js 24 or newer is required. In a terminal:

```sh
cd "/Users/toan/HopHacks 2026/HopHacks/backend"
npm install
npm start
```

For a different clone, use its backend folder. `npm install` downloads dependencies; `npm start` runs the server. Keep the terminal open; Control+C stops it. `npm run dev` restarts automatically while editing.

Open **http://127.0.0.1:3001/app** for the connected UI, or **http://127.0.0.1:3001/test/** for the text-only API tester. Do not open root HTML as a local file. `npm run demo` in a second terminal exercises a fictional transcript/answer/save flow against the running server.

## Provider configuration

For a new setup only, copy `.env.example` to `.env`; do not overwrite an existing configured `.env`. Set keys locally:

```dotenv
EXTRACTION_MODE=gemini
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-3.8-flash
ELEVENLABS_API_KEY=your_elevenlabs_key
```

Both keys stay server-side and out of Git. Never put them in frontend JavaScript or Expo `EXPO_PUBLIC_*` variables. Restart after changing settings. Set `GEMINI_MODEL` to a compatible model available to your account.

- **Gemini** receives completed transcript text, the current record, and question. It extracts structured facts; the server validates them and chooses rule-based questions. It uses the Interactions API with `store: false`. This disables interaction retrieval through that API, not all provider data processing. Failure does not trigger an automatic demo fallback or modify an existing session.
- **ElevenLabs** transcribes browser microphone audio. The server exchanges its key for a single-use token; the browser streams mono 16 kHz PCM directly to Scribe v2 Realtime. Each clip is limited to 30 seconds, and Done waits for a final committed transcript. Typed input remains available without speech configuration. This is speech-to-text, not an ElevenLabs conversational agent or text-to-speech implementation.
- **Demo extraction** (`EXTRACTION_MODE=demo`, the default) is a limited phrase parser. It supports the documented fictional cases, not general medical language. Responses identify it as demo. To run beside Gemini: `EXTRACTION_MODE=demo PORT=3002 npm start`, then open port 3002. ElevenLabs voice still needs its key in demo extraction mode.

## Check-in contract

See [API.md](API.md) and `contracts/*.schema.json` for complete formats. The frontend sends a transcript, keeps the latest response, and submits follow-ups with the same session plus the latest version/question ID. All responses contain four arrays: symptoms, medications, diet, vitals. Unknown fields remain null; absent categories remain empty.

The additive nullable `wellness` object represents an explicit report such as “I feel fine today.” It makes a no-symptom check-in savable without inventing a symptom. Unrelated empty text still cannot save. Medication refusal is retained as a mention and description, not falsely classified as taken.

Version B starts with `painScale: "1-10"`. Pain lacking a numeric score triggers its existing 1–10 screen even if a category such as mild was stated. The preference persists for the session; old clients omitting it retain categorical questions. Each symptom has its own ID and score.

Review may finish early. Users can correct/remove facts before Confirm; saved records retain missing-field notices. An exact repeated save request is idempotent. Keep one request in flight, retain data on errors, and do not blindly replay analyze requests after an uncertain network failure.

## Phone or separate frontend

`localhost` on a phone refers to the phone. A native Expo app on the same trusted network needs the Mac's LAN address; set `HOST=0.0.0.0` and use `http://YOUR_MAC_LAN_IP:3001`. Find the address in System Settings → Wi-Fi → Details → TCP/IP. An Expo tunnel does not expose this separate API. Keep the Mac/server running.

Browser microphone capture requires localhost or HTTPS; plain HTTP to a LAN address may reach the API but cannot enable browser audio capture. A native app requires native audio capture rather than this browser AudioWorklet adapter. For another web origin, configure exact `CORS_ORIGINS`. CORS is not authentication.

## Files and checks

| File | Purpose |
| --- | --- |
| `src/schema.ts` | Records and request/response validation |
| `src/extractor.ts` | Gemini adapter and explicit demo parser |
| `src/gemini-schema.ts` | Provider-compatible JSON schema |
| `src/questions.ts` | Deterministic questions and targeted answers |
| `src/checkins.ts` | In-memory sessions, review, save |
| `src/speech.ts` | Single-use ElevenLabs tokens |
| `src/app.ts` | API routes, static frontend/tester, CORS, error handling |
| `src/server.ts` | Server settings and startup |

```sh
npm run check
npm test
npm run schema
```

At completion of this merge, TypeScript checking and all 68 automated tests passed. Tests include the requested extraction cases, Version B events, independent pain scores, review corrections, API failures, and simulated speech/audio behavior. `npm run schema` regenerates machine-readable contracts.

Live verification succeeded for synthetic ElevenLabs audio, Gemini wellness, separate arm/leg pain, and unnamed missed medication. An actual browser Gemini check-in completed independent scores 7/3, impact/trend questions, review, and save. Live refusal and meals checks encountered provider busy/quota limits (503/429); their deterministic cases passed automated tests. Physical microphone capture still needs a manual browser check.

## Prototype limits

No authentication, database, wearable integration, diagnosis, treatment advice, or triage is implemented. Sessions expire after two hours of inactivity, with a maximum of 200; restarting the server clears all records. Saved means one Node process's memory. There is no history retrieval endpoint. Recent Check-ins displays records saved in the current page; refreshing clears that frontend history. Manual profile and Meals edits are also page-local. Use fictional data during development; this is not a public patient-record service.

## References

- [Google structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google Interactions API](https://ai.google.dev/api/interactions-api)
- [Zod JSON Schema](https://zod.dev/json-schema)
