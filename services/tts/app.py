"""IndexTTS FastAPI service: HTTP layer, emotion mapping and the single-GPU job queue.

No torch / indextts imports here: the model sits behind the `Engine` protocol (real one in
`engine.py`), so this module is unit-tested with a fake engine on any machine.

API (see README.md):
  POST /tts              {text, voice?, emotion?, emotion_vector?, emo_alpha?, generation?, request_id?} → s16le mono PCM
  POST /warm             {voice} load a voice's speaker conditioning ahead of the first /tts
  POST /cancel/{id}      drop a queued request / discard (and best-effort abort) a running one
  GET  /health           model info, queue state, VRAM
"""

from __future__ import annotations

import asyncio
import collections
import concurrent.futures
import logging
import threading
import time
import uuid
from typing import Any, Callable, Literal, Optional, Protocol

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, field_validator, model_validator

from pauses import PauseLimits, tighten

log = logging.getLogger("ptoy.tts")

# IndexTTS2 emotion-vector order (same as packages/segmenter EMOTIONS / WebUI vec1..vec8).
EMOTIONS = ("喜", "怒", "哀", "惧", "厌恶", "低落", "惊喜", "平静")
# 平静 means "speak like the speaker reference": no emotion vector at all.
NEUTRAL = "平静"
# What /warm synthesizes (and throws away) to load a voice.
WARM_TEXT = "嗯，好的。"


class Engine(Protocol):
    """What the service needs from the model. `synthesize` runs on the single worker thread."""

    sample_rate: int
    # Speaker reference ids; a request without `voice` gets `default_voice`.
    voices: list[str]
    default_voice: str
    # Voice of the last synthesis: the model caches that one's speaker conditioning only.
    loaded_voice: Optional[str]

    def synthesize(
        self,
        text: str,
        emo_vector: Optional[list[float]],
        emo_alpha: float,
        should_abort: Callable[[], bool],
        generation: Optional[dict[str, Any]] = None,
        voice: Optional[str] = None,
    ) -> np.ndarray:
        """Returns mono int16 PCM at `sample_rate`. May raise `SynthesisAborted` once `should_abort()` is true.

        `generation` overrides the configured sampling parameters for this call only;
        `voice` picks the speaker reference (None = `default_voice`)."""
        ...

    def info(self) -> dict[str, Any]:
        """Static model/config facts plus live VRAM numbers for /health."""
        ...


class SynthesisAborted(Exception):
    """Raised by an engine that stopped a running synthesis because it was cancelled."""


class JobCancelled(Exception):
    """The job was cancelled (queued or running); its result is dropped."""


class QueueFull(Exception):
    pass


class DuplicateRequest(Exception):
    pass


def emotion_vector(emotion: Optional[str], vector: Optional[list[float]]) -> Optional[list[float]]:
    """Maps the request's emotion to the raw IndexTTS2 vector (None = follow the speaker reference).

    - explicit `vector` wins (validation makes the two mutually exclusive)
    - 平静 / missing → None
    - any other name → one-hot (the engine applies IndexTTS2's `normalize_emo_vec`, like the WebUI)
    - an all-zero vector also means "follow the reference" (IndexTTS2 would otherwise get a null emotion)
    """
    if vector is not None:
        return list(vector) if any(v > 0 for v in vector) else None
    if emotion is None or emotion == NEUTRAL:
        return None
    return [1.0 if e == emotion else 0.0 for e in EMOTIONS]


class GenerationOverrides(BaseModel):
    """Per-request sampling overrides (for tuning without restarting the service); missing = TTS_* env value."""

    model_config = {"extra": "forbid"}

    temperature: Optional[float] = Field(default=None, gt=0.0, le=2.0)
    top_p: Optional[float] = Field(default=None, gt=0.0, le=1.0)
    top_k: Optional[int] = Field(default=None, ge=0)
    repetition_penalty: Optional[float] = Field(default=None, ge=1.0)


VoiceId = Field(default=None, min_length=1, max_length=128)


class TtsRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: Optional[str] = VoiceId
    emotion: Optional[Literal["喜", "怒", "哀", "惧", "厌恶", "低落", "惊喜", "平静"]] = None
    emotion_vector: Optional[list[float]] = Field(default=None, min_length=8, max_length=8)
    emo_alpha: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    generation: Optional[GenerationOverrides] = None
    request_id: Optional[str] = Field(default=None, min_length=1, max_length=128)

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("text is blank")
        return v

    @field_validator("emotion_vector")
    @classmethod
    def _vector_range(cls, v: Optional[list[float]]) -> Optional[list[float]]:
        if v is not None and any(not (0.0 <= x <= 1.0) for x in v):
            raise ValueError("emotion_vector values must be within [0, 1]")
        return v

    @model_validator(mode="after")
    def _one_emotion_source(self) -> "TtsRequest":
        if self.emotion is not None and self.emotion_vector is not None:
            raise ValueError("give either emotion or emotion_vector, not both")
        return self


class WarmRequest(BaseModel):
    voice: str = Field(min_length=1, max_length=128)


