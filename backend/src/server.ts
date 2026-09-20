import { createApp } from './app.js';
import { demoSource, snapshotSource, whoopSource } from './biometrics.js';
import { createGeminiExtractor, demoExtractor } from './extractor.js';
import { createSpeechTokenProvider } from './speech.js';
import { createSpeechAudioProvider } from './tts.js';

const mode = process.env.EXTRACTION_MODE ?? 'demo';
if (!['demo', 'gemini'].includes(mode)) throw new Error('EXTRACTION_MODE must be demo or gemini.');
const extractor = mode === 'gemini' ? createGeminiExtractor({
  apiKey: process.env.GEMINI_API_KEY ?? '', model: process.env.GEMINI_MODEL ?? 'gemini-3.8-flash',
}) : demoExtractor;
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const host = process.env.HOST ?? '127.0.0.1';
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
// whoop (default): ask the connector on every request, the way a laptop with the band does.
// snapshot: real WHOOP nights captured to a file, for a deployment that cannot reach a connector.
// demo: invented nights, labelled "Example data" wherever they appear.
const wearableMode = process.env.WEARABLE_MODE ?? 'whoop';
if (!['whoop', 'snapshot', 'demo'].includes(wearableMode)) throw new Error('WEARABLE_MODE must be whoop, snapshot or demo.');
const wearable = wearableMode === 'demo' ? demoSource(today, [today()])
  : wearableMode === 'snapshot' ? snapshotSource()
  : whoopSource(process.env.WHOOP_URL ?? 'http://127.0.0.1:8000');
const checkinLimit = Number(process.env.CHECKIN_DAILY_LIMIT ?? 0);
if (!Number.isInteger(checkinLimit) || checkinLimit < 0) throw new Error('CHECKIN_DAILY_LIMIT must be a whole number, 0 or more.');
const app = createApp(extractor, {
  origins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean),
  speechTokenProvider: process.env.ELEVENLABS_API_KEY?.trim()
    ? createSpeechTokenProvider({ apiKey: process.env.ELEVENLABS_API_KEY }) : undefined,
  speechAudioProvider: process.env.ELEVENLABS_API_KEY?.trim()
    ? createSpeechAudioProvider({ apiKey: process.env.ELEVENLABS_API_KEY, voiceId: process.env.ELEVENLABS_VOICE_ID || undefined, modelId: process.env.ELEVENLABS_TTS_MODEL || undefined }) : undefined,
  wearable,
  checkinLimit, clientIpHeader: process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
  demo: { on: process.env.DEMO_DEFAULT === 'on', locked: process.env.DEMO_LOCKED === '1' },
});
// Behind a platform's HTTPS proxy the browser's Origin is https while the request arrives as http.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
const server = app.listen(port, host, () => {
  console.log(`Pulsewise API running at http://${host}:${port} (${mode} extraction)`);
  console.log('POST /api/analyze | POST /api/checkin/save');
  console.log(`Wearable data: ${wearableMode}${wearableMode === 'whoop' ? ` (${process.env.WHOOP_URL ?? 'http://127.0.0.1:8000'})` : ''}`);
  console.log(`Connected frontend: http://${host}:${port}/app`);
  console.log(`Text-only backend tester: http://${host}:${port}/test/`);
  console.log('Hackathon prototype: in-memory sessions expire after 2 hours of inactivity or on restart.');
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other process or change PORT in .env.` : `Could not start server (${error.code ?? 'unknown error'}).`);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
