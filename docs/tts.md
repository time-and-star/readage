# 朗读与 TTS 接入

2026-10-16 补充：已在 vivo V2190A / Exynos 1080 的 1.0.4 正式包中测 CPU 美音、1×。84 字符未命中首段缓存时原生首次输出 7.101 秒，同文完成后重播 3.025 秒；451 字符段落完整播放，但有两次缺音频缓冲，合计 4.007 秒。请求内引擎加载时间均为 0，不能标为冷模型启动；也不能标为长文无停顿或听感通过。完整口径、电脑既有对照及资源成本见 [实测性能与运行条件](performance.md)。下方未测、待安装的条目保留其各自历史日期范围。

单词查词、复习和文章朗读共用同一个客户端语音模块。阅读页的口音和语速选择会保存在当前浏览器，其他朗读入口也使用这些偏好。

选中正文里的句子后，操作小卡片会显示“解释、讨论、复制、朗读”。点击“朗读”只播放选中的文字，长句会依次读完；完整词卡的“阅读原句”下也有“朗读原句”。这些入口沿用阅读页的口音、语速和停止按钮。

浏览器会保留已准备和已播放的音频（最多 32 段、16 MiB，10 分钟过期），相同文本、口音和语速直接复用音频，省去重复下载。准备中点击或连续点击同一句，共用一个 HTTP 请求；关闭选句卡片不会取消已经接手的播放。文章打开约 300 毫秒后开始准备首段，词卡或选区出现约 150 毫秒后开始准备；提前准备仍仅用于明确启用的本机引擎。

文章和句子朗读时，蓝色方框会跟随正文中的当前单词，页面可自由上下滚动，朗读不会改变滚动位置；当前词超出视口时隐藏方框，滚回该词所在位置时继续显示。停止、切换文章或换一句朗读会清除旧框。词框更新使用独立订阅，不会逐词重新渲染整篇文章。设备声音支持 `boundary` 事件时使用真实边界；本机 Kokoro 的当前 ONNX 文件只输出 `waveform`，没有逐词时间戳，因此按每段音频的实际 `currentTime` / `duration` 和词长、音节、标点估计位置，界面标明“词框位置为估计”。这不是强制对齐，不能保证与每个单词的发音完全同步。

“播放耗时”面板显示点击到首次开始播放的时间、首段音频就绪、缓存来源，以及服务返回的排队、CPU 推理和预处理耗时。服务端缓存命中不会重用上次推理耗时。后台准备后点击时，面板里的任务推理耗时可能大于点击后的剩余等待时间。服务新增的计时需重启本机 Kokoro 和应用服务后生效，前端可通过刷新加载。

运行 `npx tsx scripts/diagnose-tts.ts` 会在独立、临时的回环端口上加载已有 fp32 模型，预热后通过应用路由测量真实合成与缓存，不会停止正在使用的服务或下载新模型。结果写入 `local-data/tts-diagnostics.json`。本次 Ryzen 7 6800H 测得：140 字符音频就绪约 2346 ms，其中推理 2211 ms、预处理 80 ms、WAV 编码 3 ms，排队 0 ms；服务端缓存就绪约 7 ms。模型加载和预热另行记录，不计入上述单次请求。瓶颈主要在 CPU 推理，机器负载与文本会影响结果。

## Android 连续朗读源码优化（2026-10-15，待设备检测）

用户反馈 Android“先读然后慢慢加载”时一句一句中断。手机在准备正式模型线程对照时断开，用户暂不方便重连；本轮没有拿到可用的 CPU 线程、实时率或听感对照结果。已经准备的隔离诊断程序不代表手机已执行测试，不据此更改正式模型或线程数，也不套用 Windows 的 fp32 / q8 数据。

原生播放存在可由代码和隔离队列测试确认的等待：合成回调同步向最多 8 秒的 PCM 队列写入，较长音频填满队列后，推理线程会等待播放腾出空间，不能进入下一段合成。例如一次产生 20 秒音频时，旧队列会让回调等待约 12 秒播放（另有 AudioTrack 的小缓冲）；下一段较慢时容易用完剩余音频。这是合成与播放调度的瓶颈，不等于模型运算本身变快或变慢。

源码已作以下调整：

