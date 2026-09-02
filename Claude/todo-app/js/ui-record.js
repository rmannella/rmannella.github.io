// The Record screen: press-and-hold the circle, speak, release. The Web
// Speech API is the only capture path, and it is absent on some browsers
// (notably iOS Safari), so the typed fallback is always reachable and becomes
// the default when speech is unavailable.

const RecordUI = (() => {
  const SUCCESS_FLASH_MS = 550;

  function speechRecognitionClass() {
    return window.SpeechRecognition || window.webkitSpeechRecognition;
  }

  function setupTypedFallback() {
    const link = $('record-type-link');
    const form = $('record-type-form');
    const input = $('record-type-input');

    link.addEventListener('click', () => {
      setHidden(form, false);
      setHidden(link, true);
      input.focus();
    });

    form.addEventListener('submit', e => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      TasksUI.addTaskFromText(value);
      input.value = '';
    });
  }

  function setup() {
    setupTypedFallback();

    const screen = $('record-screen');
    const btn = $('record-btn');
    const prompt = $('record-prompt');
    const transcriptEl = $('record-transcript');
    const idlePrompt = 'Hold to add a task';

    const SpeechRecognition = speechRecognitionClass();
    if (!SpeechRecognition) {
      screen.classList.add('no-voice');
      prompt.textContent = "Voice isn't supported in this browser — type your task below.";
      setHidden($('record-type-form'), false);
      setHidden($('record-type-link'), true);
      return;
    }

    const recognizer = new SpeechRecognition();
    recognizer.lang = 'en-US';
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 1;
    // Keeps the recognizer from cutting out at the first natural pause, so a
    // longer sentence survives to the end of the hold.
    recognizer.continuous = true;

    let recording = false;
    let finalTranscript = '';

    function reset() {
      recording = false;
      screen.classList.remove('recording');
      prompt.textContent = idlePrompt;
      transcriptEl.textContent = '';
    }

    function start() {
      if (recording) return;
      finalTranscript = '';
      transcriptEl.textContent = '';
      try {
        recognizer.start();
      } catch (err) {
        return; // already running; the end handler will tidy up
      }
      recording = true;
      screen.classList.add('recording');
      prompt.textContent = 'Listening…';
    }

    function stop() {
      if (!recording) return;
      recording = false;
      recognizer.stop();
    }

    // pointerdown/up rather than click: this is a walkie-talkie button, and
    // preventDefault keeps the press from focusing or text-selecting.
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      start();
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(evt => btn.addEventListener(evt, stop));

    recognizer.addEventListener('result', e => {
      let interim = '';
      let final = '';
      for (let i = 0; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += chunk;
        else interim += chunk;
      }
      if (final) finalTranscript = final;
      transcriptEl.textContent = finalTranscript || interim;
    });

    recognizer.addEventListener('end', () => {
      const captured = finalTranscript.trim();
      finalTranscript = '';
      reset();
      if (!captured) return;
      TasksUI.addTaskFromText(captured);
      screen.classList.add('success');
      setTimeout(() => screen.classList.remove('success'), SUCCESS_FLASH_MS);
    });

    recognizer.addEventListener('error', e => {
      reset();
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        UI.showToast('Microphone access is blocked — enable it in your browser settings.', { duration: 5000 });
      }
    });
  }

  return { setup };
})();
