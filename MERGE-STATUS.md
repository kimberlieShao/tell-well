# Integration checkpoint — 2026-09-19

Combined Kimberly's `codex/patient-onboarding` with `origin/main` and the teammate's `codex/gemini-profile-api` at `6a03e7f`.

- Retained `frontend1`, the old standalone prototype renamed on main.
- Resolved the index.html modify/delete conflict by retaining the teammate's integrated root index.html. Root index.html, frontend/ and backend/ are identical to the teammate branch.
- Added onboarding/ as a standalone self-only mock prototype, not an authenticated entry point.
- Did not add login, database/profile routes, paid provider requests, or automatic onboarding-to-Home data transfer.

## Run and preview

For the integrated check-in app, follow FRONTEND-INTEGRATION.md: install backend dependencies, configure your own ignored environment file, start the backend, and open /app.

For the standalone onboarding prototype, open onboarding/index.html. The existing backend does not serve /onboarding yet. Its Open existing app demo link points at the root HTML; the integrated app must actually be run at /app through the backend. Do not use that file link to test API/voice integration.

## Verified after merge

- `npm run check`: passed.
- `npm test`: 127 passed, 0 failed (simulated providers, with local loopback servers).
- Onboarding JavaScript syntax: passed.
- JSDOM interaction check: setup progression, POTS selection, medication creation, tracking/device selections, settings, saving, personal photo control, editing/cancel restoration passed.
- No live microphone/provider tests or browser visual/mobile QA were performed.

The dependency lockfile reports engine-range warnings on local Node 25.8.2, although the checks above pass. Use a supported Node version matching dependency requirements for repeatable development.

## Next integration task

Agree on backend/PROFILE-AUTH-CONTRACT.md before wiring real endpoints. The current onboarding adapter uses a plain profile object and differs from the proposed versioned API envelope. Devices, photo, notes, age bands, reminder preferences and field names need contract reconciliation. No API compatibility is claimed by this merge.

Scope is self-only: family/caregiver and multi-member flows were removed. Actual auth/profile persistence and first-login routing remain pending. Coordinate entry-point changes with the backend teammate.
