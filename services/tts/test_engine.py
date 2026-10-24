"""IndexTtsEngine against a fake `indextts` package shaped like upstream IndexTTS2 (no torch needed)."""

import logging
import os
import sys
import tempfile
import types
import unittest
import wave
from types import SimpleNamespace

import numpy as np

from app import SynthesisAborted
from engine import EngineConfig, IndexTtsEngine, filter_kwargs, pcm_from_output, to_int16_mono

logging.disable(logging.CRITICAL)
RATE = 22050


class FakeCfm:
    def __init__(self):
        self.calls = []

    def inference(self, mu, x_lens, prompt, style, f0, n_timesteps, temperature=1.0, inference_cfg_rate=0.5):
        self.calls.append({"n_timesteps": n_timesteps, "inference_cfg_rate": inference_cfg_rate})


class FakeIndexTTS2:
    """Upstream-like: no `use_qwen_emo`, returns (sr, int16 (T, 1)) when output_path is None."""

    instances = []
    memory_output = True
    abort_stage = None

    def __init__(self, cfg_path, model_dir, use_fp16=False, device=None, use_cuda_kernel=None,
                 use_deepspeed=False, use_accel=False, use_torch_compile=False, use_bf16=False):
        self.init_kwargs = dict(cfg_path=cfg_path, model_dir=model_dir, use_fp16=use_fp16, use_bf16=use_bf16,
                                use_deepspeed=use_deepspeed)
        self.gr_progress = None
        self.s2mel = SimpleNamespace(models={"cfm": FakeCfm()})
        self.calls = []
        FakeIndexTTS2.instances.append(self)

    def _set_gr_progress(self, value, desc):
        if self.gr_progress is not None:
            self.gr_progress(value, desc=desc)

    def normalize_emo_vec(self, vec, apply_bias=True):
        return [round(v * 0.5, 4) for v in vec]

    def infer(self, spk_audio_prompt, text, output_path, emo_audio_prompt=None, emo_alpha=1.0, emo_vector=None,
              use_emo_text=False, emo_text=None, use_random=False, interval_silence=200, verbose=False,
              max_text_tokens_per_segment=120, stream_return=False, more_segment_before=0, **generation_kwargs):
        self.calls.append(dict(spk_audio_prompt=spk_audio_prompt, text=text, output_path=output_path,
                               emo_alpha=emo_alpha, emo_vector=emo_vector,
                               max_text_tokens_per_segment=max_text_tokens_per_segment, **generation_kwargs))
        self._set_gr_progress(0, "start")
        self.s2mel.models["cfm"].inference(None, None, None, None, None, 25, inference_cfg_rate=0.7)
        self._set_gr_progress(0.9, "bigvgan")
        n = RATE // 100 * len(text)
        wav = (np.arange(n) % 100).astype(np.int16).reshape(-1, 1)
        if output_path:
            with wave.open(output_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(wav.tobytes())
            return output_path
        if not self.memory_output:
            raise TypeError("expected str, bytes or os.PathLike object, not NoneType")
        return (RATE, wav)


def install_fakes():
    torch = types.ModuleType("torch")
    torch.cuda = SimpleNamespace(is_available=lambda: False, is_bf16_supported=lambda: False)
    pkg = types.ModuleType("indextts")
    pkg.__path__ = []
    v2 = types.ModuleType("indextts.infer_v2")
    v25 = types.ModuleType("indextts.infer_v2_5")
    v2.IndexTTS2 = v25.IndexTTS2 = FakeIndexTTS2
    sys.modules.update({"torch": torch, "indextts": pkg, "indextts.infer_v2": v2, "indextts.infer_v2_5": v25})


class EngineTest(unittest.TestCase):
    def setUp(self):
        install_fakes()
        FakeIndexTTS2.memory_output = True
        FakeIndexTTS2.instances.clear()
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        self.dir = tempfile.mkdtemp()
        self.ref = os.path.join(self.dir, "ref.wav")
        with wave.open(self.ref, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(b"\0\0" * 100)
        os.makedirs(os.path.join(self.dir, "checkpoints"))
        with open(os.path.join(self.dir, "checkpoints", "config.yaml"), "w") as f:
            f.write("fake: true\n")

    def engine(self, **env):
        base = {"INDEXTTS_DIR": self.dir, "TTS_REF_AUDIO": self.ref}
        return IndexTtsEngine(EngineConfig.from_env({**base, **env}))

    def test_missing_config_yaml_names_the_model_dir(self):
        os.remove(os.path.join(self.dir, "checkpoints", "config.yaml"))
        with self.assertRaisesRegex(FileNotFoundError, "TTS_MODEL_DIR"):
            self.engine()

    def test_missing_model_dir_is_reported(self):
        with self.assertRaisesRegex(FileNotFoundError, "model dir not found"):
            self.engine(TTS_MODEL_DIR=os.path.join(self.dir, "nope"))

    def test_builds_model_with_supported_kwargs_and_warms_up_in_memory(self):
        e = self.engine(TTS_MODEL_VERSION="2")
        model = FakeIndexTTS2.instances[0]
        self.assertTrue(model.init_kwargs["use_fp16"])  # half precision by default
        self.assertEqual(model.init_kwargs["model_dir"], os.path.join(self.dir, "checkpoints"))
        self.assertEqual(e.output_mode, "memory")
        self.assertEqual(len(model.calls), 1)  # warm-up
        self.assertIsNone(model.calls[0]["output_path"])
        self.assertEqual(e.sample_rate, RATE)

    def test_v25_without_bf16_falls_back_to_full_precision(self):
        e = self.engine()
        self.assertFalse(FakeIndexTTS2.instances[0].init_kwargs["use_bf16"])
        self.assertEqual(e.precision, "fp32")

    def test_synthesize_uses_fixed_ref_path_normalized_vector_and_webui_sampling(self):
        e = self.engine(TTS_TOP_K="20")
        pcm = e.synthesize("你好。", [1, 0, 0, 0, 0, 0, 0, 0], 0.65, lambda: False)
        self.assertEqual(pcm.dtype, np.int16)
        self.assertEqual(pcm.ndim, 1)
        self.assertEqual(len(pcm), RATE // 100 * 3)
        call = FakeIndexTTS2.instances[0].calls[-1]
        self.assertEqual(call["spk_audio_prompt"], self.ref)
        self.assertEqual(call["emo_vector"], [0.5, 0, 0, 0, 0, 0, 0, 0])
        self.assertEqual(call["emo_alpha"], 0.65)
        self.assertEqual((call["top_k"], call["top_p"], call["max_mel_tokens"]), (20, 0.8, 1500))
        self.assertEqual((call["lang"], call["duration_factor"]), ("ZH", 1.0))

    def test_speed_shortens_the_duration_factor_on_top_of_the_configured_one(self):
        e = self.engine(TTS_DURATION_FACTOR="0.9")
        e.synthesize("你好。", None, 1.0, lambda: False, speed=1.125)
        self.assertAlmostEqual(FakeIndexTTS2.instances[0].calls[-1]["duration_factor"], 0.8)
        e.synthesize("你好。", None, 1.0, lambda: False)
        self.assertAlmostEqual(FakeIndexTTS2.instances[0].calls[-1]["duration_factor"], 0.9)

    def test_per_call_generation_overrides_the_configured_sampling(self):
        e = self.engine(TTS_TOP_K="20")
        e.synthesize("你好。", None, 1.0, lambda: False, generation={"temperature": 0.5})
        call = FakeIndexTTS2.instances[0].calls[-1]
        self.assertEqual((call["temperature"], call["top_k"], call["top_p"]), (0.5, 20, 0.8))
        e.synthesize("你好。", None, 1.0, lambda: False)
        self.assertEqual(FakeIndexTTS2.instances[0].calls[-1]["temperature"], 0.8)

    def test_falls_back_to_temp_file_when_infer_needs_an_output_path(self):
        FakeIndexTTS2.memory_output = False
        e = self.engine()
        self.assertEqual(e.output_mode, "file")
        pcm = e.synthesize("一二三四。", None, 1.0, lambda: False)
        self.assertEqual(len(pcm), RATE // 100 * 5)
        path = FakeIndexTTS2.instances[0].calls[-1]["output_path"]
        self.assertFalse(os.path.exists(path))  # temp file removed

    def test_diffusion_steps_are_injected_into_the_cfm_call(self):
        self.engine(TTS_DIFFUSION_STEPS="10", TTS_CFG_RATE="0.5")
        cfm = FakeIndexTTS2.instances[0].s2mel.models["cfm"]
        self.assertEqual(cfm.calls[-1], {"n_timesteps": 10, "inference_cfg_rate": 0.5})

    def test_without_override_the_model_keeps_its_own_steps(self):
        e = self.engine()
        self.assertEqual(FakeIndexTTS2.instances[0].s2mel.models["cfm"].calls[-1]["n_timesteps"], 25)
        self.assertIsNone(e.diffusion["via"])

    def test_cancel_aborts_at_the_next_progress_report(self):
        e = self.engine()
        with self.assertRaises(SynthesisAborted):
            e.synthesize("你好。", None, 1.0, lambda: True)
        # The hook is reset afterwards.
        self.assertEqual(len(e.synthesize("你好。", None, 1.0, lambda: False)), RATE // 100 * 3)

    def test_missing_ref_audio(self):
        with self.assertRaises(ValueError):
            EngineConfig.from_env({"INDEXTTS_DIR": self.dir})
        with self.assertRaises(FileNotFoundError):
            self.engine(TTS_REF_AUDIO=os.path.join(self.dir, "nope.wav"))

    def voices_dir(self, *names):
        d = os.path.join(self.dir, "voices")
        os.makedirs(d, exist_ok=True)
        for name in names:
            with open(self.ref, "rb") as src, open(os.path.join(d, name), "wb") as dst:
                dst.write(src.read())
        return d

    def test_voices_dir_ids_and_default(self):
        d = self.voices_dir("chunqing.wav", "wenrou.wav", "notes.txt")
        env = {"INDEXTTS_DIR": self.dir, "TTS_VOICES_DIR": d}
        with self.assertRaisesRegex(ValueError, "TTS_DEFAULT_VOICE"):
            EngineConfig.from_env(env)  # two voices, no default
        cfg = EngineConfig.from_env({**env, "TTS_DEFAULT_VOICE": "wenrou"})
        self.assertEqual(sorted(cfg.voices), ["chunqing", "wenrou"])
        self.assertEqual(cfg.default_voice, "wenrou")
        with self.assertRaisesRegex(ValueError, "not found"):
            EngineConfig.from_env({**env, "TTS_DEFAULT_VOICE": "nope"})
        # TTS_REF_AUDIO joins the voices and is the default unless TTS_DEFAULT_VOICE says otherwise.
        cfg = EngineConfig.from_env({**env, "TTS_REF_AUDIO": self.ref})
        self.assertEqual((sorted(cfg.voices), cfg.default_voice), (["chunqing", "ref", "wenrou"], "ref"))
        # A single voice is the default.
        os.remove(os.path.join(d, "wenrou.wav"))
        self.assertEqual(EngineConfig.from_env(env).default_voice, "chunqing")

    def test_synthesize_picks_the_voice_reference(self):
        d = self.voices_dir("wenrou.wav")
        e = self.engine(TTS_VOICES_DIR=d)
        model = FakeIndexTTS2.instances[0]
        self.assertEqual((e.voices, e.default_voice, e.loaded_voice), (["ref", "wenrou"], "ref", "ref"))
        e.synthesize("你好。", None, 1.0, lambda: False, voice="wenrou")
        self.assertEqual(model.calls[-1]["spk_audio_prompt"], os.path.join(d, "wenrou.wav"))
        self.assertEqual(e.loaded_voice, "wenrou")
        e.synthesize("你好。", None, 1.0, lambda: False)
        self.assertEqual(model.calls[-1]["spk_audio_prompt"], self.ref)
        with self.assertRaisesRegex(ValueError, "unknown voice"):
            e.synthesize("你好。", None, 1.0, lambda: False, voice="nope")


class HelperTest(unittest.TestCase):
    def test_filter_kwargs(self):
        def f(a, b=1):
            pass

        def g(a, **kw):
            pass

        self.assertEqual(filter_kwargs(f, {"a": 1, "c": 2}), ({"a": 1}, ["c"]))
        self.assertEqual(filter_kwargs(g, {"a": 1, "c": 2}), ({"a": 1, "c": 2}, []))

    def test_to_int16_mono(self):
        self.assertEqual(to_int16_mono(np.array([0.5, -1.0], dtype=np.float32)).tolist(), [16384, -32767])
        self.assertEqual(to_int16_mono(np.array([[100.0], [-200.0]])).tolist(), [100, -200])
        stereo = np.array([[100, 300, 50], [-100, -300, 50]], dtype=np.int16)  # (C, T)
        self.assertEqual(to_int16_mono(stereo).tolist(), [0, 0, 50])

    def test_pcm_from_output(self):
        self.assertIsNone(pcm_from_output("out.wav"))
        self.assertIsNone(pcm_from_output(None))
        rate, pcm = pcm_from_output((24000, np.zeros((5, 1), dtype=np.int16)))
        self.assertEqual((rate, pcm.shape), (24000, (5,)))


if __name__ == "__main__":
    unittest.main()
