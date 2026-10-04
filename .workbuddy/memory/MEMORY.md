# 项目长期约定：内置词典

## 版本与规范
- 数据模型 `dictionary.v2`；编辑层内容版本 `dictionary-content.v2`。
- 规则**单一来源**：`scripts/dictionary/spec.mjs`。任何常量变更必须同步改
  `docs/dictionary-batch-workflow.md`，不允许在别的脚本里另起一套判定。
- 权威规范文档：`docs/dictionary-batch-workflow.md`。

## 内容边界（不可逾越）
- 词典内容**只能由模型逐词手写**；脚本永不写释义、例句、翻译，也不合并义项或标记 reviewed。
- 禁止调用在线词典/翻译/批量生成 API；禁止模板批量替换；禁止按文本相似度自动合并义项；
  禁止把程序规范化结果直接标为已审核；禁止把无法确认的内容猜成可靠释义。
- 无法确认 → 标 `needs-review` 并保留候选，不猜测、不强行合并。
- 阅读原句 ≠ 编纂例句，不得混用。
- 来源必须**逐层记录**：`edit.source` + 每个义项/例句/搭配各自的 `source`（缺失时由 edit.source 推导回填）。

## 内容判据（阶段 1 已锁定）
- 义项按词性分组；**数组顺序 = 显示顺序**，`sortOrder` 只是它的镜像（不要按 sortOrder 重排数组）。
- 每个义项必须有一条**只服务该义项**的例句；例句与释义不匹配即缺陷。
- 允许词性含 `modal.`：can/would/must 是情态动词，不许塞进 `v.`。
- 词形清洗：丢 `exchange` 中长度 < 2 的值（单字母是 ECDICT 噪声），按 `标签:值` 去重；
  统一走 `model.ts` 的 `cleanWordForms`。

## 逐词手写检查清单（每次组装 revisions.jsonl 前必过）
1. **中文串里禁用裸 ASCII 双引号**（会截断 JSON），改用 `‘ ’` / `「」`；组装前先全量 `JSON.parse`。
2. `edit.source` 必须是**数组** `[{...}]`；义项/例句/搭配的 `source` 同样是数组。
3. **part 文件必须以换行结尾**：缺尾换行会让 `cat a >> b` 把两条记录粘成一行，静默损坏 JSONL。
   `check-part.mjs` 已强制校验。组装用 node 脚本，不要依赖 `cat` 的隐式行为。
4. 新工作包 **追加**，绝不覆盖 `revisions.jsonl`。
5. 写入后验证 lemma 序列 == 冻结名单前 N 项（`tests/dictionaryAuthoring.test.ts` 兜底）。
6. 同步批次 manifest 与 `revisions/manifest.json` 的 `revisionCount`。
7. 阶段 3 一律写 `reviewStatus: "draft"`；`reviewed` 是阶段 4 双轮审核的产物。

## 提高吞吐：并行子代理（一次 1,000 词的正式做法）
单条回复只能承载约 50 词。要一次推进上千词，必须**并行派发子代理，每个承担一个 50 词包**，
主代理只组装与校验：
- 共用作业书 `tmp/dict-work/AUTHORING_BRIEF.md`（契约形状、编辑规则、坑、自检命令，
  末尾含「多包模式」一节）——**绝不让各代理各自理解标准**，否则必然漂移。
- 每包产出 `tmp/dict-work/work-0NN.part.jsonl`，用 `check-part.mjs` 自检到 `ok: true`。
- 主代理**独立复跑 `check-part`，不采信代理自述**，再按序组装。
- 代理可能遗留临时生成脚本（`_gen0*.cjs` 等），组装前清理。
- 实测：一个代理可承担 10 个包（500 词）；批次总量只有 2,000 词，**"一次 5,000" 在当前批次没有对象**。

