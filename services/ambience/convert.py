#!/usr/bin/env python3
"""把背景音素材转换成 Agent 直接读取的目录（ADR 0013）。

  python3 services/ambience/convert.py ~/Desktop/voice /path/to/ambience-out

输入目录里按档位命名的音频（low.mp3 / mid.mp3 / high.mp3 / climax.mp3，任意 ffmpeg 能读的格式），
输出 48kHz 单声道 16-bit WAV（响度统一到 EBU R128 -23 LUFS），并在输出目录没有 manifest.json 时
写一份默认清单。已有清单不覆盖，只检查其中引用的文件都在。需要本机装有 ffmpeg；服务器不需要。
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

LEVELS = [
    ("idle", "调情、暧昧，还没有身体接触", None, 0),
    ("low", "轻吻、抚摸、慢慢升温", "low", 0.35),
    ("mid", "正在亲密进行中，有喘息和呻吟", "mid", 0.4),
    ("high", "激烈、用力、节奏加快", "high", 0.45),
    ("climax", "高潮、到达顶点", "climax", 0.5),
]
SOURCE_SUFFIXES = (".wav", ".mp3", ".ogg", ".m4a", ".flac", ".aac")


def find_source(src: Path, name: str) -> Path:
    for suffix in SOURCE_SUFFIXES:
        path = src / f"{name}{suffix}"
        if path.exists():
            return path
    sys.exit(f"缺少素材：{src}/{name}.*（支持 {', '.join(SOURCE_SUFFIXES)}）")


def convert(source: Path, target: Path) -> None:
    subprocess.run(
        [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(source),
            "-af", "loudnorm=I=-23:TP=-2:LRA=11",
            "-ac", "1", "-ar", "48000", "-sample_fmt", "s16", "-f", "wav", str(target),
        ],
        check=True,
    )


def default_manifest() -> dict:
    levels = []
    for level_id, description, file, volume in LEVELS:
        level = {"id": level_id, "description": description}
        if file:
            level.update(file=f"{file}.wav", volume=volume)
        levels.append(level)
    return {"fadeMs": 1500, "layers": [{"id": "intensity", "tag": "bg", "levels": levels}]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("src", type=Path, help="素材目录（按档位命名）")
    parser.add_argument("out", type=Path, help="输出目录，即部署时的 AMBIENCE_DIR")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = default_manifest()
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"写入默认清单 {manifest_path}")

    for layer in manifest["layers"]:
        for level in layer["levels"]:
            file = level.get("file")
            if not file:
                continue
            target = args.out / file
            convert(find_source(args.src, Path(file).stem), target)
            print(f"{level['id']}: {target}")


if __name__ == "__main__":
    main()
