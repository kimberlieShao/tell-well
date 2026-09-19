import { createApp } from './app.js';
import { createGeminiExtractor, demoExtractor } from './extractor.js';
import { createSpeechTokenProvider } from './speech.js';

const mode = process.env.EXTRACTION_MODE ?? 'demo';
if (!['demo', 'gemini'].includes(mode)) throw new Error('EXTRACTION_MODE must be demo or gemini.');
const extractor = mode === 'gemini' ? createGeminiExtractor({
  apiKey: process.env.GEMINI_API_KEY ?? '', model: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
}) : demoExtractor;
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const host = process.env.HOST ?? '127.0.0.1';
const app = createApp(extractor, {
  origins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean),
  speechTokenProvider: process.env.ELEVENLABS_API_KEY?.trim()
    ? createSpeechTokenProvider({ apiKey: process.env.ELEVENLABS_API_KEY }) : undefined,
});
const server = app.listen(port, host, () => {
  console.log(`Pulsewise API running at http://${host}:${port} (${mode} extraction)`);
  console.log('POST /api/analyze | POST /api/checkin/save');
  console.log(`Connected frontend: http://${host}:${port}/app`);
  console.log(`Text-only backend tester: http://${host}:${port}/test/`);
  console.log('Hackathon prototype: in-memory sessions expire after 2 hours of inactivity or on restart.');
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other process or change PORT in .env.` : `Could not start server (${error.code ?? 'unknown error'}).`);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
