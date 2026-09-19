# Pulsewise — Backend teammate's Codex task

> Updated scope: self-only personal profiles. Family/caregiver recording and multiple-member profiles have been removed. This supersedes earlier plans.


## Message from Kimberly

I am building the first-time onboarding and patient profile frontend: preferred name, health background, current medications, dietary preferences, and what the user wants to track.

Please focus on investigating the Gemini limit error and establishing the authentication/profile API contract. I will build isolated frontend modules using mock data first. Please share your latest integration baseline and API documentation before we connect them. We should avoid editing the same index.html or rewriting the working voice flow in parallel.

There are only two of us working on this area. The responsibilities below refer to Kimberly and you, each using our own Codex.

---

## Copy the following task into your Codex

Please investigate the Gemini failure in our existing Pulsewise project, then document the authentication and patient-profile integration contract. Kimberly is separately developing onboarding/profile frontend modules.

### 1. Protect existing work

- Inspect the current branch, working tree, project instructions, and existing integration before editing.
- Preserve all uncommitted work. Do not reset, overwrite, or force-push.
- Work on a separate branch, suggested name: codex/gemini-profile-api.
- Do not rewrite Kimberly's onboarding/profile modules or redesign the existing UI.
- Preserve the working SpeechRecognition, continuous listening, and check-in flows. Investigate duplicate submissions at the request boundary without rewriting speech capture.

### 2. Diagnose the Gemini error from evidence

The UI currently reports a rate/quota limit, but we have not verified whether that message reflects the actual upstream response. Do not assume either that the quota is exhausted or that the user's quota dashboard rules it out.

1. Capture one failed request's actual HTTP status, upstream error body/details, requested model, timestamp, and backend request ID. Redact secrets and sensitive health content. Never print the full API key or Authorization header.
2. Inspect error mapping: are unrelated errors being converted into the same quota-limit message?
3. Verify which configuration the running backend actually loads. Check whether the API key's project, selected model/API service, and the project shown in the quota dashboard match.
4. Make one minimal request using the same backend configuration. Compare it with the app request to distinguish an upstream rejection from application behavior.
5. Check whether interim/final speech results, end callbacks, automatic submissions, concurrency, or retry loops create duplicate/excess requests. Avoid generating a burst of diagnostic requests.
6. Consult current official documentation if model, SDK, or quota behavior needs verification.
7. Fix the demonstrated cause. Distinguish authentication, model, quota/rate, and network errors. Retry only appropriate transient failures, with bounded backoff and Retry-After when provided. Do not simply increase retries.
8. Do not rotate accounts/keys to evade limits, enable billing, or change budgets without authorization.
9. Verify that failures do not overwrite saved records and that the UI message accurately describes the failure.

Report the root cause, supporting evidence, code changes, tests actually run, and any console/account action still needed from us. If the cause remains unknown, say so explicitly.

### 3. Establish authentication and profile capabilities

Inspect existing authentication, session, storage, and user models before proposing new infrastructure. A check-in session is not necessarily an authenticated user session.

Document:
- Registration, login, logout, and how the frontend determines login state.
- Reading and updating the authenticated user's profile.
- Saving and reading onboardingCompleted.
- How check-ins and meal records belong to a user.
- Whether data persists, or expires on restart/inactivity in demo memory.

Reuse existing authentication/storage if available. If neither exists, propose a minimal approach and required external configuration first; do not purchase services or implement a misleading frontend-only login.

The backend must derive user identity from authentication, not trust an arbitrary userId supplied by the browser. Test that one user cannot read or overwrite another user's profile or records. Keep server API keys out of the browser.

Profile information may later inform medication choices and optional questions, but implementing profile storage is not authorization to redesign the current analysis flow. A saved condition, medication, or tracking preference must never be treated as a symptom, dose taken, or measurement reported today.

### 4. Proposed shared data contract — confirm before implementing

This is a proposal, not a claim that these fields or endpoints already exist. Adapt to the current backend and document the final contract for Kimberly.

```js
const userProfile = {
  displayName: "",
  ageRange: null,
  conditions: null,     // self-reported, not inferred diagnoses
  medications: null,    // [{ id, name, dose, schedule }]
  dietaryPreferences: null,
  allergies: null,
  trackingPreferences: [],
  accessibility: {
    textSize: "normal",
    preferVoice: false
  },
  onboardingCompleted: false
};
```

For optional health lists, distinguish unanswered (null) from an explicit “none” ([]). Define validation, PATCH semantics, authentication errors, and response/error schemas.

Possible routes to discuss: GET /api/me, GET /api/me/profile, PATCH /api/me/profile. Use existing conventions where appropriate. Authentication routes depend on the chosen existing solution.

Age, health conditions, and accessibility preferences are separate, overlapping attributes—not mutually exclusive patient categories. Long-term userProfile data must remain separate from per-session checkinState.

### 5. Deliver to Kimberly

- A safe integration baseline branch/commit and a summary of existing changes.
- Updated FRONTEND-INTEGRATION.md and backend/API.md, or equivalent documents.
- Authentication details and copyable request/response examples.
- Validation/error formats and persistence limitations.
- Local startup/test commands and required environment-variable names, without secret values.
- Gemini fix status, verification results, and unresolved issues.

Do not force-push main or overwrite Kimberly's frontend modules.

## Two-person integration plan

1. You preserve and share the current working integration baseline; never share .env files or API keys.
2. Kimberly builds isolated onboarding/profile pages and a mock loadProfile/saveProfile adapter while you investigate Gemini and establish the API contract.
3. Both agree on the contract. Kimberly connects the frontend adapter to the real endpoints.
4. You handle final entry-point wiring in the integrated app: unauthenticated → login; onboarding incomplete → setup; completed → existing Home. Coordinate before editing the shared index.html.
5. Together test new/returning users, skipping optional fields, profile edits, logout/account switching, user-data isolation, API failure, and existing Daily Check-in/Meals/Trends/More behavior.
6. Review diffs before merging. Do not replace the integrated index.html with Kimberly's older full-file version.

Onboarding and profile storage should work without Gemini. Kimberly's frontend work does not need to wait for the Gemini issue to be resolved.
