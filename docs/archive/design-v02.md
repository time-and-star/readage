# English AI · 最小 MVP 设计文档

**版本** v0.2-FSRS · **依据** 《英语教学 AI 产品文档》v0.2 · **实现基线** 本仓库现有前端原型（P1–P4 页面 + 文章学习交互）

---

## 1. 目标与边界

### 1.1 MVP 要证明什么

用**一篇文章**串起完整学习闭环，验证产品原则是否可落地：

1. 用户从 **P1** 拿到文章
2. 在 **P2** 完成：点词打开词卡（本地词典优先）、讨论
3. 每一次关键动作会更新本地**词汇熟练度**（Memory V2 / FSRS）
4. 用户可在 **P3** 看到进度摘要，在 **P4** 回到历史文章

### 1.2 MVP 明确不做（Out of Scope）

| 延后项 | 原因 |
|---|---|
| 纯口语陪练 / StepAudio 实时语音 | 已永久下线；讨论区仅保留文字就文答疑 |
| 持久化后端 / 多用户账号 | 当前使用浏览器 localStorage / IndexedDB；尚未支持跨设备同步 |
| 内容安全过滤层 | 需产品/合规方案后再加 |
| 文章库 CEFR 精细分面检索 | 杂志库 + 本地 lemma 索引为主 |
| 孤立词卡刷题作为主复习路径 | 产品原则禁止；主路径改为「语境复习 → P2」 |

### 1.3 与产品文档的对齐关系

| 产品页面 | MVP 路由/屏幕 | 状态 |
|---|---|---|
| P1 文章获取 | `home` · HomeScreen | ✅ 三入口（粘贴 / 文库 / 推荐） |
| P2 文章学习 | `reading` · ReadingScreen | ✅ 点词词卡 / 讨论 |
| P3 学习报告 | `learning` · MyLearningScreen | ✅ 统计 + 针对性复习入口 |
| P4 文章历史库 | `history` · HistoryScreen | ✅ 列表回跳 P2 |
| 纯口语例外 | — | ❌ 永久下线 |

---

## 2. 设计原则（MVP 硬约束）

继承产品文档第 2 节，落地为实现约束：

1. **文章是核心实体**：所有学习行为绑定 `articleId`
2. **语境优先**：针对性复习优先生成/打开含到期词的文章会话，而不是默认跳孤立闪卡
3. **打分是副产品**：UI 不强调「刷分」；查词、讨论为主交互
4. **双轨分数**：`recognitionScore`（看懂）与 `productionScore`（用对）分开
5. **动作可追踪**：至少覆盖点击查词、曝光、加入复习、讨论提交（简化版事件日志）

---

## 3. 信息架构与页面流

```
                    ┌─────────────┐
                    │  P1 Home    │
                    │  文章获取    │
                    └──────┬──────┘
           ┌───────┬───────┼────────┐
           ▼       ▼       ▼        │
        粘贴文章  文章库  AI推荐     │
           │       │       │        │
           └───────┴───┬───┘        │
                       ▼            │
                 ┌──────────┐       │
                 │ P2 学习页 │◄──────┘
                 │ 正文+词卡 │
                 │ +讨论     │
                 └────┬─────┘
                      │ 返回 / 完成
         ┌────────────┼────────────┐
         ▼            ▼            ▼
      P1 Home      P3 报告      P4 历史
                      │            │
                      │ 针对性复习  │ 点选文章
                      └─────► P2 ◄─┘
```

### 3.1 P1 · 文章获取（HomeScreen）

| 入口 | 行为 |
|---|---|
| Enter Article | 打开粘贴/按话题生成 Modal → 写入文章列表 → 进 P2 |
| Pick from Library | 杂志库 / 我的文章 → 选文进 P2 |
| Recommend for Me | 推荐链路（Memory V2 + lemma 索引 + AI 回退）→ 进 P2 |

弱入口：右下角图标 → P3；顶栏可切 P3/P4（演示用，可隐藏）。

### 3.2 P2 · 文章学习（ReadingScreen）

| 能力 | MVP 实现 |
|---|---|
| 点词 / 拖选 | 直接打开 **WordCardPanel**（无浮动工具栏） |
| 词卡 | `intent: explain`；**单词语典优先**（ECDICT），短语/未命中走 AI |
| 翻译 | 词卡内 Translate → `intent: translate`（目标语默认中文） |
| 讨论区 | 就文答疑 + 苏格拉底式追问（`intent: discuss`）；**不**更新词汇熟练度 |
| 生词 | 查词写入学习事件；复习由 Memory V2 / due 列表驱动 |

### 3.3 P3 · 学习报告（MyLearningScreen）

- 展示：完成文章数、掌握词数、学习中词数、基于本地学习日计算的连续天数
- 薄弱点雷达：按近期结构化批改记录中 `weak_point` 的出现次数计算；无数据时显示真实空状态
- **Start Targeted Review** → 优先走「AI 推荐 + 嵌入到期词 → P2」，而非孤立词卡

