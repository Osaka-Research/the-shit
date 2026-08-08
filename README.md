# voice-relay

Hands-free voice UI: tap once, talk, get a reply spoken back, straight back
to listening — no holding buttons, no repeated taps.

- **Speech-to-text runs server-side**, via a bundled [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
  (`whisper-server`) — the browser records raw PCM and encodes it to WAV
  client-side, whisper decodes that natively (no ffmpeg transcode needed). A
  simple client-side silence detector decides when an utterance is done.
  This avoids the browser's built-in `SpeechRecognition`, which triggers an
  Android system beep on every start/stop and barely works outside Chrome
  (Firefox: unsupported, iOS/macOS Safari: unreliable auto-restart).
- **Text-to-speech runs in the browser** (`speechSynthesis`) — free, no
  server round-trip. Off by default (toggle in the UI) since spoken replies
  got annoying fast.
- **LLM replies go through [Groq](https://console.groq.com)** — self-hosting
  a model on Render's CPU couldn't keep up (a 3B model took ~70s for a short
  reply), Groq's LPU hardware answers the same kind of request in well under
  a second, for close to free at this usage volume. Falls back to a random
  canned sentence if `GROQ_API_KEY` isn't set or a request to it fails.

## Deploy

1. Push this repo to github.
2. In render dashboard → **New +** → **Blueprint** → point at this repo.
   Render reads `render.yaml` and provisions the service.
3. First deploy takes longer than a typical Python service — the Docker
   build compiles whisper.cpp from source. Expect several minutes.
4. Render dashboard → your service → **Environment** → add:
   ```
   GROQ_API_KEY = gsk_...
   ```
   Get a key at [console.groq.com](https://console.groq.com). Without this,
   `/api/reply` just returns canned sentences instead of erroring.
5. **Important**: after adding/changing an env var, a plain **restart**
   doesn't reliably pick it up — trigger an actual **Manual Deploy** from
   the dashboard (or push any commit) to be sure the new value is loaded.
6. Open the URL shown, allow microphone access, tap **Start Conversation**.

Or click the deploy button:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Osaka-Research/the-shit)

Works in any modern browser (`getUserMedia` + `MediaRecorder` are broadly
supported) — Chrome/Edge/Firefox/Safari should all work, desktop and mobile.

## Endpoints

| Method | Path             | Purpose                              |
|--------|------------------|---------------------------------------|
| GET    | `/`              | Web UI                               |
| GET    | `/api/health`    | Render health check (200 OK)         |
| POST   | `/api/transcribe`| multipart audio file → `{transcript}`|
| POST   | `/api/reply`     | `{transcript}` → `{reply}`           |

## Whisper model

Default is `base.en`, built into the Docker image at build time (no
download-on-boot, no persistent disk needed). Override with:

```bash
docker build --build-arg WHISPER_MODEL=tiny.en .
```

`WHISPER_THREADS` (env var, default `2`) controls whisper-server's thread
count — keep this low relative to your Render plan's actual vCPU count.
More threads than real CPU cores causes context-switch overhead, not
speedup; this is what caused severe slowdowns on Starter's fractional
0.5 vCPU. Standard gives a real dedicated vCPU.

## LLM replies (Groq)

`GROQ_API_KEY` is the only thing that turns real replies on — set it in the
Render dashboard's Environment tab (see Deploy step 4 above). Other env
vars, all optional:

| Var                  | Default            | Notes                                |
|----------------------|--------------------|----------------------------------------|
| `GROQ_MODEL`         | `openai/gpt-oss-20b` | Any chat model in Groq's catalog    |
| `GROQ_SYSTEM_PROMPT` | (voice-assistant prompt) | Personality/behavior override  |

Groq doesn't support arbitrary/custom models — only what's in their hosted
catalog (check [console.groq.com/docs/models](https://console.groq.com/docs/models)).

## Local dev

Needs a local whisper.cpp build (see the [whisper.cpp README](https://github.com/ggerganov/whisper.cpp)
for build instructions — `cmake -B build && cmake --build build -j --target whisper-server`,
then `models/download-ggml-model.sh base.en`).

```bash
pip install -r requirements.txt
WHISPER_SERVER_BIN=/path/to/whisper.cpp/build/bin/whisper-server \
WHISPER_MODEL_PATH=/path/to/whisper.cpp/models/ggml-base.en.bin \
LD_LIBRARY_PATH=/path/to/whisper.cpp/build/bin \
GROQ_API_KEY=gsk_... \
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then open http://localhost:8000. `getUserMedia` requires HTTPS except on
`localhost` itself — test locally, or deploy to Render (which is HTTPS by
default) to test on a phone.
