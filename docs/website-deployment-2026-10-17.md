# 官网部署与安全防护：2026-10-17

## 下载慢的后续修复与体积测量

安装包独立请求额度改为每 IP 10/s、突发 32、16 路并发 / 全站 64 路，保留全站速率保护。原四路 / 2 次每秒规则使正常八路分段进入 429 重试：同一本地测试修前八路五路被拒，修后八路均 206 且每段与本机原包一致，两端包尾也逐字节一致。NGINX 检查后重载，配置备份为 `/etc/nginx/sites-available/readage.before-download-fix`、`/etc/nginx/readage-limits.before-download-fix`。线上 current 中配置源同步。

管理接口单独计数，仍限制每 IP 1 / 全站 2，修复公共下载占用管理额度的问题。最初重跑安全脚本时，管理请求因此得 429；等待连接结束的假设未解决，最终查明共享全站计数原因并修正，脚本中的临时等待已撤销。仅复验剩余 11 项通过：401 / 413 / 七条私密路径 404、70 次请求中的 56 次 200 / 14 次 429、恢复后 200。原书库 / 留言与全站限流不变，未发布测试消息。

本地测速 16MiB 为 2.78MB/s、32MiB 为 7.16MB/s，均是部分连续下载；两次 curl TLS 握手失败后重试可用，不据此保证用户所在网络速度。实例元数据为 ap-singapore；无 NGINX 字节限速。不代表完整下载 / 真机安装已通过。证据在 `output/website-release-2026-10-17/downloads-{before,after}.json` 和 `download-fix-safety.json`。

用户后续提出包太大，实际 APK 的主翻译模型约 1.13GB、模型 / 音色等资源约 1.42GB；完整流式压缩测量仅省 69,216,919 字节，报告 `package-compression-analysis.json`。未改变产品源码、资源清单或离线语义，未重建三端；“小包＋首次下载资源”尚待用户选择。现有完整安装包保留。

## 最终交付

