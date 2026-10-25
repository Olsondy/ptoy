# @ptoy/e2e · 前端冒烟测试

Playwright 用 Chrome 假麦克风（`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`）打开页面，验证：

开始通话 → `通话中` → Agent 进房（页面出现并播放 Agent 的回声音轨）→ 挂断 → `已断开`

通话冒烟测试断言状态、按钮、错误提示与回声音轨播放。UI 用例另外覆盖：

- 角色菜单键盘选择、Escape 关闭、焦点恢复、保存选择及手机窄屏。
- 固定角色链接生成与复制、刷新后锁定、连续拨号、保留主页选择；无效/重复/空链接及服务异常禁止拨号；剪贴板失败时提供可复制链接。
- 发送 `lk.transcription` 流验证双方字幕、分段修订、字幕开关、重新显示最新发言、错误提示独立显示与挂断清空。
- 截图保存于 `test-results/`，用于检查桌面、手机、角色菜单及紧凑控制栏。截图内的对话由测试夹具生成，不调用 GPU 模型。

测试夹具复用 Agent 已有的 `@livekit/rtc-node` 与 `livekit-server-sdk` 版本，作为本测试包的开发依赖；不进入前端产物。
角色目录固定为 `tests/e2e/fixtures/characters`，token 服务和 echo Agent 均不读取实际角色人设文件。

单独成包而不放进 `apps/web`：测试同时依赖 web、agent、token 服务和 LiveKit，属于跨应用的端到端测试；也让 Playwright 不进入 web 的依赖。脚本名是 `test:e2e` 而不是 `test`，所以默认的 `pnpm test` 不会跑它（它需要外部进程）。

## 前置条件

1. `pnpm install`
2. 浏览器（二选一）
   - Playwright 自带 Chromium：`pnpm --filter @ptoy/e2e exec playwright install chromium`
   - 本机 Google Chrome：`E2E_BROWSER_CHANNEL=chrome`。**macOS 12 必须用这个**，Playwright 已不再提供 mac12 的 Chromium。
3. LiveKit Server（二选一，必须与日常应用及其他测试运行隔离）
   - 设 `LIVEKIT_SERVER_BIN=<livekit-server 路径>`，测试自己启动 `--dev` 实例（默认端口 7890–7892，不与常规开发用的 7880 冲突）。未指定地址或二进制时，会依次查找仓库的 `deploy/windows/.run/livekit/` 和 `PATH`。
   - 或自行启动专用于本轮测试的 LiveKit，并显式设置 `LIVEKIT_URL`。不再默认复用 7880 上的日常服务；找不到二进制且未指定地址时直接报错。

   共享 LiveKit 会使未命名 Agent 参与同一轮自动分配。测试房间可能被日常 Agent 或另一轮测试 Agent 接走，无法向本轮 token 服务完成准入，页面便停留在“连接中”。字幕 UI 夹具手动创建 Agent，可能仍然通过，因此不能据此判断自动分配正常。

   获取 `livekit-server`：
   - Windows / Linux：从 [livekit/livekit Releases](https://github.com/livekit/livekit/releases) 下载对应平台的 zip / tar.gz，解压即用（Linux 也可 `curl -sSL https://get.livekit.io | bash`）
   - macOS 13+：`brew install livekit`
   - macOS 12 或其它：从源码构建（需要 Go）：`git clone https://github.com/livekit/livekit && cd livekit && go build -o livekit-server ./cmd/server`

token 服务、Agent（`dev` 模式）、Vite 由 Playwright `webServer` 每次全新启动、结束后关闭，不复用已在运行的开发服务器。

## 运行

在仓库根目录：

```bash
LIVEKIT_SERVER_BIN=/path/to/livekit-server E2E_BROWSER_CHANNEL=chrome pnpm test:e2e
```

一次约 15 秒（含启动全部服务；用例本身约 5 秒，其中 Agent 冷启动 2–3 秒）。失败时 trace 留在 `tests/e2e/test-results/`，用 `pnpm --filter @ptoy/e2e exec playwright show-trace <trace.zip>` 查看。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LIVEKIT_SERVER_BIN` | 自动查找仓库二进制和 `PATH` | 由测试启动独立 LiveKit dev server |
| `LIVEKIT_URL` | 自启时 `ws://localhost:7890` | 显式指定外部测试实例；同时设 BIN 时指定自启端口，RTC 用 +1 TCP / +2 UDP |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `devkey` / `secret` | 与 `--dev` 固定值一致 |
| `E2E_TOKEN_PORT` | `8730` | token 服务端口 |
| `E2E_WEB_PORT` | `5730` | Vite 端口 |
| `E2E_BROWSER_CHANNEL` | 未设（Playwright Chromium） | 如 `chrome`、`msedge` |
