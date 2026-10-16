# 跨端修改与交付

2026-10-16 后续 CPU 实测：用户只要求补测手机正式 CPU，其他性能复用旧记录。vivo V2190A / Exynos 1080 / Mali-G78 已保留数据覆盖安装 Release 的 Android 1.0.4 / 5，并确认实际 APK SHA 为 `9059894f87c028d064e808e524fdb48f157438f4b19a3ba3ab575fb672838942`。独立档案中的 5 个翻译、3 个正式语音请求完成，原档案逻辑表不变并已恢复；长段落仍有两次缓冲、合计约 4.01 秒，听感未通过验收。浏览器 / Windows 没有新增设备测试，本次没有产品构建、Capacitor 同步或源码功能修改。详见 [实测性能](performance.md) 与 [逐项限定范围](user-feature-acceptance.md#2026-10-16-android-cpu-性能实测)；下方记录保留其历史时间范围。

2026-10-16 用户明确授权提交全部应用源码并发布 Release，当前进入集中编译与交付阶段。Windows 版本为 0.1.2，Android 为 1.0.4 / 5；加入 Apache 2.0 许可证、发行包许可与全新图文 README。三端源码、测试、构建、包校验、安装和设备验收分别记于 [本轮发布记录](release-2026-10-16.md)，不将新包生成视为设备已更新。

2026-10-16 用户将名称改回 **ReadAge**（R、A 大写）：共用界面、HTML / PWA 名称、词典展示及导出文件名对应三端；Windows 窗口、菜单、安装显示名 / 快捷方式及后续安装包文件名已对应，保留 `com.readge.local`、`readge.exe` 和原数据目录用于升级连续性；Android `cn.readage.app` 与原生 `ReadAge` 标签保持，原生词典及导出默认名对应更新。浏览器插件名称同步改为 ReadAge，兼容下载地址保留。按“先检测、后编译”执行：三端产物均需重建，Android 资源同步、插件包、安装及设备验收等待对应交付阶段。验收范围见 [N15](user-feature-acceptance.md)。

2026-10-15 用户明确要求生成最新安装包，本轮已集中完成 Windows 0.1.1、Android 1.0.3 / 4 和网页生产构建；严格产物检查通过。新版本尚未安装，隔离运行与设备验收分别记录，产物位置和证据见 [最新安装包交付](release-2026-10-15.md)。

随后进行的 Android 连续朗读优化修改了原生 PCM 队列、开播缓冲及共用原生事件处理，当前对应产物需重建，前段发布记录不能覆盖这些新源码。79 项回归、10 项 Java 主机测试、类型 / Java 编译及 34 项隔离界面检查通过各自范围，用户暂不方便连接手机，正式模型速度和听感仍待设备检测。按先检测、后编译规则未执行产品构建、同步、打包或安装；详见 [朗读源码记录](tts.md#android-连续朗读源码优化2026-10-15待设备检测)。

本地浏览器、Windows 和 Android 使用同一套阅读产品。每次修改默认逐项检查三端：共用规则修改一次，平台能力补齐对应实现，再分别确认源码、测试、构建、安装包和设备上的状态。用户明确限定单端时按该范围执行。持续协作规则保存在根目录 [AGENTS.md](../AGENTS.md)。

实际功能验收先使用 [用户功能逐项验收](user-feature-acceptance.md) 列出网页基准，再逐条执行。该清单包含用户动作和细小反馈，不能用模块名或构建报告代替。当前用户要求先完成离线对齐，Windows / Android 联网 AI 保持关闭；联网差异也保留在验收清单里。

## 三端如何对应

| 部分 | 本地浏览器 | Windows Electron | Android |
| --- | --- | --- | --- |
| 阅读界面与业务规则 | `src/main.tsx`、`src/App.tsx`、`src/components/`、`src/lib/` | 同一套 React 和 TypeScript 源码 | 同一套源码；检查触屏、窄屏和 WebView 兼容 |
| 启动与服务 | `scripts/start-local.mjs`、`server.ts`，开发模式读取源码 | `desktop/main.mjs`、`desktop/runtime.mjs`，运行构建后的本机 Node 服务 | `src/lib/platform/android.ts`、原生 `MainActivity.java`，运行 APK 内置页面 |
| 学习数据库 | `src/lib/localDatabase.ts` 经 HTTP 调用 `server/localDatabase/` | 同一 Node 实现，数据存于用户工作目录 | `localDatabaseTransport.ts`、`nativeDatabase.ts` 对接 `LocalDatabaseStore.java`；协议在 `src/lib/localDatabaseProtocol.ts` |
| 文档与附件 | `server/import/`、`server/documents/` | 同一 Node 解析和文件实现 | `nativeFiles.ts`、`ReadageFilesPlugin.java`、`NativeFileStore.java`、`NativeDocumentParser.java`、`NativeStructuredDocumentParser.java` |
| 查词与词典设置 | `server/dictionary/`、`packages/dictionary/` | 同一 Node 服务及打包词库 | `nativeDictionary.ts`、`ReadageDictionaryPlugin.java`、`ReadageDictionaryStore.java`；检查词条结果与设置协议 |
| 翻译 | `server/translation/`、`scripts/hymt2-service.mjs` | 同一接口，随包提供 Windows 模型与运行器 | `nativeTranslation.ts`、`ReadageTranslationPlugin.java`、`NativeHyMt2.java` 和 JNI |
| 朗读 | `src/lib/speech/`、`server/tts/`、`scripts/kokoro-service.mjs` | 同一接口，随包提供模型和声音 | `nativeBundledSpeech.ts`、`ReadageBundledSpeechPlugin.java`、`BundledSpeechPipeline.java`；实际播放由 AudioTrack 执行 |
| 外刊 | `server/magazines/` | 同一 Node 实现，手动更新 | `nativeMagazines.ts`、`ReadageMagazinesPlugin.java`、`NativeMagazineStore.java`、`NativeMagazineHttp.java` |
| 打包 | `vite.config.ts`、`npm run build` | `scripts/build-desktop.mjs`、`desktop/electron-builder.cjs` | `scripts/build-android.mjs`、`capacitor.config.ts`、`android/app/build.gradle` |

表内 `native*.ts` 和 `localDatabaseTransport.ts` 位于 `src/lib/platform/`；Java 文件位于 `android/app/src/main/java/cn/readage/app/`。Android 的 `nativeFetch.ts` 只转发已实现的本机接口，新增电脑 `/api/` 路由不会自动在手机实现，未接入接口会返回功能不可用。

只改共用页面即可影响三端源码，但已安装的 Windows 和手机应用仍使用各自上一次打包的页面。修改 Node 后端时，浏览器与 Windows 共用实现，Android 原生对应逻辑须单独检查。修改 Android 插件时，则检查返回结构、错误、取消、附件标识及日期是否仍与共用逻辑和电脑实现一致。

## 修改怎样落实到设备

### 默认先检测、后编译（2026-10-14）

用户要求以后修改完成先不编译，等用户检测后再做。默认先完成受影响三端的源码适配、相关测试及类型检查，报告源码和验证范围并等待用户检测反馈；产品构建、Capacitor 同步、打包及安装留到用户确认检测通过或明确要求对应交付时集中执行。若用户明确要求使用新包进行设备验收，则按该已授权范围生成必要产物，无需再重复询问。

等待期间，源码变更影响的旧产物记录为“需重建，待用户检测后编译”；已安装应用仍使用旧版本，新版本安装和设备验收待执行。检测发现问题时先修复并验证，再等待新的检测反馈。仅文档或流程偏好变更不运行产品测试、构建或产物核对。下表是进入构建 / 交付阶段后的入口，不表示每次源码修改后自动执行。

| 目标 | 构建与交付入口 | 完成证据 |
| --- | --- | --- |
| 本地浏览器开发版 | `npm run start:local`，服务端修改后重启，页面修改后刷新 | 当前浏览器实际操作结果；不是其他端的更新证据 |
| 本地浏览器生产版 | `npm run build`；`npm start` 运行生成的生产服务 | `dist/` 为 web 目标且源码快照对应，实际浏览器验收 |
| Windows 开发窗口 | `npm run desktop:build`，再 `npm run desktop:start` | 桌面目标构建及独立窗口验收；不等于已更新安装版 |
| Windows 安装版 | `npm run desktop:package`；需要目录包时用 `npm run desktop:pack` | `build/desktop/` 的安装包或应用目录、哈希、安装更新及实际运行验收 |
| Android 内置页面 | `npm run android:build` | `dist-android/` 与 Capacitor 同步后的 `android/app/src/main/assets/public/` 对应当前源码 |
| Android 安装版 | `npm run android:apk` | `android/app/build/outputs/apk/debug/app-debug.apk`、哈希、保留数据的安装更新及设备验收 |

网页和 Windows 构建都写入 `dist/`，相互覆盖。需要 Windows 安装包时先构建并打包桌面目标；此后再构建网页不会改动已经生成的安装包，但当前 `dist/` 已变为网页目标。Android 页面使用独立的 `dist-android/`，还需要同步原生资源和重新生成 APK。

浏览器通常使用项目中的 `local-data/`；Windows 使用 `%APPDATA%\readge\workspace`；Android 使用应用私有 SQLite 和文件目录。修改软件不会自动合并学习进度。JSON 或 ZIP 迁移包导入属于恢复或替换，应保留恢复前档案。

## 构建对应检查

产品源码阶段可运行只读的 `npm run platforms:check` 查看当前源码与已有构建、同步资源和安装包是否对应；报告需要重建不触发自动构建。进入完整三端发布产物交付阶段并生成对应产物后，再运行 `npm run platforms:check -- --strict` 检查完整交付：当前 web 构建、Windows 安装包，以及 Android 前端构建、原生资源同步和 APK 都须有对应记录。Windows 安装包单独核对自己的快照与哈希；严格检查允许后续 web 构建覆盖 `dist/`，不要求桌面开发构建仍占用该目录。

构建脚本在完整构建成功后生成 `dist/readge-build.json` 或 `dist-android/readge-build.json`，记录目标平台和源码快照，Android 将该记录随页面同步到原生资源。Windows 安装包及 Android APK 的旁车记录保存快照和产物哈希。快照按共用、Node、Windows、Android 等源码范围计算，各端只关联影响自己的范围；单端源码变化不会让无关端的包一律失效。

检查工具用这些记录区分“当前”“需重建”“缺失”等状态，检查源码与构建文件完整性、产物哈希及 Android 同步是否一致。它不验证功能等价、运行行为、安装状态或手机验收；记录当前也不表示设备已经更新。

源码变化后，旧包及其旧快照上的测试仍可作为历史记录保存，但不能宣称新源码已在旧包中生效。构建标记与产物哈希证明对应关系，实际安装和设备运行须另有证据。

## 必要验证与完成记录

优先运行与改动对应的现有测试及 `npm run lint`。桌面生命周期和资源相关验证使用 `npm run desktop:test`、`npm run desktop:smoke`、`npm run desktop:resources-check` 或 `npm run desktop:verify-package`。Android 对应入口包括 `npm run android:check`、`npm run android:test-database`、`npm run android:test-runtime`、`npm run android:test-documents`、`npm run android:test-magazines` 和 `npm run android:verify-runtime`。主机测试不能替代 WebView、系统文件选择、音频播放或手机生命周期验收。

源码阶段执行不依赖新产品包的相关测试和静态检查；依赖新构建、安装包或安装的验证在用户检测通过或明确要求该验收后执行。不会为了产物验收自动提前触发产品编译 / 打包。

测试使用隔离目录和测试档案，保留用户真实学习库、附件及配置。安装更新保留应用数据；不能用清除手机数据或覆盖真实档案来消除测试失败。

每次完成回复用三端对应表，分别列出源码、测试、构建、安装包、安装与设备验收。尚未执行的步骤写明“未运行”“待安装”或“待设备验收”。例如只修复了源码且相关测试通过，就记录源码和测试完成、受影响产物需重建；生成了 APK 后，手机安装与验收仍独立记录。

既有验收可查 [Android 修复验收记录](android-acceptance.md)、[Windows 应用说明](../desktop/README.md) 和 [两端本地运行方案](desktop-android-local.md)，以具体源码、产物快照和实际运行证据确定本轮状态。

## 功能等价与完整交付（2026-10-13）

用户明确要求不得出现跨端功能被删减的交付，规则同时记录在根目录 AGENTS.md 和 .workbuddy/memory/MEMORY.md。跨端比较以受影响功能的完整用户操作和可观察结果为单位，不以入口、接口返回或构建通过替代功能对应。真实平台限制须列明具体行为与原因，不能未获用户接受就按完整实现标记。

外刊 EPUB 对照包含正文门槛、封面 / 目录 / 版权筛选、导航与下载尾注清理、同 HTML 多篇拆分、标题优先级、图片说明 / 位置、分页、既有缓存和文章身份。个人书籍的短章节、PDF 物理页与短分级新闻保持各自规则，不把外刊的 80 词门槛全局应用。使用同一原文件对比文章、正文和媒体；旧缓存升级保留原包 / 附件及稳定 ID，失败继续读取旧版本。源码、安装包、实际已安装程序和设备上的清洗结果分别记录。

用户随后明确暂不安装并要求逐条审查。230 个编号的修复前审查证据见 [三端功能删减逐项审查](feature-parity-audit-2026-10-13.md)，历史 a9fd APK 当时暂不安装。后续 33 组缺口已修复，用户再要求 Windows / 手机安装测试，两端已安装；Android 又完成首音等待优化，具体新包及限定验收见 [手机安装与首音实测](android-install-test-2026-10-14.md)。不因构建 strict 通过、旧包真机结果或接口存在，把未实际操作的编号批量标记界面通过。完整交付前须保留逐项对应和实际行为验证，真实平台限制未经用户接受不标记完整对应。