class Job:
    def __init__(
        self, job_id: str, text: str, emo_vector: Optional[list[float]], emo_alpha: float,
        generation: Optional[dict[str, Any]] = None, voice: Optional[str] = None,
    ):
        self.id = job_id
        self.text = text
        self.emo_vector = emo_vector
        self.emo_alpha = emo_alpha
        self.generation = generation
        self.voice = voice
        self.future: concurrent.futures.Future = concurrent.futures.Future()
        self.cancelled = threading.Event()
        self.state: Literal["queued", "running", "done"] = "queued"
        self.enqueued_at = time.perf_counter()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None


class SynthesisQueue:
    """FIFO of synthesis jobs executed one at a time on a dedicated thread (the GPU is shared).

    Cancel semantics:
    - queued job → removed, its future fails with `JobCancelled`, the GPU never sees it
    - running job → flagged; the engine may abort early (`should_abort`), and whatever it
      returns is discarded (`JobCancelled`)
    - unknown id → remembered for `cancel_ttl_s`, so a /tts that arrives after its own /cancel
      (the client gave up before the request reached us) is rejected immediately
    """

    def __init__(self, engine: Engine, max_queue: int = 8, cancel_ttl_s: float = 60.0):
        self._engine = engine
        self._max_queue = max_queue
        self._cancel_ttl_s = cancel_ttl_s
        self._cond = threading.Condition()
        self._queue: collections.deque[Job] = collections.deque()
        self._jobs: dict[str, Job] = {}
        self._running: Optional[Job] = None
        self._early_cancels: dict[str, float] = {}
        self._closed = False
        self._thread = threading.Thread(target=self._work, name="tts-worker", daemon=True)
        self._thread.start()

    def submit(self, job: Job) -> concurrent.futures.Future:
        with self._cond:
            self._expire_cancels()
            if job.id in self._early_cancels:
                del self._early_cancels[job.id]
                job.state = "done"
                job.future.set_exception(JobCancelled())
                return job.future
            if job.id in self._jobs:
                raise DuplicateRequest(job.id)
            if len(self._queue) >= self._max_queue:
                raise QueueFull()
            self._jobs[job.id] = job
            self._queue.append(job)
            self._cond.notify()
        return job.future

    def cancel(self, job_id: str) -> str:
        """Returns the state the job was in: `queued`, `running` or `unknown`."""
        with self._cond:
            job = self._jobs.get(job_id)
            if job is None:
                self._expire_cancels()
                self._early_cancels[job_id] = time.monotonic()
                return "unknown"
            job.cancelled.set()
            if job.state == "queued":
                self._queue.remove(job)
                self._finish(job, error=JobCancelled())
                return "queued"
            return "running"

    def stats(self) -> dict[str, Any]:
        with self._cond:
            return {"queued": len(self._queue), "running": self._running.id if self._running else None}

    def close(self) -> None:
        with self._cond:
            self._closed = True
            for job in list(self._queue):
                self._finish(job, error=JobCancelled())
            self._queue.clear()
            self._cond.notify_all()
        self._thread.join(timeout=5)

    def _expire_cancels(self) -> None:
        cutoff = time.monotonic() - self._cancel_ttl_s
        for job_id in [k for k, t in self._early_cancels.items() if t < cutoff]:
            del self._early_cancels[job_id]

    def _finish(self, job: Job, result: Any = None, error: Optional[BaseException] = None) -> None:
        # Caller holds the lock.
        job.state = "done"
        job.finished_at = time.perf_counter()
        self._jobs.pop(job.id, None)
        if error is not None:
            job.future.set_exception(error)
        else:
            job.future.set_result(result)

    def _work(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._closed:
                    self._cond.wait()
                if self._closed:
                    return
                job = self._queue.popleft()
                job.state = "running"
                job.started_at = time.perf_counter()
                self._running = job
            result, error = None, None
            try:
                result = self._engine.synthesize(
                    job.text, job.emo_vector, job.emo_alpha, job.cancelled.is_set,
                    generation=job.generation, voice=job.voice,
                )
            except SynthesisAborted:
                error = JobCancelled()
            except BaseException as exc:  # noqa: BLE001 - report any engine failure to the caller
                error = exc
            with self._cond:
                self._running = None
                if job.cancelled.is_set():
                    error = JobCancelled()
                    log.info("discarded cancelled synthesis %s (%.0f ms)", job.id, (time.perf_counter() - job.started_at) * 1000)
                self._finish(job, result=result, error=error)


def _error(status: int, code: str, detail: str = "", headers: Optional[dict[str, str]] = None) -> JSONResponse:
    return JSONResponse({"error": code, "detail": detail}, status_code=status, headers=headers)


async def _wait_or_disconnect(request: Request, fut: concurrent.futures.Future, on_disconnect: Callable[[], None]) -> Any:
    """Awaits the job; if the client goes away first, cancels the job (frees the GPU sooner)."""
    waiter = asyncio.wrap_future(fut)
    while True:
        done, _ = await asyncio.wait({waiter}, timeout=0.1)
        if done:
            return waiter.result()
        if await request.is_disconnected():
            on_disconnect()
            # Let the job settle (queued: immediate; running: after the engine returns/aborts).
            return await waiter


def create_app(
    engine: Engine, *, default_emo_alpha: float = 0.65, max_text_chars: int = 300, max_queue: int = 8,
    pauses: Optional[PauseLimits] = None,
) -> FastAPI:
    """`pauses`: tighten each response's edge and inner silences (None = return the model output as is)."""
    queue = SynthesisQueue(engine, max_queue=max_queue)
    app = FastAPI(title="ptoy IndexTTS service")
    app.state.queue = queue
    app.router.on_shutdown.append(queue.close)

    @app.post("/tts")
    async def tts(body: TtsRequest, request: Request):
        if len(body.text) > max_text_chars:
            return _error(422, "text_too_long", f"text has {len(body.text)} chars, max {max_text_chars}")
        if body.voice is not None and body.voice not in engine.voices:
            return _error(422, "unknown_voice", f"voice {body.voice!r} not in {engine.voices}")
        job_id = body.request_id or uuid.uuid4().hex
        alpha = default_emo_alpha if body.emo_alpha is None else body.emo_alpha
        generation = body.generation.model_dump(exclude_none=True) if body.generation else None
        job = Job(
            job_id, body.text, emotion_vector(body.emotion, body.emotion_vector), alpha, generation or None, body.voice,
        )
        headers = {"X-Request-Id": job_id}
        try:
            fut = queue.submit(job)
        except DuplicateRequest:
            return _error(409, "duplicate_request_id", job_id, headers)
        except QueueFull:
            return _error(503, "queue_full", f"more than {max_queue} requests waiting", headers)

        def on_disconnect() -> None:
            state = queue.cancel(job_id)
            log.info("client disconnected, cancelled %s (%s)", job_id, state)

        try:
            pcm = await _wait_or_disconnect(request, fut, on_disconnect)
        except JobCancelled:
            return _error(409, "cancelled", job_id, headers)
        except Exception as exc:  # noqa: BLE001
            log.exception("synthesis %s failed", job_id)
            return _error(500, "synthesis_failed", f"{type(exc).__name__}: {exc}", headers)

        pcm = np.asarray(pcm)
        if pcm.dtype != np.int16:
            return _error(500, "synthesis_failed", f"engine returned {pcm.dtype}, expected int16", headers)
        if pauses is not None:
            pcm = tighten(pcm.reshape(-1), engine.sample_rate, pauses)
        data = pcm.reshape(-1).astype("<i2", copy=False).tobytes()
        queue_ms = (job.started_at - job.enqueued_at) * 1000 if job.started_at else 0.0
        synth_ms = (job.finished_at - job.started_at) * 1000 if job.started_at and job.finished_at else 0.0
        audio_ms = len(data) / 2 / engine.sample_rate * 1000
        log.info(
            "synthesized %s: %d chars, voice=%s, emotion=%s, queue %.0f ms, synth %.0f ms, audio %.0f ms",
            job_id, len(body.text), body.voice or engine.default_voice,
            body.emotion or ("vector" if body.emotion_vector else "reference"), queue_ms, synth_ms, audio_ms,
        )
        headers.update(
            {
                "X-Sample-Rate": str(engine.sample_rate),
                "X-Channels": "1",
                "X-Sample-Format": "s16le",
                "X-Queue-Ms": f"{queue_ms:.0f}",
                "X-Synth-Ms": f"{synth_ms:.0f}",
                "X-Audio-Ms": f"{audio_ms:.0f}",
            }
        )
        return Response(content=data, media_type="application/octet-stream", headers=headers)

    @app.post("/warm")
    async def warm(body: WarmRequest, request: Request):
        """Loads the voice's speaker conditioning with a throwaway synthesis, so the call's first
        reply does not pay for it. A no-op when the model already holds this voice."""
        if body.voice not in engine.voices:
            return _error(422, "unknown_voice", f"voice {body.voice!r} not in {engine.voices}")
        if engine.loaded_voice == body.voice:
            return {"voice": body.voice, "state": "loaded"}
        job_id = f"warm-{uuid.uuid4().hex}"
        try:
            fut = queue.submit(Job(job_id, WARM_TEXT, None, default_emo_alpha, voice=body.voice))
        except QueueFull:
            return _error(503, "queue_full", f"more than {max_queue} requests waiting")
        try:
            await _wait_or_disconnect(request, fut, lambda: queue.cancel(job_id))
        except JobCancelled:
            return _error(409, "cancelled", job_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("warming voice %s failed", body.voice)
            return _error(500, "synthesis_failed", f"{type(exc).__name__}: {exc}")
        log.info("warmed voice %s", body.voice)
        return {"voice": body.voice, "state": "warmed"}

    @app.post("/cancel/{request_id}")
    async def cancel(request_id: str):
        state = queue.cancel(request_id)
        if state != "unknown":
            log.info("cancel %s (%s)", request_id, state)
        return {"request_id": request_id, "state": state}

    @app.get("/health")
    async def health():
        return {
            "status": "ok", **queue.stats(), **engine.info(),
            "generation_overrides": list(GenerationOverrides.model_fields),
        }

    return app
