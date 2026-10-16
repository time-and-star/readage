# Android 手机反馈后的修复与验收记录

## 2026-10-13 当前包暂不安装，先逐项审查

用户明确要求“暂时不安装，逐条审查功能阉割”。当前 `android/app/build/outputs/apk/debug/app-debug.apk` 为后续外刊原生清洗包，SHA-256 `a9fd3fb5e2f48743961cfd29482e2c437e039b1eb69bb21f8c5f598305fec222`，1,734,101,696 字节。前端构建标记、Capacitor 同步及原生打包对应当前源码，正式词库与语音 / 翻译资源核验通过；**未安装，待设备验收**。本轮审查没有安装或操作手机。

230 项三端审查、确认缺口、每项证据与验证限制见 [完整功能审查](feature-parity-audit-2026-10-13.md)。当前包仍含个人文档拆篇、扫描 PDF、画廊集成、MDX、返回键等已确认缺口；主机测试和构建对应不能据此标记手机功能齐全。外刊同原包对照只覆盖其指定解析范围。

<a id="2026-10-13-最新顶部与查词包安装"></a>

## 2026-10-13 已安装顶部与查词包（历史）

本段只对应顶部空白与查词性能修复包 `b253d421…`，是该包的独立历史交付记录。后续外刊清洗已有新 a9fd 包但用户暂不安装；新源码、新 APK 的安装与设备结论须另行核验，不能沿用本段通过范围。

当时生成于 `android/app/build/outputs/apk/debug/app-debug.apk` 的完整 APK 为 1,734,101,696 字节，SHA-256 `b253d421d0d42f6e1b4c4863387a8c893c75e178964cb25faf42fa3432434880`；该路径现在已被 a9fd 新包替换，不再指向此历史文件。原签名证书保持 `de260020066511703db8e701412329d8fe0f58339e574ad9d64e12c51cc4a9f3`，已在 vivo V2190A / Android 13 / ARM64 保留数据覆盖安装并启动，系统最后更新时间为北京时间 `2026-10-13 16:32:14`。实际安装 `base.apk` 哈希匹配；安装前后、首次启动前的数据库与偏好文件哈希一致。WebView 内 Android `inputId=86a97cc2d89d8f685f915e4874257c3463e5d8b9cf2af2c67034bcdaaf7fcddf`、`sourceId=0e21b305594d6217091ee0c00197afb6334a450667c514770256a7eea013c604` 匹配此包。证据：[安装记录](../output/android-dictionary-2026-10-13/install-header-final/install-report.json)。

查词以已有独立标记档案验收，应用冷启动后并发核对 50 个真实单词的学习身份，随即点词，不加入人为等待。`between` 首次可见释义耗时 4.954 秒，后续 `hurricane` 0.748 秒、`science` 1.058 秒；三词均显示释义、3 本词典及保存完成。完整词卡、关闭、一次受控失败后的手机本机词典提示与重试成功均已实际操作；失败及重试前后的学习事件计数均为 16，没有重复追加。这证明本次限定交互和热查询改善，首词仍有约 5 秒等待，不能写成所有查询即时完成。原始 UI 报告因末尾未找到书架测试文章而保持 `passed=false`，其已完成步骤逐项留存，未覆盖或改写失败结果。证据：[原始查词及顶部报告](../output/android-dictionary-2026-10-13/performance-header-final-ui-report.json) 与同名前缀 PNG。

实际手机 360 × 769 CSS px / DPR 3 下，阅读顶部、原生向上与向下滑动均为导航 `top=0`、内容 `innerTop=0`、顶部 padding 与 body padding 为 0、导航高度 65 px，页面宽度与视口均为 360 px；Options 原生打开、关闭且菜单位于视口内，Back 原生返回书架成功。补验只重做缺少的返回重进：在同一隔离档案原生点击 Back → 我的书架 → 测试文章，重新进入后以上尺寸仍正确，书架与重新进入截图已目视核对。未用直达路由代替书架点击，未重跑词卡或重新打包。证据：[重进补验](../output/android-dictionary-2026-10-13/header-reentry-supplement-ui-report.json)、[测试书架截图](../output/android-dictionary-2026-10-13/header-reentry-supplement-library.png)、[重新进入截图](../output/android-dictionary-2026-10-13/header-reentry-supplement-reopened.png)。手机横屏、通知、安全区变化、字号调整、词卡朗读及整体功能清单仍待相应设备验收。