## 当前批次状态（2026-09-18）
- `batch-001`：**2,000 / 2,000 已编写**，5,768 义项，顺序与冻结名单完全一致。
- **阶段 4 第一轮**：2,000 词全覆盖（1974 approved / 25 needs-revision / 1 needs-human-review）。
- **阶段 4 第二轮**：1,450 词（work-001…029）。`apply-review` 已晋级 **1,419 词 → `reviewed`**。
- 批次状态 `reviewing`，`publishReady: false`。剩 550 词缺第二轮 + 18 词旧裁决待重判。
- 阶段 5 门禁：`dictionary:validate -- --batch batch-001 --require-publish-ready`。
- `batch-002` 名单须待 batch-001 发布后生成（方案要求排除已发布词）。

## 源文照搬检测（新增门禁，必用）
```bash
node scripts/dictionary/check-source-copy.mjs --batch batch-001 [--package work-031]
node scripts/dictionary/apply-rewrites.mjs --file <fixes.jsonl> --check   # 应用前自检
```
- **必须同时索引 ECDICT `definition` 列与增强区 `enhanced.jsonl`**——只索引一个会漏掉一半
  （实测：只索引 ECDICT 时以为是 0，补上增强区后又冒出 28 处）。
- 实测规模：2,000 词里 **601 个义项（10.4%）是源文照搬**，且**成簇分布在 work-030…033**
  （wave-b 的生成脚本直接拼源定义）。已全部改写，现为 0.0%。
- 判定分级：tier1 = ≥40 字符或含 `;`/`()`（铁定照搬）；tier2 = 25–39 字符（可能巧合，需人判）。
- **分号常掩盖"错误合并"**：`wake-n-1 :: 船只尾迹; 守灵`、`fix-v-1 :: 固定; 修理` 都是两个义项被粘成一个。

## 反复踩到的同一类坑：断言会随阶段推进而过时
`tests/dictionaryBatch.test.ts` 已被迫改过两次：
1. 阶段 2 写的"revisions.jsonl 必须为空、revisionCount=0" → 阶段 3 内容进来后失效。
2. 阶段 3 写的"review-log.jsonl 必须为空" → 阶段 4 审核日志进来后失效。
`tests/dictionaryAuthoring.test.ts` 第三次同类：阶段 3 写的"未批准前不得有 reviewed 记录"
→ 阶段 4 晋级后失效，已改写为"任何 reviewed 记录都必须在审核日志里有两轮 approved"。
**处理方式固定为：改写断言以保留并强化原意，绝不直接删掉断言。**

## 阶段 4 工具与治理规则（已建成）
```bash
node scripts/dictionary/review-log.mjs --round 1 --work work-023 \
  --file tmp/dict-review/round1-work-023.jsonl --reviewer agent:r1-a   # 加 --check 只校验不写盘
node scripts/dictionary/apply-review.mjs --batch batch-001 --dry-run
node scripts/dictionary/show-package.mjs --batch batch-001 --work work-023 --out <file>
```
- **晋级规则（纯函数 `decideReviewOutcome`，已被测试锁定）**：两轮都 `approved` 且无遗留
  `needs-review` 义项 → `reviewed`；任一轮 `needs-human-review` → `needs-review`；
  任一轮 `needs-revision` → `draft`；**只记一轮 → 不晋级**。
- 审核硬规则：`approved` 不得携带 issue；`needs-*` 必须至少一条 issue 且 `detail` 非空；
  issue code 限固定词表。审核者产出必须由主代理**独立复跑 `--check`**，不采信自述。

## 实测：同一编写会话的缺陷是成簇的
第一轮 1,500 词查出 18 处：其中 **5 处"定义缺所有格 's"全部集中在 work-011 一个包**
（hair/condition/husband/medical/involve），另有 1 处编造义项（congress-n-3）。
教训：**按"包"抽样比按"词"抽样更容易发现系统性缺陷**——同一代理的产出质量相关。

这 18 处已全部修完（共改 20 处，含 2 处 WordNet 式措辞改写）。处理原则：
**编造义项直接删除而不是修补**——规范红线是"不凭空补全"，留着再改措辞等于承认它存在。

