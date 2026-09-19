import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { recordSchema, responseSchema } from '../src/schema.js';

await mkdir('contracts', { recursive: true });
for (const [name, schema] of [['record', recordSchema], ['response', responseSchema]] as const) {
  await writeFile(`contracts/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n');
}
console.log('Generated contracts/record.schema.json and contracts/response.schema.json');
