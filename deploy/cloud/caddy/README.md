# 没有现有 Web 服务时使用 Caddy

此接法适用于 80/443 没有被其他 Web 服务占用的 Ubuntu 服务器。应用的安装、资源上传和发布仍按[上级说明](../README.md)执行，Caddy 只负责 HTTPS 入口。已有 LiteSpeed、Nginx、Apache 或 Caddy 站点时复用原入口，不能用本示例覆盖其他站点。

## 接入

1. 用 `sudo ss -lntup` 确认 80/443 可用。按 [Caddy 官方 Ubuntu 安装说明](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)安装发行包及其 systemd 服务。
2. 将 settings 中 `APP_DOMAIN` 和 `RTC_DOMAIN` 对应的两个域名解析到云服务器；有 AAAA 记录时也须指向可达的 IPv6。先用 DNS 直连。在安全组及防火墙放行 TCP 80/443，以及语音需要的 UDP 7882、TCP 7881。
3. 将本目录 `Caddyfile.example` 复制到暂存文件，替换 `voice.example.com`、`rtc.example.com` 为 settings 中的实际域名。占位符不会自动读取 settings；不要将包含密钥的 `/etc/ptoy/app.env` 导入 Caddy。

```bash
cp deploy/cloud/caddy/Caddyfile.example /tmp/ptoy-Caddyfile
# 在编辑器中填写两个实际域名
nano /tmp/ptoy-Caddyfile
caddy fmt --overwrite /tmp/ptoy-Caddyfile
caddy validate --config /tmp/ptoy-Caddyfile --adapter caddyfile
```

4. 确认 `/etc/caddy/Caddyfile` 仍是新安装的默认欢迎页配置，没有承载其他站点后，再应用：

```bash
sudo install -o root -g root -m 0644 /tmp/ptoy-Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
rm /tmp/ptoy-Caddyfile
```

Caddy 按域名自动申请并续期证书，域名与公网端口必须可达。无需另建证书脚本，具体行为见[自动 HTTPS](https://caddyserver.com/docs/automatic-https)与[服务管理](https://caddyserver.com/docs/running)。应用发布只切换静态目录链接，不需要每次重载 Caddy；修改入口配置时应在维护窗口操作。

## 路由与检查

- 网页从 `/var/www/ptoy/current` 提供；该目录由发布工具生成，Caddy 用户可读，不需要访问应用源码或密钥。
- `/api/` 保留原前缀代理到 Token 服务。使用 `handle`，不要改成会剥前缀的 `handle_path`；`/internal` 及子路径返回 404。其他未知路径按静态文件返回 404，固定角色链接使用查询参数，不需要 SPA 全路径回写。
- RTC 域名代理到 LiveKit，`reverse_proxy` 原生处理 WebSocket 升级。应用使用 `wss://` 公网域名，回环后端使用 HTTP/WS。
- Caddy 默认处理 `X-Forwarded-For`，本模板未配置外层代理信任；应用仅信任实际回环代理来源。若加入 CDN，需要另行核对完整代理链。

配置依据：[handle](https://caddyserver.com/docs/caddyfile/directives/handle)、[reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

用实际域名检查：

```bash
curl -fsS https://voice.example.com/api/session
curl -sS -o /dev/null -w '%{http_code}\n' https://voice.example.com/internal/ops/status
```

未验证时前者应返回 `authenticated: false`，后者应为 404。随后完成上级说明中的邀请码、真实通话与两类网络验收；HTTP 健康成功不能代替 WSS 与音频验证。本配置不提供 TURN/TLS 443。
