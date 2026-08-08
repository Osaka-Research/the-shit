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
# whisper-server defaults to 4 threads. Now that it's the only heavy process
# on the box (the local LLM fallback is gone — see below), it has Standard's
# full 1 dedicated vCPU to itself instead of sharing/competing. 2 threads is
# a reasonable middle ground for a single real core; drop to 1 if you move
# to a fractional-vCPU plan (that's what caused the original slowdown).
WHISPER_THREADS = os.environ.get("WHISPER_THREADS", "2")

# LLM replies: Groq first (fast, hosted, effectively free at this volume —
# self-hosting a 3B model on Render's CPU couldn't keep up, 67 tokens took
# ~70s). No local LLM fallback anymore: it added a 10GB disk, a multi-GB
# model download on every deploy, and CPU/RAM contention with whisper for a
# path that was never actually fast enough to use. Canned replies are the
# only fallback now if Groq isn't configured or a request to it fails.
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_SYSTEM_PROMPT = os.environ.get(
    "GROQ_SYSTEM_PROMPT",
    "You are a helpful voice assistant. Keep replies short — one or two sentences — since they get read aloud.",
)

app = FastAPI(title="voice-relay")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_whisper_proc: subprocess.Popen | None = None

# Fallback replies, used whenever Groq isn't configured (or a request to it
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


@app.on_event("shutdown")
def stop_background_servers():
    if _whisper_proc:
        _whisper_proc.terminate()


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
        # Generous timeout — transcription can legitimately take longer than
        # you'd expect for a few seconds of audio. A too-tight timeout here
        # just turns "slow" into "broken": it kills the request mid-inference
        # instead of just waiting a bit longer.
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

    if GROQ_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    GROQ_CHAT_URL,
                    headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                    json={
                        "model": GROQ_MODEL,
                        "messages": [
                            {"role": "system", "content": GROQ_SYSTEM_PROMPT},
                            {"role": "user", "content": transcript},
                        ],
                        "max_tokens": 80,
                        "temperature": 0.7,
                    },
                )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            if content:
                return ReplyResponse(reply=content)
        except (httpx.HTTPError, KeyError, IndexError) as err:
            logger.error("Groq request failed, falling back to canned reply: %s", err)

    return ReplyResponse(reply=random.choice(CANNED_REPLIES))
