# 词典批次编修工作流（dictionary.v2）

本文是 `dictionary.v2` 的冻结规范。所有词汇内容由模型**逐词手写**，脚本只做机械工作：
选词、读源、排序、哈希、校验、打包、回滚。规则集中在 `scripts/dictionary/spec.mjs`，
任何常量变更都属于一次规范的显式修订，必须同时改本文。

## 一、冻结的常量

| 项 | 值 | 说明 |
|---|---|---|
| `schemaVersion` | `dictionary.v2` | 每条记录、pack 头、报告都携带 |
| `contentVersion` | `dictionary-content.v2` | 编辑层内容版本，整批发布时递增 |
| `authoringMethod` | `model-manual` | 唯一允许发布的内容来源标记 |
| 批次大小 | 2000 | **发布单位**，不是工作单位 |
| 工作包大小 | 50 | 仅用于控制上下文与保存进度，不单独发布 |
| 词频方向 | ECDICT `frq` 升序 | 数值越小越常用；同频按字母升序 |
| 纯词形判定 | 中文含「过去式／过去分词／现在分词／第三人称单数／最高级／比较级／复数」且文本 < 40 字符 | 这类行只是入口，不是原形词 |
| 词形清洗 | 扔掉长度 < 2 的 `exchange` 值，并按 `标签:值` 去重 | 单字母（如 `p`）是 ECDICT 噪声，不是词形 |
| 允许的词性 | `n. v. adj. adv. prep. pron. conj. int. interj. modal. det. num. art. aux. phrase` | `modal.` 必须保留：`can`/`would` 是情态动词，硬塞进 `v.` 是错误描述 |

### 状态机

- 词条 `reviewStatus`：`draft` → `unreviewed` → `needs-review` → `reviewed`。
  **只有 `reviewed` 可以进入发布**；`draft` / `unreviewed` / `needs-review` 一律不得发布。
- 批次 `status`：`draft` → `authoring` → `reviewing` → `needs-human-review` → `approved` → `published`，异常时 `rolled-back`。
  **只有全部词条 `approved` 后才允许整批 `published`。**

### 内容来源标记

- `model-manual`：模型逐词手写。修订层默认值。
- `pack-import`：来自基础包（ECDICT + 包内增强区），未经过人工编修。
- `unknown`：无法确认。**不得推断为 `model-manual`**。

`server/dictionary/model.ts` 在字段缺失时按 `edit.source` 推导：含 `kind: 'manual'` 才判为
`model-manual`，否则为 `unknown`。程序不会把自动结果标记成人工内容。

## 二、目录结构

```text
data/dictionary/
  source/                      # 只读底稿（.gitignore）
    ecdict.csv  enhanced.jsonl  cefr.json  families.jsonl  extraction-manifest.json
  reports/                     # 质量报告与异常词表（.gitignore）
  build/                       # dictionary.pack 及其构建报告（.gitignore）
  revisions/                   # 编辑层，进版本库
    manifest.json              # 内容版本 + 批次索引
    curated-50.jsonl           # 样板 50 词（已 reviewed）
    revision-template.json     # 空白记录模板
    batches/
      batch-001/
        manifest.json          # 批次元数据与冻结哈希
        words.json             # 固定词表（含 rank / frequency）
        revisions.jsonl        # 模型写入目标，初始为空
        review-log.jsonl       # 双轮审核记录，初始为空
        quality-report.json    # 待处理问题列表
        change-report.json     # 本批次变更说明
        source-manifest.json   # 输入源快照与哈希
```

## 三、命令

```bash
# 阶段 0：冻结规范（幂等）
npm run dictionary:freeze

# 阶段 2：生成固定名单与空白审核框架
npm run dictionary:batch -- --batch batch-001 --size 2000

# 既有底座链路
npm run dictionary:extract     # 从 pack 提取只读底稿
npm run dictionary:report      # 生成质量报告与异常词表
npm run dictionary:sample       # 固定 50 词样板名单（无 --force 不重生）
npm run dictionary:sample-lock  # 阶段 1：按冻结契约复核并锁定 50 样板词（幂等）
npm run dictionary:validate     # 校验样板词结构
npm run dictionary:pack         # 重建基础包（临时文件 + 原子替换）
```

批次校验：

