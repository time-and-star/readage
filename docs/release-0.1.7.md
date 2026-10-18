# ReadAge 0.1.7 / Android 1.0.9 发布记录

2026-10-19，用户明确要求“编译并推送”，因此执行三端构建、Capacitor 同步、完整安装包生成与 GitHub / 官网发布。此次不更新用户日常电脑或手机上的安装，也不改真实学习库。

固定产品源码提交：`9a826a6f76ea6314de88983667739bfa6c0664b6`；三端共同快照：`079018a38c38246d3535f75412ef778fb4f8c9a037891f50c77f13c97044a9aa`。后续发布流程与文档提交不改变此产品快照。

累计变化包括 EPUB / HTML / DOCX 章节与图片说明、书库标题和删除确认、段落位置恢复、后台更新及暂停续传、完整包差分接收和损坏缓存修复；Windows 另有旧安装目录长路径兼容、逐文件资源复用和启动校验缓存。正式模型、音色、词典与许可证全部保留。

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 0.1.7 | 共用 UI 与 Node 完成 | 共享回归、类型、隔离生产 HTTP 通过 | 已完成，当前 `dist/` 为 web | 不适用 | 不适用 | 生产 HTTP 与入口 JS 通过；本轮未重复浏览器界面与听感 |
| Windows 0.1.7 | 共用 UI / Node、原生更新与安装资源完成 | 桌面 112 项、最终包资源与 PE、隔离首次 / 重开通过 | 已完成，独立旁车对应当前源码 | 完整 EXE 已生成并核验 | 日常应用待安装 | 从最终 EXE 提取的程序已运行；实际产品向导覆盖安装、取消 / 降级组合及听感待验收 |
| Android 1.0.9 / build10 | 共用 UI、原生解析 / 后台更新完成 | 原生宿主、API 编译、正式运行时 / 词典 / 前端 / 图标及签名通过 | 前端 / 原生已构建并同步 | 完整 APK 已生成并核验 | 待安装 | 待真机界面、通知 / 安装流程及正式声音验收 |

`npm run platforms:check -- --strict --json` 退出 0，`complete:true`。网页最后构建覆盖共用 `dist/`；Windows 的独立安装包旁车与摘要保持 current，不能把当前 web 目录当成桌面产物。

完整包：

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| `build/desktop/ReadAge-0.1.7-windows-x64-setup.exe` | 1,335,405,981 | `6800754ad357ed8034b518e61979b07046133c323f6c54aceb2e559f67411409` |
| `android/app/build/outputs/apk/debug/app-debug.apk`，公开名 `ReadAge-1.0.9-android.apk` | 1,740,942,275 | `1b5b332075ba2a513e907ca797bb6b0e6277834d5f7f3c99616259535338516c` |

Windows 最终 EXE 使用非 solid Deflate，实际静态提取的 2749 项资源共 2,226,080,638 字节均按嵌入清单核对；没有用源资源目录补齐提取结果。核心及 52 个前端 JS / CSS 与当前源码构建一致，2720 个推理资源、四正式词典 19 文件与许可证全部校验。69 个 PE 文件的 633 项导入无缺失。提取程序在全新隔离档案运行两次：四正式音色经阅读接口生成、两项本机翻译、学习标记保留；重开时源 / 目标各 2720 项命中校验记录，内容哈希与部署均为 0。已目视检查实际书库截图；没有据此扩展为全部界面或听感验收。

Android 实际 APK 中的 273 个运行资源、四词典 12 文件、84 个前端文件和 16 张图标逐项核对通过，包含 arm64-v8a / x86_64。签名 v2 与旧包固定证书一致：`de260020066511703db8e701412329d8fe0f58339e574ad9d64e12c51cc4a9f3`。Windows 尚无 Authenticode 签名；Android 沿用原调试签名。

共享 TS 1529 项、桌面 112 项（启用真实 NSIS 小夹具）、额外 Node 测试 97 项、Android HTTP 17 项及安装更新宿主 53 项通过，主项目与官网类型通过。官网首轮 33 项中 32 项通过，文件缓存读取次数出现一次快速重写时间戳相关断言失败；原样单文件 3 项复查通过，未按全套首轮通过记录。沙箱权限造成的文件 / 服务测试失败使用同源码隔离重跑，保留首轮和重跑日志。

Android 1.0.8 / 1.0.7 / 1.0.6 到 1.0.9 三个差分分别经正式 Java 引擎完整重构、SHA 与逐字节比较通过，总下载约 3.03–3.05 MB。Windows 0.1.6 / 0.1.5 / 0.1.1 到 0.1.7 约 89.74% 字节变化，超过 80% 发布门槛，全部安全跳过并使用完整 EXE。缺少新接收器的旧版首次升级仍需要完整包；不能据此宣称这些旧应用已经能自动取差分。使用正式 0.1.6 源码的旧元数据校验器单独确认：新版 manifest 可接受，两个新完整包身份正确、版本判断为可升级，新增差分字段被安全忽略；没有据此计作旧安装版的实际操作通过。

发布状态：官网和 [GitHub v0.1.7](https://github.com/time-and-star/readage/releases/tag/v0.1.7) 均已公开并通过公网验证，GitHub 已设为 latest。可从 [Windows 完整包](https://readage.xyz/downloads/ReadAge-0.1.7-windows-x64-setup.exe) 或 [Android 完整包](https://readage.xyz/downloads/ReadAge-1.0.9-android.apk) 下载。

官网已发布至 `/srv/readage/releases/20261018T162235Z-full-0.1.7`，代码 / nginx 回退备份保留于 `/srv/readage/update-backups/20261018T162235Z-full-0.1.7`。两完整包先在服务器全 SHA 验证，再以同卷硬链原子公开；公网 HEAD / 首尾精确 Range、全部三差分及三描述的完整 SHA / Range / 无 gzip 检查通过。书库两库 quick_check 正常，506 本书、17 个杂志、523 个版本、1 条留言及 Cookie 身份与发布前一致，六个旧包保留，服务全部 active。新网站包含 `installer-delta-protocol.mjs` 依赖和差分下载 nginx 规则，只部署公开代码，没有迁移或替换真实数据库 / 密钥。证据见本地 `website-delivery.json`、`public-verification.json` 和 `data-protection-verification.json`。

GitHub Release ID 为 `416554620`，固定 tag 解析至上述产品提交 `9a826a6f76ea6314de88983667739bfa6c0664b6`。上传流程提交 `2226cc545bdab00e58c34802242792000fa1f53a` 仅添加本次固定资产 workflow；[运行 39145117191](https://github.com/time-and-star/readage/actions/runs/39145117191) 成功。两个完整包、六个差分相关文件与两份摘要 / 验证资料共十项资产的大小、state 和 GitHub digest 全部对应本机；十项匿名 HEAD / 首尾精确 Range 通过，两份小资料另做完整 SHA。latest Release ID 正确。证据见 `github-public-verification.json` 和 `github-workflow-completed.json`。源码及流程推送到 `codex/full-installer-release-0.1.7`；公开 tag 固定产品代码，后续文档提交不改产物。

详细本地证据位于 `output/full-release-0.1.7/`：`release-verification.json`、`validation/report.json`、`windows-exe-payload.json`、`windows-smoke-verification.json`、`windows-pe-integrity.json`、`android-verification.json`、`web-verification.json`、`platforms-strict.json` 和 `deltas/`。旧包及其验证记录保留，不用于冒充新版真实安装结果。
