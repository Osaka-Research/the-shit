import asyncio
import logging
import os
import random
import socket
import subprocess
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("voice-relay")

STATIC_DIR = Path(__file__).parent / "static"

# whisper-server is spawned as a subprocess and talked to over localhost —
# keeps the model resident in memory instead of reloading it per request.
WHISPER_SERVER_BIN = os.environ.get("WHISPER_SERVER_BIN", "whisper-server")
WHISPER_MODEL_PATH = os.environ.get("WHISPER_MODEL_PATH", "models/ggml-base.en.bin")
WHISPER_PORT = int(os.environ.get("WHISPER_SERVER_PORT", "8090"))
WHISPER_INFERENCE_URL = f"http://127.0.0.1:{WHISPER_PORT}/inference"
# whisper-server defaults to 4 threads. On a fractional-vCPU host (Render
# Starter = 0.5 vCPU) that's actively counterproductive — more threads than
# actual CPU budget just adds context-switch overhead with no real
# parallelism. 1 is the safe default; bump this if you're on a plan with
# real dedicated cores (Standard = 1 vCPU, Pro = more).
WHISPER_THREADS = os.environ.get("WHISPER_THREADS", "1")

# llama-server is the swappable LLM backend for /api/reply. It only starts if
# a model file actually exists at LLAMA_MODEL_PATH — until you drop one
# there, /api/reply keeps working off the canned stub replies below. Point
# it at *any* chat-capable GGUF (Llama 3.1, Qwen, Mistral, whatever) and
# restart the app — no code changes needed to swap models.
LLAMA_SERVER_BIN = os.environ.get("LLAMA_SERVER_BIN", "llama-server")
LLAMA_MODEL_PATH = os.environ.get("LLAMA_MODEL_PATH", str(Path(__file__).parent.parent / "models" / "llm.gguf"))
# If set (e.g. in the Render dashboard → Environment) and no file exists yet
# at LLAMA_MODEL_PATH, it's downloaded from this URL on startup — a direct
# link to a GGUF file (a Hugging Face .../resolve/main/....gguf URL works).
# Render's disk is ephemeral, so this re-downloads on every fresh deploy;
# for large models that costs real startup time.
LLAMA_MODEL_URL = os.environ.get("LLAMA_MODEL_URL", "")
LLAMA_PORT = int(os.environ.get("LLAMA_SERVER_PORT", "8091"))
LLAMA_CTX_SIZE = os.environ.get("LLAMA_CTX_SIZE", "2048")
LLAMA_CHAT_URL = f"http://127.0.0.1:{LLAMA_PORT}/v1/chat/completions"
LLAMA_SYSTEM_PROMPT = os.environ.get(
    "LLAMA_SYSTEM_PROMPT",
    "You are a helpful voice assistant. Keep replies short — one or two sentences — since they get read aloud.",
)

app = FastAPI(title="voice-relay")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_whisper_proc: subprocess.Popen | None = None
_llama_proc: subprocess.Popen | None = None

# Fallback replies, used whenever no LLM is configured (or a request to it
# fails) — keeps /api/reply always returning something instead of erroring.
CANNED_REPLIES = [
    "That's interesting — tell me more.",
    "I hear you. What happened next?",
    "Not sure I follow, but I'm listening.",
    "Good point. What do you want to do about it?",
    "Let's think about that for a second.",
    "Sounds like a plan.",
    "I don't have a real answer for that yet — I'm just a placeholder.",
    "Can you say that again a different way?",
    "Noted. Anything else?",
    "That checks out.",
]


class ReplyRequest(BaseModel):
    transcript: str
    history: list[dict] | None = None


class ReplyResponse(BaseModel):
    reply: str


class TranscribeResponse(BaseModel):
    transcript: str


def _wait_for_port(port: int, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.5)
    return False


@app.on_event("startup")
def start_whisper_server():
    global _whisper_proc
    logger.info("starting whisper-server: %s -m %s --port %s", WHISPER_SERVER_BIN, WHISPER_MODEL_PATH, WHISPER_PORT)
    # No stdout/stderr redirection — inherit the parent's, so whisper-server's
    # own output (including crash reasons: OOM, missing model, bad lib path)
    # lands in the same log stream as everything else instead of vanishing.
    _whisper_proc = subprocess.Popen(
        [
            WHISPER_SERVER_BIN,
            "-m", WHISPER_MODEL_PATH,
            "--host", "127.0.0.1",
            "--port", str(WHISPER_PORT),
            "-t", WHISPER_THREADS,
            # No --convert: the frontend sends WAV directly (encoded from
            # captured PCM), which whisper's decoder reads natively — skips
            # an ffmpeg transcode subprocess on every single request.
        ],
    )
    if _wait_for_port(WHISPER_PORT, timeout=60):
        logger.info("whisper-server is up on port %s", WHISPER_PORT)
    else:
        exit_code = _whisper_proc.poll()
        if exit_code is not None:
            logger.error("whisper-server exited early with code %s — see its output above for why", exit_code)
        else:
            logger.error("whisper-server did not come up within timeout (still running, just slow to bind)")


def _llama_source_marker_path() -> Path:
    return Path(str(LLAMA_MODEL_PATH) + ".source_url")


