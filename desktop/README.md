# Windows 本地应用

正式显示名为 **ReadAge**（R、A 大写），窗口、菜单、快捷方式及安装显示名保持一致；后续安装包文件名为 `ReadAge-<版本>-windows-x64-setup.exe`。`com.readge.local`、`readge.exe` 及原用户数据目录保留以延续升级与档案。2026-10-16 更名当前只完成源码和验证，待用户检测后重建、安装。

桌面程序使用 Electron 44.5.1 内置的 Node 24.21.0。启动时会实际打开一个内存 `node:sqlite` 数据库，再启动本机服务；界面在独立的、开启隔离和沙箱的窗口内运行。[固定版本信息](https://releases.electronjs.org/release/v44.5.1)、[Electron 运行变量](https://www.electronjs.org/docs/latest/api/environment-variables)。

```powershell
npm run desktop:build
npm run desktop:start
npm run desktop:pack
npm run desktop:package
```

`desktop:build` 构建离线界面和本机服务。`desktop:pack` 生成 Windows x64 应用目录；`desktop:package` 生成 NSIS 安装包。打包使用已安装的生产依赖；首次准备 Electron、打包工具以及安装器构建资源可能需要联网。应用运行时不下载模型、声音或词典。

用户数据位于 `%APPDATA%\readge`，其 `workspace` 保存学习库、附件、导入的词典和已安装模型，Chromium 的界面数据也保存在该用户目录。安装文件保持只读。卸载和升级都不主动删除用户档案。

首次在项目内运行会发现已有本地档案；安装后的首次运行让使用者选择包含 `local-data` 的旧项目目录或明确建立新档案。迁移先在 `migration-backups` 生成独立备份，再检查每个文件的 SHA-256。学习库通过 SQLite 的备份接口读取完整事务状态，包含 WAL 中已提交的记录；不直接复制正在使用的 SQLite 主文件。备份与迁移后的库均检查完整性和实际表内容。最终核对通过才写入 `data-migration.json` 并启动服务。

旧目录和失败的迁移尝试均保留。发现目标已有未核对的数据、备份期间源文件变化、或已迁移的数据库缺失时，应用停止启动，不覆盖现有档案。迁移覆盖学习库、既有恢复备份、个人导入、`data/magazines` 和本地词典数据，排除朗读翻译模型、运行依赖、日志和预览文件；模型由安装包单独部署。浏览器原有 localStorage 档案仍需通过原应用导出迁移包再导入，桌面程序不会读取浏览器配置目录。

阅读界面只连接本次启动的本机服务。服务首次使用系统分配的端口并通过 IPC 回报，后续启动复用保存的端口，让界面保留当前档案选择；被其他服务占用时停止启动。桌面窗口为本机接口添加本次启动的随机凭据。关闭应用先发出 IPC 停止消息，让 SQLite、翻译和朗读服务清理已拥有的子进程。Kokoro 和 Hy-MT2 缺少已安装资源时保留明确错误，阅读和复习可继续使用。

Windows 保留“更新外刊目录”和“更新这本外刊”。只有使用者主动点击更新时，本机服务才可读取已配置的杂志来源；逐次校验重定向，其他调用不能使用这个联网例外，学习档案和本机接口凭据不会发送到来源网站。开机和定时自动更新继续关闭；已有外刊、阅读、复习、查词、朗读和翻译均可离线使用。Android 不启用这个联网入口。

窗口、任务栏、EXE、安装/卸载程序和快捷方式统一使用现有 ReadAge 品牌图标。多尺寸 ICO 包含 16、32、48、128、256 像素，实际 EXE 与 NSIS 默认图标可通过 `scripts/desktop-verify-icons.mjs` 校验。

桌面、网页和移动端统一使用透明原图 `assets/brand/readge-icon.png`；运行 `node scripts/desktop-icons.mjs` 可重新生成保留透明度的品牌 PNG 和桌面 ICO，桌面构建也会自动执行此步骤。

安装包内含阅读界面、当前项目发布的词典和完整离线推理资源：Hy-MT2 1.8B 1.25bit 模型与固定的 Windows x64 CPU AVX2 运行器，Kokoro q8/fp32 模型及全部已安装英美/英式音色、法语 Siwis、日语 Alpha、Node 原生运行依赖，以及官方 Python 3.12.10 嵌入版和日语发音依赖。使用者电脑不需要另外安装 Node 或 Python。翻译运行器要求 CPU 支持 AVX2。

桌面新档案默认选择完整部署的 Kokoro fp32 模型；模型不可用时默认 q8，明确保存的合法模型配置继续保留。本机随包运行组件的对照测试中，105 字符首段两轮平均生成时间从 q8 的 6.66 秒降到 fp32 的 2.10 秒，194 字符后段从 12.94 秒降到 3.52 秒；这些是音频生成时间，网页到实际出声还包括播放初始化。两种模型均已内置，不需要另行下载。播放真正开始后才显示“正在朗读”，等待尚未准备好的下一段时显示“准备朗读”并清除旧词框。

`scripts/desktop-bundle-resources.mjs --download` 只在构建阶段取得固定版本的嵌入版 Python、许可证和随包源码。后续构建可离线重用缓存。打包前核对现有翻译模型/运行器、法日音色 SHA，再生成带每个文件版本、大小和 SHA-256 的 `offline-resources/manifest.json`；生产安装资源位于 Electron 的 `resources/offline-resources`，模型和可执行组件不置于虚拟 ASAR 中。GPL eSpeak 组件保留许可证、源码归档和官方构建说明，其余组件保留原发行版许可证。

首次启动先核对整个内置资源包，再向用户的 `workspace/local-data` 部署模型和运行依赖。升级时只处理清单允许的五个推理资源目录，资源变化先另存校验通过的 `resource-backups` 备份；不会复制或覆盖学习数据库、个人配置、文章或日志。后续启动核对精确清单SHA及源 / 目标文件的纳秒时间、文件身份等元数据；完全相同时复用此前SHA结果，文件 / 清单变化或收据无效时重新核对，缺失仍恢复。诊断可调用 `deployBundledResources({ ..., forceVerify: true })` 强制完整校验。安装资源损坏会停止并提示，运行时不会联网补下载。独立日语 Python 使用相对路径与隔离模式，不读取外部 Python 安装、用户包目录或 `PYTHONPATH`。

NSIS安装阶段采用独立、非solid的逐文件资源载荷。核心7z不再含模型和词典正文；完整离线EXE仍内嵌全部文件、清单、许可证及对应源码。标准同目录升级在原检查程序退出后，把两个只读资源目录同卷暂存，避免旧卸载器逐文件搬走它们；核心解开后还原，逐文件SHA相同则跳过释放，仅变化 / 缺失 / 损坏文件重新写临时文件、核对并替换。失败保留可恢复旧资源，学习档案不在处理范围。换目录升级安全回落完整释放。完整EXE仍保留更新缓存，以供精确旧包基线差分；本优化不承诺没有该复制成本。成品大小、首次离线安装、真实向导及正式声音必须在用户授权打包后另验，不能把小夹具计数当作正式包耗时。

仅安装包构建时准备`build/desktop-installer/p-<payloadId>/<index>`短源，优先硬链接，不支持时复制并核对SHA；编译器不再直接读取深层资源路径。载荷元数据仍记录原始来源，核心验证同时核对短源和实际NSIS脚本。安装体积与空间宏补入全部资源大小。普通失败 / 取消回调支持恢复；硬杀或断电会留下原资源和journal，尚无下次自动发现旧事务机制。

原生组件的 PE 依赖另行核对。翻译运行器、ONNX 和日语扩展实际需要的 `MSVCP140`、`MSVCP140_1`、`VCRUNTIME140`、`VCRUNTIME140_1`、`VCOMP140` 由微软官方签名的固定 x64 可再分发包取得，放在各组件自己的目录中；Python 保留官方嵌入版原有 VC 文件，并核对新增 MSVCP 的所有导入符号。程序不要求用户先安装 VC++ 包，不运行 VC 安装器，不复制或替换系统 DLL。其版本、来源、签名和 SHA 一并写入清单，原始许可随包保存。Windows 自身提供的 Kernel32/UCRT 等系统 API 仍由操作系统提供。

安全迁移与生命周期测试：

```powershell
npm run desktop:test
```

完整安装资源验证：

```powershell
node scripts/desktop-resource-smoke.mjs
```

该验证启动真实 `win-unpacked/readge.exe`，使用全新隔离目录和不含模型的迁移夹具，故意设置无效外部 Python 路径；首次部署后实际生成美式、英式、法语、日语 WAV，并执行英译中、日译英。测试继续关闭、重新打开以核对学习档案与记录保留，以及所拥有的服务均已退出。报告、截图与音频保留在 `build/desktop-smoke`，不接触实际学习档案。

`scripts/desktop-verify-package.mjs --directory <完整应用目录>` 检查应用代码、资源和许可校验值；`scripts/desktop-audit-pe.mjs --directory <完整应用目录>` 检查原生依赖闭包，VC 依赖必须解析到安装包自己的文件。`desktop:pack` 保持完整可运行目录。`desktop:installer`生成的`win-unpacked`及NSIS内`app-64.7z`现在是核心中间目录，资源由独立NSIS指令内嵌；默认完整校验 / 冒烟拒绝把核心中间目录算成完整包，`--installer-core`只校验核心及对应完整资源输入。正式完整验收应使用完整目录或实际安装结果，不能仅检查核心7z。

隔离验证支持 `READGE_DESKTOP_USER_DATA`、`READGE_LEGACY_ROOT`、`READGE_DESKTOP_SMOKE=1` 和 `READGE_DESKTOP_SMOKE_REPORT`。测试应指向临时目录，避免在验证过程中迁移实际学习档案。`READGE_DATA_ROOT` 是本机服务的数据根，`READGE_APP_ROOT` 是只读应用资源根；两者不相互替代。
