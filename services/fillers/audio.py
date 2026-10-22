"""语气词音频后处理：重采样、去首尾静音、峰值归一化。纯 numpy，不依赖服务。"""

import numpy as np

TARGET_RATE = 48000  # LiveKit 原生采样率，播放时不用再重采样
FRAME_MS = 10
SILENCE_DB = -45.0  # 帧 RMS 低于（峰值 + 此值）视为静音
LEAD_PAD_MS = 10  # 首部保留的静音：越短越好，直接计入首包延迟
TAIL_PAD_MS = 40  # 尾部保留一点，避免切掉尾音的自然衰减
FADE_IN_MS = 5
FADE_OUT_MS = 20
PEAK_DBFS = -3.0


def to_mono(audio):
    audio = np.asarray(audio, dtype=np.float64)
    return audio.mean(axis=1) if audio.ndim == 2 else audio


def resample(audio, src_rate, dst_rate=TARGET_RATE):
    """FFT 重采样（带限插值）。片段只有一两秒，整段做 FFT 足够快。"""
    if src_rate == dst_rate or len(audio) == 0:
        return audio
    n = len(audio)
    m = int(round(n * dst_rate / src_rate))
    spectrum = np.fft.rfft(audio)
    out = np.zeros(m // 2 + 1, dtype=complex)
    k = min(len(spectrum), len(out))
    out[:k] = spectrum[:k]
    return np.fft.irfft(out, m) * (m / n)


def voiced_bounds(audio, rate, silence_db=SILENCE_DB):
    """返回首个和最后一个非静音帧的样本区间 [start, end)；全静音返回 None。"""
    frame = max(1, rate * FRAME_MS // 1000)
    n_frames = len(audio) // frame
    if n_frames == 0:
        return None
    frames = audio[: n_frames * frame].reshape(n_frames, frame)
    rms = np.sqrt(np.mean(frames**2, axis=1))
    peak = np.max(np.abs(audio))
    if peak == 0:
        return None
    threshold = peak * 10 ** (silence_db / 20)
    voiced = np.nonzero(rms > threshold)[0]
    if len(voiced) == 0:
        return None
    return voiced[0] * frame, min(len(audio), (voiced[-1] + 1) * frame)


def trim_silence(audio, rate):
    bounds = voiced_bounds(audio, rate)
    if bounds is None:
        raise ValueError("音频全是静音")
    start, end = bounds
    start = max(0, start - rate * LEAD_PAD_MS // 1000)
    end = min(len(audio), end + rate * TAIL_PAD_MS // 1000)
    return audio[start:end]


def fade(audio, rate):
    audio = audio.copy()
    n_in = min(len(audio), rate * FADE_IN_MS // 1000)
    n_out = min(len(audio), rate * FADE_OUT_MS // 1000)
    audio[:n_in] *= np.linspace(0.0, 1.0, n_in)
    audio[len(audio) - n_out :] *= np.linspace(1.0, 0.0, n_out)
    return audio


def normalize_peak(audio, peak_dbfs=PEAK_DBFS):
    peak = np.max(np.abs(audio))
    return audio if peak == 0 else audio * (10 ** (peak_dbfs / 20) / peak)


def to_pcm16(audio):
    return np.round(np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)


def process(audio, rate):
    """TTS 原始输出 → 48kHz 单声道 int16，去掉首尾静音并归一化峰值。"""
    audio = resample(to_mono(audio), rate)
    audio = trim_silence(audio, TARGET_RATE)
    audio = fade(audio, TARGET_RATE)
    return to_pcm16(normalize_peak(audio))


def edge_silence_ms(pcm, rate):
    """处理后首尾残留的静音时长（ms），用于验证。"""
    audio = pcm.astype(np.float64) / 32768
    bounds = voiced_bounds(audio, rate)
    if bounds is None:
        return len(audio) * 1000 / rate, 0.0
    start, end = bounds
    return start * 1000 / rate, (len(audio) - end) * 1000 / rate
