# 日语文章与日中查词

导入文章时选择“日语”，打开文章后点击词语，即可查询日语词头的中文释义。词典设置中启用 **Wiktionary 日中词典**，也可以在 `/settings/dictionaries/try/ja` 粘贴日语短文或输入词语试查。词典不依赖翻译模型；整句翻译使用独立的本地翻译服务。

## 来源与覆盖

日中词典来源是 Kaikki 抽取的[中文维基词典“日语”分组](https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AF%AD/index.html)和[“日語”分组](https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AA%9E/index.html)。两个分组含不同词条，需要一起导入。**词条语言为日语，释义语言为中文**，释义与例句译文保留原文，可能同时包含简体和繁体。

当前安装快照抽取于 2026-10-02，上游 dump 日期为 2026-10-01。共导入 112,633 个词条记录、104,708 个不同词头，含 224,812 条词形关系、46,135 条读音查询关系。原始下载合计约 126 MB，SQLite 包约 302 MB。相同词头的不同词性或原文记录分别保留；这些数字不代表互不重复的义项数量。

假名读音来自 `sounds.other`、`forms.hiragana` 和 `forms.ruby`。读音中保留词典使用的长音符号，也保留注音提供的标准写法；如 `学校` 可显示 `がっこー` 与 `がっこう`。使用明确假名读音建立查询索引，归一化会处理半角片假名，不去除浊点或任意改写长音。词典缺少注音的词条仍可查询中文原文释义。

词形查询使用 `forms` 的明确变位表和 `senses.form_of`，异体写法使用明确的 `alternative` / `alt_of`。仅对词典中明确标记为礼貌形式的动词 `ます` 形式增加固定的 `ました`、`ません`、`ませんでした`、`ましょう` 索引。例如源表列出 `食べます` 后，可以查询 `食べました → 食べる`。不做任意删后缀猜词，关系保留词性约束，最多追踪五层。名词条目中的量词不是异体写法，例如 `電車` 条目列出的量词 `本` 不会使“本”查到“电车”。直接词头结果优先于读音和变体结果。

例子：`学校` → `學校`，`図書館` → `圖書館`，`本` → `書，書籍`，`読んで` → `読む / 閱讀`，`食べました` → `食べる / 吃`，`行きませんでした` → `行く / 去，前往`。词形、复合词及专业词覆盖取决于源词典；多义词和同音词保留多个结果，不自动做上下文消歧。

数据许可为 [CC BY-SA 4.0 / GFDL](https://zh.wiktionary.org/wiki/Wiktionary:%E7%89%88%E6%9D%83%E4%BF%A1%E6%81%AF)。包内包含来源、许可证链接、变更说明及 SHA-256。查询结果提供中文维基词典贡献者归属及原词条链接。

## 安装与重建

构建和读取 SQLite 需要 **Node 22.13+**。运行时按需加载服务器词典，数据库和读取代码不会进入浏览器包。缺失、损坏或不兼容的包明确显示不可用。

```powershell
New-Item -ItemType Directory -Force tmp/dictionaries | Out-Null
curl.exe --fail --location --output tmp/dictionaries/kaikki-japanese-zh-hans.jsonl 'https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AF%AD/kaikki.org-dictionary-%E6%97%A5%E8%AF%AD.jsonl'
curl.exe --fail --location --output tmp/dictionaries/kaikki-japanese-zh-hant.jsonl 'https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AA%9E/kaikki.org-dictionary-%E6%97%A5%E8%AA%9E.jsonl'
npm run dictionary:import-japanese -- --source tmp/dictionaries/kaikki-japanese-zh-hans.jsonl --source tmp/dictionaries/kaikki-japanese-zh-hant.jsonl
```

默认安装目录为 `data/dictionary/imported/wiktionary-ja-zh/`，包含 `dictionary.sqlite`、`manifest.json`、`LICENSE.txt`。可以设置 `DICTIONARY_JAPANESE_CHINESE_DIR` 指向其他目录。导入器拒绝覆盖现有数据库；更新时用 `--output` 构建到新目录，验证后改变配置并重启。启动时校验数据库大小、摘要和词条数。

Kaikki 按语言的后处理下载入口已标记为将废弃，下载不是固定发布版本。应保留实际快照及其清单。原始源摘要确定内容版本，适配器版本也参与目录和缓存版本；更改转换规则后必须重建包。

## 接口与分词

`japaneseLanguageAdapter` 使用 `Intl.Segmenter('ja', { granularity: 'word' })`，保留原文和 UTF-16 位置。英文 wink 模型不用于日语。ICU 有时把日语词形拆成较短片段，因此分词层会合并常见词尾和完整助动词序列，如 `食 / べ / ま / した → 食べました`、`行き / ま / せん / で / した → 行きませんでした`；助词和名词后的 `です` 等保留分界。分词是启发式边界处理，不宣布词形还原能力，词典才确认原形。遇到复杂句式可选中文本后查询。

服务器始终注册语言 `ja`，因此手动导入的日语 MDX 也能使用日语归一化；内置日中来源只在安装包存在时注册。公共词典 v1 契约不变，使用已有 `lookup`、`lookupMany`、`getEntry`、`listSources`：

```json
{"text":"食べました","language":"ja","dictionaryIds":["wiktionary-ja-zh"],"preferredDefinitionLanguages":["zh"]}
```

调用 `POST /api/dictionary/v1/lookup`。日语学习身份与原有英语学习身份分别按各自语言处理，原有英语词典顺序与默认来源保持既有设置。已保存词典设置优先于启动配置；新安装来源需要启用。
