# Authentication and profile contract — proposal for agreement

**Status: DRAFT, not implemented.** This document is the proposed contract for Kimberly's mock frontend. Agree on it before installing an authentication SDK, creating a database, adding routes, or changing the shared entry point. Requests to `/api/me` or `/api/me/profile` currently return `404 NOT_FOUND`.

Integration baseline: [`codex/checkpoint-voice-checkin-2026-09-19`](https://github.com/aanya-k/HopHacks/tree/codex/checkpoint-voice-checkin-2026-09-19), commit [`5a7fd55`](https://github.com/aanya-k/HopHacks/commit/5a7fd557dbe30dadcad8ff9c3f8d584fb7b397d8). This proposal is on `codex/gemini-profile-api`; the branch name follows the requested name, but no new Gemini investigation is included.

## What exists today

| Capability | Verified implementation |
| --- | --- |
| Registration, login, logout, authenticated identity | None |
| Profile / onboarding API or database | None |
| Profile and medication-list screen | `patientState` in `frontend/new-ui.js`; page-local demo values |
| Check-ins | `Checkins` in `backend/src/checkins.ts`; process-memory `Map`, indexed by random session UUID |
| Record ownership | None; a session UUID and version identify workflow state, not an authenticated person |
| Check-in retention | Both drafts and saved records expire after two hours of inactivity or a backend restart |
| Meals | Manual entries, water and caffeine are page-local; voice entries use analyze/save, then copy diet data into page state |
| History retrieval / separate meal CRUD API | None |

The existing test named “sessions are isolated” checks separate check-in UUIDs. It does **not** establish authenticated-user isolation. CORS restricts browser origins; it is not login or ownership enforcement.

Do not migrate the existing sample name, date of birth, contact information, or page-local medication list into a real account automatically.

## Recommended first implementation

Use **Supabase Auth for email/password sign-in and Supabase Postgres for profiles**, while keeping Express as the health/profile API. This avoids implementing password storage ourselves. The frontend auth adapter handles the provider SDK; profile reads and writes use the Express routes below. Supabase supports email/password registration, sign-in, and configurable email confirmation. See [password authentication](https://supabase.com/docs/guides/auth/passwords).

Proposed first scope: one self profile per account, persistent profile/onboarding state, and authenticated ownership checks around the existing temporary check-in store. Check-in persistence and standalone meal CRUD are separate work; a profile database alone does not provide them. No account, project, billing, SDK installation, database migration, or runtime auth configuration has been created by this documentation change.

### Configuration required after agreement

1. Choose a team-owned Supabase project or approve creating one; no paid plan or billing change is assumed.
2. Configure email/password sign-in, email-confirmation behavior, and the allowed callback URL. Proposed local callback: `http://127.0.0.1:3001/app`; production requires its own HTTPS URL. Verify the project's email-delivery settings before testing registration with teammates.
3. Add a profiles table with authenticated-owner policies and atomic version-checked updates. Test the policies using two distinct users before connecting real frontend data.
4. Add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` to backend configuration. These are proposed names and are not read by the current server. Only those public values may be supplied to the future browser auth adapter. Keep Gemini/ElevenLabs keys and any Supabase secret/service-role key server-side; the proposed request path does not need a service-role key. See [API key types](https://supabase.com/docs/guides/getting-started/api-keys).
5. Serve/bundle the auth SDK locally to preserve the current script policy. Add only the configured Supabase HTTPS origin to the page's `connect-src`. Extend CORS to allow `GET, PATCH, POST, OPTIONS` and `Authorization, Content-Type` for approved origins. Keep origin checks; validate JSON for PATCH as well as POST. These are future implementation changes, not changes made in this branch.

### Authentication adapter and login state

Recommended transport: `Authorization: Bearer <user-access-token>`. These are user session tokens, not provider API keys. Supabase handles registration/login/logout; there are **no proposed Express password endpoints** in this version.

Copyable provider calls, **after** the SDK and public configuration are installed:

```js
// `supabase` is the configured Supabase JS client; email/password come from inputs.
const registration = await supabase.auth.signUp({
  email, password,
  options: { emailRedirectTo: `${location.origin}/app` }
});
// Check registration.error. A missing session can mean email confirmation is required.
// Show the confirmation state; do not pretend that registration already logged in.

const login = await supabase.auth.signInWithPassword({ email, password });
// Check login.error before using login.data.session.

const logout = await supabase.auth.signOut({ scope: 'local' });
// Check logout.error; clear application state and stop microphone/audio on sign-out.
```

On startup and auth-state changes, obtain the current access token through the SDK and call `GET /api/me`. A browser's cached session is only a hint; backend verification decides access. On `401`, attempt at most one SDK refresh and retry once, then show login. On network/`503`, show Retry; do not treat the user as newly registered or overwrite their profile with defaults. Handle SDK errors through the frontend adapter, without displaying raw provider details or credentials.

For every protected request, the backend validates the supplied token using the configured project's `supabase.auth.getUser(token)` and derives the owner from the returned user ID. Never authorize from decoded-but-unverified claims, `user_metadata`, a body/query `userId`, or a check-in UUID. Supabase documents that [getUser performs a server authentication check](https://supabase.com/docs/reference/javascript/auth-getuser).

Logout must stop voice, abort/discard pending requests, and clear `userProfile`, both check-in clients, transcripts, meals, history, and rendered private data. Changing accounts must do the same before loading the next profile; late responses from account A must never render under account B. SDK sign-out removes the local session, but an already issued access JWT may remain usable until expiry; do not claim instant server revocation. Confirm an appropriate token lifetime during setup. Immediate invalidation would need a separate revocation design. See [signOut behavior](https://supabase.com/docs/reference/javascript/auth-signout).

## Proposed routes and response shapes

All routes below require verified authentication and return `Cache-Control: no-store`. Successful responses are JSON. The existing check-in `schemaVersion: "1.0"` is unchanged; the profile contract uses a separate draft version.

| Route | Success | Purpose |
| --- | --- | --- |
| `GET /api/me` | `200`, identity envelope below | Determine authenticated identity and onboarding state |
| `GET /api/me/profile` | `200`, profile envelope below | Read the signed-in user's complete profile |
| `PATCH /api/me/profile` | `200`, updated profile envelope | Atomically update only supplied profile fields |

`GET /api/me` example:

```json
{
  "schemaVersion": "profile-1.0-draft",
  "authenticated": true,
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "demo@example.com"
  },
  "onboardingCompleted": false
}
```

Unauthenticated callers receive `401`, not a fake demo user. The onboarding flag is read from profile storage, not trusted auth metadata. If storage is unavailable, return `503` rather than inventing `false`.

`GET /api/me/profile` for an authenticated user who has not saved a profile:

```json
{
  "schemaVersion": "profile-1.0-draft",
  "profileVersion": 0,
  "persisted": false,
  "storage": "database",
  "updatedAt": null,
  "profile": {
    "displayName": "",
    "ageRange": null,
    "recordingFor": "self",
    "conditions": null,
    "medications": null,
    "dietaryPreferences": null,
    "allergies": null,
    "trackingPreferences": [],
    "accessibility": { "textSize": "normal", "preferVoice": false },
    "onboardingCompleted": false
  }
}
```

This is a logical default after a successful database lookup finds no row. `persisted: false` means it has not been saved. GET does not create a row. Subsequent successful PATCH responses contain all the same keys, increment `profileVersion`, set `persisted: true`, and set `updatedAt` to a server-generated UTC ISO timestamp. They return the entire normalized profile, not only changed fields.

### Profile field validation

| Field | Proposed value and rules |
| --- | --- |
| `displayName` | Trimmed string, 0–80 characters in a draft; at least one character to complete onboarding |
| `ageRange` | `null`, `under_18`, `18_29`, `30_44`, `45_64`, or `65_plus`; self-reported, no birth date collected here |
| `recordingFor` | `self` in this first contract. `family` is reserved pending a separate care-recipient/ownership design and returns `422 UNSUPPORTED_RECORDING_FOR` |
| `conditions` | `null` or up to 30 unique trimmed strings of 1–120 characters; self-reported labels, not inferred diagnoses |
| `medications` | `null` or up to 30 `{id, name, dose, schedule}` objects. `id`: unique UUID generated by frontend for new list items; `name`: trimmed 1–120 characters; `dose` and `schedule`: `null` or trimmed 1–200-character text. All four item keys required |
| `dietaryPreferences`, `allergies` | Each `null` or up to 30 unique trimmed strings of 1–120 characters |
| `trackingPreferences` | Array of distinct values from `symptoms`, `medications`, `diet`, `vitals`, `wellbeing`; `[]` allowed; `null` rejected |
| `accessibility` | Object containing `textSize`: `normal`, `large`, or `extra_large`; `preferVoice`: boolean |
| `onboardingCompleted` | Boolean. Any resulting true value requires a nonempty displayName and supported recordingFor after applying the patch; optional health questions can all remain unanswered |

Do not classify users into mutually exclusive “older”, “autoimmune”, or “accessibility” categories. These attributes can overlap. The reserved family option must not route into another person's history or imply delegated access. Kimberly can leave that option disabled until we agree on a separate subject model.

For optional health lists, `null` means unanswered/reset to unknown; `[]` means the user explicitly reported none. Never convert one to the other. All objects are strict: reject unknown fields, including read-only identity, timestamps, storage, and ownership fields. Duplicate list strings after trimming/case normalization or duplicate medication IDs are invalid. Medication IDs identify profile-list entries only and are not authorization credentials or today's dose-event IDs.

### PATCH semantics and copyable calls

Use `application/json`. This is an application-specific patch; it is **not** RFC JSON Merge Patch. Body:

```json
{
  "profileVersion": 0,
  "profile": {
    "displayName": "Alex",
    "conditions": null,
    "medications": [],
    "accessibility": { "preferVoice": true },
    "onboardingCompleted": true
  }
}
```

- The top-level keys are exactly `profileVersion` and `profile`. `profileVersion` is a nonnegative integer from the most recent profile response; it is unrelated to check-in `version`.
- Omitted fields remain unchanged. Arrays replace the complete prior list. Listed nullable fields accept null; other fields do not. `profile` must be a nonempty object.
- `accessibility` merges supplied child keys; changing preferVoice keeps the current textSize. An empty accessibility patch, unknown child, or null is invalid.
- Validate the entire resulting profile before writing. No partial updates on failure. Onboarding does not require health disclosure and is never automatically completed by GET or registration. Explicit false can reopen onboarding; it does not delete check-ins. Clearing the display name while the resulting onboardingCompleted remains true returns `422 ONBOARDING_INCOMPLETE`; the same patch may instead set onboardingCompleted to false.
- `profileVersion: 0` creates the initial row only if absent. Concurrent creates must have one winner. Existing rows update atomically only at the expected version, then increment once. A stale version returns `409 PROFILE_VERSION_CONFLICT`; GET the latest profile and ask the user to reconcile edits. Never silently retry by replacing the whole current profile.
- Database constraints must enforce field/ownership rules even if a caller bypasses Express. If using a database RPC for atomic patching, keep it invoker-authorized and do not accept an arbitrary owner parameter.

Copyable fetch examples for the future live adapter:

```js
// `accessToken` comes from the auth SDK. Never log it or put it in a URL.
const headers = { Authorization: `Bearer ${accessToken}` };
const response = await fetch('/api/me/profile', { headers });
const current = await response.json();
if (!response.ok) throw Object.assign(new Error(current.error.message), current.error);

const update = await fetch('/api/me/profile', {
  method: 'PATCH',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    profileVersion: current.profileVersion,
    profile: { displayName: 'Alex', accessibility: { preferVoice: true } }
  })
});
const next = await update.json();
if (!update.ok) throw Object.assign(new Error(next.error.message), next.error);
// Replace userProfile from next.profile; do not mutate today's checkinState.
```

### Errors

Use the existing API error envelope. A field-validation error example:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Profile update did not match the schema.",
    "details": [{ "path": "profile.accessibility.textSize", "message": "Choose normal, large, or extra_large." }]
  }
}
```

