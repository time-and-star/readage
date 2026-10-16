# 2026-10-14 Android 新包安装与真机检测记录

用户明确要求将本轮更新编译为 APK、传到手机并测试。本轮已完成 Android 前端构建、Capacitor 资源同步、APK 生成和保留数据的安装更新；真机检测尚未全部完成。下列时间使用北京时间。

## 新包与安装证据

| 项目 | 实际记录 |
| --- | --- |
| 手机 | vivo V2190A，Android 13 / API 33，arm64-v8a；设备序列号 `3504296688000CN` |
| 应用 | `cn.readage.app` |
| APK | [app-debug.apk](../android/app/build/outputs/apk/debug/app-debug.apk)，1,744,237,863 字节；Android Debug 签名 |
| 构建 / 打包时间 | 2026-10-14 21:32:27 / 21:33:15；Gradle `BUILD SUCCESSFUL` |
| 源码快照 sourceId | `53b122b1822381fa61453bcccb2e60a903b39ee165f2d12f43af7d7a2e93a53d` |
| Android inputId | `9199662fd721eb16b3c4a14118954580e84e5cacb4caa90cf3e67f98cede4d77` |
| APK SHA-256 | `63cd4f1f6d56c3ed4916afce499a584732252b74e17d70a186a9533f584208d9` |
| 签名证书 SHA-256 | `de260020066511703db8e701412329d8fe0f58339e574ad9d64e12c51cc4a9f3`；与手机原安装版一致 |
| 安装完成 | 2026-10-14 21:42:34；ADB 返回成功，手机实际安装的 `base.apk` 哈希与上述新包完全一致 |
| 内置资源核对 | 273 项资源、12 个词典文件及 4 个正式词典通过校验；词典、正式朗读资源、Hy-MT2 翻译资源及 ARM64 原生库随包核对 |

构建和资源校验不替代功能操作、模型听感或真机性能验收。安装脚本的 `launched:false` 仅表示它未执行启动；随后真实 APK WebView 已用于下述 H18 原生检测。

证据：[构建日志](../output/android-update-test-2026-10-14/apk-build.log)、[APK 资源报告](../output/android-update-test-2026-10-14/apk-runtime-report.json)、[新包签名](../output/android-update-test-2026-10-14/new-apk-signature.log)、[安装报告](../output/android-update-test-2026-10-14/install-report.json)。

## 用户流程逐项状态

网页用户流程基准仍为 [用户功能逐项验收](user-feature-acceptance.md) 的 D11 / D28 / D29 / D30、F21 和 H18。本轮手机操作使用独立标记测试档案，正式本机词典用于查询；未替换成测试词典。

| 编号 / 范围 | 本轮手机实际结果 | 后续状态 |
| --- | --- | --- |
| D11 / D28 / D29 / D30：正文查词、默认自动收录、不收录、反复查词与刷新、完整卡恢复、实际学习队列 | 首轮验收脚本在触控坐标校验处停止，未形成上述按钮流程的通过证据。原因是把被系统导航裁切的原生可见高度用于计算纵向比例 | 测试脚本已改为按实际 DPR 与外层 WebView 原点换算，并验证触点位于原生可见区域；待补测 |
| F21：无记忆状态的 run / ran 在词表管理归并一行、恢复后立即出现规范 run 词卡 | 首轮测试脚本误把相同边界的两层 WebView 判作多个独立表面，在设置按钮触控前停止 | 已对相同边界去重、按实际外层确认触控表面；待补测 |
| H18：原生坏备份替换前拒绝 | 首轮在真实 APK 的正式 Java `ReadageDatabase.restore` 路径检测空 state、缺失 state 包装、错误 state 类型、key 与身份不匹配四类坏记录，全部返回 400 和问题说明。隔离档案各表哈希、revision 与恢复前副本不变，之后实际词卡学习页面仍正常可读 | 仅此四类原生拒绝及正常读取范围已通过；Android 系统文件选择器 / 恢复弹窗流程待验收 |
| 保存失败与重试、父子词卡完整返回、系统返回、正式模型声音听感 | 本轮未完成对应真机操作；不能沿用源码测试或旧 APK 的设备通过结果 | 待对应设备验收 |

首轮失败原始报告保留在 [phone-ui-first-geometry-report.json](../output/android-update-test-2026-10-14/phone-ui-first-geometry-report.json)；H18 页面截图为 [坏备份拒绝后的学习页面](../output/android-update-test-2026-10-14/H18-learning-after-rejected-native-backups.png)。这些脚本问题没有触发产品源码修改、产品重建或再次安装。

