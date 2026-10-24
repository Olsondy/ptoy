# 按角色调校 TTS：语速和停顿写在角色文件里，按请求发给 TTS 服务

状态：accepted · 2026-10-24

角色文件的 front matter 可以写两个可选字段，和 `voice:` 放在一起：

- `tts_speed`：语速倍数，缺省 `1.0`，`1.06` 表示快 6%。
- `tts_max_pause_ms`：句中停顿上限，缺省用 TTS 服务的配置（`TTS_MAX_PAUSE_MS`，400）；每段尾部保留的静音取它的 0.6 倍（300 → 180ms），段与段之间的停顿也就不超过这个量级。

Agent 每次 `POST /tts` 把这两个值带上（`speed`、`max_pause_ms`），TTS 服务按请求生效，所以调参后下一通电话就能听到，不用重启服务。当前取值：

| 角色 | voice | tts_speed | tts_max_pause_ms |
|---|---|---|---|
| 小悠 | xiaoyou-default | 1.06 | 300 |
| 知夏 | zhixia | 1.12 | 300 |

原因：语速和停顿因说话人而异（两段参考音频分别要快 6% 和 12%），全局一个值调不好两个角色。角色文件已经是声明音色的地方（ADR 0008），调校值跟音色写在一起、进仓库可审查。试听依据见 2026-10-24 的对比（真实 LLM 回复，FastAPI；快 6% / 12% 当时用 ffmpeg `atempo` 模拟）。

## 平静句不变

平静句仍然不发情绪、照参考音频念（`emotion: 平静` 在服务端就是“跟随参考音频”）。试过真正的平静情感向量（`emotion_vector` 只有平静一维，强度 0.6 / 0.8）：`xiaoyou-default` 听感和 SenseVoice 判断都不变（各遍都判 ANGRY），`zhixia` 变得更亮但没有更好；真人试听选了跟随参考音频。一开始以为选中的“平静向量 0.6”比原声好，其实请求发的是 `emotion: 平静`，和原声是同一种合成，差别来自采样随机性。

## 语速的实现

IndexTTS 2.5 的 `infer()` 有 `duration_factor` 参数（之前只能用环境变量 `TTS_DURATION_FACTOR` 全局设置）。服务把按请求的 `speed` 换算成 `duration_factor = TTS_DURATION_FACTOR / speed`。

实测（2026-10-24，FastAPI，同一句 25 字，去掉静音后的有声时长）：`speed` 0.8 / 1.0 / 1.25 时，`xiaoyou-default` 为 4.66 / 3.71–3.87 / 2.75–3.09s，`zhixia` 为 5.31 / 4.21–4.22 / 3.18–3.24s。方向正确，而且基本成比例（1.25 时约 0.77 倍，0.8 时约 1.2 倍），改变的是念字速度本身，不只是尾部长度，所以不需要服务端另做变速。

## Considered Options

- **调校值放在 Windows 音色目录里（`voices/<id>.json`）**：服务自动应用，Agent 不用改；但配置不进仓库，和角色、语气词分在两处，改了还要重启服务。
- **全局环境变量**（`TTS_DURATION_FACTOR` / `TTS_MAX_PAUSE_MS`）：两个音色要的值不同。
- **平静句改用平静情感向量**：见上文，试听没有更好。
- **用另一段“情绪参考音频”或文字描述控制语气**：前者要为每个音色再挑一段音频，后者要加载 QwenEmotion，显存只剩约 2.5GB。

## Consequences

- 新增或换音色后，用对比页试听 `tts_speed` / `tts_max_pause_ms` 的几档（`bench/compare_ref_audio.py --sweep`），把选定值写进角色文件。
- `TTS_BACKEND=gradio`（WebUI）不支持按请求的语速和停顿，Agent 忽略这两个字段并记一条警告。
- 语气词也按角色的语速合成（生成器带上 `--speed`），否则语气词比回复慢一拍；换了调校值要重新生成这个音色的语气词。
- 两个角色共用一个音色时，调校值各写各的；音色换了，两个角色文件都要复核。
- 同样的参数每次合成听感不同（采样随机性），试听对比每档至少合成两遍。
