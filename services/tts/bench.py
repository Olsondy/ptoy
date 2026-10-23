"""IndexTTS FastAPI service benchmark: synthesis time vs text length, cancel latency, VRAM.

Run on the Windows GPU host against a running `server.py` (standard library only):
  python services\\tts\\bench.py --url http://127.0.0.1:8002
  python services\\tts\\bench.py --label steps10 --save-wavs bench_out\\steps10   (after restarting with TTS_DIFFUSION_STEPS=10)

Prints per-length medians, a least-squares fit `synthesis ≈ fixed + per_char × chars`
(Gradio baseline: 770 ms + 89 ms/char, docs/architecture/server.md §6) and how fast a
cancelled long synthesis frees the GPU. `--json` appends the raw results to a file.
"""

import argparse
import json
import os
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "bench"))
from bench_gpu import GpuSampler  # noqa: E402

GRADIO_FIXED_MS = 770
GRADIO_PER_CHAR_MS = 89

# Typical segments: short first segments (segmenter cuts at the first comma) up to 40-char sentences.
TEXTS = [
    "好呀，",
    "我想想，",
    "没问题呀，",
    "别着急，我们一起",
    "别着急，我们一起想想办法。",
    "今天天气挺好的，要不要出去走走？",
    "钱包丢了确实让人难受，不过先别慌，我们一步一步来。",
    "钱包丢了确实让人难受，不过先别慌，我们一步一步来，先挂失银行卡吧。",
    "我刚才查了一下，附近有三家银行营业到晚上八点，最近的那家走过去大概十分钟，要不要我陪你一起过去？",
]
LONG_TEXT = TEXTS[-1]


