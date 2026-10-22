"""SenseVoiceSmall on CPU via funasr."""

from __future__ import annotations

import logging
import threading
from typing import Protocol

import numpy as np

from .config import Settings

logger = logging.getLogger(__name__)

WARMUP_SAMPLES = 16000  # 1s of silence


class Transcriber(Protocol):
    def transcribe(self, samples: np.ndarray) -> str:
        """Return SenseVoice raw output (with ``<|...|>`` tags) for 16 kHz mono float32 audio."""
        ...


class SenseVoiceTranscriber:
    """Loads the model once; serializes inference (funasr models are not thread-safe)."""

    def __init__(self, settings: Settings) -> None:
        import torch
        from funasr import AutoModel

        torch.set_num_threads(settings.threads)
        logger.info("loading %s on cpu (threads=%d)", settings.model, settings.threads)
        self._model = AutoModel(
            model=settings.model,
            device="cpu",
            ncpu=settings.threads,
            disable_update=True,
            disable_pbar=True,
            log_level="ERROR",
        )
        self._language = settings.language
        self._lock = threading.Lock()
        # Warm-up so the first real request does not pay one-off init cost.
        self.transcribe(np.zeros(WARMUP_SAMPLES, dtype=np.float32))
        logger.info("model ready")

    def transcribe(self, samples: np.ndarray) -> str:
        with self._lock:
            res = self._model.generate(
                input=samples,
                cache={},
                language=self._language,
                use_itn=True,
                batch_size_s=60,
                disable_pbar=True,
            )
        if not res:
            return ""
        return str(res[0].get("text", ""))

