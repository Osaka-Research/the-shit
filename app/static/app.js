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
let mimeType = "";

let currentRecorder = null;
let currentChunks = [];
let hasSpoken = false;
let silenceStartedAt = null;
let utteranceStartedAt = 0;

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

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const candidate of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return ""; // let the browser pick whatever it supports
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

async function finalizeUtterance() {
  const blob = new Blob(currentChunks, { type: mimeType || "audio/webm" });
  currentChunks = [];
  const spoke = hasSpoken;

  if (!sessionActive) return; // stopSession() already tore everything down

  if (!spoke || blob.size < 800) {
    // nothing meaningful captured — go straight back to listening
    beginListening();
    return;
  }

  setOrbState("thinking");
  setStatus("Transcribing...");
  try {
    const form = new FormData();
    form.append("file", blob, "utterance.webm");
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    if (!res.ok) throw new Error("transcribe failed " + res.status);
    const data = await res.json();
    const transcript = (data.transcript || "").trim();
    if (!transcript) {
      if (sessionActive) beginListening();
      return;
    }
    handleFinalTranscript(transcript);
  } catch (err) {
    console.error(err);
    setStatus("Transcription error");
    if (sessionActive) beginListening();
  }
}

function stopUtteranceRecording() {
  if (currentRecorder && currentRecorder.state !== "inactive") {
    currentRecorder.stop();
  }
}

function startUtteranceRecording() {
  currentChunks = [];
  hasSpoken = false;
  silenceStartedAt = null;
  utteranceStartedAt = Date.now();

  currentRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  currentRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) currentChunks.push(e.data);
  };
  currentRecorder.onstop = finalizeUtterance;
  currentRecorder.start();
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

  mimeType = pickMimeType();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  volumeData = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
  volumeTimer = setInterval(volumeTick, VOLUME_POLL_MS);

  sessionActive = true;
  setLabel("Stop Conversation");
  beginListening();
}

function stopSession() {
  sessionActive = false;
  setOrbState("idle");
  setLabel("Start Conversation");
  setStatus("Tap the orb to talk");

  if (volumeTimer) {
    clearInterval(volumeTimer);
    volumeTimer = null;
  }
  if (currentRecorder && currentRecorder.state !== "inactive") {
    currentRecorder.onstop = null; // don't finalize/send after an explicit stop
    currentRecorder.stop();
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

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
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
