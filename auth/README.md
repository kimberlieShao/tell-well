# Pulsewise account UI preview

Open auth/index.html directly. No build or backend is required. Responsive layout hides the illustration and uses one column below 800px.

Includes email/password sign-in, registration, password confirmation, password visibility toggles, password-reset form, Google entry button, inline errors and an explicitly labeled onboarding preview link.

This is UI only. Valid submissions state that authentication is not connected; Google does not open OAuth and reset does not send mail. No network calls, password logging, cookies or browser storage. Passwords are cleared after valid preview submission; switching screens clears all fields. Use sample values.

The eight-character registration minimum is provisional UI validation, not a finalized backend password policy. Existing users' sign-in passwords are only checked for presence.

## Integration later

Connect to the agreed authentication provider after the backend teammate confirms configuration. Replace unavailable messages with real provider requests, error/loading states and verified session handling. Route to onboarding only when the backend confirms onboardingCompleted is false; failures must not be treated as a new profile. Wire completed users to Home. Keep provider secrets server-side and clear user state on logout/account changes.

The Google entry is sign-in, not existing-account linking. No main App, onboarding, WHOOP or voice code is changed. The existing backend does not yet serve /auth; this directory is standalone.

## Checks

With existing backend development dependencies installed: node auth/test/forms.cjs

JSDOM checks cover invalid/valid forms, confirmation mismatch, visibility toggle, screen switching, provider-unavailable messages, password clearing and absence of storage. Syntax checked with node --check auth/app.js. These do not establish live authentication, mobile/browser rendering or email delivery. Visual browser QA remains pending.
