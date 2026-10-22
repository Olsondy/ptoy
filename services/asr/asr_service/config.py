"""Settings read from environment variables (see README for the table)."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value else default


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    return float(value) if value else default


@dataclass(frozen=True)
class Settings:
    host: str = "0.0.0.0"
    port: int = 8100
    model: str = "iic/SenseVoiceSmall"
    language: str = "auto"
    threads: int = 4
    max_seconds: float = 30.0
    log_level: str = "info"

    @classmethod
    def from_env(cls) -> "Settings":
        d = cls()
        return cls(
            host=os.environ.get("ASR_HOST", d.host),
            port=_env_int("ASR_PORT", d.port),
            model=os.environ.get("ASR_MODEL", d.model),
            language=os.environ.get("ASR_LANGUAGE", d.language),
            threads=_env_int("ASR_THREADS", d.threads),
            max_seconds=_env_float("ASR_MAX_SECONDS", d.max_seconds),
            log_level=os.environ.get("ASR_LOG_LEVEL", d.log_level).lower(),
        )
