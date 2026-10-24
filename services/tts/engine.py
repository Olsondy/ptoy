"""Loads IndexTTS2 once and runs one synthesis at a time for `app.py`.

The installed IndexTTS is a non-official fork; everything we know about it comes from its
`webui.py` (`build_tts()` / `gen_single()`). So every call is shaped defensively:
- constructor and `infer()` kwargs are filtered by `inspect.signature` (unknown ones are logged and dropped)
- audio comes back in memory when `infer(output_path=None)` returns `(sample_rate, ndarray)` like
  upstream IndexTTS2; otherwise we fall back to a temp wav file (`TTS_OUTPUT_MODE`)
- diffusion steps: passed to `infer()` if it has such a parameter, else injected by wrapping the
  s2mel CFM `inference(..., n_timesteps, inference_cfg_rate=...)` call, else reported as unavailable
- cancellation: IndexTTS2 reports progress through `tts.gr_progress(value, desc)` at stage
  boundaries; our hook raises there once the job is cancelled, so a cancelled synthesis stops at
  the next stage instead of running to the end
"""

from __future__ import annotations

import functools
import inspect
import logging
import os
import sys
import tempfile
import time
import uuid
import wave
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import numpy as np

from app import SynthesisAborted

log = logging.getLogger("ptoy.tts.engine")

# WebUI defaults (webui.py sliders / gen_single / --gui_seg_tokens).
DEFAULT_GENERATION = {
    "do_sample": True,
    "top_p": 0.8,
    "top_k": 30,
    "temperature": 0.8,
    "length_penalty": 0.0,
    "num_beams": 1,
    "repetition_penalty": 10.0,
    "max_mel_tokens": 1500,
}


def _env_bool(env: dict[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_opt(env: dict[str, str], name: str, cast: Callable[[str], Any]) -> Any:
    raw = env.get(name)
    return None if raw is None or raw.strip() == "" else cast(raw.strip())


def voices_from_env(env: dict[str, str]) -> tuple[dict[str, str], str]:
    """Speaker references by voice id (wav file stem) and the default voice.

    `TTS_VOICES_DIR` holds one `<voice>.wav` per voice; `TTS_REF_AUDIO` adds one more file and,
    unless `TTS_DEFAULT_VOICE` says otherwise, is the default (a request without `voice`).
    """
    voices: dict[str, str] = {}
    voices_dir = env.get("TTS_VOICES_DIR")
    if voices_dir:
        voices_dir = os.path.abspath(voices_dir)
        if not os.path.isdir(voices_dir):
            raise ValueError(f"TTS_VOICES_DIR is not a directory: {voices_dir}")
        for name in sorted(os.listdir(voices_dir)):
            stem, ext = os.path.splitext(name)
            if ext.lower() == ".wav":
                voices[stem] = os.path.join(voices_dir, name)
    ref_id = None
    ref = env.get("TTS_REF_AUDIO")
    if ref:
        ref = os.path.abspath(ref)
        ref_id = os.path.splitext(os.path.basename(ref))[0]
        if voices.get(ref_id, ref) != ref:
            raise ValueError(f"TTS_REF_AUDIO {ref} and {voices[ref_id]} would both be voice {ref_id!r}")
        voices[ref_id] = ref
    if not voices:
        raise ValueError("no voice: set TTS_VOICES_DIR (one <voice>.wav per voice) and/or TTS_REF_AUDIO")
    default = env.get("TTS_DEFAULT_VOICE") or ref_id or (next(iter(voices)) if len(voices) == 1 else None)
    if default is None:
        raise ValueError(f"set TTS_DEFAULT_VOICE to one of {sorted(voices)}")
    if default not in voices:
        raise ValueError(f"TTS_DEFAULT_VOICE {default!r} not found (have: {sorted(voices)})")
    return voices, default


@dataclass
class EngineConfig:
    indextts_dir: str
    voices: dict[str, str]
    default_voice: str
    model_dir: str
    version: str = "2.5"
    half: bool = True
    use_deepspeed: bool = False
    use_cuda_kernel: bool = False
    use_accel: bool = False
    use_torch_compile: bool = False
    use_qwen_emo: bool = False
    language: str = "ZH"
    duration_factor: float = 1.0
    max_text_tokens_per_segment: int = 120
    diffusion_steps: Optional[int] = None
    cfg_rate: Optional[float] = None
    generation: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_GENERATION))
    output_mode: str = "auto"  # auto | memory | file
    abort_running: bool = True
    warmup_text: str = "你好，很高兴认识你。"

    @classmethod
    def from_env(cls, env: Optional[dict[str, str]] = None) -> "EngineConfig":
        env = dict(os.environ if env is None else env)
        root = os.path.abspath(env.get("INDEXTTS_DIR") or os.getcwd())
        voices, default_voice = voices_from_env(env)
        generation = dict(DEFAULT_GENERATION)
        for key, cast in (
            ("top_p", float), ("top_k", int), ("temperature", float), ("length_penalty", float),
            ("num_beams", int), ("repetition_penalty", float), ("max_mel_tokens", int),
        ):
            value = _env_opt(env, f"TTS_{key.upper()}", cast)
            if value is not None:
                generation[key] = value
        generation["do_sample"] = _env_bool(env, "TTS_DO_SAMPLE", True)
        mode = (env.get("TTS_OUTPUT_MODE") or "auto").lower()
        if mode not in ("auto", "memory", "file"):
            raise ValueError("TTS_OUTPUT_MODE must be auto, memory or file")
        version = env.get("TTS_MODEL_VERSION") or "2.5"
        if version not in ("2", "2.5"):
            raise ValueError("TTS_MODEL_VERSION must be 2 or 2.5")
        return cls(
            indextts_dir=root,
            voices=voices,
            default_voice=default_voice,
            model_dir=os.path.abspath(env.get("TTS_MODEL_DIR") or os.path.join(root, "checkpoints")),
            version=version,
            half=_env_bool(env, "TTS_HALF", True),
            use_deepspeed=_env_bool(env, "TTS_DEEPSPEED", False),
            use_cuda_kernel=_env_bool(env, "TTS_CUDA_KERNEL", False),
            use_accel=_env_bool(env, "TTS_ACCEL", False),
            use_torch_compile=_env_bool(env, "TTS_TORCH_COMPILE", False),
            use_qwen_emo=_env_bool(env, "TTS_QWEN_EMO", False),
            language=env.get("TTS_LANGUAGE") or "ZH",
            duration_factor=_env_opt(env, "TTS_DURATION_FACTOR", float) or 1.0,
            max_text_tokens_per_segment=_env_opt(env, "TTS_MAX_TEXT_TOKENS_PER_SEGMENT", int) or 120,
            diffusion_steps=_env_opt(env, "TTS_DIFFUSION_STEPS", int),
            cfg_rate=_env_opt(env, "TTS_CFG_RATE", float),
            generation=generation,
            output_mode=mode,
            abort_running=_env_bool(env, "TTS_ABORT_RUNNING", True),
            warmup_text=env.get("TTS_WARMUP_TEXT") or "你好，很高兴认识你。",
        )


