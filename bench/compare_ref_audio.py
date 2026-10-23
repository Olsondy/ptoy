"""参考音频 / 采样参数 A/B 试听：用同一组小悠的典型回复，分别配几段候选参考音频、几组采样参数合成，生成对比试听页。

每条回复合成两种版本：
  - whole：整段一次合成（语调连贯，代表 IndexTTS2 的上限）
  - segmented：按 Agent 的分段方式切开逐段合成再拼接（首段切在第一个逗号，之后按句切；
    段间不加静音），代表通话里实际听到的样子
两者对比能听出分段对自然度的影响；不同参考音频之间对比能听出参考音频的影响。
分段版每段是独立采样，段与段之间的音色、语调起伏就是通话里“跳”的来源，调采样参数主要听它。

后端：
  - gradio（默认）：IndexTTS WebUI，参考音频由 --refs 上传
  - fastapi：services/tts 服务，参考音频是服务端音色目录里的音色，--voices 选几个对比（不填用默认音色），
    采样参数按请求覆盖（`generation` 字段），不用重启服务

用法（标准库即可，Mac 经局域网或 Windows 本机都能跑）：
  python bench/compare_ref_audio.py --tts-url http://127.0.0.1:7860 --refs D:\\voice\\a.wav D:\\voice\\b.wav
  python bench/compare_ref_audio.py --tts-url http://192.168.31.82:7860 --refs ~/voices/ --out /tmp/ref-ab
  python bench/compare_ref_audio.py --backend fastapi --tts-url http://192.168.31.82:8002 \
      --sweep temperature=0.8,0.6,0.4 --sweep top_p=0.8,0.6
  python bench/compare_ref_audio.py --backend fastapi --tts-url http://192.168.31.82:8002 --voices chunqing wenrou
  只要整段版（省一半时间）：加 --no-segmented；自定义台词：--texts lines.txt（一行一条）
  --sweep 可重复，多个参数取笛卡尔积，每种组合一列；可扫 temperature / top_p / top_k / repetition_penalty

结果写到 --out（默认 bench/out/ref-ab/），用浏览器打开其中的 index.html 试听。
情感跟随参考音频（与 Agent 的 TTS_EMOTION_CONTROL=reference 一致），未扫的参数用后端自己的默认值。
"""

import argparse
import html
import itertools
import json
import mimetypes
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
from pathlib import Path

SWEEPABLE = {"temperature": float, "top_p": float, "top_k": int, "repetition_penalty": float}

API_NAME = "gen_single"
EMO_SAME_AS_REFERENCE = "与音色参考音频相同"

# 小悠的典型回复：寒暄、关心、开心、安慰、追问，长短都有。
DEFAULT_TEXTS = [
    "诶，你来啦！今天过得怎么样呀？",
    "哈哈，真的假的？那也太巧了吧，后来呢？",
    "哎呀，听起来你今天挺累的，要不先歇会儿，喝点热水。",
    "没事没事，谁都有搞砸的时候嘛，下次注意就好啦。",
    "嗯，我明白你的意思，你是觉得他没把你的话当回事，对吧？",
]

COMMA_OR_END = re.compile(r"[，、,。！？；!?;…]+")
SENTENCE_END = re.compile(r"[。！？；!?;…]+[”’\"')）]*")
CONTENT = re.compile(r"[\w]", re.UNICODE)


def split_like_agent(text):
    """近似 @ptoy/segmenter 的默认切法：首段在第一个逗号/句末切（实义字少于 2 个则并入下一小句），其余按句切。"""
    segments = []
    rest = text
    for m in COMMA_OR_END.finditer(text):
        head = text[: m.end()]
        if len(CONTENT.findall(head)) >= 2:
            segments.append(head.strip())
            rest = text[m.end():]
            break
    else:
        return [text.strip()]
    start = 0
    for m in SENTENCE_END.finditer(rest):
        piece = rest[start:m.end()].strip()
        if piece:
            segments.append(piece)
        start = m.end()
    tail = rest[start:].strip()
    if CONTENT.search(tail):
        segments.append(tail)
    elif tail and segments:
        segments[-1] += tail
    return segments


