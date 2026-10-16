# Windows 和 Android 本地运行方案

目标是 Windows 电脑应用和 Android 12 以上应用。两端各自保存学习档案、读取词典、运行朗读和翻译，手机使用时无需电脑开机。数据通过手动导出、导入迁移包转移。共用阅读界面、复习算法和数据格式，分别实现设备存储、文件访问和模型运行。

## 当前基础与目标差距

| 功能 | 当前电脑项目 | Android 所需工作 |
| --- | --- | --- |
| 阅读与复习 | React 界面和 TypeScript 复习算法可以复用。 | 适配触屏选区、返回键、键盘、安全区域及后台恢复。 |
| 学习数据库 | Node SQLite 已管理档案、正文、偏好和六类记忆记录。 | 原生 SQLite 实现同一套事务、版本冲突和备份协议。 |
| 词典 | 词条与索引保存在本地文件，服务端按需读取。 | 替换 Node 文件读取和桌面词典运行依赖，保留词条身份与查词结果格式。 |
| 文件导入 | PDF、HTML 等由电脑服务处理，附件位于本地目录。 | 接入系统文件选择器，复制到应用私有目录，适配解析及附件显示。 |
| 翻译 | Hy-MT2 配合固定 Windows x64 AVX2 运行器。 | 编译、集成 ARM64 推理库，验证对应 GGUF 与量化格式。 |
| 朗读 | Kokoro 使用 Node ONNX；日语另有 Python 发音转换。 | 接入原生离线声音或 Android ONNX，同时补齐各语言发音转换。 |
| 迁移包 | 电脑 ZIP 包包含记录、正文及引用的本地 PDF、插图。 | 原生文件导入导出与流式 ZIP 校验，兼容电脑备份。 |
| 安装 | 当前通过本地启动器运行，在浏览器中使用。 | 电脑安装程序和 Android APK 均需新增构建与验证。 |

上表记录实施前的基础与工作范围。当前已增加 Electron 桌面工程、Capacitor Android 工程，以及 Android SQLite、文件、词典、内置朗读和翻译插件。按照新增要求，朗读与翻译的模型、声音和运行组件必须随安装包提供，使用者不需要另装这些资源。代码接入、安装包校验、模拟器运行和手机实机验收分别记录。

## 应用框架

