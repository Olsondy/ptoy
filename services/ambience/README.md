# 背景音素材

通话中随对话气氛切换的循环背景音（ADR 0013）。素材**不进仓库**，只放在部署目录，由 Agent 的 `AMBIENCE_DIR` 指定。只有角色 front matter 写了 `ambience: true` 的角色才会播放。

## 目录格式

```
<AMBIENCE_DIR>/
  manifest.json
  low.wav  mid.wav  high.wav  climax.wav
```

`manifest.json`：

```json
{
  "fadeMs": 1500,
  "layers": [
    {
      "id": "intensity",
      "tag": "bg",
      "levels": [
        { "id": "idle", "description": "调情、暧昧，还没有身体接触" },
        { "id": "low", "description": "轻吻、抚摸、慢慢升温", "file": "low.wav", "volume": 0.35 }
      ]
    }
  ]
}
```

- `levels`：按顺序排列，第一个是通话开始时的档位。没有 `file` 的档位是静音。`id` 就是 LLM 写在回复开头的 `<bg:id>`，`description` 会原样写进给 LLM 的规则。
- `volume`：0–1，压在人声下面。`fadeMs`：切换档位时交叉淡化的时长。
- `layers` 目前只支持一层（`tag` 必须是 `bg`）。
- 音频：48kHz、单声道、16-bit PCM WAV，至少 1 秒。Agent 会把每段的最后 50ms 和开头交叉淡化，循环时听不到接缝。
- 清单或素材有错时，Agent 在这通电话的日志里写明原因（`ambience disabled for this call`），通话照常进行，只是没有背景音。

## 转换素材

在 Mac 上用 ffmpeg 转换（服务器上不需要 ffmpeg）。输入目录里的文件按档位命名，如 `low.mp3`：

```bash
python3 services/ambience/convert.py .data/ambience-src .data/ambience
```

脚本会把素材转成上面的格式并统一响度（-23 LUFS）。输出目录还没有 `manifest.json` 时，会写一份默认清单；已有清单不会覆盖，可以直接改里面的说明和音量后重新运行。

## 部署

本机开发：在 `apps/agent/.env` 里设置 `AMBIENCE_DIR=<仓库>/.data/ambience`（`.data/` 已被 Git 忽略）。

HK 服务器（`.env.hk` 已设置 `AMBIENCE_DIR=/var/lib/ptoy/resources/ambience`）：先在本机转换并校验，通过后手动上传到这个目录，覆盖同名文件。下一通电话生效，不用重启。

```bash
python3 services/ambience/convert.py .data/ambience-src .data/ambience
pnpm --filter @ptoy/agent check:ambience -- .data/ambience
```

校验按 Agent 读取的方式检查清单和每个循环文件，通过时会列出所有档位。上传后的文件要让 `ptoy` 用户可读（当前为 `root:ptoy`、`0640`）。

## 验证

- 不打电话：`pnpm --filter @ptoy/agent sim:call -- --fake asr,llm,tts --turns "你好呀|慢慢来|继续说" --ambience "low|mid|"`，会检查来电方收到的背景音轨是否按预期切换档位（用合成的测试音，不读这里的素材）。
- 真实通话时看 Agent 日志里每轮的 `ambience` 行：`tag` 是模型写的标签，`from` / `to` 是切换前后的档位，`ignored: unknown_level` 表示模型写了清单里没有的档位。
