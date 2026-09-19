// Translate allowlisted provider error fields, never expose provider messages,
// project identifiers, transcripts, API keys, or arbitrary error bodies.
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function readError(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) return {};
      chunks.push(value);
    }
    return object(object(JSON.parse(Buffer.concat(chunks).toString('utf8'))).error);
  } catch {
    return {};
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function geminiQuotaReason(response: Response, model: string): Promise<string> {
  const error = await readError(response);
  const details = Array.isArray(error.details) ? error.details.map(object) : [];
  const violations = details.filter(d => d['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure')
    .flatMap(d => Array.isArray(d.violations) ? d.violations.map(object) : []);
  const ids = violations.map(v => typeof v.quotaId === 'string' ? v.quotaId : '');
  const zeroLimit = violations.some(v => v.quotaValue === 0 || v.quotaValue === '0');
  const daily = error.code === 'quota_exceeded' || ids.some(id => /per[_-]?day|daily/i.test(id));
  const minute = ids.some(id => /per[_-]?minute/i.test(id));
  const rate = error.code === 'rate_limit_exceeded' || error.code === 'too_many_requests';
  let reason = zeroLimit
    ? 'Google reports a quota limit of zero. This project currently has no allowance for the requested operation; check its model access and billing.'
    : daily ? 'Google reports a daily quota limit. Waiting a few minutes will not reset a daily quota; check this API key\'s project in AI Studio.'
      : minute ? 'Google reports a per-minute rate limit. Pause requests from all apps sharing this project before retrying.'
        : rate ? 'Google reports a short-term rate limit. Pause requests from all apps sharing this project before retrying.'
          : 'Gemini has reached a rate or quota limit, but Google did not identify which limit in structured error details. Check this API key\'s project in AI Studio.';

  const header = response.headers.get('retry-after');
  const retryDetail = details.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
  const duration = typeof retryDetail?.retryDelay === 'string' && /^\d+(?:\.\d+)?s$/.test(retryDetail.retryDelay)
    ? Number.parseFloat(retryDetail.retryDelay) : NaN;
  const headerSeconds = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header.trim())
    ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
  const waits = [headerSeconds, duration].filter(n => Number.isFinite(n) && n > 0 && n <= 604_800);
  if (!zeroLimit && !daily && waits.length) reason += ` Google recommends waiting at least ${Math.ceil(Math.max(...waits))} seconds before retrying.`;
  // This model is validated by createGeminiExtractor, not taken from the error body.
  return `Gemini model: ${model}. ${reason}`;
}