```bash
npm run dictionary:validate -- --batch batch-001                    # 校验冻结框架与记录契约
npm run dictionary:validate -- --batch batch-001 --require-publish-ready   # 发布门禁（未写完即失败）
```

编写前的源料简报（只读，逐词手写的第 1、2 步）：

```bash
node scripts/dictionary/source-brief.mjs --batch batch-001 --work work-001 --out tmp/dict-work/work-001.brief.md
```

简报汇总每个词的原形 ECDICT 行（definition / translation / pos / exchange / tag）、已有增强条目
和冻结名单里的 rank / 词频。**增强区含噪声必须甄别**，已发现的键碰撞包括：`me` → 美国缅因州（ME）、
`its` → 信息技术（IT）、`more` → 政治家 Thomas More。这类内容一律不采信，按规范记为不采用。

`--batch` 模式把结果写入 `batches/<id>/content-validation.json`；`--require-publish-ready` 让命令在内容
未完成时以非零码退出，可直接挂到发布流程里。

`dictionary:batch` 的参数：`--batch`（批次号，形如 `batch-001`）、`--size`（词数，默认 2000）、
`--force`（重生成已冻结名单）、`--created-at` / `SOURCE_DATE_EPOCH`（冻结时间戳，保证可复现）。
名单已存在且未加 `--force` 时命令**拒绝重写**。

## 四、选词规则（冻结）

1. 按原形归并，每个原形只保留一条规范源记录（词频最小者优先，同频时原形行优于纯词形行）。
2. 排除样板 50 词。
3. 排除 `curated-50.jsonl` 等已进入修订层的词。
4. 排除已发布批次（`status: published`）词表中的词。
5. 排除纯词形条目。
6. 仅接受 `/^[a-z]+$/` 且长度 ≥ 2 的原形。
7. 按 `frq` 升序、同频按字母升序排序。
8. 取前 N 个并**固定顺序**；名单生成后不得因内容编辑而重排。

后续批次不使用固定 offset：每次都重新排除已发布词，再按同一规则取下一批，避免批次漂移。

## 五、`dictionary:batch` 的边界

**只允许**：选词、读原始记录、生成来源快照、生成空白模板、生成待处理问题列表、写 manifest、固定词表哈希。
**不允许**：写释义、写例句、翻译、合并义项、标记审核通过。

产出中所有内容字段均为空：`revisions.jsonl` 与 `review-log.jsonl` 初始为 0 字节，
`quality-report.json` 只描述缺口（缺中/缺英、异常词性、串接释义、缺词频），不填补缺口。

硬性守卫（不满足即报错中止）：词数必须等于 `--size`、无重复原形、无样板词/已发布词混入、
无纯词形混入、重读源后重新选词得到的哈希必须与首次一致。

## 六、模型逐词手写的记录契约

每条写入 `revisions.jsonl` 的记录须满足 `revision-template.json` 的形状：

```jsonc
{
  "schemaVersion": "dictionary.v2",
  "query": "<被查询的拼写>",
  "lemma": "<原形>",
  "partOfSpeechGroups": [{
    "id": "<lemma>:<pos>", "partOfSpeech": "v.",
    "usageLabels": ["vi.", "vt."], "sortOrder": 0,
    "senses": [{
      "id": "<lemma>-v-1",
      "definitionEn": "…",              // 英文定义
      "definitionZh": "…",              // 对应中文解释（与英文逐义对应）
      "usageLabels": ["vi."], "sortOrder": 0,
      "examples": [{ "id": "…", "en": "…", "zh": "…" }],
      "collocations": [], "grammarNotes": [],
      "source": [{ "kind": "manual", "label": "curated-revision", "status": "confirmed" }],
      "reviewStatus": "draft"
    }]
  }],
  "phrases": [], "supplementaryChinese": [],
  "edit": {
    "source": [{ "kind": "manual", "label": "curated-revision", "status": "confirmed" }],
    "revisionVersion": "batch-001.v1",
    "authoringMethod": "model-manual",
    "reviewStatus": "draft",
    "changeNote": "<变更原因与依据>"
  }
}
```

编写原则：

