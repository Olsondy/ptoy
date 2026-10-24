# Ubuntu 云端部署

本目录提供与 Web 入口解耦的 ptoy 专用 systemd 服务与发布工具。**已有 Web 服务时复用；没有时使用 Caddy**，不要求安装 LiteSpeed。当前临时服务器保留 LiteSpeed 和 PHP 应用。脚本不自动改写 Web 入口、防火墙、Tailscale 或原本地启动方式；没有备份、对象存储或灾难恢复设施。

**当前 HK 实例已上线，使用 [hk/README.md](hk/README.md)**：源码 `/opt/ptoy/source`，环境文件 `apps/agent/.env.hk`，服务通过 `--env hk` 启动，复用 `livekit-server.service`。本目录不保存另一份 HK `.env`，本地 `.env` 不变。

下文是原有通用安装器的另一套部署布局，读取 `/etc/ptoy/app.env` 和 `/etc/ptoy/livekit.yaml`。它不是当前 HK 的更新入口；不要直接在该主机运行旧 `install.sh` / `release.sh`。当前版本、路径及验证结果以 [server.md](../../docs/architecture/server.md#9-运维注意) 为准。

## 准备

在 Ubuntu 上准备源码、Node **22.13 或更高版本**、pnpm **10.18.0**、指定版本的 LiveKit Server，以及 `rsync`、`curl`、`flock`、`ss`。Node/pnpm/LiveKit 放在 root 管理的系统可执行目录；不能使用 `/root` 或 `/home` 下的个人 nvm 路径，也不能通过系统目录的符号链接绕回个人目录。安装器会校验可执行路径及版本，不下载或替换这些程序。

Ubuntu 与本地 Windows 均需登录同一 Tailscale 网络，现有连接可直接沿用。模型服务仍在 Windows：ASR 8001、LLM 8080、FastAPI TTS 8002，端口不同则修改 settings。朋友的浏览器不需要 Tailscale。

下载与安装依据：[Node](https://nodejs.org/en/download)、[pnpm 指定版本](https://pnpm.io/installation)、[LiveKit Releases](https://github.com/livekit/livekit/releases)、[Tailscale Ubuntu/Linux](https://tailscale.com/docs/install/linux)。选定的 LiveKit 版本须填写到 settings，不使用未经审查的远程一键安装脚本。

## 首次部署

以下命令在服务器的 **Linux 源码目录**执行，示例 `/usr/bin/node` 按实际系统路径替换。不会连接服务器代你执行这些命令。

### 1. 填配置并安装专用服务

```bash
sudo install -m 0600 deploy/cloud/settings.env.example /root/ptoy-settings.env
sudoedit /root/ptoy-settings.env
sudo bash deploy/cloud/install.sh /root/ptoy-settings.env /usr/bin/node
```

必填：`APP_DOMAIN`、`RTC_DOMAIN`、`PUBLIC_IPV4`、`MODEL_HOST`、`DEFAULT_CHARACTER`、运行时路径及 `LIVEKIT_VERSION`。公网 IP 与 Tailscale IP 不能混用。示例域名/IP/版本会被拒绝；`MODEL_HOST` 填 Windows 的 Tailscale IPv4 或完整 `*.ts.net` 名称。`LLM_MODEL` 与模型服务保持一致。

安装器创建专用用户、目录、配置和三个 systemd 单元，**此时不启动服务**。应用密钥首次随机生成，重跑安装不会轮换；如果已有配置或单元不同会停止，避免覆盖。首次创建数据库时默认维护状态，只有发布就绪后才开放拨号。

生成配置在 `/etc/ptoy/app.env` 与 `/etc/ptoy/livekit.yaml`；不要提交到 Git。后续配置变更需先进入维护并排空通话，再人工核对修改，不在运行中直接轮换密钥。

### 2. 放置角色和预录音频

将已有角色目录、fillers 目录上传到服务器的独立暂存位置，再显式指定：

```bash
sudo bash deploy/cloud/resources.sh /srv/ptoy-input/characters /srv/ptoy-input/fillers /usr/bin/node
```

角色目录需要 `_rules.md` 和 settings 中默认角色对应的文件；fillers 对应原有音色资源，可为空目录。脚本不会默认读取仓库真实角色，也不会上传模型权重或 TTS 参考音频。实际资源同步会读取你明确指定的目录内容。

### 3. 构建与启动

```bash
sudo bash deploy/cloud/release.sh "$PWD" 20261024-1 /usr/bin/node
```

发布编号每次使用新值。脚本复制源码，排除 `.env`、数据库、Windows 依赖和私有角色资源，在 Linux 安装锁定依赖并构建，再加载原生 VAD 执行一帧合成静音推理，失败时不切换旧服务。源码不必已提交，但不得把 Windows 的 `node_modules` 当作 Linux 运行依赖。

Token、LiveKit 和 Agent 自身健康就绪后，发布解除维护。模型离线时网页与邀请码仍可访问，页面显示模型暂不可用；模型恢复后自动允许新通话，不需要再次解除维护。

### 4. 选择 Web 入口并接通公网音频

前三步适用于两种接法，不需要修改应用脚本：

- **已有 Web 服务**：在原入口增加网页/API 与 RTC 信令两个域名。当前服务器按 [LiteSpeed 接入说明](litespeed/README.md)选择模板，保留 PHP 虚拟主机、监听和证书。已有 Nginx/Apache 等也可复用，按下方契约配置，无需再装 LiteSpeed 或 Caddy。
- **没有 Web 服务**：按 [Caddy 接入说明](caddy/README.md)安装并应用独立配置，提供网页、反代与 HTTPS 证书。

统一接入契约：网页根目录 `/var/www/ptoy/current`；仅 `/api/` 转发到 `127.0.0.1:8787` 并保留路径前缀；`/internal` 及其子路径不公开；RTC 域名的 HTTP/WebSocket 转发到 `127.0.0.1:7880`。不缓存 API，代理需正确覆盖/附加客户端地址头，仅信任实际回环代理来源。模板均不自动覆盖旧站配置。

| 端口 | 用途与范围 |
|---|---|
| 80/443 | 已有 Web 服务或新装 Caddy 管理，按所选方式配置两个域名与证书 |
| UDP 7882、TCP 7881 | 新增公网音频入口；在云安全组与主机防火墙检查放行 |
| TCP 7880、8787、8081 | 仅本机 LiveKit HTTP、Token API 和 Agent 健康检查，不公开 |

本期不提供 TURN/TLS 443；部分公司网络/VPN可能无法通话。部署脚本不自动变更防火墙，也不抢占旧站入口。

## 更新与日常命令

更新源码后，在该源码目录使用新发布编号再次运行 `release.sh`。脚本先构建，然后启用维护、等待所有通话与清理结束，再切换应用和网页版本。默认等 600 秒，超时退出并保持维护，不强制挂断；可用第四参数调整等待秒数。

```bash
# 只看维护、通话数量与模型就绪状态，不输出密钥
sudo /usr/bin/node deploy/cloud/ops.mjs status

# 手动维护、排空及恢复（均调用带内部鉴权的本机接口）
sudo /usr/bin/node deploy/cloud/ops.mjs maintenance-on
sudo /usr/bin/node deploy/cloud/ops.mjs wait-drain
sudo /usr/bin/node deploy/cloud/ops.mjs maintenance-off

systemctl status ptoy-livekit ptoy-token ptoy-agent
sudo journalctl -u ptoy-token -u ptoy-agent -n 80 --no-pager
```

发布失败不会自动回退数据库或强杀通话。修复报告的问题后用新的发布编号重试；旧代码目录保留，数据与代码分开。资源更新会进入维护并停止已排空的 Agent，随后同样运行一次新版本发布完成启动。

邀请码管理直接使用同一持久数据库：

```bash
cd /opt/ptoy/current/apps/agent
sudo -u ptoy /usr/bin/node --env-file=/etc/ptoy/app.env node_modules/tsx/dist/cli.mjs src/access/cli.ts create "朋友备注"
sudo -u ptoy /usr/bin/node --env-file=/etc/ptoy/app.env node_modules/tsx/dist/cli.mjs src/access/cli.ts list
sudo -u ptoy /usr/bin/node --env-file=/etc/ptoy/app.env node_modules/tsx/dist/cli.mjs src/access/cli.ts revoke INVITE_ID
```

创建命令仅此时显示邀请码明文，将它私下发给对应朋友。日常状态、列表和部署输出不包含密钥或邀请码明文。

## 文件位置

| 路径 | 内容 |
|---|---|
| `/opt/ptoy/releases/`、`/opt/ptoy/current` | 版本化应用代码 |
| `/var/www/ptoy/releases/`、`/var/www/ptoy/current` | 单独复制的网页构建结果，不暴露源码或密钥 |
| `/etc/ptoy/` | 受权限保护的应用环境和 LiveKit 配置 |
| `/var/lib/ptoy/access.sqlite` | 邀请、会话、通话占用和维护状态，更新不删除 |
| `/var/lib/ptoy/resources/` | 私有角色与 fillers |
| `/usr/local/lib/ptoy/` | root 管理的服务启动与运维工具 |

## 上线检查

有旧站时确认其页面和登录仍正常；两个新域名的证书有效；未验证不能访问角色或拨号，`/internal/`不能从公网到达。用家庭 Wi-Fi 和手机流量分别完成邀请码验证、通话、字幕及挂断，再检查固定角色链接、同码两设备忙碌提示、模型离线/恢复与维护排空。

当前临时服务器为 2 核 4 GiB，与 PHP 共用；换机器时重新检查可用资源。3–5 人容量需在目标服务器逐步实测，本地真实 LiveKit/echo 测试不能替代公网媒体及实际模型的验收。此处通用安装器没有用于当前 HK；当前实例的验证范围见上方状态链接。

如果公网 IP 不在服务器网卡上而是供应商 NAT 映射，必须验证同机 Agent 到 LiveKit 的音频链路；健康接口成功不代表 NAT 回环可用。若该链路失败，再针对固定 LiveKit 版本验证内部候选地址配置（如 `advertise_internal_ip`）并排除 Tailscale 媒体候选，不盲目改成仅广播 Tailscale 地址。

## 本地验证记录

已通过 9 项 Linux 隔离测试、Bash 语法检查、临时目录内的 systemd 单元校验，以及本机现有原生包的 VAD 静音推理。隔离测试不会安装服务、连接模型或读取真实角色。复现脚本测试可在带 Node 22.13+ 与 systemd 工具的 Linux 环境运行：

```bash
node --test deploy/cloud/configure.test.mjs deploy/cloud/release.test.mjs
```

目标服务器的原生依赖由 `release.sh` 再做真实预检。首次接入新服务器时仍需按所选 Caddy 或 LiteSpeed 的说明完成配置校验，再做真实 HTTPS、WebSocket 和音频验收；当前 HK 的 OpenLiteSpeed 模板已加载验证。
