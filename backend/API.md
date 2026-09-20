# API contract — version 1.0

Base URL during local development: `http://127.0.0.1:3001`.
Use `Content-Type: application/json` on every POST. Successful analyze/save responses have the same keys, validated by `contracts/response.schema.json`. All four health categories are always arrays; `wellness` is a nullable object. Speech-token responses are separate JSON, and spoken-question responses are audio, as described below.

## Authentication and profile status

**This document describes implemented check-in/speech routes. This baseline has no authenticated accounts or backend profiles.** Check-in UUIDs are not user authentication. All saved check-ins still use expiring process memory.

The [proposed authentication/profile contract](PROFILE-AUTH-CONTRACT.md) separately defines `GET /api/me`, `GET /api/me/profile`, and `PATCH /api/me/profile`, registration/login/logout integration, validation, null-vs-empty semantics, ownership, and persistence. Those routes currently return `404 NOT_FOUND`; the proposal must be agreed before implementation. Kimberly should use its mock adapter contract until real endpoints and user-isolation tests exist. Proposed profile versions are distinct from existing check-in versions.

## 0. Start speech transcription (optional)

POST `/api/speech/token` with `{}` returns `{ "token": "<single-use token>" }`. The backend requires `ELEVENLABS_API_KEY`; the provider key is never sent to the browser. Missing configuration returns `503 SPEECH_NOT_CONFIGURED`. Provider failures return `502` or `503 SPEECH_UNAVAILABLE`.

All app microphone paths request `language_code=en` and `include_language_detection=true`, without secondary languages, on the shared realtime connection. This applies to manual recording, automatic conversation turns, follow-ups, and Meals. The language request alone is a recognition hint, not a strict output guarantee. The app holds partial/plain committed text until the delayed `committed_transcript_with_timestamps` result arrives, then accepts English (`en`/`eng`) language metadata and Latin-script text. Explicit non-English metadata or non-Latin letters (including Cyrillic) stop the recording with a visible English retry message; missing language metadata for words or a metadata timeout also stops submission. Earlier verified words and typed drafts remain available. Language-neutral numbers such as `2:00` can be accepted from the enriched final result without a language label. Plain and enriched notifications count as one segment. If session configuration explicitly reports a non-English or unset language, startup fails visibly.

This does not translate other languages. Provider metadata is documented as detected or specified language, so it cannot prove every Latin-script phrase is English; the script guard specifically prevents the demonstrated Cyrillic failure even if metadata says English. See the [ElevenLabs realtime language parameters](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime) and [event sequence](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference). Refresh the app and start a new recording to load this browser-side setting; no backend restart or key change is needed for this setting alone.

The supplied browser module uses that token for `wss://api.elevenlabs.io/v1/speech-to-text/realtime`, model `scribe_v2_realtime`, and `audio_format=pcm_16000`. It streams mono 16 kHz PCM and displays only final segments that pass the language checks; partial words remain hidden until then. Daily Check-in conversation mode selects `commit_strategy=vad` with a two-second silence threshold; it sends each completed turn to `/api/analyze` only once, after recording stops and all pending committed segments pass language checks. Manual microphone controls retain manual commit and wait for the language-checked enriched final transcript. Each recording is limited to 30 seconds. Audio does not go to the health API; typed transcripts skip this endpoint entirely.

After assistant playback ends, capture starts as soon as the microphone is available. Audio captured during token/WebSocket startup is held in memory (up to 30 seconds of PCM) and sent in order only after a valid `session_started` acknowledgement. The app reports Listening only after the microphone has produced its first audio frame and the provider is ready. Silence is a valid frame: users do not need to speak to enable readiness. Cancellation or failed startup clears the buffer; an overflow fails visibly instead of dropping the start of the reply. The recording limit starts with capture, including connection time. Refresh the app to load this browser-side fix.

### Read a question aloud (optional)

POST `/api/speech/speak`:

```json
{ "text": "How severe is your knee pain, from one to ten?", "voice": "sarah" }
```

`voice` is optional: `default` (or omitted) uses the configured `ELEVENLABS_VOICE_ID`, with George as the code default. `sarah` selects Sarah (reassuring American female voice); `river` selects River (calm American neutral voice); `callum` selects Callum (husky trickster); `harry` selects Harry (fierce warrior). All five presets are English voices. Only these presets are accepted. Voice IDs and credentials are resolved on the backend.

