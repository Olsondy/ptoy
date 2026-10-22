# MVP 第一版功能路线图

> 版本：v1 · 日期：2026-10-23 · 架构依据：`docs/architecture/server.md`

## 目标

在浏览器里点开通话开关，就能和一个本地部署的角色语音对话：能自然地插话打断它，用户说完后 1 秒内听到回应，球体随声音起伏。

## 里程碑

### M0 · 链路打通（回声）

验证 WebRTC 链路和整套部署方式，暂时不接任何模型。

- Windows 上运行 LiveKit Server（`--dev` 模式），防火墙放行相应端口
- Agent 附带 token 签发接口
- React 页面：通话开关，能连上和断开房间，显示连接状态
- Agent 加入房间后，把用户的声音原样回放

**验收**：开启通话后能听到自己的回声；挂断后 Agent 能正常退出房间；开发环境（Agent 在 Mac）和部署环境（Agent 在 Windows）都能跑通。

### M1 · 对话跑通

ASR → LLM → TTS 整条链路跑通，先做到“能对话”。

- Windows 上部署 SenseVoice ASR 服务（CPU）
- Agent：STT 插件（SenseVoice）、LLM（OpenAI 插件指向 llama-server）、TTS 插件（Gradio `/gen_single`）
- Silero VAD 加轮次检测
- 固定的角色 system prompt
- 页面显示双方的字幕
- 每一段都打时间戳并记录日志：端点检测、ASR、LLM 首 token、TTS 合成、开始播放

**验收**：能连续对话 5 轮以上，上下文连贯；从日志里能读出每一轮各段的耗时；端到端延迟不超过 2.5s。

### M2 · 通话体验

做到“像在打电话”。

- 打断：AI 说话时用户开口，AI 立即停止；对话历史只保留用户实际听到的部分
- Segmenter：首段在第一个逗号处就切出（4–8 字），后续段落按句子切
- 预录语气词：同一音色预合成 5–10 条，按场景选用
- 球体的四种状态：空闲、聆听（跟随麦克风电平）、思考、说话（跟随 Agent 音轨电平）

**验收**：开外放时 AI 不会被自己的声音打断；打断后 300ms 内停止发声；用户说完约 0.7s 内听到声音；下一轮 AI 不会提到被打断、没说出口的内容。

### M3 · 表现力与延迟优化

- 情绪标签链路：SenseVoice 情绪标签 → prompt → LLM 给每句加情绪标签 → IndexTTS2 按情绪合成；字幕中去掉标签，标签缺失或格式错误时按中性处理
- IndexTTS 封装成 FastAPI 服务，替代 Gradio：缓存音色特征、FP16、调扩散步数、返回 PCM、支持取消
- 用新服务重新压测，并更新 `docs/architecture/server.md`

**验收**：用户生气或开心时，回复的语气有明显区别；TTS 固定开销明显下降（目标是省掉约 0.5s）。

## 不在 MVP 范围内

- BGM 和多音轨混音
- 多用户、账号和鉴权
- 移动端 App
- 端到端全双工模型（见 `docs/decisions/0001-cascaded-half-duplex-pipeline.md`）
- 云端模型