### 3.4 P4 · 历史库（HistoryScreen）

- 列表：标题 / 摘要 / 日期 / 状态
- 点击 → 恢复该文章进入 P2

---

## 4. 前端现有资产映射

本 MVP **复用并收敛**仓库内已有 UI，不另起视觉体系。

| 文件 | 角色 |
|---|---|
| `src/components/HomeScreen.tsx` | P1 |
| `src/components/ReadingScreen.tsx` | P2 核心 |
| `src/components/MyLearningScreen.tsx` | P3 |
| `src/components/HistoryScreen.tsx` | P4 / 文章库 |
| `src/components/EnterArticleModal.tsx` | 粘贴文章 / 话题生成 |
| `src/components/WordCardPanel.tsx` | 独立词卡面板（词典优先 / AI 回退） |
| `src/lib/wordCard.ts` | 词卡请求规范化 + 拉取闭环 |
| `src/components/TargetedReviewModal.tsx` | 备用复习 UI（弱路径；主路径已改为语境复习） |
| `src/data/mockArticles.ts` | 文章库 + 初始到期词 |
| `server.ts` | 能力引擎：查词（词典优先）、翻译、推荐、讨论 |

视觉基调：暖纸色背景 `#F8F6F0`、衬线标题、强调色 `#C35E37`（陶土橙）。

---

## 5. 系统架构（MVP 切片）

```
┌─────────────────────────────────────────────┐
│ 交互层 (React SPA)                           │
│  P1 Home · P2 Reading · P3 Report · P4 Hist │
└──────────────────┬──────────────────────────┘
                   │ fetch JSON
┌──────────────────▼──────────────────────────┐
│ 能力引擎层 (Express + Step/Gemini)            │
│  explain (dict-first) · translate · recommend │
│  discuss · magazine sync                      │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│ 数据层 (localStorage + IndexedDB Memory V2)  │
│  articles · memory state · events            │
└─────────────────────────────────────────────┘
```

- **无独立 Agent 编排服务**：意图由用户点击入口隐式路由（点词=查词、底部输入=讨论、口语入口=口语评估）
- **API Key**：服务端 `GEMINI_API_KEY`；前端永不持有密钥
- **降级**：无 API / 网络失败时使用 mock 文案，保证演示可走完主路径

---

## 6. 词汇熟练度（FSRS-6 实时算法）

系统使用 `ts-fsrs@5.4.1` 的 FSRS-6 调度器。持久化的 `level`、
`recognitionScore`、`nextReviewDue` 仅作为兼容缓存；所有 UI、统计和到期判断
都通过 `getEffectiveProficiency(word, 当前时间)` 重新投影，不能直接信任缓存值。

### 6.1 等级

| Level | 含义 | 实时进入条件 |
|---|---|---|
| L0 | 尚未进入复习 | New 卡且未引入；被动曝光不足 3 次 |
| L1 | 生词 / 回忆失败 | 已引入但尚未正式复习，或最近一次评分为 Again |
| L2 | 学习中 | 有正向回忆证据且当前 FSRS retrievability ≥ 0.14 |
| L3 | 巩固中 | retrievability ≥ 0.6 且 production ≥ 0.3 |
| L4 | 掌握 | retrievability ≥ 0.8 且 production ≥ 0.7 |

### 6.2 动作 → FSRS 证据

| 动作 | FSRS Rating | production | 其它 |
|---|---|---|---|
| 点击查词 / 明确回忆失败 | Again | — | 进入或更新复习计划 |
| 文章被动曝光 | 不评分 | — | 第 3 次只引入一张到期 New 卡，不伪造成功回忆 |
| 加入复习列表 | 不评分 | — | 引入 New 卡并立即到期 |
| 正确主动产出 | Good | 增加 | 作为真实成功回忆 |
| 错误使用 | Again | -0.25 | 失败证据 |
| 明确回避目标词 | Again | -0.12 | 失败证据，但产出惩罚小于错误使用 |
| 手动标记掌握 | Easy | 至少 0.75 | 用户明确强正向证据 |

相同词、相同 Rating 在 10 秒内的重复事件只记录一次 FSRS review，防止双击或请求重试污染 `reps`、`lapses` 和 `stability`。

### 6.3 到期复习队列与历史完整性

到期时间直接读取有效 FSRS card 的 `due`，并与调用时的当前时间比较。
持久化 schema v2 保存完整 card、完整 review log、算法版本、实现版本、参数指纹，
并满足 `historyStartReps + reviews.length === card.reps`。旧数据没有明细日志时，
`historyStartReps` 明确标记迁移基线；从迁移完成后的每次真实复习都必须有日志。

---

## 7. 数据模型（MVP 字段）

### Article

```ts
{
  id: string
  title: string
  description: string
  date: string
  status: 'Completed' | 'In Progress'
  content: string[]          // 段落
  keyWords?: string[]
  source?: 'user_input' | 'library' | 'ai_generated' | 'oral_session'
  level?: string             // CEFR 可选
  embeddedReviewWords?: string[]
}
```

