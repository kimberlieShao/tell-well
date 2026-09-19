# Kimberly — onboarding/profile handoff

The current integrated frontend/backend baseline is pushed:

- Branch: [`codex/checkpoint-voice-checkin-2026-09-19`](https://github.com/aanya-k/HopHacks/tree/codex/checkpoint-voice-checkin-2026-09-19)
- Commit: [`5a7fd55`](https://github.com/aanya-k/HopHacks/commit/5a7fd557dbe30dadcad8ff9c3f8d584fb7b397d8)
- This contract proposal: `codex/gemini-profile-api`; use this branch's latest commit for these documents. It descends from that checkpoint and changes documentation only.

The baseline preserves Version B's UI and contains ElevenLabs Scribe transcription and spoken questions, Gemini structured extraction, multi-step check-ins, 1–10 pain follow-ups, editable review, confirmed saving, microphone handoff improvements, and provider error handling. It is a checkpoint, not a finished production release.

## What you can build now

Build onboarding/profile screens as isolated modules and a clearly labeled mock `loadProfile()` / `saveProfile({ profileVersion, profile })` adapter. Use [PROFILE-AUTH-CONTRACT.md](PROFILE-AUTH-CONTRACT.md) for the exact response envelopes, fields, validation, PATCH behavior, error cases, and future authentication design. It is a **proposal for agreement**, not a claim that the routes exist.

The backend currently has no login, persistent profiles, onboarding flag, or authenticated record ownership. Profile/medication edits in the existing UI are page-local. A check-in session is not an account. The proposal recommends Supabase Auth + Postgres for profiles, self-only first release, and owner checks for existing temporary check-ins. Please agree on those decisions before connecting the adapter.

Keep `userProfile` separate from `checkinState`; existing prescriptions and conditions are not today's dose events or symptoms. Optional health questions may be skipped: null is unanswered, [] means explicitly none. Age and accessibility are separate attributes, not patient types.

Please keep your modules separate from root `index.html` and `frontend/new-ui.js`. We will coordinate the shared login → onboarding → Home wiring after the contract and real APIs are ready. Do not replace the current integrated UI with an older full-file version.

## Local baseline startup and tests

From your checkout, using Node.js 24 or newer:

```sh
cd backend
npm ci
# New checkout only, if you do not already have a .env file:
cp -n .env.example .env
npm start
```

Open `http://127.0.0.1:3001/app`; the text-only backend tester is `/test/`. Keep the server terminal running. If port 3001 is in use, use its existing terminal or stop that server before restarting. After changing `.env`, restart with Control+C then `npm start`.

Current environment names: `HOST`, `PORT`, `CORS_ORIGINS`, `EXTRACTION_MODE`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ELEVENLABS_API_KEY`, and optional `ELEVENLABS_VOICE_ID` / `ELEVENLABS_TTS_MODEL`. Values belong in your own ignored `.env`, never shared. `EXTRACTION_MODE=demo` supports limited fictional typed examples without a Gemini key; voice still requires ElevenLabs. For the tested real Gemini configuration, set `EXTRACTION_MODE=gemini` and `GEMINI_MODEL=gemini-3.6-flash` with your own authorized key.

Proposed Supabase names and setup are documented in the contract; the current backend does not read them. No additional service has been provisioned.

```sh
# From backend; these tests use simulated providers, not paid API calls:
npm run check
npm test
```

## Verification and remaining work

- Checkpoint verification: TypeScript passed; **127 automated tests passed**. That includes simulated full voice/check-in flows and microphone handoff regressions, not live user-account isolation.
- Earlier Gemini verification: `gemini-3.6-flash` returned HTTP 200 and a valid structured wellness record. The user reports the model switch resolved their Gemini error; no new Gemini diagnosis was performed for this task.
- Earlier ElevenLabs checks verified a TTS MP3 response and synthetic-audio transcription. The user's physical microphone/browser flow still needs a fresh manual check after the handoff fix.
- Current saved check-ins expire after two hours of inactivity or a server restart. Manual Meals/profile/history state is not durable. Do not advertise cloud account storage yet.
- Authentication/profile endpoints, database policies, migrations, login wiring, and cross-user isolation tests are **not implemented**. The contract lists the required acceptance checks. Onboarding/profile development does not require Gemini to be available.

No keys or `.env` files are included; `.env.example` contains only blank key fields and nonsecret configuration. Nothing in this handoff merges into `main`.
