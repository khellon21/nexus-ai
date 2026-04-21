"""
Nexus AI — Local Voice Microservice
------------------------------------
A single FastAPI process that serves BOTH:
  • Faster-Whisper STT (Speech-to-Text)           → POST /transcribe
  • VoxCPM2 TTS       (Text-to-Speech)            → POST /generate
  • Health check                                  → GET  /health

Design goals
  • Run efficiently on low-end CPUs (Whisper `base.en`, `int8` quantization).
  • Keep models in memory (load-once) and lazy-initialized so a missing
    VoxCPM install does not prevent STT from booting.
  • Return errors as JSON so the Node.js AIEngine can handle them gracefully.

Install
  pip install fastapi uvicorn python-multipart faster-whisper voxcpm soundfile numpy

Run
  python services/tts/server.py
  # or:
  uvicorn services.tts.server:app --host 127.0.0.1 --port 8808
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import logging
import tempfile
import threading
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# ───────────────────────────────────────────────────────────────
# Configuration
# ───────────────────────────────────────────────────────────────
HOST = os.environ.get("VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_PORT", "8808"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base.en")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
VOXCPM_MODEL = os.environ.get("VOXCPM_MODEL", "openbmb/VoxCPM2")
VOXCPM_DENOISE = os.environ.get("VOXCPM_LOAD_DENOISER", "false").lower() == "true"

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("nexus-voice")

# Lazy-initialized singletons — populated on first use so that, e.g.,
# a broken VoxCPM install does not block Whisper startup.
#
# CRITICAL: do NOT construct these at module import time. The Node.js
# VoiceProcessManager polls /health after spawning us; until uvicorn has
# bound the port, it thinks we're still cold-starting. Heavy constructors
# at import time would delay the bind by tens of seconds. Instead we:
#   • Bind the port instantly (empty lifespan).
#   • Kick off model loads on a background thread at startup (non-blocking).
#   • Have request handlers wait on that background load if it's still in
#     flight rather than starting their own.
_whisper_model = None
_voxcpm_model = None

# Locks so only one background thread / request ever attempts a load.
_whisper_lock = threading.Lock()
_voxcpm_lock = threading.Lock()

# Background-preload thread handle (so /health can report progress).
_preload_thread: Optional[threading.Thread] = None


# ───────────────────────────────────────────────────────────────
# Model loaders (blocking — call from a worker thread, not the event loop)
# ───────────────────────────────────────────────────────────────
def _load_whisper_blocking():
    """Load Faster-Whisper once. Safe to call from multiple threads."""
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            from faster_whisper import WhisperModel  # local import to keep import time cheap
            log.info(
                "Loading Faster-Whisper model=%s device=%s compute_type=%s",
                WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE,
            )
            _whisper_model = WhisperModel(
                WHISPER_MODEL,
                device=WHISPER_DEVICE,
                compute_type=WHISPER_COMPUTE,
            )
            log.info("Faster-Whisper ready.")
    return _whisper_model


def _load_voxcpm_blocking():
    """Load VoxCPM2 once. Heavy on CPU-only hardware."""
    global _voxcpm_model
    if _voxcpm_model is not None:
        return _voxcpm_model
    with _voxcpm_lock:
        if _voxcpm_model is None:
            from voxcpm import VoxCPM  # local import — optional at startup
            log.info("Loading VoxCPM2 model=%s (load_denoiser=%s)", VOXCPM_MODEL, VOXCPM_DENOISE)
            _voxcpm_model = VoxCPM.from_pretrained(VOXCPM_MODEL, load_denoiser=VOXCPM_DENOISE)
            log.info("VoxCPM2 ready.")
    return _voxcpm_model


async def get_whisper():
    """Await Whisper readiness without blocking the event loop."""
    if _whisper_model is not None:
        return _whisper_model
    return await asyncio.to_thread(_load_whisper_blocking)


async def get_voxcpm():
    """Await VoxCPM readiness without blocking the event loop."""
    if _voxcpm_model is not None:
        return _voxcpm_model
    return await asyncio.to_thread(_load_voxcpm_blocking)


def _preload_models_in_background():
    """Fire-and-forget preload. Runs on a plain thread so uvicorn's event
    loop stays free to serve /health immediately."""
    try:
        _load_whisper_blocking()
    except Exception as exc:  # noqa: BLE001
        log.warning("Background Whisper preload failed — will retry on first /transcribe: %s", exc)
    # Deliberately DO NOT preload VoxCPM here — it's large and often unused.
    # The TTS endpoint will load it lazily on first /generate.


# ───────────────────────────────────────────────────────────────
# FastAPI app
# ───────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Bind the port IMMEDIATELY, then warm models on a background thread.

    The Node.js VoiceProcessManager considers the service "awake" the
    moment /health returns 200, so this hook must not block. Heavy model
    construction happens off-thread so the event loop is free from the
    first tick.
    """
    global _preload_thread
    if os.environ.get("PRELOAD_WHISPER", "true").lower() == "true":
        _preload_thread = threading.Thread(
            target=_preload_models_in_background,
            name="nexus-voice-preload",
            daemon=True,
        )
        _preload_thread.start()
        log.info("Voice service ready; preloading Whisper in background.")
    else:
        log.info("Voice service ready; models will load on first request.")
    yield
    log.info("Voice service shutting down.")