- 常用义优先，但**不使用 CEFR 标签推断义项频率**。
- **不按中英文数组下标配对**；中英必须逐义对应。
- 仅当词性相同、英文定义完全相同且中文无冲突时才考虑合并。
- 中文冲突时保留候选（`definitionZhCandidates`），不强行合并。
- 无法对应的中文放入 `supplementaryChinese`，不伪装成某条英文释义的翻译。
- 原始内容缺失时保持缺失，**不凭空补全**。
- 阅读原句是「阅读原句」，**不得当作编纂例句**。
- 无法确认的内容标 `needs-review` 并记录问题，不猜测、不自行选择。

### 来源必须逐层记录

`edit.source` 只是整条记录的声明，**每个义项、每条例句、每条搭配也都要带 `source`**。
缺失时由记录自身的 `edit.source` 推导回填（机械操作，不是判断）。理由很直接：将来若某条释义
被替换或与其它来源合并，只有义项级来源才能说清它原来从哪来。样例 50 词在阶段 1 已补齐
127 个义项与 127 条例句的来源。

### 阶段 1 复核结论（已锁定的判据）

对 50 样板词的逐词复核确认了以下判据，后续 2,000 词沿用同一标准：

- 义项按词性分组（`v.` / `n.` / `adj.` / `adv.` / `modal.` …），组内按数组顺序即显示顺序。
- 每个义项必须有一条**只服务该义项**的例句；例句与释义不匹配即视为缺陷。
- 中英逐义对应，不靠数组下标配对。
- 一个词形入口（如 `went` → `go`）只保留真实词形，不显示虚构的词性义项。

阶段 1 实际修正了三处例句与义项不匹配：`set` 的「片场」义项与「一群人」义项被拆开、
`in` 的「一段时间之后」与「在……期间」被拆成两个义项、`take` 中属于「携带」义的例句被替换。
每处修正的原因都写进了该词的 `changeNote`。

## 七、阶段 4：双轮审核

编写完成不等于可以发布。每条词必须经过**两轮**审核，且两轮结果都记为 `approved`，
才允许变成 `reviewed`。

```bash
# 把某一轮某个工作包的审核结果写入审核日志（追加，按 轮次:词 去重）
node scripts/dictionary/review-log.mjs --round 1 --work work-023 \
  --file tmp/dict-review/round1-work-023.jsonl --reviewer agent:r1-a

# 按审核日志计算每条词的最终状态（先 --dry-run 看方案）
node scripts/dictionary/apply-review.mjs --batch batch-001 --dry-run
node scripts/dictionary/apply-review.mjs --batch batch-001
```

### 两种审核的分工

- **第一轮（编写检查）**：对照源料简报查——是否漏掉原始核心义、是否重复、是否错误合并、
  是否混淆词性、中英是否逐义对应、例句是否对应本义项、是否把词形当成独立义项、
  是否把阅读原句当编纂例句。
- **第二轮（独立复核）**：**新的审核上下文逐词复核，不依赖第一轮的判断**。职责是独立重新判断，
  不是复核第一轮的结论；与第一轮不一致时必须如实记录，不得折中、不得默认放行。

实操上两轮都派发独立子代理（各承担一个或多个工作包），第二轮**不把第一轮结果交给它**。

### 只允许三种结论

```text
approved | needs-revision | needs-human-review
```

- `approved` **不得携带任何 issue**——有问题的词不能判通过（工具会直接拒绝写入）。
- `needs-revision` / `needs-human-review` **必须至少给出一条 issue 说明理由**。
- 争议不猜测、不自动选择：记 `needs-human-review` 并保留候选。

### 晋级规则（`apply-review.mjs`，纯函数 `decideReviewOutcome`）

| 两轮结果 | 最终状态 |
|---|---|
| 两轮都 `approved` 且无遗留 `needs-review` 义项 | **`reviewed`（可进入发布）** |
| 任一轮 `needs-human-review` | `needs-review` |
| 任一轮 `needs-revision` | `draft`（退回修改） |
| 只记录了一轮 | `draft`（**不晋级**） |
| 两轮都通过但仍有义项标 `needs-review` | `needs-review` |

该函数已被单元测试锁定，规则改动必然导致测试失败。

### 审核记录格式

`batches/<id>/review-log.jsonl`，一行一条 `(词, 轮次)`：

```json
{"format":"dictionary-review.v1","batchId":"batch-001","round":1,"lemma":"will",
 "result":"approved","issues":[],"reviewer":"agent:r1-a","reviewedAt":"..."}
```

