# Android GPU 实测：2026-10-15

GPU 已在连接手机的独立原生运行器中真正执行正式翻译模型。当前设备是 vivo V2190A / Exynos 1080 / Mali-G78，不能记为骁龙 8 Elite Gen 5 或天玑实测。实测的纯 GPU、注意力配置和 GPU 输入 / CPU 生成方案均慢于优化 CPU，因此 `READAGE_VULKAN` 默认关闭，正式应用继续走 CPU。本轮没有产品前端构建、Capacitor 同步、APK 生成、覆盖安装或安装版界面验收；初始设想的安装步骤因候选性能不满足目标而不执行。

## 实际 GPU 证据

- 系统 Vulkan API 为 1.3.213，16 位存储、FP16 与带硬件加速的 8 位整数点积可用；设备类型是共享内存的集成 GPU（IGPU），选择时同时覆盖 GPU / IGPU。
- [模型加载日志](../output/android-gpu-2026-10-15/gpu-full.stderr.log)记录 `offloaded 33/33 layers to GPU`、`Vulkan0 model buffer size = 1075.74 MiB`，有完整 EOS 译文，非仅检查库存在。
- NDK glslc 为 2022.3，不能编译所需整数点积扩展。改用 Google 官方固定构件中的 glslc 2026.5-dev 后，[日志](../output/android-gpu-2026-10-15/gpu-cancel-loading.stderr.log)确认 `int dot: 1`。
- [硬件能力](../output/android-gpu-2026-10-15/gpu-capabilities.json)、[原始 vkjson](../output/android-gpu-2026-10-15/vulkan-device.json)、[编译器来源与哈希](../output/android-gpu-2026-10-15/glslc-provenance.json)均保留。

正式模型保持 Tencent Hy-MT2-1.8B Q4_K_M，1,133,080,448 字节，SHA-256 为 `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699`。四线程、完整指令 / 正文、固定指令缓存、128 输入批次、4096 上下文、768 输出上限和 EOS 门禁保持。没有换小模型、缩短正文、改变采样参数或向学习库写测试数据。

## 性能筛选

下表是每配置每输入 2 个热运行样本的中位数。短句为 41 个输入 token / 17 个输出 token；段落为 104 个输入 token，输出随配置约 71–72 token。使用 USB 供电，顺序筛选而非随机 ABBA，现代 GPU 测试前电池温度 37.7°C；不构成长时温控、功耗或广泛质量评测。耗时是独立运行器的请求时间，不是界面点击到显示时间。

| 配置 | 短句 | 段落 | 峰值进程 RSS |
| --- | ---: | ---: | ---: |
| 优化 CPU | 2.319 秒 | 9.246 秒 | 1389 MiB |
| GPU，NDK 旧编译器 | 23.761 秒 | 59.742 秒 | 2239 MiB |
| GPU，新编译器 / 整数点积 | 8.328 秒 | 未测 | 2246 MiB |
| GPU，新编译器，关闭 Flash Attention | 8.619 秒 | 未测 | 2246 MiB |
| GPU，新编译器，注意力放 CPU | 15.681 秒 | 未测 | 2246 MiB |
| GPU 输入 / CPU 生成，普通 KV 布局原型 | 9.215 秒 | 19.094 秒 | 3434 MiB |
| GPU 输入 / CPU 生成，连续 KV 布局原型 | 6.782 秒 | 14.801 秒 | 3405 MiB |

新编译器改善了纯 GPU 路线，但短句仍比 CPU 约慢 3.6 倍。GPU 输入本身很快，逐字生成较慢；混合方案则被 KV 传递拖慢。连续布局原型中，短句 2.62 MB 状态传递约 4.77–4.84 秒，段落 6.75 MB 约 7.14–7.31 秒，连同 CPU 生成后整体仍输给 CPU。两份混合原型只在 `output/`，未合入产品核心。

旧 GPU 配置的段落两次出现不同措辞 / 输出长度。样例数字 37、两年、否定和限制条件检查保留，但这不能代替完整四语、长文质量、确定性、界面或各平台验收。没有将 Mali 的结果外推为 Adreno / 骁龙或其他天玑 GPU 的倍率。

原始结果及统计见 [summary.json](../output/android-gpu-2026-10-15/summary.json)，每项对应同目录 `*.stdout.jsonl` 和 `*.stderr.log`。

## 源码与检测

