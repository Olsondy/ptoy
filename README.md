# ptoy

浏览器里的实时语音通话：点一下开关，就能和一个 AI 角色像打电话一样聊天。页面上只有通话开关、随声音起伏的球体和字幕。

所有模型都部署在本地的 Windows GPU 主机上，不依赖云服务：

- 语音识别：SenseVoice
- 对话：Qwen3-8B（llama.cpp）
- 语音合成：IndexTTS2

音频经 LiveKit（WebRTC）在浏览器和 Agent 之间传输。

目前处于 MVP 开发阶段，进度见 [路线图](docs/roadmap/mvp-v1.md)，架构见 [架构文档](docs/architecture/server.md)。
