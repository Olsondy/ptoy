# ptoy

实时语音通话： AI 角色打电话聊天。

- 语音识别：SenseVoice（可选 OpenRouter）
- 对话：Qwen3-8B（llama.cpp，可选 OpenRouter）
- 语音合成：IndexTTS2（可选 OpenRouter）

三个模型也可以全部改用 OpenRouter，不需要本地 GPU（ADR 0012）。

音频经 LiveKit（WebRTC）在浏览器和 Agent 之间传输。

## 启动

第一次：

```powershell
git clone https://github.com/Olsondy/ptoy.git
cd ptoy
pnpm install
Copy-Item apps\agent\.env.example apps\agent\.env
```

在 `apps\agent\.env` 里填 `livekit-server.exe` 路径和模型服务地址，见 [部署总览](docs/deployment-overview.md#第三层-应用连接流程)。

每次：

```powershell
pnpm app
```

它会启动 LiveKit、token 服务、Agent 和网页。打开 <http://localhost:4173>，戴上耳机，点通话开关说话。按 `Ctrl+C` 全部停止。手机等其他设备访问见 [从其他设备访问](docs/deployment-overview.md#3-从其他设备访问)。

更新：`git pull` 后再执行 `pnpm install`。

## 文档

- [部署总览：下载安装 → 启动 → 应用连接](docs/deployment-overview.md)（含 `--env` 多环境启动） · [HK 服务器部署](deploy/cloud/hk/README.md) · [安装资料](docs/installation/README.md) · [TTS 服务](services/tts/README.md)
- [架构](docs/architecture/server.md) · [情绪链路](docs/architecture/emotion-pipeline.md)
- [新增角色与音色](docs/new-character.md)：参考音频 → 试听定语速 → 语气词 → 角色文件
- [路线图](docs/roadmap/mvp-v1.md) · [决策记录](docs/decisions/)
