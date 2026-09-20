import { z } from 'zod';
import { extractionSchema } from './schema.js';
import { followUpPlanSchema } from './followups.js';

// Gemini accepts a subset of JSON Schema. Keep the complete Zod validation on
// our server, but omit unsupported string constraints and array size limits from
// the provider request. The combined bounded arrays make this schema too complex
// for Gemini's constrained decoder; the server still enforces the 20-item limits.
// https://ai.google.dev/gemini-api/docs/structured-output
const schema = z.toJSONSchema(extractionSchema.extend({ followUp: followUpPlanSchema.nullable() }), {
  override: ({ jsonSchema }) => {
    delete jsonSchema.minLength;
    delete jsonSchema.maxLength;
    delete jsonSchema.pattern;
    delete jsonSchema.maxItems;
    delete jsonSchema.default;
    if (jsonSchema.format === 'uuid') delete jsonSchema.format;
  },
});
delete schema.$schema;
export const geminiExtractionSchema = schema;