def filter_kwargs(fn: Callable[..., Any], kwargs: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Keeps the kwargs `fn` accepts. With a `**kwargs` parameter everything is accepted."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return dict(kwargs), []
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(kwargs), []
    accepted = {k: v for k, v in kwargs.items() if k in params}
    return accepted, [k for k in kwargs if k not in params]


def has_param(fn: Callable[..., Any], name: str) -> bool:
    try:
        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def to_int16_mono(audio: Any) -> np.ndarray:
    """Tensor / ndarray in any of (T,), (T, C), (C, T); int16 or float (±1 or ±32767 scale) → mono int16."""
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    arr = np.asarray(audio)
    if arr.ndim == 2 and min(arr.shape) == 1:
        arr = arr.reshape(-1)
    elif arr.ndim == 2:
        # Channels are the short axis.
        arr = arr.mean(axis=0 if arr.shape[0] < arr.shape[1] else 1)
    elif arr.ndim != 1:
        arr = arr.reshape(-1)
    if arr.dtype == np.int16:
        return arr
    arr = arr.astype(np.float32)
    peak = float(np.max(np.abs(arr))) if arr.size else 0.0
    if peak <= 1.5:
        arr = arr * 32767.0
    return np.clip(np.round(arr), -32768, 32767).astype(np.int16)


def pcm_from_output(output: Any) -> Optional[tuple[int, np.ndarray]]:
    """Upstream IndexTTS2 returns `(sampling_rate, wav_int16_numpy)` when `output_path=None`."""
    if isinstance(output, (tuple, list)) and len(output) == 2 and isinstance(output[0], (int, np.integer)):
        try:
            return int(output[0]), to_int16_mono(output[1])
        except (TypeError, ValueError):
            return None
    return None


def read_wav(path: str) -> tuple[int, np.ndarray]:
    try:
        import soundfile as sf  # IndexTTS envs usually have it (librosa dependency)

        data, rate = sf.read(path, dtype="int16", always_2d=False)
        return int(rate), to_int16_mono(data)
    except ImportError:
        with wave.open(path, "rb") as w:
            if w.getsampwidth() != 2:
                raise ValueError(f"{path}: {w.getsampwidth() * 8}-bit wav, install soundfile to read it")
            frames = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
            channels = w.getnchannels()
            if channels > 1:
                frames = frames.reshape(-1, channels)
            return w.getframerate(), to_int16_mono(frames)


class ProgressHook:
    """Stands in for the Gradio progress object IndexTTS2 reports to (`tts.gr_progress`)."""

    def __init__(self) -> None:
        self.should_abort: Callable[[], bool] = lambda: False

    def _check(self) -> None:
        if self.should_abort():
            raise SynthesisAborted()

    def __call__(self, *args: Any, **kwargs: Any) -> None:
        self._check()

    def tqdm(self, iterable: Any, *args: Any, **kwargs: Any):  # gr.Progress().tqdm(...) compatibility
        for item in iterable:
            self._check()
            yield item


def patch_diffusion(tts: Any, steps: Optional[int], cfg_rate: Optional[float]) -> Optional[str]:
    """Overrides the s2mel CFM's `n_timesteps` / `inference_cfg_rate`. Returns where it was patched, or None."""
    if steps is None and cfg_rate is None:
        return None
    models = getattr(getattr(tts, "s2mel", None), "models", None)
    cfm = None
    if models is not None:
        try:
            cfm = models["cfm"]
        except (KeyError, TypeError, IndexError):
            cfm = getattr(models, "cfm", None)
    inference = getattr(cfm, "inference", None)
    if inference is None:
        return None
    try:
        sig = inspect.signature(inference)
    except (TypeError, ValueError):
        return None
    if steps is not None and "n_timesteps" not in sig.parameters:
        return None

    @functools.wraps(inference)
    def patched(*args: Any, **kwargs: Any) -> Any:
        bound = sig.bind_partial(*args, **kwargs)
        if steps is not None:
            bound.arguments["n_timesteps"] = steps
        if cfg_rate is not None and "inference_cfg_rate" in sig.parameters:
            bound.arguments["inference_cfg_rate"] = cfg_rate
        return inference(*bound.args, **bound.kwargs)

    cfm.inference = patched
    return "s2mel.models['cfm'].inference"


class IndexTtsEngine:
    """The real model. Construct once; `synthesize` is called from the single worker thread only."""

    def __init__(self, cfg: EngineConfig):
        self.cfg = cfg
        for voice, path in cfg.voices.items():
            if not os.path.isfile(path):
                raise FileNotFoundError(f"reference audio of voice {voice!r} not found: {path}")
        self.voices = sorted(cfg.voices)
        self.default_voice = cfg.default_voice
        # Voice whose speaker conditioning IndexTTS2 holds: it caches only the last reference path.
        self.loaded_voice: Optional[str] = None
        # Same import setup as webui.py, which runs from the IndexTTS root (relative paths inside).
        for p in (cfg.indextts_dir, os.path.join(cfg.indextts_dir, "indextts")):
            if p not in sys.path:
                sys.path.append(p)
        os.chdir(cfg.indextts_dir)

        if not os.path.isdir(cfg.model_dir):
            raise FileNotFoundError(
                f"model dir not found: {cfg.model_dir} (set TTS_MODEL_DIR to the WebUI --model_dir)"
            )
        # webui.py writes/downloads config.yaml into the model dir before loading; do the same.
        try:
            from indextts.utils.model_download import ensure_config_available
        except ImportError:
            ensure_config_available = None
        if ensure_config_available is not None:
            ensure_config_available(cfg.model_dir, version=cfg.version)
        if not os.path.isfile(os.path.join(cfg.model_dir, "config.yaml")):
            raise FileNotFoundError(
                f"config.yaml not found in {cfg.model_dir}; set TTS_MODEL_DIR to the directory the WebUI uses"
                " (its --model_dir, default <IndexTTS>/checkpoints)"
            )

        import torch

        self._torch = torch
        if cfg.version == "2.5":
            from indextts.infer_v2_5 import IndexTTS2
        else:
            from indextts.infer_v2 import IndexTTS2

        kwargs: dict[str, Any] = dict(
            model_dir=cfg.model_dir,
            cfg_path=os.path.join(cfg.model_dir, "config.yaml"),
            use_deepspeed=cfg.use_deepspeed,
            use_cuda_kernel=cfg.use_cuda_kernel,
            use_accel=cfg.use_accel,
            use_torch_compile=cfg.use_torch_compile,
            use_qwen_emo=cfg.use_qwen_emo,
        )
        self.precision = "fp32"
        if cfg.version == "2.5":
            bf16 = cfg.half and torch.cuda.is_available() and torch.cuda.is_bf16_supported()
            if cfg.half and not bf16:
                log.warning("BF16 unsupported on this device, IndexTTS 2.5 runs in full precision")
            kwargs["use_bf16"] = bf16
            self.precision = "bf16" if bf16 else "fp32"
        else:
            kwargs["use_fp16"] = cfg.half
            self.precision = "fp16" if cfg.half else "fp32"
        accepted, dropped = filter_kwargs(IndexTTS2.__init__, kwargs)
        if dropped:
            log.warning("IndexTTS2() does not accept %s; ignored", dropped)
        started = time.perf_counter()
        self.tts = IndexTTS2(**accepted)
        self.load_ms = (time.perf_counter() - started) * 1000
        log.info("IndexTTS2 v%s loaded in %.0f ms (%s, %s)", cfg.version, self.load_ms, self.precision, accepted)

        self._progress = ProgressHook()
        self.tts.gr_progress = self._progress
        self._infer = self.tts.infer
        self.infer_params = self._describe_infer()

        self.diffusion: dict[str, Any] = {"steps": None, "cfg_rate": None, "via": None}
        self._infer_extra: dict[str, Any] = {}
        if cfg.diffusion_steps is not None or cfg.cfg_rate is not None:
            if has_param(self._infer, "diffusion_steps"):
                if cfg.diffusion_steps is not None:
                    self._infer_extra["diffusion_steps"] = cfg.diffusion_steps
                if cfg.cfg_rate is not None and has_param(self._infer, "inference_cfg_rate"):
                    self._infer_extra["inference_cfg_rate"] = cfg.cfg_rate
                via = "infer()"
            else:
                via = patch_diffusion(self.tts, cfg.diffusion_steps, cfg.cfg_rate)
            if via:
                self.diffusion = {"steps": cfg.diffusion_steps, "cfg_rate": cfg.cfg_rate, "via": via}
                log.info("diffusion overridden via %s: steps=%s cfg_rate=%s", via, cfg.diffusion_steps, cfg.cfg_rate)
            else:
                log.warning(
                    "TTS_DIFFUSION_STEPS/TTS_CFG_RATE set but this IndexTTS build exposes neither an infer() "
                    "parameter nor s2mel.models['cfm'].inference(n_timesteps); using the model's built-in values"
                )

        self._tmpdir = tempfile.mkdtemp(prefix="ptoy-tts-")
        self.output_mode = "file" if cfg.output_mode == "file" else "memory"
        self.sample_rate = 22050
        self._warmup()

    def _describe_infer(self) -> dict[str, Any]:
        try:
            sig = inspect.signature(self._infer)
        except (TypeError, ValueError):
            return {"signature": "unknown"}
        log.info("IndexTTS2.infer%s", sig)
        return {
            "signature": str(sig),
            "output_path_optional": "output_path" in sig.parameters
            and sig.parameters["output_path"].default is not inspect.Parameter.empty,
            "stream_return": "stream_return" in sig.parameters,
            "diffusion_steps": "diffusion_steps" in sig.parameters,
        }

    def _warmup(self) -> None:
        """First call: fills the speaker-reference caches (keyed by the prompt path) and CUDA kernels;
        in `auto` mode also decides whether `infer` can return audio in memory."""
        started = time.perf_counter()
        if self.cfg.output_mode == "auto":
            try:
                self.output_mode = "memory"
                self.synthesize(self.cfg.warmup_text, None, 1.0, lambda: False)
            except SynthesisAborted:
                raise
            except Exception as exc:  # noqa: BLE001 - e.g. this fork insists on an output path
                log.info("infer(output_path=None) unusable (%s: %s); using temp wav files", type(exc).__name__, exc)
                self.output_mode = "file"
                self.synthesize(self.cfg.warmup_text, None, 1.0, lambda: False)
        else:
            self.synthesize(self.cfg.warmup_text, None, 1.0, lambda: False)
        self.warmup_ms = (time.perf_counter() - started) * 1000
        log.info("warm-up done in %.0f ms (output via %s, %d Hz)", self.warmup_ms, self.output_mode, self.sample_rate)

    def _infer_kwargs(
        self, text: str, emo_vector: Optional[list[float]], emo_alpha: float, output_path: Optional[str],
        generation: Optional[dict[str, Any]] = None, voice: Optional[str] = None, speed: float = 1.0,
    ) -> dict[str, Any]:
        vec = None
        if emo_vector is not None:
            normalize = getattr(self.tts, "normalize_emo_vec", None)
            vec = normalize(list(emo_vector), apply_bias=True) if normalize else list(emo_vector)
        kwargs: dict[str, Any] = dict(
            # A fixed path per voice: IndexTTS2 caches the speaker conditioning of the last path it saw.
            spk_audio_prompt=self.cfg.voices[voice or self.cfg.default_voice],
            text=text,
            output_path=output_path,
            emo_audio_prompt=None,
            emo_alpha=emo_alpha,
            emo_vector=vec,
            use_emo_text=False,
            emo_text=None,
            use_random=False,
            verbose=False,
            max_text_tokens_per_segment=self.cfg.max_text_tokens_per_segment,
            **{**self.cfg.generation, **(generation or {})},
            **self._infer_extra,
        )
        if self.cfg.version == "2.5":
            kwargs["lang"] = self.cfg.language
            # duration_factor scales the generated length: speaking faster is a shorter one.
            kwargs["duration_factor"] = self.cfg.duration_factor / speed
        elif speed != 1.0 and not getattr(self, "_warned_speed", False):
            log.warning("IndexTTS2 v%s has no duration_factor; per-request speed ignored", self.cfg.version)
            self._warned_speed = True
        top_k = kwargs.get("top_k")
        if isinstance(top_k, int) and top_k <= 0:
            kwargs["top_k"] = None  # same as gen_single()
        accepted, dropped = filter_kwargs(self._infer, kwargs)
        if dropped and not getattr(self, "_warned_dropped", False):
            log.warning("IndexTTS2.infer() does not accept %s; ignored", dropped)
            self._warned_dropped = True
        return accepted

    def synthesize(
        self, text: str, emo_vector: Optional[list[float]], emo_alpha: float, should_abort: Callable[[], bool],
        generation: Optional[dict[str, Any]] = None, voice: Optional[str] = None, speed: float = 1.0,
    ) -> np.ndarray:
        voice = voice or self.cfg.default_voice
        if voice not in self.cfg.voices:
            raise ValueError(f"unknown voice {voice!r}")
        self._progress.should_abort = should_abort if self.cfg.abort_running else (lambda: False)
        # Set before inferring: an aborted synthesis may already have replaced the cached reference.
        self.loaded_voice = voice
        try:
            if self.output_mode == "memory":
                output = self._infer(**self._infer_kwargs(text, emo_vector, emo_alpha, None, generation, voice, speed))
                parsed = pcm_from_output(output)
                if parsed is None:
                    raise _NotInMemory(type(output).__name__)
                self.sample_rate, pcm = parsed
                return pcm
            path = os.path.join(self._tmpdir, f"{uuid.uuid4().hex}.wav")
            try:
                output = self._infer(**self._infer_kwargs(text, emo_vector, emo_alpha, path, generation, voice, speed))
                if not os.path.isfile(path) and isinstance(output, str) and os.path.isfile(output):
                    path = output
                self.sample_rate, pcm = read_wav(path)
                return pcm
            finally:
                if os.path.isfile(path):
                    os.remove(path)
        finally:
            self._progress.should_abort = lambda: False

    def info(self) -> dict[str, Any]:
        info: dict[str, Any] = {
            "model": f"IndexTTS2 v{self.cfg.version}",
            "precision": self.precision,
            "sample_rate": self.sample_rate,
            "output_mode": self.output_mode,
            "voices": self.voices,
            "default_voice": self.default_voice,
            "loaded_voice": self.loaded_voice,
            "qwen_emo": self.cfg.use_qwen_emo,
            "diffusion": self.diffusion,
            "generation": self.cfg.generation,
            "infer": self.infer_params,
            "load_ms": round(self.load_ms),
            "warmup_ms": round(getattr(self, "warmup_ms", 0)),
        }
        torch = self._torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            info["vram_mib"] = {
                "allocated": round(torch.cuda.memory_allocated() / 2**20),
                "reserved": round(torch.cuda.memory_reserved() / 2**20),
                "peak_allocated": round(torch.cuda.max_memory_allocated() / 2**20),
                "device_used": round((total - free) / 2**20),
                "device_total": round(total / 2**20),
            }
        return info


class _NotInMemory(Exception):
    """`infer(output_path=None)` did not return `(sample_rate, audio)`."""
