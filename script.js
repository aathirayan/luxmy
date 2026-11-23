/*
  LUXMY — A little reminder. A lot of care.

  Voice-powered medication reminder prototype.
  Inspired by Vijayaluxmy.

  English and Tamil (Tamil script, spoken with a Tamil voice).
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

  const SCRIPT_VERSION = 'speech-v2 (23 Nov 2026)';

  const STORAGE_KEY = 'luxmy.v1.reminders';
  const MAX_REMINDERS = 20;
  const LATE_LIMIT_MINUTES = 2;
  const SPEECH_RATE = 0.85;

  const VALID_STATUSES = [
    'upcoming',
    'postponed',
    'unconfirmed',
    'taken',
    'skipped'
  ];

  const PREFERRED_LANG = {
    en: 'en-US',
    ta: 'ta-IN'
  };

  const LANGUAGE_NAMES = {
    en: 'English',
    ta: 'Tamil'
  };

  // ===========================
  // SPEECH "PARTS"
  // ===========================
  //
  // A reminder can be spoken as several short parts.
  // Each part says which voice language it needs:
  //   'ta' = Tamil voice, 'en' = English voice.
  // The medication name is its own part, spoken exactly
  // as typed, so Tamil sentences never contain English
  // letters (many Tamil voices cannot handle mixed text).

  function containsTamil(text) {
    return /[\u0B80-\u0BFF]/.test(String(text || ''));
  }

  function tamilPart(text) {
    return { text: text, voiceLang: 'ta', isName: false };
  }

  function nameSegment(name) {
    return {
      text: name,
      voiceLang: containsTamil(name) ? 'ta' : 'en',
      isName: true
    };
  }

  // ===========================
  // LANGUAGES
  // ===========================

  const LANGUAGES = {
    en: {
      name: 'English',
      speechLang: 'en-US',
      voicePrefix: 'en',
      fallbackName: 'your demo medicine',

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
      speechLang: 'ta-IN',
      voicePrefix: 'ta',
      fallbackName: 'Sample',

      /*
        Tamil is written in Tamil script and spoken by a
        Tamil voice. No punctuation is used inside the Tamil
        parts, because some voices read "." or "?" aloud as
        "dot" or "question mark". Each sentence is its own
        part, which also gives natural pauses.

        The medication name is a separate part, spoken exactly
        as typed.
      */

      test: function (medicine) {
        return [
          tamilPart('சோதனை நினைவூட்டல்'),
          tamilPart('உங்கள் நினைவூட்டல் இப்படித்தான் ஒலிக்கும்'),
          tamilPart('இப்போது'),
          nameSegment(medicine),
          tamilPart('மருந்து எடுத்துக்கொள்ள வேண்டிய நேரம்')
        ];
      },

      reminder: function (medicine) {
        return [
          tamilPart('மருந்து நினைவூட்டல்'),
          tamilPart('இப்போது'),
          nameSegment(medicine),
          tamilPart('மருந்து எடுத்துக்கொள்ள வேண்டிய நேரம்'),
          tamilPart('மருந்தை எடுத்துக்கொண்ட பிறகு திரையில் உறுதிப்படுத்துங்கள்')
        ];
      },

      enabled: 'குரல் நினைவூட்டல்கள் இயக்கத்தில் உள்ளன'
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
  let speechToken = 0;
  let tamilVoiceKey = '';

  const debugState = {
    lines: [],
    logEl: null,
    voiceSelect: null,
    voiceListEl: null
  };

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

  // Writes to the browser console AND to the small
  // "Voice diagnostics" box on the page.
  function debugLog(message) {
    const d = new Date();

    const stamp =
      pad2(d.getHours()) + ':' +
      pad2(d.getMinutes()) + ':' +
      pad2(d.getSeconds());

    const line = stamp + '  ' + message;

    console.log('LUXMY ' + line);

    debugState.lines.push(line);

    if (debugState.lines.length > 80) {
      debugState.lines.shift();
    }

    if (debugState.logEl) {
      debugState.logEl.textContent =
        debugState.lines.join('\n');

      debugState.logEl.scrollTop =
        debugState.logEl.scrollHeight;
    }
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
      .replace(/_/g, '-')
      .toLowerCase();
  }

  // Some systems report "ta_IN"; the speech engine
  // expects the standard "ta-IN".
  function toBcp47(language) {
    return String(language || '').replace(/_/g, '-');
  }

  function voiceKey(voice) {
    return voice.name + '|' + voice.lang;
  }

  function describeVoice(voice) {
    if (!voice) {
      return 'none (browser default)';
    }

    return (
      voice.name +
      ' (' + voice.lang + ', ' +
      (voice.localService
        ? 'on this device'
        : 'online') +
      ')'
    );
  }

  // Finds the best voice for 'en' or 'ta'.
  function pickVoiceForPrefix(prefix) {
    const matches = voices.filter(function (voice) {
      return (
        normalizeLanguage(voice.lang)
          .split('-')[0] === prefix
      );
    });

    if (!matches.length) {
      return null;
    }

    // A voice chosen in "Voice diagnostics" wins.
    if (prefix === 'ta' && tamilVoiceKey) {
      const chosen = matches.find(function (voice) {
        return voiceKey(voice) === tamilVoiceKey;
      });

      if (chosen) {
        return chosen;
      }
    }

    const preferred = (
      PREFERRED_LANG[prefix] || prefix
    ).toLowerCase();

    const exactMatches = matches.filter(
      function (voice) {
        return (
          normalizeLanguage(voice.lang) === preferred
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

  function pickVoice(langKey) {
    return pickVoiceForPrefix(
      LANGUAGES[langKey].voicePrefix
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
          ' The medicine name is spoken with an English voice so it is pronounced clearly.';
      }

      setVoiceStatus(message, 'ok');

    } else if (!voices.length) {
      setVoiceStatus(
        'Voices are still loading.',
        'warn'
      );

    } else if (langKey === 'ta') {
      setVoiceStatus(
        'No Tamil voice was found on this device, so Tamil reminders will appear on screen only. You may be able to add a Tamil voice in your device\'s language or accessibility settings.',
        'warn'
      );

    } else {
      setVoiceStatus(
        'No matching voice found. Browser default will be used.',
        'warn'
      );
    }

    refreshVoiceDiagnostics();
  }

  function stopSpeech() {
    speechToken++;

    if (speechSupported()) {
      speechSynthesis.cancel();
    }

    activeUtterances = [];
  }

  function segmentsToText(content) {
    if (typeof content === 'string') {
      return content;
    }

    return content.map(function (part) {
      return part.text;
    }).join(' ');
  }

  // Turns a plain string or a list of parts into a clean
  // list of parts.
  function toSegments(content, config) {
    if (typeof content === 'string') {
      return [{
        text: content,
        voiceLang: config.voicePrefix,
        isName: false
      }];
    }

    return content
      .map(function (part) {
        return {
          text: String(part.text),
          voiceLang: part.voiceLang || config.voicePrefix,
          isName: part.isName === true
        };
      })
      .filter(function (part) {
        return part.text.trim() !== '';
      });
  }

  // Speaks a string or a list of parts.
  // Every part is queued together, so parts play one after
  // another and never interrupt each other.
  function speak(content, langKey, options) {
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
    const segments = toSegments(content, config);

    if (!segments.length) {
      return false;
    }

    // Choose a voice for every part.
    const plan = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const voice = pickVoiceForPrefix(segment.voiceLang);

      if (
        !voice &&
        voices.length > 0 &&
        segment.voiceLang !== 'en'
      ) {
        const languageName =
          LANGUAGE_NAMES[segment.voiceLang] ||
          segment.voiceLang;

        setVoiceStatus(
          'This device does not have a ' +
          languageName +
          ' voice installed, so this reminder is shown on screen only.',
          'warn'
        );

        debugLog(
          'NOT SPOKEN: no ' + languageName +
          ' voice found among ' + voices.length +
          ' voices.'
        );

        return false;
      }

      plan.push({ segment: segment, voice: voice });
    }

    debugLog('--- Speech request ---');
    debugLog('Reminder language: ' + config.name + ' (' + langKey + ')');
    debugLog('Complete text: ' + segmentsToText(content));

    plan.forEach(function (item, index) {
      const code = item.voice
        ? toBcp47(item.voice.lang)
        : (PREFERRED_LANG[item.segment.voiceLang] ||
           item.segment.voiceLang);

      debugLog(
        'Part ' + (index + 1) + '/' + plan.length +
        ' [' + item.segment.voiceLang + '] "' +
        item.segment.text + '" -> language code ' + code +
        ', voice ' + describeVoice(item.voice)
      );
    });

    function beginSpeaking(myToken) {
      // Some browsers get stuck in a paused state.
      if (speechSynthesis.paused) {
        speechSynthesis.resume();
      }

      let remaining = plan.length;
      let anyStarted = false;
      let suspicious = false;
      let hadError = false;

      plan.forEach(function (item, index) {
        const label =
          'Part ' + (index + 1) + '/' + plan.length;

        const utterance =
          new SpeechSynthesisUtterance(item.segment.text);

        utterance.lang = item.voice
          ? toBcp47(item.voice.lang)
          : (PREFERRED_LANG[item.segment.voiceLang] ||
             item.segment.voiceLang);

        if (item.voice) {
          utterance.voice = item.voice;
        }

        utterance.rate = SPEECH_RATE;
        utterance.pitch = 1;
        utterance.volume = 1;

        // Keep a reference while speech is active, because
        // some browsers lose utterances that are not
        // referenced anywhere.
        activeUtterances.push(utterance);

        let finished = false;
        let startTime = 0;
        let boundaryCount = 0;

        function finishPart() {
          if (finished) {
            return;
          }

          finished = true;

          activeUtterances = activeUtterances.filter(
            function (u) {
              return u !== utterance;
            }
          );

          remaining--;

          if (remaining === 0) {
            if (suspicious) {
              setVoiceStatus(
                'The Tamil voice finished almost instantly, so it may not be able to read Tamil in this browser. The reminder is shown on screen. Open "Voice diagnostics" to try another Tamil voice.',
                'warn'
              );

              debugLog(
                'RESULT: sequence ended, but a Tamil part finished suspiciously fast (probably no sound).'
              );

            } else if (hadError) {
              debugLog('RESULT: sequence ended with an error.');

            } else {
              debugLog('RESULT: all parts finished normally.');
            }
          }
        }

        utterance.onstart = function () {
          anyStarted = true;
          startTime = Date.now();

          debugLog(label + ' started.');
        };

        utterance.onboundary = function () {
          boundaryCount++;

          if (boundaryCount === 1) {
            debugLog(label + ' reported word progress.');
          }
        };

        utterance.onend = function () {
          const elapsed = startTime
            ? Date.now() - startTime
            : 0;

          debugLog(
            label + ' finished after ' + elapsed + ' ms.'
          );

          if (
            item.segment.voiceLang !== 'en' &&
            item.segment.text.length >= 10 &&
            elapsed < 400
          ) {
            suspicious = true;

            debugLog(
              label + ' WARNING: ended much too quickly for its length.'
            );
          }

          finishPart();
        };

        utterance.onerror = function (event) {
          const reason = event && event.error
            ? event.error
            : 'unknown';

          if (
            reason === 'canceled' ||
            reason === 'interrupted'
          ) {
            debugLog(label + ' was cancelled (' + reason + ').');
            finishPart();
            return;
          }

          hadError = true;

          debugLog(label + ' ERROR: ' + reason);

          if (reason === 'not-allowed') {
            setVoiceStatus(
              'Your browser blocked the voice. Please tap "Turn on voice reminders" or "Hear again".',
              'warn'
            );

          } else {
            setVoiceStatus(
              'Speech error: ' + reason,
              'warn'
            );
          }

          finishPart();
        };

        try {
          speechSynthesis.speak(utterance);

        } catch (error) {
          hadError = true;

          console.error(error);

          debugLog(label + ' could not be started.');

          setVoiceStatus(
            'Could not start speech.',
            'warn'
          );

          finishPart();
        }
      });

      // If nothing starts within a few seconds, tell the user.
      setTimeout(function () {
        if (
          myToken === speechToken &&
          !anyStarted &&
          !speechSynthesis.speaking
        ) {
          debugLog(
            'WARNING: no speech started within 4 seconds.'
          );

          setVoiceStatus(
            'No sound started. Your browser may have blocked the voice, or the volume may be off. Try "Turn on voice reminders" or "Hear again".',
            'warn'
          );
        }
      }, 4000);
    }

    if (options.queue) {
      beginSpeaking(speechToken);

    } else {
      const wasBusy =
        speechSynthesis.speaking ||
        speechSynthesis.pending;

      stopSpeech();

      const myToken = speechToken;

      if (wasBusy) {
        // Starting speech in the same instant as cancel()
        // can make some browsers drop the new speech.
        setTimeout(function () {
          if (myToken === speechToken) {
            beginSpeaking(myToken);
          }
        }, 120);

      } else {
        beginSpeaking(myToken);
      }
    }

    return true;
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
  // VOICE DIAGNOSTICS (small, collapsed box)
  // ===========================

  function refreshVoiceDiagnostics() {
    if (!debugState.voiceListEl || !debugState.voiceSelect) {
      return;
    }

    const tamilVoices = voices.filter(function (voice) {
      return (
        normalizeLanguage(voice.lang)
          .split('-')[0] === 'ta'
      );
    });

    // Rebuild the Tamil voice menu.
    const select = debugState.voiceSelect;
    const previous = tamilVoiceKey;

    select.textContent = '';

    const automatic = document.createElement('option');
    automatic.value = '';
    automatic.textContent = 'Automatic';
    select.appendChild(automatic);

    tamilVoices.forEach(function (voice) {
      const option = document.createElement('option');

      option.value = voiceKey(voice);
      option.textContent = describeVoice(voice);

      select.appendChild(option);
    });

    const stillThere = tamilVoices.some(function (voice) {
      return voiceKey(voice) === previous;
    });

    select.value = stillThere ? previous : '';

    if (!stillThere) {
      tamilVoiceKey = '';
    }

    const englishVoice = pickVoiceForPrefix('en');
    const tamilChosen = pickVoiceForPrefix('ta');

    debugState.voiceListEl.textContent =
      'Voices found: ' + voices.length + '\n' +
      'Tamil voices: ' +
      (tamilVoices.length
        ? tamilVoices.map(describeVoice).join('; ')
        : 'none') + '\n' +
      'Tamil voice in use: ' + describeVoice(tamilChosen) + '\n' +
      'English voice in use: ' + describeVoice(englishVoice);
  }

  function debugSpeakTamilWord() {
    speak(
      [tamilPart('வணக்கம்')],
      'ta'
    );
  }

  function debugSpeakTamilNoName() {
    speak(
      [
        tamilPart('சோதனை நினைவூட்டல்'),
        tamilPart('உங்கள் நினைவூட்டல் இப்படித்தான் ஒலிக்கும்')
      ],
      'ta'
    );
  }

  function debugSpeakNameOnly() {
    const name = els.name.value.trim() || 'Dragon';

    speak(
      [nameSegment(name)],
      els.lang.value
    );
  }

  function buildDebugPanel() {
    const style = document.createElement('style');

    style.textContent =
      '.luxmy-debug{margin-top:1rem;border:1px dashed #c9d3c4;border-radius:.8rem;padding:.6rem .8rem;font-size:.85rem;color:#435247;background:#f7f3e8}' +
      '.luxmy-debug summary{cursor:pointer;font-weight:700}' +
      '.luxmy-debug pre{white-space:pre-wrap;word-break:break-word;max-height:14rem;overflow:auto;background:#fff;border:1px solid #c9d3c4;border-radius:.5rem;padding:.5rem;font-size:.8rem;margin:.5rem 0}' +
      '.luxmy-debug-body .button-row{margin:.5rem 0}' +
      '.luxmy-debug-body p{margin:.4rem 0}' +
      '.luxmy-debug-body select{font-size:.9rem;min-height:2.6rem}';

    document.head.appendChild(style);

    const details = createElement('details', 'luxmy-debug');
    details.id = 'luxmy-debug';

    details.appendChild(
      createElement(
        'summary',
        null,
        'Voice diagnostics (for testing)'
      )
    );

    const body = createElement('div', 'luxmy-debug-body');

    body.appendChild(
      createElement(
        'p',
        null,
        'Script version: ' + SCRIPT_VERSION
      )
    );

    const label = createElement(
      'label',
      null,
      'Tamil voice (advanced)'
    );

    label.setAttribute('for', 'luxmy-tamil-voice');

    body.appendChild(label);

    const select = document.createElement('select');
    select.id = 'luxmy-tamil-voice';

    select.addEventListener('change', function () {
      tamilVoiceKey = select.value;

      debugLog(
        'Tamil voice choice: ' +
        (select.value || 'Automatic')
      );

      updateVoiceStatusForLanguage();
    });

    body.appendChild(select);

    const buttons = createElement('div', 'button-row');

    buttons.appendChild(
      makeButton(
        'Tamil word only',
        'btn-ghost btn-small',
        debugSpeakTamilWord
      )
    );

    buttons.appendChild(
      makeButton(
        'Tamil sentence, no name',
        'btn-ghost btn-small',
        debugSpeakTamilNoName
      )
    );

    buttons.appendChild(
      makeButton(
        'Name only',
        'btn-ghost btn-small',
        debugSpeakNameOnly
      )
    );

    body.appendChild(buttons);

    const voiceList = createElement('pre');
    voiceList.setAttribute('aria-label', 'Voices on this device');
    body.appendChild(voiceList);

    const log = createElement('pre');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-label', 'Speech log');
    body.appendChild(log);

    details.appendChild(body);

    els.form.parentNode.appendChild(details);

    debugState.voiceSelect = select;
    debugState.voiceListEl = voiceList;
    debugState.logEl = log;

    log.textContent = debugState.lines.join('\n');
  }

  // Checks that the Tamil text in this file was not damaged
  // (for example by a text-encoding problem when saving).
  function checkTamilText() {
    const sample = segmentsToText(
      LANGUAGES.ta.reminder('X')
    );

    if (containsTamil(sample)) {
      debugLog('Tamil text check: OK (Tamil letters found).');

    } else {
      debugLog(
        'Tamil text check: PROBLEM. The Tamil letters in script.js look damaged. Make sure the file is saved as UTF-8.'
      );

      console.error(
        'LUXMY: Tamil text appears damaged. Save script.js as UTF-8.'
      );
    }
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
    const langKey = els.lang.value;
    const config = LANGUAGES[langKey];

    // Uses whatever name is in the input field,
    // exactly as typed.
    const typedName = els.name.value.trim();
    const medicine = typedName || config.fallbackName;

    // The test and scheduled reminders use the same
    // speak() function, so a good test is meaningful.
    const message = config.test(medicine);

    if (typedName) {
      showFormMessage(
        'Playing the ' + config.name +
        ' voice test. Details are in "Voice diagnostics" below.',
        'ok'
      );

    } else {
      showFormMessage(
        'Playing the ' + config.name +
        ' voice test with a sample name. Type a medication name above to hear it instead.',
        'ok'
      );
    }

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
    debugLog('LUXMY script loaded: ' + SCRIPT_VERSION);

    buildDebugPanel();
    checkTamilText();

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
