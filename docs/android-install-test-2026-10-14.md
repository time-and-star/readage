# 手机安装与首音实测（2026-10-14）

已保留原签名更新真实 vivo V2190A / Android 13，实际安装包 SHA-256 与新 APK 一致。首音等待修复只涉及 Android 原生分块和缓存：首段 100 → 48 字符，后续 220 字符并保留全部文字；同语言 / 语速 / 文本 / 采样率的开头两分钟内可重用，首次实际播放也写入缓存。正式 Kokoro int8 / Sherpa ONNX CPU、af_heart、en-US、语速 1、两条推理线程未改。

当前包：`android/app/build/outputs/apk/debug/app-debug.apk`，1734102726 字节，SHA-256 `8ccef17d3aab17bcffc40bea458da58b0cd40ce1dde13faafe3fc4cb6e7d3090`；Android 输入 `a429ef605568c1b493815534b6ac1c7317fa3f94e25abc39d179bf4981de516b`，源码快照 `cb2040cf72ba740c2846be1df198f8abec264823750d049dba95a315d8b13ed1`。前一功能修复包 cccd343a… 的安装记录单独保留，不用旧安装结果证明新包。

## 首音对比

同一 84 字符英文，前四场景沿用出声一秒后停止的基线协议；最后两场景自然播放完成再重播，用来区分取消中的推理排队。单位为秒。

| 场景 | 更新前 | 更新后 | 更新后首段缓存 |
| --- | --- | --- | --- |
| restart-opening | 12.734 | 6.963 | 未命中 |
| warm-repeat | 8.976 | 1.994 | 命中 |
| prepared-opening | 0.183 | 0.031 | 命中 |
| prepared-replay | 未取得对应基线 | 2.012 | 命中 |
| complete-opening | 未取得对应基线 | 2.001 | 命中 |
| completed-replay | 未取得对应基线 | 0.024 | 命中 |

restart-opening 指重启应用进程，保留系统资源缓存，阅读页自动准备也可能启动。记录从原生请求接受到首个 AudioTrack 成功写入；这是播放器启动指标，不能当作声学延迟或听感。prepared-opening 之前准备耗时由 8.832 秒变为 1.929 秒，此次已经有匹配缓存，仍可能等待前次被取消的推理。首次仍约 7 秒，快速停止后重播约 2 秒；自然完成后的本例重播约 0.03 秒，不泛化为每次都瞬时播放。

## 限定设备验收

真实触屏点击 Options → 听全文，观察到准备及播放状态；朗读方框出现并移动，点停止后消失。词卡发音后关闭词卡也清除其方框；展开详情显示手机本机音频缓存 / 本机首次输出 / 模型加载，截图已目视核对。本例全文实际点击首个原生输出 41 ms，词卡输出 1376 ms。对应 S01 / S02 / S04 / S05 / S09 / S20 / D12 的上述行为；选句、重复词跨段定位、长文章完整连续播放、多语言 / 多语速及声音听感未验收，不批量把 S01–S21 标通过。

外刊实际 Library 显示 72 篇，与原生标题顺序一致；Politics / Business 为 1227 / 750 词，正文及尾注、下一篇、顶部 65 px / 无额外留白 / 无水平溢出通过。deal 可见释义 553 ms、保存 926 ms。原主脚本在这些步骤后错误地假设 Back 总去 Library：实际 Back 遵循阅读历史，从 Business 回 Politics；该失败回执保留。只补真正的 Library 入口、重开 Politics、原生插图加载及说明 / 段落位置，补验通过，图片已目视核对；未因此重建产品。

新版图库原生桥接通过三轮各 964 张并进入第四轮 60 张，未把原生续流等同于图库触屏 UI。6 类文档和 3 类 MDX 的真实原生解析 / 回滚证据来自此前已安装 cccd 包，解析器 / 词典本轮未修改；正式系统选择器与文章保存 UI 仍待验收，不把这些旧结果移作新 APK 全功能通过。

## 原档案与跨日结算

两次覆盖安装均在启动前核对数据库 / 偏好文件字节哈希未变；独立测试期间两个原档案所有表精确不变。完成后恢复原档案与路径，学习库内容、附件引用和配置保留。原档案正常启动触发昨日 19 组阅读记录结算：原始每日组由 19 变 0，同日 19 条每日证据在恢复时标记结算；每日证据 110、记忆条目 93 的数量保持，文章证据、配置与另一原档案哈希不变。该变化符合 memorySystem 的历史日期结算和 raw 清理流程；未覆盖或回滚结算数据。首个要求学习表字节完全相同的恢复回执仍保留失败状态，另用只读审计解释正常结算，不能写成全部学习文件最终哈希未变。

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | Node / 共享输入保持，无需修改 | 共享朗读 27 项通过 | 原 web 构建有效 | 不适用 | 不适用 | 本轮 UI 未复测 |
| Windows | Node / Electron 输入保持，无需修改 | 共享朗读 27 项通过；前轮安装检测另列 | 已入现有有效包；dist 当前为 web | 原 dd6538c7… 包有效 | 前轮已安装 | 本轮未复测；听感待验收 |
| Android | 首段 / 缓存修复完成 | 原生 6 + 共享 27 项、273 资源 / 4 词典核对通过 | 前端 / 同步 / 原生完成 | 新 8ccef17d… 已生成 | 已覆盖更新并核对实际哈希 | 上述首音 / UI / 外刊限定范围通过；听感等未测项保留 |

npm run platforms:check 核对完成；浏览器和 Windows 的输入未变，所以没有重复生成无关包。生成的验证报告 / APK 副本 / 模拟器镜像已在 .gitignore 排除，避免被样式扫描误当作 UI 源码。

证据：[交付汇总](../output/android-install-test-2026-10-13/speech-delivery-report.json)、[安装](../output/android-install-test-2026-10-13/speech-install/install-report.json)、[首音基线](../output/android-install-test-2026-10-13/speech-before-report.json)、[首音更新后](../output/android-install-test-2026-10-13/speech-after-report.json)、[实际朗读 UI](../output/android-install-test-2026-10-13/speech-ui-report.json)、[外刊主步骤](../output/android-install-test-2026-10-13/magazine-final/magazine-cleaning-ui-report.json)、[外刊补验](../output/android-install-test-2026-10-13/magazine-supplement-report.json)、[原生格式 / 图库](../output/android-install-test-2026-10-13/native-parity-report.json)、[恢复审计](../output/android-install-test-2026-10-13/restoration-audit-report.json)、[平台检查](../output/android-install-test-2026-10-13/speech-platforms-check.log)。
