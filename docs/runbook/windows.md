# Windows 主机部署与启动清单

适用于 Windows GPU 主机（`192.168.31.82`，16GB NVIDIA，用户 `Olsond`）。所有模型服务、LiveKit Server、Agent、token 服务和网页都跑在这台机器上，浏览器经局域网访问。架构与参数的依据见 `docs/architecture/server.md`，本文只讲怎么装、怎么起、怎么查。

脚本都在 `deploy/windows/`，路径类配置集中在 `deploy/windows/config.ps1`（从 `config.example.ps1` 复制，不提交）。下文命令默认在 PowerShell 中、工作目录为仓库根目录执行。

## 0. 服务一览

| 顺序 | 服务 | 端口 | 需要局域网放行 | 启动脚本 | 健康检查 |
|---|---|---|---|---|---|
| 1 | IndexTTS2 WebUI（Gradio，GPU） | TCP 7860 | Mac 开发 / 生成语气词时 | `start-indextts.ps1` | `GET /` 返回 200 |
| 2 | llama-server（Qwen3-8B，GPU） | TCP 8080 | Mac 开发时 | `start-llama.ps1` | `GET /health` 返回 `{"status":"ok"}`；日志含 `offloaded 37/37 layers to GPU` |
| 3 | ASR（SenseVoice，CPU） | TCP 8100 | Mac 开发时 | `start-asr.ps1` | `GET /health` |
| 4 | LiveKit Server | TCP 7880、TCP 7881、UDP 7882 | **必须** | `start-livekit.ps1` | `GET /` 返回 `OK` |
| 5 | token 服务（`apps/agent`） | TCP 8787 | 否（网页经 `/api` 代理访问） | `start-token.ps1` | `GET /healthz` |
| 6 | Agent worker（`apps/agent`） | 8081（仅本机健康检查） | 否 | `start-agent.ps1` | `GET http://127.0.0.1:8081/` 返回 `OK`（已连上 LiveKit） |
| 7 | 网页（`apps/web`，vite preview） | TCP 4173（dev 模式 5173） | **必须** | `start-web.ps1` | `GET /` 返回 200 |
| 8 | Caddy HTTPS（可选，手机用） | TCP 5443、7443 | 启用 HTTPS 时 | `start-caddy.ps1` | 端口在监听 |

**顺序约束**：IndexTTS 必须先于 llama-server 启动（ADR 0005：llama-server 固定 `-ngl 99`，先让 IndexTTS 占好显存，显存不够时 llama-server 直接启动失败，而不是悄悄把层放到 CPU 上）。其余服务之间没有硬依赖，但 Agent 要连 LiveKit，所以按上表顺序启动。

## 1. 一次性准备

### 1.1 系统设置

- **NVIDIA 控制面板 → 管理 3D 设置 → 全局设置 → “CUDA - 系统内存回退策略”（CUDA - Sysmem Fallback Policy）设为“首选无系统内存回退”（Prefer No Sysmem Fallback）**。驱动升级后要重新确认。
- 主机接网线；关闭睡眠，并在设备管理器里关闭网卡的“允许计算机关闭此设备以节约电源”。Wi-Fi 下实测 ping 在 30–375ms 之间波动，还会丢包。

  ```powershell
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  ```

