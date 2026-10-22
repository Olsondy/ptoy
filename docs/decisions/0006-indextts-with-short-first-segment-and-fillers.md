# 保留不支持流式的 IndexTTS2，首句延迟靠短首段和预录语气词掩盖

状态：accepted · 2026-10-23

实测 IndexTTS2 的合成耗时约为 770ms 固定开销 + 89ms × 字数，必须整句合成完才返回；但 RTF 为 0.53–0.72，所以只有第一句有延迟问题，后续句子能连续播放。我们接受这一点，换取它的音色克隆和情绪控制能力：Segmenter 在第一个逗号处就切出很短的首段（4–8 字），用户说完后立即播放同一音色预录的语气词。

## Considered Options

- **换成支持流式的 TTS（CosyVoice 3 / Qwen3-TTS）**：首包可以做到约 150–300ms，但音色和情绪表现可能不如 IndexTTS2，而且要重新部署。如果实测下来语气词方案体验不达标，这是第一备选。

## Consequences

阶段 1 直接调用 Gradio WebUI 的 `/gen_single`；阶段 2 把 IndexTTS 封装成 FastAPI 服务替代 WebUI（两者不能同时运行），省掉 Gradio 的固定开销，并支持返回 PCM 和取消合成。
