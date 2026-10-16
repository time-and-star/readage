# 功能缺口修复记录（2026-10-13）

按用户要求修复 [逐项审查](feature-parity-audit-2026-10-13.md) 中全部 33 组问题，涉及 42 个基准编号。用户后续已要求两端安装检测，现 **Windows 与 Android 已安装**。真实学习数据及配置按各端证据保留；验收范围逐项记录。审查报告为修复前历史，不能拿旧行号或旧包结论证明当前修改已通过。230 项基准不因本轮修复而批量变为界面验收通过。

| 编号 | 问题 | 受影响端 | 源码 | 验证 | 构建 | 安装 / 设备 |
| --- | --- | --- | --- | --- | --- | --- |
| L18 | 重开已读完外刊时覆盖 Completed 状态 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；Completed 重开界面待专项验收；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| I14 / R04 | 个人 HTML 导入未生成正文媒体附件 | 网页 / Windows | 已完成 | HTML 内嵌图片/图注/短章/语义拆篇隔离回归通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows 已安装；Android 用户暂不安装，待真机逐项验收 |
| I14 / R04 | DOCX 未按电脑规则关联 Caption 图注 | Android | 已完成 | Android 正式解析器主机 20 ZIP/XML + 10 文本/PDF/图库测试通过；原生编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| L19 | 正式解析图片与画廊读取的资源命名空间不匹配 | Android | 已完成 | Android 正式解析器主机 20 ZIP/XML + 10 文本/PDF/图库测试通过；原生编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| L17 / I05 / I07 / I10 / I11 | 个人 EPUB / HTML 正文清洗、语义拆篇及续读偏差 | Android | 已完成 | Android 正式解析器主机 20 ZIP/XML + 10 文本/PDF/图库测试通过；原生编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| I14 / R04 | 个人 EPUB 行内图片位置、图注处理不同 | Android | 已完成 | Android 正式解析器主机 20 ZIP/XML + 10 文本/PDF/图库测试通过；原生编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| I05 / I15 / R05 | 所选批次全无文字时拒绝 PDF，缺少原页预览导入 | Android | 已完成 | Android 正式解析器主机 20 ZIP/XML + 10 文本/PDF/图库测试通过；原生编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| I05 | TXT 内 HTML / Markdown / 无扩展名识别与电脑不同 | Android | 已完成 | Android 正式解析器主机 20 ZIP/XML + 10 文本/PDF/图库测试通过；原生编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| D10 / X11 | 显式相关词 / 词形按钮替换根卡，缺少父词返回链 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：相关词子卡、返回父卡；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| D08 / D17 | 默认来源未参与实际选择，卡片优先级及出处展示不足 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：来源与许可展开、HTTP 链接保留（默认设置仍需独立界面核对）；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| D23 | 独立法 / 日试读页缺选中翻译、朗读入口 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：法语试读查词、选区操作入口及朗读调用（实际模型/日语界面待专项）；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| D14 | 全局查词没有基准要求的语言切换 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：法日全局查询不写英语学习库；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| D11 | 全局查词保存失败仅写控制台，没有状态与重试 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：保存失败/重试及发生编号保持；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| D12 | 普通阅读及嵌套词卡关闭未停止所属朗读 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：子词卡与阅读根卡关闭停止所属朗读调用；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 新版真机发音后关闭词卡，朗读方框消失通过；桌面与其他弹窗分支保留待验收 |
| F17 | 词表导入完成页忽略实际新增、已有数量 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：实际新增/已有结果反馈；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| X31 | 导入末章没有明确结束提示 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：末章提示；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| R07 / D07 | 普通阅读词卡缺阅读原句，原句词突出显示也不足 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：原句完整查询词高亮；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| X32 | 简明词卡打开时正文手势 / 右键仍可切篇 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：卡片打开阻止切篇、关闭恢复手势；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| R14 | 推荐流换主文章时旧查词请求未取消 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：主文章变化中断旧请求；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| L13 | 外刊多处更新失败仅显示首条原因 | 三端共用 | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：展开更新详情显示全部失败来源；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows / Android 已安装；Android 待真机逐项验收 |
| X24 | 首次选择前不显示 MDX 拖入区域 | 网页 / Windows | 已完成 | 共用/Node 全量回归 1391 通过；末尾词卡修正 23 项与类型检查通过；网页 隔离 Chromium 宽屏/触屏通过：首次区域、MDX/包预览、语言名称与取消；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows 已安装；Android 用户暂不安装，待真机逐项验收 |
| L08 | 有效外刊超过 80 篇时静默截断 | 网页 / Windows | 已完成 | 隔离真实手动更新 95 篇完整保留，通过；全量回归通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows 已安装；Android 用户暂不安装，待真机逐项验收 |
| D19 | 缺少手机同格式 ECDICT / 自编分发包界面安装器 | 网页 / Windows | 已完成 | 词典包安装/重启恢复/损坏拒绝/失败回滚 3 项通过；网页 隔离 Chromium 宽屏/触屏通过：分发包预览/取消，实际安装见隔离接口测试；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows 已安装；Android 用户暂不安装，待真机逐项验收 |
| N09 / R12 / F10 | 系统返回未被部分弹窗 / 选区消费，会继续退页或退后台 | Android | 已完成 | 共用返回消费回归与合成 Android Escape 浏览器操作通过；原生编译通过；网页 隔离 Chromium 宽屏/触屏通过：学习设置合成返回消费（其他设备返回情形待真机）；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| H09 | CSV 额外 8 Mi 字符 / 16 MiB 容量限制 | Android | 已完成 | 流式 UTF-8 写入实现核对及原生编译通过；大容量系统保存待真机；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| H23 | 学习数据位置说明仍写“这台电脑 / 换电脑” | Android | 已完成 | 类型检查通过；实际设备文案待验收；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| I09 | 取消文档解析只拒绝前端 Promise，原生任务继续 | Android | 已完成 | 前端同请求取消/超时回归及原生中断、不发布附件主机测试通过；桥接编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| L22 | 画廊固定顺序有限分页，缺少循环轮次与洗牌续流 | Android | 已完成 | Android 外刊/图库主机 27 项，正式导入附件跨 3 轮续流及共用窗口去重回归通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 新版原生桥接三轮各 964 张并续入第四轮通过；实际图库触屏 UI 待验收 |
| S20 | 朗读耗时详情字段丢失，缺少同等展开详情 | Android | 已完成 | 本机事件匹配、非法字段过滤及引擎/缓存/首音耗时适配测试通过；实际声源/听感待设备；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 新版真机实际展开正式来源 / 本机首次输出 / 模型加载通过；听感与其他语种待验收 |
| I16 | TXT / HTML 8 MiB 限制与界面 64 MiB 声明不同 | Android | 已完成 | Android 正式解析器主机 20 ZIP/XML + 10 文本/PDF/图库测试通过；原生编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| D18 / X23 | 损坏旧词典设置回默认，缺少异常与显式修复提示 | Android | 已完成 | 损坏/无效/来源变化的设置读取与显式修复回归通过；原生编译通过；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| D27 / X24 | 没有电脑端直接 MDX 导入及预览流程 | Android | 已完成 | Android 字典 22 项及与 Node 同样本的压缩/编码/Unicode 词条 ID/别名/损坏/重复/回滚对照通过；网页 隔离 Chromium 宽屏/触屏通过：共用预览流程通过；Android 正式选择器/导入待设备；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Android 已安装；Android 待真机逐项验收 |
| X28 | 原词条 / 来源外链被 Electron 拦截 | Windows | 已完成 | 外链协议分支核对及 Electron 26 项回归通过；默认浏览器实际打开待 Windows 专项；网页 待专项界面验收；Windows 待安装版逐项验收 | 已完成：三端对应产物、Android 同步与安装包严格核对通过 | Windows 已安装；Android 用户暂不安装，待真机逐项验收 |

