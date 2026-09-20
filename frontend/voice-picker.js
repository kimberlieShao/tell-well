const STORAGE_KEY = 'pulsewise.checkin-voice.v1';
const choices = [
  { value: 'default', label: 'Original voice' },
  { value: 'sarah', label: 'Sarah · Reassuring' },
  { value: 'river', label: 'River · Calm' },
  { value: 'callum', label: 'Callum · Trickster' },
  { value: 'harry', label: 'Harry · Warrior' },
];
const validChoice = value => choices.some(choice => choice.value === value) ? value : 'default';

export function mountVoicePicker(document) {
  const window = document.defaultView;
  const checkin = document.getElementById('dailyCheckinButton');
  if (!window || !checkin) return { getVoice: () => 'default', destroy() {} };
  let selected = 'default';
  try { selected = validChoice(window.localStorage.getItem(STORAGE_KEY)); } catch { /* Use the original voice when storage is unavailable. */ }

  // Keep this control beside the large check-in button, never nested inside it.
  const card = document.createElement('div');
  card.className = 'checkin-voice-card';
  checkin.before(card);
  card.append(checkin);
  const label = document.createElement('label');
  label.className = 'checkin-voice-picker';
  label.htmlFor = 'checkinVoiceSelect';
  const title = document.createElement('span');
  title.textContent = 'Voice';
  const select = document.createElement('select');
  select.id = 'checkinVoiceSelect';
  select.setAttribute('aria-label', 'Check-in voice');
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    select.append(option);
  }
  select.value = selected;
  label.append(title, select);
  card.append(label);
  const onChange = () => {
    selected = validChoice(select.value);
    select.value = selected;
    try { window.localStorage.setItem(STORAGE_KEY, selected); } catch { /* Still use the choice for this visit. */ }
  };
  const onStorage = event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    selected = validChoice(event.newValue);
    select.value = selected;
  };
  select.addEventListener('change', onChange);
  window.addEventListener('storage', onStorage);
  return {
    getVoice: () => selected,
    destroy() {
      select.removeEventListener('change', onChange);
      window.removeEventListener('storage', onStorage);
      card.replaceWith(checkin);
    },
  };
}