正式私有词库的 15 份完整性验证缓存记录已从手机读取，均具备可靠文件身份、大小及纳秒变化时间；记录证据在 [设备词库验证缓存](../output/android-dictionary-2026-10-13/header-final-device-receipts.json)。缓存失效、文件或清单变化仍触发完整校验；这些记录不代替词卡操作或自然耗时测量。主报告与补验均恢复原档案 `97189e6d-d447-4133-9d9b-3868d1a53851` 和原阅读路径，原学习库内容及六类学习证据表保持，原档案没有测试文章。原页恢复可能正常更新阅读会话元数据，不能笼统宣称每次 UI 验收后所有文件哈希不变；本次重进补验的原配置变更清单为空。

该快照三端交付已集中验证：共享适配 / 学习 ID / 平台超时 34 项、Java 主机词典 18 项、类型检查通过；隔离浏览器顶部 12 场景 / 325 检查通过。Windows 安装包内容核验通过，网页最终构建完成，`npm run platforms:check -- --strict` 于 `2026-10-13T08:33:00.091Z` 通过。当前 `dist/` 由 web 构建占用，Windows 独立安装包旁车有效。Windows 日常安装版本轮未更新；上述源码、测试、构建、安装和设备状态分别记录如下，仅属于 `b253d421…` 这轮快照。

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 行为保持，共享顶部样式已对应 | 平台 / 适配回归、类型检查；顶部 12 场景 / 325 检查通过 | 最终 web 构建完成，`dist/` | 不适用 | 不适用 | 隔离真实组件顶部范围通过；本轮词卡 UI 未复测 |
| Windows | Node 词典与用户规则保持，共享界面已对应 | 安装包代码、46 编译资源、正式模型与词库核验通过 | 构建及打包完成，后切回 web | `build/desktop/readge-0.1.0-windows-x64-setup.exe`，SHA-256 `501cb9a3fbb177b56902c8c34945651e4201d8ecaff9b2a41c8eaa240a69f78c` | 日常安装版待安装 | 安装版界面待设备验收 |
| Android | 轻量词形、5 词批次、文件校验缓存及顶部实际安全区修复完成 | 适配 / 身份 / 超时、Java 主机及上述真机范围通过 | 前端构建与 Capacitor 原生资源同步完成 | 本轮完整 APK 已生成并核对，SHA-256 `b253d421…` | 已安装真实 vivo V2190A 并启动 | 三词 / 保存 / 完整卡 / 重试、竖屏顶部 / 原生滚动 / Options / 返回重进范围通过；其余待设备验收 |

