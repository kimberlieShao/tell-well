# Personal onboarding — connected demo

Start the Node backend and open http://127.0.0.1:3001/ (or its configured port). Root opens /auth/. Try demo opens /onboarding/ until setup is complete, then /app. Open pages through the backend, not file://.

Eight self-only steps: personal details, chronic conditions, medications, diet/allergies, tracking preferences, devices, settings, review. Save persists to tab-scoped sessionStorage; Continue to Home opens the wearable-enabled UI. More → Profile / Settings / Connected Health Data links back to the relevant setup editor. Personal profile facts never populate today's check-in facts.

This is not authentication: no accounts, cloud persistence or user ownership are implemented. The profile survives navigation and refresh within this tab, not a new session. Profile storage errors are displayed without overwriting unreadable data. Device selections are preferences, not live connections. WHOOP reads still come from the existing biometrics backend. Reminder settings do not schedule notifications.

frontend/profile-store.js is the shared demo adapter. Replace with the agreed authenticated/versioned profile API when available. Home and More medication lists share it; physician-summary medication reads use the same list. Do not use the demo as a real account or put provider secrets in frontend storage.

Validation: backend/test/onboarding-integration.test.ts covers routes, real DOM setup, navigation data transfer, More content, medication sync and storage errors. Existing voice/check-in tests remain in place. Live provider and physical mobile/browser testing is separate.
