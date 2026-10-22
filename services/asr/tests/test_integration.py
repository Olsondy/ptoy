"""Real-model test. Skipped unless ASR_INTEGRATION=1 (downloads ~900MB on first run)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from asr_service.app import create_app
from asr_service.config import Settings
from asr_service.tags import EMOTIONS, EVENTS

pytestmark = pytest.mark.skipif(
    os.environ.get("ASR_INTEGRATION") != "1", reason="set ASR_INTEGRATION=1 to load the real model"
)

FIXTURE = Path(__file__).parent / "fixtures" / "zh_weather_3s.wav"  # "今天天气怎么样，我们出去走走吧。"


@pytest.fixture(scope="module")
def client():
    from asr_service.engine import SenseVoiceTranscriber

    with TestClient(create_app(Settings.from_env(), SenseVoiceTranscriber)) as c:
        yield c


def test_transcribes_fixture(client: TestClient):
    r = client.post("/asr", content=FIXTURE.read_bytes(), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"text", "emotion", "events", "duration_ms"}
    assert "<|" not in body["text"] and "|>" not in body["text"]
    assert "天气" in body["text"]
    assert body["emotion"] in EMOTIONS
    assert set(body["events"]) <= set(EVENTS)
    print(f"\n{body}")
