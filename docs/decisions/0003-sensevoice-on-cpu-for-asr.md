# ASR 采用本地 SenseVoice-Small，跑在 CPU 上

状态：accepted · 2026-10-23

VAD 切出一整句后，交给 SenseVoice-Small 整句识别，耗时几十到一百多毫秒；它还能顺带输出情绪和事件标签。放在 CPU 上是有意为之：16GB 显存要留给 LLM 和 TTS（实测峰值 13.8GB），而这个模型很小、不是自回归结构，在 CPU 上也足够快。

## Considered Options

- **Gemini Flash 等多模态 LLM 兼当 ASR**：不支持流式，要等整段音频上传后才开始处理，多一次云端往返（0.5–1.5s+）；通用模型拿到一句问话时，有时会直接回答而不是转写；境外网络不稳定。
- **流式 ASR（Paraformer-streaming）**：只有需要边说边出字的实时字幕，或靠半句话判断轮次时才需要，MVP 不需要。
