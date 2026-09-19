# Start here: compare the two backends

This package implements **health analysis and check-in state**. The teammate's separate voice backend and interface are still her responsibility.

## Main files to compare

| File | Responsibility |
| --- | --- |
| `src/app.ts` | HTTP routes, validation, JSON errors and CORS |
| `src/schema.ts` | Exact request and response fields/types |
| `src/extractor.ts` | Transcript → Gemini → validated health facts |
| `src/checkins.ts` | Merge facts, maintain sessions, review and save |
| `src/questions.ts` | Missing-field detection and deterministic questions |
| `API.md` | Requests her voice backend should send and responses it receives |
| `HANDOFF.md` | Ownership split and integration steps |

Required routes: `POST /api/analyze` and `POST /api/checkin/save`.

The current contract uses four arrays: `symptoms`, `medications`, `diet`, `vitals`. Numeric symptom severity is `severityScore`; activity impact is a nullable string `functionalImpact`; duration is `duration`. Unknown values are `null`. Use this actual contract when comparing with older draft examples. Continuing requests use `sessionId`, `version`, and the current question's ID when answering it.

## Integration boundary

Her voice backend sends a completed transcript to `/api/analyze`, then displays or speaks the returned `nextQuestion.text`. This package has no voice endpoints. It implements the health extraction, rule-based questions, session state and confirmed save requested in her document.

`test-ui/` is a small text-only developer tester, not the team's mobile interface.

No `.env` or real API keys are included in this package. Copy `.env.example` to `.env` locally, add your own runtime settings, and follow README to run it. Without keys, demo extraction can be used to compare request/response behavior. This prototype saves in memory only.