- 允许运行本地脚本（当前用户一次即可；`start-all.ps1` 打开的窗口本身也带 `-ExecutionPolicy Bypass`）：

  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```

### 1.2 软件

| 软件 | 安装方式 | 验证 |
|---|---|---|
| Git | `winget install --id Git.Git -e` | `git --version` |
| Node.js 22+ | `winget install --id OpenJS.NodeJS.LTS -e` | `node -v`（≥ v22） |
| pnpm 10 | `npm install -g pnpm@10` | `pnpm -v` |
| conda | 已安装在 `D:\Resources\MyWorkspace\ai\conda` | `D:\Resources\MyWorkspace\ai\conda\shell\condabin\conda-hook.ps1` 存在 |
| llama.cpp（CUDA 版） | 已安装；需要支持 `--fit`、`--reasoning`、`--cache-ram` 的新版本 | `llama-server.exe --version` |
| IndexTTS2（非官方 fork） | 已安装在 conda 环境 `indextts` | 能手动打开 WebUI |
| LiveKit Server | 从 <https://github.com/livekit/livekit/releases> 下载 `livekit_<版本>_windows_amd64.zip`，解压出 `livekit-server.exe`（例如 `C:\livekit\`） | `C:\livekit\livekit-server.exe --version` |
| Caddy（可选，手机 HTTPS） | 从 <https://github.com/caddyserver/caddy/releases> 下载 `caddy_<版本>_windows_amd64.zip`，解压出 `caddy.exe`（例如 `C:\caddy\`） | `C:\caddy\caddy.exe version` |

从浏览器下载的 zip 解压前先右键“属性 → 解除锁定”，或解压后执行 `Get-ChildItem C:\livekit, C:\caddy | Unblock-File`。

### 1.3 代码与依赖

```powershell
cd D:\Resources\MyWorkspace\ai          # 仓库放哪都行，下文称 <repo>
git clone https://github.com/Olsondy/ptoy.git
cd ptoy
pnpm install --frozen-lockfile
pnpm --filter @ptoy/web run build
```

### 1.4 ASR 的 conda 环境

按 `services/asr/README.md`“Windows 部署”一节创建 `ptoy-asr` 环境（CPU 版 torch），并确认 `python -c "import torch; print(torch.cuda.is_available())"` 输出 `False`。首次启动会下载约 900MB 模型。

### 1.5 防火墙

管理员 PowerShell 执行一次（规则只对本地子网放行，所有网络配置文件生效；已存在的规则会跳过）：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\setup-firewall.ps1
```

等价的手动命令（可直接粘贴到管理员 PowerShell）：

```powershell
$rules = @(
  @('ptoy LiveKit HTTP/WS 7880','TCP',7880), @('ptoy LiveKit RTC TCP 7881','TCP',7881), @('ptoy LiveKit RTC UDP 7882','UDP',7882),
  @('ptoy web preview 4173','TCP',4173), @('ptoy web dev 5173','TCP',5173),
  @('ptoy HTTPS web 5443','TCP',5443), @('ptoy HTTPS LiveKit 7443','TCP',7443),
  @('ptoy IndexTTS 7860','TCP',7860), @('ptoy llama-server 8080','TCP',8080), @('ptoy ASR 8100','TCP',8100),
  @('ptoy token server 8787','TCP',8787)
)
foreach ($r in $rules) {
  New-NetFirewallRule -DisplayName $r[0] -Direction Inbound -Action Allow -Protocol $r[1] -LocalPort $r[2] -RemoteAddress LocalSubnet -Profile Any
}
```

- LiveKit `--dev` 模式的 WebRTC 媒体只走一个 UDP 端口 7882（UDP mux），不是端口段；UDP 不通时回退到 TCP 7881。
- 7860 / 8080 / 8100 只在 Mac 上开发、需要跨机调用模型时才用得到；8787 只在浏览器绕过网页代理直连 token 服务时才用得到。
- 第一次运行 `node.exe`、`python.exe`、`livekit-server.exe` 时 Windows 会弹窗，勾选“专用网络”后点允许。**如果点了取消，Windows 会生成一条阻止规则，优先级高于上面的允许规则**，处理见第 10.3 节。

## 2. 配置

### 2.1 `deploy/windows/config.ps1`

```powershell
Copy-Item deploy\windows\config.example.ps1 deploy\windows\config.ps1
notepad deploy\windows\config.ps1
```

必须改的项：`IndexTtsDir`、`IndexTtsArgs`（按这个 fork 的实际启动方式，默认 `python webui.py --host 0.0.0.0 --port 7860`）、`LlamaServerExe`、`LlamaModel`、`LiveKitExe`；启用 HTTPS 时还有 `CaddyExe`。其余项（conda 路径、环境名、端口、局域网 IP）默认值已按这台主机填好。

### 2.2 `apps/agent/.env`

```powershell
Copy-Item apps\agent\.env.example apps\agent\.env
notepad apps\agent\.env
```

部署到 Windows 时改成：

```ini
# Agent 与 LiveKit 同机，用 127.0.0.1 而不是 localhost（避免先解析到 ::1）
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
# 发给浏览器的 LiveKit 地址，必须是局域网能访问的地址，不能是 localhost
LIVEKIT_PUBLIC_URL=ws://192.168.31.82:7880
# 启用 HTTPS（第 8 节）后改成：
# LIVEKIT_PUBLIC_URL=wss://192.168.31.82:7443
TOKEN_SERVER_HOST=0.0.0.0
TOKEN_SERVER_PORT=8787
TOKEN_SERVER_CORS_ORIGIN=*
TOKEN_TTL=1h
# 对话链路（默认 AGENT_PIPELINE=conversation）：模型服务都在本机
ASR_URL=http://127.0.0.1:8100
LLM_BASE_URL=http://127.0.0.1:8080/v1
TTS_GRADIO_URL=http://127.0.0.1:7860
# 角色音色参考音频（不入库），例如 IndexTTS WebUI 的默认参考 vo-10s.wav 的本机副本
TTS_REF_AUDIO=C:\path\to\ref.wav
```

