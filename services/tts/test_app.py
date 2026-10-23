import logging
import threading
import time
import unittest

import numpy as np
from fastapi.testclient import TestClient

import app as service
from app import EMOTIONS, Job, JobCancelled, SynthesisAborted, SynthesisQueue, create_app, emotion_vector

RATE = 22050
logging.disable(logging.CRITICAL)


class FakeEngine:
    """Returns 10 ms of a ramp per character; can block until released and honours `should_abort`."""

    sample_rate = RATE

    def __init__(self, gated=False, fail=None, abortable=False):
        self.calls = []
        self.gated = gated
        self.fail = fail
        self.abortable = abortable
        self.started = threading.Event()
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def synthesize(self, text, emo_vector, emo_alpha, should_abort, generation=None):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            call = {"text": text, "emo_vector": emo_vector, "emo_alpha": emo_alpha}
            if generation is not None:
                call["generation"] = generation
            self.calls.append(call)
            self.started.set()
            if self.gated:
                while not self.release.wait(0.01):
                    if self.abortable and should_abort():
                        raise SynthesisAborted()
            if self.fail:
                raise RuntimeError(self.fail)
            n = RATE // 100 * len(text)
            return (np.arange(n) % 1000 - 500).astype(np.int16)
        finally:
            with self.lock:
                self.active -= 1

    def info(self):
        return {"model": "fake", "sample_rate": RATE}


def wait_for(predicate, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.005)
    return False


class EmotionMappingTest(unittest.TestCase):
    def test_neutral_and_missing_follow_the_reference(self):
        self.assertIsNone(emotion_vector(None, None))
        self.assertIsNone(emotion_vector("平静", None))

    def test_names_map_to_one_hot_in_indextts_order(self):
        self.assertEqual(emotion_vector("喜", None), [1, 0, 0, 0, 0, 0, 0, 0])
        self.assertEqual(emotion_vector("哀", None), [0, 0, 1, 0, 0, 0, 0, 0])
        self.assertEqual(emotion_vector("惊喜", None), [0, 0, 0, 0, 0, 0, 1, 0])
        self.assertEqual(EMOTIONS.index("厌恶"), 4)

    def test_explicit_vector_passes_through_and_zero_means_reference(self):
        vec = [0, 0.3, 0, 0, 0, 0.5, 0, 0]
        self.assertEqual(emotion_vector(None, vec), vec)
        self.assertIsNone(emotion_vector(None, [0.0] * 8))