issue 的 `code` 取自固定词表：`missing-core-sense`、`duplicate-sense`、`wrong-merge`、
`pos-confusion`、`en-zh-mismatch`、`example-mismatch`、`example-missing-headword`、
`word-form-as-sense`、`reading-sentence-misuse`、`source-sense-dropped`、`other`。
`detail` 写清具体位置与理由，不允许空。

## 八、批次校验口径
`ok` 表示**冻结框架成立**；`publishReady` 表示**内容足以发布**。二者刻意分开：
空批次（`revisions.jsonl` 为 0 字节）应当是 `ok: true` 且 `publishReady: false`，
否则说明校验器本身写错了。

机器可判定的检查项：

| 类别 | 检查 |
|---|---|
| 框架 | manifest 的 schemaVersion / contentVersion / status / authoringMethod 合法 |
| 框架 | `words.json` 词数等于 `batchSize`、无重复、全是合法原形 |
| 框架 | 重算词表哈希必须等于 manifest 的 `wordListHash`（名单不许漂移） |
| 框架 | 批次已登记进 `revisions/manifest.json` 且哈希一致 |
| 记录 | 每条 revision 的 `lemma` 属于本批次；无重复原形 |
| 来源 | `edit.authoringMethod === model-manual`、`edit.source` 非空、`changeNote` 非空 |
| 义项 | 每个词性组词性合法、至少一个义项；义项英文定义非空、非串接（≤240 字符） |
| 义项 | 同词性组内无重复义项；义项必须带 `source` |
| 中英 | 每个义项有中文对应，或显式标 `needs-review`（不允许静默缺中文） |
| 例句 | 每个义项至少一条**双语**例句；例句不得处于 `draft`/`unreviewed` |
| 发布 | 批次为 `published` 时，不许存在缺失 revision 或非 `reviewed` 的记录 |

**无法机器判定、必须人工复核的**（校验器在 `warnings` 中提醒）：

- 原始英文释义是被保留还是被显式合并；中文有无被静默删除。
- 每条合并是否记录了合并原因。
- 例句是否只服务于其所属义项；「阅读原句」是否被误当作编纂例句。
- 词形关系（`went` → `go`、`saw` → `see`）是否正确。
- 义项取舍是否合理（常用义是否齐全、是否有该拆未拆或该并未并）。

这类问题一律走阶段 4 的第二轮独立复核，不靠脚本兜底。

### 逐词手写检查清单（来自实际编写踩坑）

每写完一个工作包、组装 `revisions.jsonl` 之前必须过一遍：

1. **JSON 引号**：中文释义、语法说明里**不能出现裸的 ASCII 双引号**（如 `表示"用品"时`），
   会直接截断 JSON。改用中文引号 `‘ ’` 或 `「」`。每次组装前先跑一次 `JSON.parse` 全量校验。
2. **`edit.source` 必须是数组**：`[{...}]`，不是单个对象。义项、例句、搭配各自的 `source` 也是数组。
3. **文件必须以换行结尾**：单文件缺尾换行无害，但拼接时会把上一条记录与下一条**粘成一行**，
   产出损坏的 JSONL。`check-part` 已强制校验此项。
4. **追加而非覆盖**：新工作包 `cat >>` 到 `revisions.jsonl`，不能覆盖已有内容。
5. **顺序对齐**：写入后必须验证 lemma 序列等于冻结名单的前 N 项（有自动化测试兜底）。
6. **进度一致**：同步更新批次 manifest 与 `revisions/manifest.json` 的 `revisionCount`，
   否则校验报告与实际情况不符。
7. **增强区甄别**：增强条目可能是 key 碰撞（同形异义词）。已确认的碰撞见下一节，一律不采信。
8. **组装后必须做质量抽检**：契约校验只查结构，**查不出编辑质量问题**。见下一节。

### 并行编写（提高吞吐的正式做法）

单次输出无法承载上千词。提高吞吐的唯一正确做法是**并行派发子代理，每个代理独立承担一个
50 词工作包**，各有独立上下文与输出预算；主代理只负责组装与校验。步骤：

1. 把规范写成子代理共用作业书 `tmp/dict-work/AUTHORING_BRIEF.md`（契约形状、编辑规则、
   已踩的坑、自检命令）。**不要**让每个代理各自理解标准，否则必然漂移。