class GradioTts:
    """IndexTTS WebUI 的 Gradio REST API（/gradio_api/...），与 apps/agent/src/tts/gradio.ts 同一套调用。"""

    def __init__(self, url, timeout=120):
        self.base = url.rstrip("/")
        self.timeout = timeout
        self.params = self._parameters()

    def _open(self, req):
        return urllib.request.urlopen(req, timeout=self.timeout)

    def _parameters(self):
        with self._open(f"{self.base}/gradio_api/info") as resp:
            info = json.load(resp)
        params = info.get("named_endpoints", {}).get(f"/{API_NAME}", {}).get("parameters")
        if not params or not any(p.get("parameter_name") == "text" for p in params):
            sys.exit(f"{self.base} 上没有带 text 参数的 /{API_NAME} 接口，确认是 IndexTTS2 WebUI")
        return params

    def upload(self, path):
        boundary = uuid.uuid4().hex
        mime = mimetypes.guess_type(path.name)[0] or "audio/wav"
        body = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{path.name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(
            f"{self.base}/gradio_api/upload",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with self._open(req) as resp:
            return json.load(resp)[0]

    def synth(self, ref_server_path, text, generation):
        """返回 (wave params, PCM 帧)。"""
        overrides = {
            **generation,
            "emo_control_method": EMO_SAME_AS_REFERENCE,
            "prompt": {"path": ref_server_path, "meta": {"_type": "gradio.FileData"}},
            "text": text,
            "lang_choice": "ZH",
            "emo_ref_path": None,
        }
        data = [
            overrides[p["parameter_name"]]
            if p["parameter_name"] in overrides
            else (p.get("parameter_default") if p.get("parameter_has_default") else None)
            for p in self.params
        ]
        req = urllib.request.Request(
            f"{self.base}/gradio_api/call/{API_NAME}",
            data=json.dumps({"data": data}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with self._open(req) as resp:
            event_id = json.load(resp)["event_id"]
        with self._open(f"{self.base}/gradio_api/call/{API_NAME}/{event_id}") as resp:
            stream = resp.read().decode()
        event = ""
        for line in stream.splitlines():
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:") and event in ("complete", "error"):
                if event == "error":
                    raise RuntimeError(f"IndexTTS 合成失败：{line[5:].strip()}")
                output = json.loads(line[5:].strip())[0]
                file = output if "path" in output else output.get("value")
                quoted = urllib.parse.quote(file["path"], safe="")
                with self._open(f"{self.base}/gradio_api/file={quoted}") as audio:
                    return read_wav(audio.read())
        raise RuntimeError("Gradio 结果流里没有 complete 事件")


class FastApiTts:
    """services/tts 的 POST /tts：参考音频是服务端音色目录里的音色（按 id 选），返回裸 s16le PCM。"""

    def __init__(self, url, timeout=120):
        self.base = url.rstrip("/")
        self.timeout = timeout
        with urllib.request.urlopen(f"{self.base}/health", timeout=timeout) as resp:
            self.health = json.load(resp)

    def synth(self, text, generation, voice=None):
        body = {"text": text, "emotion": "平静"}
        if voice:
            body["voice"] = voice
        if generation:
            body["generation"] = generation
        req = urllib.request.Request(
            f"{self.base}/tts", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                rate = int(resp.headers["X-Sample-Rate"])
                frames = resp.read()
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"TTS 服务返回 {e.code}：{e.read().decode(errors='replace')}") from None
        return wave._wave_params(1, 2, rate, len(frames) // 2, "NONE", "not compressed"), frames


def read_wav(data):
    import io

    with wave.open(io.BytesIO(data), "rb") as w:
        return w.getparams(), w.readframes(w.getnframes())


def write_wav(path, params, frames):
    with wave.open(str(path), "wb") as w:
        w.setparams(params)
        w.writeframes(frames)


def collect_refs(items):
    refs = []
    for item in items:
        p = Path(item).expanduser()
        if p.is_dir():
            refs += sorted(f for f in p.iterdir() if f.suffix.lower() in (".wav", ".mp3", ".flac"))
        elif p.is_file():
            refs.append(p)
        else:
            sys.exit(f"找不到参考音频：{item}")
    if not refs:
        sys.exit("没有可用的参考音频（支持 .wav / .mp3 / .flac）")
    return refs


def parse_sweeps(items):
    """["temperature=0.8,0.6", "top_p=0.8"] → [{"temperature": 0.8, "top_p": 0.8}, ...]（笛卡尔积）；不扫 → [{}]。"""
    axes = []
    for item in items or []:
        name, _, values = item.partition("=")
        name = name.strip()
        if name not in SWEEPABLE or not values:
            sys.exit(f"--sweep 格式是 参数=值1,值2，参数可选 {', '.join(SWEEPABLE)}：{item}")
        axes.append([(name, SWEEPABLE[name](v)) for v in values.split(",") if v.strip()])
    return [dict(combo) for combo in itertools.product(*axes)]


def variant_name(generation):
    return " ".join(f"{k}={v}" for k, v in generation.items()) or "默认参数"


def write_index(out, columns, texts, with_segmented):
    """columns: [{"dir", "title", "ref"(参考音频原声文件，可无)}]。"""
    rel = lambda p: html.escape(p.relative_to(out).as_posix())
    rows = []
    for i, text in enumerate(texts):
        cells = []
        for col in columns:
            d = col["dir"]
            players = [f'<div>整段</div><audio controls preload="none" src="{rel(d / f"{i + 1:02d}_whole.wav")}"></audio>']
            if with_segmented:
                players.append(
                    f'<div>分段</div><audio controls preload="none" src="{rel(d / f"{i + 1:02d}_segmented.wav")}"></audio>'
                )
            cells.append(f"<td>{''.join(players)}</td>")
        rows.append(f"<tr><th>{html.escape(text)}</th>{''.join(cells)}</tr>")
    refs_row = "".join(
        f'<td><audio controls preload="none" src="{rel(col["ref"])}"></audio></td>' if col.get("ref") else "<td>（服务端）</td>"
        for col in columns
    )
    header = "".join(f"<th><b>{html.escape(col['title'])}</b></th>" for col in columns)
    (out / "index.html").write_text(
        f"""<!doctype html><meta charset="utf-8"><title>参考音频 A/B</title>
<style>body{{font-family:system-ui,sans-serif;margin:24px}}table{{border-collapse:collapse}}
td,th{{border:1px solid #ccc;padding:8px;vertical-align:top;text-align:left}}th{{max-width:220px;font-weight:normal}}
audio{{width:240px;height:32px}}div{{font-size:12px;color:#666}}</style>
<h2>参考音频 A/B</h2>
<table><tr><th>台词</th>{header}</tr><tr><th>参考音频原声</th>{refs_row}</tr>{''.join(rows)}</table>
""",
        encoding="utf-8",
    )


def synth_line(synth, text, with_segmented):
    """synth(text) → (params, frames)。返回 [(文件后缀, params, frames)] 和日志。"""
    started = time.perf_counter()
    params, frames = synth(text)
    results = [("whole", params, frames)]
    line = f"整段 {(time.perf_counter() - started):.1f}s"
    if with_segmented:
        started = time.perf_counter()
        segments = split_like_agent(text)
        joined, first = b"", None
        for seg in segments:
            p, f = synth(seg)
            if first and (p.framerate, p.nchannels, p.sampwidth) != (first.framerate, first.nchannels, first.sampwidth):
                raise RuntimeError(f"分段音频格式不一致：{p} vs {first}")
            first = first or p
            joined += f
        results.append(("segmented", first, joined))
        line += f" | 分段 {(time.perf_counter() - started):.1f}s {' / '.join(segments)}"
    return results, line


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend", choices=("gradio", "fastapi"), default="gradio")
    parser.add_argument("--tts-url", required=True, help="WebUI 如 http://127.0.0.1:7860；FastAPI 服务如 http://127.0.0.1:8002")
    parser.add_argument("--refs", nargs="+", help="候选参考音频文件或目录（可混用）；gradio 必填，fastapi 不用")
    parser.add_argument("--voices", nargs="+", help="fastapi：服务端的候选音色 id（/health 的 voices），默认只用默认音色")
    parser.add_argument("--sweep", action="append", help="采样参数，如 temperature=0.8,0.6；可重复，取笛卡尔积")
    parser.add_argument("--texts", help="台词文件，一行一条；默认用内置的 5 条")
    parser.add_argument("--out", default=str(Path(__file__).parent / "out" / "ref-ab"), help="输出目录")
    parser.add_argument("--no-segmented", action="store_true", help="只合成整段版")
    args = parser.parse_args()

    texts = DEFAULT_TEXTS
    if args.texts:
        texts = [t.strip() for t in Path(args.texts).read_text(encoding="utf-8").splitlines() if t.strip()]
    variants = parse_sweeps(args.sweep)
    out = Path(args.out).expanduser().resolve()
    with_segmented = not args.no_segmented

    # 每列：(目录, 标题, 参考音频原声, synth(text))
    columns = []
    if args.backend == "fastapi":
        if args.refs:
            sys.exit("fastapi 后端用服务端的音色（--voices），不接受 --refs")
        tts = FastApiTts(args.tts_url)
        supported = set(tts.health.get("generation_overrides", []))
        unsupported = {k for g in variants for k in g} - supported
        if unsupported:
            sys.exit(f"服务不支持按请求覆盖 {sorted(unsupported)}（/health 的 generation_overrides），先更新并重启 services/tts")
        available = tts.health.get("voices", [])
        voices = args.voices or [tts.health.get("default_voice", "server")]
        unknown = set(args.voices or []) - set(available)
        if unknown:
            sys.exit(f"服务端没有音色 {sorted(unknown)}（有 {available}）")
        print(f"服务端音色 {available}，对比 {voices}，默认采样 {tts.health.get('generation')}")
        for voice in voices:
            for g in variants:
                slug = "_".join(f"{k}{v}" for k, v in g.items()) or "default"
                columns.append((out / f"{voice}_{slug}", f"{voice}｜{variant_name(g)}", None,
                                lambda text, g=g, voice=voice: tts.synth(text, g, voice if args.voices else None)))
    else:
        if not args.refs:
            sys.exit("gradio 后端需要 --refs")
        tts = GradioTts(args.tts_url)
        names = {p.get("parameter_name") for p in tts.params}
        unsupported = {k for g in variants for k in g} - names
        if unsupported:
            sys.exit(f"WebUI 的 /{API_NAME} 没有这些参数：{sorted(unsupported)}（有 {sorted(n for n in names if n)}）")
        for ref in collect_refs(args.refs):
            server_path = tts.upload(ref)
            for g in variants:
                slug = "_".join(f"{k}{v}" for k, v in g.items())
                d = out / (f"{ref.stem}_{slug}" if slug else ref.stem)
                d.mkdir(parents=True, exist_ok=True)
                (d / ("ref" + ref.suffix.lower())).write_bytes(ref.read_bytes())
                title = ref.name if not g else f"{ref.name}｜{variant_name(g)}"
                columns.append((d, title, d / ("ref" + ref.suffix.lower()),
                                lambda text, p=server_path, g=g: tts.synth(p, text, g)))

    for d, title, _, synth in columns:
        d.mkdir(parents=True, exist_ok=True)
        print(f"== {title}")
        for i, text in enumerate(texts):
            results, line = synth_line(synth, text, with_segmented)
            for kind, params, frames in results:
                write_wav(d / f"{i + 1:02d}_{kind}.wav", params, frames)
            print(f"  {i + 1:02d} {line}")

    write_index(out, [{"dir": d, "title": t, "ref": r} for d, t, r, _ in columns], texts, with_segmented)
    print(f"\n试听：{out / 'index.html'}")


if __name__ == "__main__":
    main()
