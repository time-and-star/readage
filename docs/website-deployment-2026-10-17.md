# 官网部署与安全防护：2026-10-17

目标：用户指定的 Ubuntu 24.04 服务器，正式入口 `https://readage.xyz`；`www` 统一跳转主域名。使用 SSH 密钥认证的 `ubuntu` 账号操作，不将密钥写入项目或网页。本文件不记录任何管理密钥。

## 范围与数据

仅部署独立 `website/`：首页、安装包下载链接、致谢、留言、书库、更新元数据与现有签名补丁下载协议。网站无需前端构建，不部署完整学习应用、模型、用户学习档案、`.env` 或更新签名私钥。HTML / releases.json 保留已真实发布的 Windows 0.1.2、Android 1.0.4 / build 5，不能把尚未发布的新源码版本当作可下载包。

用户明确授权将 506 本书、16 条杂志、资料数据库、空留言数据库及 Cookie 签名密钥迁移到该服务器。采用 SQLite backup API 的一致性快照，逐一核对 522 个资源版本的大小与 SHA-256；原本机数据保留。资料包为 1,389,905,920 字节，SHA-256 `9f77b13bd87baa3fac767e7c57e5ebd6eaae4c4992790ada46f4ed836988bdda`，本机快照与报告位于忽略目录 `tmp/website-deploy-2026-10-17/`。该包含私有数据，不应发布为公开下载。

## 实现

- Node 22 官方 Linux x64 发行包经官方 SHA-256 清单核对；当前安装 22.23.3。网站无第三方运行时 npm 依赖。
- NGINX 提供 TLS 1.2 / 1.3，HTTP 与 www 重定向，HSTS、安全响应头，拒绝未知 Host、私密路径和过大普通请求体；保留公开资料及更新 API 的应用访问，不加网页验证码。
- 每个 IP 普通请求 10/s（突发 40）；文件请求 2/s（突发 6）、每 IP 最多 4 个进行中的下载；管理接口 6/min（突发 4）、每 IP 1 个 / 全站 2 个并发。全站另有请求 / 连接限制。超额返回 429；阈值可按真实流量调整。
- NGINX 覆盖转发 IP，Node 只信任 127.0.0.1；不信任浏览器传入的 X-Forwarded-For。
- 文件 SHA-256 校验缓存按文件身份、大小、mtime 和 ctime 失效；同文件并发请求共用校验，最多两个不同文件同时做冷校验。改变或损坏的文件仍拒绝，失败不缓存，繁忙时 503 / Retry-After。完整下载、HEAD、单 Range、ETag 及客户端再次验摘要的协议保持。
- 服务使用无登录权限的 readage 系统用户，程序只读、仅持久数据可写；绑定 127.0.0.1:4175，内存 / CPU / 进程 / 文件数受限，失败自动重启，开机启动。
- 管理密钥由服务器随机生成，仅存根用户可读的 `/etc/readage/website.env`；上传仍需 Bearer 密钥，不写访问日志，不在页面中内嵌。密码只在官网上传页的内存使用。
- 主机防火墙仅允许 SSH / HTTP / HTTPS。SSH 保留已验证的 Ubuntu 密钥登录，关闭密码登录和 root 登录。
- 每日用 SQLite backup API 备份一致性数据库及 Cookie 密钥、全部历史资料文件，保留七天；备份只在服务器本地，不能替代异地备份。证书自动续期并在成功后重新加载 NGINX。

配置和可审阅脚本见 `website/deploy/`。此配置提供基础应用与主机防护，没有接入 CDN / WAF 或云端流量清洗；不能宣称抵御任意规模 DDoS。

## 运维位置

| 内容 | 服务器位置 |
| --- | --- |
| 当前程序 | `/srv/readage/current/website` |
| 历史程序目录 | `/srv/readage/releases/` |
| 持久数据 | `/var/lib/readage/` |
| 环境与管理密钥 | `/etc/readage/website.env`，root 0600 |
| 备份 | `/var/backups/readage/`，root 私有 |
| 主服务 | `readage-website.service` |
| 备份任务 | `readage-backup.timer` / `readage-backup.service` |
| 证书续期 | `certbot.timer`；成功后 deploy hook 重载 NGINX |
| NGINX 日志 | `/var/log/nginx/readage.access.log` / `readage.error.log` |

检查服务：`sudo systemctl status readage-website nginx`；服务日志：`sudo journalctl -u readage-website -n 80 --no-pager`。修改环境后需重启 Node 服务；修改代理配置先 `sudo nginx -t` 再 reload。上线目录和数据目录必须分开，后续换程序不能覆盖数据库或 Cookie 密钥。

首次迁移激活脚本会在发现已有持久数据库时停止，不可用于覆盖后续生产数据。后续更新应上传新版本代码到新目录、核对后切换 current 并重启，保留旧代码以便回退；数据不跟随代码回退。先备份，再做任何后续数据库迁移。

## 验收状态（部署进行中）

- 官网隔离回归 33/33（包括新文件缓存 / 并发 / 错误恢复 3 项）通过；官网 JS / Node 类型检查通过。首次沙箱执行因 realpath / 回环网络权限失败，经批准在隔离数据目录复测通过，没有写正式留言。
- Node、NGINX、UFW 已就绪。两个域名证书签发成功，证书到期日 2027-01-15，自动续期任务已启用。
- 现有本地官网实际打开书库、搜索“傲慢与偏见”，显示 1 / 506、中文标题与作者、EPUB 下载入口；360px 无页面和面板横向溢出。
- 数据包上传、服务激活、全部远端文件校验、首份备份、公网 HTTP / 浏览器检查仍待完成；W18–W20 的最终结果在结束时更新。真实留言发布、管理上传、已安装应用 / Android 真机不由源码或 HTTP 通过替代。

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器学习应用 | 无需修改，官网独立服务 | 官网服务回归通过；公网待验收 | 本轮无需；既有待重建状态保留 | 不适用 | 不适用 | 官网本地限定流程通过，公网待验收 |
| Windows | 无需修改，保持 HTTPS 下载 / 更新协议 | Node 协议源码核对 | 本轮无需；既有待重建状态保留 | 未生成；旧包保留 | 未安装 | 官网 / 更新安装版待验收 |
| Android | 无需修改，保持原生 HTTPS / SHA256 协议 | 原生协议源码核对 | 本轮未构建 / 同步；原状态保留 | 未生成；旧 APK 保留 | 未安装 | 待设备验收 |

参考：[NGINX 请求限流](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)、[连接限制](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html)、[受信任代理](https://nginx.org/en/docs/http/ngx_http_realip_module.html)、[Certbot 续期与 hook](https://eff-certbot.readthedocs.io/en/stable/using.html)。这些机制的文档不是本次实际生效的证据，实际运行结果另行记录。
