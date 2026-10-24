# ptoy

实时语音通话： AI 角色打电话聊天。

- 语音识别：SenseVoice
- 对话：Qwen3-8B（llama.cpp）
- 语音合成：IndexTTS2

音频经 LiveKit（WebRTC）在浏览器和 Agent 之间传输。

## 启动

### 第一次

```powershell
git clone https://github.com/Olsondy/ptoy.git
cd ptoy
pnpm install
Copy-Item apps\agent\.env.example apps\agent\.env
```

在 `apps\agent\.env` 里配置：

```ini
# livekit-server.exe 的完整路径，从 https://github.com/livekit/livekit/releases 下载
LIVEKIT_SERVER_BIN=C:\livekit\livekit-server.exe
# 模型服务地址
ASR_URL=http://127.0.0.1:8001
LLM_BASE_URL=http://127.0.0.1:8080/v1
TTS_GRADIO_URL=http://127.0.0.1:7860
# 角色音色参考音频
TTS_REF_AUDIO=C:\path\to\ref.wav
```

注释要单独写一行，不要写在值的后面。

### TTS 用 FastAPI 服务（替代 WebUI）

`services/tts` 把 IndexTTS 封装成常驻服务，省掉 WebUI 每句约 0.77s 的固定开销，打断时能取消合成。它和 WebUI 不能同时运行（显存不够）。

1. 关掉 IndexTTS WebUI。
2. 在 IndexTTS 的 conda 环境里，从仓库根目录启动（详细配置见 [services/tts/README.md](services/tts/README.md)）：

   ```powershell
   $env:INDEXTTS_DIR = "D:\index-tts"
   # 音色目录：每个音色一个 <id>.wav，id 对应角色文件里的 voice:（如 xiaoyou-default.wav）
   $env:TTS_VOICES_DIR = "C:\path\to\voices"
   $env:TTS_DEFAULT_VOICE = "xiaoyou-default"
   python services\tts\server.py
   ```

3. `apps\agent\.env` 里切换后端（参考音频此时由服务端提供，Agent 不需要 `TTS_REF_AUDIO`；每个角色用自己的音色，只有这个后端支持）：

   ```ini
   TTS_BACKEND=fastapi
   TTS_FASTAPI_URL=http://127.0.0.1:8002
   ```

换回 WebUI：停掉服务、启动 WebUI，把 `TTS_BACKEND` 改回 `gradio`。

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

## 外网访问（Tailscale）

手机等设备装 Tailscale 后，在外网也像在局域网里一样访问 Windows；`tailscale serve` 提供 HTTPS，浏览器才允许用麦克风。

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

## 文档

- [部署总览：下载安装 → 启动 → 应用连接](docs/deployment-overview.md) · [安装资料](docs/installation/README.md)
- [架构](docs/architecture/server.md) · [情绪链路](docs/architecture/emotion-pipeline.md)
- [新增角色与音色](docs/new-character.md)：参考音频 → 试听定语速 → 语气词 → 角色文件
- [路线图](docs/roadmap/mvp-v1.md) · [决策记录](docs/decisions/)