The request accepts `text`, trimmed and limited to 1–1200 characters, and the optional `voice` preset. A successful response is **`200` with `Content-Type: audio/mpeg`**, containing MP3 bytes, not health-record JSON. Play it as audio and wait for playback to end before opening the microphone. Error responses retain the JSON error envelope documented below. Neither speech endpoint creates a health session or changes a record.

This route requires the same server-side `ELEVENLABS_API_KEY` with **Text to Speech** access. Optional settings are `ELEVENLABS_VOICE_ID` (default `JBFqnCBsd6RMkjVDRZzb`) and `ELEVENLABS_TTS_MODEL` (default `eleven_flash_v2_5`). The backend requests MP3 audio from ElevenLabs; private credentials never reach the frontend. Missing route configuration returns `503 VOICE_NOT_CONFIGURED`; unavailable provider audio returns `502` or `503 SPEECH_UNAVAILABLE`. Invalid JSON/request shape returns `400`. Restart the backend after adding this route or changing its environment settings.

The main frontend uses `flow: "brief"`: spoken opening → listen → analyze → one shared symptom-details invitation when symptoms exist → one answer → editable review. With no symptoms, it goes directly to review. Render and speak `nextQuestion.text` verbatim. The brief question has `field: "details"`, `category: "symptoms"`, `type: "text"`, and `options: []`. Its entity ID is one real symptom, but its invitation covers all included symptoms; do not interpret that ID as permission to assign every answer to the first symptom. The screen lists all symptom names and the optional note **Symptom? Location? Pain score (1–10)? Activities? Since when?** The note is not read aloud and does not create separate activity questions.

Clients omitting `flow` retain the legacy policy: Gemini proposes contextual questions alongside extraction, with at most six overall and three per item; demo mode uses deterministic questions. Both omit separate daily-activity impact questions, while accepting volunteered `functionalImpact` facts. Legacy `context` answers remain in `reportedAnswers`, not an invented record field. In either flow, `nextQuestion: null` with `status: "review"` can leave optional fields unknown.

Exact voice commands “skip,” “pause,” and “finish check-in” are handled by the conversation controller. An ordinary `action: "skip"` skips one question; in brief mode it ends the shared details invitation. Legacy topic selection can use `action: "skip", skipScope: "entity"` for the current question to omit that entity without consuming a visible question. Entity scope is valid only with a targeted skip. Final-review edits control which entities are saved.

The main brief frontend directly logs food/water-only responses, including an optional wellness statement, when symptoms, medications, and vitals are all empty. It calls the save endpoint with `confirmed: true`, updates Meals/water once, speaks one short recorded confirmation, and ends listening. Mixed health/food entries and other non-food records retain editable review and **Confirm & Save**. This automatic food/water behavior belongs to the frontend; `/api/analyze` itself does not save records.

## 1. Start a check-in

```js
const response = await fetch('http://127.0.0.1:3001/api/analyze', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    transcript: 'My knees hurt more today and I forgot my prednisone this morning.',
    flow: 'brief',
    painScale: '1-10'
  })
});
const state = await response.json();
if (!response.ok) throw new Error(state.error.message);
```

Illustrative response (IDs/timestamps are generated by the backend):

```json
{
  "schemaVersion": "1.0",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "version": 1,
  "status": "collecting",
  "extractionMode": "demo",
  "symptoms": [{
    "id": "22222222-2222-4222-8222-222222222222",
    "name": "knee pain",
    "location": "knees",
    "severity": null,
    "severityScore": null,
    "trend": "worse",
    "functionalImpact": null,
    "duration": null
  }],
  "medications": [{
    "id": "33333333-3333-4333-8333-333333333333",
    "name": "Prednisone",
    "description": null,
    "dose": null,
    "status": "missed",
    "time": "morning"
  }],
  "diet": [],
  "vitals": [],
  "wellness": null,
  "missingFields": ["symptoms[0].severity", "symptoms[0].firstOccurrence", "symptoms[0].duration"],
  "skippedFields": [],
  "needsClarification": false,
  "nextQuestion": {
    "id": "22222222-2222-4222-8222-222222222222:details",
    "category": "symptoms",
    "entityId": "22222222-2222-4222-8222-222222222222",
    "field": "details",
    "text": "What else would you like to share about your symptoms?",
    "type": "text",
    "options": []
  },
  "notices": ["Demo extraction uses limited phrase rules, not AI. It can miss details. Use fictional data and review every field."],
  "storage": "memory",
  "expiresAt": "2026-09-18T20:00:00.000Z",
  "savedAt": null
}
```

