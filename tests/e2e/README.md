# @ptoy/e2e · 前端冒烟测试

Playwright 用 Chrome 假麦克风（`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`）打开页面，验证：

开始通话 → `通话中` → Agent 进房（页面出现并播放 Agent 的回声音轨）→ 挂断 → `已断开`

只断言用户可见的 DOM（`data-testid="call-status"` 的文本与 `data-status`、`call-toggle` 文案、`call-error` 不出现、`<audio>` 在播放）。

单独成包而不放进 `apps/web`：测试同时依赖 web、agent、token 服务和 LiveKit，属于跨应用的端到端测试；也让 Playwright 不进入 web 的依赖。脚本名是 `test:e2e` 而不是 `test`，所以默认的 `pnpm test` 不会跑它（它需要外部进程）。

## 前置条件

1. `pnpm install`
2. 浏览器（二选一）
   - Playwright 自带 Chromium：`pnpm --filter @ptoy/e2e exec playwright install chromium`
   - 本机 Google Chrome：`E2E_BROWSER_CHANNEL=chrome`。**macOS 12 必须用这个**，Playwright 已不再提供 mac12 的 Chromium。
3. LiveKit Server 二进制（二选一）
   - 设 `LIVEKIT_SERVER_BIN=<livekit-server 路径>`，测试自己启动 `--dev` 实例（默认端口 7890–7892，不与常规开发用的 7880 冲突）
   - 或先自行运行 `livekit-server --dev`，测试连 `LIVEKIT_URL`（默认 `ws://localhost:7880`）；连不上会直接报错提示

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
| `LIVEKIT_SERVER_BIN` | 未设 | 设了就由测试启动 LiveKit dev server |
| `LIVEKIT_URL` | 设了 BIN 时 `ws://localhost:7890`，否则 `ws://localhost:7880` | LiveKit 地址（自启时端口取自这里，RTC 用 +1 TCP / +2 UDP） |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `devkey` / `secret` | 与 `--dev` 固定值一致 |
| `E2E_TOKEN_PORT` | `8730` | token 服务端口 |
| `E2E_WEB_PORT` | `5730` | Vite 端口 |
| `E2E_BROWSER_CHANNEL` | 未设（Playwright Chromium） | 如 `chrome`、`msedge` |
