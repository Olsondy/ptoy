# 语气感知走情绪标签链路，不换用 Omni 模型

状态：accepted · 2026-10-23

保留 Qwen3-8B 和 IndexTTS2。情绪通过标签传递：SenseVoice 识别出的情绪标签写进 prompt → Qwen3-8B 在每句回复前加情绪标签 → Segmenter 解析出来 → IndexTTS2 按对应情绪合成。

## Considered Options

- **Qwen2.5-Omni 直接听音频**：能感知一些语气，但比较粗；它自带的发声模块只有固定音色，没法控制情绪；文本和角色扮演能力也比 Qwen3-8B 弱。换来的只有“省掉 ASR、直接听音频”这一点，代价是同时失去音色克隆、情绪表达和对话质量。