### 2.3 `apps/web/.env`

```powershell
Copy-Item apps\web\.env.example apps\web\.env
```

把 `TOKEN_SERVER_URL` 改成 `http://127.0.0.1:8787`，其余保持默认（`VITE_TOKEN_ENDPOINT=/api/token` 经 vite 的 `/api` 代理转发到 token 服务，浏览器不跨域）。

### 2.4 运行方式的选择

- **Agent 与 token 服务用 tsx 直接跑 TypeScript（`pnpm run start` / `pnpm run start:token`），不先编译成 JS。** 原因：workspace 包（如 `@ptoy/segmenter`）导出的是 `.ts` 源码，`apps/agent` 的 tsconfig 是 `noEmit` + Bundler 解析，要产出可运行的 JS 得额外引入打包步骤；tsx 的转译成本只在进程启动时付一次（亚秒级）。`start` 是 LiveKit Agents 的生产模式：预热空闲的 job 进程（tsx 的 loader 会经 `execArgv` 传给子进程），所以每次来电不会再付冷启动成本；同时开启 `:8081` 健康检查端口。`apps/agent/package.json` 里已有这两个脚本，本次没有改动。
- **网页用 `vite build` 的产物 + `vite preview`（:4173）。** 单用户局域网应用，`vite preview` 足够，而且 `vite.config.ts` 已为 preview 配好 `/api` 代理。要热更新调试时把 `WebMode` 改成 `'dev'`（:5173）。

## 3. 启动

### 3.1 一键启动（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\start-all.ps1
```

- 按 IndexTTS → llama-server → ASR → LiveKit → token → Agent → 网页（→ Caddy）的顺序，每个服务开一个独立窗口，等上一个健康检查通过后再起下一个。
- 端口已在监听的服务会跳过，所以某一步失败时修好后直接重跑即可。
- llama-server 就绪后会检查日志里的 `offloaded X/Y layers to GPU`，不是 37/37 就报红并停止。
- 最后打印 `check.ps1` 的状态表。
- 跳过某些服务：`start-all.ps1 -Skip indextts,llama`。

IndexTTS 首次加载模型可能要几分钟（默认最多等 600 秒，`IndexTtsTimeoutSec`）。

### 3.2 手动逐个启动

每条命令开一个新的 PowerShell 窗口执行，**必须等上一个就绪再执行下一个**：

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\start-indextts.ps1   # 1. 等 WebUI 能打开
powershell -ExecutionPolicy Bypass -File deploy\windows\start-llama.ps1      # 2. 等 /health 为 ok，确认 37/37
powershell -ExecutionPolicy Bypass -File deploy\windows\start-asr.ps1        # 3. 等 "model ready"
powershell -ExecutionPolicy Bypass -File deploy\windows\start-livekit.ps1    # 4.
powershell -ExecutionPolicy Bypass -File deploy\windows\start-token.ps1      # 5.
powershell -ExecutionPolicy Bypass -File deploy\windows\start-agent.ps1      # 6. 等 "registered worker"
powershell -ExecutionPolicy Bypass -File deploy\windows\start-web.ps1        # 7.
```

每个脚本做的事（也可以照着手敲）：

| 服务 | 实际命令 |
|---|---|
| IndexTTS | `conda activate indextts`；在 `IndexTtsDir` 下执行 `python webui.py --host 0.0.0.0 --port 7860` |
| llama-server | `docs/architecture/server.md` 第 5 节的完整命令，外加 `--log-file deploy\windows\logs\llama-server.log` |
| ASR | `conda activate ptoy-asr`；在 `services\asr` 下 `$env:ASR_PORT=8100; python -m asr_service` |
| LiveKit | `livekit-server.exe --dev --bind 0.0.0.0 --node-ip 192.168.31.82` |
| token | 在 `apps\agent` 下 `$env:NODE_ENV='production'; pnpm run start:token` |
| Agent | 在 `apps\agent` 下 `$env:NODE_ENV='production'; pnpm run start` |
| 网页 | 在 `apps\web` 下 `pnpm exec vite preview --host 0.0.0.0 --port 4173 --strictPort`（没有 `dist\` 时先 `pnpm run build`） |

所有服务窗口都会设置 `NO_PROXY=localhost,127.0.0.1,::1,192.168.31.82`（见第 10.4 节）。

## 4. 健康检查

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\check.ps1
```

