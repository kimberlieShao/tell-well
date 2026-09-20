import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { localDate } from '../src/checkin-log.js';
import { arthritisToday } from '../src/demo-story.js';

// The top bar: the avatar opens the Profile page (More > Profile), showing the example person, read-only,
// while the Demo person switch is on. The old diamond button did nothing and is gone. No network, no Gemini.
const uiUrl = new URL('../../frontend/new-ui.js', import.meta.url).href;
const recordsUrl = new URL('../../frontend/records.js', import.meta.url).href;
const toggleUrl = new URL('../../frontend/demo-toggle.js', import.meta.url).href;
const readText = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ownProfile = { displayName: 'Kimberly', ageRange: '60–69', conditions: ['POTS'], dietaryPreferences: [], allergies: ['Penicillin'], trackingPreferences: [], devices: [], profileNotes: '', medications: [], onboardingCompleted: true, accessibility: { textSize: 'normal' } };
const EXAMPLE_SENTENCE = 'This is an example profile. Turn off Demo person to see and edit your own.';

async function withTopbar(run: (page: any) => Promise<void>, { demo = false, profile = true }: { demo?: boolean; profile?: boolean } = {}) {
  const dom = new JSDOM(await readText('index.html'), { url: 'https://example.test/app', runScripts: 'outside-only' });
  const window = dom.window as any;
  window.structuredClone = structuredClone; window.scrollTo = () => {};
  window.eval(await readText('frontend/profile-store.js'));
  if (profile) window.PulsewiseProfile.save(ownProfile);
  const { mountVersionB } = await import(uiUrl);
  const { mountRecords } = await import(recordsUrl);
  const { mountDemoToggle } = await import(toggleUrl);
  const document = window.document as Document;
  const originalFetch = globalThis.fetch;
  const story = arthritisToday(localDate(new Date()));
  globalThis.fetch = (async () => Response.json({ on: demo, name: 'Arthur Itis', story: demo ? story : null })) as typeof fetch;
  const app = mountVersionB(document, {
    initialProfile: profile ? window.PulsewiseProfile.read() : null, profileStore: profile ? window.PulsewiseProfile : null,
    conversationEnabled: false, speechFactory: () => ({ available: false, cancel() {}, destroy() {} }), speakerFactory: () => ({ stop() {}, destroy() {} }),
  });
  const records = mountRecords(document, { load: async () => ({ source: 'real', name: null, checkins: [], quietDays: [] }) });
  mountDemoToggle(document);
  const page = {
    window, document, dom,
    $: (selector: string) => document.querySelector(selector) as HTMLElement,
    click: (selector: string) => { const node = document.querySelector<HTMLElement>(selector); assert.ok(node, selector); node.click(); },
    text: () => document.getElementById('moreDetailBody')!.textContent!,
    profileOpen: () => !(document.getElementById('moreDetail') as HTMLElement).hidden && (document.getElementById('moreDetail') as HTMLElement).dataset.subview === 'profile',
  };
  try {
    if (demo) for (let i = 0; i < 200 && !document.body.classList.contains('demo-on'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    if (demo) assert.ok(document.body.classList.contains('demo-on'), 'the demo switch never turned on');
    await run(page);
  } finally { records?.destroy(); app.destroy(); globalThis.fetch = originalFetch; dom.window.close(); }
}

test('the diamond button is gone; the top bar holds the demo switch and the avatar', async () => {
  await withTopbar(async page => {
    assert.equal(page.$('.icon-button'), null);
    assert.equal(page.document.querySelector('[aria-label="Notifications"]'), null);
    assert.ok(!page.$('.top-actions').textContent!.includes('♢'));
    assert.deepEqual([...page.$('.top-actions').children].map((node: Element) => node.id), ['demoToggle', 'profileButton']);
    // Notification settings are still in More; only the do-nothing top-bar button went.
    assert.ok(page.$('[data-more="notifications"]'));
  });
});

test('the avatar is a real button with a name, and it shows the first letter of the profile name', async () => {
  await withTopbar(async page => {
    const avatar = page.$('#profileButton');
    assert.equal(avatar.tagName, 'BUTTON');
    assert.equal(avatar.getAttribute('type'), 'button');
    assert.equal(avatar.getAttribute('aria-label'), 'Open your profile');
    assert.ok(avatar.classList.contains('avatar'));
    assert.equal(avatar.textContent, 'M'); // the default name in this prototype
    assert.equal(avatar.tabIndex, 0);
    assert.match(await readText('frontend/home.css'), /button\.avatar:focus-visible\s*\{[^}]*outline/);
  }, { profile: false });
});

test('clicking the avatar opens the Profile page in More, and Back goes to the More menu', async () => {
  await withTopbar(async page => {
    assert.equal((page.$('#moreView') as HTMLElement).hidden, true);
    page.click('#profileButton');
    assert.equal((page.$('#moreView') as HTMLElement).hidden, false);
    assert.equal((page.$('.patient-home') as HTMLElement).hidden, true);
    assert.ok(page.profileOpen());
    assert.equal((page.$('.more-menu') as HTMLElement).hidden, true);
    assert.ok(page.$('#desktopMoreNav').classList.contains('active'));
    assert.ok(page.$('#moreNav').classList.contains('active'));
    assert.match(page.text(), /Kimberly/);
    page.click('#moreDetailBack');
    assert.equal((page.$('.more-menu') as HTMLElement).hidden, false);
    assert.equal((page.$('#moreDetail') as HTMLElement).hidden, true);
    // From another tab, too.
    page.click('#desktopRecordsNav');
    assert.equal((page.$('#recordsView') as HTMLElement).hidden, false);
    page.click('#profileButton');
    assert.equal((page.$('#recordsView') as HTMLElement).hidden, true);
    assert.ok(page.profileOpen());
  });
});

test('with the demo off, the avatar opens the reader\'s own profile, with the link to edit it', async () => {
  await withTopbar(async page => {
    assert.equal(page.$('#profileButton').textContent, 'K');
    page.click('#profileButton');
    assert.match(page.text(), /Kimberly/);
    assert.match(page.text(), /Penicillin/);
    assert.equal(page.$('a.profile-setup-link')!.getAttribute('href'), '/onboarding/?edit=profile');
    assert.equal(page.$('[data-example-profile]'), null);
    assert.doesNotMatch(page.text(), /Example profile|Arthur/);
  }, { demo: false });
});

test('with the demo on, the avatar opens Arthur\'s example profile: read-only, labelled, with only what the demo file holds', async () => {
  await withTopbar(async page => {
    assert.equal(page.$('#profileButton').textContent, 'A');
    page.click('#profileButton');
    assert.ok(page.profileOpen());
    const card = page.$('[data-example-profile]');
    assert.ok(card);
    assert.equal(card.firstElementChild!.textContent, 'Example profile'); // at the top
    assert.equal(card.querySelector('h2')!.textContent, 'Profile');
    assert.ok(card.textContent!.includes(EXAMPLE_SENTENCE));
    const rows = [...card.querySelectorAll('.more-detail-row')].map((row: Element) => [row.querySelector('span')!.childNodes[0]!.textContent, row.querySelector('strong')!.textContent]);
    assert.deepEqual(rows, [['Name', 'Arthur Itis'], ['Condition', 'Rheumatoid arthritis'], ['Methotrexate', '15 mg'], ['Folic acid', '1 mg'], ['Ibuprofen', '400 mg']]);
    assert.match(card.textContent!, /Weekly tablet for rheumatoid arthritis/);
    assert.match(card.textContent!, /For pain, as needed/);
    // Nothing the demo file does not have, and nothing to edit.
    assert.doesNotMatch(card.textContent!, /Not provided|Age|Allerg|Date of birth|Emergency|Diet/);
    assert.equal(card.querySelectorAll('a, button, input, textarea, select').length, 0);
    assert.equal(page.$('a.profile-setup-link'), null);
    assert.equal(page.$('[data-action="edit-profile"]'), null);
    assert.doesNotMatch(page.text(), /Kimberly|Penicillin/); // the reader's own details are not shown
  }, { demo: true });
});

test('the Profile card in More shows the same example profile while the demo is on, and the real one when it is off', async () => {
  await withTopbar(async page => {
    page.click('#desktopMoreNav');
    page.click('[data-more="profile"]');
    assert.ok(page.$('[data-example-profile]'));
    assert.match(page.text(), /Arthur Itis/);
    // Turning the demo off reloads the page in a browser; here the class just goes, and the real profile is back.
    page.document.body.classList.remove('demo-on');
    page.click('#moreDetailBack');
    page.click('[data-more="profile"]');
    assert.equal(page.$('[data-example-profile]'), null);
    assert.match(page.text(), /Kimberly/);
  }, { demo: true });
});