官网 [https://readage.xyz](https://readage.xyz/#download) 已上线。用户随后明确要求“按当前源码重建三端，再更新官网下载”：Windows / web 0.1.4、Android 1.0.6 / build 7 已构建，Android 已同步 Capacitor 及编译原生，三端严格产物核对通过。先核对服务器完整安装包、实际公开 HEAD / Range 可用，再更新官网 HTML 和 releases.json。新包从官网服务器提供，GitHub Release 保留历史 v0.1.2。

| 当前完整包 | 字节数 | SHA-256 |
| --- | ---: | --- |
| ReadAge-0.1.4-windows-x64-setup.exe | 1,278,530,940 | `c0cc236a7c41336c3c41da66da04559a3d953539f9593442aad7bd58e3f2427f` |
| ReadAge-1.0.6-android.apk | 1,740,885,298 | `25c535a9595f7de4a2248ddfeb4b216f84f7624f68a1c164aaa2d512467392d8` |

公开下载：`https://readage.xyz/downloads/<文件名>`，校验文件同目录 `SHA256SUMS.txt`。NGINX 精确限制文件名，目录不可列出、拒绝符号链接，APK 返回正确 MIME，提供限流与断点续传。传输复用公开旧包中的相同块，仅上传约 137MB / 54MB 必要数据；服务器重建的完整安装包与本机构建完整 SHA-256 一致并再次校验后才原子发布。用户取得完整包，无需旧包或传输工具。

本机位置：`build/desktop/ReadAge-0.1.4-windows-x64-setup.exe`、`android/app/build/outputs/apk/debug/app-debug.apk`、浏览器 `dist/`。对应 sourceId 为 `3994141e77bb1b0b0ba1dfa1085412f74bfd9a579e4d3c5ec60d60f0093e140b`。Windows 开发 dist 被后续 web 构建覆盖属既定顺序，独立安装包仍匹配源码。新 APK 实际签名校验通过，指纹 `de260020066511703db8e701412329d8fe0f58339e574ad9d64e12c51cc4a9f3` 与原已安装身份记录一致，正式离线模型保持；Windows 仍未 Authenticode 签名。本轮未安装新包，不以旧安装或主机测试代替新版设备验收 / 朗读听感。

验收证据与范围：

- 1,498 项应用、26 项桌面、33 项官网、39 项构建 / 更新回归通过；Android ZIP/XML 21 项、PDFBox / 文本 / HTML 10 项、原生资料 HTTP 14 项及更新 14 项通过；主项目与官网类型检查通过。Windows 包内代码、词典、模型、图标和打包程序正式资源隔离首次 / 重开 / 学习标记保留通过；实际 APK 的 273 个正式模型资源、4 套词典、ARM64 依赖和 16 个编译图标通过。
- web 生产构建的 6 个 HTTP / 独立 SQLite 路径及真实前端入口资源通过；完整学习界面未逐项复测。夹具最初缺本机数据请求头，修正后通过，未重建产品。另一次浏览器隔离启动未配置生产敏感 API 凭证，显示配置提示，未计作完整学习流程通过。
- 公网 30 项 HTTP 检查通过：HTTPS / HTTP / www、响应头、目录、最小 EPUB 全量 SHA、最大 EPUB Range、HEAD / ETag、新包 HEAD / Range / 校验清单、验证码与安全 Cookie、跨站 / 无密钥 / 超大请求拒绝、7 个私密路径拒绝、伪造转发头下限流及恢复。70 次有限突发为 53 次 200、17 次 429，6 秒后恢复正常，不是大规模压测。
- TLS 5 项实测通过：TLS 1.0 / 1.1 拒绝，1.2 / 1.3 正常且证书校验保留，未知 SNI 拒绝。用户放行云端 443 后公网连通；主机防火墙仅放行 22 / 80 / 443，Node 4175 仅回环。SSH 密码与 root 登录关闭后，ubuntu 密钥再次连接 / SCP 成功。实际服务为 readage 用户、ProtectSystem=strict、NoNewPrivileges=yes、MemoryMax=768MiB，备份和证书定时器启用。
- 浏览器实际检查：公网 `#download` 两项新版本 / URL / 运行条件、致谢返回、506 本书、中文标题与作者、搜索 / 分类交集、空状态与清空恢复、留言验证码、未发布草稿关闭重开保留、清空 / 返回 / 回焦；360px 页面和书库 / 留言面板无横向溢出。未真实发表测试留言、管理上传或操作手机安装。
- 迁移 506 本书 / 16 条杂志及全部 522 个文件逐个核对。启动自动同步后新增一期。首份有效备份覆盖 506 本书 / 17 条杂志、523 个版本及 0 条留言；两个 SQLite integrity_check、Cookie 密钥长度及全部归档文件大小 / SHA-256 独立验证通过，没有恢复覆盖线上数据。
- 首次备份因自动同步新增文件改变目录 mtime 而失败，已改为按数据库快照中的不可变文件列表归档，单独重跑成功，无产品重建。有效备份 `/var/backups/readage/readage-20261017T094510Z.tar`，SHA-256 `b09711d71db1ea026c6e5431a90995f25915371cc900828dfcebf89149d86dc1`；旧 `.partial` 不属于有效备份。每日保留七天，仍是服务器本地备份，不能替代异地备份。

证据：[公网验收](../output/website-release-2026-10-17/readage-public-smoke.json)、[备份独立验证](../output/website-release-2026-10-17/readage-backup-verification.json)、[安装包校验清单](../output/website-release-2026-10-17/SHA256SUMS.txt)、[APK 签名](../output/website-release-2026-10-17/apk-signature.json)、[公网首页截图](../output/website-release-2026-10-17/live-homepage.jpg)；其他构建 / 回归 / 类型 / 资源日志在 `tmp/website-deploy-2026-10-17/`，构建旁车在 `build/platforms/`。管理密钥仅存服务器 root 0600 的 `/etc/readage/website.env`，未写入报告、网页或 Git。更新签名私钥留本机。

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 当前源码 / 官网已部署 | 共用 / 类型 / 生产 HTTP，官网桌面及 360px 通过 | web 0.1.4 完成，严格核对通过 | 不适用 | 不适用 | 官网限定流程通过；完整学习界面待检测 |
| Windows | 当前源码 0.1.4 | 共用 / 26 项 / 包内 / 正式资源隔离启动重开通过 | 安装器完成，桌面开发 dist 被 web 覆盖属预期 | 新包公开下载、完整摘要一致 | 本轮未安装，旧版保留 | 新包安装、设备界面与听感待验收 |
| Android | 当前源码 1.0.6 / 7 | 共用 / 原生 21+10+14+14 / 实际 APK 资源通过 | 前端、原生与同步完成，严格核对通过 | 新 APK 公开下载、完整摘要一致 | 本轮未安装，旧版保留 | 待新包设备验收 |

以下为部署过程记录，其中当时的旧下载版本 / 待构建状态由本节最终结果更新。基础主机与应用防护已生效，未接入 CDN / WAF / 云端 DDoS 流量清洗，不能保证抵御任意规模攻击。

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

## 历史：部署过程检查

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
