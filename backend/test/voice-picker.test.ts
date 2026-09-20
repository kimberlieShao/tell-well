import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const { mountVoicePicker } = await import(new URL('../../frontend/voice-picker.js', import.meta.url).href);
const storageKey = 'pulsewise.checkin-voice.v1';
function page() {
  return new JSDOM('<button id="dailyCheckinButton">Check-in</button>', { url: 'https://example.test/app' });
}

test('voice selection stays separate from starting check-in, persists, and restores after remount', () => {
  const dom = page();
  const { document } = dom.window;
  let starts = 0;
  document.getElementById('dailyCheckinButton')!.addEventListener('click', () => starts++);
  let picker = mountVoicePicker(document);
  try {
    const select = document.getElementById('checkinVoiceSelect') as HTMLSelectElement;
    assert.equal(select.closest('button'), null);
    assert.equal(select.options.length, 5);
    assert.equal(select.querySelector('option[value="callum"]')!.textContent, 'Callum · Trickster');
    assert.equal(select.querySelector('option[value="harry"]')!.textContent, 'Harry · Warrior');
    assert.equal(picker.getVoice(), 'default');
    for (const voice of ['sarah', 'river', 'callum', 'harry', 'default']) {
      select.click();
      select.value = voice;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      assert.equal(picker.getVoice(), voice);
      assert.equal(starts, 0, 'Choosing a voice must not activate the microphone or check-in');
    }
    select.value = 'callum';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(dom.window.localStorage.getItem(storageKey), 'callum');
    picker.destroy();
    picker = mountVoicePicker(document);
    assert.equal(picker.getVoice(), 'callum');
    assert.equal(document.querySelectorAll('.checkin-voice-card').length, 1);
    document.getElementById('dailyCheckinButton')!.click();
    assert.equal(starts, 1, 'The original check-in action remains attached');
  } finally { picker.destroy(); dom.window.close(); }
});

test('unknown stored choices fall back and unavailable storage still permits a voice for this visit', () => {
  const dom = page();
  dom.window.localStorage.setItem(storageKey, 'untrusted-id');
  let picker = mountVoicePicker(dom.window.document);
  assert.equal(picker.getVoice(), 'default');
  picker.destroy();
  Object.defineProperty(dom.window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  picker = mountVoicePicker(dom.window.document);
  try {
    const select = dom.window.document.getElementById('checkinVoiceSelect') as HTMLSelectElement;
    select.value = 'harry';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(picker.getVoice(), 'harry');
  } finally { picker.destroy(); dom.window.close(); }
});