The invitation's wording varies. The note helps the user decide which additional details to share; known facts such as “knees” remain in the record. Missing-field paths describe unknown values, not a required queue: brief mode ends after the one answer or skip. Use stable item IDs for rendering keys and question IDs for answers; array indexes are only display paths.

The main Version B client sends both `flow: "brief"` and `painScale: "1-10"` only when starting. Sending either again on an existing session is invalid. The brief policy applies in Gemini and demo modes. Omitting `flow` retains the legacy question sequence; in that sequence, `painScale: "1-10"` requests numeric severity options `"1"` through `"10"` even if a categorical severity was reported. Omitting both preferences retains legacy categorical severity questions.

## 2. Answer, skip, add information, or finish

Use the **latest** response in place of `state` and replace it with every new response. Send one action per request.

Button/form answer:

```js
const body = {
  sessionId: state.sessionId,
  version: state.version,
  answer: { questionId: state.nextQuestion.id, value: 'Left knee, four out of ten, since yesterday.' }
};
```

Voice answer to the current question:

```js
const body = {
  sessionId: state.sessionId,
  version: state.version,
  questionId: state.nextQuestion.id,
  transcript: 'Left knee, four out of ten, since yesterday.'
};
```

A brief reply can supply several facts for one or several symptoms. It ends the details turn even when partial or unconfirmed, and the exact words remain in `reportedAnswers`. A targeted short pain score such as `"2"`, `"two"`, or speech-rendered `"it's 2:00"` can be applied without a model call. Clock-style interpretation is allowed only for a severity question, or a brief details question about exactly one pain symptom. Actual timing such as `"it started at 2:00 PM"`, nonzero clock minutes, and ambiguous multi-symptom numbers are not converted to scores. Explicit decimal scores within the pain scale are preserved without rounding; this is a backend parsing option, not a change to the whole-number score buttons.

To add a new observation through the API, send `{ sessionId, version, transcript }` **without** `questionId`. The backend does not assume an untagged short answer belongs to the current question. This does not grant a second details question once the brief question budget has been used.

Skip a question:

```js
const body = {
  sessionId: state.sessionId,
  version: state.version,
  action: 'skip',
  questionId: state.nextQuestion.id
};
```

“I'm not sure,” “I don't know” and “prefer not to say” as targeted answers also skip. Unknown facts stay `null`. For a legacy question targeting an actual missing field, its path appears in `missingFields` and `skippedFields`. The brief `details` invitation is not a health-record field, so skipping it does not invent a `.details` property or field path.

Finish early and show review:

```js
const body = { sessionId: state.sessionId, version: state.version, action: 'review' };
```

`action: 'resume'` can restore an unanswered question after an early review. It does not repeat answered/skipped questions or reset the brief one-question budget. Users can fill unknown details at review. `nextQuestion` is `null` in review and saved states. **That is not proof the record is complete or medically safe.**

In the legacy flow, an unnamed-pill report can produce `name: null`, `needsClarification: true`, and a text question with `options: []`. Show a text/voice input and Skip button; no medication list is invented. In brief mode, medication-only reports go directly to editable review, with identity still unknown.

A typed medication-name guess such as “Maybe prednisone” cannot establish identity. Legacy direct-answer validation may return `422 INVALID_ANSWER`; Gemini free-text extraction can retain the uncertainty and leave `name: null`.

## 3. Save a reviewed record

The API always requires `status: "review"` and `confirmed: true`. The main UI obtains explicit confirmation for symptom, medication, vital, wellness-only, and mixed entries. For authorized direct food/water logging in brief mode, it submits this same request automatically after analysis reaches review; an accompanying wellness statement is permitted.

POST `/api/checkin/save`:

```js
const body = {
  sessionId: state.sessionId,
  version: state.version,
  confirmed: true
};
```

An optional `record` contains **all four complete arrays and nullable wellness**, after the user's edits:

```js
const body = {
  sessionId: state.sessionId,
  version: state.version,
  confirmed: true,
  record: {
    symptoms: editedSymptoms,
    medications: editedMedications,
    diet: editedDiet,
    vitals: editedVitals,
    wellness: editedWellness // null, or { status: 'well' | 'normal', statement: 'reported words' }
  }
};
```