## 本轮验证证据

共用 / Node 全量回归 1391 项通过，最后一次词卡滚动修正后重跑相关 23 项与类型检查通过；Electron 26 项通过。Android 主机测试为字典 22、ZIP / XML 20、实际文本 / PDFBox / 导入图库 10、外刊 / 图库 27，合计 79 项通过；真实原生桥接编译通过。

隔离 Chromium 中实际共用 React 界面 24 个场景通过（宽屏 12、触屏 12），页面异常 0。该界面验证使用隔离档案及受控的查询、保存、语音接口响应，只验证具体按钮、状态和回调；不能代替真实导入、学习持久化、正式模型声音听感或 Android 系统操作。

证据：[shared-full-final.log](../output/feature-parity-repair-2026-10-13/shared-full-final.log)、[reading-ui-final-regression.log](../output/feature-parity-repair-2026-10-13/reading-ui-final-regression.log)、[type-check-after-ui.log](../output/feature-parity-repair-2026-10-13/type-check-after-ui.log)、[desktop-tests-final.log](../output/feature-parity-repair-2026-10-13/desktop-tests-final.log)、[android-native-compile.log](../output/feature-parity-repair-2026-10-13/android-native-compile.log)、[android-dictionary-final.log](../output/feature-parity-repair-2026-10-13/android-dictionary-final.log)、[android-documents-final.log](../output/feature-parity-repair-2026-10-13/android-documents-final.log)、[android-document-gallery.log](../output/feature-parity-repair-2026-10-13/android-document-gallery.log)、[android-magazines-final.log](../output/feature-parity-repair-2026-10-13/android-magazines-final.log)、[shared-ui-verification.json](../output/feature-parity-repair-2026-10-13/shared-ui-verification.json)。同目录前次失败 / 调试日志保留为历史，以上最终日志为本次对应证据。

