# 独立 Kokoro 精度诊断（模拟器 JNI 探针通过，手机对照待测）

此目录不进入主 APK。`scripts/test-android-kokoro-diagnostic-prepare.mjs` 只使用工作区 JDK、Android SDK、现有 Sherpa 1.13.8 和 Kotlin 2.2.0 编译一个约 12 KB 的 DEX JAR，不调用 ADB、不安装应用、不改主包。产物与本地主 APK 的哈希、签名证据记录在 `build/android/kokoro-diagnostic/preparation.json`。

本地已编译主 APK 的调试 manifest 为 `debuggable=true`、`extractNativeLibs=false`，包含 ARM64 与 x86_64 的 Sherpa、ONNX Runtime 以及 Kotlin。JNI 库通过 `System.loadLibrary("sherpa-onnx-jni")` 加载，依赖 `libonnxruntime.so`；已核对未压缩 ZIP 库和 16 KB 对齐。此事实只描述工作区产物，不能证明手机 c05 已安装相同包。

## 执行边界

- 仅在用户已授权的现有调试应用、已授权的 USB 调试通道下，由主任务决定运行。先在专用模拟器验证 JNI 探针，再决定是否在实际手机执行。
- `run-as` 是 AOSP 调试入口，会检查已安装且可调试的包、目录和系统策略；`app_process` 可以启动独立 Java `main`。这是有条件的调试方案，不保证每个厂商设备允许它。
- 如果出现 `run-as` 拒绝、SELinux 拒绝、DEX 只读检查失败、原生 linker 拒绝或明确的系统拒绝，立即停止。不要改变 USB/安全设置、root、SELinux、包权限或用另一入口绕过拒绝。USB 断线也不能作为运行许可。
- 测试包安装授权和手机上对安装的确认仍独立保留。本诊断不安装测试包，不应声称它解决了安装拒绝或替代了安装确认。
- 不启动 Activity、Capacitor、学习数据库，不播放声音，不修改当前语速、默认模型、文章或学习档案。不调用 `NativeRuntimeResources.ensure`，只读取已经发布的运行资源。

## 执行前必须核实

1. 主任务确认完整设备 serial、实际 Android 用户、`cn.readage.app` 的实际安装 `codePath` 和 `base.apk`。不能从本地 APK 路径猜手机路径。
2. 通过正常允许的调试读取核对实际安装 APK 的哈希/签名和准备报告；不同包应记录其真实版本并先核对 Sherpa/Kotlin、ABI 和资源清单。不要把工作区哈希当作手机证据。
3. 正常 `run-as cn.readage.app` 必须已经可用；不得启用它或调整策略来通过检查。
4. 在该应用私有 `cache/` 新建唯一目录：`readage-kokoro-diagnostic-<8到64位小写字母、数字、连字符>`，不得复用其他用途的目录。目录由应用 UID 所有，建议 `0700`。标记文件 `.owner` 内容为 `readage-kokoro-diagnostic-v1`。
5. 只把经过 SHA256 核对的 `kokoro-diagnostic.jar` 放在该目录。按 Android 的安全动态加载要求将它设为只读，再启动；代码在创建加载器前检查只读和所有者。设置诊断文件的只读属性不是改手机安全设置。

所有命令由主任务的参数数组工具执行。设备、包名、目录、APK 和资源路径必须先验证；不要把未校验文本拼接成 shell 字符串。下面是参数模板，不是已执行记录。

## 两个明确入口

只加载 JNI 的探针不需要 FP32 或模型目录，不创建引擎、不合成：

```text
adb -s VERIFIED_SERIAL shell run-as cn.readage.app env CLASSPATH=OWNED_DIAG_DIR/kokoro-diagnostic.jar /system/bin/app_process64 /system/bin --nice-name=readage-kokoro-diagnostic cn.readage.diagnostic.KokoroDiagnosticLauncher --probe ACTUAL_APP_DATA OWNED_DIAG_DIR ACTUAL_INSTALLED_BASE_APK
```

launcher 用公开 `PathClassLoader` 创建 `诊断JAR:实际已安装base.apk` 的加载器，原生搜索目录为 `实际base.apk!/lib/实际64位ABI`，父加载器只用 boot parent。通过反射进入测试类，确保测试、Sherpa、Kotlin 和 JNI 在同一个加载器中；不要预先由缺少正确库目录的 system loader 加载 Sherpa，也不要加载后才修改 `java.library.path`。探针支持实际 ARM64 手机和专用 x86_64 模拟器。

