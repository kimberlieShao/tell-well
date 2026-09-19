import { ApiError } from './errors.js';

export type SpeechAudioProvider = (text: string) => Promise<Uint8Array>;
export const MAX_SPOKEN_TEXT_LENGTH = 1200;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

// Only the server contacts ElevenLabs with the long-lived API key.
export function createSpeechAudioProvider({
  apiKey,
  voiceId = 'JBFqnCBsd6RMkjVDRZzb',
  modelId = 'eleven_flash_v2_5',
  fetcher = fetch,
  timeoutMs = 20_000,
}: { apiKey: string; voiceId?: string; modelId?: string; fetcher?: typeof fetch; timeoutMs?: number }): SpeechAudioProvider {
  return async (text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_SPOKEN_TEXT_LENGTH) {
      throw new ApiError(400, 'INVALID_SPEECH_TEXT', `Spoken questions must contain between 1 and ${MAX_SPOKEN_TEXT_LENGTH} characters.`);
    }
    if (!apiKey.trim() || !/^[a-zA-Z0-9_-]{1,100}$/.test(voiceId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(modelId)) {
      throw new ApiError(503, 'SPEECH_NOT_CONFIGURED', 'Spoken questions are not configured. You can continue by typing.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: text.trim(), model_id: modelId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) throw new ApiError(503, 'SPEECH_UNAVAILABLE', 'Spoken questions are busy or have reached the service usage limit. You can continue by typing.');
        throw new ApiError(502, 'SPEECH_UNAVAILABLE', 'The speech service could not read this question. Check that the server key has Text to Speech access, or continue by typing.');
      }
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!['audio/mpeg', 'audio/mp3'].includes(contentType ?? '') || Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES || !response.body) {
        throw new ApiError(502, 'SPEECH_UNAVAILABLE', 'The speech service returned invalid audio. You can continue by typing.');
      }
      const reader = response.body.getReader();
      const cancelRead = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelRead, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_AUDIO_BYTES) {
            await reader.cancel();
            throw new ApiError(502, 'SPEECH_UNAVAILABLE', 'The speech service returned invalid audio. You can continue by typing.');
          }
          chunks.push(value);
        }
        if (controller.signal.aborted) throw new Error('Speech response timed out.');
      } finally {
        controller.signal.removeEventListener('abort', cancelRead);
        reader.releaseLock();
      }
      if (!size) throw new ApiError(502, 'SPEECH_UNAVAILABLE', 'The speech service returned no audio. You can continue by typing.');
      const audio = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
      return audio;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'SPEECH_UNAVAILABLE', controller.signal.aborted
        ? 'The speech service took too long to read the question. You can continue by typing.'
        : 'The speech service could not read this question. You can continue by typing.');
    } finally { clearTimeout(timer); }
  };
}
