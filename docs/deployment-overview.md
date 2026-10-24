# 本地语音对话部署总览

按三层完成部署：先安装三个模型及应用依赖，再分别启动模型服务，最后让 ptoy 连接这些服务。当前 Windows 路径沿用已经整理好的模型目录；Mac 开发时只需把 Agent 的服务地址改为 Windows 主机地址。

架构、参数和性能数据以 [server.md](architecture/server.md) 为准。本页给出操作顺序；安装文件清单单独放在 [installation](installation/README.md)。本文不表示服务已经启动或端到端验收已经通过。

## 第一层 下载安装流程

### 1 准备模型和推理程序

按 [安装目录说明](installation/README.md) 准备环境，然后依次完成：

| 模型 | 安装文档 | 完成标准 |
|---|---|---|
| IndexTTS 2.5 | [下载与安装](installation/IndexTTS-2.5.md) | 主模型、辅助权重、参考音频、独立 Python 环境齐全 |
| Huihui Qwen3 8B Q5_K_M | [下载与安装](installation/Huihui-Qwen3-8B-abliterated-v2.Q5_K_M.md) | CUDA llama-server、GGUF、对话模板齐全 |
| SenseVoiceSmall | [下载与安装](installation/SenseVoiceSmall.md) | 五个模型文件、独立环境、本地 API 封装齐全 |

### 2 准备应用

下载 LiveKit Server，记住 `livekit-server.exe` 的绝对路径。在现有仓库执行：

```powershell
Set-Location 'D:\Resources\MyWorkspace\ai\ptoy'
pnpm install --frozen-lockfile
if (!(Test-Path 'apps\agent\.env')) {
    Copy-Item 'apps\agent\.env.example' 'apps\agent\.env'
}
```

第三层会说明 `.env` 内容。已有配置时直接编辑，不用示例文件覆盖。模型权重、Conda 环境、参考音频和 `.env` 不提交到仓库。

## 第二层 启动流程

打开三个独立的 `pwsh` 标签页。按 IndexTTS → Qwen3 8B → SenseVoice 的顺序逐个执行，已有服务正在运行时跳过对应步骤。

### 1 启动 IndexTTS（API 服务）