输出 `OWNED_DIAG_DIR/probe.json`。只有 `completed=true`、`jniLoaded=true` 才证明该设备的这次 JNI 加载成功；尚不证明模型可合成。虚拟机在进入 `main` 之前拒绝加载时，应保留正常退出码及 stderr，可能没有 JSON。

物理 ARM64 手机上明确运行精度比较：

```text
adb -s VERIFIED_SERIAL shell run-as cn.readage.app env CLASSPATH=OWNED_DIAG_DIR/kokoro-diagnostic.jar /system/bin/app_process64 /system/bin --nice-name=readage-kokoro-diagnostic cn.readage.diagnostic.KokoroDiagnosticLauncher --compare ACTUAL_APP_DATA OWNED_DIAG_DIR ACTUAL_INSTALLED_BASE_APK EXISTING_RUNTIME_GENERATION q8-first
```

比较另需：

- `EXISTING_RUNTIME_GENERATION` 是 `ACTUAL_APP_DATA/files/readage-runtime/<64位bundleId>` 下已存在的完整代。代码检查 `.complete` 与实际安装 APK 内资源 manifest；校验 Kokoro 模型、tokens、voices 和全部发音文件。运行目录只读，不重新解包或清理它。
- FP32 放在自己的 `OWNED_DIAG_DIR/kokoro-fp32.onnx`：325560556 字节，SHA256 `b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11`。固定来源为 `https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/resolve/f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b/model.onnx`。
- q8 使用现有运行代的 `model.int8.onnx`，SHA256 `4b86207ef680e394d8343bee22dfc4c512e5c707c6d9578e3f35ab09bffd6b36`。两者同 voices/tokens/eSpeak、CPU 两线程、美音声号 3、速度 1.0。
- 每模型 7 次合成：冷引擎首句一次，再两轮短词、首句和后段。记录加载时间、首 PCM 回调、总合成时间、非静音/有限 PCM、采样率、帧数及阶段 PSS。保存两个冷句 WAV，仅写文件、不播放。
- 用 `fp32-first` 可以反转顺序；另一次对照用新的唯一目录。不要清系统页缓存，也不要更改生产设置。

输出 `benchmark.json` 与 `cold-q8.wav`、`cold-fp32.wav`。在引擎失败时保存部分进度。正常 Java 退出的 `finally` 只删除该唯一目录下自己所有的 FP32 文件，记录删除结果。原生崩溃、强制进程终止或系统 OOM 可能来不及执行 `finally`；主任务确认进程已结束后，只清理该次已确认拥有的诊断文件，不能删除运行资源或学习目录。

## 证据限制与跨端状态

这是单独调试进程，不具有真实 Activity 的进程优先级、热状态及 AudioTrack；首 PCM 回调表示合成数据可用，不等于可听首音。冷只表示新引擎，系统文件缓存保留；PSS 是阶段采样，不是完整峰值。禁止将模拟器速度推断为 ARM64 手机速度。

Java/D8 编译和本地主包核对已通过。2026-10-11 的隔离 Android 12/API 31 x86_64 模拟器 JNI 探针也已通过：`completed=true`、`jniLoaded=true`，实际安装主包 SHA 为冻结 c05f61…，传入 JAR SHA 相符、应用 UID 所有且只读；没有加载模型或合成/播放。证据在 `build/android/kokoro-diagnostic/emulator-probe/aa136e42-9a69-47a5-8b5b-1aaccdc77309/proof.json`，自行启动的模拟器已关闭。尚无手机探针或 ARM64 精度比较结果。浏览器、Windows 生产源码均无需改动；Android 只增加独立诊断材料，主前端、原生源码、APK、安装和用户数据未更改，无需为此重建任何生产产物。实际手机模型取舍仍须同手机测量后再决定。

参考：[AOSP run-as](https://android.googlesource.com/platform/system/core/+/master/run-as/run-as.cpp)、[AOSP app_process](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/cmds/app_process/app_main.cpp)、[DEX 原生目录处理](https://android.googlesource.com/platform/libcore/+/master/dalvik/src/main/java/dalvik/system/DexPathList.java)、[原生加载器 namespace](https://android.googlesource.com/platform/art/+/master/libnativeloader/native_loader.cpp)、[Android 14 动态代码只读要求](https://developer.android.com/about/versions/14/behavior-changes-14#safer-dynamic-code-loading)。
