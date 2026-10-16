# Android 连续查词等待修复（2026-10-15）

用户明确反馈 Android 手机“每个词都慢”。本轮完成源码修复和隔离验证；没有产品构建、Capacitor 同步、安装包生成或安装。已有学习库、文章、附件、词典和配置保持原样。

## 原因与修改

- 手机点词、词典状态和段落词形核对此前使用同一个 FIFO 队列。词形核对虽然分组让出队列，已经排队的后台任务仍能挡住点词。本轮使用同一读取线程的优先队列，点词 / 状态 / 来源 / 详情优先，后台每核对一个词便让出线程；后台批次顺序和词库更新代次核对保留。
- ECDICT 原来只缓存六个展开的 JSON 分片，索引、增强内容和 CEFR 共用这些位置。段落涉及多个首字母时不断挤掉词卡分片，后续点词重复读取和解析大块 JSON。本轮将分片压成 UTF-8 字节与排序键 / 值偏移，二分查找后只展开当前词条，按实际字节数限制为 64 MiB；正式包本次场景驻留约 39.9 MiB。格式、UTF-8、JSON 深度、索引范围和词条对应检查继续执行。
- 释义已经完整返回时，Android 原生适配层仍可能等待同一个词的后台学习 ID promise。现在只附带已经完成的权威 ID，待核对时先返回完整释义；显示之后的学习保存继续等待原 promise。既有或待完成的学习身份不被新词卡覆盖，失败仍可重试。
- 浏览器和 Windows 的 Node 词库读取不使用上述 Android 队列 / 分片缓存。共用身份缓存新增只读 `getResolved` 方法，原有 `resolve` / `prime` 的学习 ID 语义保留并回归；没有替换其词库、排序、来源选择或学习数据。

对应生产源码为 `CompactDictionarySection.java`、`DictionaryReadQueue.java`、`ReadageDictionaryStore.java`、`ReadageDictionaryPlugin.java`、`src/lib/platform/nativeDictionary.ts` 和 `src/lib/learningWordIds.ts`；Java 文件位于 `android/app/src/main/java/cn/readage/app/`。

## 验证证据及边界

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| 相关 TypeScript 回归 | 56 项通过 | 原生来源 / 取消 / 身份等待、共用学习 ID、词卡、搜索显示和平台超时 |
| `npm run lint` | 通过 | TypeScript 类型检查 |
| `npm run android:test-dictionaries` | 24 项通过 | 生产 Java 读取器、真实主机 SQLite、MDX、升级、词形、紧凑缓存内容和优先队列；[报告](../output/android-dictionary-speed-2026-10-15/native-tests.log) |
| Android 插件独立 javac | 通过 | Android 36 / Capacitor 的真实 API 类路径，存储依赖使用主机已编译类；[报告](../output/android-dictionary-speed-2026-10-15/plugin-compilation.json)。不是 Gradle 产品构建 |
| 正式 ECDICT 全字段对照 | 20 个查询通过 | 生产 Java 实际读正式 pack 后，与 Node 中性词条深比较；包括释义、例句、中文、词形、级别、关联词、短语、缩写及未收录；[结果](../output/android-dictionary-speed-2026-10-15/content-parity.json)、[原始记录](../output/android-dictionary-speed-2026-10-15/native-records.json) |
| 当前源码隔离 Chromium | 4 组、49 项通过 | 1280px 鼠标与 320px 触屏：全局搜索、完整词卡、关闭重开、学习保存、排除 / 恢复和错误重试。词典 / 历史学习为夹具，不是 Android 插件或 WebView；[报告](../output/android-dictionary-speed-2026-10-15/search-ui/verified-report.json)。已目视核对两种宽度词卡 |
| `npm run platforms:check` | 三端已有产物需重建 | 只读对应检查；[状态](../build/platforms/status.json)，不证明安装或功能通过 |

主机性能对照使用相同正式 ECDICT、相同 Java 测量入口、12 个词 × 3 轮；每次词卡间插入 24 个不同首字母的后台身份查询。第 2–3 轮原生读取中位数由约 47.1 ms 降至 0.7 ms，修复后还在 `-Xmx128m` 下执行并通过。详见 [测量数据](../output/android-dictionary-speed-2026-10-15/benchmark.json) 和 [修复后原始耗时](../output/android-dictionary-speed-2026-10-15/after.log)。这是 Windows 主机 Java 的读取耗时，不包含手机 JNI / WebView / 界面渲染，不能换算成真机速度。

首次解析某个分片仍有一次准备开销；本次主机首个 `science` 约 1.0 秒，修复前该样本约 0.7 秒。紧凑缓存不是冷启动加速的证据。冷启动、未准备的首字母、连续查词、后台学习并发和字节预算淘汰后的行为须在新 APK 中分别计时；不能只报缓存后的收益。

## 用户功能逐项对应

| 编号 / 操作 | 本地浏览器 | Windows | Android |
| --- | --- | --- | --- |
| D05 / D08 / D09 / D19 / D20：完整词条、来源和安装 / 升级后的数据 | 共用回归及 20 个正式 ECDICT 对照；隔离搜索 UI 只用夹具，不扩展为全部正式来源界面通过 | Node 读取无需本轮优化，共用回归通过；安装版未操作 | 24 项 Java、正式 ECDICT 对照及原生适配回归通过；正式 APK 全来源界面待验收 |
| D11：释义出现、学习 ID 核对、保存 / 失败重试 | 隔离搜索保存与恢复通过；共用身份缓存回归通过 | 共用源码对应；安装版待验收 | 待核对 ID 不阻塞释义的真实适配函数回归通过；不覆盖既有 / pending ID；后台保存的实际 WebView 顺序待验收 |
| D12 / D13 / D14：搜索、关闭、换词、取消、重查 | 两种宽度隔离搜索通过；旧请求取消及失败提示回归通过 | 共用源码对应；安装版待验收 | 原生取消及晚回调回归通过，共用触屏 UI 对应；系统返回 / WebView 待验收 |
| R06 / R07 / R13 / D31：阅读点词、词形、连续查询与后台并发 | 词形 / 原句 / 最后结果有相关回归，本轮阅读页 UI 未操作 | 共用源码对应，未操作安装版 | 原生优先队列、并发身份与实际 pack 主机读取通过；阅读页点词、返回、原句和真机耗时待新包验收 |

## 三端交付状态

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 共用身份缓存兼容完成；Node 读取无需修改 | 相关回归、类型检查、隔离 Chromium 部分操作通过 | 需重建，本轮未运行 | 不适用 | 不适用 | 隔离搜索范围通过；真实阅读档案未操作 |
| Windows | 共用源码对应；Node 读取无需修改 | 相关回归通过；安装版未运行 | 需重建，本轮未运行 | 旧包保留，需重建 | 本轮未安装 | 待设备验收 |
| Android | 原生队列 / 紧凑缓存 / 不阻塞释义及共用适配完成 | 原生主机、真实词库对照、类型 / 插件检查通过 | 需重建；Capacitor 未同步 | 旧 APK 保留，需重建 | 新代码未安装 | 待新 APK 真机速度及 WebView 验收 |

旧产物位置为 `build/desktop/readge-0.1.0-windows-x64-setup.exe` 和 `android/app/build/outputs/apk/debug/app-debug.apk`；均不作为本轮源码已经交付的证据。遵循用户“先检测、后编译”的要求，等待反馈后再执行对应交付。