app = FastAPI(title="Nexus AI Voice Service", version="1.0.0", lifespan=lifespan)


# ───────────────────────────────────────────────────────────────
# Health
# ───────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    preload_running = bool(_preload_thread and _preload_thread.is_alive())
    return {
        "status": "ok",
        "whisper_loaded": _whisper_model is not None,
        "voxcpm_loaded": _voxcpm_model is not None,
        "preload_in_progress": preload_running,
        "config": {
            "whisper_model": WHISPER_MODEL,
            "whisper_compute_type": WHISPER_COMPUTE,
            "voxcpm_model": VOXCPM_MODEL,
        },
    }


# ───────────────────────────────────────────────────────────────
# STT — POST /transcribe
# ───────────────────────────────────────────────────────────────
@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """
    Transcribe an uploaded audio file using Faster-Whisper.
    Accepts any audio format ffmpeg can decode (ogg/opus, webm, mp3, wav, m4a …).
    Returns: { "text": "<transcription>", "language": "...", "duration": <sec> }
    """
    # Persist the upload to a tempfile because faster-whisper reads from a path.
    suffix = os.path.splitext(file.filename or "audio.webm")[1] or ".webm"
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
    except Exception as exc:  # noqa: BLE001
        log.exception("Failed to buffer upload")
        raise HTTPException(status_code=400, detail=f"Upload failed: {exc}") from exc

    try:
        model = await get_whisper()
        beam_size = int(os.environ.get("WHISPER_BEAM_SIZE", "1"))

        def _run_transcribe():
            # `beam_size=1` keeps CPU inference fast; bump to 5 if accuracy matters more.
            segs, inf = model.transcribe(
                tmp_path,
                beam_size=beam_size,
                vad_filter=True,  # skips silent regions → faster
            )
            return list(segs), inf

        # Offload to a worker thread so the event loop stays responsive and
        # /health keeps answering during long transcriptions.
        segments, info = await asyncio.to_thread(_run_transcribe)
        text = "".join(seg.text for seg in segments).strip()
        return {
            "text": text,
            "language": getattr(info, "language", None),
            "duration": getattr(info, "duration", None),
        }
    except Exception as exc:  # noqa: BLE001
        log.exception("Transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ───────────────────────────────────────────────────────────────
# TTS — POST /generate
# ───────────────────────────────────────────────────────────────
class GenerateRequest(BaseModel):
    text: str
    reference_wav_path: Optional[str] = None  # optional voice-cloning reference
    cfg_value: Optional[float] = 2.0
    inference_timesteps: Optional[int] = 10


@app.post("/generate")
async def generate(req: GenerateRequest):
    """
    Synthesize speech for `req.text` via VoxCPM2 and return a WAV buffer.

    If `reference_wav_path` is provided, it is used for voice-cloning.
    Returns: binary WAV (Content-Type: audio/wav).
    """
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="`text` must be non-empty")

    try:
        import numpy as np  # noqa: F401  (required for soundfile buffers)
        import soundfile as sf
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="soundfile + numpy are required for /generate. "
                   "pip install soundfile numpy",
        ) from exc

    try:
        tts = await get_voxcpm()
    except Exception as exc:  # noqa: BLE001
        log.exception("VoxCPM failed to load")
        raise HTTPException(status_code=503, detail=f"VoxCPM unavailable: {exc}") from exc

    try:
        # VoxCPM returns a numpy ndarray of audio samples at a fixed sample rate.
        # API shape may differ between versions — we try the common kwargs.
        kwargs = {
            "text": req.text,
            "cfg_value": req.cfg_value or 2.0,
            "inference_timesteps": req.inference_timesteps or 10,
        }
        if req.reference_wav_path:
            if not os.path.exists(req.reference_wav_path):
                raise HTTPException(
                    status_code=400,
                    detail=f"reference_wav_path not found on server: {req.reference_wav_path}",
                )
            kwargs["prompt_wav_path"] = req.reference_wav_path

        # Run the blocking inference off-thread so concurrent /health pings
        # (from the Node.js manager) still get prompt replies.
        wav = await asyncio.to_thread(lambda: tts.generate(**kwargs))

        # VoxCPM commonly emits at 16 kHz; fall back safely if not exposed.
        sample_rate = getattr(tts, "sample_rate", 16000)

        buf = io.BytesIO()
        sf.write(buf, wav, sample_rate, format="WAV", subtype="PCM_16")
        buf.seek(0)

        return Response(
            content=buf.read(),
            media_type="audio/wav",
            headers={"X-Sample-Rate": str(sample_rate)},
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("TTS generation failed")
        raise HTTPException(status_code=500, detail=f"TTS failed: {exc}") from exc


# ───────────────────────────────────────────────────────────────
# Entrypoint
# ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    try:
        import uvicorn
    except ImportError:
        print("uvicorn is required. pip install uvicorn", file=sys.stderr)
        sys.exit(1)
    uvicorn.run(app, host=HOST, port=PORT, log_level=os.environ.get("LOG_LEVEL", "info").lower())