- PCM 队列上限改为 24 秒，允许长句回调更早返回并继续合成后文。队列仍有容量限制，正式 24 / 44.1 kHz 单声道 float PCM 占用上限约 2.2 / 4.0 MiB，不缓存全文音频。
- 保留标点断句，前几段字符上限由 48 → 220 改为 48 → 96 → 160 → 220，避免短开头后立即遇到最大合成任务；英文、法文、日文及 Unicode 原文均完整保留。
- 多段朗读开头先准备约 4 秒**音频内容**，再向 AudioTrack 写入并开始播放；单段短词 / 短句不额外等待。短内容全部合成完毕后即放行，不补静音。首音等待可能增加，尤其旧的首段缓存短于 4 秒时；原有 24 / 31 ms 重播记录不能当作新缓冲策略的保证。
- 如果未完成合成、队列为空且 AudioTrack 已读完已写入帧，显示准备状态并清除旧词框，准备约 3 秒音频或剩余短尾后恢复。实际播放位置继续使用 AudioTrack 帧计数；不把等待时间加入音频位置，不跳过或重读正文。
- 缓冲等待可取消，旧请求的迟到进度 / 恢复事件不能复活朗读；原生调用在停止后即使迟到返回成功，共用客户端仍返回已取消。自然完成继续等待最后实际播放帧。

Android 声音来源保持正式 Sherpa ONNX 1.13.8：英语美音 `af_heart`、英音 `bf_emma`、法语 `ff_siwis` 仍用 Kokoro int8 / 24 kHz / CPU 两线程；日语仍用 Supertonic3 int8 / speaker 0 / 44.1 kHz / 两线程 / 8 步。语速、声音设置及本机离线能力保留，没有换成系统备用声音。没有强行增加 Kokoro 的 `maxNumSentences`；[固定版本上游实现](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-tts-kokoro-impl.h) 对 Kokoro 固定使用单句批次。

验证范围：79 项相关 TypeScript 回归、10 项 Java 主机队列 / 分段 / 缓存测试及类型检查通过，Android Java 编译检查通过；未触发原生产品构建或 APK 任务。真实 ReadingScreen、控件、词框和 CSS 在 360px 触控 / 1280px 鼠标的隔离页面完成 34 项检查，使用**合成的原生进度事件**，没有输出声音，不能计作模型音质或真机连续朗读通过。浏览器 / Windows 的 Node 服务与正式声音配置已核对，生产播放路线无需修改，共用客户端仅增加原生缓冲及取消保护。

若平均合成时间仍长于对应音频时长，任何有限缓冲最终都会耗尽；本轮不能保证低性能手机的长文不再停顿，也不能报告 CPU 提速百分比。后续设备检测须对比正式模型的逐段合成到达时间、首音、缺音频次数、完整正文及持续播放听感，再决定是否调整两条推理线程或模型执行配置。