## 反复踩到的同一类坑：断言会随阶段推进而过时
`tests/dictionaryBatch.test.ts` 已被迫改过两次：
1. 阶段 2 写的"revisions.jsonl 必须为空、revisionCount=0" → 阶段 3 内容进来后失效。
2. 阶段 3 写的"review-log.jsonl 必须为空" → 阶段 4 审核日志进来后失效。
**处理方式固定为：改写断言以保留原意（"工具不写内容"），绝不直接删掉断言。**
写"当前处于某个空状态"的断言时要意识到它只是一个阶段的快照。

## 质量抽检实测结论（2,000 词，累计 4 处真缺陷，约 0.2%）
- 跨词重复释义/例句：**绝大多数是合理同族/同义词对**（may/might、vision/sight、song/sing），
  需人工判断，不要一律当缺陷。
- 例句不含词头：**83/84 是不规则动词与不规则复数的误报**（held/feet/lit/caught/teeth），
  必须人工过；真缺陷形如 `government`、`intelligence` 的"例句里根本没有词头"。
- 单词义词（259 个）抽样 26 个全部合理，属窄义词，**不是编写不足**。

## 增强区（enhanced）不可信
key 碰撞会把无关同形词当成释义，已确认：`me`(Maine) `its`(IT) `more`(Thomas More) `man`(MAN)
`tell`(William Tell) `us`(US/尿嘧啶/铀/U) `down`(Down 医生) `may`(五月) `last`(古单位) `keep`/`let`(同形异义)。
一律不采信，并在 `changeNote` 写明未采用及原因。

## 来源标记
- `authoringMethod`：`model-manual`（唯一可发布）/ `pack-import`（基础包）/ `unknown`（不推测）。
- 缺失时由 `edit.source` 推导：含 `kind:'manual'` 才判 `model-manual`。
- `reviewStatus` 必须是 `reviewed` 才可发布；批次 `status` 必须 `approved` 才可 `published`。

## 选词规则（冻结）
- ECDICT `frq` 升序（越小越常用），同频按字母升序；排除样板词、已发布词、纯词形条目；
  只接受 `/^[a-z]+$/` 且长度 ≥ 2 的原形。
- 2,000 是**发布单位**，50 是**内部工作包**。批次发布后不使用固定 offset 选下一批，
  而是重新排除已发布词后再取，避免批次漂移。

## 常用命令
```bash
npm run dictionary:freeze    # 阶段0：冻结规范（幂等）
npm run dictionary:sample-lock   # 阶段1：复核并锁定 50 样板词（幂等，不合契约不写盘）
npm run dictionary:batch -- --batch batch-001 --size 2000
npm run dictionary:validate -- --batch batch-001   # 批次校验
npm run dictionary:validate -- --batch batch-001 --require-publish-ready  # 发布门禁
npm run dictionary:extract | report | sample | pack
```
- `generate-batch.mjs`：名单已存在且无 `--force` 时拒绝重写；`SOURCE_DATE_EPOCH` 可冻结时间戳。
- 构建/写入一律走 `pack.mjs` 的 `writeFileSafely` / `writeJsonSafely`（临时文件 + 原子替换）。
- 脚本若需被测试 import，必须加入口守卫
  （`import.meta.url === pathToFileURL(process.argv[1]).href`），否则 import 会直接执行 CLI。

## 校验语义（重要）
- `ok` = 冻结框架成立；`publishReady` = 内容足以发布。**两者刻意分开**：
  空批次必须 `ok: true` + `publishReady: false`。
- 不可机器判定的项（原始释义是否被保留/显式合并、中文有无静默删除、合并原因、
  例句是否只服务本义项、阅读原句误用、词形关系、义项取舍）一律走人工第二轮复核，
  校验器只在 `warnings` 中提醒，不假装能判。

## 测试
- `tests/dictionaryBatch.test.ts` 锁定 batch-001 完整性与选词规则确定性。
- 验收口径：全量测试 + `tsc --noEmit` + `check:extension` 均需通过。
