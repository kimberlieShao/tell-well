import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import { ZodError, z } from 'zod';
import { BiometricsUnavailable, metricKeys, reading, type BiometricsSource } from './biometrics.js';
import { CheckinLog } from './checkin-log.js';
import { arthritisCheckins, arthritisQuietDays, arthritisRecords, arthritisSource, arthritisToday, DEMO_NAME } from './demo-story.js';
import { evaluateNudges, feedbackFor, type Nudge } from './nudges.js';
import { Checkins } from './checkins.js';
import { ApiError } from './errors.js';
import type { Extractor } from './extractor.js';
import { analyzeInputSchema, saveInputSchema } from './schema.js';
import type { SpeechTokenProvider } from './speech.js';
import { MAX_SPOKEN_TEXT_LENGTH, SPEECH_VOICE_PRESETS, type SpeechAudioProvider } from './tts.js';

export function createApp(extractor: Extractor, config: { origins?: string[]; store?: Checkins; speechTokenProvider?: SpeechTokenProvider; speechAudioProvider?: SpeechAudioProvider; wearable?: BiometricsSource; log?: CheckinLog; demo?: { on?: boolean; locked?: boolean }; checkinLimit?: number; clientIpHeader?: string } = {}) {
  const app = express();
  const store = config.store ?? new Checkins(extractor);
  const log = config.log ?? new CheckinLog();
  // The Arthur Itis demo: an example person with rheumatoid arthritis. Off by default, so the
  // app shows the real wearable and the real check-ins. A public deployment starts it on and locks it
  // (DEMO_DEFAULT=on, DEMO_LOCKED=1): the switch is held in this process's memory, so a restart, or a
  // second instance, must not be able to disagree about it.
  let demo = config.demo?.on ?? false;
  const demoLocked = config.demo?.locked ?? false;
  const demoNights = arthritisSource(() => log.today());
  if (demo) log.seed(arthritisCheckins(log.today()).map(c => ({ date: c.date, symptoms: c.symptoms.map(s => ({ name: s.name, score: s.score })) })));
  // A public deployment spends the owner's Gemini quota, so each visitor (by client address) may start
  // only so many check-ins per day (CHECKIN_DAILY_LIMIT). 0 means no limit, as on a laptop. The counts sit
  // in this process's memory, like the sessions: a restart gives everyone a fresh allowance.
  const perDay = config.checkinLimit ?? 0;
  const startedToday = new Map<string, number>();
  // Behind a platform's proxy every request arrives from the proxy, so the visitor is the address the
  // platform reports in CLIENT_IP_HEADER (Railway: x-real-ip), which it sets itself. Otherwise the socket's.
  const visitorOf = (req: express.Request) => {
    const reported = config.clientIpHeader ? req.get(config.clientIpHeader)?.trim() : undefined;
    return reported || req.ip || 'unknown';
  };
  let countedDay = log.today();
  const started = (visitor: string) => {
    if (log.today() !== countedDay) { startedToday.clear(); countedDay = log.today(); }
    return startedToday.get(visitor) ?? 0;
  };
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
    // Only opening a new check-in counts; answering its follow-up questions does not.
    const opening = perDay > 0 && !input.sessionId;
    const visitor = visitorOf(req);
    if (opening) {
      if (started(visitor) >= perDay) throw new ApiError(429, 'DAILY_CHECKIN_LIMIT', `This demo allows ${perDay} check-in${perDay === 1 ? '' : 's'} per visitor per day. Please come back tomorrow.`);
      startedToday.set(visitor, started(visitor) + 1);
    }
    try {
      log.screen(input.transcript ?? input.answer?.value); // red-flag screen on everything the person says
      res.json(await store.analyze(input));
    } catch (error) {
      if (opening) startedToday.set(visitor, Math.max(0, started(visitor) - 1)); // a check-in that never opened is not used up
      throw error;
    }
  });
  app.get('/api/checkin/limit', (req, res) => {
    const used = perDay > 0 ? started(visitorOf(req)) : 0;
    res.json({ perDay: perDay || null, used, remaining: perDay > 0 ? Math.max(0, perDay - used) : null });
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
    const { text, voice } = z.strictObject({
      text: z.string().trim().min(1).max(MAX_SPOKEN_TEXT_LENGTH),
      voice: z.enum(SPEECH_VOICE_PRESETS).optional(),
    }).parse(req.body);
    if (!config.speechAudioProvider) throw new ApiError(503, 'VOICE_NOT_CONFIGURED', 'Spoken questions need ElevenLabs configured on the server. You can continue using buttons or typing.');
    const audio = await config.speechAudioProvider(text, voice);
    res.type('audio/mpeg').send(Buffer.from(audio));
  });
  app.get('/api/biometrics', async (req, res) => {
    // ?days= sets how many recent nights come back (the card uses 7, the doctor summary 30–90).
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    try {
      if (!config.wearable) throw new BiometricsUnavailable('not_configured', 'No wearable is set up on the server.');
      // The demo keeps the real wearable when the connector answers, and falls back to example nights.
      // If it falls back, say so: "demo" is what makes the card and the doctor summary label the
      // numbers as example data. Never let invented nights go out under the real wearable's name.
      let invented = false;
      const fetched = demo
        ? await config.wearable.fetchDays(Math.max(38, days)).catch(() => { invented = true; return demoNights.fetchDays(Math.max(38, days)); })
        : await config.wearable.fetchDays(Math.max(38, days));
      const rows = fetched.sort((a, b) => a.date.localeCompare(b.date));
      const last = rows.findLast(r => metricKeys.some(k => r[k] !== null));
      const readings = last ? Object.fromEntries(metricKeys.map(k => [k, reading(rows, k, last, new Set())])) : {};
      res.json({ connected: true, source: invented ? 'demo' : config.wearable.name, live: config.wearable.live !== false, date: last?.date ?? null, readings, days: rows.slice(-days) });
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
  app.get('/api/demo', async (_req, res) => { res.json({ on: demo, locked: demoLocked, name: DEMO_NAME, story: demo ? arthritisToday(log.today(), await nightsInUse()) : null }); });
  app.post('/api/demo', async (req, res) => {
    const { on } = z.strictObject({ on: z.boolean() }).parse(req.body);
    if (!demoLocked) {
      demo = on;
      if (on) log.seed(arthritisCheckins(log.today()).map(c => ({ date: c.date, symptoms: c.symptoms.map(s => ({ name: s.name, score: s.score })) })));
      else log.clearSeed();
    }
    res.json({ on: demo, locked: demoLocked, name: DEMO_NAME, story: demo ? arthritisToday(log.today(), await nightsInUse()) : null });
  });
  // What the Records calendar shows: the example person's check-ins while the demo is on, otherwise the
  // confirmed check-ins this server has kept. Check-ins are in the record format (see RECORDS-DATA-FORMAT.md).
  // `quietDays` are days with a short daily reading but no check-in; only the example person has them.
  app.get('/api/records', (_req, res) => {
    res.json(demo
      ? { source: 'demo', name: DEMO_NAME, checkins: arthritisRecords(log.today()), quietDays: arthritisQuietDays(log.today()) }
      : { source: 'real', name: null, checkins: log.savedRecords(), quietDays: [] });
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