证据保存在 `output/android-speech-continuity-2026-10-15/`：`client-tests.log`、`pipeline-host-tests.log`、`typecheck.log`、`java-check-plan.log`、`java-compile-check.log`、`ui-report.json` 和界面截图。按先检测、后编译规则，没有产品前端构建、Capacitor 同步、安装包生成或安装；三端当前产物均需重建，学习库、文章、附件和设置未修改。逐项验收见 [S01 / S04–S06 / S09–S21 本轮记录](user-feature-acceptance.md#2026-10-15-android-连续朗读源码检测)。

## 选择方案

| 方案 | 配置 | 使用条件 |
| --- | --- | --- |
| 设备英语声音 | `TTS_PROVIDER=browser`，默认值 | 无需独立服务；可用音色取决于浏览器和系统 |
| 本机 Kokoro（无需 Docker） | `TTS_LOCAL_ENGINE=kokoro-js`，`TTS_PROVIDER=openai-compatible` | 使用已有 Node.js 在 CPU 上推理；`start:local` 自动启动并等待模型就绪 |
| 本机 Kokoro FastAPI | `TTS_PROVIDER=openai-compatible`，指向本机 Kokoro FastAPI | 使用可选的 Docker CPU 部署 |
| 同协议的其他服务 | `TTS_PROVIDER=openai-compatible`，替换服务地址、模型、音色和密钥 | 服务须接受 `POST /audio/speech` 并返回配置的 MP3 或 WAV 音频 |

这里的“兼容”指 HTTP 协议，不要求使用 OpenAI 账户或 SDK。当前外部适配器发送 `model`、`input`、`voice`、配置的 `response_format` 和 `speed`；服务必须接受这些字段。`TTS_AUDIO_FORMAT` 支持 `mp3`（默认）和 `wav`。其他协议可以增加独立的后端适配器，学习界面无需修改。

## 启动本机 Kokoro（无需 Docker）

在项目目录安装独立的推理依赖：

```powershell
npm run tts:setup
```

安装固定的 `kokoro-js@1.2.1` 到 `local-data/kokoro-runtime/`，不会全局安装，也不加入应用的主依赖。Windows x64 CPU 使用 ONNX Runtime 的预编译二进制。

把以下配置加入应用自己的 `.env`：

```dotenv
TTS_LOCAL_ENGINE=kokoro-js
TTS_KOKORO_DTYPE=fp32
TTS_PROVIDER=openai-compatible
TTS_BASE_URL=http://127.0.0.1:8880/v1
TTS_MODEL=kokoro
TTS_VOICE=af_heart
TTS_VOICE_EN_GB=bf_emma
TTS_AUDIO_FORMAT=wav
TTS_TIMEOUT_MS=120000
TTS_MAX_TEXT_LENGTH=200
```

然后运行：

```powershell
npm run start:local
```

启动器先运行 `scripts/kokoro-service.mjs`，每秒检查 `http://127.0.0.1:8880/health`，模型就绪后再打开应用服务。以上配置首次下载 fp32 模型（约 327 MB），缓存保存在 `local-data/kokoro-models/`；控制台显示下载进度。`TTS_KOKORO_DTYPE` 支持 `fp32` 和 `q8`，未配置时保留 q8（约 92.4 MB）。独立的 `tts:start` 也会读取项目 `.env`。启动等待最长 10 分钟，依赖错误、推理进程退出或端口被其他服务占用会明确报错。

网页地址为 `http://localhost:3000`。在阅读页选择美音或英音，点击全文朗读，或点击单词的朗读按钮。打开文章后会提前合成首段，打开阅读词卡或搜索词卡后会准备该单词，准备过程不会播放音频。点击时复用已准备的缓存；如果准备仍在进行，点击请求共用同一次合成。只为明确启用的本机 Kokoro 自动准备音频，云端服务保持点击后合成。

本机首段优先保留不超过 100 字符的完整句子；更长的开头在 100 字符内优先选自然停顿处分段，播放时最多提前准备下一段（后续每段上限 200 字符）。一条 142 字符长首句实测，完整首段准备约 2177 ms，改为在逗号处分出 51 字符首段后约 814 ms 开始具备可播放音频，后文继续完整朗读。云端兼容服务保留首句 180 字符、长开头约 120 字符的原有策略。较慢的 q8 CPU 可设置每段上限 100。结果随硬件、文本、音色和语速变化，缓存未就绪时仍需等待合成。

上述是网页 / Windows 的 Node 管线。Android 正式 Sherpa ONNX 管线独立分块：2026-10-14 将首段上限从 100 改为 48 字符，后续保留 220 字符，原文不遗漏；正式模型与音色保持。首段按语言 / 语速 / 文本 / 采样率精确匹配，在两分钟内可复用，实际首次播放也保留首段。vivo V2190A 实测应用进程重启首个原生音频输出约 12.7 → 7 秒，快速停止后重播约 9 → 2 秒，自然完成后同内容重播约 0.03 秒。快速重播仍可能等前次正在取消的推理，声音听感另作验收。新包安装、正式来源、设备交互及测量边界见 [手机安装与首音实测](android-install-test-2026-10-14.md)。

可运行 `node scripts/benchmark-kokoro.mjs fp32` 比较默认、2、4、8 个 CPU 线程，结果写入 `local-data/kokoro-benchmark-fp32.json`。该测试测量预热后直接调用模型的耗时，不等于网页点击到出声的时间；本次测试没有发现限制线程数带来稳定改善，因此保留引擎默认线程配置。

`af_heart` 是美音女声，`bf_emma` 是英音女声。独立 Node 服务只输出 WAV，因此需要保留 `TTS_AUDIO_FORMAT=wav`。

检查服务：

```powershell
Invoke-RestMethod http://127.0.0.1:8880/health
Invoke-RestMethod http://127.0.0.1:8880/v1/audio/voices
Invoke-RestMethod http://localhost:3000/api/tts/status
```

`health` 的 `engine: "kokoro-js"` 和 `ready: true` 表示模型已加载并完成预热。已运行的同引擎服务会被复用；如果它还在下载模型，启动器会等待它就绪。按 `Ctrl+C` 停止启动器，会停止它自己启动的应用和推理服务，复用的推理服务继续保留。

修改 `TTS_KOKORO_DTYPE` 后，需要停止原推理服务再启动，已加载的模型不会随 `.env` 自动切换。

Windows 安装版在已完整部署 fp32 模型时默认使用 fp32，明确保存的合法模型选择继续保留。2026-10-11 使用实际随包 Electron、ONNX 和模型进行同机对照，每项两轮：短词 q8 1.29 秒、fp32 0.37 秒；105 字符首段 q8 6.66 秒、fp32 2.10 秒；194 字符后段 q8 12.94 秒、fp32 3.52 秒。两种模型均已内置，切换无需下载；本次观察 fp32 内存比 q8 多约 284 MiB。测试音频均为有效、非静音 PCM，记录在 `build/desktop/speech-latency-verification.json`。这是音频生成时间，不是网页点击到出声时间。现有桌面档案中由旧默认保存的 q8 已先备份再恢复为 fp32，重启应用后生效；未改学习数据库。

界面在真实播放开始后才显示“正在朗读”；上一段结束而下一段尚未就绪时显示“准备朗读”并清除旧词框，预取就绪时保持连续状态。取消后的迟到播放结果不能重新启动朗读。51 项客户端朗读、词位和选区测试，以及桌面模型选择和文本处理测试通过；本次没有调整分段边界或原文。

也可以在单独的终端运行 `npm run tts:start`，再运行 `npm run start:local`。需要停止独立启动的推理服务时，在对应终端按 `Ctrl+C`。

## 使用 Docker 启动 Kokoro FastAPI

先安装并启动 Docker Desktop，再在项目目录运行：

```powershell
docker compose -f docker-compose.tts.yml up -d
```

这个可选 Compose 文件使用 Kokoro FastAPI 的 CPU 镜像，固定为 `v0.9.0`，只在本机 `127.0.0.1:8880` 提供接口。首次启动需要下载镜像和模型，镜像包含独立的 Python 推理环境，不安装到本项目的 Node 依赖中。

把下面的配置加入应用自己的 `.env`，然后重启应用：

```dotenv
TTS_PROVIDER=openai-compatible
TTS_LOCAL_ENGINE=
TTS_BASE_URL=http://127.0.0.1:8880/v1
TTS_MODEL=kokoro
TTS_VOICE=af_heart
TTS_VOICE_EN_GB=bf_emma
TTS_AUDIO_FORMAT=mp3
TTS_TIMEOUT_MS=20000
```

`TTS_VOICE` 用于美音，也作为其他口音的默认值；`TTS_VOICE_EN_GB` 指定英音音色。接其他服务时，需要按该服务的声音列表替换名称。Kokoro 本机服务通常无需密钥；需要认证的服务使用 `TTS_API_KEY`，这个密钥只由应用服务端读取。

检查独立推理服务和应用配置：

```powershell
Invoke-RestMethod http://127.0.0.1:8880/v1/audio/voices
Invoke-RestMethod http://localhost:3000/api/tts/status
```

应用状态接口的 `configured: true` 表示配置可用，不表示已经完成推理服务的连接或试听。启动应用后，点击单词朗读或阅读页的全文朗读验证实际播放。CPU 的首次推理可能较慢，可以按设备情况增加 `TTS_TIMEOUT_MS`。

停止独立推理服务：

```powershell
docker compose -f docker-compose.tts.yml down
```

恢复设备语音时，把 `TTS_PROVIDER` 改成 `browser`，清空 `TTS_LOCAL_ENGINE`，并重启应用。

## 模块和接口

客户端位于 `src/lib/speech/`，组件调用 `speakText(text, options?)` 和 `stopSpeech()`。`prepareSpeech(text, options?)` 只准备本机首段，返回取消函数供组件关闭或切换内容时调用，不触发播放或设备语音回退。开始新的朗读会取消之前的播放请求；正在准备的同内容音频可以继续为新点击提供结果。长文章按完整句子和段落拆分，保留标点；`TTS_MAX_TEXT_LENGTH` 设置每段上限（100–2,000 字符，默认 2,000），播放当前段时最多预取下一段。本机 Kokoro 还会检查实际模型 token 长度，拆分过长单句，避免只读到句子前部。

服务端位于 `server/tts/`，通过 `server.ts` 挂载：

- `GET /api/tts/status`：返回提供商标识、是否配置以及文本长度上限；明确启用本机引擎时额外返回 `preload: true`，不返回服务地址或密钥。
- `POST /api/tts/synthesize`：接收 `{ "text": "Hello world.", "lang": "en-US", "rate": 1 }`，返回音频。`lang` 支持 `en-US`、`en-GB`、`fr-FR`、`ja-JP`（`ja` 会归一化为 `ja-JP`），法语和日语分别需要配置对应音色，`rate` 范围为 `0.5–2`。

合成接口沿用应用的敏感 API 认证规则；公开部署使用原有 `APP_API_TOKEN` / `VITE_APP_API_TOKEN`。客户端不能覆盖推理服务地址、模型或密钥。

外部服务发生网络错误或暂时不可用时，客户端提示并切换到设备语音；认证失败会明确提示。服务端限制超时、并发和音频大小，重复朗读使用有容量上限的进程内缓存。相同内容、口音、语速和服务配置的并发请求共用一次合成；只有所有等待者都取消后才取消共享任务。缓存不写磁盘，重启后清空。

## 增加其他协议

在 `server/tts/` 为新协议实现提供商适配器，再在服务的配置解析和提供商选择处注册。保持应用 API 的输入与二进制音频输出合同，就能继续复用客户端的断句、预取、偏好、停止和回退逻辑。

实时口语对话继续使用原有 Step 实时链路；这次模块负责朗读按钮的单词和文章配音。

## 法语文章试读

书库导入时选择“法语”，或从词典试读页点击“导入书库并阅读”。文章保存 `language: fr`，正式 `/read/…` 路由使用语言中立的查词结果，支持按段或选中文本翻译、单词/段落/全文朗读及阅读位置保存。当前法语查词不写入英语词汇复习记录，也不触发英语 CEFR 编纂任务。

本机语音安装：`npm run tts:setup-french`。这会在独立的 `local-data/kokoro-runtime` 内安装固定版本 `@echogarden/espeak-ng-emscripten@0.3.5`（GPL-3.0），并校验下载官方 ONNX `ff_siwis.bin` 音色的 SHA-256。模型权重使用原有 Kokoro ONNX，适配器位于 `scripts/kokoro-french.mjs`，不修改第三方 Kokoro.js 包。法语文本先经 eSpeak NG 转为法语音素，再输入模型；保留鼻化音与法语标点，不经过英语文本归一化。eSpeak 与音色只在服务端读取，不进入网页或扩展包。

安装后在 `.env` 配置 `TTS_VOICE_FR_FR=ff_siwis`，重启已有 Kokoro 引擎和应用；已经运行的旧引擎不会自动加载新音色。`/api/tts/status` 声明所配置的语言。没有法语语音服务时，只回退到设备的法语声音；设备没有匹配声音时明确提示，不使用英语声音替读。临时独立预览可设置 `TTS_KOKORO_PORT=8881` 并使用 `TTS_BASE_URL=http://127.0.0.1:8881/v1`。

朗读的法语请求不会覆盖浏览器原先保存的英语口音偏好；语速仍共用原有偏好、取消机制和带语言标识的音频缓存。逐词蓝框沿用音频时长估计，尚非真实法语强制对齐。

相关上游：[官方法语音色](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md#french)、[eSpeak NG Emscripten](https://github.com/echogarden-project/espeak-ng-emscripten)。

## 日语文章朗读

安装日语语音依赖：`npm run tts:setup-japanese`。安装后在 `.env` 配置 `TTS_VOICE_JA_JP=jf_alpha`，重启 Kokoro 引擎和应用。日语使用官方 `jf_alpha` 音色、日语音素转换与已有的 Kokoro ONNX 模型；新安装的依赖只由本机推理服务使用。

书库导入时选择“日语”，保存的 `language: ja` 会让文章、段落、选中文本及查词卡的朗读请求使用 `ja-JP`，无需更改原有美音/英音偏好。长文本按 `。！？` 和段落拆分，首段也能在日语顿号处停顿；音频缓存包含语言和语速，服务端缓存还包含音色配置。

`/api/tts/status` 只在配置日语音色后声明 `ja-JP`。如果语音服务没有日语能力，或服务暂时失败，客户端会使用设备的日语声音；设备没有匹配声音时明确提示。日语逐词蓝框使用分词与音频时长估计，尚非真实音素对齐。

## 上游资料

- [Kokoro 模型与官方音色](https://huggingface.co/hexgrad/Kokoro-82M)
- [Kokoro.js 官方代码和用法](https://github.com/hexgrad/kokoro/tree/main/kokoro.js)
- [Kokoro ONNX 模型文件](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/onnx)
- [ONNX Runtime Node.js 支持平台](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [Kokoro FastAPI 部署和兼容接口](https://github.com/remsky/Kokoro-FastAPI)
- [Kokoro FastAPI v0.9.0](https://github.com/remsky/Kokoro-FastAPI/releases/tag/v0.9.0)