Keep existing item UUIDs when editing. Generate a unique UUID for any newly added item. Include every required schema field, with `null` for unknown values; optional additive fields can be omitted. You may remove mistakenly extracted items or clear fields to `null`. The brief UI displays **Not Provided** but keeps the edit value blank, never saving that placeholder as a fact. See `contracts/record.schema.json`.

The response has `status: "saved"`, `savedAt`, a new version, and the saved record. It does not add a separate `success` key: check the HTTP status and `status`. The response still reports missing details. Empty arrays with explicit wellness can save; empty arrays and `wellness: null` cannot. Saved sessions cannot be modified. An exact repeated save request returns the same saved response.

## Record fields

| Category | Fields on each item, in addition to UUID `id` |
| --- | --- |
| symptoms | `name`, `location`, `severity` (mild/moderate/severe/null), `severityScore` (0–10/null in the backward-compatible record schema; current pain prompts use 1–10), `trend` (better/same/worse/null), `functionalImpact`, `duration`, optional `firstOccurrence` (boolean/null) |
| medications | `name`, `description`, `dose`, `status` (taken/missed/stopped/mentioned/null), `time` |
| diet | `description`, `time`, optional `waterGlasses` (number 0–100/null), optional `waterMode` (add/total/null) |
| vitals | `name`, `value`, `unit`, `time` |

Names are required for symptoms/vitals; diet description is required. Other text fields are nullable. Vital values are strings to preserve readings such as `120/80`. Units and doses are never assumed. This API does not classify any reading as healthy or dangerous. Numeric severity is not converted into mild/moderate/severe.

`wellness` is null unless explicitly reported. For “I feel fine today,” it may be `{ "status": "well", "statement": "I feel fine today" }`; explicitly feeling normal uses `status: "normal"`. It has no item ID. Legacy records omitting it default to null, but new edited saves should include it to preserve the reported statement. It is never inferred from an empty symptom list.

“I don't want to take my medicine” reports intent, not a taken dose: the medication uses `status: "mentioned"` with the reported wording in `description`. `refused` and `not_taken` are not accepted status enum values. Separate body locations retain separate symptom IDs; each explicitly stated meal is a separate diet entry with its stated time.

Water is a separate diet entry from food. `waterMode: "add"` means an additional amount; `"total"` means the reported daily total. The frontend increments or replaces the water count accordingly, preserves zero/fractions, expands the slider above 12, and applies each saved session only once. Unknown glass quantities use `waterGlasses: null`, `waterMode: "add"`; the original words are kept without changing the slider. Never convert bottles, milliliters, or other units into glasses. Non-water entries omit both water fields or set them null. Example:

```json
{ "id": "44444444-4444-4444-8444-444444444444", "description": "two more glasses of water", "time": null, "waterGlasses": 2, "waterMode": "add" }
```

Meal grouping is a frontend presentation rule: known breakfast/lunch/dinner times go to that meal, while unknown times go to Snacks in brief mode. The reported `time` stays null when unknown. Water is never grouped as a snack. Legacy clients may retain their Unspecified meal group.

## Errors

Errors use `{ "error": { "code": "...", "message": "...", "details": [] } }`.

| HTTP status | Meaning |
| --- | --- |
| 400 | Invalid JSON, missing fields, wrong schema, or missing confirmation |
| 403 | Browser origin not in backend CORS settings |
| 404 | Session absent/expired, server restarted, or wrong endpoint |
| 409 | Outdated version/question, overlapping request, already saved, or review required |
| 413 / 415 | Body too large / wrong Content-Type |
| 422 | Invalid answer, duplicate item IDs, or empty save |
| 502 | Extraction/speech provider failed, invalid output, or unknown entity reference; existing health session unchanged |
| 503 | Session capacity reached, speech unconfigured, or speech service unavailable |

On failed requests, retain the last successful response. A `409` means stop submitting against stale state. Keep one request in flight per session. This MVP has no session-retrieval endpoint: if a successful analyze response is lost over the network, start a new check-in from the transcript rather than retrying indefinitely with a stale version.

All records use temporary process memory with a two-hour inactivity expiry. Server restart clears them. The speech endpoints do not create or authenticate a health session.
