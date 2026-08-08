# --- stage 1: build whisper.cpp from source ---
FROM python:3.12-slim AS whisper-build

RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git /whisper.cpp
WORKDIR /whisper.cpp

# Only build the server target — skips the cli/tests/parakeet examples we
# don't ship, which cuts the build noticeably. -j capped (not left to
# default to nproc) — Render's build machine has more cores than it has RAM
# for unbounded parallel C++ compiles, which OOM-killed the build at the
# default setting. GGML_NATIVE=OFF is the important one: ggml defaults to
# -march=native, baking in whatever CPU extensions the *build* machine has —
# if the runtime instance's CPU doesn't support those, the binary SIGILLs
# (exit code -4) the instant it hits one. Off means a portable baseline ISA.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
    && cmake --build build -j 2 --config Release --target whisper-server

# tiny.en fits comfortably in Render's Starter 512MB plan alongside FastAPI.
# Bump to base.en (bigger, more accurate) if you move to the Standard plan —
# override with: docker build --build-arg WHISPER_MODEL=base.en
ARG WHISPER_MODEL=tiny.en
RUN bash ./models/download-ggml-model.sh ${WHISPER_MODEL} \
    && mv models/ggml-${WHISPER_MODEL}.bin models/ggml-model.bin

# --- stage 2: build llama.cpp from source ---
FROM python:3.12-slim AS llama-build

RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggml-org/llama.cpp.git /llama.cpp
WORKDIR /llama.cpp

# Only the server target — no model baked in here. The model is downloaded
# at container startup from LLAMA_MODEL_URL instead (see app/main.py), since
# it needs to be swappable without rebuilding the image every time. -j and
# GGML_NATIVE=OFF for the same reasons as whisper.cpp above.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
    && cmake --build build -j 2 --config Release --target llama-server

# --- stage 3: runtime ---
FROM python:3.12-slim

# ffmpeg is what whisper-server's --convert flag shells out to, to turn the
# browser's webm/opus recordings into something it can decode.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

# whisper-server's shared libs (libggml*, libwhisper*) live alongside the
# binary in build/bin — copying the whole dir keeps it self-contained.
COPY --from=whisper-build /whisper.cpp/build/bin/ /opt/whisper/bin/
COPY --from=whisper-build /whisper.cpp/models/ggml-model.bin /opt/whisper/models/ggml-model.bin

# Same deal for llama-server's shared libs. No model copied here — see
# LLAMA_MODEL_URL below, it's fetched at startup into /app/models instead
# (the app's own writable dir, unlike /opt in this image).
COPY --from=llama-build /llama.cpp/build/bin/ /opt/llama/bin/

ENV LD_LIBRARY_PATH=/opt/whisper/bin:/opt/llama/bin \
    WHISPER_SERVER_BIN=/opt/whisper/bin/whisper-server \
    WHISPER_MODEL_PATH=/opt/whisper/models/ggml-model.bin \
    WHISPER_SERVER_PORT=8090 \
    LLAMA_SERVER_BIN=/opt/llama/bin/llama-server \
    LLAMA_SERVER_PORT=8091
# LLAMA_MODEL_URL is intentionally not set here — set it in the Render
# dashboard (Settings → Environment) to a direct GGUF download URL. Without
# it, /api/reply just keeps using the canned stub replies.

# Match the port we actually bind to. EXPOSE is informational only.
EXPOSE 10000

# Honor $PORT (render sets it to 10000 by default). sh -c is required so the
# env var actually expands — CMD JSON-array form passes the literal string.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000}"]
