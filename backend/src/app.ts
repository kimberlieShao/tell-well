import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { ZodError, z } from 'zod';
import { BiometricsUnavailable, metricKeys, reading, type BiometricsSource } from './biometrics.js';
import { CheckinLog } from './checkin-log.js';
import { arthritisCheckins, arthritisSource, arthritisToday, DEMO_NAME } from './demo-story.js';
import { evaluateNudges, feedbackFor, type Nudge } from './nudges.js';
import { Checkins } from './checkins.js';
import { ApiError } from './errors.js';
import type { Extractor } from './extractor.js';
import { analyzeInputSchema, saveInputSchema } from './schema.js';
import type { SpeechTokenProvider } from './speech.js';
import type { SpeechAudioProvider } from './tts.js';

export function createApp(extractor: Extractor, config: { origins?: string[]; store?: Checkins; speechTokenProvider?: SpeechTokenProvider; speechAudioProvider?: SpeechAudioProvider; wearable?: BiometricsSource; log?: CheckinLog } = {}) {
  const app = express();
  const store = config.store ?? new Checkins(extractor);
  const log = config.log ?? new CheckinLog();
  // The Arthur Itis demo: an example person with rheumatoid arthritis. Off by default, so the
  // app shows the real wearable and the real check-ins.
  let demo = false;
  const demoNights = arthritisSource(() => log.today());
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
  app.get('/', (_req, res) => { res.redirect('/auth/'); });
  app.get(['/app', '/app/'], (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://api.elevenlabs.io; worker-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.sendFile(fileURLToPath(new URL('../../index.html', import.meta.url)));
  });
  // Explicit page/asset allowlists: do not expose tests, documentation or the repository.
  for (const page of ['auth', 'onboarding']) {
    app.get(new RegExp(`^/${page}$`), (_req, res) => { res.redirect(`/${page}/`); });
    for (const asset of ['', 'index.html', 'app.js', page === 'auth' ? 'styles.css' : 'style.css']) {
      app.get(`/${page}/${asset}`, (_req, res) => {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.sendFile(fileURLToPath(new URL(`../../${page}/${asset || 'index.html'}`, import.meta.url)));
      });
    }
  }
  // Serve only the browser modules, never the repository or backend secrets.
  app.use('/frontend', express.static(fileURLToPath(new URL('../../frontend/', import.meta.url)), { dotfiles: 'deny', index: false }));
  app.use('/test', (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  }, express.static(fileURLToPath(new URL('../test-ui/', import.meta.url)), { dotfiles: 'deny', index: 'index.html' }));
  app.post('/api/analyze', async (req, res) => {
    const input = analyzeInputSchema.parse(req.body);
    log.screen(input.transcript ?? input.answer?.value); // red-flag screen on everything the person says
    res.json(await store.analyze(input));
  });
  app.post('/api/checkin/save', (req, res) => {
    const saved = store.save(saveInputSchema.parse(req.body));
    log.remember(saved);
    res.json(saved);
  });
  app.post('/api/speech/token', async (_req, res) => {
    if (!config.speechTokenProvider) throw new ApiError(503, 'SPEECH_NOT_CONFIGURED', 'Voice input is not configured. Add ELEVENLABS_API_KEY on the server, or type your check-in.');
    res.json(await config.speechTokenProvider());
  });
  app.post('/api/speech/speak', async (req, res) => {
    const { text } = z.strictObject({ text: z.string().trim().min(1).max(1200) }).parse(req.body);
    if (!config.speechAudioProvider) throw new ApiError(503, 'VOICE_NOT_CONFIGURED', 'Spoken questions need ElevenLabs configured on the server. You can continue using buttons or typing.');
    const audio = await config.speechAudioProvider(text);
    res.type('audio/mpeg').send(Buffer.from(audio));
  });
  app.get('/api/biometrics', async (req, res) => {
    // ?days= sets how many recent nights come back (the card uses 7, the doctor summary 30–90).
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    try {
      if (!config.wearable) throw new BiometricsUnavailable('not_configured', 'No wearable is set up on the server.');
      // The demo keeps the real wearable when the connector answers, and falls back to example nights.
      const source = demo ? await config.wearable.fetchDays(Math.max(38, days)).catch(() => demoNights.fetchDays(Math.max(38, days))) : await config.wearable.fetchDays(Math.max(38, days));
      const rows = source.sort((a, b) => a.date.localeCompare(b.date));
      const last = rows.findLast(r => metricKeys.some(k => r[k] !== null));
      const readings = last ? Object.fromEntries(metricKeys.map(k => [k, reading(rows, k, last, new Set())])) : {};
      res.json({ connected: true, source: config.wearable.name, date: last?.date ?? null, readings, days: rows.slice(-days) });
    } catch (error) {
      if (!(error instanceof BiometricsUnavailable)) throw error;
      res.json({ connected: false, reason: error.reason, message: error.message });
    }
  });
  // "Worth a look" on the home page: a red-flag alert from the latest check-in, plus a nudge when
  // wearable numbers drift from usual while symptoms are being logged. Numbers alone never nudge.
  app.get('/api/nudges', async (_req, res) => {
    let nudges: Nudge[] = [];
    let wearable = config.wearable ? 'connected' : 'not_configured';
    if (config.wearable) {
      try {
        const rows = demo ? await config.wearable.fetchDays(45).catch(() => demoNights.fetchDays(45)) : await config.wearable.fetchDays(45);
        nudges = evaluateNudges(rows, log.days(), log.feedback, log.today());
      } catch (error) {
        if (!(error instanceof BiometricsUnavailable)) throw error;
        wearable = error.reason;
      }
    }
    res.json({ alert: log.currentAlert(), nudges, wearable });
  });
  app.post('/api/nudges/feedback', (req, res) => {
    const { nudgeId, verdict } = z.strictObject({ nudgeId: z.string().max(200), verdict: z.enum(['was_a_flare', 'not_a_flare']) }).parse(req.body);
    log.feedback.push(feedbackFor(nudgeId, verdict));
    res.json({ ok: true });
  });
  app.post('/api/nudges/read-alert', (_req, res) => { log.dismissAlert(); res.json({ ok: true }); });
  // Demo toggle: the example person's week of check-ins, medications, blood pressure and patterns.
  // The patterns quote whichever nights the card is showing, real or example.
  // Enough nights to cover every day the example person checked in on, so the sleep pattern counts them all.
  const nightsInUse = async () => config.wearable ? await config.wearable.fetchDays(40).catch(() => undefined) : undefined;
  app.get('/api/demo', async (_req, res) => { res.json({ on: demo, name: DEMO_NAME, story: demo ? arthritisToday(log.today(), await nightsInUse()) : null }); });
  app.post('/api/demo', async (req, res) => {
    const { on } = z.strictObject({ on: z.boolean() }).parse(req.body);
    demo = on;
    if (on) log.seed(arthritisCheckins(log.today()).map(c => ({ date: c.date, symptoms: c.symptoms.map(s => ({ name: s.name, score: s.score })) })));
    else log.clearSeed();
    res.json({ on: demo, name: DEMO_NAME, story: demo ? arthritisToday(log.today(), await nightsInUse()) : null });
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
