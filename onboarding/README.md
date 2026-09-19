# Personal onboarding prototype

Open onboarding/index.html. No build or backend is required.

This is a self-only profile: no family members, caregiver fields, person selector, member cards or add-member action.

Eight steps: personal details, chronic conditions, medications, diet/allergies, tracking preferences, devices, app settings, review.

Save opens the personal profile with optional photo and section editing. Cancel restores the saved profile. The mock loadProfile/saveProfile adapter clones data and stores it only in page memory; refresh or navigating away clears it. Photos accept PNG/JPEG/WebP up to 2 MB. Unanswered optional lists use null, explicit none uses [].

The sidebar is hidden on mobile (<=760px), and on desktop after setup completion, including profile editing. More → Profile and More → Settings are future integration destinations; the existing app is unchanged. First-login detection and persistence need the authentication/backend integration.

Device choices are metadata only, not connected devices. Text size previews locally; reminders do not send notifications. SpeechRecognition is unchanged.

Age groups are product reporting bands, not a universal clinical standard: https://archive.cdc.gov/www_cdc_gov/csels/dsepd/ss1978/lesson5/section5.html

Validation: syntax, eight rendering paths, self-only markup, save and cancel restoration tested with DOM simulation. Browser visual QA remains pending.