逐项打印 OK / DOWN（绿 / 红），附 GPU 显存占用；全部正常时退出码为 0。

手动检查（PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 的别名，所以要写 `curl.exe`；`--noproxy '*'` 避免走代理）：

```powershell
curl.exe --noproxy '*' -s -o NUL -w "%{http_code}`n" http://127.0.0.1:7860/   # IndexTTS -> 200
curl.exe --noproxy '*' http://127.0.0.1:8080/health                            # {"status":"ok"}
Select-String -Path deploy\windows\logs\llama-server.log -Pattern 'offloaded'   # offloaded 37/37 layers to GPU
curl.exe --noproxy '*' http://127.0.0.1:8100/health                            # {"status":"ok","model":"iic/SenseVoiceSmall"}
curl.exe --noproxy '*' http://127.0.0.1:7880                                   # OK
curl.exe --noproxy '*' http://127.0.0.1:8787/healthz                           # {"ok":true}
curl.exe --noproxy '*' -X POST http://127.0.0.1:4173/api/token                 # serverUrl 应为 ws://192.168.31.82:7880
curl.exe --noproxy '*' http://127.0.0.1:8081/                                  # OK（Agent 已连上 LiveKit）
nvidia-smi                                                                     # 显存约 13.8/16GB
```

LLM 冒烟（确认能生成、思考模式已关）：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8080/v1/chat/completions -Method Post -ContentType 'application/json' `
  -Body '{"messages":[{"role":"user","content":"hello"}],"max_tokens":16}' | Select-Object -ExpandProperty choices
```

ASR 冒烟：在 `services\asr` 下 `curl.exe --noproxy '*' -X POST -H "Content-Type: audio/wav" --data-binary "@tests\fixtures\zh_weather_3s.wav" http://127.0.0.1:8100/asr`。

从 Mac 检查局域网可达：`curl http://192.168.31.82:7880`（`OK`）、`curl -o /dev/null -w '%{http_code}\n' http://192.168.31.82:4173/`（200）。

## 5. 回声通话验证

浏览器只在 HTTPS 或 `localhost` 下允许使用麦克风。

Agent 默认运行完整对话链路（`AGENT_PIPELINE=conversation`：说完一句后 AI 用角色音色回答，页面显示双方字幕）；`transcribe` 只出用户字幕。只验证 WebRTC 链路、不依赖任何模型时，在 `apps\agent\.env` 里设 `AGENT_PIPELINE=echo` 再重启 Agent 窗口，下面的“听到自己的声音”针对的就是这个模式；验证完删掉这一行（或改回 `conversation`）。

- **在 Windows 主机本机**：打开 <http://localhost:4173>，戴耳机，点通话按钮，应能听到自己的声音；挂断后 Agent 窗口出现 `caller left, ending job`，再拨能重新连上。
- **在 Mac / 手机上**：走第 8 节的 HTTPS（<https://192.168.31.82:5443>）。只想在 Mac Chrome 上临时测一下时，可以在 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 里加入 `http://192.168.31.82:4173` 后重启 Chrome，再打开该地址（LiveKit 仍是 `ws://`，不冲突）。

## 6. 停止

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\stop-all.ps1
```

按启动的逆序关闭 `start-all.ps1` 打开的窗口（连同子进程），再结束仍占用服务端口的进程。也可以在各窗口里按 `Ctrl+C`。只重启 llama-server 时：在它的窗口里 `Ctrl+C`，再执行 `start-llama.ps1`（IndexTTS 保持运行即可，顺序仍然正确）。

## 7. 更新

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\stop-all.ps1
powershell -ExecutionPolicy Bypass -File deploy\windows\update.ps1     # git pull --ff-only + pnpm install --frozen-lockfile + 重建网页
powershell -ExecutionPolicy Bypass -File deploy\windows\start-all.ps1
```

