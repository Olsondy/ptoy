# 全部模型走 OpenRouter

状态：accepted（代码与配置已完成，未做真实通话验收） · 2026-10-25

在本地模型（ADR 0001–0006）和云端应用加本地模型（ADR 0011）之外，增加第三种运行方式：ASR、LLM、TTS 全部调用 OpenRouter，任何机器都不再运行模型进程，也不依赖 Windows GPU 主机。三种方式只靠 `apps/agent/.env` 切换，默认仍是本地模型，原有链路不变。配置见 [环境变量示例](../../apps/agent/.env.example) 的 Profile C 和 [部署总览](../deployment-overview.md)。

## 选型

| 环节 | 选择 | 理由 |
|---|---|---|
| ASR | `fish-audio/transcribe-1-pro` | 文本里带 `[高兴]` 这类情绪/事件提示，插件映射为 SenseVoice 的类别，保住来电者语气；约 $0.0001/秒，Mac 实测单句约 2.5s。走 OpenAI 兼容的 `/audio/transcriptions`，复用 SenseVoice 插件，只加 key 和 `model`。最初选的 `qwen/qwen3-asr-1.7b` 便宜十余倍但只返回文本、实测 4–11s |
| LLM | `cognitivecomputations/dolphin-mistral-24b-venice-edition` | 无审核对话模型，沿用 realtime-sex-voice-call 的实测选择；OpenAI 兼容，只改配置 |
| TTS | `fish-audio/s2.1-pro`（`TTS_BACKEND=openrouter`） | 音色按 Fish 音色 id 选择，返回 wav；情绪与整体语气用方括号提示（`tts_style`） |

## 取舍

- **情绪链路降级**：托管 ASR 的情绪来自 Fish 的自由文本提示，没有置信度，类别靠关键词映射，覆盖不如 SenseVoice 的固定标签；Fish TTS 没有 IndexTTS2 的情绪向量与强度。此模式配合 `LLM_SHARED_RULES=false` 使用，人设自带说话规则（如 `rouyi`），不要求 LLM 输出情绪标签。
- **角色按后端区分**：角色 front matter 的 `tts_backends` 声明适用后端，页面只列出与当前 `TTS_BACKEND` 匹配的角色；IndexTTS 的参考音频和预录语气词在此模式不可用，语气词需关闭或用 Fish 重录。
- **延迟与费用**：三段都走公网，首句延迟高于本地，按用量计费，取代 ADR 0011 中“不切换付费云模型”的限制（仅在选择此模式时）。未压测，`CLOUD_MODEL_CHECKS` 不探测 OpenRouter。
- **可用性**：不再受家庭主机开关机影响，改为依赖 OpenRouter 及其上游供应商。

## 替代方案

- 云服务器 CPU 上跑 SenseVoice，只把 LLM/TTS 放 OpenRouter：情绪标签固定、ASR 更快，但要在服务器上维护 Python 模型环境。托管 ASR 的语气不够用时再考虑。
- 其他 ASR：`openai/gpt-4o-transcribe`、`elevenlabs/scribe-v2` 支持中文但更贵；只改 `ASR_MODEL` 即可切换，按实测效果再定。
