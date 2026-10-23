# 预录语气词生成器

用角色音色经 IndexTTS WebUI（`/gen_single`）一次性合成语气词，用户说完后由 Agent 立即播放，掩盖正式回复的首句合成延迟（ADR 0006）。

- 定义：`fillers.json`（`groups` 场景说明；`fillers` 每条 `id` / `group` / `text` / 可选 `emotion`）
- 产物：每个音色一套，`assets/fillers/<音色>/*.wav` + `manifest.json`，随仓库提交，运行时不再合成。音色 id 与 TTS 服务 `TTS_VOICES_DIR` 里的 `<音色>.wav`、角色文件的 `voice:` 一致（ADR 0008）；Agent 只播这通电话角色音色的那一套

## 生成

```bash
python3 -m venv .venv && .venv/bin/pip install -r services/fillers/requirements.txt

# 新增音色或换了某个音色的参考音频后，全量生成这个音色（会删掉定义里已不存在的旧 wav）
INDEXTTS_URL=http://192.168.31.82:7860 \
INDEXTTS_REF_AUDIO=/path/to/default-relaxing.wav \
  .venv/bin/python services/fillers/generate.py --voice default-relaxing

# 不切 WebUI：直接用正在跑的 TTS 服务（音色是服务端 TTS_VOICES_DIR 里的 <音色>.wav；
# 不给 --ref 时 manifest 的 ref_sha256 为 null）
.venv/bin/python services/fillers/generate.py --backend fastapi --tts-url http://192.168.31.82:8002 --voice gentle

# 只重做某几条（其余条目保留在 manifest 中）
.venv/bin/python services/fillers/generate.py --voice default-relaxing --tts-url http://... --ref /path/to/default-relaxing.wav --only ack_hao_de --only thinking_en
```

- 参考音频不要提交进仓库；manifest 里记录了它的文件名和 sha256，用来核对产物来自哪个音色
- 逐条顺序调用（GPU 共享，不并发），每条失败会重试；从 Mac 经 Wi-Fi 调用每条约 3–10s
- 若本机设了 HTTP 代理，加 `NO_PROXY=<Windows 主机 IP>`
- `emotion` 为 `{情绪: 强度}`，情绪取 喜/怒/哀/惧/厌恶/低落/惊喜/平静（对应 WebUI 的 vec1–vec8），启用“使用情感向量控制”；不写则情绪跟随参考音频
- 后处理单测：`cd services/fillers && ../../.venv/bin/python -m unittest test_audio`

## 后处理

TTS 原始输出（IndexTTS2 为 22.05kHz）依次经过：

1. 重采样到 **48kHz 单声道**：LiveKit 的原生采样率，Agent 直接推进音轨，不再重采样
2. 去首尾静音：10ms 帧 RMS 低于峰值 −45dB 视为静音；首部只留 10ms（首部静音直接计入用户感知延迟），尾部留 40ms 保住尾音衰减；再加 5ms 淡入 / 20ms 淡出防爆音
3. 峰值归一化到 −3 dBFS，保证各条响度一致
4. 写成 16-bit PCM WAV

## Manifest（给 Agent 的契约）

```json
{
  "version": 1,
  "sample_rate": 48000,
  "channels": 1,
  "sample_format": "s16le",
  "voice": { "id": "default-relaxing", "ref": "default-relaxing.wav", "ref_sha256": "...（fastapi 后端未给 --ref 时为 null）" },
  "groups": {
    "thinking": [
      { "id": "thinking_en", "text": "嗯…", "file": "thinking_en.wav", "duration_ms": 380, "sample_rate": 48000 }
    ],
    "ack": [ ... ],
    "empathy": [ ... ]
  }
}
```

- `file` 相对 `manifest.json` 所在目录
- 分组：`thinking` 思考类（用户提问）、`ack` 同意/应答类（请求或陈述）、`empathy` 共情类（倾诉、抱怨、情绪低落）
- `duration_ms` 是处理后整段时长，可用来安排正式回复首段的衔接
- 新增分组或字段时只做加法；不兼容的变更要升 `version`
