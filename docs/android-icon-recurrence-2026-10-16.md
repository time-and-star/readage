# Android 桌面旧黑边图标复发（2026-10-16）

用户报告新图标“就坚持了一个早上”，随后又出现旧版带黑边的样式。本轮先保留现场，只读核对，未清缓存、重载桌面、重排布局、改主题、安装应用或访问学习档案。此前提升版本号的修复没有满足 N13 持续透明要求；不能继续将增版作为足够修复，也不能把安装后一张透明截图当作长期通过。

## 实际复发现场

- 真实 vivo V2190A / Android 13，桌面 `com.bbk.launcher2` 14.0.3.140。
- 北京时间 2026-10-16 16:20:33 截图中，ReadAge 的橙色图案缩在明显黑色圆角底内，已目视确认。图标节点为 `[801,677][1017,929]`；全屏只保存在本地 private 目录，公开证据只保留对应应用局部。
- 当时手机是浅色模式：`mNightMode=1`、`mComputedNightMode=false`。没有更改设置，也没有为截图发送 HOME 或滑动桌面，当前页即为真实桌面。
- 真实安装为 **versionCode 4 / 1.0.3**，最后更新时间为今天 **10:12:57**；实际 `base.apk` SHA-256 为 `e94a45f744daed28141c90e452430c9d08491dab84ac8a844aaa0ec4d7de50a9`，与该版本交付记录匹配。
- 本线程昨天的 3 / 1.0.2 安装记录保留，但不能作为这次复发现场的设备版本；各版本独立核对，不从工作区 APK 推断手机已更新。

证据：[1.0.3 复发现场报告](../output/android-icon-recurrence-2026-10-16/recurrence-v4-report.json)、[图标局部](../output/android-icon-recurrence-2026-10-16/现场-1792138829260-icon.png)、[产物独立审计](../output/android-icon-recurrence-2026-10-16/artifacts/audit-report.json)。真实 APK 哈希已在设备只读重新计算，不只依据旧安装报告。

本线程未安装任何应用。排查期间另一次更新使设备于 16:25:13 成为 5 / 1.0.4，实际 base.apk 只读重新计算 SHA-256 为 `9059894f87c028d064e808e524fdb48f157438f4b19a3ba3ab575fb672838942`，与该版本包一致；该新状态不覆盖上面 16:20 的 1.0.3 黑底复发证据，也不能将新安装后的暂时显示当作长期通过。之后截图没有当前应用桌面节点，未为此切页，不能新增 1.0.4 黑底或透明结论。后续每次诊断按当时真实版本单独记录。

## 已确认与仍需追查

当前与此前交付的正式透明母图、16 张 PNG、应用图标资源和唯一 MainActivity 身份保持相同；没有动态图标、组件别名切换或快捷方式创建代码。当前新版 APK 的静态透明图标校验通过，证明资源本身正确，不能证明 vivo 桌面处理后持续透明。

此前桌面静态分析查到按 appversion 接受旧 bytes 的缓存支路；本次在增加版本号后再次出现，说明这一条不足以解释或阻止全部路径。新分析还确认桌面生成图标时会调用厂商框架 `IconRedrawManger.createIconBitmap`，失败再调用 `ImageUtil.createRedrawIconBitmap`，存在独立于直接取原 PNG 的主题重绘路径。其具体加底条件与实际命中仍需运行时证据，暂不据类名断言根因，也不把资源改名当作根治。

本机系统框架反汇编确认 `createAlienIconBitmap` 会先画主题背景再画缩小前景，`addBorder=false` 不能跳过；普通几何分支则保留透明。隔离诊断实测现用 PNG 缩放至当前 `mIconSize=240` 的半径识别为 42，支持 normal，而不是 alien，不能仅因母图低 alpha 杂点就改前景。缓存 PNG 编解码链没有查到确定的丢 alpha 写法。

## 隔离实测范围与限制

独立 Java / DEX 诊断仅在 `/data/local/tmp/readage-icon-probe-*` 输出；没有产品构建、安装应用、读取学习库或修改全局设置。所有变体只在诊断内存和临时 PNG 中，不写回品牌图。最终报告为 [attribution-2-run/report.json](../output/android-icon-recurrence-2026-10-16/probe/attribution-2-run/report.json)，程序与副作用审查见 [RUN.md](../output/android-icon-recurrence-2026-10-16/probe/RUN.md)。

