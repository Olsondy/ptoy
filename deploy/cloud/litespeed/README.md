# 将 ptoy 接到现有 LiteSpeed

这些文件只供新增 ptoy 虚拟主机使用，部署脚本不会写入 LiteSpeed 配置、重启 LiteSpeed 或改动 PHP。实际 LiteSpeed 版本/面板未知，选择匹配的一套模板，不混用 OpenLiteSpeed 和 Enterprise 的语法。

## 两个新增子域名

- `APP_DOMAIN`：语音网页及 `/api/`，文档根目录 `/var/www/ptoy/current/`。
- `RTC_DOMAIN`：LiveKit 的 HTTP/WebSocket 信令。

两个域名都解析到云服务器公网 IP，并使用现有证书管理方式签发证书；先使用 DNS 直连，不套未经验证的 CDN 代理。沿用原来的 HTTPS 监听，仅增加两个域名映射。原 PHP 域名、虚拟主机、监听和证书保持原配置；不要替换默认虚拟主机或添加抢占 443 的 Caddy/Nginx。

## OpenLiteSpeed

1. 在 WebAdmin/现有面板中新增 `ptoy-app` 与 `ptoy-rtc` 虚拟主机，配置独立证书和域名，使用 `openlitespeed-app.conf.example`、`openlitespeed-rtc.conf.example` 中的对应字段。将 `APP_DOMAIN`/`RTC_DOMAIN` 替换为实际域名。若面板会重写配置，通过面板维护，不能覆盖其生成文件。
2. `ptoy-app`：Web Server External App 指向 `127.0.0.1:8787`，Proxy Context URI 为 `/api/`；其余请求由静态目录提供。不要把 URI `/` 代理给 Token 服务，也不要剥掉 `/api` 前缀。
3. `ptoy-rtc`：Web Server External App 与 Proxy Context `/` 指向 `127.0.0.1:7880`；另加 **WebSocket Proxy**，URI `/`、Address `127.0.0.1:7880`。仅设置 HTTP Context 不够。
4. 将两个新虚拟主机映射到已有 HTTPS Listener。HTTP Listener 如用于证书验证，按现有面板方式增加域名映射；不要删掉现有映射。关闭新虚拟主机的 LSCache，避免缓存会话/通话状态。
5. 用该版本提供的配置检查确认无错误，再通过现有管理方式 graceful reload。不要让脚本猜测或替换整份 `httpd_config.conf`。

后端使用回环 HTTP/WS，TLS 由 LiteSpeed 终止；OpenLiteSpeed 不要求后端启用 WSS。官方依据：[HTTP 反代](https://docs.openlitespeed.org/config/reverseproxy/)、[WebSocket 代理](https://docs.openlitespeed.org/config/reverseproxy/websocket/)。

## LiteSpeed Enterprise

通过现有面板创建两个新 TLS 虚拟主机，并添加对应 `enterprise-*.include.conf.example`。这是 Apache-compatible vhost **include**，不是 `.htaccess`、不是完整 server 配置。证书、监听、配置重建和 reload 都沿用已有面板。

App include 只代理 `/api/`；RTC include 同时处理 HTTP 与 WebSocket。关闭两个新虚拟主机的 LSCache。如果是 Enterprise 原生配置模式而非 Apache-compatible 模式，请在 WebAdmin 建等价 External App/Context 和 WebSocket Proxy，不直接粘贴 Apache 语法。[Enterprise 反代](https://docs.litespeedtech.com/lsws/cp/cpanel/rewrite-proxy/)、[WebSocket 配置](https://docs.litespeedtech.com/lsws/cp/cpanel/websocket-proxy/)。

## 接通后检查

在正常证书校验下执行，域名用实际值替换；不使用 `curl -k`。

```bash
curl -fsS https://voice.example.com/api/session
curl -sS -o /dev/null -w '%{http_code}\n' https://voice.example.com/internal/ops/status
```

第一项在未验证时应返回 `authenticated: false`，第二项应为 403/404，不能到达内部管理接口。再打开网页完成邀请码验证与真实通话；验证 `rtc` 域名的 WebSocket 升级，以及手机流量和家庭 Wi-Fi 音频。网页使用查询参数固定角色，不需要将未知 URL 全部回写为 `index.html`。

最后检查原 PHP 页面及其登录流程仍可用。新增端口是 UDP 7882、TCP 7881；8787、7880、Agent 健康端口不对公网开放。此版本不配置 TURN/TLS 443 回退；HTTPS 页可打开不代表所有受限网络均能通话。

客户端 IP 由 LiteSpeed 附加/覆盖转发头，`ACCESS_TRUSTED_PROXY_IPS` 只列它的实际回环来源。不要原样透传外部伪造的 `X-Forwarded-For`，也不要信任任意 IP；若另有 CDN/代理，先验证代理链后再扩展精确白名单。