def post_tts(base, text, emotion=None, request_id=None, timeout=120):
    body = {"text": text, "request_id": request_id or uuid.uuid4().hex}
    if emotion:
        body["emotion"] = emotion
    req = urllib.request.Request(
        f"{base}/tts", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = res.read()
            headers = res.headers
            status = res.status
    except urllib.error.HTTPError as err:
        return {"status": err.code, "total_ms": (time.perf_counter() - start) * 1000, "error": err.read().decode()}
    total_ms = (time.perf_counter() - start) * 1000
    rate = int(headers["X-Sample-Rate"])
    return {
        "status": status,
        "chars": len(text),
        "total_ms": total_ms,
        "synth_ms": float(headers.get("X-Synth-Ms", "nan")),
        "queue_ms": float(headers.get("X-Queue-Ms", "nan")),
        "audio_ms": len(data) / 2 / rate * 1000,
        "rate": rate,
        "pcm": data,
    }


def get_json(url):
    with urllib.request.urlopen(url, timeout=10) as res:
        return json.loads(res.read())


def fit(points):
    """Least squares y = a + b·x."""
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else float("nan")
    return my - b * mx, b


def save_wav(path, pcm, rate):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def cancel_test(base):
    """Starts the long text, cancels it after 300 ms, then times a short request."""
    request_id = uuid.uuid4().hex
    long_result = {}
    t = threading.Thread(target=lambda: long_result.update(post_tts(base, LONG_TEXT, request_id=request_id)))
    t.start()
    time.sleep(0.3)
    cancelled_at = time.perf_counter()
    req = urllib.request.Request(f"{base}/cancel/{request_id}", data=b"", method="POST")
    with urllib.request.urlopen(req, timeout=10) as res:
        state = json.loads(res.read())["state"]
    short = post_tts(base, TEXTS[0])
    short_done_ms = (time.perf_counter() - cancelled_at) * 1000
    t.join()
    return {
        "cancel_state": state,
        "long_status": long_result.get("status"),
        "long_returned_ms": long_result.get("total_ms"),
        "short_after_cancel_ms": short_done_ms,
        "short_queue_ms": short.get("queue_ms"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8002")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--emotion", default=None, help="情绪名（喜/怒/哀/…），默认跟随音色参考音频")
    parser.add_argument("--label", default="", help="本轮配置名，如 steps10，写进 --json 结果")
    parser.add_argument("--save-wavs", default=None, help="把每个长度的最后一次合成存成 wav，用来听音质")
    parser.add_argument("--json", default=None, help="把结果追加写入此文件（一行一个 JSON）")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    health = get_json(f"{base}/health")
    print(f"服务: {health.get('model')} · {health.get('precision')} · {health.get('sample_rate')} Hz · "
          f"输出 {health.get('output_mode')} · 扩散 {health.get('diffusion')}")
    sampler = GpuSampler()
    sampler.start()

    print("预热 ...")
    post_tts(base, TEXTS[4], args.emotion)

    print(f"\n[1] 合成耗时 vs 字数 × {args.rounds}")
    rows, points = [], []
    if args.save_wavs:
        os.makedirs(args.save_wavs, exist_ok=True)
    for i, text in enumerate(TEXTS):
        runs = [post_tts(base, text, args.emotion) for _ in range(args.rounds)]
        bad = [r for r in runs if r["status"] != 200]
        if bad:
            print(f"  {len(text)}字: 失败 {bad[0]}")
            continue
        points += [(len(text), r["total_ms"]) for r in runs]
        row = {
            "chars": len(text),
            "total_ms": statistics.median(r["total_ms"] for r in runs),
            "synth_ms": statistics.median(r["synth_ms"] for r in runs),
            "audio_ms": statistics.median(r["audio_ms"] for r in runs),
        }
        row["rtf"] = row["total_ms"] / row["audio_ms"] if row["audio_ms"] else float("nan")
        gradio = GRADIO_FIXED_MS + GRADIO_PER_CHAR_MS * len(text)
        rows.append(row)
        print(f"  {len(text):>3}字: 总 {row['total_ms']:6.0f} ms（服务端 {row['synth_ms']:6.0f}）"
              f" / 音频 {row['audio_ms']:6.0f} ms / RTF {row['rtf']:.2f} · Gradio 模型 {gradio} ms")
        if args.save_wavs:
            save_wav(os.path.join(args.save_wavs, f"{i:02d}_{len(text)}chars.wav"), runs[-1]["pcm"], runs[-1]["rate"])

    fixed, per_char = fit(points) if len(points) > 1 else (float("nan"), float("nan"))
    print(f"\n  拟合: 合成耗时 ≈ {fixed:.0f} ms + {per_char:.1f} ms × 字数"
          f"（Gradio: {GRADIO_FIXED_MS} ms + {GRADIO_PER_CHAR_MS} ms × 字数）")

    print("\n[2] 取消：长句开始 300ms 后取消，紧接着发一条短句")
    cancel = cancel_test(base)
    print(f"  取消时状态 {cancel['cancel_state']}，长句请求 {cancel['long_status']}（{cancel['long_returned_ms']:.0f} ms 后返回）")
    print(f"  取消 → 短句完成 {cancel['short_after_cancel_ms']:.0f} ms（短句排队 {cancel['short_queue_ms']:.0f} ms；"
          "排队接近 0 说明进行中的合成被及时中止）")

    sampler.stop_event.set()
    sampler.join(timeout=1)
    health = get_json(f"{base}/health")
    print("\n[GPU]")
    print(f"  显存峰值（nvidia-smi，整卡）: {sampler.peak_mem} / {sampler.total_mem} MiB，余量 {sampler.total_mem - sampler.peak_mem} MiB")
    if health.get("vram_mib"):
        print(f"  本进程 torch: {health['vram_mib']}")

    if args.json:
        with open(args.json, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "label": args.label, "time": time.strftime("%Y-%m-%d %H:%M:%S"), "service": health,
                "rows": rows, "fit": {"fixed_ms": fixed, "per_char_ms": per_char}, "cancel": cancel,
                "gpu": {"peak_mib": sampler.peak_mem, "total_mib": sampler.total_mem},
            }, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