def _invalidate_stale_llama_model():
    # On a persistent disk, a model downloaded from a previous LLAMA_MODEL_URL
    # sticks around across deploys/restarts — the "only download if missing"
    # check would otherwise happily keep serving last week's model forever
    # even after you point the env var somewhere else. Compare against a
    # marker file recording which URL produced the cached file, and clear
    # it out if the configured URL has changed since.
    dest = Path(LLAMA_MODEL_PATH)
    marker = _llama_source_marker_path()
    if not dest.exists():
        return
    previous_url = marker.read_text().strip() if marker.exists() else None
    if LLAMA_MODEL_URL and previous_url != LLAMA_MODEL_URL:
        logger.info(
            "LLAMA_MODEL_URL changed (was %s) — clearing cached model at %s so it re-downloads",
            previous_url or "unknown",
            dest,
        )
        dest.unlink()
        marker.unlink(missing_ok=True)


async def _download_llama_model() -> bool:
    dest = Path(LLAMA_MODEL_PATH)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    logger.info("downloading LLM model from %s", LLAMA_MODEL_URL)
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=None) as client:
            async with client.stream("GET", LLAMA_MODEL_URL) as resp:
                resp.raise_for_status()
                with open(tmp, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=1024 * 1024):
                        f.write(chunk)
        tmp.rename(dest)
        _llama_source_marker_path().write_text(LLAMA_MODEL_URL)
        logger.info("LLM model download complete: %s", dest)
        return True
    except (httpx.HTTPError, OSError) as err:
        logger.error("LLM model download failed: %s", err)
        tmp.unlink(missing_ok=True)
        return False


async def _prepare_and_start_llama():
    # Runs as a background task (not awaited by the startup event) so a
    # multi-minute model download can't hold up /api/health or the rest of
    # the app from becoming ready — Render's deploy health check would time
    # out waiting on it otherwise.
    global _llama_proc

    _invalidate_stale_llama_model()

    if not Path(LLAMA_MODEL_PATH).exists():
        if not LLAMA_MODEL_URL:
            logger.warning(
                "no LLM model at %s and no LLAMA_MODEL_URL set — /api/reply will use canned stub replies until one is added",
                LLAMA_MODEL_PATH,
            )
            return
        if not await _download_llama_model():
            logger.warning("proceeding without an LLM — /api/reply will use canned stub replies")
            return

    logger.info("starting llama-server: %s -m %s --port %s", LLAMA_SERVER_BIN, LLAMA_MODEL_PATH, LLAMA_PORT)
    try:
        # No stdout/stderr redirection — see the comment on whisper-server's
        # Popen call for why: we want its own crash output in the logs.
        _llama_proc = subprocess.Popen(
            [
                LLAMA_SERVER_BIN,
                "-m", LLAMA_MODEL_PATH,
                "--host", "127.0.0.1",
                "--port", str(LLAMA_PORT),
                "-c", str(LLAMA_CTX_SIZE),
            ],
        )
    except FileNotFoundError:
        logger.error("llama-server binary not found (LLAMA_SERVER_BIN=%s)", LLAMA_SERVER_BIN)
        return

    if await asyncio.to_thread(_wait_for_port, LLAMA_PORT, 120):
        logger.info("llama-server is up on port %s", LLAMA_PORT)
    else:
        exit_code = _llama_proc.poll()
        if exit_code is not None:
            logger.error("llama-server exited early with code %s — see its output above for why", exit_code)
        else:
            logger.error("llama-server did not come up within timeout (still running, just slow to bind)")
        _llama_proc = None


@app.on_event("startup")
async def start_llama_server():
    asyncio.create_task(_prepare_and_start_llama())


@app.on_event("shutdown")
def stop_background_servers():
    if _whisper_proc:
        _whisper_proc.terminate()
    if _llama_proc:
        _llama_proc.terminate()


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    if not audio_bytes:
        return TranscribeResponse(transcript="")
    try:
        # Generous timeout — on a fractional-vCPU host, transcription can
        # legitimately take longer than you'd expect for a few seconds of
        # audio. A too-tight timeout here just turns "slow" into "broken":
        # it kills the request mid-inference, whisper-server logs a wasted
        # "client disconnected" instead of finishing, and the user gets a
        # hard error instead of just waiting a bit longer.
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                WHISPER_INFERENCE_URL,
                files={"file": (file.filename or "utterance.webm", audio_bytes, file.content_type or "application/octet-stream")},
                data={"response_format": "json"},
            )
        resp.raise_for_status()
    except httpx.HTTPError as err:
        logger.error("whisper-server request failed: %s", err)
        raise HTTPException(status_code=503, detail="transcription service unavailable") from err

    text = resp.json().get("text", "").strip()
    logger.info("transcript: %s", text)
    return TranscribeResponse(transcript=text)


@app.post("/api/reply", response_model=ReplyResponse)
async def reply(req: ReplyRequest):
    transcript = req.transcript.strip()
    logger.info("reply for transcript: %s", transcript)
    if not transcript:
        return ReplyResponse(reply="I didn't catch that.")

    if _llama_proc is not None:
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    LLAMA_CHAT_URL,
                    json={
                        "messages": [
                            {"role": "system", "content": LLAMA_SYSTEM_PROMPT},
                            {"role": "user", "content": transcript},
                        ],
                        "max_tokens": 200,
                        "temperature": 0.7,
                    },
                )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            if content:
                return ReplyResponse(reply=content)
        except (httpx.HTTPError, KeyError, IndexError) as err:
            logger.error("llama-server request failed, falling back to canned reply: %s", err)

    return ReplyResponse(reply=random.choice(CANNED_REPLIES))
