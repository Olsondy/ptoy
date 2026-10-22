"""Parse SenseVoice raw output into clean text + emotion + events.

SenseVoice prefixes each segment with special tokens, e.g.

    <|zh|><|NEUTRAL|><|Speech|><|withitn|>今天天气怎么样。

This module is pure (no model, no I/O) so it can be unit-tested directly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Stable lowercase emotion values returned by the API.
EMOTIONS: tuple[str, ...] = (
    "neutral",
    "happy",
    "sad",
    "angry",
    "fearful",
    "disgusted",
    "surprised",
    "unknown",
)

# Stable lowercase event values returned by the API.
EVENTS: tuple[str, ...] = (
    "speech",
    "bgm",
    "applause",
    "laughter",
    "cry",
    "sneeze",
    "breath",
    "cough",
)

_EMOTION_TAGS: dict[str, str] = {
    "NEUTRAL": "neutral",
    "HAPPY": "happy",
    "SAD": "sad",
    "ANGRY": "angry",
    "FEARFUL": "fearful",
    "DISGUSTED": "disgusted",
    "SURPRISED": "surprised",
    "EMO_UNKNOWN": "unknown",
}

_EVENT_TAGS: dict[str, str] = {
    "Speech": "speech",
    "BGM": "bgm",
    "Applause": "applause",
    "Laughter": "laughter",
    "Cry": "cry",
    "Sneeze": "sneeze",
    "Breath": "breath",
    "Cough": "cough",
}

_TAG_RE = re.compile(r"<\|([^|<>]*)\|>")
_SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class ParsedTranscript:
    text: str
    emotion: str = "unknown"
    events: list[str] = field(default_factory=list)


def parse_sensevoice(raw: str) -> ParsedTranscript:
    """Strip every ``<|...|>`` tag and extract emotion/events.

    - ``emotion``: the first known emotion that is not ``unknown``; otherwise
      ``unknown`` (also when no emotion tag is present).
    - ``events``: known event tags, lowercased, de-duplicated, in order of first
      appearance. ``Event_UNK`` and any unrecognized tag are dropped.
    - Language (``zh``/``en``/...) and ITN (``withitn``/``woitn``) tags are dropped.
    """
    emotion = "unknown"
    events: list[str] = []
    for name in _TAG_RE.findall(raw):
        mapped_emotion = _EMOTION_TAGS.get(name)
        if mapped_emotion is not None:
            if emotion == "unknown":
                emotion = mapped_emotion
            continue
        mapped_event = _EVENT_TAGS.get(name)
        if mapped_event is not None and mapped_event not in events:
            events.append(mapped_event)

    text = _SPACE_RE.sub(" ", _TAG_RE.sub(" ", raw)).strip()
    return ParsedTranscript(text=text, emotion=emotion, events=events)
