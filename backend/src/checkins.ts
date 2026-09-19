import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { applyAnswer, fieldPath, isUnknown, questionsFor } from './questions.js';
import { categories, emptyRecord, extractionSchema, recordSchema, responseSchema, type AnalyzeInput, type CheckinResponse, type Extraction, type HealthRecord, type SaveInput } from './schema.js';
import type { Extractor } from './extractor.js';

interface Session {
  id: string; version: number; record: HealthRecord; skipped: string[];
  status: 'collecting' | 'review' | 'saved'; notices: string[];
  savedAt: string | null; expiresAt: number; savedInput?: string;
  numericPain: boolean;
}

function merge(record: HealthRecord, extraction: Extraction): HealthRecord {
  const next = structuredClone(record);
  if (extraction.wellness !== null) next.wellness = structuredClone(extraction.wellness);
  for (const category of categories) {
    const items = next[category] as unknown as Record<string, unknown>[];
    for (const patch of extraction[category]) {
      let target = patch.id ? items.find(item => item.id === patch.id) : undefined;
      if (patch.id && !target) throw new ApiError(502, 'INVALID_EXTRACTION', 'AI referenced an unknown record item. No changes were saved.');
      if (!target && category === 'symptoms') {
        const p = patch as Extraction['symptoms'][number];
        target = items.find(item => String(item.name).toLowerCase() === p.name.toLowerCase()
          && (!p.location || !item.location || String(item.location).toLowerCase() === p.location.toLowerCase()));
      }
      if (!target && category === 'medications') {
        const p = patch as Extraction['medications'][number];
        target = items.find(item => p.name !== null && String(item.name).toLowerCase() === p.name.toLowerCase()
          && item.time === p.time && item.status === p.status);
      }
      if (target) {
        for (const [key, value] of Object.entries(patch)) if (key !== 'id' && value !== null) target[key] = value;
        // A later descriptive answer must not erase an already reported numeric score.
        if ('severityScore' in patch && patch.severityScore !== null && patch.severity === null) target.severity = null;
      } else items.push({ ...patch, id: randomUUID() });
    }
  }
  return recordSchema.parse(next);
}

