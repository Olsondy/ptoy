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

指定环境时读取同目录的完整配置文件，不叠加本地 `.env`：

```powershell
pnpm app --env hk                                 # apps/agent/.env.hk
pnpm --filter @ptoy/agent start --env hk           # 仅启动 Agent
pnpm --filter @ptoy/agent start:token --env hk     # 仅启动 Token 服务
pnpm app --env hk --check-env                     # 只检查配置选择及生产域名是否填写，不启动服务
```

省略 `--env` 仍使用 `apps/agent/.env`；指定的环境文件缺失会报错，不回退。进程环境变量优先于文件。`dev`、`dev:token`、`invite`、`chat`、`sim:call`、`emotion:compliance` 也支持同一选项。真实 `.env.*` 已被 Git 忽略，密钥只保留在本机文件中。

HK 配置还需填写 `APP_ORIGIN=https://网页域名` 和 `LIVEKIT_PUBLIC_URL=wss://信令域名`。其 Linux 可执行文件、角色资源目录及 Tailscale 链路须在服务器上准备好；`LIVEKIT_CONFIG` 指向的 LiveKit 配置必须使用相同的 API key/secret。生产环境不会自动用 `--dev` 启动 LiveKit。`--check-env` 不验证网络、模型服务或资源文件，也不代表已完成部署。

它会启动 LiveKit、token 服务、Agent 和网页。打开 <http://localhost:4173>，戴上耳机，点通话开关说话。按 `Ctrl+C` 全部停止。手机等其他设备访问见 [从其他设备访问](docs/deployment-overview.md#3-从其他设备访问)。

主页右上角选角色后，点链接图标可复制只能与该角色通话的固定链接，规则见 [服务端架构](docs/architecture/server.md#通话页面-ui)。

更新：`git pull` 后再执行 `pnpm install`。

## 文档

- [HK 服务器部署与运维](deploy/cloud/hk/README.md)（`voice.bocayouth.cn`，Node.js + systemd）
- [部署总览：下载安装 → 启动 → 应用连接](docs/deployment-overview.md) · [安装资料](docs/installation/README.md) · [TTS 服务](services/tts/README.md)
- [架构](docs/architecture/server.md) · [情绪链路](docs/architecture/emotion-pipeline.md)
- [新增角色与音色](docs/new-character.md)：参考音频 → 试听定语速 → 语气词 → 角色文件
- [路线图](docs/roadmap/mvp-v1.md) · [决策记录](docs/decisions/)
