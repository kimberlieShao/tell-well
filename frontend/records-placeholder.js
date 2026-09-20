// PLACEHOLDER: replace with real records
//
// Temporary check-ins so the Records calendar has something to show. To remove them:
// delete this file and the two lines in main.js marked PLACEHOLDER. records.js never imports it.
//
// The shape is a saved check-in as the backend describes it (backend/src/schema.ts): `sessionId` and
// `savedAt` from the check-in response, and the record's symptoms / medications / diet / vitals /
// wellness / reportedAnswers. See RECORDS-DATA-FORMAT.md.
// `local()` builds each time from the viewer's local clock, so a check-in always lands on the day named below.
// Real data carries a UTC `savedAt` such as "2026-09-19T12:30:00Z".

const local = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).toISOString();
const id = suffix => `a1b2c3d4-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const symptom = fields => ({
  location: null, severity: null, severityScore: null, trend: null,
  functionalImpact: null, duration: null, firstOccurrence: null, ...fields,
});
const medication = fields => ({ description: null, dose: null, status: null, time: null, ...fields });
const report = fields => ({ questionId: null, entityId: null, field: null, question: null, interpretation: 'recorded', ...fields });

export const PLACEHOLDER_CHECKINS = [
  // Friday, September 4: one check-in, a headache
  {
    sessionId: id(1),
    savedAt: local(4, 10, 20),
    symptoms: [symptom({
      id: id(101), name: 'Headache', location: 'Forehead', severity: 'mild', severityScore: 4,
      duration: 'Since this morning', functionalImpact: 'Hard to read on screens', firstOccurrence: false,
    })],
    medications: [], diet: [], vitals: [], wellness: null,
    reportedAnswers: [
      report({ transcript: 'I woke up with a headache and it has not really gone away.' }),
      report({ questionId: `${id(101)}:duration`, entityId: id(101), field: 'duration', question: 'When did the headache start?', transcript: 'Around seven this morning, right after I woke up.' }),
    ],
  },

  // Friday, September 11: arm pain and a pain reliever
  {
    sessionId: id(2),
    savedAt: local(11, 9, 5),
    symptoms: [symptom({
      id: id(102), name: 'Arm pain', location: 'Left arm', severity: 'moderate', severityScore: 6, trend: 'worse',
      duration: '3 days', functionalImpact: 'Lifting the kettle, sleeping on that side', firstOccurrence: true,
    })],
    medications: [medication({ id: id(201), name: 'Ibuprofen', description: 'For arm pain', dose: '200 mg', status: 'taken', time: 'Morning' })],
    diet: [], vitals: [], wellness: null,
    reportedAnswers: [
      report({ transcript: 'My left arm has been aching for a few days and it is getting worse. I took an ibuprofen this morning.' }),
    ],
  },

  // Tuesday, September 15: very little detail, to show that empty fields are left out
  {
    sessionId: id(3),
    savedAt: local(15, 12, 40),
    symptoms: [symptom({ id: id(103), name: 'Headache', severityScore: 3 })],
    medications: [medication({ id: id(202), name: 'Blood pressure pill', description: 'For blood pressure', status: 'missed' })],
    diet: [], vitals: [], wellness: null,
    reportedAnswers: [],
  },

  // Saturday, September 19: two check-ins
  {
    sessionId: id(4),
    savedAt: local(19, 8, 30),
    symptoms: [symptom({
      id: id(104), name: 'Headache', location: 'Behind the eyes', severity: 'moderate', severityScore: 6, trend: 'worse',
      duration: 'Since yesterday afternoon', functionalImpact: 'Bright light bothers me', firstOccurrence: false,
    })],
    medications: [], diet: [], vitals: [], wellness: null,
    reportedAnswers: [
      report({ transcript: 'My headache is back and it is worse than yesterday. The light in the kitchen is too bright.' }),
    ],
  },
  {
    sessionId: id(5),
    savedAt: local(19, 17, 30),
    symptoms: [symptom({ id: id(105), name: 'Arm pain', location: 'Left arm', severity: 'mild', severityScore: 5, trend: 'better' })],
    medications: [medication({ id: id(203), name: 'Ibuprofen', description: 'For arm pain', dose: '200 mg', status: 'taken', time: 'Afternoon' })],
    diet: [{ id: id(301), description: 'Chicken soup and toast', time: 'Dinner', waterGlasses: 3, waterMode: 'total' }],
    vitals: [], wellness: null,
    reportedAnswers: [
      report({ transcript: 'My arm feels a little better this evening.' }),
      report({ questionId: `${id(105)}:trend`, entityId: id(105), field: 'trend', question: 'Is it getting better or worse?', transcript: 'A bit better than this morning, I think the ibuprofen helped.', interpretation: 'unconfirmed' }),
    ],
  },
];