| HTTP | Code | Frontend action |
| --- | --- | --- |
| 400 | `INVALID_JSON`, `INVALID_REQUEST` | Keep edits; show field errors. Unknown/read-only fields are rejected |
| 401 | `AUTH_REQUIRED`, `AUTH_INVALID` | Refresh once if possible, then login; do not clear saved server records |
| 403 | `ORIGIN_NOT_ALLOWED` | Correct approved frontend origin configuration |
| 404 | `SESSION_NOT_FOUND` / `RECORD_NOT_FOUND` | Missing, expired, or somebody else's record; don't disclose which |
| 409 | `PROFILE_VERSION_CONFLICT` | Reload server profile and reconcile; retain unsent edits separately |
| 413 / 415 | `BODY_TOO_LARGE` / `JSON_REQUIRED` | Respect existing 64 KiB JSON limit and content type |
| 422 | `ONBOARDING_INCOMPLETE`, `UNSUPPORTED_RECORDING_FOR` | Explain the specific completion/unsupported-family issue |
| 503 | `AUTH_UNAVAILABLE`, `PROFILE_STORAGE_UNAVAILABLE` | Retry later; do not fabricate identity, defaults, or a saved result |

Details never echo passwords, tokens, private provider responses, or submitted health text. Authorization failures cannot fall back to a demo account. There is no `/api/users/:userId/profile` in this proposal.