class HttpTest(unittest.TestCase):
    def client(self, engine, **kwargs):
        c = TestClient(create_app(engine, **kwargs))
        c.__enter__()
        self.addCleanup(c.__exit__, None, None, None)
        return c

    def test_returns_s16le_pcm_with_rate_headers(self):
        engine = FakeEngine()
        res = self.client(engine).post("/tts", json={"text": " 你好呀。 ", "request_id": "r1"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["x-sample-rate"], str(RATE))
        self.assertEqual(res.headers["x-channels"], "1")
        self.assertEqual(res.headers["x-sample-format"], "s16le")
        self.assertEqual(res.headers["x-request-id"], "r1")
        self.assertEqual(res.headers["content-type"], "application/octet-stream")
        pcm = np.frombuffer(res.content, dtype="<i2")
        self.assertEqual(len(pcm), RATE // 100 * 4)
        self.assertEqual(pcm[1], -499)
        self.assertEqual(engine.calls, [{"text": "你好呀。", "emo_vector": None, "emo_alpha": 0.65}])
        self.assertEqual(int(res.headers["x-audio-ms"]), 40)

    def test_emotion_name_vector_and_alpha_reach_the_engine(self):
        engine = FakeEngine()
        c = self.client(engine, default_emo_alpha=0.5)
        c.post("/tts", json={"text": "好开心！", "emotion": "喜"})
        c.post("/tts", json={"text": "嗯。", "emotion": "平静"})
        c.post("/tts", json={"text": "唉。", "emotion_vector": [0, 0, 0.8, 0, 0, 0, 0, 0], "emo_alpha": 1})
        self.assertEqual(
            [(x["emo_vector"], x["emo_alpha"]) for x in engine.calls],
            [([1, 0, 0, 0, 0, 0, 0, 0], 0.5), (None, 0.5), ([0, 0, 0.8, 0, 0, 0, 0, 0], 1.0)],
        )

    def test_generation_overrides_reach_the_engine(self):
        engine = FakeEngine()
        c = self.client(engine)
        c.post("/tts", json={"text": "嗯。", "generation": {"temperature": 0.5, "top_k": 10}})
        c.post("/tts", json={"text": "嗯。", "generation": {}})
        self.assertEqual(engine.calls[0]["generation"], {"temperature": 0.5, "top_k": 10})
        self.assertNotIn("generation", engine.calls[1])

    def test_validation(self):
        c = self.client(FakeEngine(), max_text_chars=5)
        bad = [
            {},
            {"text": "   "},
            {"text": "你好", "emotion": "开心"},
            {"text": "你好", "emotion_vector": [1, 0, 0]},
            {"text": "你好", "emotion_vector": [2, 0, 0, 0, 0, 0, 0, 0]},
            {"text": "你好", "emotion": "喜", "emotion_vector": [1, 0, 0, 0, 0, 0, 0, 0]},
            {"text": "你好", "emo_alpha": 1.5},
            {"text": "你好", "generation": {"temperature": 0}},
            {"text": "你好", "generation": {"seed": 1}},
            {"text": "这句话太长了"},
        ]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(c.post("/tts", json=body).status_code, 422)

    def test_engine_failure_is_500_and_service_keeps_working(self):
        engine = FakeEngine(fail="CUDA out of memory")
        c = self.client(engine)
        res = c.post("/tts", json={"text": "你好。"})
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.json()["error"], "synthesis_failed")
        self.assertIn("CUDA out of memory", res.json()["detail"])
        engine.fail = None
        self.assertEqual(c.post("/tts", json={"text": "你好。"}).status_code, 200)

    def test_health(self):
        res = self.client(FakeEngine()).get("/health")
        self.assertEqual(res.json(), {
            "status": "ok", "queued": 0, "running": None, "model": "fake", "sample_rate": RATE,
            "generation_overrides": ["temperature", "top_p", "top_k", "repetition_penalty"],
        })

    def test_cancel_running_request_over_http(self):
        engine = FakeEngine(gated=True)
        c = self.client(engine)
        result = {}
        t = threading.Thread(target=lambda: result.update(res=c.post("/tts", json={"text": "很长的一句话。", "request_id": "long"})))
        t.start()
        self.assertTrue(engine.started.wait(2))
        self.assertEqual(c.post("/cancel/long").json(), {"request_id": "long", "state": "running"})
        engine.release.set()
        t.join(2)
        self.assertEqual(result["res"].status_code, 409)
        self.assertEqual(result["res"].json()["error"], "cancelled")
        self.assertEqual(c.post("/cancel/long").json()["state"], "unknown")

    def test_duplicate_in_flight_request_id_is_409(self):
        engine = FakeEngine(gated=True)
        c = self.client(engine)
        t = threading.Thread(target=lambda: c.post("/tts", json={"text": "一。", "request_id": "dup"}))
        t.start()
        self.assertTrue(engine.started.wait(2))
        self.assertEqual(c.post("/tts", json={"text": "二。", "request_id": "dup"}).status_code, 409)
        engine.release.set()
        t.join(2)


class QueueTest(unittest.TestCase):
    def queue(self, engine, **kwargs):
        q = SynthesisQueue(engine, **kwargs)
        self.addCleanup(q.close)
        return q

    def test_runs_one_job_at_a_time_in_order(self):
        engine = FakeEngine(gated=True)
        q = self.queue(engine)
        futures = [q.submit(Job(f"j{i}", f"第{i}句。", None, 1.0)) for i in range(3)]
        self.assertTrue(engine.started.wait(2))
        self.assertEqual(q.stats(), {"queued": 2, "running": "j0"})
        engine.release.set()
        for f in futures:
            f.result(2)
        self.assertEqual([c["text"] for c in engine.calls], ["第0句。", "第1句。", "第2句。"])
        self.assertEqual(engine.max_active, 1)

    def test_cancel_queued_job_never_reaches_the_engine(self):
        engine = FakeEngine(gated=True)
        q = self.queue(engine)
        first = q.submit(Job("a", "一。", None, 1.0))
        second = q.submit(Job("b", "二。", None, 1.0))
        third = q.submit(Job("c", "三。", None, 1.0))
        self.assertTrue(engine.started.wait(2))
        self.assertEqual(q.cancel("b"), "queued")
        with self.assertRaises(JobCancelled):
            second.result(0.1)  # fails immediately, does not wait for the running job
        engine.release.set()
        first.result(2)
        third.result(2)
        self.assertEqual([c["text"] for c in engine.calls], ["一。", "三。"])

    def test_cancel_running_job_discards_its_result(self):
        engine = FakeEngine(gated=True)
        q = self.queue(engine)
        fut = q.submit(Job("a", "一。", None, 1.0))
        self.assertTrue(engine.started.wait(2))
        self.assertEqual(q.cancel("a"), "running")
        engine.release.set()
        with self.assertRaises(JobCancelled):
            fut.result(2)

    def test_cancel_running_job_lets_the_engine_abort_early(self):
        engine = FakeEngine(gated=True, abortable=True)
        q = self.queue(engine)
        fut = q.submit(Job("a", "一。", None, 1.0))
        nxt = q.submit(Job("b", "二。", None, 1.0))
        self.assertTrue(engine.started.wait(2))
        q.cancel("a")
        with self.assertRaises(JobCancelled):
            fut.result(2)  # without release: the engine stopped by itself
        self.assertTrue(wait_for(lambda: len(engine.calls) == 2))
        engine.release.set()
        self.assertEqual(len(nxt.result(2)), RATE // 100 * 2)

    def test_cancel_before_submit_rejects_the_late_request(self):
        engine = FakeEngine()
        q = self.queue(engine)
        self.assertEqual(q.cancel("late"), "unknown")
        with self.assertRaises(JobCancelled):
            q.submit(Job("late", "一。", None, 1.0)).result(1)
        self.assertEqual(engine.calls, [])
        # The id is consumed: a new request with it runs normally.
        self.assertEqual(len(q.submit(Job("late", "一。", None, 1.0)).result(1)), RATE // 100 * 2)

    def test_queue_limit(self):
        engine = FakeEngine(gated=True)
        q = self.queue(engine, max_queue=1)
        q.submit(Job("a", "一。", None, 1.0))
        self.assertTrue(engine.started.wait(2))
        q.submit(Job("b", "二。", None, 1.0))
        with self.assertRaises(service.QueueFull):
            q.submit(Job("c", "三。", None, 1.0))
        engine.release.set()


if __name__ == "__main__":
    unittest.main()
