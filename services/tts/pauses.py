"""Tightens the silence IndexTTS2 leaves around and inside each synthesized segment.

The agent plays segments back to back, so a segment's trailing silence plus the next one's leading
silence becomes the pause between them; with the model's own 60–290 ms edges and long comma pauses
that came to 600–1000 ms, against 200–420 ms in the speaker reference, and replies sounded slow.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FRAME_MS = 10
# A frame is silent below this fraction of the clip's loudest frame (about -30 dB).
SILENCE_RATIO = 0.03


@dataclass(frozen=True)
class PauseLimits:
    lead_ms: int = 30
    trail_ms: int = 250
    max_pause_ms: int = 400


def tighten(pcm: np.ndarray, rate: int, limits: PauseLimits) -> np.ndarray:
    """Keeps at most `lead_ms` / `trail_ms` of edge silence and shortens inner pauses to `max_pause_ms`."""
    frame = max(1, rate * FRAME_MS // 1000)
    n = len(pcm) // frame
    if n == 0:
        return pcm
    frames = pcm[: n * frame].astype(np.float64).reshape(n, frame)
    rms = np.sqrt((frames**2).mean(axis=1))
    voiced = rms > rms.max() * SILENCE_RATIO
    if not voiced.any():
        return pcm
    first = int(np.argmax(voiced))
    last = n - 1 - int(np.argmax(voiced[::-1]))
    lead = limits.lead_ms // FRAME_MS
    trail = limits.trail_ms // FRAME_MS
    max_pause = limits.max_pause_ms // FRAME_MS

    keep = np.zeros(n, dtype=bool)
    keep[max(0, first - lead) : min(n, last + 1 + trail)] = True
    # Inner silent runs longer than max_pause keep their first and last halves.
    i = first
    while i <= last:
        if voiced[i]:
            i += 1
            continue
        j = i
        while not voiced[j]:
            j += 1
        if j - i > max_pause:
            head = max_pause // 2
            keep[i + head : j - (max_pause - head)] = False
        i = j
    out = frames[keep].reshape(-1)
    if last + 1 + trail > n:  # the tail past the last whole frame is still inside the kept trail
        out = np.concatenate([out, pcm[n * frame :].astype(np.float64)])
    return out.astype(pcm.dtype)
