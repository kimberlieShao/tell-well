import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Checkins } from './checkins.js';
import { ApiError } from './errors.js';
import type { Extractor } from './extractor.js';
import { analyzeInputSchema, saveInputSchema } from './schema.js';
import type { SpeechTokenProvider } from './speech.js';

export function createApp(extractor: Extractor, config: { origins?: string[]; store?: Checkins; speechTokenProvider?: SpeechTokenProvider } = {}) {
  const app = express();
  const store = config.store ?? new Checkins(extractor);
  const origins = new Set(config.origins ?? ['http://localhost:8081', 'http://localhost:5500', 'http://127.0.0.1:5500']);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin) {
      res.vary('Origin');
      const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
      if (!sameOrigin && !origins.has(origin)) return next(new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Add this frontend origin to CORS_ORIGINS on the backend.'));
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    if (req.method === 'POST' && !req.is('application/json')) return next(new ApiError(415, 'JSON_REQUIRED', 'Send Content-Type: application/json.'));
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/', (_req, res) => { res.redirect('/app'); });
  app.get(['/app', '/app/'], (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://api.elevenlabs.io; worker-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.sendFile(fileURLToPath(new URL('../../index.html', import.meta.url)));
  });
  // Serve only the browser modules, never the repository or backend secrets.
  app.use('/frontend', express.static(fileURLToPath(new URL('../../frontend/', import.meta.url)), { dotfiles: 'deny', index: false }));
  app.use('/test', (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  }, express.static(fileURLToPath(new URL('../test-ui/', import.meta.url)), { dotfiles: 'deny', index: 'index.html' }));
  app.post('/api/analyze', async (req, res) => { res.json(await store.analyze(analyzeInputSchema.parse(req.body))); });
  app.post('/api/checkin/save', (req, res) => { res.json(store.save(saveInputSchema.parse(req.body))); });
  app.post('/api/speech/token', async (_req, res) => {
    if (!config.speechTokenProvider) throw new ApiError(503, 'SPEECH_NOT_CONFIGURED', 'Voice input is not configured. Add ELEVENLABS_API_KEY on the server, or type your check-in.');
    res.json(await config.speechTokenProvider());
  });
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Use POST /api/analyze or POST /api/checkin/save.')));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Request did not match the API schema.', details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } });
    } else if (error instanceof ApiError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, details: [] } });
    } else if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.', details: [] } });
    } else if (error.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request is too large.', details: [] } });
    } else {
      // Do not log request bodies, transcripts, API keys, or provider responses.
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The server could not complete this request.', details: [] } });
    }
  };
  app.use(errorHandler);
  return app;
}