## Ownership and persistence plan

When account mode is implemented, authenticate `/api/me`, profile routes, `/api/analyze`, `/api/checkin/save`, `/api/speech/token`, and `/api/speech/speak` before invoking providers or changing records. Derive each check-in's owner from verified auth when it is created. Compare that owner on every answer, skip, resume, review, and save, before returning or changing the session. A known UUID/version must not grant another user access. Reject client-supplied owner/user IDs.

Profile table recommendation: one row keyed by authenticated `user_id`, normalized profile fields (or validated JSON), `profile_version`, and timestamps. Apply owner-only select/insert/update policies; both the existing and resulting owner must match verified identity. Use the caller's token with database RLS, not an unrestricted service-role client. [Supabase RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security) describes owner checks for reads and writes.

| Data | Current baseline | Proposed first account/profile phase |
| --- | --- | --- |
| Profile and onboardingCompleted | Profile: page-local; onboardingCompleted: not implemented | Durable database, per authenticated account |
| Auth session | None | Managed Supabase session; governed by its token/refresh policy |
| Active and saved check-ins | Anonymous memory, two-hour idle TTL/restart loss | Owner-bound memory with the same TTL/restart loss, until a separate durable-record change |
| Voice meal check-in | Anonymous temporary check-in + page state | Authenticated owner's temporary check-in; still no durable meal history |
| Manual Meals, water, caffeine | Page-local only | Still page-local until separate CRUD; cleared on logout/account change |
| Recent Check-ins / Trends | Current-page state | Current signed-in account's page state; no cross-account reuse |