| 入口 / 192×192 结果 | 实测 | 能证明与不能证明 |
| --- | --- | --- |
| APK 原图 / Resources 直接加载 | 13,222 个全透明像素，0 个不透明暗像素 | 当前安装 1.0.4 的原图透明；不能代替桌面绘制结果 |
| 内存 ApplicationInfo 的主题取图 optout=false | 与原图相同 | 真实 vivo metadata 能绕开 PM 的主题取图入口；未修改产品 manifest，不能保证桌面后续不重绘 |
| 透明 Adaptive，前景按 64/108 留白 | 18,581 个不透明暗像素 | 本机 AdaptiveIconDrawable.draw 自身先填黑色；不能改成透明 Adaptive 冒充修复，也不能据此断言实际桌面已包装当前 legacy PNG |
| ImageUtil / 当前原 PNG | 144×144 输出保留透明，0 个不透明暗像素 | 该诊断条件下此入口未加黑，非完整桌面复现 |
| 完整 IconRedrawManger / 默认 PM 主题入口 | SecurityException，独立 app_process 未注册 ApplicationThread，不能取得 Settings provider | 未得到真实完整重绘结果；completed=true 只表示各项已采样，不表示成功或设备验收通过 |

`android.vivo_globaltheme_loadthemeicon=false` 的真实框架代码只跳过 PackageManager 主题 PNG 取图，后续 launcher 独立重绘没有读取该 app metadata。不能作为“始终使用原图”的保证，也未向产品添加未经验证的配置。没有继续冒用 launcher / system UID、改系统属性或用全局设置强行完成诊断。

随后核对本机 `services.jar` 得到更直接的排除依据：`LauncherAppsService.queryIntentLauncherActivities` 查询 flags 固定为 `0x000c0000`，不含 `GET_META_DATA=0x80`，下游未补此位；最终生成 `ActivityInfo` 时不装载 metaData，客户端也不补载。所以该 false 键连当前桌面取图入口也不能有效控制，不能为了“做了改动”而加入。逐指令证据见 [framework-analysis.md](../output/android-icon-recurrence-2026-10-16/framework-analysis.md)。

如需补齐完整重绘结果，可审阅并明确授权安装独立诊断工具后，用真实注册的 Activity Context 重试；诊断工具也不是 launcher 进程本身，若输出仍透明，仍需继续区分桌面缓存与其环境差异，不能宣称根治。产品修复尚未完成。

独立诊断源码与操作说明位于 [probe-app](../output/android-icon-recurrence-2026-10-16/probe-app/README.md)：固定包 `cn.readage.iconprobe`、独立 UID、真实 Application Context，不再改写 app_process 身份。无权限、网络、后台服务或 ReadAge 启动，仅读取公开 APK 图标与版本，输出只写自己的 files 新目录。源码已通过 Java 编译及独立副作用审查；默认脚本只执行 Java 检查，APK 打包须显式 `--package`，脚本没有 ADB 安装动作。

## 用户授权后的真实注册进程诊断

用户随后明确回复“允许，继续诊断”，授权临时工具打包、安装、运行、取回结果后移除。独立 APK 24,985 字节，SHA-256 `d00ef8c954a0f62ab64009343e59e350599e5fe764ee3fceb88134f8abeb028b`；无桌面 MAIN / LAUNCHER 入口。只安装该工具，没有重建或重装 ReadAge。2026-10-16 17:03 左右真实 Activity 启动成功，运行于独立 UID 10269。

SDK 的 aapt2 在沙箱 link 时以 0xC0000005 崩溃；同工具、SDK、输入和命令在正常 Windows 环境成功，未更改 SDK、权限或身份。此为诊断工具打包问题，不能误记为产品问题。

| 实际 1.0.4 / 5 的测试入口 | 注册进程结果 | 限定结论 |
| --- | --- | --- |
| PM 默认取图 / 原图 / 直接资源 | 均透明，192×192 时全透明 13,222 像素、不透明暗像素 0 | 当前原资源和 PM 正常取图未变黑 |
| IconRedrawManger，普通原图，5 / 6 参数重载 | 两项均成功，240×240，全透明 20,307 像素、不透明暗像素 0 | 完整公开 OEM 方法在此独立 App Context 下保持透明；不是桌面进程的完整环境与缓存 |
| ImageUtil，普通原图 | 成功，192×192，全透明 13,624 像素、不透明暗像素 0 | 此实际入口也未把正常 PNG 加黑 |
| 留白 64/108 的透明 Adaptive | 直接画图为 18,581 个暗像素；OEM 输出 16,290 个暗像素 | 透明 Adaptive 不是可用修法；实际桌面 legacy 是否包装仍未证实 |
| 私有字段 / online 替换私方法 | hidden API 返回 NoSuchField / NoSuchMethod | 未读取内部主题状态；没有调整 hidden_api_policy 或注入豁免，不能把此项记为成功 |

