import { z } from 'zod';

const text = z.string().trim().min(1).max(500);
const nullableText = text.nullable();
const id = z.uuid();
export const categories = ['symptoms', 'medications', 'diet', 'vitals'] as const;
export const symptomSchema = z.strictObject({
  id, name: text, location: nullableText,
  severity: z.enum(['mild', 'moderate', 'severe']).nullable(),
  severityScore: z.number().min(0).max(10).nullable(),
  trend: z.enum(['better', 'same', 'worse']).nullable(),
  functionalImpact: nullableText, duration: nullableText,
  firstOccurrence: z.boolean().nullable().optional(),
});
export const medicationSchema = z.strictObject({
  id, name: nullableText, description: nullableText, dose: nullableText,
  status: z.enum(['taken', 'missed', 'stopped', 'mentioned']).nullable(),
  time: nullableText,
});
export const dietSchema = z.strictObject({ id, description: text, time: nullableText,
  waterGlasses: z.number().min(0).max(100).nullable().optional(),
  waterMode: z.enum(['add', 'total']).nullable().optional(),
});
export const vitalSchema = z.strictObject({
  id, name: text, value: nullableText, unit: nullableText, time: nullableText,
});
// An explicitly reported well day is a valid check-in, not a fabricated symptom.
// Defaulting this additive field keeps earlier four-category clients compatible.
export const wellnessSchema = z.strictObject({
  status: z.enum(['well', 'normal']), statement: text,
}).nullable();
// Written by the server from actual input, never supplied by the extraction model.
export const reportedAnswerSchema = z.strictObject({
  questionId: text.nullable(), entityId: id.nullable(), field: text.nullable(), question: nullableText,
  transcript: z.string().min(1).max(8000), interpretation: z.enum(['recorded', 'unconfirmed']),
});
export const recordSchema = z.strictObject({
  symptoms: z.array(symptomSchema).max(20),
  medications: z.array(medicationSchema).max(20),
  diet: z.array(dietSchema).max(20),
  vitals: z.array(vitalSchema).max(20),
  wellness: wellnessSchema.default(null),
  reportedAnswers: z.array(reportedAnswerSchema).max(100).optional(),
});
export type HealthRecord = z.infer<typeof recordSchema>;
export type Category = typeof categories[number];
export const emptyRecord = (): HealthRecord => ({ symptoms: [], medications: [], diet: [], vitals: [], wellness: null });

// Models propose field updates; the server owns entity IDs and validates question proposals.
export const extractionSchema = z.strictObject({
  symptoms: z.array(symptomSchema.extend({ id: id.nullable() })).max(20),
  medications: z.array(medicationSchema.extend({ id: id.nullable() })).max(20),
  diet: z.array(dietSchema.extend({ id: id.nullable() })).max(20),
  vitals: z.array(vitalSchema.extend({ id: id.nullable() })).max(20),
  wellness: wellnessSchema.default(null),
});
export type Extraction = z.infer<typeof extractionSchema>;

export const questionSchema = z.strictObject({
  id: text, category: z.enum(categories), entityId: id, field: text,
  text: z.string().max(1000), type: z.enum(['single_choice', 'text']),
  options: z.array(text),
});
export type Question = z.infer<typeof questionSchema>;

export const analyzeInputSchema = z.strictObject({
  sessionId: id.optional(), version: z.number().int().positive().optional(),
  transcript: z.string().trim().min(1).max(8000).optional(),
  painScale: z.literal('1-10').optional(),
  flow: z.literal('brief').optional(),
  questionId: text.optional(),
  answer: z.strictObject({ questionId: text, value: text }).optional(),
  action: z.enum(['skip', 'review', 'resume']).optional(),
  skipScope: z.literal('entity').optional(),
}).superRefine((data, ctx) => {
  if ([data.transcript, data.answer, data.action].filter(x => x !== undefined).length !== 1)
    ctx.addIssue({ code: 'custom', message: 'Send exactly one of transcript, answer, or action.' });
  if (!data.sessionId && (data.answer || data.action || data.questionId || data.version !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Start with transcript only; subsequent turns need sessionId and version.' });
  if (data.sessionId && data.version === undefined)
    ctx.addIssue({ code: 'custom', message: 'Include the version from the latest response.' });
  if (data.sessionId && data.painScale !== undefined)
    ctx.addIssue({ code: 'custom', path: ['painScale'], message: 'Choose a pain scale only when starting a check-in.' });
  if (data.sessionId && data.flow !== undefined)
    ctx.addIssue({ code: 'custom', path: ['flow'], message: 'Choose a flow only when starting a check-in.' });
  if (data.questionId && !(data.transcript || data.action === 'skip'))
    ctx.addIssue({ code: 'custom', message: 'questionId accompanies a spoken transcript answer or skip.' });
  if (data.action === 'skip' && !data.questionId)
    ctx.addIssue({ code: 'custom', message: 'Skipping needs questionId.' });
  if (data.skipScope !== undefined && data.action !== 'skip')
    ctx.addIssue({ code: 'custom', path: ['skipScope'], message: 'Entity scope applies only when skipping a question.' });
});
export type AnalyzeInput = z.infer<typeof analyzeInputSchema>;

export const saveInputSchema = z.strictObject({
  sessionId: id, version: z.number().int().positive(), confirmed: z.literal(true),
  record: recordSchema.optional(),
});
export type SaveInput = z.infer<typeof saveInputSchema>;
export const responseSchema = z.strictObject({
  schemaVersion: z.literal('1.0'), sessionId: id, version: z.number().int().positive(),
  status: z.enum(['collecting', 'review', 'saved']),
  extractionMode: z.enum(['demo', 'gemini']),
  ...recordSchema.shape,
  missingFields: z.array(z.string()), skippedFields: z.array(z.string()),
  needsClarification: z.boolean(), nextQuestion: questionSchema.nullable(),
  notices: z.array(z.string()), storage: z.literal('memory'),
  expiresAt: z.iso.datetime(), savedAt: z.iso.datetime().nullable(),
});
export type CheckinResponse = z.infer<typeof responseSchema>;