Persisting saved check-ins and standalone meals needs a later contract: owner-bound stored records, retrieval, dates/time zones, conflict handling, and meal deduplication. Do not advertise durable health history until that work is implemented. If an anonymous developer demo remains, keep it an explicit separate local mode/store; never let failed auth requests access it.

Long-term `userProfile` remains separate from `checkinState`. A condition is not a symptom reported today; a prescribed medication is not a dose taken; a tracking preference is not a measurement. This phase will not inject profile data into Gemini extraction, automatically fill today's categories, or redesign follow-up questions. Existing final review/confirmation stays intact.

## Kimberly's mock adapter and integration boundary

Kimberly owns isolated onboarding/profile modules, not replacements for root `index.html` or `frontend/new-ui.js`. Suggested adapter surface:

```ts
interface ProfileAdapter {
  // These return the exact envelopes above, not a raw profile object.
  loadProfile(): Promise<ProfileEnvelope>;
  saveProfile(input: { profileVersion: number; profile: ProfilePatch }): Promise<ProfileEnvelope>;
}
```

`ProfileEnvelope` means the complete GET/PATCH response above. `ProfilePatch` allows optional writable fields from the validation table and optional accessibility children. A mock should preserve null vs [], enforce version conflicts, and simulate authentication/storage errors. Label it mock; a fake login must not be presented as authentication. Keep mock data isolated and do not silently use it after a real API failure.

After agreement and real API implementation, backend teammate coordinates entry-point wiring: auth pending → loading; no authenticated user → login; profile onboarding incomplete → setup; complete → existing Home. Loading failure → Retry. A 404 from an unimplemented route is an integration error, not evidence of a new user. Do not wire this into the shared UI while Kimberly edits isolated modules.

## Acceptance checks after implementation

These are **required future tests, not tests that have already passed**:

1. New/returning users, email confirmation, login failure, expiry/one refresh, logout, and account switching show the correct screen; auth/storage outages never invent a user or profile.
2. A and B read different profiles and onboarding flags. A cannot inject B's ID via body/query/path or bypass database policies. Invalid patches change nothing; atomic revision checks reject concurrent conflicts.
3. B cannot answer/review/save A's session even with its correct UUID/version; return the same 404 as an absent session. Auth-required speech routes make no provider request for anonymous callers.
4. Optional null and explicit [] round-trip; nested patches preserve siblings; skipping optional questions can still complete onboarding. Profile and onboarding persist after a backend restart.
5. Logout/switch clears all account state and stops voice. Delayed A responses do not display after B signs in. Test and document the configured access-token expiry limit rather than claiming instant JWT revocation.
6. Profile onboarding works with Gemini/ElevenLabs unavailable and makes no calls to either. Fresh check-ins do not gain symptoms, dose events, or vital readings from profile data.
7. Existing Daily Check-in, numeric pain, voice, Meals, Trends, More, review and save still work for an authenticated user. Temporary check-in expiry remains accurately labeled.
8. Add meal CRUD ownership/isolation tests when those endpoints actually exist; they are outside this first profile contract.

## Decisions to approve

- Supabase Auth + Postgres, frontend user-token transport, and backend verification.
- This field/response/PATCH contract, including self-only first release; family support remains deferred.
- Persistent profiles first, with check-ins/meal history still temporary and explicitly labeled.

Approval is requested because the supplied teammate task explicitly says “confirm before implementing” and requires a proposal first when auth/storage are absent. This branch completes that proposal; it does not implement login or claim user isolation exists yet.
