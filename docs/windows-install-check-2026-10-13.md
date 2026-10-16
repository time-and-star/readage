# Windows 安装检测（2026-10-13）

用户在完整修复包生成后要求“windows安装检测”，本轮执行 Windows 安装和实际安装程序的隔离运行检测。Android 继续遵守暂不安装；本轮没有修改产品源码或重建安装包。

## 实际安装

安装前，真实 Windows 用户的卸载注册表没有 readge，默认安装路径没有程序，但 `%APPDATA%/readge` 已存在历史学习数据。本轮使用已核对的新包执行当前用户安装，安装程序退出码为 0。

| 项目 | 结果 |
| --- | --- |
| 已安装程序 | `C:/Users/19891/AppData/Local/Programs/readge/readge.exe` |
| 注册表显示 | `readge 0.1.0`，当前用户卸载项已创建 |
| 桌面快捷方式 | `C:/Users/19891/Desktop/readge.lnk`，目标为上述已安装程序 |
| 开始菜单快捷方式 | 当前用户开始菜单的 `readge.lnk`，目标为上述已安装程序 |
| 安装包 SHA-256 | `dd6538c77fc023a9a8a532d055dcd6cd88b268e928e8675a64d9f75506688f2c` |
| 安装内容源码快照 | `985e7eb7612dce916b5fa38babe0b2307925aaa24a05f9818d55329b35dab06d` |
| Windows 输入快照 | `ada68c8b0e488492e4a8f3f5ca659189b28b59e892a673aba15931a144311910` |

版本名仍为 0.1.0，所以本轮依靠安装包哈希、安装目录实际 `readge.exe` / `app.asar`、包内构建标记与内容指纹确认新版本，而不是仅凭版本名判定。

## 检测通过范围

- 已安装目录的可执行文件和整个 ASAR 与本轮核验的打包产物一致；79 个网页产物文件、11 个运行源码文件、2720 个正式离线模型 / 运行资源文件以及 4 套正式词典核对通过。实际安装程序图标和品牌资源一致，ASAR 不含真实学习数据或 `.env`。
- 使用实际已安装的 `readge.exe`，在项目内独立测试档案首次启动和重开。两次均打开 `/library` 并渲染书架；测试档案 ID、服务地址和测试保存记录保持一致。首次部署 2720 个资源文件，重开部署 0 个，没有重复覆盖。
- 正式本机 Kokoro fp32 模型实际加载；经生产朗读接口分别合成美音 `af_heart`、英音 `bf_emma`、法语 `ff_siwis`、日语 `jf_alpha`，两次启动共 8 次合成请求返回 WAV。日语使用随包提供的独立 Python。此项证明正式声源及合成接口运行，不证明设备播放、跟读方框移动或声音听感。
- 正式 Hy-MT2 本机翻译运行；英译中“书在桌子上。”、日译英“The book is on the desk.”两种方向在首次 / 重开共 4 次请求通过。页面直接访问外部网络的探测被阻止，安装版联网 AI 保持关闭。
- 安装和隔离检测前后，真实数据目录的学习 SQLite、WAL、SHM、桌面配置、端口记录、迁移记录、离线资源记录共 7 个文件，长度、SHA-256 和修改时间一致。未打开真实学习档案进行测试；原学习库、附件和配置保留。

N01 仅验收了隔离档案无阅读书签时进入 Library 的分支，有效书签恢复未在本轮操作。安装版完整功能编号、正式文件选择 / 导出回执、真实旧档案首次启动和声音听感继续待逐项验收。检测期间没有向真实学习库导入测试包。

## 三端对应

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 本轮无需改动 | 本轮未重跑，前轮回归与隔离界面证据保留 | 前轮 web 构建保持 | 不适用 | 不适用 | 本轮未运行浏览器专项 |
| Windows | 本轮无需改动，前轮修复已落入新安装目录 | 实际安装文件 / 资源核对、隔离首次 / 重开、正式合成 / 翻译通过 | 前轮桌面构建已入包；当前 `dist/` 为 web | 已核对并使用本轮新包 | **已安装**，注册表 / 程序 / 快捷方式有证据 | 隔离 Library 启动 / 重开通过；其余完整操作和听感待验收 |
| Android | 本轮无需改动 | 本轮未重跑，前轮主机证据保留 | 前轮前端同步 / 原生编译保持 | 前轮 APK 保留 | **暂不安装** | 待真机验收 |

证据：[总报告](../output/windows-install-check-2026-10-13/report.json)、[安装前状态](../output/windows-install-check-2026-10-13/before.json)、[安装回执](../output/windows-install-check-2026-10-13/installation.json)、[注册表](../output/windows-install-check-2026-10-13/registry-after.json)、[快捷方式](../output/windows-install-check-2026-10-13/shortcuts.json)、[实际安装内容核验](../output/windows-install-check-2026-10-13/installed-payload-verification.json)、[首次启动](../output/windows-install-check-2026-10-13/first-start.json)、[重开](../output/windows-install-check-2026-10-13/reopen.json)、[真实数据未变](../output/windows-install-check-2026-10-13/real-data-final.json)、[实际书架截图](../output/windows-install-check-2026-10-13/installed-library.png)。

核对脚本曾因注册表名称包含版本号、Windows ASAR 路径分隔符出现断言失败，已修正检查脚本并只重跑内容核验，没有重建或重新安装产品。最终文件核验见 `installed-payload-verification-final.log`；前次失败日志仅保留为检查脚本历史。
