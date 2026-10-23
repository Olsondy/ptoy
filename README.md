# ptoy

实时语音通话： AI 角色打电话聊天。

- 语音识别：SenseVoice
- 对话：Qwen3-8B（llama.cpp）
- 语音合成：IndexTTS2

音频经 LiveKit（WebRTC）在浏览器和 Agent 之间传输。

## 服务与端口

全部运行在 Windows GPU 主机（192.168.31.82）上：

| 服务 | 端口 | 说明 |
|---|---|---|
| IndexTTS2 WebUI | 7860 | GPU，必须最先启动 |
| llama-server | 8080 | GPU，Qwen3-8B Q5_K_M |
| ASR（SenseVoice） | 8100 | CPU，conda 环境 `ptoy-asr` |
| LiveKit Server | 7880 / 7881 TCP，7882 UDP | `--dev` 模式 |
| Token 服务 | 8787 | `apps/agent` |
| Agent | 8081（健康检查） | `apps/agent` |
| 网页 | 4173 | `apps/web`，`vite preview` |

## Windows 启动流程

以下命令都在仓库根目录的 PowerShell 里执行。每一步的细节和故障排查见 [Windows 部署手册](docs/runbook/windows.md)。

### 1. 一次性准备

1. **NVIDIA 控制面板** → 管理 3D 设置 → “CUDA - 系统内存回退策略”设为 **“首选无系统内存回退”**。
2. **安装软件**：Git、Node.js 22+、pnpm 10（`npm install -g pnpm@10`）、[LiveKit Server](https://github.com/livekit/livekit/releases)（解压出 `livekit-server.exe`）。llama.cpp、IndexTTS2、conda 需要已经装好。
3. **允许运行脚本**：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
4. **拉取代码，安装依赖**：

   ```powershell
   git clone https://github.com/Olsondy/ptoy.git
   cd ptoy
   pnpm install --frozen-lockfile
   pnpm --filter @ptoy/web run build
   ```

5. **ASR 环境**：已经有装好 `services/asr` 的 conda 环境就直接用，在 `config.ps1` 里把 `AsrEnv` 改成它的名字；没有的话按 [services/asr/README.md](services/asr/README.md) 新建一个（CPU 版 torch）。
6. **防火墙**（管理员 PowerShell）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\windows\setup-firewall.ps1
   ```

### 2. 配置（一次性）

```powershell
Copy-Item deploy\windows\config.example.ps1 deploy\windows\config.ps1
Copy-Item apps\agent\.env.example apps\agent\.env
Copy-Item apps\web\.env.example apps\web\.env
```

- `deploy\windows\config.ps1`：填好 `IndexTtsDir`、`IndexTtsArgs`（IndexTTS 的启动参数）、`LlamaServerExe`、`LlamaModel`、`LiveKitExe`、`AsrEnv`（ASR 所在的 conda 环境名），本地已有 SenseVoice 模型时再填 `AsrModel`（模型目录）。
- `apps\agent\.env`：

  ```ini
  LIVEKIT_URL=ws://127.0.0.1:7880
  LIVEKIT_PUBLIC_URL=ws://192.168.31.82:7880
  ASR_URL=http://127.0.0.1:8100
  LLM_BASE_URL=http://127.0.0.1:8080/v1
  TTS_GRADIO_URL=http://127.0.0.1:7860
  TTS_REF_AUDIO=C:\path\to\ref.wav   # 角色音色参考音频
  ```

- `apps\web\.env`：`TOKEN_SERVER_URL=http://127.0.0.1:8787`

这三个文件都不入库，`git reset` 也不会覆盖它们。

### 3. 启动

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\start-all.ps1
```

脚本会按 IndexTTS → llama-server → ASR → LiveKit → token → Agent → 网页 的顺序，每个服务开一个窗口，前一个就绪后才启动下一个。已经在运行（端口在监听）的服务会直接跳过，不会重复启动。IndexTTS 第一次加载模型可能要几分钟。

### 4. 检查

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\check.ps1
```

所有服务都应显示 OK，显存约 13.8 / 16GB。llama-server 日志里要有 `offloaded 37/37 layers to GPU`。

### 5. 打电话

在 Windows 本机浏览器打开 <http://localhost:4173>，戴上耳机，点通话开关，直接说话。

- 浏览器只在 `localhost` 或 HTTPS 下允许使用麦克风。从手机或其他电脑访问时，见部署手册第 8 节（Caddy HTTPS）。
- 只想测网络链路、不调用模型：把 `apps\agent\.env` 里的 `AGENT_PIPELINE` 改成 `echo`，重启 Agent 窗口，就能听到自己的回声。

### 停止与更新

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\stop-all.ps1   # 停止全部服务
powershell -ExecutionPolicy Bypass -File deploy\windows\update.ps1     # 拉取最新代码、安装依赖、重新构建网页
```

更新完再运行一次 `start-all.ps1`。

## 文档

- [架构](docs/architecture/server.md) · [情绪链路](docs/architecture/emotion-pipeline.md)
- [路线图](docs/roadmap/mvp-v1.md) · [决策记录](docs/decisions/)
- [Windows 部署手册](docs/runbook/windows.md)
