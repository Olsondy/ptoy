"""语音通话链路 GPU 压测：在 Windows GPU 主机上运行。

测三件事：
  1. LLM（llama-server）首 token 延迟、生成速度、思考模式是否已关闭
  2. TTS（IndexTTS Gradio WebUI /gen_single）整句合成耗时、音频时长、实时率
  3. LLM 与 TTS 并发时上述指标的退化程度，以及显存峰值

用法：
  只测 LLM（标准库即可）：
    python bench_gpu.py --llm-url http://127.0.0.1:8080
  LLM + TTS（需要 gradio_client，在 indextts 的 conda 环境里运行）：
    python bench_gpu.py --llm-url http://127.0.0.1:8080 --tts-url http://127.0.0.1:7860 --tts-ref D:\voice\ref.wav

/gen_single 只在整句合成完后返回 wav 文件，没有流式输出，所以“首包延迟 = 整句合成耗时”。
"""

import argparse
import json
import statistics
import subprocess
import threading
import time
import urllib.request
import wave

LLM_PROMPT = "用两三句话安慰一个刚丢了钱包、有点沮丧的朋友。"
TTS_TEXTS = {
    "短句": "别着急，我们一起想想办法。",
    "中句": "钱包丢了确实让人难受，不过先别慌，我们一步一步来，先挂失银行卡吧。",
}


class GpuSampler(threading.Thread):
    """每 200ms 采样一次 nvidia-smi，记录显存与利用率峰值。"""

    def __init__(self):
        super().__init__(daemon=True)
        self.stop_event = threading.Event()
        self.peak_mem = 0
        self.total_mem = 0
        self.peak_util = 0

    def run(self):
        while not self.stop_event.is_set():
            try:
                out = subprocess.check_output(
                    [
                        "nvidia-smi",
                        "--query-gpu=memory.used,memory.total,utilization.gpu",
                        "--format=csv,noheader,nounits",
                    ],
                    text=True,
                )
                used, total, util = (int(x) for x in out.strip().splitlines()[0].split(","))
                self.peak_mem = max(self.peak_mem, used)
                self.total_mem = total
                self.peak_util = max(self.peak_util, util)
            except (OSError, subprocess.CalledProcessError, ValueError):
                pass
            time.sleep(0.2)