ptoy 使用仓库里的 `services/tts` API 服务（:8002），它替代 WebUI：两者都加载整套模型，不能同时运行。入口脚本的内容见 [IndexTTS 安装](installation/IndexTTS-2.5.md#ptoy-使用的-api-服务)。

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File 'D:\Resources\MyWorkspace\ai\models\IndexTTS-2.5\Start-IndexTTS-API.ps1'
```

日志出现 `serving on http://0.0.0.0:8002` 即就绪（加载和预热约 20 秒）。打开 [health](http://127.0.0.1:8002/health)，确认 `status: ok`、`model: IndexTTS2 v2.5`、`qwen_emo: false`。

需要用网页试听或调参时，先停掉 API 服务，再用 `Start-IndexTTS.ps1` 启动 WebUI（:7860），并把 Agent 切回 `TTS_BACKEND=gradio`（见第三层）。

### 2 启动 Qwen3 8B

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File 'D:\Resources\MyWorkspace\ai\models\Huihui-Qwen3-8B-abliterated-v2.Q5_K_M\Start-Qwen3-8B.ps1'
```

等待 [health](http://127.0.0.1:8080/health) 返回 `status: ok`，在 [聊天页](http://127.0.0.1:8080) 发一句中文，确认直接回答且没有思考正文。日志在相应日志级别下应确认 `offloaded 37/37 layers to GPU`；详细参数和模板要求见架构文档第 5 节。27B 与 8B 使用同一个端口，不能同时启动。

### 3 启动 SenseVoice

按仓库 ADR-0003 使用 CPU，显式传参数：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File 'D:\Resources\MyWorkspace\ai\models\SenseVoiceSmall\Start-SenseVoice.ps1' -Device cpu
```

打开 [health](http://127.0.0.1:8001/health)，确认 `device: cpu`；使用 [API 测试页](http://127.0.0.1:8001/docs) 上传短音频，确认返回识别文本。该启动脚本的 CPU 分支此前只做过静态检查，Windows CPU 识别结果以本次真实调用为准。

需要复测 GPU 时先停止 CPU 服务，再将命令末尾改为 `-Device gpu`；这不是仓库默认部署方案。不要省略 `-Device`，因为现有脚本缺省值仍为 GPU。

### 4 检查服务并管理窗口

```powershell
Invoke-RestMethod 'http://127.0.0.1:8001/health' -NoProxy
Invoke-RestMethod 'http://127.0.0.1:8080/health' -NoProxy
Invoke-RestMethod 'http://127.0.0.1:8002/health' -NoProxy
```

IndexTTS API 服务和 SenseVoice 的启动脚本已调用各自 Conda 环境中的 Python，无需手动激活；llama.cpp 不需要 Conda。命令通过子 `pwsh` 启动，各服务在对应窗口前台运行。按 `Ctrl+C` 停止对应服务；切换 CPU/GPU 或重启前先等端口释放。

## 第三层 应用连接流程

### 1 将 Agent 指向模型服务

编辑 `apps/agent/.env` 中对应字段，保留其他已有设置。Windows 同机运行可使用：

```ini
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_SERVER_BIN=C:/livekit/livekit-server.exe
AGENT_PIPELINE=conversation
ASR_URL=http://127.0.0.1:8001
ASR_LANGUAGE=zh
TURN_DETECTOR=transcript
ENDPOINTING_MIN_DELAY_MS=800
ENDPOINTING_MAX_DELAY_MS=2000
LLM_BASE_URL=http://127.0.0.1:8080/v1
LLM_MODEL=qwen3-8b
LLM_API_KEY=no-key
TTS_BACKEND=fastapi
TTS_FASTAPI_URL=http://127.0.0.1:8002
TTS_EMOTION_CONTROL=vector
TTS_EMO_WEIGHT=0.6
```

改用 WebUI 时把 TTS 部分换成：

```ini
TTS_BACKEND=gradio
TTS_GRADIO_URL=http://127.0.0.1:7860
TTS_REF_AUDIO=D:/Development/IndexTTS/prompts/voices/<id>.wav
TTS_LANGUAGE=ZH
TTS_EMOTION_CONTROL=vector
TTS_EMO_WEIGHT=0.6
```

全部模型改用 OpenRouter 时（ADR 0012），不需要启动任何模型服务，第二层可以跳过：

```ini
ASR_URL=https://openrouter.ai/api
ASR_API_KEY=sk-or-...
ASR_MODEL=fish-audio/transcribe-1-pro
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=cognitivecomputations/dolphin-mistral-24b-venice-edition
LLM_SHARED_RULES=false
TTS_BACKEND=openrouter
TTS_OPENROUTER_API_KEY=sk-or-...
TTS_OPENROUTER_MODEL=fish-audio/s2.1-pro
TTS_OPENROUTER_VOICES=rouyi=<fish voice id>
DEFAULT_CHARACTER=rouyi
FILLERS_ENABLED=false
```

- 页面只列出 `tts_backends` 包含当前 `TTS_BACKEND` 的角色。内置角色缺省只用于 IndexTTS，Fish 模式下只有 `rouyi`；其他角色要在角色文件里加 `openrouter` 并在 `TTS_OPENROUTER_VOICES` 映射音色，`DEFAULT_CHARACTER` 也必须是可用角色，否则启动报错。
- `TTS_OPENROUTER_VOICES` 把角色文件的 `voice:` 映射为 Fish 音色 id，未映射的用模型默认音色。预录语气词是 IndexTTS 音色，要关闭或用 Fish 音色重新生成。
- 该后端不支持情绪强度，非平静情绪以 `[开心]` 式提示词传给模型，角色的 `tts_style` 加在每句最前面。`LLM_SHARED_RULES=false` 不拼 `_rules.md`，只适合人设自带说话规则的角色（如 `rouyi`）。
- `fish-audio/transcribe-1-pro` 在文本里带 `[高兴]`、`[laughter]` 这类提示，Agent 按关键词映射成 SenseVoice 的情绪/事件类别，来电者语气可用；换成其他托管 ASR（如 `qwen/qwen3-asr-1.7b`）只返回文本，语气不可用。也可以只把 LLM/TTS 换成 OpenRouter，ASR 保留 SenseVoice。
- `CLOUD_MODEL_CHECKS` 不探测 OpenRouter 上的 ASR、LLM 和 TTS。

把 `LIVEKIT_SERVER_BIN` 改为实际安装路径。`devkey/secret` 对应本地 `livekit-server --dev`，已有独立 LiveKit 时使用与其一致的连接配置。注释独占一行，不放在值后面。完整可选项见 [环境变量示例](../apps/agent/.env.example)。

连接时容易混淆的几处：

- `LLM_BASE_URL` 带 `/v1`；ASR 和 TTS 的 URL 填服务根地址，Agent 会追加接口路径。
- 参考音频：用 API 服务时只在服务端配置（入口脚本里的 `TTS_VOICES_DIR`，每个音色一个 `<id>.wav`），Agent 按角色文件的 `voice:` 传 id，对不上时 TTS 返回 `422 unknown_voice`。用 WebUI 时，Agent 的 `TTS_REF_AUDIO` 必须是 **Agent 所在机器可读取的文件**，Agent 会自行上传并缓存服务端路径；Agent 在 Mac 时使用 Mac 本地音频路径。
- `TTS_EMOTION_CONTROL=vector`（默认）按每句的情绪标签合成，`TTS_EMO_WEIGHT` 是强度；`reference` 跟随参考音频情绪。见 [情绪链路](architecture/emotion-pipeline.md)，不要把关闭 QwenEmotion 理解为关闭全部情绪控制。
- `TURN_DETECTOR=transcript` 按识别文字判断是否说完：句子完整时静音 `ENDPOINTING_MIN_DELAY_MS` 后回复，结尾像没说完时最多等 `ENDPOINTING_MAX_DELAY_MS`。停顿稍长就被抢答时调大前者（如 1000）。
- Agent 在 Mac 时，三个模型 URL 的 `127.0.0.1` 换成 Windows 的局域网 IP。`0.0.0.0` 是服务监听地址，不是客户端访问地址。
- 应用入口 `pnpm app` 读取 `apps/agent/.env`，不读取 `deploy/windows/config.ps1`。本机遗留配置中有旧 GGUF 路径和 ASR 8100 端口，不能混用；本流程使用模型目录启动入口和 ASR 8001。
- 只测网络链路、不调用模型时设 `AGENT_PIPELINE=echo`，能听到自己的回声。

### 2 启动应用并接通通话

在第四个 `pwsh` 标签页执行：

```powershell
Set-Location 'D:\Resources\MyWorkspace\ai\ptoy'
pnpm app
```

该命令由 `scripts/app.mjs` 启动 LiveKit、token 服务、Agent 和网页，并构建前端；不会启动、停止或加载三个模型。LiveKit 已在配置端口运行时会跳过启动。打开 [http://localhost:4173](http://localhost:4173)，允许麦克风，戴耳机后打开通话开关。

浏览器通过网页代理获取 token，再加入 LiveKit 房间；Agent 调用 ASR、LLM 和 TTS，音频经 LiveKit 回到浏览器。具体组件与数据流见 [总体架构](architecture/server.md#3-总体架构)，接口实现见 [SenseVoice 适配器](../apps/agent/src/stt/sensevoice.ts)、[LLM 适配器](../apps/agent/src/llm/index.ts)、[TTS API 适配器](../apps/agent/src/tts/fastapi.ts) 和 [Gradio 适配器](../apps/agent/src/tts/gradio.ts)。

从手机或其他电脑访问见下一节。

### 3 从其他设备访问

浏览器只在 `localhost` 或 HTTPS 下允许使用麦克风，LiveKit 也要能从浏览器访问；仅把页面地址换成局域网 HTTP 地址不足以启用麦克风。

局域网放行防火墙（管理员 PowerShell，只需一次）：

```powershell
New-NetFirewallRule -DisplayName ptoy-tcp -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173,7880,7881 -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName ptoy-udp -Direction Inbound -Action Allow -Protocol UDP -LocalPort 7882 -RemoteAddress LocalSubnet
```

手机等设备在外网访问时用 Tailscale，`tailscale serve` 提供 HTTPS：

1. Windows 和手机都安装 [Tailscale](https://tailscale.com/download)，登录同一个账号。
2. 在 Tailscale 管理后台 → DNS，打开 **MagicDNS** 和 **HTTPS Certificates**。
3. 在 Windows 上查本机的 Tailscale 地址：

   ```powershell
   tailscale ip -4          # 100.x.y.z
   tailscale status         # 第一行是本机名，完整域名形如 <本机名>.<tailnet>.ts.net
   ```

4. 用 `tailscale serve` 给网页和 LiveKit 加 HTTPS（只需一次，`--bg` 会一直保持）：

   ```powershell
   tailscale serve --bg --https=443 4173
   tailscale serve --bg --https=8443 7880
   tailscale serve status
   ```

5. 放行 Tailscale 网段的防火墙（管理员 PowerShell，只需一次）：

   ```powershell
   New-NetFirewallRule -DisplayName ptoy-tailscale-tcp -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173,7880,7881 -RemoteAddress 100.64.0.0/10
   New-NetFirewallRule -DisplayName ptoy-tailscale-udp -Direction Inbound -Action Allow -Protocol UDP -LocalPort 7882 -RemoteAddress 100.64.0.0/10
   ```

6. 在 `apps\agent\.env` 里加两行（换成第 3 步查到的值），然后重启 `pnpm app`：

   ```ini
   LIVEKIT_PUBLIC_URL=wss://<本机名>.<tailnet>.ts.net:8443
   LIVEKIT_NODE_IP=100.x.y.z
   ```

7. 手机打开 Tailscale，再用浏览器访问 `https://<本机名>.<tailnet>.ts.net`。

设了 `LIVEKIT_NODE_IP` 之后，所有访问的设备都要通过 Tailscale 连接；只在本机测试时去掉这两行即可。

分享固定角色链接时，要从对方也能访问的 HTTPS 地址打开主页再复制，链接使用当前页面的域名。

### 4 验收和定位

按顺序检查：三个模型独立调用成功 → 网页加入房间 → 说话出现用户字幕 → AI 字幕与声音正常 → 再次开口能打断 → 下一轮继续对话。只有 HTTP 200 或端口监听不算完整通话通过。

| 现象 | 先检查 |
|---|---|
| 页面能打开但麦克风不可用 | 是否用 localhost 或 HTTPS，浏览器麦克风权限 |
| 无用户字幕 | ASR health、CPU/GPU 实际设备、`ASR_URL`、Agent 的 `ptoy.stt_error` 日志 |
| 有用户字幕，没有回复 | llama-server health、`/v1` 路径、模型别名及 Agent 的 LLM 错误 |
| 有回复但没声音 | `TTS_BACKEND` 与实际运行的服务是否一致（API :8002 / WebUI :7860）、8002 health、Agent 的 TTS 错误；用 WebUI 时再查参考音频是否在 Agent 本机 |
| 本机能用，另一台设备不行 | 服务地址、LiveKit 公网/局域网地址、网络及 [防火墙配置](#3-从其他设备访问) |

`pnpm app` 窗口的 `Ctrl+C` 只停止它自己启动的应用子进程；三个模型要在各自窗口停止。更换 GPU 模型后按仓库规则重新运行 `bench/bench_gpu.py`；性能结论以 Windows 本机压测为准，记录入口和指标见架构文档。
