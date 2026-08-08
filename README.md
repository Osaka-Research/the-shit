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

- **The LLM is swappable** — `/api/reply` calls a bundled `llama-server`
  (also [llama.cpp](https://github.com/ggml-org/llama.cpp)) if a model is
  configured, and falls back to a random canned sentence if not. Swapping
  models never needs a code change or rebuild — see "Setting the LLM model"
  below.

## Deploy

1. Push this repo to github.
2. In render dashboard → **New +** → **Blueprint** → point at this repo.
   Render reads `render.yaml` and provisions the service.
3. First deploy takes a lot longer than a typical Python service — the
   Docker build compiles both whisper.cpp and llama.cpp from source. Expect
   10+ minutes, not the usual ~2.
4. Open the URL shown, allow microphone access, tap **Start Conversation**.
5. (Optional) Set an LLM model — see "Setting the LLM model" below. Without
   this step `/api/reply` just returns canned sentences.

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

## Setting the LLM model

1. Find a chat-capable GGUF file and copy its **direct download URL** — a
   Hugging Face `.../resolve/main/....gguf` link works. Any instruct model
   works; pick a quant that fits your Render plan's RAM (see sizing below).
2. Render dashboard → your service → **Settings → Environment** → add:
   ```
   LLAMA_MODEL_URL = https://huggingface.co/<repo>/resolve/main/<file>.gguf
   ```
3. Save, which triggers a redeploy. On boot the app downloads that file into
   the container and starts `llama-server` against it — check the **Logs**
   tab for `downloading LLM model from ...` then `llama-server is up on
   port 8091`. Until that finishes, `/api/reply` keeps using canned replies,
   it doesn't error.

**Sizing against RAM** (`plan` in `render.yaml`): Starter is 512MB, Standard
is 2GB. `whisper-server` (tiny.en) already uses ~100–150MB, so budget the
rest for the LLM — a Q4_K_M quant needs roughly its file size + 20% at
runtime for context. A 3B-class model (~2GB file) needs Standard or higher;
don't expect an 8B model to fit even on Standard once whisper and FastAPI
are accounted for — go Pro (4GB+) or drop to a smaller/lower quant instead.

**Every fresh deploy re-downloads the model** — Render's disk is ephemeral,
so a restart or redeploy means the multi-GB download happens again on next
boot. For a large model that's real startup latency each time. If that
becomes a problem, the fix is a Render persistent [Disk](https://render.com/docs/disks)
mounted at e.g. `/data`, with `LLAMA_MODEL_PATH=/data/llm.gguf` — then the
download only happens once, ever.

To change models later, just update `LLAMA_MODEL_URL` to a different file
and delete the old one via a shell on the instance (or just let a Disk fill
up — worth deleting manually if you're switching models often).

Local overrides for all of this: `LLAMA_SERVER_BIN`, `LLAMA_MODEL_PATH`,
`LLAMA_MODEL_URL`, `LLAMA_SERVER_PORT`, `LLAMA_CTX_SIZE`, `LLAMA_SYSTEM_PROMPT`.

## Local dev

Needs a local whisper.cpp build (see the [whisper.cpp README](https://github.com/ggerganov/whisper.cpp)
for build instructions — `cmake -B build && cmake --build build -j --target whisper-server`,
then `models/download-ggml-model.sh tiny.en`) and `ffmpeg` on PATH.

For the LLM, either drop any chat GGUF at `models/llm.gguf` (default path,
no env var needed), or point `LLAMA_MODEL_PATH` at one elsewhere. No model
present just means canned replies, same as the deployed version. A local
[llama.cpp build](https://github.com/ggml-org/llama.cpp) (`--target
llama-server`) is required either way — its shared libs need to be on
`LD_LIBRARY_PATH` too.

```bash
pip install -r requirements.txt
WHISPER_SERVER_BIN=/path/to/whisper.cpp/build/bin/whisper-server \
WHISPER_MODEL_PATH=/path/to/whisper.cpp/models/ggml-tiny.en.bin \
LLAMA_SERVER_BIN=/path/to/llama.cpp/build/bin/llama-server \
LLAMA_MODEL_PATH=/path/to/your-model.gguf \
LD_LIBRARY_PATH=/path/to/whisper.cpp/build/bin:/path/to/llama.cpp/build/bin \
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then open http://localhost:8000. `getUserMedia` requires HTTPS except on
`localhost` itself — test locally, or deploy to Render (which is HTTPS by
default) to test on a phone.
