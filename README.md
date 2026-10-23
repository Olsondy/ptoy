# ptoy

实时语音通话： AI 角色打电话聊天。

- 语音识别：SenseVoice
- 对话：Qwen3-8B（llama.cpp）
- 语音合成：IndexTTS2

音频经 LiveKit（WebRTC）在浏览器和 Agent 之间传输。

## 启动

前提：模型服务已经自己启动好，`pnpm app` 只会检查它们有没有响应。

| 模型服务 | 默认地址 |
|---|---|
| ASR（SenseVoice，`services/asr`） | http://127.0.0.1:8100 |
| llama-server | http://127.0.0.1:8080 |
| IndexTTS2 WebUI | http://127.0.0.1:7860 |

### 第一次

```powershell
git clone https://github.com/Olsondy/ptoy.git
cd ptoy
pnpm install
Copy-Item apps\agent\.env.example apps\agent\.env
```

在 `apps\agent\.env` 里填两项：

```ini
LIVEKIT_SERVER_BIN=C:\livekit\livekit-server.exe   # 从 https://github.com/livekit/livekit/releases 下载
TTS_REF_AUDIO=C:\path\to\ref.wav                   # 角色音色参考音频
```

模型服务不在本机时，再改 `ASR_URL`、`LLM_BASE_URL`、`TTS_GRADIO_URL`。

需要从局域网其他设备访问时，用管理员 PowerShell 放行防火墙（只需一次）：

```powershell
New-NetFirewallRule -DisplayName ptoy-tcp -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173,7880,7881 -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName ptoy-udp -Direction Inbound -Action Allow -Protocol UDP -LocalPort 7882 -RemoteAddress LocalSubnet
```

### 每次

```powershell
pnpm app
```

它会在同一个窗口里启动 LiveKit、token 服务、Agent 和网页（LiveKit 已经在运行就跳过）。看到提示后打开 <http://localhost:4173>，戴上耳机，点通话开关说话。按 `Ctrl+C` 全部停止。

- 浏览器只在 `localhost` 或 HTTPS 下允许使用麦克风，所以要在运行 `pnpm app` 的这台电脑上打开页面。
- 只想测网络链路、不调用模型：在 `apps\agent\.env` 里设 `AGENT_PIPELINE=echo`，能听到自己的回声。

### 更新

```powershell
git pull
pnpm install
```

## 文档

- [架构](docs/architecture/server.md) · [情绪链路](docs/architecture/emotion-pipeline.md)
- [路线图](docs/roadmap/mvp-v1.md) · [决策记录](docs/decisions/)