逐项编号及限制见 [用户功能逐项验收](user-feature-acceptance.md#2026-10-13-顶部与查词包的限定交付结果)。下方旧包的时间、哈希与验证结果保留为历史证据。

## 2026-10-13 最新完整包已转移并启用

用户已连接 USB 调试手机并要求转移启用新安装包。本轮没有修改产品源码或重新打包，先运行 `npm run platforms:check`，确认当前网页、Windows 安装包、Android 前端、Capacitor 同步资源和 APK 与当前源码对应。Windows 开发构建目录仍由网页构建占用，历史安装包的独立记录有效。

已在真实 vivo V2190A（Android 13、ARM64、序列号 `3504296688000CN`）执行 `adb install -r --no-streaming`，保留数据覆盖安装。完整 APK 为 `android/app/build/outputs/apk/debug/app-debug.apk`，1,732,862,875 字节，SHA-256 `8254b675e90fac9a4272c992520f51bba363e9b3df6ff2dfad65edb4c11f9377`；签名证书 SHA-256 为原证书 `de260020066511703db8e701412329d8fe0f58339e574ad9d64e12c51cc4a9f3`。手机 vivo 安装保护要求本次安装授权及锁屏密码验证，机主在手机完成验证后安装成功。传输及系统确认共耗时约 228 秒；未关闭系统安装保护。

手机系统记录 `versionName=1.0.1`、`versionCode=2`、`lastUpdateTime=2026-10-13 09:44:19`（北京时间）。已读取实际安装目录中 `base.apk` 的 SHA-256，与上述最新 APK 完全一致；版本号本身不能区分同版本号的不同构建。升级前与升级后、首次启动之前的学习数据库全部文件及 `shared_prefs` 文件哈希逐一一致。未卸载、未清空数据、未导入测试文章或修改学习档案。

应用已通过 `am start -W` 启动，系统确认 `MainActivity` 处于前台。实际 WebView 的 `readge-build.json` 中 Android `inputId=45db9776a97c42352c747729ba8b9336ec3c5bd90668913fdce977ca680b7fe8`、共同源码快照 `055c6c0174ddd30bca24bdc95f50a42d095523ad9e3c68a71ca5031ca1153355` 均匹配本轮 APK。原档案 `97189e6d-d447-4133-9d9b-3868d1a53851` 与原有阅读页正常加载，随后观察到本期书架正常显示。环境为 WebView 150.0.7871.181、360 × 769 CSS px、DPR 3。

本轮只确认安装、启用和实际页面加载。初次观察阅读页时，`between` 查词弹窗先显示查询中，随后出现连接错误提示；未在真实档案中主动重试或进行会新增学习记录的测试。之后只读查询原生词典接口，六个词库均报告可用，`between` 在自编词典与 ECDICT 返回结果，但这些接口证据不能代替词卡界面重试成功。该交互保留待复核；朗读听感、横竖屏、滚动及其他完整功能仍待逐项真机验收。

证据在 [手机安装与启动记录](../output/android-phone-install-2026-10-13/install-report.json)、[启动核对](../output/android-phone-install-2026-10-13/launch-report.json)、[本机词典只读诊断](../output/android-phone-install-2026-10-13/dictionary-diagnostic.json)、`phone-started-initial.png` 与 `phone-started.png`。首次启动核对脚本未识别该手机的 `topResumedActivity` 字段，已适配后仅重跑只读核验；初次失败记录单独保留，未重装或重建产品。逐端与编号状态见 [用户功能逐项验收](user-feature-acceptance.md#2026-10-13-真实手机覆盖安装与启用)。以下 2026-10-11 记录均保留为对应旧包的历史证据。

本记录对应 2026-10-11 手机反馈后的修复。使用原签名证书的冻结修复 APK 已安装到用户手机，手机实际 `base.apk` 哈希与冻结包一致。项目专用 Android 12 x86_64 模拟器此前完成 23 项原生回归；最新仅运行应用界面的 app-only 检查通过生产 WebView 书库启动／翻译、窄屏阅读排版、外刊与导入入口、可信触屏事件及选区工具栏定位。选区由 DOMRange 构造，不代表长按／拖选完整手势已通过。尚无本轮手机 UI 截图、语音耗时或精度对照结论。此前 20 项原生测试属于历史包，历史记录保留在 [两端本地运行方案](desktop-android-local.md)。

## 冻结安装包与设备状态

当前冻结包为 `build/android-phone/model-comparison/readge-phone-fixes.apk`，1,644,278,425 字节。APK SHA-256 为 `c05f61aee2a905d31bf9c0e5f54c9d0a945b3554513916a55d9b91fce175aac7`，公开签名证书 SHA-256 为 `de260020066511703db8e701412329d8fe0f58339e574ad9d64e12c51cc4a9f3`，与用户手机旧安装的证书一致。签名差异造成的更新不兼容已修正，重新安装后通过读取手机系统版本与实际安装文件确认更新；未通过卸载或清数据绕过问题。

手机系统现记录 `lastUpdateTime=2026-10-11 10:53:25`，应用已切换到新的 `codePath`。主任务于 `2026-10-11T02:55:12.566Z` 和 `2026-10-11T02:57:42.458Z` 两次读取该路径下 `base.apk` 的 SHA-256，均与上述冻结包一致。独立保存的 `build/android-phone/model-comparison/phone-main-install-check.json` 记录 `installed=true`、实际安装文件与相同哈希，是主应用安装证据。

本次非流式 USB 传输耗时 72.416 秒，约 21.7 MB/s；客户端结束时 USB 断连返回 255，但手机包系统已提交成功，上述实际文件核对确认安装结果。客户端退出码不能单独代替安装状态。此前辅助流程曾在 USB 离线时重置为 `installed=false`；本轮于 `2026-10-11T03:18:34.542Z` 重读主包哈希成功，当前 `phone-benchmark-status.json` 已记录 `installed=true` 与 `installedApp`。测试包安装仍未确认；主包状态以独立实际文件证据为准。其 `measuredOnPhone=false`、空 `runs` 仍表明尚未执行 q8／fp32 手机对照，也尚未读取实际手机 UI 截图。

手机连接进度更新：主任务在 `2026-10-11T03:18:34Z` 使用 SDK 37／libusb 和原始 shell 读取，再次核对实际主包 SHA 为 c05f61…；随后 124004… 新测试包的 `pm install` 回执为空，连接消失，未确认安装。停止自己的等待读取进程并重启为 Windows 默认 USB 后端后，仍每约 0.5 秒出现 read failed。`build/android-phone/model-comparison/usb-connection-diagnostic.json` 记录 `testInstallConfirmed=false`、`benchmarkStarted=false`、`measuredOnPhone=false`。已向用户请求无线调试配对地址／配对码及连接地址，截至本记录尚未收到，未执行无线配对或手机模型比较。生产 q8 保持不变。

上述手机与模拟器验收对应冻结的 c05f61… 包。后来当前源码又生成 `android/app/build/outputs/apk/debug/app-debug.apk`，1,644,503,906 字节，SHA-256 为 `9b5310484a58b565730b39c379adf19e18fc699cf0c0b6996f8ff0558eec2065`，构建产物记录时间为 `2026-10-11T03:04:13.144Z`。这个新包尚未安装或设备验收，不能沿用冻结包的安装及功能结论。

## 文档导入

原手机入口明确拒绝 PDF、EPUB 和 DOCX，原生文件插件也没有正文解析接口。现在系统选择后的文件仍留在原生私有目录，`ReadageFiles.parseDocument` 只向 WebView 返回有界的章节／页批次。手动下载的外刊使用相同的 `NativeDocumentParser.parse(Context, File, filename, offset, limit)`。

| 格式 | 当前源码行为 | 主机验证与限制 |
| --- | --- | --- |
| PDF | Android PDFBox 提取可复制文字，按原始物理页分页，保留原 PDF 和页号；提取支持的栅格插图。 | 主机已验证真实文字、原文件、83 页的 80＋3 分批、密码保护和纯扫描提示；Android 12 模拟器另外通过真实 Bitmap 插图的尺寸／像素、两页文字及原 PDF 保留检查。选中批次完全无文字时拒绝；不内置 OCR，不绕过密码或禁止复制权限。手机文件选择与阅读页显示仍待实机验收。 |
| EPUB | 沿 OPF spine 阅读顺序拆章，跳过空章，保留内嵌栅格图片位置，支持常见 HTML/XHTML 声明、命名字符和可恢复的不完整 HTML。 | 主机章节、文字、图片与分页已验证；Android 12 模拟器通过常见 DOCTYPE／命名字符与实体声明拒绝检查。加密、外部实体、越界引用、损坏 CRC、异常压缩大小明确拒绝，不访问外部 DTD 或图片。 |
| DOCX | 合并文字 runs，保持段落和表格顺序，识别 Title、Heading1、自定义“标题 1”和 outlineLvl 0，按一级标题拆章；读取内嵌图片。 | 主机标题样式与章节继续读取已验证，Android 12 模拟器通过实际两章的 Heading1、runs 合并与分页。外部图片关系不下载，旧版 DOC 须先转换为 DOCX。 |
| TXT / HTML | 支持 UTF-8、带 BOM 的 UTF-16 和常见 GB18030 文本；HTML 提取正文，排除脚本及导航，并保留支持的内嵌 data 图片。 | 实际中文段落、行内文字连接、HTML 实体与 PNG 原始字节已验证。HTML 外部图片不联网下载。 |
| JSON / ZIP | “我的学习”继续提供学习备份恢复与替换，使用原有日期、快照、附件引用和校验协议。 | 本次未扩展迁移格式；文档入口会提示改用备份入口。 |

单个原文件上限 64 MiB，每批最多 80 篇／页，一次预览最多准备 500 篇／页；PDF 上限 2000 页。选中批次的单图上限 16 MiB、图片总大小上限 64 MiB；结构化文档每篇最多 256 个图片引用。ZIP 解压数量、大小、路径及 CRC 均先校验。原文件保存于 `files/readage/originals`；已有 `/api/import/documents/…` 和 `/api/import/images/…` 附件标识继续用于保存与迁移。SVG／矢量图不转为文章栅格附件，仍保留在原文件中；EPUB/DOCX 原包暂不作为新的跨端备份字段导出。

继续准备使用原文件句柄和准确的下一章节／页 offset，重试不能重复追加。取消或超时立即结束界面等待，移除监听并忽略迟到结果；关闭窗口释放临时句柄。已开始的原生单线程解析会完成，不声称能够强制中断 PDFBox 计算。

## 手动外刊与网络边界

当前源码增加本机外刊目录、手动更新、下载、解析和本地缓存。目录查询与阅读不联网；用户点击更新后，`ReadageMagazines` 才启动原生下载，限定配置的 GitHub 仓库和 News in Levels 主机／路径，HTTPS 和每次重定向均重新校验，限制响应大小与等待时间。启动及定时自动更新继续关闭，不发送个人档案或把学习、查词、翻译、朗读改为远程服务。

新版 manifest 声明 `android.permission.INTERNET`，同时 `android:usesCleartextTraffic="false"`。WebView fetch 仍拒绝外部 URL；外刊 API 转发到原生插件，不能通过它请求任意来源。旧包“无 INTERNET 权限”的历史结论不适用于新版。13 项主机目录／HTTPS 边界测试通过，其来源响应为测试 fixture。

此前真实网络检查四个 GitHub 外刊目录及两个 News in Levels 级别，共六个来源：读取目录元数据、经济学人 EPUB HEAD，以及分级新闻 HTML 正文定位。`tmp/android-tools/magazine-live-check/report.json` 中该次 HEAD 的 `downloadedBodyBytes=0`，只代表那次检查的范围。

随后 `tmp/android-tools/magazine-full-import/report.json` 记录真实 HTTPS 下载与生产 Android Java 外刊链路的主机集成验证：`NativeMagazineStore`、`NativeMagazineHttp` 和 `NativeDocumentParser` 在隔离目录实际下载经济学人 2026.10.10 的 6,179,760 字节 EPUB，Git blob SHA-1 与远程目录记录一致；原包 SHA-256 为 `000f09b1c70d3aa4912ad846ddd7f706f9f6ae22fe2c3e38a9e4a70fde649e65`。解析分成 80＋15 篇，共 95 篇、1294 段、65,895 词，发布 126 个图片文件、127 个图片引用并保留原 EPUB。News in Levels 第 1、2 级各下载一篇完整的 6 段文章，总共缓存 97 篇。关闭网络与解析入口后重新打开 Store，97 篇全文／媒体 JSON 指纹完全一致，`networkCalls=0`、`parserCalls=0`。

上述整期下载结果已补足此前仅 HEAD 的范围，但运行环境是主机 JVM 的隔离文件系统边界，未使用手机、Android 系统解析环境或学习数据库。它不证明手机已经下载、展示或写入真实学习档案，也不包含真实整期 PDF 下载或六个来源全部下载验收。

## 界面与朗读

当前源码保留 Android 12 初始 WebView 的兼容代码与样式转换，导入弹窗展示章节／页预览、继续添加与重试。冻结生产 APK 的 WebView 91 已在专用模拟器进入 `/library`，取消、结构化复制、安全 UUID 等七项兼容接口可用，实际 `window.fetch` 英中翻译返回 `猫正在睡觉。`，证据已复制到 `build/android-phone/fixes-emulator-acceptance/app-smoke.json`。

启动路径的源码核对显示，`src/main.tsx` 等待 `initializeAndroidPlatform()`，后者等待 `initializeNativeResources()`／`ReadageResources.initialize`／`NativeRuntimeResources.ensure`，之后才初始化学习数据库并渲染 React 书库／阅读界面。当前资源清单的 273 个文件共 1,438,812,234 字节。每个新应用进程第一次 ensure 会逐文件 SHA 校验已有完整资源代；首次部署则复制并校验全部资源。同一进程成功后使用静态缓存，不能把启动时的整套资源准备描述为“每次点击朗读都会校验翻译模型”。这些是源码与资源清单核对，尚无手机各阶段耗时。

最新 app-only 的 `build/android-phone/fixes-emulator-acceptance/app-ui-smoke.json` 记录 `passed=true`：窄屏阅读排版、长标题及外刊／导入入口通过。按照实际观测的 WebView 边界映射坐标后，通过 Android input 触屏点击，生产 WebView 收到 `isTrusted=true` 的 touchstart／touchend；该步骤没有通过 CDP 派发触屏事件。测试随后用 DOMRange 构造原句选区，验证触屏工具栏按钮高度 44 px，滚动 36 px 后选区和工具栏均移动 −36 px，原测试档案与触屏仿真设置已恢复。本轮未因此修改生产 UI 源码。此前长标题及可信触屏输入失败已被本轮检查覆盖；这些结果仍不包含系统长按／拖拽选区的完整手势，实际手机截图、滚动、点击及选区操作待实测。

同目录 `proof.json` 固定记录冻结包哈希、此前原生回归与最新 UI 检查范围，并校验复制的日志、JSON 与四张 PNG。滚动后的 `app-selection-scrolled-ui.png` 实际可见选区工具栏；初始选区截图早于合成器绘制，未作为可见工具栏证据保存。

朗读界面在实际播放开始后才显示“正在朗读”，等待音频时显示“准备朗读”，提供停止按钮及真实首段时间；取消后的旧回调不能重新开始播放。Android 继续使用内置 Sherpa/Kokoro/Supertonic 和 AudioTrack，生产 Kokoro 仍为 q8；没有因准备对照试验而切换生产精度。模拟器四语言生成、取消和 WebView 播放桥接已通过，不能把其耗时作为手机性能。

fp32 只作为测试 APK 的固定对照资源：`assets/readage-benchmark/kokoro-fp32.onnx`，325,560,556 字节，SHA-256 为 `b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11`。尚无手机 q8／fp32 耗时、声音质量或精度对照结果，也不据此改变默认选择。

## 已执行与待执行

本轮已执行 13 项 EPUB/DOCX 主机测试、7 项使用实际 Android PDFBox 库的 PDF/TXT/HTML 主机解析测试、6 项 TypeScript 导入协议／取消测试，以及类型检查。生产解析类、文件存储与插件通过 Android API 36 的独立 Java 编译。PDFBox 主机测试使用明确的 Android 文件系统、日志及几何替代边界；真实文字提取由生产库执行，不等于 Android 图像、文件选择器或应用生命周期验收。

冻结 c05f61… 包此前在项目专用 Android 12／API 31 x86_64 模拟器完成完整原生回归，复制保存的 `build/android-phone/fixes-emulator-acceptance/instrumentation.log` 为 `OK (23 tests)`：数据库 8 项、文件／资源 6 项、文档解析 3 项、翻译 3 项、朗读 2 项、实际 WebView 朗读桥接 1 项。同目录最新 `report.json` 则来自 app-only 复跑，记录 `passed=true`、`classes=[]`、生产书库／翻译与 UI 通过；其中四语言 `speech` 数据沿用此前回归，本轮没有再次执行 23 项测试或朗读生成。上述结果不代表 ARM64 手机的性能和音频硬件验收，也不自动覆盖后来生成的 9b531… 包。

新增 `BundledSpeechPipelineDiagnosticTest` 已通过实际 Gradle 编译并打入 `build/android-phone/model-comparison/readge-model-pipeline-test.apk`：327,014,889 字节，SHA-256 为 `1240041f111397f40611199f0df4682719fc37525f808c3412a0300402b9080b`，公开签名证书仍为上述 de260… 原证书。因 USB 离线，测试包尚未确认安装，也未在设备执行；不计入上述 23 项或手机性能结果。

独立诊断 DEX JAR 的 `--probe` 已另行在现有专用 Android 12／API 31 x86_64 模拟器完成，`completed=true`、`jniLoaded=true`、`stage=jni-probe-complete`。实际已安装 APK SHA 核对为冻结 c05f61…；本地与传入 JAR SHA 相同，应用 UID 所有且权限 0400，只通过实际 APK 的 x86_64 库目录加载 Sherpa JNI。证据在 `build/android/kokoro-diagnostic/emulator-probe/aa136e42-9a69-47a5-8b5b-1aaccdc77309/` 的 `probe.json`、`proof.json` 及 `launcher-output.log`；`startup-source-check.json` 记录上述启动路径与资源清单核对。此次未加载模型、合成、播放、启动 Activity 或访问学习数据库，未安装应用、重置 AVD、操作真机或修改共享 ADB 服务；自行启动的模拟器已关闭，主机确认该进程和 5560／5561 监听均已退出。它证明这次 x86_64 JNI 加载成功，不证明 ARM64 手机 q8／fp32 的速度或精度。

可复跑的主机入口：

```powershell
npm run android:test-documents
npm run android:test-magazines
node --import tsx --test tests/nativeDocumentImport.test.ts tests/nativeMagazines.test.ts
npm run lint
```

`android:test-documents` 顺序执行 `scripts/test-android-documents.mjs` 和 `scripts/test-android-document-parser.mjs`；`android:test-magazines` 执行 `scripts/test-android-magazines.mjs`。依赖 JDK 21 和既有 Android 主机测试依赖，临时数据在忽略的 `tmp/android-tools` 下。报告分别为 `document-tests/report.log`、`document-import/report.log` 和 `magazine-tests/report.log`。

冻结包的路径、大小、SHA、原签名证书与手机实际安装哈希现已确认，冻结模拟器证据保存在 `build/android-phone/fixes-emulator-acceptance/`。后来生成的主应用 9b531… 包及流水线诊断测试包仍待安装／设备验收。手机实际运行检查仍包括书库及阅读页、长按／拖选完整手势、五类文档导入与下一批、原页及插图、JSON/ZIP 恢复、手动外刊完整下载与网络错误、朗读播放／停止、精度对照，以及离线翻译。安装通过不能替代功能验收，任何尚未运行的检查都不记录为通过。

## 本次记录更新的三端范围

主任务最近一次 `npm run platforms:check` 的记录时间为 `2026-10-11T03:26:52.759Z`：网页构建以及 Android 的构建、同步、安装包均为 `current`，Android 安装包记录对应后来生成的 9b531… 包；Windows 构建／安装包仍为 `unrecorded`。报告为 `build/platforms/status.json`。这个检查不安装应用或验证手机行为，不能把“当前构建”当作“手机已更新到该包”，也不能把冻结包的设备证据转用于新包；记录规则见 [跨端修改与交付](platform-parity.md)。本次文档更新没有重新构建或新增设备操作，独立模拟器探针按上文单独记录。

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 本次只更新文档，无功能源码修改 | 未复测 | 最近平台记录 current；本次未构建 | 不适用 | 不适用 | 未新增浏览器验收 |
| Windows | 本次只更新文档，无功能源码修改 | 未复测 | 最近平台记录 unrecorded；本次未构建 | 历史产物未重验，版本记录未登记 | 未新增安装操作 | 未新增设备验收 |
| Android | 本次不改源码；冻结证据与后来构建分别记录 | c05f61… 的此前 23 项原生及最新 app-only UI、主机全文外刊 97 篇通过；独立 x86_64 JNI 探针通过 | 后来构建／同步记录 current；本次未重建 | 9b531… 当前包已生成；c05f61… 与诊断测试包分别保留 | c05f61… 已装手机且哈希吻合；9b531… 与诊断测试包待安装 | 冻结包模拟器 UI 在上述范围通过；DOMRange 构造选区；手机完整手势／UI／性能待测，模型比较未开始 |
