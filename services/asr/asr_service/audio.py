"""Decode a request body into 16 kHz mono float32 samples.

Accepted encodings (selected by ``Content-Type``):

- ``audio/wav`` (also ``audio/wave``, ``audio/x-wav``): a RIFF/WAVE file,
  PCM 16-bit, mono, 16000 Hz.
- ``audio/pcm`` or ``audio/L16`` (also ``application/octet-stream``): headerless
  signed 16-bit little-endian PCM, mono, 16000 Hz. An optional ``rate=`` /
  ``channels=`` media-type parameter is validated if present.

No resampling or downmixing is done: the caller (the Agent's STT plugin)
already holds 16 kHz mono PCM, and silently converting would hide bugs.
"""

from __future__ import annotations

import io
import wave

import numpy as np

SAMPLE_RATE = 16000

WAV_TYPES = frozenset({"audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"})
PCM_TYPES = frozenset({"audio/pcm", "audio/l16", "application/octet-stream"})


class AudioError(Exception):
    """Client-side audio problem. ``status`` is the HTTP status to return."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _parse_content_type(header: str | None) -> tuple[str, dict[str, str]]:
    if not header:
        return "", {}
    parts = [p.strip() for p in header.split(";")]
    params: dict[str, str] = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.strip().lower()] = v.strip().strip('"')
    return parts[0].lower(), params


def _int16_to_float(raw: bytes) -> np.ndarray:
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def _decode_wav(body: bytes) -> np.ndarray:
    try:
        with wave.open(io.BytesIO(body), "rb") as w:
            channels, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
            frames = w.readframes(w.getnframes())
    except (wave.Error, EOFError) as exc:
        raise AudioError(422, "invalid_wav", f"cannot parse WAV: {exc}") from exc
    if rate != SAMPLE_RATE:
        raise AudioError(422, "unsupported_sample_rate", f"sample rate must be {SAMPLE_RATE}, got {rate}")
    if channels != 1:
        raise AudioError(422, "unsupported_channels", f"audio must be mono, got {channels} channels")
    if width != 2:
        raise AudioError(422, "unsupported_sample_width", f"audio must be 16-bit PCM, got {width * 8}-bit")
    return _int16_to_float(frames)


def _decode_pcm(body: bytes, params: dict[str, str]) -> np.ndarray:
    rate = params.get("rate")
    if rate is not None and rate != str(SAMPLE_RATE):
        raise AudioError(422, "unsupported_sample_rate", f"sample rate must be {SAMPLE_RATE}, got {rate}")
    channels = params.get("channels")
    if channels is not None and channels != "1":
        raise AudioError(422, "unsupported_channels", f"audio must be mono, got {channels} channels")
    if len(body) % 2:
        raise AudioError(422, "invalid_pcm", "16-bit PCM body must have an even number of bytes")
    return _int16_to_float(body)


def decode_audio(body: bytes, content_type: str | None) -> np.ndarray:
    """Return float32 samples in [-1, 1) at 16 kHz mono, or raise AudioError."""
    if not body:
        raise AudioError(400, "empty_body", "request body is empty")
    media_type, params = _parse_content_type(content_type)
    if media_type in WAV_TYPES:
        samples = _decode_wav(body)
    elif media_type in PCM_TYPES:
        samples = _decode_pcm(body, params)
    else:
        raise AudioError(
            415,
            "unsupported_media_type",
            "Content-Type must be audio/wav or audio/pcm (16-bit LE, 16 kHz, mono)",
        )
    if samples.size == 0:
        raise AudioError(400, "empty_audio", "audio contains no samples")
    return samples
