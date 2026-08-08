const talkBtn = document.getElementById("talk-btn");
const talkBtnLabel = document.getElementById("talk-btn-label");
const statusEl = document.getElementById("status");
const captionEl = document.getElementById("caption");
const logEl = document.getElementById("log");
const voiceToggleBtn = document.getElementById("voice-toggle-btn");
const historyToggle = document.getElementById("history-toggle");
const panelEl = document.getElementById("panel");

// Tuning for the client-side silence detector (RMS of the time-domain
// signal, 0..1). These are deliberately conservative defaults — adjust if
// it cuts you off too early/late.
const SPEECH_THRESHOLD = 0.02;
const SILENCE_HOLD_MS = 900; // how long silence must persist to end an utterance
const NO_SPEECH_TIMEOUT_MS = 7000; // give up and re-arm if nothing was ever heard
const MAX_UTTERANCE_MS = 20000; // hard cap so a stuck mic can't record forever
const VOLUME_POLL_MS = 100;
const CAPTURE_BUFFER_SIZE = 4096;

// sessionActive: whether the user wants the hands-free loop running at all.
// state: what the loop is doing right now, mirrored onto the button's
// data-state attribute so the CSS orb can react (breathing/spinning/pulsing).
// The mic is only ever recording during "listening" — it's paused while
// thinking/speaking so it doesn't pick up the reply being read out loud.
let sessionActive = false;
let state = "idle"; // idle | listening | thinking | speaking
// Off by default — spoken replies were the original complaint. Toggle to
// opt back in.
let voiceEnabled = false;

let mediaStream = null;
let audioCtx = null;
let analyser = null;
let volumeData = null;
let volumeTimer = null;

// Raw PCM capture — sent to the server as WAV. Whisper's decoder reads WAV
// natively, so this skips a per-request ffmpeg transcode that MediaRecorder's
// webm/opus output would otherwise require server-side.
let captureNode = null;
let silentSink = null; // ScriptProcessorNode must connect to a destination
// to reliably fire in all browsers — routed through zero gain so the mic
// doesn't get echoed back out the speaker.
let pcmChunks = [];
let hasSpoken = false;
let silenceStartedAt = null;
let utteranceStartedAt = 0;
let utteranceActive = false;

function setOrbState(next) {
  state = next;
  talkBtn.dataset.state = next;
}

function setLabel(text) {
  talkBtn.setAttribute("aria-label", text);
  talkBtnLabel.textContent = text;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function addEntry(role, text) {
  const div = document.createElement("div");
  div.className = "entry " + role;
  div.textContent = (role === "user" ? "You: " : "Relay: ") + text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  setCaption(role, text);
}

function setCaption(role, text) {
  captionEl.textContent = text;
  captionEl.className = "caption caption-" + role;
  // retrigger the entrance animation even if the class didn't change
  void captionEl.offsetWidth;
  captionEl.classList.add("caption-in");
}

voiceToggleBtn.addEventListener("click", () => {
  voiceEnabled = !voiceEnabled;
  voiceToggleBtn.setAttribute("aria-pressed", String(voiceEnabled));
  voiceToggleBtn.setAttribute("aria-label", "Speak replies aloud: " + (voiceEnabled ? "on" : "off"));
  if (!voiceEnabled) speechSynthesis.cancel();
});

historyToggle.addEventListener("click", () => {
  const opening = panelEl.hasAttribute("hidden");
  if (opening) {
    panelEl.removeAttribute("hidden");
    historyToggle.textContent = "Hide history";
    historyToggle.setAttribute("aria-expanded", "true");
  } else {
    panelEl.setAttribute("hidden", "");
    historyToggle.textContent = "Show history";
    historyToggle.setAttribute("aria-expanded", "false");
  }
});

// ── WAV encoding ──

function concatFloat32(chunks) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const result = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([view], { type: "audio/wav" });
}

// ── conversation reply (text → server reply → optional speech) ──