## 三端交付状态

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 共用界面、Node 导入 / 外刊 / 词典对应完成 | 共用 / Node 1391；末次相关 23；类型检查；宽屏 / 触屏 24 场景通过 | 已完成，dist 为 web 目标 | 不适用 | 不适用 | 隔离 Chromium 指定场景通过；其他实际操作按逐组记录待验收 |
| Windows | 共用界面 / Node 与 Electron 外链对应完成 | 前轮 Electron 26 项；本轮实际安装文件 / 资源核对、首次 / 重开、四语正式声音合成及离线翻译通过 | 已完成并进入安装包；当前 dist 已恢复为 web | [Windows 安装包已生成](../build/desktop/readge-0.1.0-windows-x64-setup.exe) | 已安装（2026-10-13 用户随后要求 Windows 安装检测） | 实际安装程序以隔离档案启动 / Library 渲染 / 重开通过；完整功能操作与声音听感待验收 |
| Android | 原功能对应完成；本轮 Android 首段 / 重播缓存已修复，共用与 Node 输入保持 | 原功能主机 79 项保留；本轮原生 6 + 共享朗读 27 项、正式 APK 273 资源及 4 词典核对通过 | 前端已构建、Capacitor 同步、原生编译完成 | [Android APK 已生成](../android/app/build/outputs/apk/debug/app-debug.apk) | 已安装（2026-10-14，实际 APK 哈希已核对，原档案已恢复） | 首音改善、朗读指定交互、外刊正文 / 图片 / 导航限定范围通过；其余界面与听感待验收 |

原功能修复源码快照：`985e7eb7612dce916b5fa38babe0b2307925aaa24a05f9818d55329b35dab06d`。原快照严格产物核对：通过（2026-10-13T12:40:59.285Z），核对源码、目标、前端同步和安装包哈希；不证明安装或功能验收。记录：[冻结平台状态](../output/feature-parity-repair-2026-10-13/platform-status-final.json)、[原严格检查日志](../output/feature-parity-repair-2026-10-13/platforms-strict-final.log)。Windows 的构建目录已按交付顺序被网页构建替换；桌面内容已在替换前逐文件核对并装入安装包，旁车记录和本轮快照单独保存。

Windows 包：1,275,429,476 字节，SHA-256 `dd6538c77fc023a9a8a532d055dcd6cd88b268e928e8675a64d9f75506688f2c`，输入快照 `ada68c8b0e488492e4a8f3f5ca659189b28b59e892a673aba15931a144311910`。

Android 包：1,734,102,726 字节，SHA-256 `8ccef17d3aab17bcffc40bea458da58b0cd40ce1dde13faafe3fc4cb6e7d3090`，输入快照 `a429ef605568c1b493815534b6ac1c7317fa3f94e25abc39d179bf4981de516b`。

Windows 已按后续指令安装到当前用户程序目录，实际安装文件与正式资源核对、隔离首次 / 重开 Library、四种正式声音合成、两种翻译方向和隔离记录保留通过。真实学习数据库与配置 7 个文件的字节、哈希和修改时间均保持不变；未打开真实学习档案进行测试。证据：[安装检测报告](../output/windows-install-check-2026-10-13/report.json)、[详细安装验收](windows-install-check-2026-10-13.md)。系统选择器、导出完成回执、正式声音听感和完整安装版功能操作继续待逐项验收。

产物证据：[web-build-final.log](../output/feature-parity-repair-2026-10-13/web-build-final.log)、[desktop-package.log](../output/feature-parity-repair-2026-10-13/desktop-package.log)、[android-apk.log](../output/feature-parity-repair-2026-10-13/android-apk.log)、[desktop-package-verification.log](../output/feature-parity-repair-2026-10-13/desktop-package-verification.log)、[desktop-isolated-smoke.log](../output/feature-parity-repair-2026-10-13/desktop-isolated-smoke.log)、[android-runtime-verification.log](../output/feature-parity-repair-2026-10-13/android-runtime-verification.log)、[platform-status-final.json](../output/feature-parity-repair-2026-10-13/platform-status-final.json)、[web-build-final.json](../output/feature-parity-repair-2026-10-13/web-build-final.json)、[windows-package-final.json](../output/feature-parity-repair-2026-10-13/windows-package-final.json)、[android-package-final.json](../output/feature-parity-repair-2026-10-13/android-package-final.json)、[windows-package-verification.json](../output/feature-parity-repair-2026-10-13/windows-package-verification.json)、[android-runtime-verification.json](../output/feature-parity-repair-2026-10-13/android-runtime-verification.json)、[windows-first-start.json](../output/feature-parity-repair-2026-10-13/windows-first-start.json)、[windows-reopen.json](../output/feature-parity-repair-2026-10-13/windows-reopen.json)。

Android 后续安装及朗读优化覆盖前述历史未安装状态；当前专项证据与限制见 [手机安装与首音实测](android-install-test-2026-10-14.md)，实际安装回执 [JSON](../output/android-install-test-2026-10-13/speech-install/install-report.json)。本轮三端对应检查另记 [日志](../output/android-install-test-2026-10-13/speech-platforms-check.log)，不将原功能修复快照的严格结果挪作新版设备验收。