电脑端采用 Electron，保留现有 React 和本机 Node 服务，以独立窗口运行。Electron 内置 Chromium 和 Node，适合保留当前后端；数据库、模型和附件放入用户可写的数据目录，不能写进安装目录。打包时需核对内置 Node 对 `node:sqlite` 的支持，并处理词典、ONNX 等原生依赖的运行版本。已有 `local-data` 先核对、备份再迁移，避免新安装打开一个空档案。[Electron 文档](https://www.electronjs.org/docs/latest/)、[进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)。

Android 采用 Capacitor 承载共用的 React 界面，通过 Java 或 Kotlin 插件访问本机能力，最低版本设为 Android 12，即 API 31。APK 内置界面资源，数据库、模型及附件由手机自己管理。现有 Express 服务和 Windows 可执行文件不能作为 Android 的运行依赖。这个框架选择依据当前代码结构，能减少界面重写，但原生能力仍需逐项实现。[Capacitor Android 文档](https://capacitorjs.com/docs/android)。

学习记录继续使用 SQLite。轻量偏好存储和 WebView 的 localStorage 不承担学习数据库职责；Capacitor 官方也明确区分偏好存储与数据库。[Preferences 文档](https://capacitorjs.com/docs/apis/preferences)。

## 数据库与离线迁移

两台设备各有自己的数据库文件，共用逻辑表、记录键、档案身份和序列化格式。不会让手机访问电脑数据库，也不直接复制仍在运行的 SQLite 主文件，因为还有事务与 WAL 状态需要处理。

`src/lib/platform/localDatabaseTransport.ts` 已将现有数据库命令与 HTTP 分离。电脑默认使用本机接口；Android 启动入口须在 `initializeLocalDatabase` 前注册 `kind: 'native'` 的适配器。Android 构建使用 `VITE_APP_PLATFORM=android`，缺少原生适配器、返回未启用或档案读取失败时停止启动，避免切换为空的浏览器档案。读取开始后禁止更换数据库。

原生插件需要实现 `status`、`profiles`、`bootstrap`、`query`、`settings-since`、`commit`、`operation`、`snapshot`、`previous-snapshot`、`restore`。同一事务的 `operationId` 必须持久保存；界面退出、回执丢失或重试不能重复计入复习。沿用版本冲突重算、文章元数据增量更新、六类记忆记录及原始日期字符串，后台数据库写入不得依赖 WebView 一直存活。

JSON 记录协议可以共用。Android 已增加系统文件选择与保存接口，ZIP 和 JSON 恢复直接读取手机私有文件，通过文件句柄调用，不调用电脑下载地址。PDF 和 ZIP 字节保留在原生层；界面只传文件标识。插件缺失时停止相应操作。

首版迁移包含学习记录、文章正文和被引用的附件，沿用校验、恢复前快照及失败回滚。附件使用稳定标识，显示时由各平台解析成本机文件地址；Android 临时文件选择地址不能成为长期附件引用。基础词典、翻译模型与声音随安装包提供，不混进每次学习迁移。

**导入是档案恢复或替换，不是两台设备的进度合并。** 例如电脑与手机都学习了一周，导入电脑备份不会自动合并手机这一周的记录。界面应显示这一区别，并保留恢复前档案；双向合并不属于本次手动迁移范围。

## 本机翻译

两端使用 Hy-MT2，共用选句和分段翻译逻辑。Android 通过内置 llama.cpp JNI 推理，保留源语言、目标语言、超时、取消和完整译文校验。单个 CPU 推理请求执行，最多另排队四个请求；取消可打断正在执行的计算，超时或截断不作为成功译文。[llama.cpp Android 文档](https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md)。

Windows 安装包包含约 462 MB 的既有 1.25bit 模型及固定 AVX2 运行器。Android 使用腾讯官方标准 Q4_K_M GGUF，模型大小 1,133,080,448 字节，SHA-256 为 `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699`；模型固定版本 `a0c709d9fac510f2c807aa3af52872340dc37a4a`，llama.cpp 固定版本 `8ae386707bed05f02354dbfc6fa5ee0cf58e5f0f`。ARM64 与 x86_64 均已编译，采用 Android NDK 28.2，原生库满足 16 KiB 页面对齐。未将 Windows 专用类型号或可执行文件当作手机运行组件。[项目当前翻译说明](local-translation.md)、[腾讯官方 GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/tree/a0c709d9fac510f2c807aa3af52872340dc37a4a)。

Android 12 是系统兼容要求，无法单独决定模型速度。运行内存还包括上下文缓存、推理缓冲、界面和词典，不能把模型文件大小当成全部内存占用。先采用短选句、有限上下文和单次推理，长选区依次分段；模型加载失败明确提示，不转发到电脑或云端。性能验收记录冷启动、首段等待、峰值内存和连续使用后的发热影响，不照搬电脑测试秒数。

## 本机朗读

Windows 内置 Kokoro 模型、美式与英式音色、法语 Siwis 和日语 Alpha，以及 Node ONNX、法语发音组件与微软 VC 运行库。日语附带官方 Python 3.12.10 嵌入版和固定版本的发音依赖，不读取使用者电脑的 Python、用户包目录或 `PYTHONPATH`；VC 运行库来自微软官方发行包，放在应用自己的目录，不需要另装到系统。[当前朗读说明](tts.md)、[日语朗读依赖](tts-japanese.md)。

Android 内置 Sherpa-ONNX 1.13.8、ONNX Runtime 与全部模型及发音资源。美式 `af_heart`、英式 `bf_emma`、法语 `ff_siwis` 使用 Kokoro int8；日语使用实际支持日语的 Supertonic 3 int8 内置音色。手机日语音色与桌面日语 Alpha 不同，不依赖系统另装声音、电脑服务或运行时下载。[Kokoro 原生配置](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)。

手机生成的 PCM 通过本机 AudioTrack 播放，播放完毕才确认完成。已处理取消、音频焦点及耳机断开，进入后台时停止朗读。当前内置模型不提供实测逐词时间，插件只报告真实播放开始，不伪造逐词边界；持续后台播放仍需后续服务实现。

## 完全本地运行条件

界面、基础词典、翻译模型、朗读模型与音色必须内置安装包。打包缺少资源时失败；首次启动校验并部署内置资源，运行阶段不自动联网补下载。模型文件安装完整后，即使重启或清除临时音频缓存也能继续使用。个人附件继续通过学习迁移包转移。

两端已关闭云端全文预处理、AI 讨论及远程朗读回退，并限制外部网络请求和远程图片。Windows 按使用要求保留手动外刊更新：只有点击“更新外刊目录”或“更新这本外刊”时，才能从已配置来源读取外刊，逐次校验重定向，不发送个人学习档案。开机和定时自动更新保持关闭。Android 当前源码也已增加用户手动外刊更新：目录与正文读取使用本机缓存，只有用户发起更新后，原生外刊插件才能访问配置的 GitHub 仓库与 News in Levels 的限定 HTTPS 主机及路径，每次重定向重新核对；不开放任意地址、明文 HTTP 或 WebView 外部联网。新版 manifest 因此外刊功能声明 `INTERNET`，同时保持 `usesCleartextTraffic=false`。此权限不表示朗读、翻译或学习记录改用网络服务。模型或声音缺失时明确报错，不自动下载；已有外刊、阅读、复习、查词、朗读和翻译均可离线使用。当前修复的主机与模拟器结果、已安装手机包的证据及待完成的手机功能验收见 [Android 修复验收记录](android-acceptance.md)。

## 实施顺序与完成条件

1. **共用数据库接入层。** 已拆分 HTTP 与原生传输接口；主机侧测试验证无网络调用时仍能使用现有设置和复习逻辑。这一步不代表 Android 插件已完成。
2. **Android 本地阅读与迁移。** 建立 API 31 以上原生工程，实现 SQLite、文件、词典和 ZIP 导入导出。验收电脑导出、手机导入、手机复习、手机导出、电脑恢复，核对正文、附件、日期和复习状态。
3. **两端独立朗读和翻译。** 实现 Android 原生声音与 ARM64 翻译，完成电脑离线资源检查及回退限制。验收取消、长文分段、缺失资源和低内存错误，保证失败不会丢失档案。
4. **安装与设备验证。** 生成 Windows 安装包和 Android APK。升级保留数据库；强制退出后重开保留已确认保存的记录；开启飞行模式、关闭电脑并清除临时音频缓存后，Android 的导入、阅读、查词、复习、朗读、翻译及导出均可运行。

## 当前接入与运行

应用已移除启动欢迎首页。新档案打开后直接进入书库；已有有效阅读书签时继续打开原文章。

Windows 桌面版使用 Electron 44.5.1，程序独立启动本机服务，用户档案放入 `%APPDATA%\\readge`。旧学习库、个人导入、外刊附件和用户词典通过一致 SQLite 快照和逐文件校验备份后迁移，原目录保留；朗读翻译模型、运行依赖、日志及预览文件排除在学习迁移之外。安装、升级和卸载不主动删除用户档案。窗口、任务栏、安装/卸载程序和快捷方式统一使用 readge 品牌图标。

```powershell
npm run desktop:build
npm run desktop:start
npm run desktop:pack
npm run desktop:package
```

`desktop:pack` 生成 `build/desktop/win-unpacked`，`desktop:package` 生成 Windows x64 NSIS 安装程序。桌面窗口仅连接本机服务；服务只在手动外刊更新期间允许访问已配置的来源，其余请求保持本机限制。关闭前先等待持久写入完成；在线讨论、云端预处理和远程朗读回退均关闭。安装包的 `resources/offline-resources` 包含完整朗读、翻译和嵌入 Python，首次向用户目录部署，升级只处理资源清单允许的目录，不覆盖学习档案。翻译运行器要求 CPU 支持 AVX2。

Android 工程固定 Capacitor 8.5.3，最低 API 31，编译/目标 API 36。启动前注册手机数据库；缺失插件时停止读取。SQLite 沿用十条命令、持久事务回执、版本冲突、元数据增量和恢复前快照。系统文件选择后的临时来源复制到私有目录，文章保存兼容电脑的附件标识。

Android 12 初始 WebView 91 也属于支持范围。APK 内置所需 JavaScript 兼容代码，覆盖操作取消、结构化复制、安全 UUID 和数组等接口；已有正常原生实现保持使用。Android 构建单独转换完整样式表的层级、颜色、视口高度和位移，不要求使用者先联网升级 WebView，Windows 样式与安装包不受影响。

Android 已接入 JSON/ZIP 保存与恢复、被引用附件校验、PDF 原页渲染、英文 ECDICT 和 ReadAge 自编词典安装及查词。当前导入源码已补齐原生 PDF、EPUB、DOCX、TXT 与 HTML 解析：手机入口不再拒绝 EPUB/DOCX/PDF，按章节或 PDF 原页准备，每批最多 80 篇／页，支持继续下一批与重试。EPUB 沿用书内阅读顺序，Word 按一级标题样式拆章；PDF 同时保留原页标识。原文件复制到应用私有目录，内嵌栅格图片保存为稳定附件引用，临时文件选择地址不写入文章。仅包含扫描图片的 PDF 不生成空文章，明确要求先 OCR；需要密码或禁止提取文字的 PDF 明确提示使用允许提取的副本，旧版 DOC 需先转换为 DOCX。ZIP/JSON 继续通过“我的学习”恢复学习备份。这些导入修复已通过主机解析回归和 Android 12 模拟器的 3 项实际解析测试，覆盖 PDF 文字／Bitmap 插图、EPUB 文档声明及 DOCX 章节分页；手机文件选择与完整导入体验仍待实机验收。

已验证旧 APK 的 `assets/readage-runtime` 包含约 1.44 GB 的朗读、翻译及许可资源，首次向应用私有目录部署并逐文件校验，完整资源验证后才发布新版本目录。新版本发布成功后清理旧模型，避免每次升级累积约 1.44 GB；失败时保留旧资源和学习档案。清理只处理受控模型目录，升级不会替换数据库或个人附件。

当前源码的启动顺序为 `src/main.tsx` 等待 `initializeAndroidPlatform`，再等待 `initializeNativeResources` 调用原生 `NativeRuntimeResources.ensure`，之后才初始化数据库并渲染 React 书库／阅读界面。当前清单 273 个文件共 1,438,812,234 字节；新应用进程第一次 ensure 会完整校验已有资源代的 SHA，首次部署则复制并校验资源。同一进程成功后使用静态缓存，因此不是每次点击朗读都重新校验翻译模型。这是源码与清单核对，尚未测出手机启动校验、模型加载或合成各阶段耗时。

```powershell
npm run android:check
npm run android:build
npm run android:apk
```

`android:build` 校验固定来源、构建内置界面并同步原生工程，复制基础词典和朗读/翻译资源；缺资源则失败。首次开发准备可运行 `npm run android:setup-runtime`，显式下载固定官方模型、原生依赖与源码；应用运行不下载。`android:apk` 需要 Java 21、Android SDK Platform 36、Build Tools 36.0.0、NDK 28.2.13676358 和 CMake 3.22.1。优先使用配置的工具，也可发现本次任务在 `tmp/android-tools` 准备的便携工具；不修改系统环境。包内模型不压缩，初次部署需要另外约 1.44 GB 私有文件空间，安装及升级时还需临时空间。

使用原签名证书的冻结修复 APK 已更新到用户手机，实际安装文件哈希与冻结包一致；专用 Android 12 模拟器此前的 23 项原生回归通过，最新 app-only 检查另行通过生产 WebView 书库启动／翻译、阅读排版、外刊／导入入口、可信触屏事件及选区工具栏定位。选区由 DOMRange 构造，长按／拖选完整手势仍待验收。仍待完成手机实际 UI 截图与操作、五类文件选择与导入、完整外刊下载、朗读及精度对照；法语／日语词典原生包、持续后台朗读服务，以及 ARM64 手机的性能、发热、音频硬件、强退和升级验收也仍需分别记录。Android 12 x86_64 模拟器运行不代表已验证真实 ARM64 手机性能；离线阅读和模型运行不连接电脑或云端，手动外刊下载单独遵循上述限定 HTTPS 规则。

## 内置资源构建与验证记录（2026-10-09 至 2026-10-11）

| 产物 | 位置 | 验证状态 |
| --- | --- | --- |
| Windows x64 安装包 | `build/desktop/readge-0.1.0-windows-x64-setup.exe`，1,230,713,623 字节，约 1.23 GB | 全部模型、声音、Python 和原生运行组件已内置；未签名。最终安装包解出程序的代码、资源与图标已核对，首次部署、四种语言朗读、翻译及重启后档案保留验证通过；已包含朗读提速和播放状态修复。 |
| Android 调试 APK（本轮修复前的历史包） | `android/app/build/outputs/apk/debug/app-debug.apk`，1,631,044,421 字节，约 1.63 GB | 当时内置 273 项朗读、翻译和许可资源；逐文件 SHA-256 校验通过。最低 API 31、目标 API 36、签名及 16 KiB 对齐检查通过，当时无 INTERNET 权限；Android 12 模拟器的朗读、翻译和实际阅读界面验收通过。此结果不覆盖新增文档导入、手动外刊及当前界面修复。 |
| Android 冻结修复 APK | `build/android-phone/model-comparison/readge-phone-fixes.apk`，1,644,278,425 字节，约 1.64 GB | 使用与手机旧安装一致的原签名证书；手机已更新，实际安装 APK 哈希吻合。专用 Android 12 x86_64 模拟器此前 23 项原生测试通过，最新 app-only 的书库／翻译、阅读排版、外刊／导入入口及选区工具栏检查通过；选区由 DOMRange 构造。手机完整手势、UI、完整外刊下载和性能对照待验收。 |
| Android 后来生成的当前包 | `android/app/build/outputs/apk/debug/app-debug.apk`，1,644,503,906 字节 | `2026-10-11T03:04:13.144Z` 记录的 9b531… 包，平台检查构建／同步／安装包为 current；尚未安装或设备验收，不能沿用冻结 c05f61… 包的设备结果。当前输出已替换上表历史调试包所在路径。 |
| Android 流水线诊断测试 APK | `build/android-phone/model-comparison/readge-model-pipeline-test.apk`，327,014,889 字节 | 新增诊断类已编译并打包，使用原签名证书；USB 离线，尚未确认安装或设备执行，不作为 q8／fp32 性能结论。 |

Windows 安装包 SHA-256：`987132eff6d3e937c9ff460a871a582f3c26038f96626b5ad8c0481683d652d4`。Android 上述历史 APK SHA-256：`f39f4b2e78c479900f9b8a1347237432f8e1b3346ca581d8c312d341323df85d`，不移作新版验收。冻结修复包 SHA-256：`c05f61aee2a905d31bf9c0e5f54c9d0a945b3554513916a55d9b91fce175aac7`；公开签名证书 SHA-256：`de260020066511703db8e701412329d8fe0f58339e574ad9d64e12c51cc4a9f3`。手机系统记录最后更新时间 `2026-10-11 10:53:25`，新的安装目录内 `base.apk` 于 `2026-10-11T02:55:12.566Z`、`2026-10-11T02:57:42.458Z` 两次核对哈希均与冻结包吻合。独立保存的 `build/android-phone/model-comparison/phone-main-install-check.json` 记录 `installed=true` 及实际安装文件证据；客户端 USB 断连虽返回 255，手机包系统已成功提交。此前辅助流程曾因 USB 离线出现 `installed=false` 暂态；本轮于 `2026-10-11T03:18:34.542Z` 再次重读主包 SHA 成功，当前 `phone-benchmark-status.json` 已为 `installed=true` 并保存 `installedApp`，主应用仍以独立实际文件证据为准；`measuredOnPhone=false`、空 `runs` 仍表明尚无语音 A/B 数据或手机 UI 截图，测试 APK 尚未确认安装。未卸载或清空学习数据。

后来生成的当前 Android 主包 SHA-256 为 `9b5310484a58b565730b39c379adf19e18fc699cf0c0b6996f8ff0558eec2065`，流水线诊断测试包 SHA-256 为 `1240041f111397f40611199f0df4682719fc37525f808c3412a0300402b9080b`；两者与已安装、已验收的冻结包分别记录，不声称新包已进入手机。

手机连接进度：`2026-10-11T03:18:34Z` 通过 SDK 37／libusb 和原始 shell 再次核对实际主包 c05f61… 哈希成功；但 124004… 测试包 `pm install` 回执为空，随后设备掉线，未确认安装。停止本轮等待读取进程并重启 Windows 默认 USB 后端后，仍每约 0.5 秒读失败。`build/android-phone/model-comparison/usb-connection-diagnostic.json` 记录 `testInstallConfirmed=false`、`benchmarkStarted=false`、`measuredOnPhone=false`。已请求用户提供无线调试配对地址／配对码与连接地址，截至本记录尚未收到，未无线配对或开始手机 q8／fp32 比较。

Windows 内置资源共 2720 个文件，1,461,771,919 字节。最终安装包内全部 69 个原生组件的 633 组依赖核对通过，无缺失 DLL 或导出符号；实际运行中 11 个 VC 模块全部来自独立用户目录内的随包副本。通过阅读接口生成美式、英式、法语、日语 WAV，并实际完成英中和日英翻译。空模型环境首次部署 2720 个资源，关闭重开不重复复制；旧设置升级后档案身份和已保存记录保留。资源运行测试使用独立档案，与最终安装包解出程序的 EXE 和完整 ASAR 逐字节一致，未更改系统网卡。

2026-10-11 修复 Windows 外刊列表因更新状态响应格式错误而加载中断的问题，恢复“更新外刊目录”和单本更新按钮，并保留手动 EPUB/PDF 文件入口。手动外刊更新在独立目录内通过模拟来源的真实路由、下载、解析和入库验证；45 项相关回归测试通过。程序与安装程序的默认图标均核对了 16、32、48、128、256 五个尺寸，全部匹配现有 readge 品牌图。

随后将真实学习资料备份、逐文件校验并迁入 `%APPDATA%\\readge`。迁移时包含两个档案、183 篇已保存文章、101748 条学习记录和 121 期外刊，共 7877 个个人资料文件；原项目资料保留。已启动最终安装包解出的新版程序，真实本机服务返回六个外刊来源与 121 期目录，数据库完整性检查通过，已有外刊正文可读取。启动后的新阅读继续写入正常用户档案；迁移验证记录与当前运行数据数量分别保存。

同日修复朗读首段等待过长：Windows 新档案在完整部署 fp32 模型时默认使用 fp32，明确合法的模型选择保留。使用实际随包运行组件同机对照，每项两轮，105 字符首段生成均值从 q8 的 6.66 秒降至 fp32 的 2.10 秒，194 字符后段从 12.94 秒降至 3.52 秒；模型都已内置，无需下载。界面在真实播放开始后才显示“正在朗读”，等待下一段合成时显示“准备朗读”并清除旧词框，取消后的迟到结果不能重启播放。51 项朗读、词位和选区测试、26 项桌面测试、7 项文本处理测试及类型检查通过；未改分段边界或原文。

提速版全新独立档案的首次与重开均实际加载 fp32，四种音色、英中和日英翻译两轮通过，12 份模型对照音频及四种最终音色均校验为有效非静音 PCM。最终 NSIS 中的首页与全部 46 个编译后阅读资源已逐字节核对。真实桌面设置另存备份后由 q8 恢复为 fp32，关闭旧窗口后已用最终安装包解出的程序重新打开正常档案，启动日志确认实际加载 fp32；书库与记录完整性复核通过。

上述历史 Android 包在项目专用 Android 12 x86_64 模拟器中验证，飞行模式开启，Wi-Fi 和移动数据关闭。数据库 8 项、文件与 ZIP 6 项、原生翻译 3 项、四语言朗读及取消 2 项、实际 WebView 朗读桥接 1 项，共 20 项原生测试通过；翻译涵盖英语、法语、日语、中文及超时和取消。当时的 APK 另外通过 WebView 91 的实际朗读播放与停止、书库初始化及阅读界面翻译验收：`The cat is sleeping.` 返回 `猫正在睡觉。`，七项兼容接口均已可用，首屏直接进入 `/library`。本轮手机反馈后的新增修复另行验收，不能用这 20 项历史结果代替。

资源安装主机测试 7 项通过，覆盖校验、修复、失败时保留旧资源、成功后清理旧模型、档案保留、路径链接保护与清理失败重试。旧浏览器兼容测试 11 项及样式转换测试 7 项通过；APK 中已核对完整兼容样式和 core-js 许可。模拟器结果不代表已验证 ARM64 实机性能和音频硬件。

本轮冻结 c05f61… 修复包此前在项目专用 Android 12／API 31 x86_64 模拟器完成 `OK (23 tests)`：数据库 8 项、文件／资源 6 项、文档 3 项、翻译 3 项、朗读 2 项、实际 WebView 朗读桥接 1 项；证据已复制保存为 `build/android-phone/fixes-emulator-acceptance/instrumentation.log`。同目录最新 `report.json` 来自 app-only 复跑，`passed=true`、`classes=[]`，其中 `speech` 数据沿用此前回归，不能视为再次执行 23 项测试或朗读生成。`app-smoke.json` 记录生产 WebView 91 书库 `/library` 启动与真实英中翻译通过。这些设备证据对应冻结包，不自动覆盖后来生成的 9b531… 当前包。

最新 `app-ui-smoke.json` 的 `passed=true` 覆盖窄屏阅读排版、长标题及外刊／导入入口，并记录按实际 WebView 边界映射的 Android input 点击触发可信 touchstart／touchend，CDP 未派发触屏事件。之后用 DOMRange 构造原句选区，工具栏按钮高度 44 px；滚动 36 px 时选区和工具栏均移动 −36 px，原测试档案和触屏仿真设置已恢复。本轮未修改生产 UI 源码；模拟器检查不等于手机截图验收，也不包含长按／拖拽选区的完整手势。`proof.json` 保存冻结包、日志／JSON 与四张 PNG 的对应哈希，滚动后的选区图实际可见工具栏；初始选区截图早于绘制，未作为可见工具栏证据保存。新增 `BundledSpeechPipelineDiagnosticTest` 已实际 Gradle 编译并进入上表流水线诊断测试 APK，但未确认安装或在设备执行。

Android 外刊主机边界测试为 13 项。此前 `tmp/android-tools/magazine-live-check/report.json` 记录六个真实来源的目录元数据、EPUB HEAD 与分级新闻 HTML 正文定位；那次 HEAD 正文字节为 0。之后 `tmp/android-tools/magazine-full-import/report.json` 已完成真实整期下载及生产 `NativeMagazineStore`／`NativeMagazineHttp`／`NativeDocumentParser` 主机链路：经济学人 2026.10.10 EPUB 为 6,179,760 字节，Git blob SHA-1 与远程目录一致，80＋15 批次解析出 95 篇、1294 段、65,895 词，保留原包并发布 126 个图片文件、127 个引用；两个分级新闻级别各缓存一篇完整 6 段文章，共 97 篇。禁用网络与解析器后重开 Store，97 篇全文／媒体 JSON 指纹一致，网络与解析调用均为 0。此验证使用主机 JVM 隔离文件系统，未使用手机、Android 系统解析环境或学习数据库，不是用户手机下载成功证据，也未验证真实整期 PDF 下载。

Android 生产 Kokoro 保持 q8；fp32 仅在测试 APK 提供对照资源，325,560,556 字节，SHA-256 为 `b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11`。尚无手机速度／精度对照结果，不改变生产默认。

独立诊断 DEX JAR 的 `--probe` 已在既有专用 Android 12／API 31 x86_64 模拟器执行成功，输出 `completed=true`、`jniLoaded=true`，通过冻结 c05f61… 实际安装 APK 的 x86_64 库目录加载 JNI。传入 JAR 的 SHA 已核对，应用 UID 所有且为 0400 只读；未加载模型、合成或播放，未启动 Activity、学习数据库、安装应用、重置 AVD 或操作真机，也未改共享 ADB 服务。自行启动的模拟器已关闭并经主机确认进程与 5560／5561 监听退出。证据为 `build/android/kokoro-diagnostic/emulator-probe/aa136e42-9a69-47a5-8b5b-1aaccdc77309/probe.json`、`proof.json`、`launcher-output.log`；同目录 `startup-source-check.json` 记录启动路径源码和资源清单。此探针只证明 x86_64 JNI 加载，不能当作 ARM64 手机模型速度、精度或可听首音结果，也不计入此前 23 项回归。

主任务最近一次 `npm run platforms:check` 的 `2026-10-11T03:26:52.759Z` 记录为：网页构建 current，Android 构建／同步／安装包 current，Windows 构建／安装包 unrecorded，报告为 `build/platforms/status.json`。Android 当前包记录对应后来生成、尚未安装的 9b531… 包；手机安装哈希及模拟器测试属于冻结 c05f61… 包，不能互相代用。这次文档更新未重建或新增设备操作，独立模拟器探针已单独记录；三端范围及待验收状态详见 [Android 修复验收记录](android-acceptance.md) 和 [跨端修改与交付](platform-parity.md)。

复跑入口包括 `npm run desktop:test`、`npm run desktop:verify-package`、`npm run desktop:resources-check`、`npm run android:test-database`、`npm run android:test-runtime`、`npm run android:test-documents`、`npm run android:test-magazines`、`npm run android:verify-runtime`，以及 `node scripts/test-android-emulator.mjs --fresh`。文档与外刊命令属于主机测试，不操作手机；模拟器命令只操作项目 `tmp/android-tools/avd/readage-bundle-api31.avd`，`--fresh` 重置该专用测试设备。

Windows 汇总报告为 `build/desktop/offline-verification.json`，最终包完整性、图标、原生依赖及实际运行模块报告分别为 `package-verification.json`、`icon-verification.json`、`pe-integrity.json`、`native-modules-verification.json`；完整应用运行报告在 `build/desktop-smoke/694286a7-a0f2-4fac-b0ec-e238f27f1375/`，真实用户资料验证为 `build/desktop/restored-user-data-verification.json`，外刊修复测试记录为 `build/desktop/repair-tests.log`。朗读模型对照、客户端回归、桌面回归及真实设置备份校验分别为 `speech-latency-verification.json`、`speech-regression-verification.json`、`speech-desktop-regression-verification.json`、`speech-settings-verification.json`，均位于 `build/desktop/`。Android 包内资源报告在 `tmp/android-tools/bundled-runtime-apk-report.json`，历史 `final-native-20-passed.log` 仍在 `tmp/android-tools/emulator-acceptance/`；冻结 c05f61… 包的 23 项原生回归日志、最新 app-only JSON 与四张可用截图及其哈希已保存到 `build/android-phone/fixes-emulator-acceptance/`，索引为 `proof.json`。完整样式转换报告为 `dist-android/android-css-compatibility.json`。
