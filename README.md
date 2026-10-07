# English AI · Active Reading MVP

以**文章**为核心实体的英语学习最小可行产品。依据《英语教学 AI 产品文档》v0.2，复用本仓库暖纸色前端，串联 **P1 获取 → P2 学习 → P3 学习概览与阅读记录** 闭环。

详细设计见 **[DESIGN.md](./DESIGN.md)**。

单词、复习和文章朗读共用可切换的语音模块：默认使用设备英语声音，也可接入本机 Kokoro 或其他兼容语音服务。阅读页可选择英音/美音、语速和停止播放，配置见 **[朗读与 TTS 接入](docs/tts.md)**。

选中正文里的句子，点击 **翻译**，可用本机腾讯 Hy-MT2 模型得到中文译文。当前电脑已安装并启用按需模式，不自动预翻译全文；启动器会自动加载模型，无需翻译 API Key。安装、启动及使用说明见 **[本机句子翻译](docs/local-translation.md)**。

## 功能范围（MVP）

| 页面 | 能力 |
|---|---|
| P1 Home | 一键推荐 / 文章库 / 粘贴文章 / 自动续读 |
| P2 Reading | 本地词卡、按需句子翻译、朗读、连续阅读与难度反馈；解释与讨论暂时关闭 |
| 词卡学习内页 | 英文词卡翻面、自评回忆、到期优先、间隔复习、本轮错词重练 |
| P3 My Learning | 进度统计、阅读记录、文章生词、书籍章节进度、推荐阅读与词卡学习入口 |

阅读历史统一保留在学习概览的阅读记录中。旧 `/history` 链接会转到 `/learning/articles`。

本地词汇记忆：成功查词形成曝光＋查询证据，阅读曝光使用可见性和停留时间约束；主应用按每日证据更新记忆估计和复习安排。未查询不等于已掌握；文字讨论不直接给词汇加分；英语测试功能已移除。

阅读有两个入口：**Library** 按期刊目录选文章，正文末尾的“下一篇（本期）”继续本期顺序，末篇明确结束；导入的文件按章节或页序继续。**推荐阅读** 有独立入口，点击“开始推荐阅读”后进入推荐流，也可从入口继续尚未结束的推荐阅读。Library 和历史记录中的文章不会自动启动推荐流。

每篇文章分别保存阅读断点；达到前台停留要求的段落可跨次累计完读，正文变化会重置旧段落进度。返回 Library 保留目录、筛选和列表位置。文件导入先准备再确认，支持取消、超时重试、分批继续和指定章节起点；同一文件的章节使用稳定标识，重复导入保留原学习记录。

**词卡学习**位于数据页内，与“推荐阅读”并排，点击进入 `/learning/flashcards` 内页，返回时回到数据页；旧 `/flashcards` 链接仍兼容。阅读中查过的词和主动导入词表的词一起进入队列，先复习全部到期词，再学习新词。右上角“学习设置”可修改每天的新词数量（默认 10，可自定义、选择不限或设为 0 仅复习），到期复习不占新词名额；修改后立即更新当前计划，并保留已保存的答案和本轮巩固卡。支持 TXT、CSV、TSV、JSON 文件或粘贴词表，导入前归并词形并预览新增、已有、重复和无效项；已有词的记忆不会重置，导入本身不计作查词或学习成功。单次支持 10000 项、2 MiB 文本，词卡设置和登记词表随本地学习数据备份保留。在正面先回忆并选择熟悉程度，词卡带动画翻开核心释义，更多内容从“查看详解”展开，再点卡片进入下一张；也可直接点击卡片查看释义。共享 FSRS 记忆库自动调整下一次复习时间，忘记的词隔几张后再练。

学习设置中的“词表管理”可搜索、批量暂停、恢复或移出单词。暂停和移出仅停止词卡安排，保留历史记录；恢复或重新导入可以重新加入学习。

点击页面底部的“记忆曲线”，可查看已有正式回忆记录的 FSRS 预测，切换 1 / 7 / 30 天、当前词 / 我的词库并探索时间点。它是默认模型估计，没有记录时明确提示；0 天的 100% 是模型起点，不是实测成绩。

数据页的“已学习”统计已有正式回忆记录的词，“待复习”仅统计其中已到期且未暂停或移出的词；“待学新词”显示完整待学词库，每日数量只影响当天安排。读取失败显示重试入口。“推荐阅读”与“词卡学习”提供两种学习入口；文章只覆盖词库的一部分，读完不会将全部待复习词标为已复习。

## 本地运行

浏览器插件现已支持 Chrome / Edge 的网页选词查词和本地熟练度同步，安装与使用见 [浏览器插件说明](extension/README.md)。

**前置：** Node.js ≥ 20

```bash
npm install
```

在 `.env` 中配置 AI 服务（可选；没有有效凭证时基础词典仍可使用，AI 功能明确显示不可用）：

```
GEMINI_API_KEY=your_key_here

# 外刊同步（hehonghui/awesome-english-ebooks）
# GITHUB_TOKEN=ghp_xxx          # 可选，提高 GitHub API 限额
# MAGAZINE_MAX_ISSUES_PER_SOURCE=4
# MAGAZINE_SYNC_CRON=0 12 * * 5 # 默认每周五 12:00
# MAGAZINE_SYNC_ON_BOOT=true    # 默认启动后全源同步；设 false 可关闭

# Step Plan（文字 tutor + 实时语音）
# STEP_API_KEY=your_step_key
# STEP_BASE_URL=https://api.stepfun.com/step_plan/v1
# STEP_CHAT_MODEL=step-3.7-flash
# DEEPSEEK_API_KEY=your_deepseek_key
# DEEPSEEK_BASE_URL=https://api.deepseek.com
# DEEPSEEK_TRANSLATE_MODEL=deepseek-v4-flash   # article enrichment; thinking disabled
# DEEPSEEK_ARTICLE_MAX_IN_FLIGHT=50              # translation + CEFR rating, max 2500
# STEP_REALTIME_MODEL=stepaudio-2.5-realtime
# STEP_REALTIME_URL=wss://api.stepfun.com/step_plan/v1/realtime
# LLM_PROVIDER=step
# READING_VERIFICATION_PROVIDER=deepseek # optional: step / deepseek / gemini; defaults to LLM_PROVIDER
```

