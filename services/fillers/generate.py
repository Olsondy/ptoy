"""用角色音色批量合成预录语气词，产出 assets/fillers/*.wav 与 manifest.json。

用法见同目录 README.md。顺序逐条调用 IndexTTS WebUI 的 /gen_single（GPU 共享，不并发）。
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import soundfile as sf

import audio

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEFAULT_DEFS = HERE / "fillers.json"
DEFAULT_OUT = REPO / "assets" / "fillers"
MANIFEST_VERSION = 1
EMOTIONS = ["喜", "怒", "哀", "惧", "厌恶", "低落", "惊喜", "平静"]  # 对应 vec1..vec8
RETRIES = 4


def retry(fn, what):
    for attempt in range(1, RETRIES + 1):
        try:
            return fn()
        except Exception as exc:  # 局域网 / Gradio 偶发超时
            if attempt == RETRIES:
                raise
            print(f"  {what}第 {attempt} 次失败（{exc!r}），重试 ...", file=sys.stderr)
            time.sleep(2 * attempt)


class TtsClient:
    def __init__(self, url, ref_path):
        from gradio_client import Client, handle_file

        # 局域网 Wi-Fi 抖动大，放宽超时；参考音频每次都要重新上传
        self.client = retry(lambda: Client(url, verbose=False, httpx_kwargs={"timeout": 120}), "连接 TTS")
        self.ref = handle_file(str(ref_path))

    def synth(self, text, emotion=None):
        """返回 TTS 输出 wav 的本地路径。emotion 为 {情绪名: 强度}，缺省时情绪跟随音色参考音频。"""
        kwargs = dict(prompt=self.ref, text=text, lang_choice="ZH", emo_ref_path=None, api_name="/gen_single")
        if emotion:
            unknown = set(emotion) - set(EMOTIONS)
            if unknown:
                raise ValueError(f"未知情绪 {unknown}，可选 {EMOTIONS}")
            kwargs["emo_control_method"] = "使用情感向量控制"
            kwargs.update({f"vec{i + 1}": float(emotion.get(name, 0.0)) for i, name in enumerate(EMOTIONS)})
        else:
            kwargs["emo_control_method"] = "与音色参考音频相同"
        result = self.client.predict(**kwargs)
        return result.get("value") if isinstance(result, dict) else result


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_defs(path):
    defs = json.loads(Path(path).read_text(encoding="utf-8"))
    ids = [f["id"] for f in defs["fillers"]]
    if len(ids) != len(set(ids)):
        raise ValueError("fillers.json 里有重复的 id")
    for f in defs["fillers"]:
        if f["group"] not in defs["groups"]:
            raise ValueError(f"{f['id']} 的 group {f['group']!r} 未在 groups 中定义")
    return defs


def load_entries(manifest_path):
    if not manifest_path.exists():
        return {}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {e["id"]: e for entries in manifest["groups"].values() for e in entries}


def build_manifest(defs, entries, ref_path):
    groups = {g: [] for g in defs["groups"]}
    for f in defs["fillers"]:  # 按定义文件的顺序输出
        if f["id"] in entries:
            groups[f["group"]].append(entries[f["id"]])
    return {
        "version": MANIFEST_VERSION,
        "sample_rate": audio.TARGET_RATE,
        "channels": 1,
        "sample_format": "s16le",
        "voice": {"ref": Path(ref_path).name, "ref_sha256": sha256(ref_path)},
        "groups": groups,
    }


def generate_one(tts, filler, out_dir):
    raw_path = retry(lambda: tts.synth(filler["text"], filler.get("emotion")), f"合成 {filler['id']} ")
    raw, rate = sf.read(raw_path, dtype="float64")
    pcm = audio.process(raw, rate)
    file_name = f"{filler['id']}.wav"
    sf.write(out_dir / file_name, pcm, audio.TARGET_RATE, subtype="PCM_16")
    lead_ms, tail_ms = audio.edge_silence_ms(pcm, audio.TARGET_RATE)
    entry = {
        "id": filler["id"],
        "text": filler["text"],
        "file": file_name,
        "duration_ms": round(len(pcm) * 1000 / audio.TARGET_RATE),
        "sample_rate": audio.TARGET_RATE,
    }
    raw_ms = len(raw) * 1000 / rate
    print(
        f"  {filler['id']:<30} {filler['text']:<8} 原始 {raw_ms:5.0f}ms → {entry['duration_ms']:4d}ms"
        f"  首静音 {lead_ms:3.0f}ms 尾静音 {tail_ms:3.0f}ms"
    )
    return entry


def main():
    parser = argparse.ArgumentParser(description="合成预录语气词")
    parser.add_argument("--tts-url", default=os.environ.get("INDEXTTS_URL", "http://127.0.0.1:7860"),
                        help="IndexTTS WebUI 地址（环境变量 INDEXTTS_URL）")
    parser.add_argument("--ref", default=os.environ.get("INDEXTTS_REF_AUDIO"),
                        help="角色音色参考音频（环境变量 INDEXTTS_REF_AUDIO）")
    parser.add_argument("--only", action="append", metavar="ID", help="只重新生成指定 id，可重复")
    parser.add_argument("--defs", default=str(DEFAULT_DEFS), help="语气词定义文件")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出目录（音频 + manifest.json）")
    args = parser.parse_args()
    if not args.ref or not Path(args.ref).is_file():
        parser.error("需要用 --ref 或 INDEXTTS_REF_AUDIO 指定存在的参考音频")

    defs = load_defs(args.defs)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"

    todo = defs["fillers"]
    if args.only:
        unknown = set(args.only) - {f["id"] for f in todo}
        if unknown:
            parser.error(f"未知 id：{sorted(unknown)}")
        todo = [f for f in todo if f["id"] in args.only]
        entries = load_entries(manifest_path)
        old_ref = json.loads(manifest_path.read_text(encoding="utf-8"))["voice"]["ref_sha256"] if entries else None
        if old_ref and old_ref != sha256(args.ref):
            print("[警告] 参考音频与 manifest 中的不同，部分重生成会混用两种音色", file=sys.stderr)
    else:
        entries = {}

    tts = TtsClient(args.tts_url, args.ref)
    print(f"合成 {len(todo)} 条语气词 → {out_dir}")
    for filler in todo:
        entries[filler["id"]] = generate_one(tts, filler, out_dir)

    if not args.only:  # 全量生成时清掉定义里已删除的旧文件
        keep = {e["file"] for e in entries.values()}
        for stale in out_dir.glob("*.wav"):
            if stale.name not in keep:
                stale.unlink()

    manifest = build_manifest(defs, entries, args.ref)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {manifest_path}")


if __name__ == "__main__":
    main()
