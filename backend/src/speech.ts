import { ApiError } from './errors.js';

export type SpeechTokenProvider = () => Promise<{ token: string }>;

// The long-lived key stays on the server. Only a single-use Scribe token leaves it.
export function createSpeechTokenProvider({
  apiKey,
  fetcher = fetch,
  timeoutMs = 10_000,
}: { apiKey: string; fetcher?: typeof fetch; timeoutMs?: number }): SpeechTokenProvider {
  return async () => {
    if (!apiKey.trim()) throw new ApiError(503, 'SPEECH_NOT_CONFIGURED', 'Voice input is not configured. Type your check-in instead.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) throw new ApiError(503, 'SPEECH_UNAVAILABLE', 'The speech service is busy or has reached its usage limit. Type your check-in instead.');
        throw new ApiError(502, 'SPEECH_UNAVAILABLE', 'The speech service could not start. Type your check-in instead.');
      }
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string' || !result.token.trim() || result.token.length > 8192) {
        throw new ApiError(502, 'SPEECH_UNAVAILABLE', 'The speech service returned an invalid response. Type your check-in instead.');
      }
      return { token: result.token };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'SPEECH_UNAVAILABLE', controller.signal.aborted
        ? 'The speech service took too long to respond. Type your check-in instead.'
        : 'The speech service could not start. Type your check-in instead.');
    } finally { clearTimeout(timer); }
  };
}
