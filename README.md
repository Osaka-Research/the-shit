# voice-relay

Hands-free voice UI: tap once, talk, get a reply spoken back, straight back
to listening — no holding buttons, no repeated taps.

STT and TTS split across two different places on purpose:

- **Speech-to-text runs server-side**, via a bundled [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
  (`whisper-server`) — the browser just records audio (`MediaRecorder`) and a
  simple client-side silence detector decides when an utterance is done. This
  avoids the browser's built-in `SpeechRecognition`, which triggers an
  Android system beep on every start/stop and barely works outside Chrome
  (Firefox: unsupported, iOS/macOS Safari: unreliable auto-restart).
- **Text-to-speech still runs in the browser** (`speechSynthesis`) — that one
  doesn't have those problems and is free, so no reason to move it server-side.
  Off by default (toggle in the UI) since spoken replies got annoying fast.

Right now `/api/reply` returns a random canned sentence — it's a stub so the
full loop (mic → transcribe → server → voice) can be tested before wiring up
a real LLM.

## Deploy

1. Push this repo to github.
2. In render dashboard → **New +** → **Blueprint** → point at this repo.
   Render reads `render.yaml` and provisions the service.
3. First deploy takes longer than a typical Python service — the Docker
   build compiles whisper.cpp from source. Expect several minutes, not the
   usual ~2.
4. Open the URL shown, allow microphone access, tap **Start Conversation**.

Or click the deploy button:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Osaka-Research/the-shit)

No environment variables are required for the stub. Works in any modern
browser (`getUserMedia` + `MediaRecorder` are broadly supported, unlike the
old `SpeechRecognition`-based approach) — Chrome/Edge/Firefox/Safari should
all work, desktop and mobile.

## Endpoints

| Method | Path             | Purpose                              |
|--------|------------------|---------------------------------------|
| GET    | `/`              | Web UI                               |
| GET    | `/api/health`    | Render health check (200 OK)         |
| POST   | `/api/transcribe`| multipart audio file → `{transcript}`|
| POST   | `/api/reply`     | `{transcript}` → `{reply}`           |

## Whisper model

Default is `tiny.en` — fits comfortably in Render's Starter plan (512MB)
alongside FastAPI. For better accuracy, rebuild with:

```bash
docker build --build-arg WHISPER_MODEL=base.en .
```

...and bump `render.yaml`'s `plan` to `standard` (2GB) — `base.en` alone
uses ~150–250MB resident, too tight on Starter with everything else running.

## Swapping in a real LLM

Everything funnels through `reply()` in `app/main.py`. Replace the
`random.choice(CANNED_REPLIES)` line with a real API call (Anthropic, OpenAI,
your own harvest-agent queue, whatever) — the request/response shape the
frontend expects doesn't need to change. If the call needs a key, set it as
an env var in the render dashboard (Settings → Environment), never in code.

## Local dev

Needs a local whisper.cpp build (see the [whisper.cpp README](https://github.com/ggerganov/whisper.cpp)
for build instructions — `cmake -B build && cmake --build build -j --target whisper-server`,
then `models/download-ggml-model.sh tiny.en`) and `ffmpeg` on PATH.

```bash
pip install -r requirements.txt
WHISPER_SERVER_BIN=/path/to/whisper.cpp/build/bin/whisper-server \
WHISPER_MODEL_PATH=/path/to/whisper.cpp/models/ggml-tiny.en.bin \
LD_LIBRARY_PATH=/path/to/whisper.cpp/build/bin \
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then open http://localhost:8000. `getUserMedia` requires HTTPS except on
`localhost` itself — test locally, or deploy to Render (which is HTTPS by
default) to test on a phone.
