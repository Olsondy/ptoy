"""参考音频 A/B 试听：用同一组小悠的典型回复，分别配几段候选参考音频合成，生成对比试听页。

每条回复合成两种版本：
  - whole：整段一次合成（语调连贯，代表 IndexTTS2 的上限）
  - segmented：按 Agent 的分段方式切开逐段合成再拼接（首段切在第一个逗号，之后按句切；
    段间不加静音），代表通话里实际听到的样子
两者对比能听出分段对自然度的影响；不同参考音频之间对比能听出参考音频的影响。

用法（标准库即可，Mac 经局域网或 Windows 本机都能跑）：
  python bench/compare_ref_audio.py --tts-url http://127.0.0.1:7860 --refs D:\\voice\\a.wav D:\\voice\\b.wav
  python bench/compare_ref_audio.py --tts-url http://192.168.31.82:7860 --refs ~/voices/ --out /tmp/ref-ab
  只要整段版（省一半时间）：加 --no-segmented；自定义台词：--texts lines.txt（一行一条）

结果写到 --out（默认 bench/out/ref-ab/），用浏览器打开其中的 index.html 试听。
情感跟随参考音频（与 Agent 默认的 TTS_EMOTION_CONTROL=reference 一致），其余参数用 WebUI 默认值。
"""

import argparse
import html
import json
import mimetypes
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid
import wave
from pathlib import Path

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

    def synth(self, ref_server_path, text):
        """返回 wav 字节。"""
        overrides = {
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
                    return audio.read()
        raise RuntimeError("Gradio 结果流里没有 complete 事件")


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


def write_index(out, refs, texts, with_segmented):
    rel = lambda p: html.escape(p.relative_to(out).as_posix())
    rows = []
    for i, text in enumerate(texts):
        cells = []
        for ref in refs:
            d = out / ref.stem
            players = [f'<div>整段</div><audio controls preload="none" src="{rel(d / f"{i + 1:02d}_whole.wav")}"></audio>']
            if with_segmented:
                players.append(
                    f'<div>分段</div><audio controls preload="none" src="{rel(d / f"{i + 1:02d}_segmented.wav")}"></audio>'
                )
            cells.append(f"<td>{''.join(players)}</td>")
        rows.append(f"<tr><th>{html.escape(text)}</th>{''.join(cells)}</tr>")
    refs_row = "".join(
        f'<td><b>{html.escape(r.name)}</b><br><audio controls preload="none" src="{rel(out / r.stem / ("ref" + r.suffix.lower()))}"></audio></td>'
        for r in refs
    )
    header = "".join(f"<th>{html.escape(r.stem)}</th>" for r in refs)
    (out / "index.html").write_text(
        f"""<!doctype html><meta charset="utf-8"><title>参考音频 A/B</title>
<style>body{{font-family:system-ui,sans-serif;margin:24px}}table{{border-collapse:collapse}}
td,th{{border:1px solid #ccc;padding:8px;vertical-align:top;text-align:left}}th{{max-width:220px;font-weight:normal}}
audio{{width:240px;height:32px}}div{{font-size:12px;color:#666}}</style>
<h2>参考音频 A/B</h2>
<table><tr><th>参考音频原声</th>{refs_row}</tr><tr><th>台词</th>{header}</tr>{''.join(rows)}</table>
""",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tts-url", required=True, help="IndexTTS WebUI 地址，如 http://127.0.0.1:7860")
    parser.add_argument("--refs", nargs="+", required=True, help="候选参考音频文件或目录（可混用）")
    parser.add_argument("--texts", help="台词文件，一行一条；默认用内置的 5 条")
    parser.add_argument("--out", default=str(Path(__file__).parent / "out" / "ref-ab"), help="输出目录")
    parser.add_argument("--no-segmented", action="store_true", help="只合成整段版")
    args = parser.parse_args()

    texts = DEFAULT_TEXTS
    if args.texts:
        texts = [t.strip() for t in Path(args.texts).read_text(encoding="utf-8").splitlines() if t.strip()]
    refs = collect_refs(args.refs)
    out = Path(args.out).expanduser().resolve()
    with_segmented = not args.no_segmented

    tts = GradioTts(args.tts_url)
    for ref in refs:
        d = out / ref.stem
        d.mkdir(parents=True, exist_ok=True)
        (d / ("ref" + ref.suffix.lower())).write_bytes(ref.read_bytes())
        server_path = tts.upload(ref)
        print(f"== {ref.name}")
        for i, text in enumerate(texts):
            start = time.perf_counter()
            params, frames = read_wav(tts.synth(server_path, text))
            write_wav(d / f"{i + 1:02d}_whole.wav", params, frames)
            line = f"  {i + 1:02d} 整段 {(time.perf_counter() - start):.1f}s"
            if with_segmented:
                start = time.perf_counter()
                segments = split_like_agent(text)
                joined, first_params = b"", None
                for seg in segments:
                    p, f = read_wav(tts.synth(server_path, seg))
                    if first_params and (p.framerate, p.nchannels, p.sampwidth) != (
                        first_params.framerate, first_params.nchannels, first_params.sampwidth,
                    ):
                        raise RuntimeError(f"分段音频格式不一致：{p} vs {first_params}")
                    first_params = first_params or p
                    joined += f
                write_wav(d / f"{i + 1:02d}_segmented.wav", first_params, joined)
                line += f" | 分段 {(time.perf_counter() - start):.1f}s {' / '.join(segments)}"
            print(line)

    write_index(out, refs, texts, with_segmented)
    print(f"\n试听：{out / 'index.html'}")


if __name__ == "__main__":
    main()