所有普通原图入口成功且透明，进一步把问题限定在桌面自己的历史图、缓存或尚未观测到的绘制条件；目前不能从这些结果断言具体命中哪一条。**根治未完成，不交付猜测性图标资源改动。**

补充边界核对：当前桌面 APK 只读 SHA 为 `b2a25fb7bdb801be1213dfa547b1ec1e14ed7c82098fa386c25280ee43f48baa`，与静态分析文件一致。BaseIconFactory 全类图未查到普通图标的外部实例 / 包装调用，实际 BitmapDrawable 子类也没有额外填底，不能把捆绑 AOSP 包装器当作本次根因。`/data/bbkcore/download` 和 `/data/bbkcore/theme` 的定向 PNG 查找被 Permission denied 拒绝；静态确定在线路径会保留主题子路径后缀，不能用此前几个精确文件不存在排除保护目录中的替换图。

桌面 Provider `com.bbk.launcher2.settings` 需要 `com.bbk.launcher2.permission.READ_SETTINGS`（或写权限）。使用 `--projection _id --where 0` 的零行访问验证，打开 Provider 阶段即被明确 SecurityException 拒绝，没有读取任何桌面条目。未授予权限、没有新增诊断包权限、没有查询全表。当前权限下不能从桌面私有缓存取回真正使用的黑边 bitmap；这是真实诊断限制，不能转写成某个缓存已确认损坏。

结果已只读导出到 [device-results/1792141416474](../output/android-icon-recurrence-2026-10-16/probe-app/device-results/1792141416474/report.json)。随后 `adb uninstall cn.readage.iconprobe` 返回 Success，`pm path cn.readage.iconprobe` 为空，工具已移除；ReadAge 仍为 5 / 1.0.4、更新时间 16:25:13。可审计执行回执见 [execution-receipt.json](../output/android-icon-recurrence-2026-10-16/probe-app/execution-receipt.json)。这次未读取学习库，未做真实数据指纹审计，不扩展宣称逐文件一致。

### 第二阶段：合法持普通读权限的缓存诊断，等待重新连接

在同一“继续诊断”的授权目标内，已明确向用户说明工具新增 vivo 定义的唯一 normal `READ_SETTINGS` 读取权限，仍只读 ReadAge 自己的图标和版本；不使用 pm grant、写权限或身份伪装。源码与第二次独立审查确认固定五个已验证的 `location_*` 表，每个只执行 `intent IN (?, ?)`，参数固定为 ReadAge 的全名 / 缩写组件；再解析 ComponentName 检查精确包名与类名，投影仅 `_id / intent / itemType / icon / app_version`。每表超过 8 个目标条目或图标超过 2 MiB 即停止，不读取布局列或其他应用条目。五表可能包含历史布局，无法确认 active 表时明确标注，不将历史图片当作复发因果。

此工具是 0.0.2 / 2，Java 与独立代码审查通过，已生成 [独立诊断 APK](../output/android-icon-recurrence-2026-10-16/probe-app/package-output/2026-10-16T09-20-09-577Z-55376/ReadAge-icon-probe-0.0.2.apk)，20,890 字节，SHA-256 `1846b6a6ca9c4e6484d41d46b6a0501cd580a72eee7be9a72d26e150e653b0b4`。没有构建 ReadAge 产品。

17:22 左右安装前手机断开，ADB 报 `device '3504296688000CN' not found`，随后设备列表为空。因此 **0.0.2 尚未安装，没有第二阶段查询结果**；已经向用户请求重新连接并解锁。设备恢复后只安装此工具、定向取回结果再移除，之前授权保留，不再重复请求安装许可。

本轮保持“背景必须透明”的要求，不用橙底、白底或其他实色替代黑底；不卸载应用、不清学习数据、不更换包名、不清全局桌面数据。源码、构建、真实安装和长时间桌面验收将分别记录。

## 当前对应状态

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 本轮图标无需改动 | 本轮未重测 | 保留既有状态 | 不适用 | 不适用 | 本轮未操作 |
| Windows | 本轮图标无需改动 | 本轮未重测 | 保留既有状态 | 保留旧包 | 本轮未更新 | 本轮未操作 |
| Android | 未改产品源码；保持正式透明 PNG，桌面缓存 / 特定绘制条件待追查 | 包 / 资源 / 实际 OEM 公开重绘均核对；私有字段受限 | 本线程未构建产品 | 现有 1.0.4 包，本线程未生成；仅另生成独立诊断包 | ReadAge 当前 1.0.4；临时工具已安装运行并移除 | **1.0.3 的 N13 持续透明失败**；1.0.4 长期桌面显示待验收，持久修复待实现 |
