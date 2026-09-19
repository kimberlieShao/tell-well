// "Worth a look" on the home page: a safety alert when a check-in mentioned something urgent,
// and a nudge when wearable numbers drift from usual while symptoms are being logged.

const TIERS = { note: 'Worth a note', watch: 'Worth watching', check_in: 'Check in with your care team' };
const THANKS = {
  not_a_flare: 'Thanks. Pulsewise will wait for a bigger change in these numbers before mentioning them again.',
  was_a_flare: 'Thanks. Pulsewise will mention changes like this a little sooner.',
};
const CALM = {
  connected: 'Nothing worth a look right now. Pulsewise compares your wearable with your check-ins and will say here when the two line up.',
  other: 'Nothing worth a look right now. Connect a device and check in regularly, and patterns will show up here.',
};

export function mountNudges(doc, { apiBase = '' } = {}) {
  const box = doc.getElementById('signalBox');
  if (!box) return;
  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(doc, box, apiBase, refresh), 250);
  };
  refresh();
  // Check again when a check-in closes or is saved (both are handled by new-ui.js).
  const flow = doc.getElementById('checkinFlow');
  if (flow) new MutationObserver(() => { if (!flow.classList.contains('open')) refresh(); })
    .observe(flow, { attributes: true, attributeFilter: ['class'] });
  const history = doc.querySelector('.checkin-history');
  if (history) new MutationObserver(refresh).observe(history, { childList: true });
}

const el = (doc, tag, className, text = '') => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
};

const button = (doc, label, onClick) => {
  const node = el(doc, 'button', 'signal-button', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
};

const post = (apiBase, path, body) => fetch(`${apiBase}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(res => res.ok).catch(() => false);

async function load(doc, box, apiBase, refresh) {
  let data;
  try {
    data = await (await fetch(`${apiBase}/api/nudges`)).json();
  } catch {
    box.replaceChildren(el(doc, 'p', 'signal-calm', "Couldn't check for patterns right now."));
    return;
  }
  const parts = [];
  if (data.alert) parts.push(alertView(doc, data.alert, apiBase, refresh));
  for (const nudge of data.nudges ?? []) parts.push(nudgeView(doc, nudge, apiBase));
  if (!parts.length) parts.push(el(doc, 'p', 'signal-calm', CALM[data.wearable] ?? CALM.other));
  box.replaceChildren(...parts);
}

function alertView(doc, alert, apiBase, refresh) {
  const wrap = el(doc, 'div', `signal-alert ${alert.level}`);
  wrap.setAttribute('role', 'alert');
  wrap.append(el(doc, 'strong', '', alert.level === 'emergency' ? 'This may need emergency care' : 'Worth contacting your provider today'));
  wrap.append(el(doc, 'p', '', alert.advice));
  const actions = el(doc, 'div', 'signal-actions');
  const crisis = alert.flags.some(flag => flag.code === 'self_harm');
  if (alert.level === 'emergency') {
    const call = el(doc, 'a', 'signal-call', crisis ? 'Call or text 988' : 'Call 911');
    call.href = crisis ? 'tel:988' : 'tel:911';
    actions.append(call);
  }
  actions.append(button(doc, "I've read this", async () => {
    await post(apiBase, '/api/nudges/read-alert', {});
    refresh();
  }));
  wrap.append(actions);
  return wrap;
}

function nudgeView(doc, nudge, apiBase) {
  const wrap = el(doc, 'div', `signal-nudge ${nudge.tier}`);
  wrap.append(el(doc, 'span', 'signal-tier', TIERS[nudge.tier] ?? 'Worth a look'));
  wrap.append(el(doc, 'strong', '', nudge.title));
  wrap.append(el(doc, 'p', '', nudge.message));
  const why = el(doc, 'details');
  why.append(el(doc, 'summary', '', 'Why am I seeing this?'));
  const reasons = el(doc, 'ul');
  for (const reason of nudge.reasons) reasons.append(el(doc, 'li', '', reason));
  why.append(reasons);
  wrap.append(why);
  const actions = el(doc, 'div', 'signal-actions');
  for (const [verdict, label] of [['was_a_flare', 'That was a flare'], ['not_a_flare', 'Not a flare']]) {
    actions.append(button(doc, label, async () => {
      actions.replaceChildren(el(doc, 'p', 'signal-thanks', 'Saving…'));
      const saved = await post(apiBase, '/api/nudges/feedback', { nudgeId: nudge.id, verdict });
      actions.replaceChildren(el(doc, 'p', 'signal-thanks', saved ? THANKS[verdict] : "Couldn't save that. Try again in a moment."));
    }));
  }
  wrap.append(actions);
  return wrap;
}
