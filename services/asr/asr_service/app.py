"""HTTP API.

``POST /asr``  body = 16 kHz mono 16-bit audio (``audio/wav`` or ``audio/pcm``)
-> ``{"text": str, "emotion": str, "events": [str], "duration_ms": int}``

``GET /health`` -> ``{"status": "ok", "model": str}``

Errors -> ``{"error": <code>, "message": <text>}`` with 4xx/5xx status.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .audio import SAMPLE_RATE, AudioError, decode_audio
from .config import Settings
from .engine import Transcriber
from .tags import parse_sensevoice

logger = logging.getLogger(__name__)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code, "message": message})


def create_app(settings: Settings, transcriber_factory: Callable[[Settings], Transcriber]) -> FastAPI:
    """Build the app. ``transcriber_factory`` runs once at startup (tests pass a fake)."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.transcriber = transcriber_factory(settings)
        yield

    app = FastAPI(title="ptoy ASR (SenseVoiceSmall)", lifespan=lifespan)

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "model": settings.model}

    @app.post("/asr")
    async def asr(request: Request) -> JSONResponse:
        body = await request.body()
        try:
            samples = decode_audio(body, request.headers.get("content-type"))
        except AudioError as exc:
            logger.info("rejected request: %s (%s)", exc.code, exc.message)
            return _error(exc.status, exc.code, exc.message)

        audio_s = samples.size / SAMPLE_RATE
        if audio_s > settings.max_seconds:
            return _error(
                413, "audio_too_long", f"audio is {audio_s:.1f}s, limit is {settings.max_seconds:g}s"
            )

        transcriber: Transcriber = request.app.state.transcriber
        start = time.perf_counter()
        try:
            raw = await run_in_threadpool(transcriber.transcribe, samples)
        except Exception:
            logger.exception("inference failed")
            return _error(500, "inference_failed", "ASR inference failed")
        duration_ms = round((time.perf_counter() - start) * 1000)

        parsed = parse_sensevoice(raw)
        logger.info(
            "asr audio=%.2fs infer=%dms emotion=%s events=%s text=%r",
            audio_s, duration_ms, parsed.emotion, parsed.events, parsed.text,
        )
        return JSONResponse(
            {
                "text": parsed.text,
                "emotion": parsed.emotion,
                "events": parsed.events,
                "duration_ms": duration_ms,
            }
        )

    return app
