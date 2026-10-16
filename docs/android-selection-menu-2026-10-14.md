# Android 阅读选句系统菜单修复（2026-10-14）

用户截图中的白色“翻译 / 复制 / 分享 / 全选”条是 Android WebView 的原生文字选择菜单，叠在应用自己的选句操作条上。现有 `ReadingTouchSelection` 已拦截网页 `contextmenu`，但原生 ActionMode 仍可能出现。本轮仅修改 Android 原生层，共享 React 选择、翻译、复制和朗读逻辑不变。

## 社区与原生实现依据

- [React Native WebView 原生实现](https://github.com/react-native-webview/react-native-webview/blob/master/android/src/main/java/com/reactnativecommunity/webview/RNCWebView.java)通过 `startActionMode` 和 `ActionMode.Callback2` 接管选择菜单，并转发原回调的内容矩形。
- [Chromium 选择控制器](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/android/java/src/org/chromium/content/browser/selection/SelectionPopupControllerImpl.java)在无法创建 ActionMode 或销毁选择模式时可能清除选区。因此本轮保留原创建返回值和生命周期，只在菜单创建及刷新后清空菜单项，不直接拒绝模式或调用 `finish()`。
- [Android Callback2 文档](https://developer.android.com/reference/android/view/ActionMode.Callback2)说明浮动模式使用内容矩形动态定位。本轮继续委托原矩形回调。

`ReadageWebView` 继承 CapacitorWebView，应用层覆盖 `capacitor_bridge_layout_main.xml` 实际实例化该子类；原 `activity_main.xml` 不是 BridgeActivity 的加载布局。Android 专属 `res/raw/readage_selection_menu.js` 在本地页面加载后发布当前选择范围策略：阅读标题、正文及法日试读正文由应用提供选择操作，输入框 / textarea / select / contenteditable、译文和其他页面保留原生菜单。脚本不修改 DOM Range，不改变共享页面的手势、内容或学习数据。

## 逐项对应与实际验收范围

网页基准见 [用户功能逐项验收](user-feature-acceptance.md)。已补充 R09 的系统菜单不叠加与选柄行为，以及 I03 的输入框系统粘贴菜单要求。

| 编号 | 本地浏览器 | Windows | Android 本轮 |
| --- | --- | --- | --- |
| R09 | 共用长按 / 选区实现不变；本轮未复测实际网页 | 共用实现不变；本轮未复测应用 | 原生菜单抑制完成；长按后、等待后、拖柄松开后卡片不重现仍待真机验收 |
| R08 / R10 | 原 DOM Range 和鼠标选择逻辑不变；共享相关测试通过 | 共用逻辑不变；本轮未复测应用 | 保留 DOM Range 和应用操作条；最终范围的实际复制 / 翻译 / 朗读待真机验收 |
| R11 / R12 / N09 | 滚动、取消和返回实现不变 | 共用实现不变；本轮未复测应用 | 不直接结束原生模式；滚动、横屏、空白 / 系统返回取消待真机验收 |
| R06 / R13 / R14 | 查词、快速选择、离开文章实现不变 | 共用实现不变；本轮未复测应用 | 短点查词、快速重选及退出清理待真机验收 |
| S03 | 选句朗读输入与定位实现不变 | 共用实现不变；本轮未复测应用 | 本轮未进行朗读实测，不判定声音或定位已通过 |
| D23 | 法日试读逻辑不变 | 共用实现不变；本轮未复测应用 | 专属策略覆盖实际试读容器；真实试读操作仍待验收 |
| I03 | 正文输入和保存规则不变 | 共用实现不变；本轮未复测应用 | 主机 DOM 测试确认编辑范围不屏蔽；系统复制 / 粘贴 / 全选及从输入框直接长按正文的真实焦点过渡待验收 |

验证：`npm run lint` 通过；`readingTouchSelection` / `readingSelectionPosition` / `observeReadingSelection` 共 23 项通过；`node scripts/test-android-selection-menu.mjs` 的 8 项原生回调 host 测试通过；`tests/androidSelectionMenuScope.test.mjs` 的 7 组真实 Chromium DOM 场景通过（含 Node 父测试共 8 项）。主机测试不证明 vivo 系统卡片已消失。独立源码审查确认实际打包布局已使用定制 WebView；原生 Java 编译通过。

## 构建、安装和数据

`npm run android:apk` 成功，前端已构建并通过 Capacitor 同步，原生 APK 已生成。首次沙箱构建被 Vite `realpath` 权限阻止，改用正常权限运行相同构建脚本后完成；不是产品编译错误。

- APK：`android/app/build/outputs/apk/debug/app-debug.apk`，1744237863 字节。
- SHA-256：`cf121e3c1180d590366bc5df5210e1fa806da7ff88a8426add35dac60e76aafe`。
- Android 输入：`17fc9cba801be236fb197fa8c89daab6468e8589392b89c44cce61dcc6efc3f0`。
- 原签名 SHA-256：`de260020066511703db8e701412329d8fe0f58339e574ad9d64e12c51cc4a9f3`。

检测到真实 vivo V2190A / Android 13，但界面处于锁屏。覆盖安装先核对原签名和学习数据库 / 配置指纹；ADB 推送 13.137 秒后出现 Broken pipe，随后设备消失，无法读取新安装包哈希，不能记为已安装。本轮没有卸载、清除数据、切换学习档案或向真实学习库写入测试文章。只取得安装前指纹，因设备断开没有取得安装后指纹，不能宣称已完成前后数据一致核验。用户随后回复“暂时先不用”，本轮停止继续安装和真机验收。

`npm run platforms:check` 已完成：网页构建、Windows 独立安装包、Android 前端 / 同步资源 / APK 均对应当前输入。当前 `dist/` 是网页目标，桌面开发构建已被覆盖；已有 Windows 安装包具有独立有效记录，本次 Android 修改不要求重建该包。未进行三端完整发布，因此未重复运行 strict。

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 无需改动 | 共享选择 23 项通过 | 原 web 构建有效 | 不适用 | 不适用 | 本轮实际网页未复测 |
| Windows | 无需改动 | 共享选择 23 项通过 | 安装包记录有效；dist 当前是 web | 原包有效，无需重建 | 本轮无需更新、未复核安装 | 本轮未复测 |
| Android | 原生抑制完成 | 共享 23 项、回调 8 项、DOM 7 组通过 | 前端 / 同步 / 原生完成 | 新 APK 已生成 | 待安装，传输中断；用户暂缓 | 待设备验收 |

证据：[构建日志](../output/android-selection-build-2026-10-14.log)、[平台核对](../output/android-selection-platforms-2026-10-14.log)、[安装失败与指纹记录](../output/android-selection-menu-2026-10-14/install-report.json)、[原生回调测试](../tmp/android-tools/selection-menu-host-tests/report.log)。
