"""HTTP contract tests with the model replaced by a fake."""

from __future__ import annotations

import io
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from asr_service.app import create_app
from asr_service.config import Settings


class FakeTranscriber:
    def __init__(self, raw: str = "<|zh|><|HAPPY|><|Speech|><|withitn|>今天天气怎么样？") -> None:
        self.raw = raw
        self.calls: list[np.ndarray] = []
        self.fail = False

    def transcribe(self, samples: np.ndarray) -> str:
        if self.fail:
            raise RuntimeError("boom")
        self.calls.append(samples)
        return self.raw


def make_wav(seconds: float = 0.5, rate: int = 16000, channels: int = 1, width: int = 2) -> bytes:
    n = int(seconds * rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes((b"\x01\x00" if width == 2 else b"\x80") * n * channels)
    return buf.getvalue()


@pytest.fixture
def fake() -> FakeTranscriber:
    return FakeTranscriber()


@pytest.fixture
def client(fake: FakeTranscriber):
    app = create_app(Settings(max_seconds=2.0), lambda _settings: fake)
    with TestClient(app) as c:
        yield c


def test_health(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_wav_request_returns_contract_shape(client: TestClient, fake: FakeTranscriber):
    r = client.post("/asr", content=make_wav(), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"text", "emotion", "events", "duration_ms"}
    assert body["text"] == "今天天气怎么样？"
    assert "<|" not in body["text"]
    assert body["emotion"] == "happy"
    assert body["events"] == ["speech"]
    assert isinstance(body["duration_ms"], int) and body["duration_ms"] >= 0
    samples = fake.calls[0]
    assert samples.dtype == np.float32 and samples.size == 8000


def test_raw_pcm_request(client: TestClient, fake: FakeTranscriber):
    pcm = np.array([0, 16384, -32768, 32767] * 100, dtype="<i2").tobytes()
    r = client.post("/asr", content=pcm, headers={"Content-Type": "audio/pcm;rate=16000;channels=1"})
    assert r.status_code == 200
    samples = fake.calls[0]
    assert samples.size == 400
    assert samples[:4].tolist() == pytest.approx([0.0, 0.5, -1.0, 32767 / 32768])


@pytest.mark.parametrize("ctype", ["audio/L16; rate=16000", "application/octet-stream", "audio/x-wav"])
def test_alternate_content_types(client: TestClient, ctype: str):
    body = make_wav() if "wav" in ctype else b"\x00\x00" * 160
    assert client.post("/asr", content=body, headers={"Content-Type": ctype}).status_code == 200


def test_empty_body(client: TestClient):
    r = client.post("/asr", content=b"", headers={"Content-Type": "audio/wav"})
    assert r.status_code == 400
    assert r.json()["error"] == "empty_body"


def test_wav_without_samples(client: TestClient):
    r = client.post("/asr", content=make_wav(seconds=0), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 400
    assert r.json()["error"] == "empty_audio"


def test_wrong_sample_rate(client: TestClient, fake: FakeTranscriber):
    r = client.post("/asr", content=make_wav(rate=44100), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 422
    assert r.json()["error"] == "unsupported_sample_rate"
    assert fake.calls == []


def test_stereo_rejected(client: TestClient):
    r = client.post("/asr", content=make_wav(channels=2), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 422
    assert r.json()["error"] == "unsupported_channels"


def test_8bit_rejected(client: TestClient):
    r = client.post("/asr", content=make_wav(width=1), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 422
    assert r.json()["error"] == "unsupported_sample_width"


def test_non_wav_body_labelled_wav(client: TestClient):
    r = client.post("/asr", content=b"this is not a wav file", headers={"Content-Type": "audio/wav"})
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_wav"


def test_pcm_wrong_rate_param(client: TestClient):
    r = client.post("/asr", content=b"\x00\x00" * 10, headers={"Content-Type": "audio/pcm;rate=48000"})
    assert r.status_code == 422
    assert r.json()["error"] == "unsupported_sample_rate"


def test_pcm_odd_length(client: TestClient):
    r = client.post("/asr", content=b"\x00\x00\x00", headers={"Content-Type": "audio/pcm"})
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_pcm"


@pytest.mark.parametrize("ctype", [None, "application/json", "audio/mpeg"])
def test_unsupported_content_type(client: TestClient, ctype):
    headers = {"Content-Type": ctype} if ctype else {}
    r = client.post("/asr", content=b"\x00\x00" * 10, headers=headers)
    assert r.status_code == 415
    assert r.json()["error"] == "unsupported_media_type"


def test_audio_too_long(client: TestClient, fake: FakeTranscriber):
    r = client.post("/asr", content=make_wav(seconds=3), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 413
    assert r.json()["error"] == "audio_too_long"
    assert fake.calls == []


def test_inference_failure_returns_500(client: TestClient, fake: FakeTranscriber):
    fake.fail = True
    r = client.post("/asr", content=make_wav(), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 500
    assert r.json()["error"] == "inference_failed"


def test_no_speech_returns_empty_text(fake: FakeTranscriber):
    fake.raw = "<|nospeech|><|EMO_UNKNOWN|><|Event_UNK|><|woitn|>"
    with TestClient(create_app(Settings(), lambda _s: fake)) as c:
        body = c.post("/asr", content=make_wav(), headers={"Content-Type": "audio/wav"}).json()
    assert body == {"text": "", "emotion": "unknown", "events": [], "duration_ms": body["duration_ms"]}
