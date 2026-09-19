import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { demoExtractor } from '../src/extractor.js';

test('spoken question route validates text, returns audio, and keeps origin/cache protections', async () => {
  const calls: string[] = [];
  const app = createApp(demoExtractor, {speechAudioProvider: async text => {calls.push(text);return new Uint8Array([73,68,51,4,0]);}});
  const server = app.listen(0,'127.0.0.1');await once(server,'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const post = (body: unknown, origin?: string) => fetch(`${base}/api/speech/speak`,{method:'POST',headers:{'Content-Type':'application/json',...(origin ? {Origin:origin} : {})},body:JSON.stringify(body)});
    const response = await post({text:'How are you feeling?'});
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type')!,/audio\/mpeg/);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await response.arrayBuffer()).byteLength,5);
    assert.equal((await post({text:''})).status,400);
    assert.equal((await post({text:'a'.repeat(1201)})).status,400);
    assert.equal((await post({text:'Question',apiKey:'not-accepted'})).status,400);
    assert.equal((await post({text:'Question'},'https://unrelated.invalid')).status,403);
    assert.deepEqual(calls,['How are you feeling?']);
    const page = await fetch(`${base}/app`);
    assert.match(page.headers.get('content-security-policy')!,/media-src 'self' blob:/);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('missing spoken question configuration returns a recoverable JSON error',async()=>{
  const server=createApp(demoExtractor).listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/speech/speak`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'How are you feeling?'})});
    assert.equal(response.status,503);
    assert.equal((await response.json()).error.code,'VOICE_NOT_CONFIGURED');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
