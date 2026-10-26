# 2026-10-26 Windows 最新包安装

用户明确要求安装 Windows 最新版。本轮使用 10 月 25 日 Bot 隔离后生成的完整 0.1.9 安装包覆盖安装，无产品源码修改、重新编译、上传或 Android 安装。

安装包：`build/desktop/ReadAge-0.1.9-windows-x64-setup.exe`，SHA-256 `7ae4ce689c96d9bfc2754ce17b409b50fc54ee8bcc8aaa7d2e30b095dfbb7d72`。安装程序退出码 0，当前用户卸载登记由 0.1.6 更新为 ReadAge 0.1.9。实际程序为 `C:/Users/19891/AppData/Local/Programs/readge/readge.exe`，文件版本 0.1.9；桌面 `ReadAge.lnk` 指向该程序。安装前程序文件也显示 0.1.9，因此本轮通过包指纹和完整安装目录逐文件比较确认更新，没有仅按版本名称判断。

实际安装目录 2887 个文件 / 3074958445 字节全部与最终 EXE 的既有完整解包内容匹配，包含正式离线资源和词典。安装源码快照 `f842d46635f7cc05b3070f4e6c469c65ed1f3dcf681daa793155fadade6e3f09`，Windows 输入 `08c3b9ce9a389b01bf7cc74bf0a6c81e5beea6e31f6f943cee794ce3b28b326a`；未接入 Bot。

安装前复制了学习 SQLite、WAL / SHM、桌面设置和迁移记录共 5 个文件 / 222271214 字节，备份位于 `output/windows-install-2026-10-26/learning-backup/`。安装前后、首次启动前，选定个人数据库、历史备份、文章、附件、字典、配置及浏览器存储 8479 个文件 / 2945716865 字节逐字节一致。未卸载清数据、导入测试内容或重置档案。此指纹结论限于首次启动前；正常启动会更新运行资源记录、配置及浏览器运行状态。

随后正常打开实际已安装程序，窗口标题为 `ReadAge — Find Your Reading Edge`，辅助功能树显示原有外刊阅读路径和文章正文，恢复原阅读页。首次启动资源核对后主窗口出现。截图捕获为 Windows 锁屏画面，曾有一次激活窗口失败；重新获取当前窗口只读状态后确认辅助功能内容，随即停止界面操作。**未完成解锁后的目视界面验收、学习操作、正式播放或听感验收**；没有用辅助功能文本代替可见画面通过。

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 无需改动 | 本轮未重跑 | 沿用 10/25 网页构建 | 不适用 | 不适用 | 本轮未操作 |
| Windows | 无需改动，Bot 隔离包 | 包指纹、2887 安装文件和数据保护核对通过 | 沿用 10/25 桌面构建 | 完整 0.1.9 EXE 已核对 | 已安装，退出码 0、注册表 / 程序 / 快捷方式有证据 | 已启动并从辅助功能确认原阅读页；可视界面待解锁，其他操作及听感待验 |
| Android | 无需改动 | 本轮未重跑 | 沿用 10/25 前端同步与原生编译 | 原 1.0.13 / build14 APK 保留 | 本轮未安装，待安装 | 待设备验收 |

证据：[总报告](../output/windows-install-2026-10-26/report.json)、[安装回执](../output/windows-install-2026-10-26/installation.json)、[安装文件](../output/windows-install-2026-10-26/installed-payload.json)、[安装前后数据](../output/windows-install-2026-10-26/personal-after-install.json)、[启动观察及锁屏限制](../output/windows-install-2026-10-26/startup-observation.json)、[快捷方式](../output/windows-install-2026-10-26/shortcuts.json)。最新安装回执同步到 `build/platforms/desktop-installation.json`；上次 0.1.6 回执保留在本轮输出目录，不改写历史记录。
