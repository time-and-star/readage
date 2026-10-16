# 橙色启动页重做（2026-10-15）

用户否决第一版书本线稿与诗句排版，明确选择“橙色艺术：鲜明色面、抽象构图、更有视觉冲击”，随后要求删除预览左上角的小图标 / 文字。本轮按该选择重新实现启动画面，先做源码和隔离验证，不构建、同步、打包或安装。

## 当前画面

品牌橙 `#FF5B22` 作为启动画布，原图标中的横条、卡片和端点重组成斜向抽象构图，搭配深色粗字标 `readge.`。左上角没有重复图标、文字或小横杠；没有上一版书本、太阳和中文诗句。底部为不定加载细线和真实阶段文案，不代表百分比。减少动态效果时线条静止；加载失败隐藏动态线并显示原因和至少 44px 高的重试按钮。

独立 HTML 首帧与重试后创建的启动壳一致。共用界面支持窄屏、桌面、横屏、安全区和长失败说明；Windows 服务启动前的独立窗口对应相同橙色与图形，矮横窗采用左右构图。正式桌面 / 浏览器 / Android 启动图标资源未改变。

## 背景与生命周期

橙色只用于启动阶段。共用启动壳观察真实 DOM：档案与模块准备完成后，等 React 实际替换启动元素，再移除启动背景标记并恢复浏览器主题色；失败和重试期间保持橙色。Android 新增专用的外观桥接，按顺序接收可见状态，控制启动窗口、系统栏、decor 与 WebView 背景；正常阅读主题保留暖白，返回和配置变化重新应用当前状态。

没有改资源完整性校验、模型、数据库、用户设置、档案水合或书签恢复规则。启动仍按平台初始化、档案准备、动态导入应用的次序执行；外观调用失败不阻断档案加载。此前已装 1.0.2 不包含这些新源码。

源码包括 `index.html`、`src/startup.css`、`src/lib/startupScreen.ts`、`src/main.tsx`、`src/lib/platform/nativeStartupAppearance.ts`、`desktop/splash.html`、Android `MainActivity.java` / `ReadageStartupAppearancePlugin.java` 与启动主题。

## 验证状态

类型检查通过；启动模块延迟加载 / 旧 WebView / Android CSS 19 项、正式透明图标策略 15 项通过。新视觉证据与已被否决的旧方案分开保存在 `output/startup-redesign-2026-10-15/verification/`。

共用启动页与外观生命周期 9 组 / 220 项检查通过，独立 Windows 启动 HTML 3 组 / 20 项检查通过，无浏览器异常。覆盖 320 / 360px、桌面、横屏、安全区、慢提示、失败 / 连续重试、错误文本防注入、减少动态效果，以及真正 React 页面提交后恢复原背景。额外回调夹具确认连续启动 / 重试 / 提交按 `[true, true, false]` 通知，清理定时器不会提前退出橙色，同步重试也不会短暂发出 false。

主执行 agent 目视核对 [当前手机预览](../output/startup-redesign-2026-10-15/verification/mobile-loading.png)、[横屏](../output/startup-redesign-2026-10-15/verification/landscape-769-html-before-main.png)、[失败重试](../output/startup-redesign-2026-10-15/verification/status-retry-360-failure.png) 和 [Windows 窗口](../output/startup-redesign-2026-10-15/verification/desktop-native-loading.png)：左上无重复小标，构图、字标和底部提示无碰撞。报告为 [共用 UI](../output/startup-redesign-2026-10-15/verification/report.json) 与 [独立窗口 HTML](../output/startup-redesign-2026-10-15/verification/desktop-native-report.json)。数据响应和应用完成页面是隔离夹具，未执行真实档案 / 书签流程，不代表 Android WebView 或 Electron 安装版设备验收。

Android 两个改动 Java 文件使用 JDK 21、Android 36 / 当前 Capacitor / AndroidX 真实缓存依赖独立 `javac` 类型检查通过，输出仅在隔离目录；两个新样式名使用独立 R stub。只有 3 条 Window 栏颜色 API 的弃用警告，没有类型或语法错误。[Java 检查](../output/startup-redesign/native-java-check/report.json) 不证明 AAPT 资源链接、Android 系统栏实际渲染或原生生命周期在设备上已通过。没有执行 Gradle、Capacitor 同步或安装。

只读 `npm run platforms:check` 确认三端现有产物均需重建，保持等待用户检测反馈后集中编译。

## 三端交付

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 橙色 / 抽象构图 / 无左上重复标志及恢复背景完成 | 类型、相关回归与新 UI 220 项检查通过 | 需重建，待用户检测后编译 | 不适用 | 不适用 | 当前源码隔离启动范围通过；真实档案未重测 |
| Windows | 共用界面及独立启动窗口对应 | 共用回归与独立 HTML 20 项检查通过 | 需重建，待用户检测后编译 | 旧包保留 | 本次修改待安装 | 隔离浏览器的 HTML 范围通过；待安装版验收 |
| Android | 共用界面、启动外观桥与主题对应 | 共用 / 图标 / CSS、Java 类型与 XML 检查通过 | 前端与原生需重建，未同步 | 旧 1.0.2 保留 | 本次修改待安装 | 实际系统首屏、栏颜色恢复及 WebView 待设备验收 |
