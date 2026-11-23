
/*
  LUXMY — A little reminder. A lot of care.

  Voice-powered medication reminder prototype.
  Inspired by Vijayaluxmy.

  English and Romanized Tamil.
  No external libraries required.

  IMPORTANT:
  Experimental demonstration only.
  Not a medical device or reliable medication alarm.
*/

(function () {
  'use strict';

  // ===========================
  // SETTINGS
  // ===========================

  const STORAGE_KEY = 'luxmy.v1.reminders';
  const MAX_REMINDERS = 20;
  const LATE_LIMIT_MINUTES = 2;

  const VALID_STATUSES = [
    'upcoming',
    'postponed',
    'unconfirmed',
    'taken',
    'skipped'
  ];

  // ===========================
  // LANGUAGES
  // ===========================

  const LANGUAGES = {
    en: {
      name: 'English',
      speechLang: 'en-US',

      test: function (medicine) {
        return (
          'Test reminder. ' +
          'This is how your reminder will sound. ' +
          'It is time for ' + medicine + '.'
        );
      },

      reminder: function (medicine) {
        return (
          'Medication reminder. ' +
          'It is time for ' + medicine + '. ' +
          'After you take it, please confirm on the screen.'
        );
      },

      enabled: 'Voice reminders are on.'
    },

    ta: {
      name: 'Tamil',

      /*
        Tamil is written in English letters.

        An English speech voice is used because
        the selected Tamil voice was not reading
        Tamil script correctly during testing.

        This is an experimental workaround.
        Pronunciation may not sound natural.
      */

      speechLang: 'en-US',

      test: function (medicine) {
        return (
          'Sothanai ninaivootal. ' +
          'Ungal ninaivootal ippadi thaan olikkum. ' +
          'Ippozhuthu ' + medicine +
          ' marundhai eduththukkolla vendiya neram.'
        );
      },

      reminder: function (medicine) {
        return (
          'Marundhu ninaivootal. ' +
          'Ippozhuthu ' + medicine +
          ' marundhai eduththukkolla vendiya neram. ' +
          'Eduththa piragu, thiraiyil urudhippaduththungal.'
        );
      },

      enabled:
        'Kural ninaivootalgal iyakkaththil ullana.'
    }
  };

  // ===========================
  // APP STATE
  // ===========================

  let reminders = [];
  let voices = [];
  let voiceEnabled = false;
  let storageWorks = true;
  let postponeDrafts = {};
  let activeUtterances = [];

  // ===========================
  // HTML ELEMENTS
  // ===========================

  function $(id) {
    return document.getElementById(id);
  }

  const els = {
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

  // ===========================
  // HELPER FUNCTIONS
  // ===========================

  function pad2(number) {
    return String(number).padStart(2, '0');
  }

  function todayKey() {
    const d = new Date();

    return (
      d.getFullYear() + '-' +
      pad2(d.getMonth() + 1) + '-' +
      pad2(d.getDate())
    );
  }

  function minutesNow() {
    const d = new Date();

    return d.getHours() * 60 + d.getMinutes();
  }

  function toMinutes(time) {
    const parts = time.split(':');

    return (
      Number(parts[0]) * 60 +
      Number(parts[1])
    );
  }

  function fromMinutes(minutes) {
    minutes = Math.max(
      0,
      Math.min(1439, minutes)
    );

    return (
      pad2(Math.floor(minutes / 60)) +
      ':' +
      pad2(minutes % 60)
    );
  }

  function formatTime(time) {
    const parts = time.split(':');
    const hour = Number(parts[0]);

    const suffix = hour >= 12 ? 'PM' : 'AM';

    return (
      (hour % 12 || 12) +
      ':' +
      parts[1] +
      ' ' +
      suffix
    );
  }

  function effectiveTime(reminder) {
    return reminder.postponedTo || reminder.time;
  }

  function newId() {
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7)
    );
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
      node.className = className;
    }

    if (text !== undefined && text !== null) {
      node.textContent = text;
    }

    return node;
  }

  function makeButton(
    label,
    className,
    onClick,
    ariaLabel
  ) {
    const button = createElement(
      'button',
      'btn ' + className,
      label
    );

    button.type = 'button';

    if (ariaLabel) {
      button.setAttribute(
        'aria-label',
        ariaLabel
      );
    }

    button.addEventListener('click', onClick);

    return button;
  }

  function announce(message) {
    els.srStatus.textContent = '';

    setTimeout(function () {
      els.srStatus.textContent = message;
    }, 50);
  }

  function findReminder(id) {
    return reminders.find(function (r) {
      return r.id === id;
    }) || null;
  }

  function sortedReminders() {
    return reminders.slice().sort(function (a, b) {
      return (
        toMinutes(effectiveTime(a)) -
        toMinutes(effectiveTime(b))
      );
    });
  }

  // ===========================
  // LOCAL STORAGE
  // ===========================

  function normalizeReminder(r) {
    if (
      !r ||
      typeof r.name !== 'string' ||
      typeof r.time !== 'string' ||
      !/^\d{2}:\d{2}$/.test(r.time)
    ) {
      return null;
    }

    return {
      id: typeof r.id === 'string'
        ? r.id
        : newId(),

      name: r.name.slice(0, 40),

      time: r.time,

      lang: LANGUAGES[r.lang]
        ? r.lang
        : 'en',

      status: VALID_STATUSES.includes(r.status)
        ? r.status
        : 'upcoming',

      postponedTo:
        typeof r.postponedTo === 'string' &&
        /^\d{2}:\d{2}$/.test(r.postponedTo)
          ? r.postponedTo
          : null,

      date: typeof r.date === 'string'
        ? r.date
        : todayKey(),

      late: r.late === true
    };
  }

  function loadReminders() {
    try {
      const stored = localStorage.getItem(
        STORAGE_KEY
      );

      if (!stored) {
        return [];
      }

      const data = JSON.parse(stored);

      if (!Array.isArray(data)) {
        return [];
      }

      return data
        .map(normalizeReminder)
        .filter(Boolean);

    } catch (error) {
      storageWorks = false;
      return [];
    }
  }

  function saveReminders() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(reminders)
      );

    } catch (error) {
      storageWorks = false;
    }

    updateStorageNote();
  }

  function checkStorage() {
    try {
      localStorage.setItem(
        'luxmy.storage.test',
        '1'
      );

      localStorage.removeItem(
        'luxmy.storage.test'
      );

      storageWorks = true;

    } catch (error) {
      storageWorks = false;
    }
  }

  function updateStorageNote() {
    els.storageNote.textContent = storageWorks
      ? 'Your demonstration schedule is saved only in this browser on this device.'
      : 'Saving is unavailable. Reminders may disappear after refreshing.';
  }

  function rolloverIfNewDay() {
    const today = todayKey();

    let changed = false;

    reminders.forEach(function (reminder) {
      if (reminder.date !== today) {
        reminder.date = today;
        reminder.status = 'upcoming';
        reminder.postponedTo = null;
        reminder.late = false;

        changed = true;
      }
    });

    return changed;
  }

  // ===========================
  // VOICE ENGINE
  // ===========================

  function speechSupported() {
    return (
      'speechSynthesis' in window &&
      typeof SpeechSynthesisUtterance !== 'undefined'
    );
  }

  function refreshVoices() {
    if (!speechSupported()) {
      return;
    }

    voices = speechSynthesis.getVoices() || [];
  }

  function normalizeLanguage(language) {
    return String(language || '')
      .replace('_', '-')
      .toLowerCase();
  }

  function pickVoice(langKey) {
    const config = LANGUAGES[langKey];

    const prefix = config.speechLang
      .split('-')[0]
      .toLowerCase();

    const matches = voices.filter(function (voice) {
      return (
        normalizeLanguage(voice.lang)
          .split('-')[0] === prefix
      );
    });

    if (!matches.length) {
      return null;
    }

    const exactMatches = matches.filter(
      function (voice) {
        return (
          normalizeLanguage(voice.lang) ===
          config.speechLang.toLowerCase()
        );
      }
    );

    const pool = exactMatches.length
      ? exactMatches
      : matches;

    const localVoices = pool.filter(
      function (voice) {
        return voice.localService;
      }
    );

    return (
      localVoices.length
        ? localVoices[0]
        : pool[0]
    );
  }

  function setVoiceStatus(message, kind) {
    els.voiceStatus.textContent = message;

    els.voiceStatus.className =
      'voice-status' +
      (kind ? ' ' + kind : '');
  }

  function updateVoiceStatusForLanguage() {
    const langKey = els.lang.value;

    if (!speechSupported()) {
      setVoiceStatus(
        'This browser does not support spoken reminders.',
        'warn'
      );
      return;
    }

    refreshVoices();

    const voice = pickVoice(langKey);

    if (voice) {
      let message =
        'Voice ready: ' + voice.name + '.';

      if (langKey === 'ta') {
        message +=
          ' Romanized Tamil uses an English voice. Pronunciation may be accented.';
      }

      setVoiceStatus(message, 'ok');

    } else if (!voices.length) {
      setVoiceStatus(
        'Voices are still loading.',
        'warn'
      );

    } else {
      setVoiceStatus(
        'No matching voice found. Browser default will be used.',
        'warn'
      );
    }
  }

  function stopSpeech() {
    if (speechSupported()) {
      speechSynthesis.cancel();
    }

    activeUtterances = [];
  }

  function speak(text, langKey, options) {
    options = options || {};

    if (!speechSupported()) {
      setVoiceStatus(
        'Speech is not supported in this browser.',
        'warn'
      );

      return false;
    }

    if (!LANGUAGES[langKey]) {
      return false;
    }

    refreshVoices();

    const config = LANGUAGES[langKey];
    const voice = pickVoice(langKey);

    if (!options.queue) {
      stopSpeech();
    }

    const utterance =
      new SpeechSynthesisUtterance(text);

    utterance.lang = voice
      ? voice.lang
      : config.speechLang;

    if (voice) {
      utterance.voice = voice;
    }

    utterance.rate = 0.85;
    utterance.pitch = 1;
    utterance.volume = 1;

    // Keep a reference while speech is active.
    activeUtterances.push(utterance);

    function releaseUtterance() {
      activeUtterances = activeUtterances.filter(
        function (item) {
          return item !== utterance;
        }
      );
    }

    utterance.onstart = function () {
      console.log(
        'LUXMY speaking:',
        text
      );
    };

    utterance.onend = function () {
      releaseUtterance();

      console.log(
        'LUXMY finished speaking.'
      );
    };

    utterance.onerror = function (event) {
      releaseUtterance();

      if (
        event.error === 'canceled' ||
        event.error === 'interrupted'
      ) {
        return;
      }

      console.error(
        'LUXMY speech error:',
        event.error
      );

      setVoiceStatus(
        'Speech error: ' + event.error,
        'warn'
      );
    };

    try {
      speechSynthesis.speak(utterance);
      return true;

    } catch (error) {
      releaseUtterance();

      console.error(error);

      setVoiceStatus(
        'Could not start speech.',
        'warn'
      );

      return false;
    }
  }

  // The exact saved name is inserted here.
  function speakReminder(reminder, options) {
    const config = LANGUAGES[reminder.lang];

    const message = config.reminder(
      reminder.name
    );

    return speak(
      message,
      reminder.lang,
      options
    );
  }

  // ===========================
  // CLOCK AND SUMMARY
  // ===========================

  function updateClock() {
    const now = new Date();

    els.clockTime.textContent =
      now.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      });

    els.clockDate.textContent =
      now.toLocaleDateString([], {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
      });
  }

  function statusLabel(reminder) {
    switch (reminder.status) {
      case 'upcoming':
        return 'Upcoming';

      case 'postponed':
        return 'Postponed to ' +
          formatTime(effectiveTime(reminder));

      case 'unconfirmed':
        return 'Unconfirmed';

      case 'taken':
        return 'Taken';

      case 'skipped':
        return 'Skipped';

      default:
        return 'Upcoming';
    }
  }

  function renderNext() {
    const pending = sortedReminders().filter(
      function (r) {
        return (
          r.status === 'upcoming' ||
          r.status === 'postponed'
        );
      }
    );

    const waiting = reminders.filter(
      function (r) {
        return r.status === 'unconfirmed';
      }
    ).length;

    let text = '';

    if (pending.length) {
      const next = pending[0];

      text =
        next.name +
        ' at ' +
        formatTime(effectiveTime(next));

      if (waiting) {
        text +=
          '. ' +
          waiting +
          (waiting === 1
            ? ' reminder is'
            : ' reminders are') +
          ' waiting for your confirmation.';
      }

    } else if (waiting) {
      text =
        waiting +
        (waiting === 1
          ? ' reminder is'
          : ' reminders are') +
        ' waiting for your confirmation.';

    } else if (reminders.length) {
      text =
        'No more reminders are scheduled for today.';

    } else {
      text =
        'No reminders yet. Add one or load the demo schedule.';
    }

    els.nextSummary.textContent = text;
  }

  // ===========================
  // ALERT CARDS
  // ===========================

  function renderAlerts() {
    const waiting = sortedReminders().filter(
      function (r) {
        return r.status === 'unconfirmed';
      }
    );

    els.alerts.textContent = '';

    document.title =
      (waiting.length
        ? '(' + waiting.length + ') Reminder – '
        : '') +
      'LUXMY – A little reminder. A lot of care.';

    if (!waiting.length) {
      return;
    }

    const section = createElement(
      'section',
      'alert-section'
    );

    section.setAttribute(
      'aria-label',
      'Reminders waiting for your confirmation'
    );

    section.appendChild(
      createElement(
        'h2',
        null,
        'Please confirm'
      )
    );

    waiting.forEach(function (reminder) {
      const card = createElement(
        'div',
        'alert-card'
      );

      card.appendChild(
        createElement(
          'p',
          'alert-title',
          reminder.name
        )
      );

      let meta =
        'Scheduled for ' +
        formatTime(effectiveTime(reminder)) +
        ' · ' +
        LANGUAGES[reminder.lang].name;

      if (reminder.postponedTo) {
        meta =
          'Postponed to ' +
          formatTime(reminder.postponedTo) +
          ' (originally ' +
          formatTime(reminder.time) +
          ') · ' +
          LANGUAGES[reminder.lang].name;
      }

      card.appendChild(
        createElement(
          'p',
          'alert-meta',
          meta
        )
      );

      let statusText =
        'Unconfirmed: waiting for you to tell LUXMY what happened.';

      if (reminder.late) {
        statusText +=
          ' This reminder time passed while LUXMY was not open or active.';
      }

      card.appendChild(
        createElement(
          'p',
          'alert-status',
          statusText
        )
      );

      const actions = createElement(
        'div',
        'alert-actions'
      );

      actions.appendChild(
        makeButton(
          'Taken',
          'btn-primary',
          function () {
            setStatus(reminder.id, 'taken');
          },
          'Mark ' + reminder.name + ' as taken'
        )
      );

      actions.appendChild(
        makeButton(
          'Skipped',
          'btn-secondary',
          function () {
            setStatus(reminder.id, 'skipped');
          },
          'Mark ' + reminder.name + ' as skipped'
        )
      );

      actions.appendChild(
        makeButton(
          'Postpone',
          'btn-secondary',
          function () {
            openPostpone(reminder.id);
          },
          'Postpone ' + reminder.name
        )
      );

      actions.appendChild(
        makeButton(
          'Hear again',
          'btn-ghost',
          function () {
            speakReminder(reminder);
          },
          'Hear ' + reminder.name + ' again'
        )
      );

      card.appendChild(actions);

      if (postponeDrafts[reminder.id]) {
        card.appendChild(
          buildPostponePanel(reminder)
        );
      }

      section.appendChild(card);
    });

    els.alerts.appendChild(section);
  }

  // ===========================
  // POSTPONE PANEL
  // ===========================

  function buildPostponePanel(reminder) {
    const draft = postponeDrafts[reminder.id];

    const panel = createElement(
      'div',
      'postpone-panel'
    );

    const label = createElement(
      'label',
      null,
      'New reminder time (today)'
    );

    const inputId =
      'postpone-time-' + reminder.id;

    label.setAttribute('for', inputId);

    panel.appendChild(label);

    const input = document.createElement(
      'input'
    );

    input.type = 'time';
    input.id = inputId;
    input.value = draft.time;

    input.addEventListener(
      'input',
      function () {
        draft.time = input.value;
      }
    );

    panel.appendChild(input);

    panel.appendChild(
      createElement(
        'p',
        'hint',
        'This only changes when LUXMY reminds you again. It is not advice about delaying a dose. Ask a healthcare professional if unsure.'
      )
    );

    if (draft.error) {
      panel.appendChild(
        createElement(
          'p',
          'postpone-error',
          draft.error
        )
      );
    }

    const row = createElement(
      'div',
      'button-row'
    );

    row.appendChild(
      makeButton(
        'Set new time',
        'btn-primary',
        function () {
          confirmPostpone(reminder.id);
        }
      )
    );

    row.appendChild(
      makeButton(
        'Cancel',
        'btn-ghost',
        function () {
          delete postponeDrafts[reminder.id];
          render();
        }
      )
    );

    panel.appendChild(row);

    return panel;
  }

  // ===========================
  // TODAY'S REMINDERS
  // ===========================

  function renderList() {
    els.list.textContent = '';

    const sorted = sortedReminders();

    els.empty.hidden = sorted.length > 0;

    sorted.forEach(function (reminder) {
      const item = createElement(
        'li',
        'reminder-item status-' +
        reminder.status
      );

      const top = createElement(
        'div',
        'item-top'
      );

      const left = createElement('div');

      left.appendChild(
        createElement(
          'p',
          'item-time',
          formatTime(effectiveTime(reminder))
        )
      );

      left.appendChild(
        createElement(
          'p',
          'item-name',
          reminder.name
        )
      );

      let meta =
        LANGUAGES[reminder.lang].name +
        ' reminder';

      if (reminder.postponedTo) {
        meta +=
          ' · originally ' +
          formatTime(reminder.time);
      }

      left.appendChild(
        createElement(
          'p',
          'item-meta',
          meta
        )
      );

      top.appendChild(left);

      top.appendChild(
        createElement(
          'span',
          'badge badge-' + reminder.status,
          statusLabel(reminder)
        )
      );

      item.appendChild(top);

      const actions = createElement(
        'div',
        'item-actions'
      );

      actions.appendChild(
        makeButton(
          'Hear',
          'btn-secondary btn-small',
          function () {
            speakReminder(reminder);
          },
          'Hear ' + reminder.name
        )
      );

      if (
        reminder.status === 'taken' ||
        reminder.status === 'skipped'
      ) {
        actions.appendChild(
          makeButton(
            'Undo',
            'btn-ghost btn-small',
            function () {
              setStatus(
                reminder.id,
                'upcoming'
              );
            },
            'Undo ' + reminder.name
          )
        );
      }

      actions.appendChild(
        makeButton(
          'Remove',
          'btn-ghost btn-small',
          function () {
            removeReminder(reminder.id);
          },
          'Remove ' + reminder.name
        )
      );

      item.appendChild(actions);

      els.list.appendChild(item);
    });
  }

  function render() {
    renderNext();
    renderAlerts();
    renderList();
  }

  // ===========================
  // REMINDER ACTIONS
  // ===========================

  function setStatus(id, status) {
    const reminder = findReminder(id);

    if (!reminder) {
      return;
    }

    reminder.status = status;
    reminder.postponedTo = null;
    reminder.late = false;
    reminder.date = todayKey();

    delete postponeDrafts[id];

    stopSpeech();
    saveReminders();
    render();

    announce(
      reminder.name +
      ' marked as ' +
      status +
      '.'
    );

    if (status === 'upcoming') {
      tick();
    }
  }

  function openPostpone(id) {
    const suggestion = Math.min(
      minutesNow() + 10,
      1439
    );

    postponeDrafts[id] = {
      time: fromMinutes(suggestion),
      error: ''
    };

    render();

    const input = $(
      'postpone-time-' + id
    );

    if (input) {
      input.focus();
    }
  }

  function confirmPostpone(id) {
    const reminder = findReminder(id);
    const draft = postponeDrafts[id];

    if (!reminder || !draft) {
      return;
    }

    if (
      !/^\d{2}:\d{2}$/.test(
        draft.time || ''
      )
    ) {
      draft.error = 'Please choose a time.';
      render();
      return;
    }

    if (
      toMinutes(draft.time) <=
      minutesNow()
    ) {
      draft.error =
        'Please choose a time later than now.';

      render();
      return;
    }

    reminder.status = 'postponed';
    reminder.postponedTo = draft.time;
    reminder.late = false;

    delete postponeDrafts[id];

    stopSpeech();
    saveReminders();
    render();

    announce(
      reminder.name +
      ' postponed to ' +
      formatTime(reminder.postponedTo)
    );
  }

  function removeReminder(id) {
    reminders = reminders.filter(
      function (reminder) {
        return reminder.id !== id;
      }
    );

    delete postponeDrafts[id];

    saveReminders();
    render();

    announce('Reminder removed.');
  }

  // ===========================
  // ADD A REMINDER
  // ===========================

  function showFormMessage(message, kind) {
    els.formMessage.textContent = message;

    els.formMessage.className =
      'form-message' +
      (kind ? ' ' + kind : '');
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

    const name = els.name.value.trim();
    const time = els.time.value;
    const lang = els.lang.value;

    if (!name) {
      showFormMessage(
        'Please enter a medication name.',
        'error'
      );

      els.name.focus();
      return;
    }

    if (!time) {
      showFormMessage(
        'Please choose a reminder time.',
        'error'
      );

      els.time.focus();
      return;
    }

    if (reminders.length >= MAX_REMINDERS) {
      showFormMessage(
        'This demo can hold up to ' +
        MAX_REMINDERS +
        ' reminders. Please remove one first.',
        'error'
      );

      return;
    }

    addReminder(
      name,
      time,
      lang
    );

    saveReminders();

    els.name.value = '';

    showFormMessage(
      'Reminder added for ' +
      formatTime(time) +
      '.',
      'ok'
    );

    render();
    tick();

    els.name.focus();
  }

  // ===========================
  // TEST VOICE
  // ===========================

  function handleTestVoice() {
    // Uses whatever name is in the input field.
    const medicine =
      els.name.value.trim() ||
      'your demo medicine';

    const langKey = els.lang.value;

    // The test and scheduled reminders
    // both insert the medication name.
    const message =
      LANGUAGES[langKey].test(medicine);

    showFormMessage(
      'Language: ' +
      LANGUAGES[langKey].name +
      ' | Speaking: ' +
      message,
      'ok'
    );

    speak(
      message,
      langKey
    );
  }

  // ===========================
  // ENABLE VOICE
  // ===========================

  function handleEnableVoice() {
    if (!speechSupported()) {
      updateVoiceStatusForLanguage();
      return;
    }

    voiceEnabled = true;

    els.enableVoice.setAttribute(
      'aria-pressed',
      'true'
    );

    els.enableVoice.textContent =
      'Voice reminders are on';

    const langKey = els.lang.value;

    speak(
      LANGUAGES[langKey].enabled,
      langKey
    );
  }

  // ===========================
  // DEMO REMINDERS
  // ===========================

  function handleDemo() {
    if (
      reminders.length + 3 >
      MAX_REMINDERS
    ) {
      showFormMessage(
        'Please remove some reminders first.',
        'error'
      );

      return;
    }

    const now = minutesNow();

    // Fictional demonstration names only.

    addReminder(
      'Calmora (demo)',
      fromMinutes(now + 1),
      'en'
    );

    addReminder(
      'Verdex (demo)',
      fromMinutes(now + 2),
      'ta'
    );

    addReminder(
      'Sagelin (demo)',
      '20:00',
      'en'
    );

    saveReminders();

    showFormMessage(
      'Demo schedule loaded. These medications are fictional.',
      'ok'
    );

    render();

    announce('Demo schedule loaded.');
  }

  function handleClear() {
    if (!reminders.length) {
      return;
    }

    if (
      window.confirm(
        'Remove all reminders from this device?'
      )
    ) {
      reminders = [];
      postponeDrafts = {};

      stopSpeech();
      saveReminders();
      render();

      announce('All reminders removed.');
    }
  }

  // ===========================
  // AUTOMATIC SCHEDULER
  // ===========================

  function tick() {
    updateClock();

    let changed = rolloverIfNewDay();

    const now = minutesNow();
    const toSpeak = [];

    reminders.forEach(function (reminder) {
      if (
        reminder.status !== 'upcoming' &&
        reminder.status !== 'postponed'
      ) {
        return;
      }

      const due = toMinutes(
        effectiveTime(reminder)
      );

      if (now >= due) {
        const late =
          (now - due) >
          LATE_LIMIT_MINUTES;

        reminder.status = 'unconfirmed';
        reminder.late = late;

        changed = true;

        // Only speak if the user has
        // enabled voice in this session.
        if (!late && voiceEnabled) {
          toSpeak.push(reminder);
        }
      }
    });

    if (changed) {
      saveReminders();
      render();
    }

    toSpeak.forEach(
      function (reminder, index) {
        speakReminder(
          reminder,
          { queue: index > 0 }
        );
      }
    );

    if (toSpeak.length) {
      announce(
        'Reminder: ' +
        toSpeak.map(function (reminder) {
          return reminder.name;
        }).join(', ') +
        '. Please confirm on the screen.'
      );
    }
  }

  // ===========================
  // INITIALIZE APP
  // ===========================

  function init() {
    checkStorage();

    reminders = loadReminders();

    const changed = rolloverIfNewDay();

    if (changed) {
      saveReminders();
    }

    // Default new reminder time.
    els.time.value = fromMinutes(
      minutesNow() + 5
    );

    if (speechSupported()) {
      refreshVoices();

      speechSynthesis.onvoiceschanged =
        function () {
          refreshVoices();
          updateVoiceStatusForLanguage();
        };

    } else {
      els.enableVoice.disabled = true;
    }

    updateVoiceStatusForLanguage();

    els.form.addEventListener(
      'submit',
      handleSubmit
    );

    els.testVoice.addEventListener(
      'click',
      handleTestVoice
    );

    els.enableVoice.addEventListener(
      'click',
      handleEnableVoice
    );

    els.demoBtn.addEventListener(
      'click',
      handleDemo
    );

    els.clearBtn.addEventListener(
      'click',
      handleClear
    );

    els.lang.addEventListener(
      'change',
      updateVoiceStatusForLanguage
    );

    document.addEventListener(
      'visibilitychange',
      function () {
        if (!document.hidden) {
          tick();
        }
      }
    );

    window.addEventListener(
      'focus',
      tick
    );

    updateStorageNote();
    updateClock();
    render();
    tick();

    // Check once per second while active.
    window.setInterval(
      tick,
      1000
    );
  }

  init();

})();