```bash
npm run start:local
```

打开 http://localhost:3000。Windows 也可双击 `start-local.cmd`。保持服务进程运行；首次安装插件可打开 `/extension-setup.html`，下载 ZIP 并按页面指引加载。

`npm start` 是生产模式，仍要求配置生产访问凭证；个人本机使用请选 `npm run start:local`。AI 供应商密钥无效或订阅到期时，请在本机更新 `.env` 并重启，不要把密钥发到聊天中。

阅读完成并保存曝光记录后，通过 `/api/tutor` 的 `after_reading` 将完整文章及最多 120 个相关词的掌握摘要交给教学 agent。agent 先决定是否出题、核对哪个词、目的和难度，再调用三选一出题能力。题目仍采用「英文＋中文」选项，展示为可选卡片，不自动展开。刚学或刚查的词可作当次理解练习，答案只保存为练习记录，不增加长期记忆证据；延迟验证仍需距离最近学习至少 24 小时。返回决策和题目在服务端、客户端分别校验；服务不可用时回退固定题库，agent 主动决定跳过时不会强行补题。答过的句子保存在本地用于去重。密钥保留在服务端，完整文章最长 120,000 字符；超过限额时不会截取部分文章冒充完整分析。

## 学习数据：浏览器本地（多访客）

**默认模型：** 每位访客的学习进度只保存在**自己的浏览器**（`localStorage` + Memory V2 `IndexedDB`），服务器不存用户档案、不要求登录。

| 存在本机 | 在服务器 |
|---|---|
| 文章历史、会话与讨论 | 杂志正文库、词典数据 |
| 词汇记忆 / FSRS 复习 | AI 代理（翻译、讨论、推荐） |
| 阅读偏好、薄弱点、连续天数 | 进程与环境变量（API Key） |

在 **数据 → 数据与备份** 可导出或导入 JSON。导出会先等待待保存记录；记忆库读取失败会停止导出，恢复失败会回滚。备份包含浏览器中的记录，PDF 原文件和插图需要单独迁移或重新导入。

换浏览器、清站点数据、无痕模式会丢失进度（除非先导出）。

## 部署给他人访问

```bash
# 1) 环境变量（示例）
# HOST=0.0.0.0
# PORT=3000
# APP_API_TOKEN=<长随机串>          # 生产/公网必填：保护 /api/tutor 与杂志同步
# VITE_APP_API_TOKEN=<同上>        # 构建前端时写入，请求时带上；勿提交仓库
# STEP_API_KEY / DEEPSEEK_API_KEY 等 LLM 密钥
# MAGAZINE_SYNC_ON_BOOT=false      # 公网建议关闭启动全量同步，改手动

# 2) 拷贝或同步 data/magazines/（体积较大，未进 git）
# 3) 构建并启动
npm run build
npm start
```

- 反代 HTTPS（Nginx/Caddy）到 `HOST:PORT`。
- `VITE_*` 在 **build 时** 生效；改 token 需重新 `npm run build`。
- 共享 `APP_API_TOKEN` 适合小范围试用；token 会出现在前端产物中，请配合限流/防火墙，勿当作真正的用户鉴权。
- 外刊内容仅供学习，请支持正版订阅。

### 外刊杂志（Library → 外刊杂志）

从 [awesome-english-ebooks](https://github.com/hehonghui/awesome-english-ebooks) **定期/手动导入并解析**经济学人、纽约客、大西洋月刊、Wired；同时从 [News in Levels](https://www.newsinlevels.com/) 导入 A2 Level 1 与 B1 Level 2 分级新闻：

1. 打开 **文章库 → 外刊杂志**
2. 点击 **同步外刊**（或等待定时任务）
3. 先选 **期号**，再选 **文章**，进入 P2 点词学习

| API | 说明 |
|---|---|
| `GET /api/magazines/sources` | 杂志源 |
| `GET /api/magazines/issues` | 期号列表 |
| `GET /api/magazines/issues/:id` | 期内文章列表 |
| `GET /api/magazines/articles/:id` | 单篇全文 |
| `POST /api/magazines/sync` | 手动同步 |
| `GET /api/magazines/sync/status` | 同步状态 |

解析结果缓存在本地 `data/magazines/`（已 gitignore），**不**再分发 epub/pdf 原文件。内容仅供个人学习，请支持正版订阅。

## 脚本

| 命令 | 说明 |
|---|---|
| `npm run start:local` | 固定本机地址的 Express + Vite，关闭启动全库同步 |
| `npm run dev` | Express + Vite 开发服务器 |
| `npm run build:extension` | 生成 extension/dist 和网页可下载的插件 ZIP |
| `npm run build` | 构建前端与 server |
| `npm run start` | 生产启动 |
| `npm run lint` | `tsc --noEmit` |
| `npm test` | 单元测试（含 epub 解析 fixture） |

## 技术栈

- React 19 + TypeScript + Vite + Tailwind CSS 4
- Express API（Gemini：查词 / 翻译 / 推荐 / 聊天；外刊同步解析）
- 数据：学习状态 localStorage；外刊正文服务端落盘