async function sendTranscript(transcript) {
  try {
    const res = await fetch("/api/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
    if (!res.ok) throw new Error("server responded " + res.status);
    const data = await res.json();
    addEntry("relay", data.reply);
    if (voiceEnabled) {
      speak(data.reply);
    } else {
      setOrbState("idle");
      if (sessionActive) {
        beginListening();
      } else {
        setStatus("Tap the orb to talk");
      }
    }
  } catch (err) {
    setStatus("Error reaching server");
    console.error(err);
    setOrbState("idle");
    if (sessionActive) beginListening();
  }
}

function speak(text) {
  setOrbState("speaking");
  setStatus("Speaking...");
  const utter = new SpeechSynthesisUtterance(text);
  utter.onend = () => {
    setOrbState("idle");
    if (sessionActive) {
      beginListening();
    } else {
      setStatus("Tap the orb to talk");
    }
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
}

function handleFinalTranscript(transcript) {
  if (!transcript) return;
  addEntry("user", transcript);
  setOrbState("thinking");
  setStatus("Thinking...");
  sendTranscript(transcript);
}

// ── recording one utterance, server-side transcription ──

const STATUS_FLASH_MS = 1500;

// beginListening() immediately overwrites the status line with "Listening...",
// so a message set right before it would never actually be seen — this
// delays the restart just long enough for the message to be readable.
function beginListeningAfterFlash(delay = STATUS_FLASH_MS) {
  setTimeout(() => {
    if (sessionActive) beginListening();
  }, delay);
}

async function finalizeUtterance() {
  const samples = concatFloat32(pcmChunks);
  pcmChunks = [];
  const spoke = hasSpoken;

  if (!sessionActive) return; // stopSession() already tore everything down

  // ~0.3s of audio at typical mic sample rates — anything shorter than that
  // is noise, not speech.
  if (!spoke || samples.length < audioCtx.sampleRate * 0.3) {
    // Nothing crossed the speech-volume threshold for the whole utterance
    // window — either genuine silence, or (if this keeps happening every
    // time) the mic/analyser isn't picking up audio at all. Flash a status
    // so that's visible instead of just silently re-looping forever.
    setStatus("Didn't hear anything — still listening");
    beginListeningAfterFlash();
    return;
  }

  const blob = encodeWav(samples, audioCtx.sampleRate);

  setOrbState("thinking");
  setStatus("Transcribing...");
  try {
    const form = new FormData();
    form.append("file", blob, "utterance.wav");
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    if (!res.ok) throw new Error("transcribe failed " + res.status);
    const data = await res.json();
    const transcript = (data.transcript || "").trim();
    if (!transcript) {
      setStatus("Heard you, but transcript came back empty — still listening");
      beginListeningAfterFlash();
      return;
    }
    handleFinalTranscript(transcript);
  } catch (err) {
    console.error(err);
    setStatus("Transcription error — is whisper-server running?");
    beginListeningAfterFlash();
  }
}

function stopUtteranceRecording() {
  utteranceActive = false;
  finalizeUtterance();
}

function startUtteranceRecording() {
  pcmChunks = [];
  hasSpoken = false;
  silenceStartedAt = null;
  utteranceStartedAt = Date.now();
  utteranceActive = true;
}

function volumeTick() {
  if (state !== "listening" || !analyser) return;

  analyser.getByteTimeDomainData(volumeData);
  let sumSquares = 0;
  for (let i = 0; i < volumeData.length; i++) {
    const v = (volumeData[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / volumeData.length);
  const now = Date.now();

  if (rms > SPEECH_THRESHOLD) {
    hasSpoken = true;
    silenceStartedAt = null;
  } else if (hasSpoken) {
    if (silenceStartedAt === null) {
      silenceStartedAt = now;
    } else if (now - silenceStartedAt > SILENCE_HOLD_MS) {
      stopUtteranceRecording();
      return;
    }
  }

  if (!hasSpoken && now - utteranceStartedAt > NO_SPEECH_TIMEOUT_MS) {
    stopUtteranceRecording();
    return;
  }

  if (now - utteranceStartedAt > MAX_UTTERANCE_MS) {
    stopUtteranceRecording();
  }
}

function beginListening() {
  if (!sessionActive) return;
  setOrbState("listening");
  setStatus("Listening...");
  startUtteranceRecording();
}

// ── session lifecycle ──

async function startSession() {
  if (sessionActive) return;
  setStatus("Requesting microphone...");
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error(err);
    setStatus("Microphone permission denied.");
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") {
    // Some browsers create AudioContext in a suspended state even inside a
    // click handler — without this, the analyser silently reads all zeros
    // forever, the volume loop never detects speech, and every utterance
    // just times out and restarts, looking like it's "stuck listening".
    await audioCtx.resume();
  }
  const source = audioCtx.createMediaStreamSource(mediaStream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  volumeData = new Uint8Array(analyser.fftSize);
  source.connect(analyser);

  // Raw PCM capture for the WAV we send to the server. ScriptProcessorNode
  // is deprecated in favor of AudioWorklet, but it's simpler (no separate
  // module file to load) and still works everywhere — fine for this.
  captureNode = audioCtx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
  captureNode.onaudioprocess = (e) => {
    if (!utteranceActive) return;
    pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  silentSink = audioCtx.createGain();
  silentSink.gain.value = 0;
  source.connect(captureNode);
  captureNode.connect(silentSink);
  silentSink.connect(audioCtx.destination);

  volumeTimer = setInterval(volumeTick, VOLUME_POLL_MS);

  sessionActive = true;
  setLabel("Stop Conversation");
  beginListening();
}

function stopSession() {
  sessionActive = false;
  utteranceActive = false;
  setOrbState("idle");
  setLabel("Start Conversation");
  setStatus("Tap the orb to talk");

  if (volumeTimer) {
    clearInterval(volumeTimer);
    volumeTimer = null;
  }
  if (captureNode) {
    captureNode.onaudioprocess = null;
    captureNode.disconnect();
    captureNode = null;
  }
  if (silentSink) {
    silentSink.disconnect();
    silentSink = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  speechSynthesis.cancel();
}

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
  setStatus("This browser doesn't support microphone recording.");
  talkBtn.disabled = true;
} else {
  talkBtn.addEventListener("click", () => {
    if (sessionActive) {
      stopSession();
    } else {
      startSession();
    }
  });
}
