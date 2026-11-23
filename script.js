/* ===== LUXMY – Version 1 prototype =====
   Experimental prototype. Not a medical device.
   Uses only: vanilla JavaScript, Web Speech API, localStorage. */

(function () {
  'use strict';

  /* ---------- Settings ---------- */
  var STORAGE_KEY = 'luxmy.v1.reminders';
  var MAX_REMINDERS = 20;
  var LATE_LIMIT_MINUTES = 2; // older than this when noticed: show silently
  var VALID_STATUS = ['upcoming', 'postponed', 'unconfirmed', 'taken', 'skipped'];

  var LANGUAGES = {
    en: {
      label: 'English',
      name: 'English',
      speechLang: 'en-US',
      prefix: 'en',
      reminder: function (n) {
        return 'Medication reminder. It is time for ' + n + '. After you take it, please confirm on the screen.';
      },
      test: function (n) {
        return 'Test reminder. This is how your reminder will sound. It is time for ' + n + '.';
      },
      enabled: 'Voice reminders are on.'
    },
    ta: {
      label: 'தமிழ் (Tamil)',
      name: 'Tamil',
      speechLang: 'ta-IN',
      prefix: 'ta',
      reminder: function (n) {
        return 'மருந்து நினைவூட்டல். ' + n + ' எடுத்துக்கொள்ளும் நேரம் இது. எடுத்துக்கொண்ட பிறகு, திரையில் உறுதிப்படுத்தவும்.';
      },
      test: function (n) {
        return 'சோதனை நினைவூட்டல். உங்கள் நினைவூட்டல் இப்படி ஒலிக்கும். ' + n + ' எடுத்துக்கொள்ளும் நேரம் இது.';
      },
      enabled: 'குரல் நினைவூட்டல்கள் இயக்கத்தில் உள்ளன.'
    }
  };

  /* ---------- State ---------- */
  var reminders = [];
  var voices = [];
  var voiceEnabled = false;
  var storageWorks = true;
  var postponeDrafts = {}; // id -> { time: 'HH:MM', error: '' }

  /* ---------- Elements ---------- */
  function $(id) { return document.getElementById(id); }
  var els = {
    clockTime: $('clock-time'),
    clockDate: $('clock-date'),
    nextSummary: $('next-summary'),
    enableVoice: $('enable-voice'),
    voiceStatus: $('voice-status'),
    alerts: $('alerts'),
    form: $('reminder-form'),
    name: $('med-name'),
    time: $('med-time'),
    lang: $('med-lang'),
    testVoice: $('test-voice'),
    formMessage: $('form-message'),
    list: $('reminder-list'),
    empty: $('empty-state'),
    demoBtn: $('demo-btn'),
    clearBtn: $('clear-btn'),
    storageNote: $('storage-note'),
    srStatus: $('sr-status')
  };

  /* ---------- Small helpers ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function minutesNow() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function toMinutes(hhmm) {
    var p = hhmm.split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  function fromMinutes(m) {
    m = Math.max(0, Math.min(1439, m));
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  function formatTime(hhmm) {
    var p = hhmm.split(':');
    var h = parseInt(p[0], 10);
    var suffix = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 || 12;
    return h12 + ':' + p[1] + ' ' + suffix;
  }

  function effectiveTime(r) { return r.postponedTo || r.time; }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  function makeButton(label, className, onClick, ariaLabel) {
    var b = el('button', 'btn ' + className, label);
    b.type = 'button';
    if (ariaLabel) { b.setAttribute('aria-label', ariaLabel); }
    b.addEventListener('click', onClick);
    return b;
  }

  function announce(message) {
    els.srStatus.textContent = '';
    window.setTimeout(function () { els.srStatus.textContent = message; }, 50);
  }

  function findReminder(id) {
    for (var i = 0; i < reminders.length; i++) {
      if (reminders[i].id === id) { return reminders[i]; }
    }
    return null;
  }

  function sortedReminders() {
    return reminders.slice().sort(function (a, b) {
      return toMinutes(effectiveTime(a)) - toMinutes(effectiveTime(b));
    });
  }

  /* ---------- Storage ---------- */
  function normalize(r) {
    if (!r || typeof r.name !== 'string' || typeof r.time !== 'string' || !/^\d{2}:\d{2}$/.test(r.time)) {
      return null;
    }
    return {
      id: typeof r.id === 'string' ? r.id : newId(),
      name: r.name.slice(0, 40),
      time: r.time,
      lang: LANGUAGES[r.lang] ? r.lang : 'en',
      status: VALID_STATUS.indexOf(r.status) !== -1 ? r.status : 'upcoming',
      postponedTo: (typeof r.postponedTo === 'string' && /^\d{2}:\d{2}$/.test(r.postponedTo)) ? r.postponedTo : null,
      date: typeof r.date === 'string' ? r.date : todayKey(),
      late: r.late === true
    };
  }

  function loadReminders() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) { return []; }
      var data = JSON.parse(raw);
      if (!Array.isArray(data)) { return []; }
      return data.map(normalize).filter(function (r) { return r !== null; });
    } catch (e) {
      storageWorks = false;
      return [];
    }
  }

  function saveReminders() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders));
    } catch (e) {
      storageWorks = false;
    }
    updateStorageNote();
  }

  function checkStorage() {
    try {
      var k = STORAGE_KEY + '.test';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      storageWorks = true;
    } catch (e) {
      storageWorks = false;
    }
  }

  function updateStorageNote() {
    els.storageNote.textContent = storageWorks
      ? 'Your demonstration schedule is saved only in this browser on this device.'
      : 'Saving is not available in this browser, so your reminders will be lost when you refresh the page.';
  }

  /* ---------- New day: reset statuses ---------- */
  function rolloverIfNewDay() {
    var today = todayKey();
    var changed = false;
    reminders.forEach(function (r) {
      if (r.date !== today) {
        r.date = today;
        r.status = 'upcoming';
        r.postponedTo = null;
        r.late = false;
        changed = true;
      }
    });
    return changed;
  }

  /* ---------- Speech ---------- */
  function speechSupported() {
    return ('speechSynthesis' in window) && (typeof window.SpeechSynthesisUtterance !== 'undefined');
  }

  function normLang(l) { return String(l || '').replace('_', '-').toLowerCase(); }

  function refreshVoices() {
    if (!speechSupported()) { return; }
    voices = window.speechSynthesis.getVoices() || [];
  }

  function pickVoice(langKey) {
    var cfg = LANGUAGES[langKey];
    var matches = voices.filter(function (v) {
      return normLang(v.lang).split('-')[0] === cfg.prefix;
    });
    if (!matches.length) { return null; }
    var exact = matches.filter(function (v) { return normLang(v.lang) === cfg.speechLang.toLowerCase(); });
    var pool = exact.length ? exact : matches;
    var local = pool.filter(function (v) { return v.localService; });
    return (local.length ? local : pool)[0];
  }

  function setVoiceStatus(message, kind) {
    els.voiceStatus.textContent = message;
    els.voiceStatus.className = 'voice-status' + (kind ? ' ' + kind : '');
  }

  function updateVoiceStatusForLanguage() {
    var langKey = els.lang.value;
    var cfg = LANGUAGES[langKey];
    if (!speechSupported()) {
      setVoiceStatus('This browser does not support spoken reminders. Reminders will appear on screen only. Try a recent version of Chrome, Edge or Safari.', 'warn');
      return;
    }
    refreshVoices();
    var voice = pickVoice(langKey);
    if (voice) {
      setVoiceStatus('Voice ready for ' + cfg.name + ' (' + voice.name + ').', 'ok');
    } else if (voices.length === 0) {
      setVoiceStatus('Voices are still loading. If this message stays, your device may not offer spoken reminders.', 'warn');
    } else if (langKey === 'en') {
      setVoiceStatus('No English voice was found, so your device\'s default voice will be used.', 'warn');
    } else {
      setVoiceStatus('This device does not have a ' + cfg.name + ' voice installed, so ' + cfg.name + ' reminders will appear on screen only. You may be able to add a ' + cfg.name + ' voice in your device\'s language or accessibility settings.', 'warn');
    }
  }

  /* Returns true if speech was started (or attempted). */
  function speak(text, langKey, options) {
    options = options || {};
    var cfg = LANGUAGES[langKey];

    if (!speechSupported()) {
      setVoiceStatus('This browser does not support spoken reminders. The reminder is shown on screen only.', 'warn');
      return false;
    }

    refreshVoices();
    var voice = pickVoice(langKey);

    if (!voice && voices.length > 0 && langKey !== 'en') {
      setVoiceStatus('This device does not have a ' + cfg.name + ' voice installed, so this reminder is shown on screen only.', 'warn');
      return false;
    }

    var utter = new window.SpeechSynthesisUtterance(text);
    utter.lang = voice ? voice.lang : cfg.speechLang;
    if (voice) { utter.voice = voice; }
    utter.rate = 0.85;   // slightly slower for easier listening
    utter.pitch = 1;
    utter.volume = 1;

    var started = false;
    utter.onstart = function () { started = true; };
    utter.onerror = function (e) {
      if (e && (e.error === 'canceled' || e.error === 'interrupted')) { return; }
      if (e && e.error === 'not-allowed') {
        setVoiceStatus('Your browser blocked the voice. Please tap "Turn on voice reminders" or "Hear again".', 'warn');
      } else {
        setVoiceStatus('The voice could not be played on this device. The reminder is shown on screen.', 'warn');
      }
    };

    try {
      if (!options.queue) { window.speechSynthesis.cancel(); }
      window.speechSynthesis.speak(utter);
    } catch (err) {
      setVoiceStatus('The voice could not be played on this device. The reminder is shown on screen.', 'warn');
      return false;
    }

    // Some browsers stay silent without an error when speech is blocked.
    if (!options.queue) {
      window.setTimeout(function () {
        if (!started && !window.speechSynthesis.speaking) {
          setVoiceStatus('No sound started. Your browser may have blocked the voice, or the volume may be off. Try "Turn on voice reminders" or "Hear again".', 'warn');
        }
      }, 3000);
    }
    return true;
  }

  function speakReminder(r, options) {
    return speak(LANGUAGES[r.lang].reminder(r.name), r.lang, options);
  }

  /* ---------- Rendering ---------- */
  function statusLabel(r) {
    switch (r.status) {
      case 'upcoming': return 'Upcoming';
      case 'postponed': return 'Postponed to ' + formatTime(r.postponedTo || r.time);
      case 'unconfirmed': return 'Unconfirmed';
      case 'taken': return 'Taken';
      case 'skipped': return 'Skipped';
      default: return 'Upcoming';
    }
  }

  function updateClock() {
    var now = new Date();
    els.clockTime.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    els.clockDate.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function renderNext() {
    var pending = sortedReminders().filter(function (r) {
      return r.status === 'upcoming' || r.status === 'postponed';
    });
    var waiting = reminders.filter(function (r) { return r.status === 'unconfirmed'; }).length;
    var text;

    if (pending.length) {
      var next = pending[0];
      text = next.name + ' at ' + formatTime(effectiveTime(next));
      if (waiting) {
        text += '. ' + waiting + (waiting === 1 ? ' reminder is' : ' reminders are') + ' waiting for your confirmation.';
      }
    } else if (waiting) {
      text = waiting + (waiting === 1 ? ' reminder is' : ' reminders are') + ' waiting for your confirmation.';
    } else if (reminders.length) {
      text = 'No more reminders are scheduled for today.';
    } else {
      text = 'No reminders yet. Add one or load the demo schedule.';
    }
    els.nextSummary.textContent = text;
  }

  function renderAlerts() {
    var waiting = sortedReminders().filter(function (r) { return r.status === 'unconfirmed'; });
    els.alerts.textContent = '';
    document.title = (waiting.length ? '(' + waiting.length + ') Reminder – ' : '') + 'LUXMY – A little reminder. A lot of care.';
    if (!waiting.length) { return; }

    var section = el('section', 'alert-section');
    section.setAttribute('aria-label', 'Reminders waiting for your confirmation');
    section.appendChild(el('h2', null, 'Please confirm'));

    waiting.forEach(function (r) {
      var card = el('div', 'alert-card');
      card.appendChild(el('p', 'alert-title', r.name));

      var meta = 'Scheduled for ' + formatTime(effectiveTime(r)) + ' · ' + LANGUAGES[r.lang].name;
      if (r.postponedTo) { meta = 'Postponed time ' + formatTime(r.postponedTo) + ' (originally ' + formatTime(r.time) + ') · ' + LANGUAGES[r.lang].name; }
      card.appendChild(el('p', 'alert-meta', meta));

      var statusText = 'Unconfirmed: waiting for you to tell LUXMY what happened.';
      if (r.late) { statusText += ' This reminder time passed while LUXMY was not open or active.'; }
      card.appendChild(el('p', 'alert-status', statusText));

      var actions = el('div', 'alert-actions');
      actions.appendChild(makeButton('Taken', 'btn-primary', function () { setStatus(r.id, 'taken'); }, 'Mark ' + r.name + ' as taken'));
      actions.appendChild(makeButton('Skipped', 'btn-secondary', function () { setStatus(r.id, 'skipped'); }, 'Mark ' + r.name + ' as skipped'));
      actions.appendChild(makeButton('Postpone', 'btn-secondary', function () { openPostpone(r.id); }, 'Choose a new reminder time for ' + r.name));
      actions.appendChild(makeButton('Hear again', 'btn-ghost', function () { speakReminder(r); }, 'Hear the reminder for ' + r.name + ' again'));
      card.appendChild(actions);

      if (postponeDrafts[r.id]) {
        card.appendChild(buildPostponePanel(r));
      }
      section.appendChild(card);
    });

    els.alerts.appendChild(section);
  }

  function buildPostponePanel(r) {
    var draft = postponeDrafts[r.id];
    var panel = el('div', 'postpone-panel');

    var label = el('label', null, 'New reminder time (today)');
    var inputId = 'postpone-time-' + r.id;
    label.setAttribute('for', inputId);
    panel.appendChild(label);

    var input = document.createElement('input');
    input.type = 'time';
    input.id = inputId;
    input.value = draft.time;
    input.addEventListener('input', function () { draft.time = input.value; });
    panel.appendChild(input);

    panel.appendChild(el('p', 'hint', 'This only changes when LUXMY reminds you again. It is not advice about whether to delay a dose. If you are unsure, please ask a doctor or pharmacist.'));

    if (draft.error) {
      panel.appendChild(el('p', 'postpone-error', draft.error));
    }

    var row = el('div', 'button-row');
    row.appendChild(makeButton('Set new time', 'btn-primary', function () { confirmPostpone(r.id); }));
    row.appendChild(makeButton('Cancel', 'btn-ghost', function () { delete postponeDrafts[r.id]; render(); }));
    panel.appendChild(row);

    return panel;
  }

  function renderList() {
    els.list.textContent = '';
    var sorted = sortedReminders();
    els.empty.hidden = sorted.length > 0;

    sorted.forEach(function (r) {
      var li = el('li', 'reminder-item status-' + r.status);

      var top = el('div', 'item-top');
      var left = el('div');
      left.appendChild(el('p', 'item-time', formatTime(effectiveTime(r))));
      left.appendChild(el('p', 'item-name', r.name));

      var meta = LANGUAGES[r.lang].name + ' reminder';
      if (r.postponedTo) { meta += ' · originally ' + formatTime(r.time); }
      left.appendChild(el('p', 'item-meta', meta));
      top.appendChild(left);

      top.appendChild(el('span', 'badge badge-' + r.status, statusLabel(r)));
      li.appendChild(top);

      var actions = el('div', 'item-actions');
      actions.appendChild(makeButton('Hear', 'btn-secondary btn-small', function () { speakReminder(r); }, 'Hear the reminder for ' + r.name));
      if (r.status === 'taken' || r.status === 'skipped') {
        actions.appendChild(makeButton('Undo', 'btn-ghost btn-small', function () { setStatus(r.id, 'upcoming'); }, 'Undo the status of ' + r.name));
      }
      actions.appendChild(makeButton('Remove', 'btn-ghost btn-small', function () { removeReminder(r.id); }, 'Remove ' + r.name));
      li.appendChild(actions);

      els.list.appendChild(li);
    });
  }

  function render() {
    renderNext();
    renderAlerts();
    renderList();
  }

  /* ---------- Actions ---------- */
  function setStatus(id, status) {
    var r = findReminder(id);
    if (!r) { return; }
    r.status = status;
    r.postponedTo = null;
    r.late = false;
    r.date = todayKey();
    delete postponeDrafts[id];
    if (speechSupported()) { window.speechSynthesis.cancel(); }
    saveReminders();
    render();
    announce(r.name + ' marked as ' + (status === 'upcoming' ? 'upcoming again' : status) + '.');
    if (status === 'upcoming') { tick(); }
  }

  function openPostpone(id) {
    var suggested = Math.min(minutesNow() + 10, 1439);
    postponeDrafts[id] = { time: fromMinutes(suggested), error: '' };
    render();
    var input = document.getElementById('postpone-time-' + id);
    if (input) { input.focus(); }
  }

  function confirmPostpone(id) {
    var r = findReminder(id);
    var draft = postponeDrafts[id];
    if (!r || !draft) { return; }

    if (!/^\d{2}:\d{2}$/.test(draft.time || '')) {
      draft.error = 'Please choose a time.';
      render();
      return;
    }
    if (toMinutes(draft.time) <= minutesNow()) {
      draft.error = 'Please choose a time later than now.';
      render();
      return;
    }

    r.status = 'postponed';
    r.postponedTo = draft.time;
    r.late = false;
    delete postponeDrafts[id];
    if (speechSupported()) { window.speechSynthesis.cancel(); }
    saveReminders();
    render();
    announce(r.name + ' postponed. New reminder time ' + formatTime(r.postponedTo) + '.');
  }

  function removeReminder(id) {
    var r = findReminder(id);
    reminders = reminders.filter(function (x) { return x.id !== id; });
    delete postponeDrafts[id];
    saveReminders();
    render();
    if (r) { announce(r.name + ' removed.'); }
  }

  function showFormMessage(text, kind) {
    els.formMessage.textContent = text;
    els.formMessage.className = 'form-message' + (kind ? ' ' + kind : '');
  }

  function addReminder(name, time, lang) {
    reminders.push({
      id: newId(),
      name: name,
      time: time,
      lang: lang,
      status: 'upcoming',
      postponedTo: null,
      date: todayKey(),
      late: false
    });
  }

  function handleSubmit(event) {
    event.preventDefault();
    var name = els.name.value.trim();
    var time = els.time.value;
    var lang = els.lang.value;

    if (!name) {
      showFormMessage('Please enter a medication name.', 'error');
      els.name.focus();
      return;
    }
    if (!time) {
      showFormMessage('Please choose a reminder time.', 'error');
      els.time.focus();
      return;
    }
    if (reminders.length >= MAX_REMINDERS) {
      showFormMessage('This demo can hold up to ' + MAX_REMINDERS + ' reminders. Please remove one first.', 'error');
      return;
    }

    addReminder(name, time, lang);
    saveReminders();
    els.name.value = '';
    showFormMessage('Reminder added for ' + formatTime(time) + '.', 'ok');
    render();
    tick();
    els.name.focus();
  }

  function handleTestVoice() {
    var name = els.name.value.trim() || 'your demo medicine';
    var langKey = els.lang.value;
    var ok = speak(LANGUAGES[langKey].test(name), langKey);
    if (ok) {
      showFormMessage('Playing a test of the ' + LANGUAGES[langKey].name + ' voice…', 'ok');
    } else {
      showFormMessage('The test voice could not be played. See the voice message above.', 'error');
    }
  }

  function handleEnableVoice() {
    if (!speechSupported()) {
      updateVoiceStatusForLanguage();
      return;
    }
    voiceEnabled = true;
    els.enableVoice.setAttribute('aria-pressed', 'true');
    els.enableVoice.textContent = 'Voice reminders are on';
    var langKey = els.lang.value;
    speak(LANGUAGES[langKey].enabled, langKey);
  }

  function handleDemo() {
    var wanted = 3;
    if (reminders.length + wanted > MAX_REMINDERS) {
      showFormMessage('Not enough space for the demo schedule. Please remove some reminders first.', 'error');
      return;
    }
    var now = minutesNow();
    addReminder('Calmora (demo)', fromMinutes(now + 1), 'en');
    addReminder('Verdex (demo)', fromMinutes(now + 2), 'ta');
    addReminder('Sagelin (demo)', '20:00', 'en');
    saveReminders();
    showFormMessage('Demo schedule loaded. These medicines are fictional.', 'ok');
    render();
    announce('Demo schedule loaded.');
  }

  function handleClear() {
    if (!reminders.length) { return; }
    if (window.confirm('Remove all reminders from this device?')) {
      reminders = [];
      postponeDrafts = {};
      saveReminders();
      render();
      announce('All reminders removed.');
    }
  }

  /* ---------- Scheduler ---------- */
  function tick() {
    updateClock();
    var changed = rolloverIfNewDay();
    var now = minutesNow();
    var toSpeak = [];

    reminders.forEach(function (r) {
      if (r.status !== 'upcoming' && r.status !== 'postponed') { return; }
      var due = toMinutes(effectiveTime(r));
      if (now >= due) {
        var late = (now - due) > LATE_LIMIT_MINUTES;
        r.status = 'unconfirmed';
        r.late = late;
        changed = true;
        if (!late && voiceEnabled) { toSpeak.push(r); }
      }
    });

    if (changed) {
      saveReminders();
      render();
    }

    toSpeak.forEach(function (r, index) {
      speakReminder(r, { queue: index > 0 });
    });
    if (toSpeak.length) {
      announce('Reminder: ' + toSpeak.map(function (r) { return r.name; }).join(', ') + '. Please confirm on the screen.');
    }
  }

  /* ---------- Start up ---------- */
  function init() {
    checkStorage();
    reminders = loadReminders();
    rolloverIfNewDay();
    saveReminders();

    // Default the time field to five minutes from now
    els.time.value = fromMinutes(minutesNow() + 5);

    if (speechSupported()) {
      refreshVoices();
      window.speechSynthesis.onvoiceschanged = function () {
        refreshVoices();
        updateVoiceStatusForLanguage();
      };
    } else {
      els.enableVoice.disabled = true;
    }
    updateVoiceStatusForLanguage();

    els.form.addEventListener('submit', handleSubmit);
    els.testVoice.addEventListener('click', handleTestVoice);
    els.enableVoice.addEventListener('click', handleEnableVoice);
    els.demoBtn.addEventListener('click', handleDemo);
    els.clearBtn.addEventListener('click', handleClear);
    els.lang.addEventListener('change', updateVoiceStatusForLanguage);

    // Check immediately when the tab becomes visible again
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { tick(); }
    });
    window.addEventListener('focus', tick);

    updateStorageNote();
    updateClock();
    render();
    tick();
    window.setInterval(tick, 1000);
  }

  init();
})();
