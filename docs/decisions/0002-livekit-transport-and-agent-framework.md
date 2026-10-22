# 传输层和 Agent 框架采用 LiveKit

状态：accepted · 2026-10-23

浏览器与 Agent 之间用 LiveKit（WebRTC），Agent 基于 LiveKit Agents（Node/TS）开发，前端因此选用 React（@livekit/components-react）。LiveKit 内置了打断、回声消除（以 WebRTC 远端音轨为参考）、按实际播放位置截断历史、字幕同步这些语音产品的难点，我们只需要写 STT、TTS 两个适配插件。

## Considered Options

- **WebSocket 传 PCM，自己写打断逻辑**：实现最简单，但浏览器的回声消除不一定能参考 WebAudio 播放的声音，外放时 AI 会听到自己说话并打断自己；打断和截断历史都要自己实现。
- **在 Node 里自己搭 WebRTC（werift / mediasoup）**：工程量大，收益和直接用 LiveKit 一样。
