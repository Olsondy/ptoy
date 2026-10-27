# HK 当前部署

采用宿主机 Node.js + systemd，复用已安装的 `livekit-server.service` 和 OpenLiteSpeed。布局与状态以 [server.md](../../../docs/architecture/server.md#9-运维注意) 为准；不要在当前主机直接执行父目录旧版 `install.sh` / `release.sh`。

- 源码：`/opt/ptoy/source`，从 GitHub 克隆，再同步尚未提交的工作区改动。
- 唯一应用环境文件：`/opt/ptoy/source/apps/agent/.env.hk`，`root:ptoy`、`0640`，不提交 Git。
- 单元：本目录 `ptoy-token.service`、`ptoy-agent.service` 安装到 `/etc/systemd/system/`，使用 `--env hk`；LiveKit 继续使用 `/etc/livekit/livekit.yaml`。
- `.env.hk` 还需填写 `APP_ORIGIN=https://网页域名` 和 `LIVEKIT_PUBLIC_URL=wss://信令域名`；`LIVEKIT_CONFIG` 指向的 LiveKit 配置必须使用相同的 API key/secret。Linux 可执行文件、角色资源目录及 Tailscale 链路须在服务器上准备好。生产环境不会自动用 `--dev` 启动 LiveKit。`pnpm app --env hk --check-env` 只检查配置选择及域名是否填写，不验证网络、模型服务或资源文件，也不代表已完成部署。
- 前端：`/var/www/ptoy/current` 只保存 `apps/web/dist`；数据库与角色资源在 `/var/lib/ptoy`。
- 配置中的 `ACCESS_MAINTENANCE_DEFAULT=true` 仅决定新建数据库的初始状态；运行状态通过运维 API 控制。

查看服务与模型就绪状态：

```bash
systemctl status ptoy-token ptoy-agent livekit-server
cd /opt/ptoy/source
sudo -u ptoy /usr/local/bin/node deploy/cloud/ops.mjs status apps/agent/.env.hk
```

**自动部署**：推送到 `main` 时（只改 `docs/`、`bench/` 或根目录说明文件除外），GitHub Actions `deploy-hk.yml` 通过 SSH 执行 [update.sh](update.sh)。也可以在 Actions 页面手动运行。脚本依次执行：`git reset --hard origin/main` → 安装依赖 → 类型检查 → 构建前端 → 同步 `dist` 和角色文件到 `/var/lib/ptoy/resources/characters` → 重启两个服务 → 健康检查。重启 Agent 时会等正在进行的通话结束。构建或类型检查失败时不重启服务，旧进程继续运行。服务器 `root` 的 `authorized_keys` 中，这把部署 key 被限制为只能执行 `update.sh`；私钥和 host key 分别保存在仓库 secrets `HK_DEPLOY_SSH_KEY`、`HK_SSH_KNOWN_HOSTS`。服务器源码目录不要保留未提交的改动，因为每次部署都会被覆盖。`.env.hk` 不在 Git 中，不受影响；新增环境变量仍需手动修改。

需要维护排空的完整手动更新：更新前先 `maintenance-on` 并 `wait-drain`，确认无通话后停止两个应用服务。保留 `.env.hk`、SQLite 及资源，在 Linux 安装锁定依赖、类型检查、构建并执行 `deploy/cloud/check-native.mjs`，随后更新静态产物、启动服务。健康检查及真实通话通过后执行 `maintenance-off`。更新代码前先核对服务器未提交改动，不能直接覆盖。

邀请码管理使用相同环境和持久数据库：

```bash
sudo -u ptoy /usr/local/bin/node scripts/run-agent.mjs invite --env hk create '朋友备注'
```

邀请码明文仅创建时显示，不写入仓库或公共网页。