- 只改了 `apps/agent` 时，不必停模型服务：关掉 token / Agent 窗口，执行 `update.ps1`，再执行 `start-all.ps1`（已在运行的服务会跳过）。
- `services/asr/requirements.txt` 有变化时，在 `ptoy-asr` 环境里重新 `pip install -r requirements.txt`。
- `.env.example` 有新增变量时，对照更新 `apps/agent/.env`、`apps/web/.env`；`config.example.ps1` 有新增项时，对照更新 `config.ps1`。

## 8. 手机 / 局域网其他设备用 HTTPS（Caddy）

推荐 Caddy 反向代理，不用 mkcert + Vite https。原因：页面一旦是 HTTPS，浏览器就会拦截它发往 `ws://` 的 LiveKit 连接（混合内容），所以 LiveKit 信令也必须是 `wss://`；Caddy 一个进程同时给网页和 LiveKit 套 TLS，用的是自带的本地 CA，不用改应用代码。WebRTC 媒体（UDP 7882）本身已加密，不经过 Caddy。

```
https://192.168.31.82:5443  ->  http://127.0.0.1:4173（网页，/api 再由 vite 代理到 token 服务）
https://192.168.31.82:7443  ->  ws://127.0.0.1:7880（LiveKit 信令，对外是 wss）
```

步骤：

1. 安装 Caddy（第 1.2 节），`config.ps1` 里设 `EnableHttps = $true`，确认 `CaddyExe`。
2. `apps/agent/.env` 里设 `LIVEKIT_PUBLIC_URL=wss://192.168.31.82:7443`，重启 token 服务。
3. 执行 `start-all.ps1`（或单独 `start-caddy.ps1`）。Caddy 首次启动会生成本地 CA，根证书在 `%APPDATA%\Caddy\pki\authorities\local\root.crt`。
4. 让每台访问设备信任这个根证书（只需一次，CA 有效期 10 年）：
   - iPhone：把 `root.crt` 发到手机（隔空投送 / 邮件）→ 安装描述文件 → **设置 → 通用 → 关于本机 → 证书信任设置**里打开完全信任。
   - Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书。
   - Mac：双击导入“钥匙串访问”的“系统”钥匙串，设为“始终信任”。
5. 手机打开 <https://192.168.31.82:5443>，拨打。

启用 HTTPS 后，所有非本机设备都用 HTTPS 地址；Windows 本机仍可用 <http://localhost:4173>（它拿到的 LiveKit 地址也会是 `wss://192.168.31.82:7443`，本机也需导入根证书，或在本机临时把 `LIVEKIT_PUBLIC_URL` 改回 `ws://`）。

## 9. 重启后恢复

主机重启并登录后执行 `start-all.ps1`，再看 `check.ps1` 全绿即可。想登录后自动拉起（服务窗口需要桌面会话，所以用“登录时”触发）：

```powershell
$repo = 'D:\Resources\MyWorkspace\ai\ptoy'   # 改成实际仓库路径
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\deploy\windows\start-all.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT30S'   # 等网络和显卡驱动就绪
Register-ScheduledTask -TaskName 'ptoy start-all' -Action $action -Trigger $trigger
# 取消：Unregister-ScheduledTask -TaskName 'ptoy start-all' -Confirm:$false
```

## 10. 故障排查

### 10.1 端口被占用

现象：`start-all.ps1` 显示 `already listening` 却连不上，或服务启动报 `address already in use` / `bind`。

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }
Get-NetUDPEndpoint -LocalPort 7882 | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

是残留的旧进程就执行 `stop-all.ps1`（或 `Stop-Process -Id <pid>`）；是别的软件占用就在 `config.ps1` 里换端口（LiveKit 的 7880/7881/7882 是 `--dev` 固定的，只能让出）。

### 10.2 llama-server 没有全部放到 GPU（不是 37/37）

现象：`start-all.ps1` 报 `PARTIAL GPU OFFLOAD`，或生成速度明显低于约 97 tok/s。也可能直接启动失败，日志里有 `out of memory` / `cudaMalloc failed`（设了“首选无系统内存回退”后，显存不足就会这样直接报错，这是预期行为）。

1. `nvidia-smi` 看谁在占显存：浏览器硬件加速、游戏、上一次没退干净的 `llama-server.exe` / `python.exe`。
2. 确认 IndexTTS 只起了一份（WebUI 和阶段 2 的 FastAPI 不能同时跑）。
3. 确认 NVIDIA 控制面板的系统内存回退策略还是“首选无系统内存回退”。
4. 关掉 llama-server 窗口，释放显存后重新 `start-llama.ps1`。