def call_llm(base_url, model=None):
    """流式调用 llama-server，返回 ttft_ms / tok_per_s / thinking_leaked / text。"""
    body = {
        **({"model": model} if model else {}),
        "messages": [{"role": "user", "content": LLM_PROMPT}],
        "stream": True,
        "max_tokens": 150,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    start = time.perf_counter()
    ttft = None
    chunks = 0
    text = ""
    thinking_leaked = False
    timings = None
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            data = json.loads(payload)
            timings = data.get("timings") or timings
            delta = (data.get("choices") or [{}])[0].get("delta", {})
            if delta.get("reasoning_content"):
                thinking_leaked = True
            content = delta.get("content")
            if content:
                if ttft is None:
                    ttft = (time.perf_counter() - start) * 1000
                chunks += 1
                text += content
    elapsed = time.perf_counter() - start
    if "<think>" in text:
        thinking_leaked = True
    if timings and timings.get("predicted_per_second"):
        tps = timings["predicted_per_second"]
    else:
        tps = chunks / max(elapsed - (ttft or 0) / 1000, 1e-6)
    return {"ttft_ms": ttft, "tok_per_s": tps, "thinking_leaked": thinking_leaked, "text": text}


class TtsClient:
    """调用 IndexTTS WebUI 的 /gen_single，情感跟随音色参考音频，其余参数用 WebUI 默认值。"""

    def __init__(self, url, ref_path):
        from gradio_client import Client, handle_file

        self.client = Client(url, verbose=False)
        self.ref = handle_file(ref_path)

    def synth(self, text):
        start = time.perf_counter()
        result = self.client.predict(
            emo_control_method="与音色参考音频相同",
            prompt=self.ref,
            text=text,
            lang_choice="ZH",
            emo_ref_path=None,
            api_name="/gen_single",
        )
        total_ms = (time.perf_counter() - start) * 1000
        path = result.get("value") if isinstance(result, dict) else result
        with wave.open(path, "rb") as w:
            audio_ms = w.getnframes() / w.getframerate() * 1000
        return {"total_ms": total_ms, "audio_ms": audio_ms, "rtf": total_ms / audio_ms}


def run_concurrent(llm_url, tts, model=None):
    """LLM 生成的同时发起 TTS，模拟真实流水线。"""
    results = {}

    def llm_job():
        results["llm"] = call_llm(llm_url, model)

    t = threading.Thread(target=llm_job)
    t.start()
    time.sleep(0.3)  # 让 LLM 先进入生成阶段，再压上 TTS
    results["tts"] = tts.synth(TTS_TEXTS["短句"])
    t.join()
    return results


def median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else float("nan")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--llm-url", default="http://127.0.0.1:8080")
    parser.add_argument("--model", default=None, help="llama-server 路由模式下的模型名（见 /v1/models）")
    parser.add_argument("--tts-url", default=None, help="IndexTTS WebUI 地址，如 http://127.0.0.1:7860")
    parser.add_argument("--tts-ref", default=None, help="音色参考音频（本机 wav 路径）")
    parser.add_argument("--rounds", type=int, default=3)
    args = parser.parse_args()
    if args.tts_url and not args.tts_ref:
        parser.error("--tts-url 需要同时提供 --tts-ref")
    tts = TtsClient(args.tts_url, args.tts_ref) if args.tts_url else None

    sampler = GpuSampler()
    sampler.start()

    print("预热 ...")
    call_llm(args.llm_url, args.model)
    if tts:
        tts.synth(TTS_TEXTS["短句"])

    print(f"\n[1] LLM 单独运行 × {args.rounds}")
    solo_llm = [call_llm(args.llm_url, args.model) for _ in range(args.rounds)]
    print(f"  首 token: {median([r['ttft_ms'] for r in solo_llm]):.0f} ms")
    print(f"  生成速度: {median([r['tok_per_s'] for r in solo_llm]):.1f} tok/s")
    if any(r["thinking_leaked"] for r in solo_llm):
        print("  [警告] 检测到思考内容输出：思考模式没关掉，检查 llama-server 是否带 --jinja，或改用 --reasoning-budget 0")
    print(f"  样例回复: {solo_llm[-1]['text'][:80]}")

    if tts:
        print(f"\n[2] TTS 单独运行 × {args.rounds}（首包延迟 = 合成耗时）")
        for label, text in TTS_TEXTS.items():
            runs = [tts.synth(text) for _ in range(args.rounds)]
            print(
                f"  {label}({len(text)}字): 合成 {median([r['total_ms'] for r in runs]):.0f} ms"
                f" / 音频 {median([r['audio_ms'] for r in runs]):.0f} ms"
                f" / RTF {median([r['rtf'] for r in runs]):.2f}"
            )

        print(f"\n[3] LLM + TTS(短句) 并发 × {args.rounds}")
        conc = [run_concurrent(args.llm_url, tts, args.model) for _ in range(args.rounds)]
        print(f"  LLM 首 token: {median([r['llm']['ttft_ms'] for r in conc]):.0f} ms")
        print(f"  LLM 生成速度: {median([r['llm']['tok_per_s'] for r in conc]):.1f} tok/s")
        print(f"  TTS 合成: {median([r['tts']['total_ms'] for r in conc]):.0f} ms")
        print(f"  TTS RTF: {median([r['tts']['rtf'] for r in conc]):.2f}")

    sampler.stop_event.set()
    sampler.join(timeout=1)
    print("\n[GPU]")
    print(f"  显存峰值: {sampler.peak_mem} / {sampler.total_mem} MiB（余量 {sampler.total_mem - sampler.peak_mem} MiB，建议 ≥ 1024）")
    print(f"  利用率峰值: {sampler.peak_util}%")


if __name__ == "__main__":
    main()
