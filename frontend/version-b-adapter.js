// Translate transport fields into Version B's existing view state. Never infer
// clinical facts or identify a medication here; interpretation belongs to the API.
const fields = {
  symptoms: ['id', 'name', 'location', 'severity', 'severityScore', 'trend', 'functionalImpact', 'duration', 'firstOccurrence'],
  medications: ['id', 'name', 'description', 'dose', 'status', 'time'],
  diet: ['id', 'description', 'time', 'waterGlasses', 'waterMode'],
  vitals: ['id', 'name', 'value', 'unit', 'time'],
};
const clone = value => structuredClone(value);

/** Water is counted in whole glasses: the nearest whole number, never below 0, or null when there is no count. */
export const wholeGlasses = value => {
  if (value === null || value === undefined || value === '') return null;
  const glasses = Math.round(Number(value));
  return Number.isFinite(glasses) ? Math.max(0, glasses) : null;
};
const pick = (item, keys) => Object.fromEntries(keys.map(key => [key, item[key] ?? null]));

export function normalizeBackendResponse(response, { transcript = '', excludedIds = new Set() } = {}) {
  const record = Object.fromEntries(Object.keys(fields).map(category => [category,
    response[category].filter(item => !excludedIds.has(item.id)).map(item => pick(item, fields[category])),
  ]));
  record.diet = record.diet.map(entry => ({ ...entry, waterGlasses: wholeGlasses(entry.waterGlasses) }));
  record.wellness = clone(response.wellness ?? null);
  record.reportedAnswers = clone(response.reportedAnswers ?? []).filter(answer=>!answer.entityId || !excludedIds.has(answer.entityId));
  return {
    transcript,
    reportedAnswers: record.reportedAnswers,
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
    reportedAnswers: clone(state.reportedAnswers ?? []),
    symptoms: state.symptoms.map(symptom => pick({ ...symptom,
      severityScore: Object.hasOwn(symptom, 'painScore') ? symptom.painScore : symptom.severityScore ?? null,
    }, fields.symptoms)),
    medications: state.medications.map(item => pick(item, fields.medications)),
    diet: state.diet.map(entry => {
      const item = pick({ ...entry, description: entry.item ?? entry.description }, fields.diet);
      return { ...item, waterGlasses: wholeGlasses(item.waterGlasses) }; // what is saved is whole glasses too
    }),
    vitals: state.vitals.map(vital => pick({ ...vital, name: vital.type ?? vital.name }, fields.vitals)),
    wellness: state.generalStatus && state.backendRecord?.wellness
      ? { ...state.backendRecord.wellness, status: state.generalStatus } : null,
  };
}

export const isWaterEntry = entry => entry.waterGlasses != null || entry.waterMode != null;

// Group structured meal times and hydration without interpreting the transcript.
export function mealsFromBackend(response, { unknownMeal = 'unspecified' } = {}) {
  const groups = new Map();
  const hydration = [];
  for (const entry of response.diet) {
    if (isWaterEntry(entry)) { hydration.push({ id: entry.id, glasses: wholeGlasses(entry.waterGlasses), mode: entry.waterMode, description: entry.description }); continue; }
    const time = entry.time?.trim().toLowerCase();
    const mealType = ['breakfast', 'lunch', 'dinner', 'snacks'].includes(time) ? time : unknownMeal;
    if (!groups.has(mealType)) groups.set(mealType, []);
    groups.get(mealType).push(entry.description);
  }
  return { meals: [...groups].map(([mealType, items]) => ({ mealType, items })), hydration, waterGlasses: 0, caffeine: [] };
}