后续补测在开始前发现手机 USB 已断开，尚未进入 UI；[当前补测报告](../output/android-update-test-2026-10-14/phone-update-report.json) 保留 `device not found` 失败，D11 组与 F21 继续标为待补测。首轮 H18 仅作为前一轮证据引用，未改写为补测已通过。

临时 USB 常亮设置原值为 `0`，测试时临时启用 USB 常亮；当前连接断开，恢复原值待重连执行，不宣称已恢复。

2026-10-15 补记：手机重连后已恢复该原值并读回 `0`。本次仅为图标问题的只读手机检查，前述 D11 / F21 补测及学习数据审计仍待执行；图标回填线索与新的源码版本记录见 [图标检查](android-icon-2026-10-15.md)。

## 学习数据保护与待完成审计

安装前已保存私有数据库、SQLite WAL 和偏好备份，并对数据库、配置、文件目录的 1,357 个文件核对。安装前后文件清单哈希均为 `b69259d330ea23999523cac5625358234a4fa0488670fceecf36652b74edc415`，安装报告确认数据库、配置与文件未变；未卸载应用、清除数据或导入测试内容到用户档案。[安装前备份报告](../output/android-update-test-2026-10-14/preflight-report.json) 记录的备份为 `database-preferences-before.tar`，SHA-256 为 `afaf56ec7a02e5cc2df99939d3112651e56ada71303ed16231f7e5dfac4fa8a8`。

首轮创建两个唯一 marker 的隔离档案。测试期间，验收前已有的三个档案逐表哈希与 revision 全部一致；结束时恢复的原档案 ID 和原阅读路径与开始前一致。返回原阅读页后，原档案六张学习表 `rawEvents`、`articleEvidence`、`dailyEvidence`、`memoryState`、`finalizationTasks`、`meta` 仍完全一致；只有当前原档案的 `settings` 哈希变化，revision 从 1279 增至 1282，其余已有档案未变。

该 settings 差异尚未完成逐键及文章内容审计，不能笼统认定全部数据不变，也不能在缺少字段证据时判定为正常读取元数据。独立只读审计已准备，但 USB 断开导致本轮读取未完成，见 [restoration-audit-report.json](../output/android-update-test-2026-10-14/restoration-audit-report.json)。后续需确认非元数据设置、文章正文、图片与附件引用均不变，并列出允许的阅读打开时间、书签或进度字段差异；不回滚或覆盖真实档案。

独立只读提取安装前数据库，另发现安装前至首轮界面测试前，当前原档案 revision 已由 1252 到 1279，rawEvents 由 113 到 154、articleEvidence 由 229 到 275、dailyEvidence 由 223 到 264、memoryState 由 195 到 235；另外两个原有档案的六表精确不变。这段发生在隔离测试基线之前，须按新增事件时间及所属文章继续核对，当前不能判定全部为正常阅读或宣称全程学习表不变。首轮隔离测试前后及返回原阅读页时六表精确一致的证据与此分开记录。

## 三端交付状态

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 本轮词卡 / 身份与 Node 备份规则已对应 | 既有源码回归及隔离界面记录通过；本轮未重跑 | 需重建，未运行 | 不适用 | 不适用 | 既有当前源码限定范围记录；真实档案 / 扩展实际页面待用户检测 |
| Windows | 共用词卡 / 身份与 Node 备份规则已对应 | 既有共用 / Windows 回归记录；本轮未重跑 | 需重建，未运行 | 需重建，旧包保留 | 新版待安装 | 新安装版待设备验收 |
| Android | 共用词卡 / 身份、Java 备份与 ZIP 发布前校验已对应 | 新 APK 资源校验通过；H18 四类原生拒绝范围通过；D11 组 / F21 待补测 | 已完成，Capacitor 已同步，快照对应当前源码 | 新 APK 已生成，位置及哈希见上表 | 已保留数据安装，手机包哈希一致 | 已开始但未完成；USB 待重连，settings 审计和受影响 UI 待继续；正式声音听感未验收 |

[平台检查记录](../build/platforms/status.json) 于 2026-10-14 22:11:22 将 Android 构建 / 同步 / 安装包标为 current，网页与 Windows 构建标为 stale；此工具不核对安装状态，Android 已安装的结论来自独立安装报告。当前不是完整三端发布交付。
