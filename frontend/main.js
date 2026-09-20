import './profile-store.js';
import { mountVersionB } from './new-ui.js';
import { mountMedications } from './medications.js';
import { mountDemoToggle } from './demo-toggle.js';
import { mountNudges } from './nudges.js';
import { mountRecords } from './records.js';
import { PLACEHOLDER_CHECKINS } from './records-placeholder.js'; // PLACEHOLDER: remove with records-placeholder.js
import { mountVisitSummary } from './visit-summary.js';
import { mountWearable } from './wearable.js';

try {
  const profile=window.PulsewiseProfile.read();
  if(!profile?.onboardingCompleted){window.location.replace('/auth/');}
  else {
    mountVersionB(document,{initialProfile:profile,profileStore:window.PulsewiseProfile});
    mountWearable(document);
    mountNudges(document);
    mountMedications(document);
    mountRecords(document, { checkins: PLACEHOLDER_CHECKINS }); // PLACEHOLDER: replace with real records
    mountVisitSummary(document);
    mountDemoToggle(document);
    document.documentElement.dataset.textSize=profile.accessibility?.textSize||'normal';
    document.documentElement.classList.toggle('reduce-motion',!!profile.accessibility?.reduceMotion);
  }
} catch {
  const notice=document.createElement('p');notice.setAttribute('role','alert');
  notice.textContent='The app could not start. Your saved demo profile has not been replaced. Please reload, or check browser storage availability.';
  document.body.replaceChildren(notice);
}