2. 每个代理：`source-brief.mjs --work work-0NN` → 读简报 → 写 `tmp/dict-work/work-0NN.part.jsonl`
   → 跑 `check-part.mjs` 直到 `ok: true`。
3. 主代理逐个独立复跑 `check-part`（**不采信代理自述**），再按序组装。
4. 组装后必须抽检编辑质量，见下。

### 组装后的质量抽检（必做）

`check-part` / `validate` 只能证明结构合规。以下检查用于发现编辑缺陷，实测在 1,100 词中
查出 3 处真实缺陷：

- **跨词重复释义/例句**：完全相同的 `definitionEn` 或例句出现在不同词条上。
  同族词（may/might、other/another）共享措辞属正常，需要人工判断，不能一律当缺陷。
- **例句不含词头**：例句里找不到词头或其屈折形式。**注意大量误报**——不规则动词
  （thought / came / gave / held / sang）本来就不含词根，必须人工过一遍。
- **词性、释义、例句三者一致性**：本项目实际查出 `including` 被标为 `prep.`、释义却按动词写、
  例句用的是 "includes"。这类"三者不一致"契约校验查不到。

结论：**机械校验通过 ≠ 编辑质量达标**。质量抽检与阶段 4 的双轮复核不能省。

### 增强区已知键碰撞（不采信）

| 词 | 增强区误报 | 性质 |
|---|---|---|
| `me` | 美国缅因州 | ME 缩写碰撞 |
| `its` | 信息技术 | IT 缩写碰撞 |
| `more` | 政治家 Thomas More | 姓氏碰撞 |
| `man` | 城域网 / 手册 | MAN 缩写碰撞 |
| `tell` | 瑞士英雄 William Tell | 姓氏碰撞 |
| `us` | 美国 / 尿嘧啶 / 铀 / 字母 U | US 缩写碰撞 |
| `down` | Down 医生（唐氏综合征） | 姓氏碰撞 |
| `may` | 五月 | 同形专有名词 |
| `last` | 重量、容量单位 | 古旧单位 |
| `keep` / `let` | 城堡主塔 / 网球重发 | 同形异义词 |
| `ms` | 美国微软公司 | MS 缩写碰撞 |
| `begin` | 以色列政治家 Begin | 姓氏碰撞 |
| `truth` / `rock` / `stone` / `wood` | 人名传记（Sojourner Truth、John Rock 等） | 姓氏碰撞 |
| `am` | 镅元素 / 文学硕士 / 调幅 | AM 缩写碰撞 |
| `white` / `real` / `best` / `low` / `guy` | 同形人名姓氏 | 姓氏碰撞 |

遇到这类情况：**不发布该义项**，并在 `changeNote` 里写明未采用及原因。

## 九、发布前必须同时满足

**内容**：2,000 词逐词手写；未使用外部批量生成或翻译；每个已发布义项经过第二轮独立复核；
核心义项有双语例句；有争议内容未被强行发布。

**数据**：索引覆盖量不下降；原始内容全部可追溯（保留／合并／补充／待审核）；无静默丢失；
无数组下标配对；未跨词性错误合并；词形关系正确。

**工程**：重复构建结果一致；构建失败不破坏旧词包；可回滚；旧 API 字段继续可用；
网页、阅读查词、扩展共用同一转换规则；全量测试与生产构建通过。

## 十、风险与应对

| 风险 | 应对 |
|---|---|
| 2,000 词标准漂移 | 规则集中在 `spec.mjs`；先锁 50 词样板；每个工作包引用同一标准 |
| 长上下文漏词或重复 | 2,000 词作为发布批次，内部按 50 词工作包保存进度 |
| 多义词判断不确定 | 保留候选，标 `needs-review`，不强行合并 |
| 自动整理被误当最终内容 | 脚本只校验，不拥有内容写入权限；`revisions.jsonl` 初始为空 |
| 例句与义项不匹配 | 每个义项单独审核例句 |
| 构建覆盖旧包 | 临时文件 → 哈希校验 → 原子替换 |
| 原始来源不清 | 标记 `unknown`，不推测编辑历史 |
| 批次名单漂移 | 固定 manifest 与词表哈希，不使用动态 offset |
