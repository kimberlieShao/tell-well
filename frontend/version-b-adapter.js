// Translate transport fields into Version B's existing view state. Never infer
// clinical facts or identify a medication here; interpretation belongs to the API.
const fields = {
  symptoms: ['id', 'name', 'location', 'severity', 'severityScore', 'trend', 'functionalImpact', 'duration'],
  medications: ['id', 'name', 'description', 'dose', 'status', 'time'],
  diet: ['id', 'description', 'time'],
  vitals: ['id', 'name', 'value', 'unit', 'time'],
};
const clone = value => structuredClone(value);
const pick = (item, keys) => Object.fromEntries(keys.map(key => [key, item[key] ?? null]));

export function normalizeBackendResponse(response, { transcript = '', excludedIds = new Set() } = {}) {
  const record = Object.fromEntries(Object.keys(fields).map(category => [category,
    response[category].filter(item => !excludedIds.has(item.id)).map(item => pick(item, fields[category])),
  ]));
  record.wellness = clone(response.wellness ?? null);
  return {
    transcript,
    symptoms: record.symptoms.map(symptom => ({ ...symptom, painScore: symptom.severityScore })),
    medications: record.medications.map(medication => ({ ...medication })),
    diet: record.diet.map(entry => ({ ...entry, item: entry.description })),
    vitals: record.vitals.map(vital => ({ ...vital, type: vital.name, source: 'reported' })),
    generalStatus: record.wellness?.status ?? null,
    noSymptoms: Boolean(record.wellness) && record.symptoms.length === 0,
    resolvedSymptoms: [],
    sessionId: response.sessionId,
    version: response.version,
    nextQuestion: clone(response.nextQuestion),
    status: response.status,
    extractionMode: response.extractionMode,
    missingFields: [...response.missingFields],
    notices: [...response.notices],
    backendRecord: record,
  };
}

export function toBackendRecord(state) {
  return {
    symptoms: state.symptoms.map(symptom => pick({ ...symptom,
      severityScore: Object.hasOwn(symptom, 'painScore') ? symptom.painScore : symptom.severityScore ?? null,
    }, fields.symptoms)),
    medications: state.medications.map(item => pick(item, fields.medications)),
    diet: state.diet.map(entry => pick({ ...entry, description: entry.item ?? entry.description }, fields.diet)),
    vitals: state.vitals.map(vital => pick({ ...vital, name: vital.type ?? vital.name }, fields.vitals)),
    wellness: state.generalStatus && state.backendRecord?.wellness
      ? { ...state.backendRecord.wellness, status: state.generalStatus } : null,
  };
}

// Group only an explicit structured meal time. Unknown time remains unspecified.
export function mealsFromBackend(response) {
  const groups = new Map();
  for (const entry of response.diet) {
    const time = entry.time?.trim().toLowerCase();
    const mealType = ['breakfast', 'lunch', 'dinner', 'snacks'].includes(time) ? time : 'unspecified';
    if (!groups.has(mealType)) groups.set(mealType, []);
    groups.get(mealType).push(entry.description);
  }
  return { meals: [...groups].map(([mealType, items]) => ({ mealType, items })), waterGlasses: 0, caffeine: [] };
}
