# ReadAge 模型来源与许可声明

本声明对应 2026-10-16 发布的 Windows 0.1.2、Android 1.0.4（versionCode 5）及对应源码。只记录应用运行时使用或保留接入的翻译、语音和在线大模型。

ReadAge 集成的第三方模型、音色及运行组件分别归其作者或权利人所有。ReadAge 自有源码采用 [Apache License 2.0](../LICENSE)，该许可证不替代第三方资源的原许可。模型和服务名称用于说明实际依赖，不表示相应项目、作者或公司对 ReadAge 的认证或背书。

## 本机翻译：腾讯 Hy-MT2-1.8B

模型由腾讯发布，项目页为 [tencent/Hy-MT2-1.8B](https://huggingface.co/tencent/Hy-MT2-1.8B)。随包许可保留 Tencent 的版权声明及 Apache License 2.0 全文。ReadAge 用它处理用户主动选中的翻译文本；翻译结果可能出现误译。

| 平台 | 实际资源 | 固定版本与处理 |
| --- | --- | --- |
| 本地浏览器 / Windows | [AngelSlim/Hy-MT2-1.8B-1.25Bit-GGUF](https://huggingface.co/AngelSlim/Hy-MT2-1.8B-1.25Bit-GGUF)，非 v2 的 1.25bit Stride16 文件 | 上游 revision `0989912c0cc2d3edeeecd76171d1c7d94ee17255`；仅在独立副本中调整旧 GGUF 张量类型号以适配固定运行器，权重数据未改动，未重新量化 |
| Android | [tencent/Hy-MT2-1.8B-GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF)，官方 `Hy-MT2-1.8B-Q4_K_M.gguf` | 上游 revision `a0c709d9fac510f2c807aa3af52872340dc37a4a`；模型按固定字节数及 SHA-256 核对，未重新量化 |

模型许可为 **Apache-2.0**，使用 [llama.cpp](https://github.com/ggml-org/llama.cpp) 推理，其源码许可为 **MIT**。Windows 使用固定 CPU AVX2 分支，revision `c828a2e883defef95fd6121ee1586efcce89ad40`；Android 固定 commit `8ae386707bed05f02354dbfc6fa5ee0cf58e5f0f`。Windows 模型的 GGUF 兼容性调整在上表明确披露。

## 本机朗读：Kokoro-82M v1.0

模型由 [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) 发布，模型许可为 **Apache-2.0**。ReadAge 使用已有转换文件合成语音，随包保留模型许可及相关声明。

| 平台 | 实际资源与用途 | 转换来源 |
| --- | --- | --- |
| 本地浏览器 / Windows | Kokoro-82M v1.0 ONNX，包含 q8 / fp32；使用已配置的英音、美音、法语 `ff_siwis`、日语 `jf_alpha` | [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)，随包模型卡 revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231`，通过 `kokoro-js` 运行 |
| Android | `kokoro-int8-multi-lang-v1_0`；美音 `af_heart`、英音 `bf_emma`、法语 `ff_siwis` | [Sherpa ONNX 官方转换包](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2)，固定下载 SHA-256 `4c3052abaa60943a341f193888cf6abd68787dae6ab8ae5c925a706caa247e4e` |

Android 使用 Sherpa ONNX 1.13.8 运行。模型许可与发音前端、运行库的许可分别适用，见下文运行组件表。

## Android 日语朗读：Supertonic 3

Android 日语使用 Supertone 的 **Supertonic 3**（speaker 0），通过 Sherpa ONNX 运行。它与 Windows 日语所用的 Kokoro `jf_alpha` 不同。

- 上游模型：[Supertone/supertonic-3](https://huggingface.co/Supertone/supertonic-3)。
- 实际转换包：[sherpa-onnx-supertonic-3-tts-int8-2026-05-11](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2)，固定 SHA-256 `82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427`，未改动上游转换文件。
- **模型许可为 BigScience Open RAIL-M**；随包全文来自上游 revision `724fb5abbf5502583fb520898d45929e62f02c0b` 的 [LICENSE](https://huggingface.co/Supertone/supertonic-3/blob/724fb5abbf5502583fb520898d45929e62f02c0b/LICENSE)。
- 使用和后续分发须遵守原模型许可，包括第 5 条及 Attachment A 的使用限制；这些条件继续适用于后续接收者。
- Supertone 推理源码使用 **MIT** 许可。模型权重继续适用其 Open RAIL-M 许可。

## 相关推理与发音组件

| 组件 | 来源 | 许可与分发说明 |
| --- | --- | --- |
| llama.cpp | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT；两端保留对应版权及许可 |
| Sherpa ONNX 1.13.8 | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8) | Apache-2.0；保留其第三方声明 |
| ONNX Runtime | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) | MIT；保留其版权与许可 |
| eSpeak NG 发音前端与数据 | [espeak-ng/espeak-ng](https://github.com/espeak-ng/espeak-ng)、Windows 的 [espeak-ng-emscripten](https://github.com/echogarden-project/espeak-ng-emscripten) | GPL-3.0；对应包保留许可、声明及所需对应源码，具体以随包文件为准 |

`kokoro-js`、Transformers.js、Python、日语发音依赖及其他运行库按各自分发文件中的许可证处理。上述表格说明主要模型链路，完整依赖许可仍以发行包内文件为准。

## 可选在线大模型与服务

源码保留以下可配置的服务接入。表内标识是当前代码的默认配置值；实际模型、可用性、计费和数据处理由用户配置及服务商决定。ReadAge 不分发这些在线模型的权重，也不将服务条款替换成项目的 Apache 2.0 许可证。

| 服务 | 代码中的默认模型标识 | 接入用途与条件 |
| --- | --- | --- |
| DeepSeek | `deepseek-v4-flash`，可由 `DEEPSEEK_TRANSLATE_MODEL` 等配置覆盖 | 可选云端翻译、文章处理及阅读核验，须有有效服务配置且功能开启 |
| 阶跃星辰 StepFun | 文本 `step-3.7-flash`；实时语音 `stepaudio-2.5-realtime` | 可选文本及实时语音接口，须有有效服务配置且功能开启 |
| Google Gemini | `gemini-3.6-flash`，可由 `GEMINI_MODEL` 覆盖 | 可选文本接口，须有有效服务配置且功能开启 |

接入依据见 [`.env.example`](../.env.example)、[`server/llm/stepChat.ts`](../server/llm/stepChat.ts)、[`server/realtime/stepProxy.ts`](../server/realtime/stepProxy.ts) 与 [`server.ts`](../server.ts)。实际使用受相应服务商的服务条款和隐私政策约束。

当前 Windows / Android 离线发行配置关闭在线 AI，界面中的 AI 解释与文章讨论也保持关闭。保留接入代码不代表发行包已经启用这些能力。启用在线服务时，请求中的相应文本或语音会发送到所配置的服务；本机翻译与本机语音合成在设备上推理，不会因失败自动转发给云端模型。

## 随包声明位置与核对依据

| 范围 | 许可与资源记录 |
| --- | --- |
| Windows 0.1.2 | `resources/offline-resources/licenses/`，含 `Hy-MT2-LICENSE.txt`、`Kokoro-LICENSE.txt`、模型卡及相关源码；`resources/offline-resources/workspace/local-data/translation/LICENSE.llama.cpp`；Node / Python 各组件目录内的许可 |
| Android 1.0.4 | APK 内 `assets/readage-runtime/translation/LICENSE.Hy-MT2.txt`、`LICENSE.llama.cpp.txt`，以及 `assets/readage-runtime/speech/licenses/` 的模型和运行库许可、`NOTICE.txt`；对应转换包中的许可同时保留 |
| 本地浏览器源码启动 | 模型单独准备；安装或携带资源时保留相应许可证，运行及配置方式见 [本机翻译](local-translation.md) 和 [朗读与 TTS](tts.md) |

版本与资源清单依据 [`scripts/desktop-bundle-resources.mjs`](../scripts/desktop-bundle-resources.mjs)、[`scripts/prepare-android-translation.mjs`](../scripts/prepare-android-translation.mjs)、[`scripts/prepare-android-speech.mjs`](../scripts/prepare-android-speech.mjs) 及当前构建清单核对。

本次补充 README、此声明和 GitHub Release 的说明文字；2026-10-16 已发布安装包中的模型及原许可文件保持原版本，下载文件的校验和不变。文档核对不替代模型准确性、正式语音听感或设备验收。