export class Checkins {
  private sessions = new Map<string, Session>();
  private busy = new Set<string>();
  constructor(private extractor: Extractor, private options: { ttlMs?: number; maxSessions?: number; now?: () => number } = {}) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private expiry() { return this.now() + (this.options.ttlMs ?? 2 * 60 * 60 * 1000); }
  private cleanup() { for (const [id, session] of this.sessions) if (session.expiresAt <= this.now() && !this.busy.has(id)) this.sessions.delete(id); }
  private get(id: string) {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session) throw new ApiError(404, 'SESSION_NOT_FOUND', 'This session expired or the server restarted. Start a new check-in.');
    return session;
  }
  private response(session: Session): CheckinResponse {
    const missing = questionsFor(session.record, { numericPain: session.numericPain });
    const pending = missing.filter(q => !session.skipped.includes(q.id));
    const notices = [...session.notices];
    if (this.extractor.mode === 'demo') notices.unshift('Demo extraction uses limited phrase rules, not AI. It can miss details. Use fictional data and review every field.');
    return responseSchema.parse({
      schemaVersion: '1.0', sessionId: session.id, version: session.version, status: session.status,
      extractionMode: this.extractor.mode, ...session.record,
      missingFields: missing.map(q => fieldPath(session.record, q)),
      skippedFields: missing.filter(q => session.skipped.includes(q.id)).map(q => fieldPath(session.record, q)),
      needsClarification: session.record.medications.some(m => m.name === null),
      nextQuestion: session.status === 'collecting' ? pending[0] ?? null : null,
      notices, storage: 'memory', expiresAt: new Date(session.expiresAt).toISOString(), savedAt: session.savedAt,
    });
  }
  async analyze(input: AnalyzeInput): Promise<CheckinResponse> {
    this.cleanup();
    const existing = input.sessionId ? this.get(input.sessionId) : undefined;
    if (existing && this.busy.has(existing.id)) throw new ApiError(409, 'SESSION_BUSY', 'Wait for the previous request to finish.');
    if (existing && existing.version !== input.version) throw new ApiError(409, 'STALE_VERSION', 'Use the latest session response and version.');
    if (existing?.status === 'saved') throw new ApiError(409, 'ALREADY_SAVED', 'Start a new check-in; this one is already saved.');
    if (!existing && this.sessions.size + this.busy.size >= (this.options.maxSessions ?? 200)) throw new ApiError(503, 'SESSION_LIMIT', 'The demo server is full. Try again after sessions expire.');
    const session: Session = existing ? structuredClone(existing) : {
      id: randomUUID(), version: 0, record: emptyRecord(), skipped: [], status: 'collecting',
      notices: [], savedAt: null, expiresAt: this.expiry(), numericPain: input.painScale === '1-10',
    };
    this.busy.add(session.id);
    try {
      session.notices = [];
      const currentQuestion = session.status === 'collecting'
        ? questionsFor(session.record, { numericPain: session.numericPain }).find(q => !session.skipped.includes(q.id)) ?? null : null;
      const questionId = input.answer?.questionId ?? input.questionId;
      if (questionId && questionId !== currentQuestion?.id) throw new ApiError(409, 'STALE_QUESTION', 'Answer the nextQuestion from the latest response.');
      if (input.action === 'review') session.status = 'review';
      else if (input.action === 'resume') session.status = 'collecting';
      else if (input.action === 'skip') {
        if (!currentQuestion) throw new ApiError(400, 'NO_QUESTION', 'There is no question to skip.');
        session.skipped.push(currentQuestion.id);
      } else {
        session.status = 'collecting';
        const answer = input.answer?.value ?? (questionId ? input.transcript : undefined);
        if (answer && currentQuestion && isUnknown(answer)) session.skipped.push(currentQuestion.id);
        else if (answer && currentQuestion && !(this.extractor.mode === 'gemini' && !input.answer) && applyAnswer(session.record, currentQuestion, answer, !input.answer)) {
          // A direct answer updates only its targeted field.
        } else if (input.answer) {
          throw new ApiError(422, 'INVALID_ANSWER', 'Choose a listed option, enter a clear answer, or skip this question.');
        } else if (input.transcript) {
          const extraction = extractionSchema.parse(await this.extractor.extract(input.transcript, session.record, questionId ? currentQuestion : null));
          if (categories.every(category => extraction[category].length === 0) && extraction.wellness === null)
            session.notices.push('No new structured details were extracted. Rephrase or edit the record during final review.');
          session.record = merge(session.record, extraction);
          // A natural-language answer is a valid report even without an enum match.
          // Keep it for review and avoid repeatedly asking the same question.
          if (answer && currentQuestion && this.extractor.mode === 'gemini'
              && questionsFor(session.record, { numericPain: session.numericPain }).some(q => q.id === currentQuestion.id)) {
            session.skipped.push(currentQuestion.id);
            session.notices.push('Your answer was kept in your own words for review. The unconfirmed field is left blank.');
          }
        }
      }
      if (input.transcript || input.answer) {
        const raw = input.transcript ?? input.answer!.value;
        const target = questionId ? currentQuestion : null;
        const unresolved = target && questionsFor(session.record, { numericPain: session.numericPain }).some(q => q.id === target.id);
        const reports = session.record.reportedAnswers ??= [];
        if (reports.length >= 100) throw new ApiError(422, 'REPORT_LIMIT', 'Please review this check-in before adding more answers.');
        reports.push({questionId:target?.id ?? null,entityId:target?.entityId ?? null,field:target?.field ?? null,
          question:target?.text ?? null,transcript:raw,interpretation:unresolved?'unconfirmed':'recorded'});
      }
      const pending = questionsFor(session.record, { numericPain: session.numericPain }).filter(q => !session.skipped.includes(q.id));
      if (session.status !== 'review') session.status = pending.length ? 'collecting' : 'review';
      session.version += 1;
      session.expiresAt = this.expiry();
      const response = this.response(session); // Validate everything before committing state.
      this.sessions.set(session.id, session);
      return response;
    } finally { this.busy.delete(session.id); }
  }

  save(input: SaveInput): CheckinResponse {
    const existing = this.get(input.sessionId);
    if (this.busy.has(existing.id)) throw new ApiError(409, 'SESSION_BUSY', 'Wait for the previous request to finish.');
    const fingerprint = JSON.stringify(input);
    if (existing.status === 'saved') {
      if (existing.savedInput === fingerprint) return this.response(existing);
      throw new ApiError(409, 'ALREADY_SAVED', 'This session has already been saved.');
    }
    if (existing.version !== input.version) throw new ApiError(409, 'STALE_VERSION', 'Use the latest session response and version.');
    if (existing.status !== 'review') throw new ApiError(409, 'REVIEW_REQUIRED', 'Request action: review, show the record to the user, then save after confirmation.');
    const session = structuredClone(existing);
    if (input.record) {
      const ids = categories.flatMap(c => input.record![c].map(item => item.id));
      if (new Set(ids).size !== ids.length) throw new ApiError(422, 'DUPLICATE_IDS', 'Each record item needs a unique id.');
      session.record = structuredClone(input.record);
      const keptIds = new Set(categories.flatMap(category=>session.record[category].map(item=>item.id)));
      session.record.reportedAnswers = structuredClone(existing.record.reportedAnswers ?? []).filter(answer=>!answer.entityId || keptIds.has(answer.entityId));
    }
    if (categories.every(c => session.record[c].length === 0) && session.record.wellness === null)
      throw new ApiError(422, 'EMPTY_RECORD', 'There are no health details to save.');
    session.status = 'saved'; session.savedAt = new Date(this.now()).toISOString();
    session.version += 1; session.expiresAt = this.expiry(); session.savedInput = fingerprint;
    const response = this.response(session);
    this.sessions.set(session.id, session);
    return response;
  }
}
