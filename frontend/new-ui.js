import { createCheckinClient } from './checkin-api.js';
import { createElevenLabsSpeechInput, createVoiceSpeechFactory } from './elevenlabs-speech.js';
import { normalizeBackendResponse, toBackendRecord } from './version-b-adapter.js';
import { createElevenLabsSpeaker } from './elevenlabs-speaker.js';
import { createVoiceConversation } from './voice-conversation.js';

export function mountVersionB(document, {client = createCheckinClient({painScale:'1-10'}), mealClient = createCheckinClient(), speechFactory = createElevenLabsSpeechInput, speakerFactory = createElevenLabsSpeaker, conversationEnabled = true, initialProfile = null, profileStore = null} = {}) {
  const window = document.defaultView;
  let conversation = null;

    const modal = document.getElementById('consentModal');
    const description = document.getElementById('modalDescription');
    const closeModal = () => modal.classList.remove('open');
    document.querySelectorAll('[data-source]').forEach((button) => button.addEventListener('click', () => {
      description.textContent = `Choose the data Alex has agreed to share from ${button.dataset.source}. You can change this scope at any time.`;
      modal.classList.add('open');
    }));
    document.getElementById('manageButton').addEventListener('click', () => {
      description.textContent = 'Choose the data Alex has agreed to share. You can change this scope at any time.';
      modal.classList.add('open');
    });
    document.getElementById('cancelButton').addEventListener('click', closeModal);
    document.getElementById('confirmButton').addEventListener('click', () => {
      closeModal();
      const button = document.querySelector('[data-source]');
      button.textContent = 'Pending';
      button.disabled = true;
      button.style.opacity = '.65';
    });
    modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });

    const checkinDate = document.getElementById('checkinDate');
    const painLevel = document.getElementById('painLevel');
    const painValue = document.getElementById('painValue');
    const logRows = document.getElementById('logRows');
    const symptomChart = document.getElementById('symptomChart');
    const emptyLog = document.getElementById('emptyLog');
    const today = new Date();
    document.getElementById('patientDate').textContent = today.toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric'});
    checkinDate.value = today.toISOString().slice(0, 10);
    painLevel.addEventListener('input', () => { painValue.textContent = `${painLevel.value} / 10`; });
    document.getElementById('checkinForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const words = [document.getElementById('journalNote').value, document.getElementById('dietNote').value, document.getElementById('medicationNote').value].filter(Boolean).join('. ');
      openCheckinFlow(); flowTranscript.value = words; showFlowScreen('listening');
    });
    document.getElementById('clearLogButton').addEventListener('click', () => {
      logRows.innerHTML = '';
      symptomChart.innerHTML = '';
      emptyLog.hidden = false;
    });
    document.getElementById('printButton').addEventListener('click', () => window.print());
    document.getElementById('exportButton').addEventListener('click', () => {
      const rows = [...logRows.querySelectorAll('tr')].map((row) => [...row.children].map((cell) => cell.innerText.replace(/\n/g, ' - ')).join('\t'));
      const report = ['PULSEWISE PATIENT HEALTH SUMMARY', `Generated: ${new Date().toLocaleString()}`, '', 'QUALITATIVE CHECK-INS', 'Date\tEntry\tIntensity', ...rows].join('\n');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([report], { type: 'text/plain' }));
      link.download = 'pulsewise-provider-summary.txt';
      link.click();
      URL.revokeObjectURL(link.href);
    });

    const micButton = document.getElementById('micButton');
    const voiceStatus = document.getElementById('voiceStatus');
    const transcript = document.getElementById('transcript');
    const speakPrompt = document.getElementById('speakPrompt');
    speakPrompt.addEventListener('click', () => {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new window.SpeechSynthesisUtterance('Tell me how you are feeling. You can mention symptoms, medications, meals, or measurements.');
      utterance.rate = 0.9;
      utterance.onstart = () => { speakPrompt.textContent = '◖ Reading prompt...'; };
      utterance.onend = () => { speakPrompt.textContent = '◖ Read prompt aloud'; };
      window.speechSynthesis.speak(utterance);
    });
    const recognizers = new Set();
    function createSpeechRecognizer(textarea, { onStart, onEnd, onError, onStatus } = {}) {
      const speech = speechFactory({ textarea, onStatus: (status) => {
        if (status?.type === 'error' || status?.type === 'unavailable') onError?.(status.message);
        if (status?.type === 'idle') onEnd?.();
        onStatus?.(status);
      }});
      const recognizer = {
        async start() { try { await speech.start(); onStart?.(); } catch (error) { onError?.(error.message); } },
        async stop() { const text = await speech.finish(); onEnd?.(); return text; },
        cancel() { speech.cancel(); },
        isActive: () => speech.isActive,
        get mode() { return speech.mode; },
        destroy() { speech.destroy(); recognizers.delete(recognizer); },
      };
      recognizers.add(recognizer);
      return recognizer;
    }
    const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[char]));
    const checkinHistory = [];
    const micRecognizer = createSpeechRecognizer(transcript, {
      onStart: () => { micButton.textContent = '■'; voiceStatus.textContent = 'Listening…'; },
      onEnd: () => { micButton.textContent = '●'; voiceStatus.textContent = 'Review or edit your words before continuing.'; },
      onError: (message) => { voiceStatus.textContent = message; },
    });
    micButton.addEventListener('click', async () => {
      try { if (micRecognizer.isActive()) await micRecognizer.stop(); else await micRecognizer.start(); }
      catch (error) { voiceStatus.textContent = error.message; }
    });
    document.getElementById('confirmCheckin').addEventListener('click', async () => {
      try { const text = await micRecognizer.stop(); openCheckinFlow(); flowTranscript.value = text; showFlowScreen('listening'); }
      catch (error) { voiceStatus.textContent = error.message; }
    });
    const checkinFlow = document.getElementById('checkinFlow');
    const flowScreens = [...checkinFlow.querySelectorAll('[data-screen]')];
    const flowStep = document.getElementById('flowStep');
    const flowProgress = document.getElementById('flowProgress');
    let currentFlowScreen = 'intro';
    const flowOrder = ['intro', 'listening', 'topics', 'guided', 'additional', 'medication', 'vital', 'review', 'trends'];
    const showFlowScreen = (screenName) => {
      currentFlowScreen = screenName;
      flowScreens.forEach((screen) => { screen.hidden = screen.dataset.screen !== screenName; });
      const steps = {intro:1,listening:2,topics:3,'pain-score':4,additional:4,medication:4,guided:4,vital:4,review:5,trends:6};
      flowStep.textContent = screenName === 'trends' ? 'Saved' : `Step ${steps[screenName] || 4} of 6`;
      flowProgress.style.width = `${((steps[screenName] || 4) / 6) * 100}%`;
      if (screenName === 'listening') { setListeningDisplay(flowVoiceRecognizer.isActive()); document.getElementById('flowTranscript').focus(); }
      if (screenName === 'review') renderReview();
    };
    const stopAllVoice = () => { for (const recognition of recognizers) recognition.cancel(); };
    const openCheckinFlow = () => {
      if (uiBusy) return;
      if (conversation?.active) conversation.stop();
      stopAllVoice();
      resetCheckinState();
      checkinFlow.classList.add('open');
      showFlowScreen('intro');
    };
    const closeCheckinFlow = () => {
      if (conversation?.active) conversation.stop();
      stopAllVoice();
      checkinFlow.classList.remove('open');
    };
    document.getElementById('dailyCheckinButton').addEventListener('click', () => {
      if (uiBusy) return;
      openCheckinFlow();
      if (conversationEnabled) startVoiceConversation();
    });
    document.getElementById('typeCheckinButton')?.addEventListener('click', () => {
      if (uiBusy) return;
      openCheckinFlow(); showFlowScreen('listening');
    });
    function setPatientNavActive(view) {
      document.querySelectorAll('.nav-button').forEach((btn) => btn.classList.remove('active'));
      document.querySelectorAll('.mobile-nav-item').forEach((btn) => btn.classList.remove('active'));
      const desktopIds = { home: 'desktopHomeNav', meals: 'desktopMealsNav', trends: 'desktopTrendsNav', more: 'desktopMoreNav' };
      const mobileIds = { home: 'homeNav', meals: 'mealsNav', trends: 'trendsNav', more: 'moreNav' };
      const desktopBtn = document.getElementById(desktopIds[view]);
      const mobileBtn = document.getElementById(mobileIds[view]);
      if (desktopBtn) desktopBtn.classList.add('active');
      if (mobileBtn) mobileBtn.classList.add('active');
    }
    function showPatientView(view) {
      if (conversation?.active) conversation.stop();
      stopAllVoice();
      const home = document.querySelector('.patient-home');
      const meals = document.getElementById('mealsView');
      const trends = document.getElementById('trendsView');
      const more = document.getElementById('moreView');
      home.hidden = view !== 'home';
      meals.hidden = view !== 'meals';
      trends.hidden = view !== 'trends';
      more.hidden = view !== 'more';
      if (view === 'home') window.scrollTo({ top: 0, behavior: 'smooth' });
      if (view === 'meals') { showMealsMain(); renderMealsMain(); }
      if (view === 'more') showMoreMain();
      setPatientNavActive(view);
    }
    document.getElementById('desktopHomeNav').addEventListener('click', () => showPatientView('home'));
    document.getElementById('desktopMealsNav').addEventListener('click', () => showPatientView('meals'));
    document.getElementById('desktopTrendsNav').addEventListener('click', () => showPatientView('trends'));
    document.getElementById('desktopMoreNav').addEventListener('click', () => showPatientView('more'));

    // Single frontend source of truth for patient-facing Trends and More content.
    // User-editable profile and medication list; health history starts empty.
    const patientState = {
      profile: {
        firstName: initialProfile ? (initialProfile.displayName || 'there') : 'Mary',
        dateOfBirth: initialProfile ? '' : '1958-03-04',
        preferredLanguage: 'English',
        emergencyContact: initialProfile ? '' : 'Daniel (Son)',
      },
      medications: structuredClone(initialProfile?.medications || []),
      trends: Object.fromEntries([['7d','Last 7 days'],['30d','Last 30 days'],['3m','Last 3 months']].map(([key,rangeLabel]) => [key, {
        rangeLabel, painAverage:'—', painTrendLabel:'No recorded data', painTrendClass:'stable',
        bloodPressure:'—', bpTrendLabel:'No recorded data', bpTrendClass:'stable', glucose:'—', glucoseTrendLabel:'No recorded data', glucoseTrendClass:'stable',
        medicationAdherence:'—', missedDoses:0, painSeries:[], painLabels:[],
      }])),
    };

    function formatDateOfBirth(iso) {
      if(!iso)return 'Not provided';
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }

    function updateHomeGreeting() {
      const name = patientState.profile.firstName;
      const heading = document.querySelector('.patient-greeting h1');
      if (heading) heading.textContent = `Good morning, ${name}`;
      const avatar = document.querySelector('.topbar .avatar');
      if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
      const crumb = document.querySelector('.topbar .crumb');
      if (crumb) crumb.textContent = `${name} / Home`;
      const profileCardSubtitle = document.querySelector('[data-more="profile"] .more-card-copy span');
      if (profileCardSubtitle) profileCardSubtitle.textContent = `${name} · Personal information and preferences`;
    }

    function updateMedicationCardSubtitle() {
      const el = document.querySelector('[data-more="medications"] .more-card-copy span');
      const count = patientState.medications.length;
      if (el) el.textContent = `${count} active medication${count === 1 ? '' : 's'}`;
    }

    if(profileStore){
      window.addEventListener('pulsewise:profile',event=>{
        patientState.medications=structuredClone(event.detail.medications||[]);
        updateMedicationCardSubtitle();
        if(!document.getElementById('moreDetail').hidden&&document.getElementById('moreDetail').dataset.subview==='medications')renderMoreSubview('medications');
      });
    }

    // ---------- Trends: renderTrends(range) drives every number/chart on the page ----------
    let currentTrendRange = '7d';
    function renderTrends(range) {
      const data = patientState.trends[range];
      if (!data) return;
      currentTrendRange = range;
      document.querySelectorAll('.trend-range-button').forEach((b) => b.classList.toggle('active', b.dataset.range === range));
      document.querySelectorAll('.trend-range-label').forEach((label) => { label.textContent = data.rangeLabel; });

      document.getElementById('trendPainAvg').textContent = data.painAverage;
      const painTrendEl = document.getElementById('trendPainTrend');
      painTrendEl.textContent = data.painTrendLabel;
      painTrendEl.className = `trend-summary-trend ${data.painTrendClass}`;

      document.getElementById('trendBPAvg').textContent = data.bloodPressure;
      const bpTrendEl = document.getElementById('trendBPTrend');
      bpTrendEl.textContent = data.bpTrendLabel;
      bpTrendEl.className = `trend-summary-trend ${data.bpTrendClass}`;

      document.getElementById('trendGlucoseAvg').textContent = data.glucose;
      const glucoseTrendEl = document.getElementById('trendGlucoseTrend');
      glucoseTrendEl.textContent = data.glucoseTrendLabel;
      glucoseTrendEl.className = `trend-summary-trend ${data.glucoseTrendClass}`;

      document.getElementById('trendMedAdherence').textContent = data.medicationAdherence;
      const missedText = data.medicationAdherence === '—' ? 'No recorded data' : `${data.missedDoses} missed dose${data.missedDoses === 1 ? '' : 's'}`;
      document.getElementById('trendMedMissed').textContent = missedText;
      document.getElementById('trendMedMeta').textContent = `${missedText} · ${data.rangeLabel}`;
      document.getElementById('trendAdherenceFill').style.width = `${typeof data.medicationAdherence === 'number' ? data.medicationAdherence : 0}%`;
      document.getElementById('trendAdherenceLabel').textContent = `${data.medicationAdherence}% adherence · ${data.rangeLabel.toLowerCase()}`;

      document.getElementById('trendBars').innerHTML = data.painSeries.map((value, i) => `
        <div class="trend-bar-group">
          <span class="trend-bar-value">${value}</span>
          <div class="trend-bar${i === data.painSeries.length - 1 ? ' highlight' : ''}" style="height: ${value * 10}%"></div>
          <label>${data.painLabels[i]}</label>
        </div>`).join('');

      document.getElementById('trendMedAdherenceList').innerHTML = patientState.medications.map((med) => `
        <div class="med-adherence-row"><span>${escapeHTML(med.name)} ${escapeHTML(med.dose)}</span><strong>${data.medicationAdherence}% taken</strong></div>`).join('');
    }
    document.querySelectorAll('.trend-range-button').forEach((button) => {
      button.addEventListener('click', () => renderTrends(button.dataset.range));
    });
    renderTrends(currentTrendRange);
    updateHomeGreeting();
    updateMedicationCardSubtitle();

    // ---------- More: showMoreMain()/showMoreSubview(key) — menu and subview are never both visible ----------
    let moreEditingProfile = false;
    let medicationFormMode = { type: 'list' };

    function profileViewTemplate() {
      if(initialProfile){
        const p=profileStore.read();
        const describe=value=>value===null||value===undefined?'Not provided':Array.isArray(value)?value.join(', ')||'None':String(value);
        const rows=[['Name',p.displayName||'Not provided'],['Age group',p.ageRange],['Health background',p.conditions],['Diet preferences',p.dietaryPreferences],['Allergies',p.allergies],['Tracking',p.trackingPreferences],['Devices (selected only)',p.devices],['Notes',p.profileNotes||'Not provided']];
        const photo=typeof p.photo==='string'&&/^data:image\/(png|jpeg|webp);base64,/.test(p.photo)?`<img class="profile-summary-photo" src="${escapeHTML(p.photo)}" alt="Your profile photo">`:'';
        return `<article class="card more-detail-panel"><h2>Profile</h2>${photo}<p class="profile-integration-note">Demo profile · saved in this browser tab, not a signed-in account.</p>${rows.map(([label,value])=>`<div class="more-detail-row"><span>${label}</span><strong>${escapeHTML(describe(value))}</strong></div>`).join('')}<a class="profile-setup-link" href="/onboarding/?edit=profile">Edit profile & photo</a></article>`;
      }

      const p = patientState.profile;
      return `<article class="card more-detail-panel">
        <h2>Profile</h2>
        <p class="more-detail-meta">Personal information and preferences</p>
        <div class="more-detail-list">
          <div class="more-detail-row"><span>Name</span><strong>${escapeHTML(p.firstName)}</strong></div>
          <div class="more-detail-row"><span>Date of birth</span><strong>${formatDateOfBirth(p.dateOfBirth)}</strong></div>
          <div class="more-detail-row"><span>Preferred language</span><strong>${escapeHTML(p.preferredLanguage)}</strong></div>
          <div class="more-detail-row"><span>Emergency contact</span><strong>${escapeHTML(p.emergencyContact)}</strong></div>
        </div>
        <button class="more-detail-button" data-action="edit-profile">Edit profile</button>
      </article>`;
    }
    function profileEditTemplate() {
      const p = patientState.profile;
      const languages = ['English', 'Spanish', 'Mandarin', 'Other'];
      return `<article class="card more-detail-panel">
        <h2>Edit Profile</h2>
        <div class="field" style="margin-bottom: 14px"><label>Name</label><input id="editProfileName" type="text" value="${escapeHTML(p.firstName)}"></div>
        <div class="field" style="margin-bottom: 14px"><label>Date of birth</label><input id="editProfileDob" type="date" value="${p.dateOfBirth}"></div>
        <div class="field" style="margin-bottom: 14px"><label>Preferred language</label><select id="editProfileLanguage">${languages.map((lang) => `<option ${lang === p.preferredLanguage ? 'selected' : ''}>${lang}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom: 18px"><label>Emergency contact</label><input id="editProfileContact" type="text" value="${escapeHTML(p.emergencyContact)}"></div>
        <div style="display: flex; gap: 9px">
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="cancel-profile-edit">Cancel</button>
          <button class="more-detail-button" style="flex: 1; text-align: center; border-color: var(--forest); background: var(--forest); color: white" data-action="save-profile">Save changes</button>
        </div>
      </article>`;
    }
    function medicationRowTemplate(med) {
      return `<div class="more-detail-row"><span>${escapeHTML(med.name)}<br><span style="color: var(--muted); font: 12px Arial, sans-serif">${escapeHTML(med.dose)} · ${escapeHTML(med.schedule)}</span></span><button class="review-edit" data-action="edit-medication" data-id="${med.id}">Edit</button></div>`;
    }
    function medicationsListTemplate() {
      const meds = patientState.medications;
      return `<article class="card more-detail-panel">
        <h2>Medications</h2>
        <p class="more-detail-meta">${meds.length} active medication${meds.length === 1 ? '' : 's'}</p>
        <div class="more-detail-list">${meds.map(medicationRowTemplate).join('') || '<p class="more-detail-meta">No medications added yet.</p>'}</div>
        <button class="more-detail-button" data-action="add-medication">+ Add a medication</button>
      </article>`;
    }
    function medicationFormTemplate({ id, name, dose, schedule } = {}) {
      const schedules = ['Morning', 'Afternoon', 'Evening', 'As needed'];
      const isEdit = Boolean(id);
      return `<article class="card more-detail-panel">
        <h2>${isEdit ? 'Edit Medication' : 'Add a Medication'}</h2>
        <div class="field" style="margin-bottom: 14px"><label>Medication name</label><input id="medFormName" type="text" placeholder="e.g. Metformin" value="${escapeHTML(name)}"></div>
        <div class="field" style="margin-bottom: 14px"><label>Dose</label><input id="medFormDose" type="text" placeholder="e.g. 500 mg" value="${escapeHTML(dose)}"></div>
        <div class="field" style="margin-bottom: 18px"><label>Schedule</label><select id="medFormSchedule">${schedules.map((s) => `<option ${s === schedule ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div style="display: flex; gap: 9px; margin-bottom: ${isEdit ? '9px' : '0'}">
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="cancel-medication-form">Cancel</button>
          <button class="more-detail-button" style="flex: 1; text-align: center; border-color: var(--forest); background: var(--forest); color: white" data-action="${isEdit ? 'save-medication-edit' : 'save-new-medication'}" data-id="${id || ''}">${isEdit ? 'Save changes' : 'Add medication'}</button>
        </div>
        ${isEdit ? `<button class="more-detail-button" style="text-align: center; color: #c7604e; border-color: #f0c9c2" data-action="delete-medication" data-id="${id}">Delete medication</button>` : ''}
      </article>`;
    }
    function medicationsTemplate() {
      if (medicationFormMode.type === 'add') return medicationFormTemplate();
      if (medicationFormMode.type === 'edit') {
        const med = patientState.medications.find((m) => m.id === medicationFormMode.id);
        if (med) return medicationFormTemplate(med);
      }
      return medicationsListTemplate();
    }
    function connectedTemplate() {
      if(initialProfile)return `<article class="card more-detail-panel"><h2>Connected Health Data</h2><p>Check Home for the live WHOOP connection status. Selected devices in your profile are not automatically connected.</p><a class="profile-setup-link" href="/onboarding/?edit=devices">Edit device list</a></article>`;

      return `<article class="card more-detail-panel">
        <h2>Connected Health Data</h2>
        <p class="more-detail-meta">No health source connected</p>
        <div class="more-detail-list">
          <div class="more-detail-row"><span>Blood pressure</span><strong>Not connected</strong></div>
          <div class="more-detail-row"><span>Heart rate</span><strong>Not connected</strong></div>
          <div class="more-detail-row"><span>Blood glucose</span><strong>Not connected</strong></div>
        </div>
        <button class="more-detail-button">Manage</button>
      </article>`;
    }
    function accessibilityTemplate() {
      if(initialProfile)return settingsTemplate();
      return `<article class="card more-detail-panel">
        <h2>Accessibility</h2>
        <div class="more-detail-row"><span>Text size</span><strong id="textSizeLabel">Normal</strong></div>
        <div class="trend-range" style="margin: 14px 0 18px">
          <button class="trend-range-button active" data-action="set-text-size" data-size="Normal">Normal</button>
          <button class="trend-range-button" data-action="set-text-size" data-size="Large">Large</button>
          <button class="trend-range-button" data-action="set-text-size" data-size="Extra Large">Extra Large</button>
        </div>
        <div class="more-toggle-row"><span>Voice input</span><button class="more-switch on" aria-label="Toggle voice input"></button></div>
        <div class="more-toggle-row"><span>Read questions aloud</span><button class="more-switch" aria-label="Toggle read questions aloud"></button></div>
      </article>`;
    }
    function notificationsTemplate() {
      if(initialProfile)return settingsTemplate();
      return `<article class="card more-detail-panel">
        <h2>Notifications</h2>
        <div class="more-toggle-row"><span>Medication reminders</span><button class="more-switch on" aria-label="Toggle medication reminders"></button></div>
        <div class="more-toggle-row"><span>Daily check-in reminders</span><button class="more-switch on" aria-label="Toggle daily check-in reminders"></button></div>
      </article>`;
    }
    function privacyTemplate() {
      return `<article class="card more-detail-panel">
        <h2>Privacy &amp; Data</h2>
        <p class="more-detail-meta">You control what is shared and with whom</p>
        <button class="more-detail-button">Connected data</button>
        <button class="more-detail-button">Export health summary</button>
        <button class="more-detail-button">Privacy settings</button>
      </article>`;
    }
    function settingsTemplate() {
      if(initialProfile){const p=profileStore.read();return `<article class="card more-detail-panel"><h2>Settings</h2><p>Text size: ${escapeHTML(p.accessibility?.textSize||'normal')}</p><p>Reduce animation: ${p.accessibility?.reduceMotion?'On':'Off'}</p><p class="profile-integration-note">Reminder preferences are saved only; notifications are not enabled.</p><a class="profile-setup-link" href="/onboarding/?edit=settings">Edit app settings</a></article>`;}

      return `<article class="card more-detail-panel">
        <h2>Settings</h2>
        <div class="more-detail-list">
          <div class="more-detail-row"><span>Language</span><strong>${patientState.profile.preferredLanguage}</strong></div>
          <div class="more-detail-row"><span>Account</span><strong>${escapeHTML(patientState.profile.firstName)}</strong></div>
        </div>
      </article>`;
    }
    const moreTemplates = {
      profile: () => (moreEditingProfile ? profileEditTemplate() : profileViewTemplate()),
      medications: medicationsTemplate,
      connected: connectedTemplate,
      accessibility: accessibilityTemplate,
      notifications: notificationsTemplate,
      privacy: privacyTemplate,
      settings: settingsTemplate,
    };
    function renderMoreSubview(key) {
      document.getElementById('moreDetail').dataset.subview = key;
      document.getElementById('moreDetailBody').innerHTML = (moreTemplates[key] || (() => ''))();
    }
    function showMoreMain() {
      document.querySelector('.more-menu').hidden = false;
      document.getElementById('moreDetail').hidden = true;
    }
    function showMoreSubview(key) {
      renderMoreSubview(key);
      document.querySelector('.more-menu').hidden = true;
      document.getElementById('moreDetail').hidden = false;
    }
    document.querySelectorAll('.more-card').forEach((card) => {
      card.addEventListener('click', () => showMoreSubview(card.dataset.more));
    });
    document.getElementById('moreDetailBack').addEventListener('click', showMoreMain);
    document.getElementById('moreDetailBody').addEventListener('click', (event) => {
      const toggle = event.target.closest('.more-switch');
      if (toggle) { toggle.classList.toggle('on'); return; }
      const actionEl = event.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      if (action === 'edit-profile') {
        moreEditingProfile = true;
        renderMoreSubview('profile');
      } else if (action === 'cancel-profile-edit') {
        moreEditingProfile = false;
        renderMoreSubview('profile');
      } else if (action === 'save-profile') {
        patientState.profile.firstName = document.getElementById('editProfileName').value.trim() || patientState.profile.firstName;
        patientState.profile.dateOfBirth = document.getElementById('editProfileDob').value || patientState.profile.dateOfBirth;
        patientState.profile.preferredLanguage = document.getElementById('editProfileLanguage').value;
        patientState.profile.emergencyContact = document.getElementById('editProfileContact').value.trim();
        moreEditingProfile = false;
        renderMoreSubview('profile');
        updateHomeGreeting();
      } else if (action === 'add-medication') {
        medicationFormMode = { type: 'add' };
        renderMoreSubview('medications');
      } else if (action === 'edit-medication') {
        medicationFormMode = { type: 'edit', id: actionEl.dataset.id };
        renderMoreSubview('medications');
      } else if (action === 'cancel-medication-form') {
        medicationFormMode = { type: 'list' };
        renderMoreSubview('medications');
      } else if (action === 'save-new-medication') {
        const name = document.getElementById('medFormName').value.trim();
        const dose = document.getElementById('medFormDose').value.trim();
        const schedule = document.getElementById('medFormSchedule').value;
        if (name && dose) {
          patientState.medications.push({ id: `med-${Date.now()}`, name, dose, schedule });
          medicationFormMode = { type: 'list' };
          renderMoreSubview('medications');
          updateMedicationCardSubtitle();
          renderTrends(currentTrendRange);
        }
      } else if (action === 'save-medication-edit') {
        const med = patientState.medications.find((m) => m.id === actionEl.dataset.id);
        if (med) {
          med.name = document.getElementById('medFormName').value.trim() || med.name;
          med.dose = document.getElementById('medFormDose').value.trim() || med.dose;
          med.schedule = document.getElementById('medFormSchedule').value;
        }
        medicationFormMode = { type: 'list' };
        renderMoreSubview('medications');
        renderTrends(currentTrendRange);
      } else if (action === 'delete-medication') {
        patientState.medications = patientState.medications.filter((m) => m.id !== actionEl.dataset.id);
        medicationFormMode = { type: 'list' };
        renderMoreSubview('medications');
        updateMedicationCardSubtitle();
        renderTrends(currentTrendRange);
      } else if (action === 'set-text-size') {
        document.getElementById('textSizeLabel').textContent = actionEl.dataset.size;
        actionEl.parentElement.querySelectorAll('.trend-range-button').forEach((b) => b.classList.remove('active'));
        actionEl.classList.add('active');
      }
      if(profileStore&&['save-new-medication','save-medication-edit','delete-medication'].includes(action)){
        try{profileStore.patch({medications:patientState.medications});}
        catch{window.alert('Your medication change could not be saved to this tab. Please retry.');}
      }
    });

    // Meals keeps Version B's display state; voice entries and Daily Check-in diet data come from the backend.
    const mealState = {
      date: '',
      meals: { breakfast: [], lunch: [], dinner: [], snacks: [], unspecified: [] },
      waterGlasses: 0,
      caffeine: [],
    };
    const MEAL_TYPES = [
      { key: 'breakfast', label: 'Breakfast' },
      { key: 'lunch', label: 'Lunch' },
      { key: 'dinner', label: 'Dinner' },
      { key: 'snacks', label: 'Snacks' },
    ];
    const CAFFEINE_TYPE_OPTIONS = ['coffee', 'tea', 'energy drink', 'other'];
    function makeMealId() { return `meal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
    function todayDateKey() { return new Date().toISOString().slice(0, 10); }
    function capitalizeWords(text) { return text.replace(/\b\w/g, (l) => l.toUpperCase()); }
    function capitalizeFirst(text) { return text.charAt(0).toUpperCase() + text.slice(1); }
    mealState.date = todayDateKey();

    function mealTypeLabel(key) {
      if (key === 'unspecified') return 'Unspecified';
      const found = MEAL_TYPES.find((t) => t.key === key);
      return found ? found.label : capitalizeFirst(key);
    }
    function mealCardTemplate(type) {
      const items = mealState.meals[type.key] || [];
      if (items.length === 0) {
        return `<article class="card trend-panel meal-card">
          <div class="meal-card-head"><h2 class="trend-panel-title">${type.label}</h2></div>
          <p class="trend-panel-meta">No meal recorded yet.</p>
          <button class="more-detail-button" data-action="add-meal" data-type="${type.key}">+ Add ${type.label.toLowerCase()}</button>
        </article>`;
      }
      const notes = items.map((item) => item.note).filter(Boolean).join(' · ');
      return `<article class="card trend-panel meal-card">
        <div class="meal-card-head"><h2 class="trend-panel-title">${type.label}</h2></div>
        <ul class="meal-item-list">${items.map((item) => `<li>${escapeHTML(item.name)}</li>`).join('')}</ul>
        ${notes ? `<p class="trend-panel-meta">${escapeHTML(notes)}</p>` : ''}
        <div style="display: flex; gap: 8px; margin-top: 12px">
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="edit-meal" data-type="${type.key}">Edit</button>
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="add-meal" data-type="${type.key}">+ Add more</button>
        </div>
      </article>`;
    }
    function unspecifiedCardTemplate() {
      const items = mealState.meals.unspecified || [];
      if (items.length === 0) return '';
      return `<article class="card trend-panel meal-card">
        <div class="meal-card-head"><h2 class="trend-panel-title">Unspecified</h2></div>
        <p class="trend-panel-meta">I wasn't sure which meal this belonged to.</p>
        <ul class="meal-item-list">${items.map((item) => `<li>${escapeHTML(item.name)}</li>`).join('')}</ul>
        <button class="more-detail-button" data-action="edit-meal" data-type="unspecified" style="text-align: center">Move to a meal</button>
      </article>`;
    }
    function parseItemsText(text) {
      return text.split(/,|\n/).map((s) => s.trim()).filter(Boolean).map(capitalizeWords);
    }
    function mealFormTemplate({ mealType = 'breakfast', itemsText = '', note = '' } = {}) {
      return `<article class="card more-detail-panel">
        <h2>Edit Meal</h2>
        <div class="field" style="margin-bottom: 14px"><label>Meal type</label><select id="mealFormType">${MEAL_TYPES.map((t) => `<option value="${t.key}" ${t.key === mealType ? 'selected' : ''}>${t.label}</option>`).join('')}<option value="unspecified" ${mealType === 'unspecified' ? 'selected' : ''}>Unspecified</option></select></div>
        <div class="field" style="margin-bottom: 14px"><label>Food items</label><textarea id="mealFormItems" placeholder="e.g. Oatmeal, banana, coffee">${escapeHTML(itemsText)}</textarea></div>
        <div class="field" style="margin-bottom: 14px"><label>Optional note</label><textarea id="mealFormNote" placeholder="Anything you want to remember">${escapeHTML(note)}</textarea></div>
        <div style="display: flex; gap: 9px">
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="cancel-meal-form">Cancel</button>
          <button class="more-detail-button" style="flex: 1; text-align: center; border-color: var(--forest); background: var(--forest); color: white" data-action="save-meal" data-original-type="${mealType}">Save meal</button>
        </div>
        <button class="more-detail-button" style="text-align: center; color: #c7604e; border-color: #f0c9c2; margin-top: 9px" data-action="delete-meal" data-type="${mealType}">Delete this meal</button>
      </article>`;
    }
    function caffeineFormTemplate({ id, type = 'coffee', count = 1, note = '' } = {}) {
      const isEdit = Boolean(id);
      const knownType = CAFFEINE_TYPE_OPTIONS.includes(type) ? type : 'other';
      return `<article class="card more-detail-panel">
        <h2>${isEdit ? 'Edit Caffeine' : 'Add Caffeine'}</h2>
        <div class="field" style="margin-bottom: 14px"><label>Type</label><select id="caffeineFormType">${CAFFEINE_TYPE_OPTIONS.map((t) => `<option value="${t}" ${t === knownType ? 'selected' : ''}>${capitalizeFirst(t)}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom: 14px"><label>Count</label><input id="caffeineFormCount" type="number" min="1" value="${count}"></div>
        <div class="field" style="margin-bottom: 14px"><label>Optional note</label><input id="caffeineFormNote" type="text" value="${escapeHTML(note)}" placeholder="e.g. iced, decaf"></div>
        <div style="display: flex; gap: 9px">
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="cancel-meal-form">Cancel</button>
          <button class="more-detail-button" style="flex: 1; text-align: center; border-color: var(--forest); background: var(--forest); color: white" data-action="save-caffeine" data-id="${id || ''}">${isEdit ? 'Save changes' : 'Add caffeine'}</button>
        </div>
        ${isEdit ? `<button class="more-detail-button" style="text-align: center; color: #c7604e; border-color: #f0c9c2; margin-top: 9px" data-action="delete-caffeine" data-id="${id}">Delete</button>` : ''}
      </article>`;
    }
    function mealVoiceCaptureTemplate(transcriptText = '') {
      return `<article class="card more-detail-panel">
        <h2>Tell me what you ate today</h2>
        <p class="more-detail-meta">Speak naturally — for example, "This morning I had oatmeal and coffee. For lunch I had rice and chicken."</p>
        <button class="more-detail-button" id="mealsVoiceMicButton" type="button" style="text-align: center; color: var(--forest)">🎤 Start speaking</button>
        <p class="trend-panel-meta" id="mealsVoiceStatus" style="margin: 8px 0 4px"></p>
        <div class="field" style="margin: 12px 0 18px"><label>Transcript (you can edit this)</label><textarea id="mealsVoiceTranscript" rows="4" placeholder="Your words will appear here...">${escapeHTML(transcriptText)}</textarea></div>
        <div style="display: flex; gap: 9px">
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="cancel-voice-entry">Cancel</button>
          <button class="more-detail-button" style="flex: 1; text-align: center; border-color: var(--forest); background: var(--forest); color: white" data-action="analyze-voice-entry">Continue</button>
        </div>
      </article>`;
    }
    function mealVoicePreviewTemplate(parseResult, rawTranscript) {
      const sections = [];
      parseResult.meals.forEach(({ mealType, items }) => {
        sections.push(`<div class="voice-preview-section"><div class="voice-preview-title">${mealTypeLabel(mealType)}</div><ul class="meal-item-list">${items.map((i) => `<li>${escapeHTML(i)}</li>`).join('')}</ul></div>`);
      });
      if (parseResult.waterGlasses > 0) {
        sections.push(`<div class="voice-preview-section"><div class="voice-preview-title">Water</div><p class="trend-panel-meta">${parseResult.waterGlasses} glass${parseResult.waterGlasses === 1 ? '' : 'es'}</p></div>`);
      }
      if (parseResult.caffeine.length) {
        sections.push(`<div class="voice-preview-section"><div class="voice-preview-title">Caffeine</div><ul class="meal-item-list">${parseResult.caffeine.map((c) => `<li>${capitalizeFirst(c.type)} ×${c.count}</li>`).join('')}</ul></div>`);
      }
      const empty = sections.length === 0;
      return `<article class="card more-detail-panel">
        <h2>I heard</h2>
        <div class="voice-preview-section">
          <div class="voice-preview-title">Raw transcript</div>
          <p class="trend-panel-meta" style="font-style: italic">"${escapeHTML(rawTranscript)}"</p>
        </div>
        <div class="voice-preview-title">Detected</div>
        ${empty ? '<p class="more-detail-meta">I could not find any meals, water, or caffeine in that. Tap Edit to fix the transcript and try again.</p>' : sections.join('')}
        <div style="display: flex; gap: 9px; margin-top: 16px">
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="edit-voice-transcript">Edit</button>
          <button class="more-detail-button" style="flex: 1; text-align: center" data-action="cancel-voice-entry">Cancel</button>
          ${empty ? '' : '<button class="more-detail-button" style="flex: 1; text-align: center; border-color: var(--forest); background: var(--forest); color: white" data-action="save-voice-entry">Save to Meals</button>'}
        </div>
      </article>`;
    }
    let mealsVoiceRecognizer = null;
    // Single source of truth for the in-progress voice entry. rawTranscript is exactly what
    // ElevenLabs/the user typed. Backend normalization never changes the transcript.
    const mealVoiceState = { rawTranscript: '', parsedResult: null, normalized: null };
    let mealBusy = false;
    function attachMealsVoiceRecognizer() {
      const textarea = document.getElementById('mealsVoiceTranscript');
      const button = document.getElementById('mealsVoiceMicButton');
      const status = document.getElementById('mealsVoiceStatus');
      if (!textarea || !button) return;
      mealsVoiceRecognizer = createSpeechRecognizer(textarea, {
        continuous: true,
        onStart: () => { status.textContent = 'Listening...'; button.textContent = '■ Stop'; },
        onEnd: () => { status.textContent = 'Tap Continue when you are done, or keep editing the text.'; button.textContent = '🎤 Start speaking'; },
        onError: (error) => {
          button.textContent = '🎤 Start speaking';
          if (error === 'not-allowed' || error === 'service-not-allowed') { status.textContent = 'Microphone access was denied.'; return; }
          if (error === 'no-speech') return;
          status.textContent = 'I may not have heard that correctly. Please try again or type instead.';
        },
      });
      button.addEventListener('click', async () => {
        if (mealBusy) return;
        if (!mealsVoiceRecognizer) { status.textContent = 'Speech recognition is not supported in this browser. Please type instead.'; return; }
        button.disabled=true;
        try { if (mealsVoiceRecognizer.isActive()) await mealsVoiceRecognizer.stop(); else await mealsVoiceRecognizer.start(); }
        catch(error) {status.textContent=error.message;}
        finally {button.disabled=false;}
      });
    }
    function showMealsMain() {
      document.getElementById('mealsMain').hidden = false;
      document.getElementById('mealFormPanel').hidden = true;
      document.getElementById('mealVoicePanel').hidden = true;
      if (mealsVoiceRecognizer) { mealsVoiceRecognizer.destroy(); mealsVoiceRecognizer = null; }
    }
    function showFormPanel(html) {
      document.getElementById('mealFormBody').innerHTML = html;
      document.getElementById('mealsMain').hidden = true;
      document.getElementById('mealVoicePanel').hidden = true;
      document.getElementById('mealFormPanel').hidden = false;
    }
    function showMealVoiceCapture(transcriptText = '') {
      if (mealBusy) return;
      mealsVoiceRecognizer?.destroy();
      document.getElementById('mealsMain').hidden = true;
      document.getElementById('mealFormPanel').hidden = true;
      document.getElementById('mealVoiceBody').innerHTML = mealVoiceCaptureTemplate(transcriptText);
      document.getElementById('mealVoicePanel').hidden = false;
      attachMealsVoiceRecognizer();
    }
    function closeMealVoicePanel() {
      if (mealsVoiceRecognizer) { mealsVoiceRecognizer.destroy(); mealsVoiceRecognizer = null; }
      document.getElementById('mealVoicePanel').hidden = true;
      document.getElementById('mealsMain').hidden = false;
    }
    function applyVoiceParseToState(parseResult) {
      parseResult.meals.forEach(({ mealType, items }) => {
        if (!mealState.meals[mealType]) mealState.meals[mealType] = [];
        items.forEach((name) => mealState.meals[mealType].push({ id: makeMealId(), name, note: '', source: 'voice' }));
      });
      if (parseResult.waterGlasses > 0) mealState.waterGlasses = Math.min(12, mealState.waterGlasses + parseResult.waterGlasses);
      parseResult.caffeine.forEach(({ type, count }) => {
        const existing = mealState.caffeine.find((c) => c.type === type && c.source === 'voice');
        if (existing) existing.count += count;
        else mealState.caffeine.push({ id: makeMealId(), type, count, size: null, source: 'voice' });
      });
    }
    function renderCaffeineList() {
      const container = document.getElementById('caffeineList');
      if (mealState.caffeine.length === 0) {
        container.innerHTML = '<p class="trend-panel-meta">No caffeine recorded yet today.</p>';
        return;
      }
      container.innerHTML = mealState.caffeine.map((entry) => `
        <div class="more-detail-row"><span>${capitalizeFirst(entry.type)} ×${entry.count}</span><button class="review-edit" data-action="edit-caffeine" data-id="${entry.id}">Edit</button></div>`).join('');
    }
    function renderWater() {
      const value = mealState.waterGlasses;
      document.getElementById('waterCountValue').textContent = value;
      document.getElementById('waterSlider').value = value;
      document.getElementById('waterDrops').innerHTML = Array.from({ length: 12 }, (_, i) => `<span class="water-drop${i < value ? ' filled' : ''}">💧</span>`).join('');
    }
    function setWaterGlasses(value) {
      mealState.waterGlasses = Math.max(0, Math.min(12, value));
      renderWater();
    }
    function renderMealsMain() {
      document.getElementById('mealsToday').textContent = `Today · ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`;
      document.getElementById('mealCards').innerHTML = MEAL_TYPES.map(mealCardTemplate).join('') + unspecifiedCardTemplate();
      renderWater();
      renderCaffeineList();
    }
    // Converts checkinState.diet (populated by Daily Check-in's transcript analysis)
    // into mealState entries. Called on Confirm & Save — never invents a meal
    // when the user didn't mention food, since it only ever reads what's already there.
    function addMealsFromCheckin() {
      checkinState.diet.forEach((entry) => {
        const items = entry.item ? [entry.item] : [];
        if (items.length === 0) return;
        const mealType = entry.time && mealState.meals[entry.time] ? entry.time : 'unspecified';
        items.forEach((name) => mealState.meals[mealType].push({ id: makeMealId(), name, note: '', source: 'daily-checkin' }));
      });
    }
    document.getElementById('waterSlider').addEventListener('input', (event) => setWaterGlasses(Number(event.target.value)));
    document.getElementById('mealsVoiceCTA').addEventListener('click', () => showMealVoiceCapture());
    document.getElementById('mealsView').addEventListener('click', async (event) => {
      const actionEl = event.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      if (mealBusy) return;
      if (action === 'add-meal') {
        showFormPanel(mealFormTemplate({ mealType: actionEl.dataset.type }));
      } else if (action === 'edit-meal') {
        const type = actionEl.dataset.type;
        const items = mealState.meals[type] || [];
        showFormPanel(mealFormTemplate({ mealType: type, itemsText: items.map((item) => item.name).join(', '), note: items.map((item) => item.note).filter(Boolean).join(' · ') }));
      } else if (action === 'cancel-meal-form') {
        showMealsMain();
        renderMealsMain();
      } else if (action === 'save-meal') {
        const newType = document.getElementById('mealFormType').value;
        const originalType = actionEl.dataset.originalType;
        const items = parseItemsText(document.getElementById('mealFormItems').value);
        const note = document.getElementById('mealFormNote').value.trim();
        if (originalType && originalType !== newType) mealState.meals[originalType] = [];
        mealState.meals[newType] = items.map((name) => ({ id: makeMealId(), name, note, source: 'manual' }));
        showMealsMain();
        renderMealsMain();
      } else if (action === 'delete-meal') {
        mealState.meals[actionEl.dataset.type] = [];
        showMealsMain();
        renderMealsMain();
      } else if (action === 'add-caffeine') {
        showFormPanel(caffeineFormTemplate({}));
      } else if (action === 'edit-caffeine') {
        const entry = mealState.caffeine.find((c) => c.id === actionEl.dataset.id);
        if (entry) showFormPanel(caffeineFormTemplate(entry));
      } else if (action === 'save-caffeine') {
        const type = document.getElementById('caffeineFormType').value;
        const count = Math.max(1, Number(document.getElementById('caffeineFormCount').value) || 1);
        const note = document.getElementById('caffeineFormNote').value.trim();
        const id = actionEl.dataset.id;
        const existing = id && mealState.caffeine.find((c) => c.id === id);
        if (existing) { existing.type = type; existing.count = count; existing.note = note; }
        else mealState.caffeine.push({ id: makeMealId(), type, count, size: null, note, source: 'manual' });
        showMealsMain();
        renderMealsMain();
      } else if (action === 'delete-caffeine') {
        const index = mealState.caffeine.findIndex((c) => c.id === actionEl.dataset.id);
        if (index !== -1) mealState.caffeine.splice(index, 1);
        showMealsMain();
        renderMealsMain();
      } else if (action === 'water-plus') {
        setWaterGlasses(mealState.waterGlasses + 1);
      } else if (action === 'water-minus') {
        setWaterGlasses(mealState.waterGlasses - 1);
      } else if (action === 'cancel-voice-entry') {
        closeMealVoicePanel();
      } else if (action === 'analyze-voice-entry') {
        if (mealBusy) return;
        mealBusy = true;
        actionEl.disabled = true;
        try {
          const transcriptText = mealsVoiceRecognizer ? await mealsVoiceRecognizer.stop() : document.getElementById('mealsVoiceTranscript').value.trim();
          if (!transcriptText.trim()) throw new Error('Please speak or type your meal details.');
          mealVoiceState.rawTranscript = transcriptText;
          mealClient.reset();
          let result = await mealClient.start(transcriptText);
          if (result.status !== 'review') result = await mealClient.review();
          mealVoiceState.normalized = normalizeBackendResponse(result, {transcript:transcriptText});
          mealVoiceState.parsedResult = {
            meals: mealVoiceState.normalized.diet.map((entry) => ({mealType: mealState.meals[entry.time] ? entry.time : 'unspecified', items:[entry.item]})),
            waterGlasses:0,caffeine:[],
          };
          document.getElementById('mealVoiceBody').innerHTML = mealVoicePreviewTemplate(mealVoiceState.parsedResult, mealVoiceState.rawTranscript);
        } catch (error) {
          const status = document.getElementById('mealsVoiceStatus');
          if (status) status.textContent = error.message;
        } finally { mealBusy = false; actionEl.disabled = false; }
      } else if (action === 'edit-voice-transcript') {
        showMealVoiceCapture(mealVoiceState.rawTranscript);
      } else if (action === 'save-voice-entry') {
        if (mealBusy || !mealVoiceState.normalized) return;
        mealBusy = true;
        actionEl.disabled = true;
        try {
          // This panel reviews meals only. Other extracted categories were not
          // shown here and must not be silently saved under a meal confirmation.
          const reviewed = toBackendRecord(mealVoiceState.normalized);
          await mealClient.save({symptoms:[],medications:[],diet:reviewed.diet,vitals:[],wellness:null});
          if (mealVoiceState.parsedResult) applyVoiceParseToState(mealVoiceState.parsedResult);
          mealVoiceState.parsedResult = null;
          closeMealVoicePanel(); renderMealsMain();
        } catch (error) {
          let note = document.getElementById('mealSaveError');
          if (!note) { note = document.createElement('p'); note.id='mealSaveError'; note.setAttribute('role','alert'); document.getElementById('mealVoiceBody').append(note); }
          note.textContent=error.message;
        } finally { mealBusy=false; actionEl.disabled=false; }

      }
    });
    // The existing Version B state remains the source of truth for its screens.
    const flowTranscript = document.getElementById('flowTranscript');
    const checkinState = {transcript:'',symptoms:[],medications:[],diet:[],vitals:[],functionalImpact:[],painScore:null,completed:false,generalStatus:null,noSymptoms:false,resolvedSymptoms:[],sessionId:null,version:null,nextQuestion:null,status:null,backendRecord:null};
    const excludedIds = new Set();
    let uiBusy = false;
    let selectedScore = null;
    let followupRecognizer = null;
    let destroyed = false;
    const integrationError = document.createElement('p');
    integrationError.id = 'integrationError'; integrationError.className = 'integration-error'; integrationError.setAttribute('role','alert'); integrationError.hidden = true;
    const integrationStatus = document.createElement('p');
    integrationStatus.id = 'integrationStatus'; integrationStatus.className = 'integration-status'; integrationStatus.setAttribute('role','status');
    checkinFlow.querySelector('.flow-progress').after(integrationStatus,integrationError);
    const voiceControls = document.createElement('div');
    voiceControls.id='voiceConversationControls'; voiceControls.className='voice-conversation-controls';
    voiceControls.innerHTML='<div class="voice-conversation-actions"><button type="button" id="voiceResume">Start voice conversation</button><button type="button" id="voicePause" hidden>Pause</button><button type="button" id="voiceManual" hidden>Use buttons / typing</button><button type="button" id="voiceReview" hidden>Review now</button></div><label id="voiceReplyLabel" hidden>Your answer<textarea id="voiceReply" class="transcript" readonly></textarea></label><p>Pause briefly after answering. Say “skip” or “finish check-in” at any question.</p>';
    integrationError.after(voiceControls);
    voiceControls.hidden=!conversationEnabled;
    const voiceReply=voiceControls.querySelector('#voiceReply');
    let voiceSpeaker=null;
    const lazySpeaker={
      prime(){voiceSpeaker??=speakerFactory();return voiceSpeaker.prime();},
      speak(text){voiceSpeaker??=speakerFactory();return voiceSpeaker.speak(text);},
      stop(){voiceSpeaker?.stop();}, destroy(){voiceSpeaker?.destroy();},
    };
    conversation=createVoiceConversation({
      client,speaker:lazySpeaker,
      speechFactory:speechFactory===createElevenLabsSpeechInput?createVoiceSpeechFactory():speechFactory,
      textarea:flowTranscript,
      onRecord(response){
        const previousQuestion=checkinState.nextQuestion?.id;
        if (!checkinState.sessionId) checkinState.transcript=flowTranscript.value.trim();
        mergeAnalysisIntoState(response);
        // Pause cannot undo an API request already sent. Reconcile the manual
        // screen with its result so a stale answer never targets a new question.
        if(!conversation.active && !destroyed && checkinFlow.classList.contains('open')) {
          if(response.status==='review'){showFlowScreen('review');voiceControls.hidden=true;}
          else if(response.nextQuestion && response.nextQuestion.id!==previousQuestion){
            flowTranscript.value='';renderQuestion(response.nextQuestion);
          }
        }
      },
      onQuestion(question){ renderQuestion(question); },
      questionText(question,response){
        const item=response[question.category]?.find(item=>item.id===question.entityId);
        const context=question.category==='symptoms' && item?.location && !item.name.toLowerCase().includes(item.location.toLowerCase())
          ? `About the ${item.name} in your ${item.location}. ` : '';
        return context+question.text;
      },
      onReview(){stopAllVoice();showFlowScreen('review');voiceControls.hidden=true;},
      onState(state){
        const locked=state.active||state.busy;
        setBusy(locked);
        checkinFlow.dataset.voiceActive=String(state.active);
        integrationStatus.textContent=state.message;
        if(state.phase==='error')showError(new Error(state.message));
        if(!state.active && ['error','paused'].includes(state.phase))copyVoiceDraftToManual();
        voiceReply.value=flowTranscript.value;
        document.getElementById('voiceReplyLabel').hidden=currentFlowScreen==='listening'||!voiceReply.value;
        setListeningDisplay(state.phase==='listening',state.phase);
        document.getElementById('voicePause').hidden=!state.active;
        document.getElementById('voicePause').disabled=false;
        document.getElementById('voiceManual').hidden=!state.active;
        document.getElementById('voiceManual').disabled=false;
        document.getElementById('voiceReview').hidden=!client.state||client.state.status==='review'||client.state.status==='saved';
        document.getElementById('voiceReview').disabled=client.busy;
        document.getElementById('voiceResume').hidden=state.active||client.state?.status==='saved'||currentFlowScreen==='review';
        document.getElementById('voiceResume').disabled=state.busy;
        document.getElementById('voiceResume').textContent=client.state?'Resume voice conversation':'Start voice conversation';
      },
    });
    function startVoiceConversation() {
      if (conversation.active || conversation.busy || destroyed) return;
      clearError(); stopAllVoice(); voiceControls.hidden=false;
      if(!client.state)showFlowScreen('listening');
      void conversation.start({resume:Boolean(client.state)}).catch(error=>showError(error));
    }
    function pauseVoiceConversation() {
      conversation.pause();
      copyVoiceDraftToManual();
    }
    function copyVoiceDraftToManual() {
      // Retain the last words in the existing manual answer field after pausing.
      const input=checkinFlow.querySelector('[data-screen]:not([hidden]) #followupAnswer, [data-screen]:not([hidden]) #impactTranscript');
      if(input)input.value=flowTranscript.value;
    }
    document.getElementById('voiceResume').addEventListener('click',startVoiceConversation);
    document.getElementById('voicePause').addEventListener('click',pauseVoiceConversation);
    document.getElementById('voiceManual').addEventListener('click',pauseVoiceConversation);
    document.getElementById('voiceReview').addEventListener('click',()=>{void conversation.review().catch(showError);});
    const flowVoiceRecognizer = createSpeechRecognizer(flowTranscript, {
      onStart: () => { setListeningDisplay(true); integrationStatus.textContent = 'Listening…'; },
      onEnd: () => { setListeningDisplay(false); integrationStatus.textContent = 'Review or edit your transcript before continuing.'; },
      onError: message => { setListeningDisplay(false); showError(new Error(message)); },
      onStatus: status => { if (['connecting','stopping','notice'].includes(status?.type)) integrationStatus.textContent = status.message; },
    });
    function setListeningDisplay(listening,phase='idle') {
      const screen = checkinFlow.querySelector('[data-screen="listening"]');
      const headings={starting:'Starting your check-in…',speaking:'Your assistant is speaking',connecting:'Connecting your microphone…',processing:'Updating your check-in…',paused:'Voice paused',error:'Voice paused'};
      screen.querySelector('h2').textContent = listening ? "I'm listening" : headings[phase] || 'Your check-in';
      screen.querySelector('.voice-wave').hidden = !listening;
    }
    function showError(error) { integrationError.textContent = error.message || 'The request could not be completed.'; integrationError.hidden=false; }
    function clearError() { integrationError.hidden=true; integrationError.textContent=''; }
    function setBusy(busy) {
      uiBusy=busy; checkinFlow.setAttribute('aria-busy',String(busy));
      checkinFlow.querySelectorAll('button,input,textarea,select').forEach(control => { if (control.id !== 'flowClose' && !control.hasAttribute('data-close')) control.disabled=busy; });
      if (busy) integrationStatus.textContent='Working…';
    }
    async function run(work) {
      if (uiBusy || destroyed) return;
      clearError(); setBusy(true);
      try { await work(); }
      catch (error) { showError(error); }
      finally {
        setBusy(false);
        if (['Working…','Organizing your check-in…'].includes(integrationStatus.textContent)) integrationStatus.textContent = checkinState.extractionMode === 'demo' ? 'Demo extraction · temporary server memory' : 'Temporary server memory';
      }
    }
    function resetCheckinState() {
      client.reset(); excludedIds.clear(); selectedScore=null;
      Object.assign(checkinState,{transcript:'',symptoms:[],medications:[],diet:[],vitals:[],functionalImpact:[],painScore:null,completed:false,generalStatus:null,noSymptoms:false,resolvedSymptoms:[],sessionId:null,version:null,nextQuestion:null,status:null,backendRecord:null});
      flowTranscript.value=''; integrationStatus.textContent=''; clearError();
      voiceControls.hidden=!conversationEnabled; voiceReply.value=''; document.getElementById('voiceReplyLabel').hidden=true;
      for(const id of ['voicePause','voiceManual','voiceReview'])document.getElementById(id).hidden=true;
      const startVoice=document.getElementById('voiceResume');startVoice.hidden=false;startVoice.disabled=false;startVoice.textContent='Start voice conversation';
      checkinFlow.dataset.voiceActive='false';
      checkinFlow.querySelectorAll('input[name="impact"]').forEach(input => {input.checked=false;});
      document.getElementById('impactTranscript').value='';
    }
    function mergeAnalysisIntoState(response) {
      Object.assign(checkinState,normalizeBackendResponse(response,{transcript:checkinState.transcript,excludedIds}));
    }
    function symptomLabel(symptom) {
      if (/^pain$/i.test(symptom.name) && symptom.location) return `${capitalizeFirst(symptom.location)} pain`;
      return capitalizeFirst(symptom.name || 'Symptom');
    }
    function renderDetectedTopics() {
      const list=checkinFlow.querySelector('.flow-detected-list'); list.replaceChildren();
      const groups=[['symptoms','🤕',symptomLabel],['medications','💊',item=>`${item.name || 'Unidentified medication'}${item.status ? ' · '+item.status.replaceAll('_',' ') : ''}`],['diet','🍽',item=>item.item],['vitals','♥',item=>`${item.type}${item.value ? ': '+item.value : ''}`]];
      for (const [category,icon,labelFor] of groups) for (const item of checkinState[category]) {
        const label=document.createElement('label'); label.className='flow-topic-card';
        const symbol=document.createElement('span'); symbol.textContent=icon;
        const input=document.createElement('input'); input.type='checkbox'; input.name='topic'; input.value=category; input.dataset.category=category; input.dataset.key=item.id; input.checked=true;
        label.append(symbol,document.createTextNode(labelFor(item)),input); list.append(label);
      }
      if (checkinState.noSymptoms) { const card=document.createElement('div');card.className='flow-topic-card';card.textContent=checkinState.generalStatus==='normal'?'🙂 Feeling normal today':'🙂 Feeling well today';list.append(card); }
      checkinFlow.querySelector('.flow-topic-note').textContent=list.children.length ? 'Let’s go through these together. Uncheck anything that is incorrect.' : 'No specific health details were identified. You can edit your transcript or review this entry.';
    }
    function applyTopicExclusions() {
      checkinFlow.querySelectorAll('.flow-detected-list input:not(:checked)').forEach(input=>excludedIds.add(input.dataset.key));
      for (const category of ['symptoms','medications','diet','vitals']) checkinState[category]=checkinState[category].filter(item=>!excludedIds.has(item.id));
    }
    async function enterReview() {
      if (conversation?.active) conversation.stop(); voiceControls.hidden=true;
      stopAllVoice();
      if (client.state?.status !== 'review') mergeAnalysisIntoState(await client.review());
      showFlowScreen('review');
    }
    async function advanceQuestion() {
      while (client.state?.nextQuestion && excludedIds.has(client.state.nextQuestion.entityId)) mergeAnalysisIntoState(await client.skip());
      if (!checkinState.nextQuestion || client.state.status==='review') { await enterReview(); return; }
      renderQuestion(checkinState.nextQuestion);
    }
    async function submitAnswer(value,{spoken=false}={}) {
      stopAllVoice();
      mergeAnalysisIntoState(await client.answer(String(value),{spoken}));
      await advanceQuestion();
    }
    function attachQuestionSpeech(textarea,button,status) {
      followupRecognizer?.destroy();
      followupRecognizer=createSpeechRecognizer(textarea,{
        onStart:()=>{button.textContent='■ Stop speaking';if(status)status.textContent='Listening…';},
        onEnd:()=>{button.textContent='🎤 Tell me';if(status)status.textContent='Review your answer, then continue.';},
        onError:message=>showError(new Error(message)),
      });
      button.onclick=()=>run(async()=>{if(followupRecognizer.isActive()) await followupRecognizer.stop();else await followupRecognizer.start();});
    }
    function questionName(question) {
      const item=checkinState[question.category]?.find(item=>item.id===question.entityId);
      return question.category==='symptoms' && item ? symptomLabel(item) : item?.name || 'your check-in';
    }
    function makeAnswerBox(screen,question) {
      let area=screen.querySelector('.integration-question-controls');
      if(!area){area=document.createElement('div');area.className='integration-question-controls';screen.insertBefore(area,screen.querySelector('.integration-question-actions'));}
      area.replaceChildren();
      const options=document.createElement('div');options.className='severity-list';
      for(const option of question.options){const button=document.createElement('button');button.className='severity-card';button.textContent=option;button.type='button';button.onclick=()=>run(()=>submitAnswer(option));options.append(button);}
      const textarea=document.createElement('textarea');textarea.className='transcript';textarea.id='followupAnswer';textarea.setAttribute('aria-label',question.text);textarea.placeholder='Type your answer, or use the microphone.';
      const voice=document.createElement('button');voice.className='severity-voice';voice.id='followupVoice';voice.textContent='🎤 Tell me';
      const status=document.createElement('p');status.className='severity-voice-status';
      const next=document.createElement('button');next.className='flow-primary';next.id='followupContinue';next.textContent='Continue';
      next.onclick=()=>run(async()=>{const text=await followupRecognizer.stop();await submitAnswer(text,{spoken:followupRecognizer.mode==='spoken'});});
      area.append(options,textarea,voice,status,next);attachQuestionSpeech(textarea,voice,status);
    }
    function renderQuestion(question) {
      stopAllVoice();followupRecognizer?.destroy();followupRecognizer=null;
      checkinFlow.querySelectorAll('.integration-question-controls').forEach(controls=>controls.remove());
      const name=questionName(question);
      const symptom=checkinState.symptoms.find(item=>item.id===question.entityId);
      let screenName='guided';
      if(question.category==='symptoms' && question.field==='severity' && /pain|ache|hurt/i.test(symptom?.name||'')) {
        screenName='pain-score';selectedScore=null;
        const screen=checkinFlow.querySelector('[data-screen="pain-score"]');screen.querySelector('h2').textContent=`How severe is your ${name.toLowerCase()} right now?`;
        screen.querySelector('.guided-context').textContent=`About your ${name.toLowerCase()}`;
        screen.querySelector('.guided-count').textContent='1–10';
        screen.querySelectorAll('.pain-score-button').forEach(button=>button.classList.remove('selected'));
      } else if(question.category==='symptoms' && question.field==='functionalImpact') {
        screenName='additional';const screen=checkinFlow.querySelector('[data-screen="additional"]');screen.querySelector('.guided-context').textContent=`About your ${name.toLowerCase()}`;screen.querySelector('h2').textContent=question.text;
        screen.querySelectorAll('input[name="impact"]').forEach(input=>input.checked=false);
        const textarea=document.getElementById('impactTranscript');textarea.value='';
        attachQuestionSpeech(textarea,document.getElementById('impactVoice'),document.getElementById('impactVoiceStatus'));
      } else if(question.category==='medications') {
        screenName='medication';const screen=checkinFlow.querySelector('[data-screen="medication"]');screen.querySelector('h2').textContent=question.text;
        screen.querySelector('p').textContent='Use the medication name you know, or skip if you are unsure.';
        const medList=document.getElementById('medList');medList.replaceChildren();medList.hidden=true;
        document.getElementById('medAmbiguity').hidden=true;document.getElementById('medVoice').hidden=true;document.getElementById('medVoiceStatus').hidden=true;
        screen.querySelector('[data-next]').hidden=true;
        const choices=question.field==='name' ? patientState.medications.map(item=>item.name) : question.options;
        makeAnswerBox(screen,{...question,options:choices});
      } else if(question.category==='vitals') {
        screenName='vital';const screen=checkinFlow.querySelector('[data-screen="vital"]');
        screen.querySelector('.guided-context').textContent=`About ${name}`;
        document.getElementById('vitalMissingTitle').textContent=question.text;
        document.getElementById('vitalQuestion').textContent='Enter only a reading you measured or a unit shown on your device.';
        screen.querySelector('.measurement-switch').hidden=true;
        screen.querySelector('.vital-source-note').textContent='This reading came from your check-in; no device source is connected.';
        for(const id of ['vitalActions','vitalEntry','vitalConfirm']) document.getElementById(id).hidden=true;
        makeAnswerBox(screen,question);
      } else {
        const screen=checkinFlow.querySelector('[data-screen="guided"]');screen.querySelector('.guided-context').textContent=`About ${name}`;screen.querySelector('.guided-count').textContent='Follow-up';screen.querySelector('h2').textContent=question.text;
        screen.querySelector(':scope > .severity-list').hidden=true;document.getElementById('severityVoice').hidden=true;document.getElementById('severityVoiceStatus').hidden=true;
        makeAnswerBox(screen,question);
      }
      showFlowScreen(screenName);
    }
    const reviewFields={
      symptoms:[['name','Symptom'],['location','Location'],['severityScore','Pain score (1–10)'],['severity','Severity',['','mild','moderate','severe']],['functionalImpact','Effect on activities'],['trend','Trend',['','better','same','worse']],['duration','Duration']],
      medications:[['name','Medication name'],['description','Description'],['dose','Dose'],['status','Status',['','taken','missed','stopped','mentioned']],['time','Time']],
      diet:[['description','Food or drink'],['time','Meal / time']],
      vitals:[['name','Measurement'],['value','Value'],['unit','Unit'],['time','Time']],
    };
    function renderReviewCard(category,item) {
      const card=document.createElement('div');card.className='review-card';card.dataset.recordId=item.id;
      const head=document.createElement('div');head.className='review-card-head';
      const title=document.createElement('strong');title.textContent=category==='symptoms'?symptomLabel(item):category==='diet'?(item.time||'Diet'):category==='vitals'?item.type:item.name||'Unidentified medication';
      const edit=document.createElement('button');edit.className='review-edit';edit.textContent='Edit';edit.dataset.editReview='';
      const summary=document.createElement('p');
      const readable=category==='symptoms'?[item.painScore==null?'':`${item.painScore} / 10`,item.severity,item.location,item.functionalImpact,item.trend,item.duration]:category==='medications'?[item.dose,item.status?.replaceAll('_',' '),item.time,item.description]:category==='diet'?[item.item]:[item.value,item.unit,item.time];
      summary.textContent=readable.filter(Boolean).join(' · ')||'Details not provided';
      const form=document.createElement('div');form.className='integration-fields';form.hidden=true;
      for(const [field,labelText,options] of reviewFields[category]) {
        const label=document.createElement('label');label.textContent=labelText;
        const input=document.createElement(options?'select':'input');input.dataset.recordCategory=category;input.dataset.recordId=item.id;input.dataset.recordField=field;
        input.setAttribute('aria-label',`${labelText}: ${title.textContent}`);
        if(options)for(const value of options){const option=document.createElement('option');option.value=value;option.textContent=value?capitalizeFirst(value.replaceAll('_',' ')):'Not provided';input.append(option);}
        if(field==='severityScore'){input.type='number';input.min='1';input.max='10';input.step='1';}
        input.value=item[field]??'';
        input.addEventListener('input',()=>{
          let value=input.value.trim();if(field==='severityScore'){value=value===''?null:Number(value);item.painScore=value;}
          else value=value||null;
          item[field]=value;
          if(category==='diet'&&field==='description')item.item=value;
          if(category==='vitals'&&field==='name')item.type=value;
        });
        label.append(input);form.append(label);
      }
      const remove=document.createElement('button');remove.type='button';remove.className='review-edit';remove.textContent='Remove this item';remove.onclick=()=>{excludedIds.add(item.id);checkinState[category]=checkinState[category].filter(other=>other.id!==item.id);renderReview();};form.append(remove);
      edit.onclick=()=>{if(!form.hidden){renderReview();return;}form.hidden=false;edit.textContent='Done';form.querySelector('input,select')?.focus();};
      head.append(title,edit);card.append(head,summary,form);return card;
    }
    function renderReview() {
      for(const [category,sectionId,targetId] of [['symptoms','reviewSymptomsSection','reviewSymptoms'],['medications','reviewMedicationsSection','reviewMedications'],['diet','reviewDietSection','reviewDiet'],['vitals','reviewVitalsSection','reviewVitals']]) {
        const entries=checkinState[category];document.getElementById(sectionId).hidden=!entries.length;document.getElementById(targetId).replaceChildren(...entries.map(item=>renderReviewCard(category,item)));
      }
      const hasWellness=Boolean(checkinState.generalStatus&&checkinState.backendRecord?.wellness);
      document.getElementById('reviewWellnessSection').hidden=!hasWellness;
      const wellness=document.getElementById('reviewWellness');wellness.replaceChildren();
      if(hasWellness){
        const card=document.createElement('div');card.className='review-card';
        const text=document.createElement('p');text.textContent=checkinState.backendRecord.wellness.statement;
        const remove=document.createElement('button');remove.className='review-edit';remove.textContent='Remove wellness statement';
        remove.onclick=()=>{checkinState.generalStatus=null;checkinState.noSymptoms=false;checkinState.backendRecord.wellness=null;renderReview();};
        card.append(text,remove);wellness.append(card);
      }
      document.getElementById('reviewResolvedSection').hidden=true;
      document.getElementById('reviewVitalsSource').textContent='You reported these readings.';
      document.getElementById('reviewEmptyNote').hidden=hasWellness||['symptoms','medications','diet','vitals'].some(key=>checkinState[key].length);
      checkinFlow.querySelector('.review-date').textContent=new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
    }
    document.getElementById('flowIntroMic').addEventListener('click',()=>{
      if(conversationEnabled)startVoiceConversation();
      else void run(async()=>{showFlowScreen('listening');await flowVoiceRecognizer.start();});
    });
    document.getElementById('flowType').addEventListener('click',()=>{if(!uiBusy)showFlowScreen('listening');});
    document.querySelector('.flow-done').addEventListener('click',()=>run(async()=>{
      const text=(await flowVoiceRecognizer.stop()).trim();if(!text)throw new Error('Please speak or type your check-in before continuing.');
      integrationStatus.textContent='Organizing your check-in…';
      checkinState.transcript=text;excludedIds.clear();client.reset();mergeAnalysisIntoState(await client.start(text));renderDetectedTopics();showFlowScreen('topics');
    }));
    checkinFlow.querySelector('[data-screen="topics"] [data-next]').addEventListener('click',()=>run(async()=>{applyTopicExclusions();await advanceQuestion();}));
    document.getElementById('editTopics').addEventListener('click',()=>{if(!uiBusy){flowTranscript.value=checkinState.transcript;showFlowScreen('listening');}});
    checkinFlow.querySelectorAll('.pain-score-button').forEach(button=>button.addEventListener('click',()=>{
      if(uiBusy)return;selectedScore=Number(button.textContent);checkinFlow.querySelectorAll('.pain-score-button').forEach(other=>other.classList.toggle('selected',other===button));
    }));
    document.getElementById('painScoreContinue').addEventListener('click',()=>run(async()=>{if(selectedScore===null)throw new Error('Choose a pain score from 1 to 10, or skip this question.');await submitAnswer(selectedScore);}));
    document.getElementById('painScoreSkip').addEventListener('click',()=>run(async()=>{mergeAnalysisIntoState(await client.skip());await advanceQuestion();}));
    checkinFlow.querySelectorAll('input[name="impact"]').forEach(input=>input.addEventListener('change',()=>{
      if(input.checked&&input.value==='none')checkinFlow.querySelectorAll('input[name="impact"]').forEach(other=>{if(other!==input)other.checked=false;});
      else if(input.checked)checkinFlow.querySelector('input[name="impact"][value="none"]').checked=false;
    }));
    checkinFlow.querySelector('[data-screen="additional"] [data-next]').addEventListener('click',()=>run(async()=>{
      const typed=(await followupRecognizer.stop()).trim();
      const choices=[...checkinFlow.querySelectorAll('input[name="impact"]:checked')].map(input=>input.value==='none'?'Not affecting activities':input.parentElement.textContent.trim());
      const answer=[...choices,typed].filter(Boolean).join('; ');
      if(!answer)throw new Error('Select an effect, type an answer, or skip this question.');
      await submitAnswer(answer,{spoken:choices.length===0&&followupRecognizer.mode==='spoken'});
    }));
    for(const name of ['pain-score','additional','medication','guided','vital']) {
      const screen=checkinFlow.querySelector(`[data-screen="${name}"]`);const actions=document.createElement('div');actions.className='integration-question-actions';
      if(name!=='pain-score'){const skip=document.createElement('button');skip.className='pain-score-skip';skip.textContent='Skip this question';skip.dataset.integrationSkip='';skip.onclick=()=>run(async()=>{stopAllVoice();mergeAnalysisIntoState(await client.skip());await advanceQuestion();});actions.append(skip);}
      const review=document.createElement('button');review.className='flow-edit';review.textContent='Review what I have';review.dataset.integrationReview='';review.onclick=()=>run(enterReview);actions.append(review);screen.append(actions);
    }
    document.getElementById('reviewConfirmSave').addEventListener('click',()=>run(async()=>{
      const record=toBackendRecord(checkinState);
      for(const symptom of record.symptoms)if(symptom.severityScore!==null&&(!Number.isInteger(symptom.severityScore)||symptom.severityScore<1||symptom.severityScore>10))throw new Error('Pain scores must be whole numbers from 1 to 10, or left blank.');
      const response=await client.save(record);mergeAnalysisIntoState(response);checkinState.completed=true;addMealsFromCheckin();checkinHistory.push({timestamp:new Date().toISOString(),...structuredClone(checkinState)});renderSavedHistory();renderMealsMain();showFlowScreen('trends');integrationStatus.textContent='Saved in temporary server memory. Records are lost when the backend restarts.';
    }));
    function renderSavedHistory() {
      const history = document.querySelector('.checkin-history');
      history.replaceChildren(); logRows.replaceChildren();
      for (const entry of [...checkinHistory].reverse()) {
        const date = new Date(entry.timestamp).toLocaleDateString('en-US', {month:'short',day:'numeric'});
        const details = [
          ...entry.symptoms.map(item => `${symptomLabel(item)}${item.painScore == null ? '' : ` (${item.painScore}/10)`}`),
          ...entry.medications.map(item => `${item.name || 'Unidentified medication'}: ${(item.status || 'mentioned').replaceAll('_',' ')}`),
          ...entry.diet.map(item => `${item.mealType ? `${item.mealType}: ` : ''}${item.item}`),
          ...entry.vitals.map(item => `${item.type}: ${[item.value,item.unit].filter(Boolean).join(' ') || 'value not provided'}`),
          ...(entry.backendRecord?.wellness ? [entry.backendRecord.wellness.statement] : []),
        ].join('; ');
        const row = document.createElement('div'); row.className = 'checkin-history-row';
        const when = document.createElement('div'); when.className = 'checkin-history-date'; when.textContent = date;
        const copy = document.createElement('div'); copy.className = 'checkin-history-copy'; copy.textContent = details;
        row.append(when,copy); history.append(row);
        const log = document.createElement('tr');
        for (const value of [date,details,entry.symptoms.filter(item => item.painScore != null).map(item => `${symptomLabel(item)}: ${item.painScore}/10`).join('; ') || 'Not recorded']) {
          const cell = document.createElement('td'); cell.textContent = value; log.append(cell);
        }
        logRows.append(log);
      }
      emptyLog.hidden = checkinHistory.length > 0;
    }
    checkinFlow.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',closeCheckinFlow));
    document.getElementById('flowClose').addEventListener('click',closeCheckinFlow);
    document.getElementById('flowBack').addEventListener('click',()=>{if(uiBusy)return;if (conversation?.active) conversation.stop();stopAllVoice();if(currentFlowScreen==='intro')closeCheckinFlow();else{flowTranscript.value=checkinState.transcript;showFlowScreen('listening');}});
    checkinFlow.addEventListener('click',event=>{if(event.target===checkinFlow)closeCheckinFlow();});
    checkinFlow.querySelectorAll('[data-back]').forEach(button=>button.addEventListener('click',()=>{if(!uiBusy)showFlowScreen(button.dataset.back);}));
    document.getElementById('trendsNav').addEventListener('click',()=>{stopAllVoice();showPatientView('trends');});
    document.getElementById('homeNav').addEventListener('click',()=>{stopAllVoice();showPatientView('home');});
    document.getElementById('moreNav').addEventListener('click',()=>{stopAllVoice();showPatientView('more');});
    document.getElementById('mealsNav').addEventListener('click',()=>{stopAllVoice();showPatientView('meals');});
    const keydown=event=>{if(event.key==='Escape')closeCheckinFlow();};document.addEventListener('keydown',keydown);
    resetCheckinState();
    return {state:checkinState,client,mealState,conversation,open:openCheckinFlow,getCurrentScreen:()=>currentFlowScreen,destroy(){destroyed=true;conversation.destroy();stopAllVoice();for(const recognition of [...recognizers])recognition.destroy();document.removeEventListener('keydown',keydown);}};
}
