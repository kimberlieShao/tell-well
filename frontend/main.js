import { mountVersionB } from './new-ui.js';
import { mountMedications } from './medications.js';
import { mountVisitSummary } from './visit-summary.js';
import { mountWearable } from './wearable.js';

mountVersionB(document);
mountWearable(document);
mountMedications(document);
mountVisitSummary(document);