### WordProficiency

```ts
{
  lemma: string
  level: 0 | 1 | 2 | 3 | 4       // 兼容缓存，不作为实时判断依据
  recognitionScore: number       // 兼容缓存；实时值来自 FSRS R(t)
  productionScore: number        // 0–1
  lastReviewedAt: string         // ISO
  nextReviewDue: string          // 兼容缓存
  fsrs: {
    version: 2
    algorithm: 'FSRS-6'
    implementation: 'ts-fsrs@5.4.1'
    parametersId: string
    historyStartReps: number
    card: FsrsCardState
    reviews: FsrsReviewLog[]
  }
  // ... 展示用字段
}
```

### LearningEvent（内存日志，可选展示）

```ts
{
  id: string
  type: 'click' | 'exposure' | 'grammar_query' | 'discussion' | 'review_start'
  articleId?: string
  lemma?: string
  createdAt: string
}
```

---

## 8. API 契约（已有）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/explain-grammar` | 点词释义 + 语法 |
| POST | `/api/translate` | 选区翻译 |
| POST | `/api/recommend-article` | AI 推荐 / 按话题生成 |
| POST | `/api/chat` | 讨论区 |
| POST | `/api/oral-feedback` | 纯口语反馈 |

推荐接口 MVP 扩展请求体（可选字段，向后兼容）：

```json
{
  "topic": "Daily Life",
  "reviewWords": ["ephemeral", "ubiquitous"],
  "level": "B1"
}
```

---

## 9. 非功能（MVP 底线）

- **可演示**：无 API Key 时主路径不白屏（mock 回退）
- **单用户本地**：不声称数据持久或跨设备同步
- **响应式**：手机宽度可用（现有 bottom bar / 全屏 Modal 已适配）
- **可解释批改**：口语反馈返回自然语言说明，不给黑盒单一分数作为唯一输出

---

## 10. 成功标准（验收）

1. 粘贴一段英文 → 进入 P2 → 点词看到释义抽屉（有 key 用 AI，无 key 有降级）
2. 底部提问 → 讨论区出现 AI 回复
3. 加入复习词后，P3「学习中」数量增加
4. Recommend for Me / 针对性复习 → 进入带高亮词的文章
5. P4 点历史文章可回到 P2
6. Oral Practice 可不依赖文章完成一轮对话

---

## 11. 后续迭代建议（非本次）

1. 将 `learning_event_log` 持久化，并接完整 stability / R(t)
2. 口语结构化批改 JSON → 精确更新 production_score
3. 文章库按 CEFR × 主题分面；与历史会话分离
4. Agent 统一意图路由层（替代隐式入口路由）
5. 未成年人内容安全与隐私脱敏

---

## 12. 设计取舍（MVP）

| 决策 | 原因 |
|---|---|
| 复用现有 UI 而非重做 | 产品验证重点在闭环与原则，不在视觉重设计 |
| 熟练度放在前端内存 | 最快闭环；算法可原样迁后端 |
| 主复习路径改为进 P2 | 对齐「不复习孤立词卡」；闪卡 Modal 降为备用 |
| 继续用 Gemini 服务端 | 仓库已接好；换模型不阻塞 MVP 演示 |
| P4 与文章库暂共用列表 | ~~减少一个页面~~ → **P0 已拆分** library vs history |

---

## 13. P0 补齐记录（相对差距分析）

针对「项目 vs 产品文档」中的高优先级缺口，本轮已落地：

| 项 | 状态 | 实现要点 |
|---|---|---|
| 去掉假统计（+200） | ✅ | P3 使用 `bands.mastered / learning` 真实计数 |
| 去掉孤立词卡主路径 | ✅ | 移除 TargetedReviewModal 挂载；仅语境复习 → P2 |
| 文章库 ≠ 历史 | ✅ | `LibraryScreen` + CEFR 筛选；`HistoryScreen` 仅用户打开过的文章 |
| 结构化批改 → production | ✅ | `POST /api/assess-output`；`applyStructuredProduction`；用对加分、用错不给分并标记 due |
| 按文章进度（P3） | ✅ | `articleProgress` 汇总完成状态、查词/讨论次数，可点回 P2 |
| P3 真实学习统计 | ✅ | 全文段落达到可见时长后标记完成；连续天数、近 7 天事件、薄弱点频次均由持久化活动计算 |
| 会话最小恢复 | ✅ | `ArticleSession.chatMessages`；P4 提示可恢复讨论 |
| FSRS-6 实时熟练度 | ✅ | 当前时间投影 `R(t)`；schema v2；完整 review history 与迁移基线校验 |
| 浏览器持久化 | ✅ | localStorage 首屏校验与旧数据升级；写入失败不再静默 |

### 仍未做（P1+）

- IndexedDB / 后端持久化与跨设备同步（当前完整历史仍受 localStorage 配额限制）
- 统一 Agent 编排层
- 推荐文生词密度 95–98% 校验
- 真实 ASR
- 词形还原 lemmatizer