- Android CMake 增加默认关闭的实验 Vulkan 分支，保留全部 CPU 变体；从 GPU 切回 CPU 会强制清掉 ggml 的旧 ON 缓存，避免误启用。后端枚举支持手机 IGPU；固定库名加载，不扫描可写库目录。
- 核心增加 CPU / GPU 诊断选择、GPU 层请求和实际设备指标；模型 / 上下文缓存按设备及配置隔离。自动模式在可恢复的 GPU 初始化 / 加载 / 计算异常后用原截止时间重试 CPU；取消和超时不重试，不返回部分输出。驱动致命崩溃不属于 C++ 异常回退能够保证的范围，本轮未注入这类故障。
- JNI 日志分别记录实际 CPU / GPU 后端、GPU 层请求和回退。Java 状态增加 `lastBackend`，初始为 `uninitialized`，只在完整请求成功后更新；不根据“库已存在”提前声称 GPU 已计算。浏览器 / Windows 的 Node 推理配置及共用 TS 桥接无需修改。
- Khronos 头文件和 Google glslc 固定版本 / 哈希，由 `node scripts/prepare-android-vulkan.mjs --download` 准备到项目 `local-data/`。原有固定版本 llama.cpp 供应商源码没有修改。
- 独立 ARM 运行器 [9 组 / 24 个完整输出检查](../output/android-gpu-2026-10-15/native-cpu/report.json)通过：四语新上下文参考、切换语言、37 / 83 正文隔离、跨批输入、加载 / 计算取消、超时恢复、上下文上限、不支持的 CPU 指令拒绝。
- [GPU 加载取消、计算取消、超时恢复](../output/android-gpu-2026-10-15/summary.json)通过限定范围检查：均没有部分译文，恢复请求没有复用失败上下文 / 指令 token。250ms 计算取消 / 超时约在 5.5 秒后才从原生退出，说明在途 Vulkan 工作不能立即中断；不能将其当作严格原生截止时间保证。
- [GPU 库缺失回退](../output/android-gpu-2026-10-15/fallback-report.json)确认自动模式实际使用 CPU，强制 GPU 则明确返回不可用。没有故意制造驱动崩溃或内存耗尽。
- 32 项 Node / 共用 / 原生桥接 / 离线资源回归、7 项最终正式模型主机检查、TypeScript 类型检查、JNI 语法 / 格式检查、Android Java 编译通过。Java 检查先审核 Gradle 任务计划，未运行产品原生构建或 APK 任务。

模型和运行库只放在 `/data/local/tmp/readage-gpu-20261015`；没有打开学习档案、卸载、清数据、覆盖安装或修改系统 GPU 设置。当前实验包不能视为正式交付，后续若启用安装版，仍需核对 Vulkan 库 / 许可证打包和完成 JNI / 界面验收。

## D01–D04 与三端对应

| 编号 / 可观察操作 | 本地浏览器 | Windows | Android 本轮证据 |
| --- | --- | --- | --- |
| D01：选句得到完整对应译文，切换正文无旧结果污染 | Node / 共用源码保持，相关回归通过；本轮 UI 未操作 | 同一 Node 路线保持，安装版 UI 未操作 | CPU 四语 / 正文 / 多批隔离通过；GPU 英语样例完整 EOS；GPU 四语及安装版显示未验收 |
| D02：取消、切换，再翻译，旧请求不覆盖新选择 | 共用 / Node 取消回归通过 | 同一请求隔离保持 | CPU 原生检查通过；GPU 取消 / 超时恢复通过上述范围，在途退出有延迟；真实触屏未验收 |
| D03：超长明确提示，不以部分输出充成功 | 1200 字符和完成门禁保持 | 同一门禁保持 | CPU 桥接 / 原生上限通过；GPU 取消 / 超时返回空结果；GPU 全部边界及 UI 未验收 |
| D04：正式离线模型运行，失败有原因 | 本轮离线 UI 未操作 | 本轮安装版模型未操作 | 正式 GGUF 与离线运行器使用实际 GPU；缺库自动 CPU / 强制 GPU 错误反馈通过；APK 离线界面未验收 |

| 端 | 源码对应 | 测试 | 构建 | 安装包 | 安装 | 设备验收 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地浏览器 | 本轮无需修改 | 相关回归通过 | 已有待交付修改需重建；本轮未运行 | 不适用 | 不适用 | 本轮 UI 未复测 |
| Windows | 本轮生产 Node 路线无需修改 | 相关回归通过；C++ 主机仅验证 Android 核心 | 已有修改需重建；本轮未运行 | 旧包保留，需重建 | 本轮未更新 | 新安装版待设备验收 |
| Android | 实验 Vulkan 路径及真实后端状态已对应，默认 CPU | 32 项相关、7 项模型主机、9 组 CPU 真机、3 组 GPU 中止恢复、缺库回退、类型 / JNI / Java 检查通过各自范围 | 仅编译测试运行器 / Java 检查；产品前端与原生需重建，Capacitor 未同步 | 本轮未生成；旧 APK 保留 | 本轮未更新 | 独立 GPU / CPU 范围有实测，安装版 JNI / UI、骁龙 / 天玑、持续负载待验收 |

已有产物仍为 `build/desktop/readge-0.1.0-windows-x64-setup.exe` 与 `android/app/build/outputs/apk/debug/app-debug.apk`，不代表本次源码已经交付。末次只读查询确认手机现有版本为 3 / 1.0.2，系统记载上次更新时间 2026-10-15 15:40:12；本任务没有执行该安装，也没有将本轮 GPU 源码安装到这个版本。后续更新包必须递增内部版本，至少为 4，不能复用 3。只读平台核对记录三端已有产物需重建。
