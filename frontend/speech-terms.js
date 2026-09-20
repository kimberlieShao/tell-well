// Words the transcriber is nudged towards, so medication and condition names come through spelled
// correctly. Realtime limits: at most 50 terms, each at most 20 characters, and no < > { } [ ] \
import { loadMedications } from './medications.js';

const MAX_TERMS = 50;
const MAX_CHARS = 20;

export const GENERAL_TERMS = [
  'flare', 'fatigue', 'brain fog', 'joint pain', 'morning stiffness', 'prednisone', 'methotrexate',
  'hydroxychloroquine', 'Plaquenil', 'Humira', 'adalimumab', 'Enbrel', 'sulfasalazine', 'leflunomide',
  'Benlysta', 'mycophenolate', 'azathioprine', 'Rinvoq', 'Xeljanz', 'Stelara', 'Entyvio', 'mesalamine',
  'Ocrevus', 'ibuprofen', 'naproxen', 'acetaminophen', 'Tylenol', 'Advil', 'folic acid', 'lupus',
  'rheumatoid', 'fibromyalgia', 'POTS', "Crohn's", 'colitis', 'migraine', "Raynaud's", 'malar rash',
  'rheumatologist', 'infusion', 'injection', 'steroid taper', 'palpitations', 'dizziness', 'nausea',
];

/** The person's own medications first, then the common condition, symptom and drug names. */
export function speechKeyterms(extra = []) {
  let names = [];
  try { names = loadMedications().map(med => med.name); } catch { /* no saved medications yet */ }
  const seen = new Set();
  const terms = [];
  for (const raw of [...extra, ...names, ...GENERAL_TERMS]) {
    const term = String(raw ?? '').replace(/[<>{}[\]\\]/g, '').trim();
    if (!term || term.length > MAX_CHARS || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}