不要靠调小 `-ngl` 或改用自动适配来“修好”它（ADR 0005）；确实需要改参数时，先用 `bench/bench_gpu.py` 在本机重新压测，并同步改 `docs/architecture/server.md`。

### 10.3 防火墙

- 从 Mac 测试 TCP：`nc -vz 192.168.31.82 7880`、`nc -vz 192.168.31.82 4173`。
- 查看放行规则：`Get-NetFirewallRule -DisplayName 'ptoy*' | Select-Object DisplayName, Enabled, Action`。
- 查找弹窗时点了取消生成的阻止规则（常见于 `node.exe`、`python.exe`、`livekit-server.exe`），删掉或改为允许：

  ```powershell
  Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True |
    Where-Object { $_.DisplayName -match 'node|python|livekit|llama|caddy' } |
    Select-Object DisplayName, Profile
  # 确认后：Remove-NetFirewallRule -DisplayName '<上面列出的名字>'
  ```

- 通话能接通（状态变成“通话中”）但听不到声音：多半是 UDP 7882 不通（会回退到 TCP 7881，也不通就没有媒体），或 LiveKit 向浏览器通告了错误的 IP。确认 `config.ps1` 里 `LiveKitNodeIp` 是本机的局域网 IP（主机有 Hyper-V / WSL / VPN 虚拟网卡时尤其要设）。

### 10.4 代理环境变量导致本机调用失败

现象：IndexTTS 启动时报 `When localhost is not accessible, a shareable link must be created`；或 `gradio_client` / `httpx` 调 `:7860` 时出现 `ConnectError`、502、超时；或 `curl` 本机地址返回代理的错误页。

原因：设置了 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，或开着代理软件的“系统代理”（Python 在 Windows 上没有代理环境变量时会读注册表里的系统代理），连 `localhost` 的请求也被发给了代理。

处理：

- 脚本打开的窗口已自动设置 `NO_PROXY=localhost,127.0.0.1,::1,192.168.31.82`。只要存在任一 `*_proxy` 环境变量，Python 就不再读注册表里的系统代理，所以这一项同时解决两种情况。
- 仍不行：`config.ps1` 设 `ClearProxyEnv = $true`，让服务窗口完全不带代理变量。
- 手动启动服务时先执行 `$env:NO_PROXY='localhost,127.0.0.1,::1,192.168.31.82'; $env:no_proxy=$env:NO_PROXY`。
- 代理软件开了 TUN / 虚拟网卡模式时，环境变量管不到，要在代理规则里让 `127.0.0.1`、`192.168.0.0/16` 直连，或关掉 TUN。
- Mac 上调用 Windows 服务（如 `services/fillers/generate.py`）同理：`export NO_PROXY=192.168.31.82`。

### 10.5 浏览器端

- “麦克风权限被拒绝 / 非安全上下文”：页面不是 HTTPS 也不是 localhost，见第 5、8 节。
- HTTPS 页面一直“连接中”，控制台有 `Mixed Content` 或 `wss` 证书错误：`LIVEKIT_PUBLIC_URL` 还是 `ws://`，或设备还没信任 Caddy 根证书（先在手机浏览器里直接打开 <https://192.168.31.82:7443>，应不再提示证书不受信任）。
- “无法连接到 LiveKit 服务器”：`POST /api/token` 返回的 `serverUrl` 是 `ws://localhost:7880` 时，说明 `LIVEKIT_PUBLIC_URL` 没设，改好后重启 token 服务。

### 10.6 其他

- token 服务 / Agent 连不上 `localhost`：Node 可能先把 `localhost` 解析成 IPv6 `::1`，而服务只监听 IPv4。`.env` 里一律写 `127.0.0.1`（第 2.2、2.3 节）。
- Agent 窗口一直没有 `registered worker`、`:8081` 返回 `not connected to livekit`：LiveKit 没起，或 `LIVEKIT_URL` / key / secret 不对（`--dev` 固定为 `devkey` / `secret`）。
- 脚本报“无法加载，因为在此系统上禁止运行脚本”：执行第 1.1 节的 `Set-ExecutionPolicy`，或像本文一样用 `powershell -ExecutionPolicy Bypass -File ...` 调用。
- 每个服务的输出都留在各自窗口里；llama-server 另有日志文件 `deploy\windows\logs\llama-server.log`（每次启动覆盖）。
