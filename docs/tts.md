# 朗读与 TTS 接入

单词查词、复习和文章朗读共用同一个客户端语音模块。阅读页的口音和语速选择会保存在当前浏览器，其他朗读入口也使用这些偏好。

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

首段优先保留不超过 180 字符的完整句子；更长的开头在约 120 字符的自然停顿处分段。播放时最多提前准备下一段。fp32 配置推荐每段上限 200 字符；较慢的 q8 CPU 可设置为 100。该电脑 Ryzen 7 6800H 实测，同一段 140 字符的美音合成从 q8 的约 9.0 秒降至 fp32 的约 3.8 秒；结果随硬件、文本、音色和语速变化，缓存未就绪时仍需等待合成。

`af_heart` 是美音女声，`bf_emma` 是英音女声。独立 Node 服务只输出 WAV，因此需要保留 `TTS_AUDIO_FORMAT=wav`。

检查服务：

```powershell
Invoke-RestMethod http://127.0.0.1:8880/health
Invoke-RestMethod http://127.0.0.1:8880/v1/audio/voices
Invoke-RestMethod http://localhost:3000/api/tts/status
```

`health` 的 `engine: "kokoro-js"` 和 `ready: true` 表示模型已加载并完成预热。已运行的同引擎服务会被复用；如果它还在下载模型，启动器会等待它就绪。按 `Ctrl+C` 停止启动器，会停止它自己启动的应用和推理服务，复用的推理服务继续保留。

修改 `TTS_KOKORO_DTYPE` 后，需要停止原推理服务再启动，已加载的模型不会随 `.env` 自动切换。

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
- `POST /api/tts/synthesize`：接收 `{ "text": "Hello world.", "lang": "en-US", "rate": 1 }`，返回音频。`lang` 支持 `en-US`、`en-GB`，`rate` 范围为 `0.5–2`。

合成接口沿用应用的敏感 API 认证规则；公开部署使用原有 `APP_API_TOKEN` / `VITE_APP_API_TOKEN`。客户端不能覆盖推理服务地址、模型或密钥。

外部服务发生网络错误或暂时不可用时，客户端提示并切换到设备语音；认证失败会明确提示。服务端限制超时、并发和音频大小，重复朗读使用有容量上限的进程内缓存。相同内容、口音、语速和服务配置的并发请求共用一次合成；只有所有等待者都取消后才取消共享任务。缓存不写磁盘，重启后清空。

## 增加其他协议

在 `server/tts/` 为新协议实现提供商适配器，再在服务的配置解析和提供商选择处注册。保持应用 API 的输入与二进制音频输出合同，就能继续复用客户端的断句、预取、偏好、停止和回退逻辑。

实时口语对话继续使用原有 Step 实时链路；这次模块负责朗读按钮的单词和文章配音。

## 上游资料

- [Kokoro 模型与官方音色](https://huggingface.co/hexgrad/Kokoro-82M)
- [Kokoro.js 官方代码和用法](https://github.com/hexgrad/kokoro/tree/main/kokoro.js)
- [Kokoro ONNX 模型文件](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/onnx)
- [ONNX Runtime Node.js 支持平台](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [Kokoro FastAPI 部署和兼容接口](https://github.com/remsky/Kokoro-FastAPI)
- [Kokoro FastAPI v0.9.0](https://github.com/remsky/Kokoro-FastAPI/releases/tag/v0.9.0)
