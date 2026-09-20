import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const speechModule = new URL('../../frontend/elevenlabs-speech.js', import.meta.url).href;
const termsModule = new URL('../../frontend/speech-terms.js', import.meta.url).href;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('the transcriber is asked for English and nudged towards medication names', async () => {
  const { createElevenLabsSpeechInput } = await import(speechModule);
  const dom = new JSDOM('<textarea></textarea>');
  const urls: string[] = [];
  class Socket {
    readyState = 1; bufferedAmount = 0; messages: any[] = [];
    onmessage: ((event: any) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string) { urls.push(url); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ message_type: 'session_started' }) })); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const speech = createElevenLabsSpeechInput({
    textarea: dom.window.document.querySelector('textarea')!,
    keyterms: ['methotrexate', 'joint pain'],
    fetchImpl: async () => Response.json({ token: 'single-use-test-token' }),
    WebSocketImpl: Socket,
    captureFactory: async () => ({ start() {}, cancel() {}, async finish() {} }),
  });
  try {
    speech.start();
    for (let i = 0; i < 50 && !urls.length; i++) await tick();
    const query = new URL(urls[0].replace('wss://', 'https://')).searchParams;
    assert.equal(query.get('language_code'), 'en', 'English only, so short clips are never read as another language');
    assert.deepEqual(query.getAll('keyterms'), ['methotrexate', 'joint pain']);
  } finally {
    speech.destroy();
    dom.window.close();
  }
});

test('keyterms stay inside the realtime limits', async () => {
  const { speechKeyterms, GENERAL_TERMS } = await import(termsModule);
  const terms = speechKeyterms(['Methotrexate', 'methotrexate', 'a name that is far too long to send', '<bad>']);
  assert.ok(terms.length <= 50);
  assert.ok(terms.every((term: string) => term.length <= 20 && !/[<>{}[\]\\]/.test(term)));
  assert.equal(terms[0], 'Methotrexate');
  assert.equal(terms.filter((term: string) => term.toLowerCase() === 'methotrexate').length, 1, 'no duplicates');
  assert.ok(terms.includes(GENERAL_TERMS[0]));
});
