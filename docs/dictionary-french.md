# 法语词典试读

打开 `/settings/dictionaries`，启用 **Wiktionary 法中词典**，点击该卡片的 **法语试读**。直达地址为 `/settings/dictionaries/try/fr`。试读支持点击示例文章、输入单词，也支持粘贴最多 12,000 字符的法语短文。中文释义来源默认优先；若同时启用原有英语释义来源，可以切换释义词典，每次只查询所选来源。

词库模块提供 `fr` 分词、查询、词典详情和明确的词形关系；本试读页不写入英语学习状态。文章翻译和朗读使用各自的服务，独立于词典的释义语言。法中词库用于法语词头查中文，不包含中文反查索引。

## 数据与安装

中文来源是 [Kaikki 中文维基词典的法语分组](https://kaikki.org/zhwiktionary/%E6%B3%95%E8%AF%AD/index.html)及[法語分组](https://kaikki.org/zhwiktionary/%E6%B3%95%E8%AA%9E/index.html)。两个分组包含不同词条，需要一起导入。**词条语言为法语，释义语言为中文**；释义与例句译文保留中文维基词典原文，可能包含简繁两种写法，不经过英语机翻。

原先的 [Kaikki French 英语释义数据](https://kaikki.org/dictionary/French/)保留为独立来源 `wiktionary-fr`；中文来源 ID 为 `wiktionary-fr-zh`。抽取字段采用 `forms`、`senses.form_of`、`sounds.ipa`、`senses.glosses` 和例句。纯词形条目进入关系索引，查询后返回已存在的原词条。

中文数据的明确词形关系优先使用；如果中文源未收录词面，且已安装英语版，可借用英语版**明确的词形关系**再查中文原词。例如中文包缺少 `chevaux` 关系时，使用 `chevaux → cheval` 的关系，再返回中文包的 `cheval`。保留词性约束、关系来源及依赖版本，不复制英语义项。英文来源可以禁用展示而继续提供关系；没有该依赖时中文包仍可独立精确查询及使用自身词形关系。需要借用的关系源读取失败会明确报错，不伪装成未收录。

文本采用 Wiktionary 的 CC BY-SA 4.0 / GFDL 许可；[中文维基词典](https://zh.wiktionary.org/)和[英文版版权页](https://en.wiktionary.org/wiki/Wiktionary:Copyrights)公开了授权。安装包包含来源、变更说明、许可证链接和数据摘要。每个结果提供对应版本的原 Wiktionary 词条链接及贡献者归属。

法语包的构建和读取使用 Node 自带 SQLite，需要 **Node 22.13+**，本机使用 Node 24。Node 20 的既有英语服务仍可运行；如果装了法语包但运行时没有 SQLite，该来源明确显示不可用，不会让英语服务启动失败。没有安装法语包的部署不加载任何法语数据。

下载 JSONL 文件后执行：

```powershell
# 两组中文释义数据都需要下载。
curl.exe --fail --location --output tmp/kaikki-french-zh-hans.jsonl 'https://kaikki.org/zhwiktionary/%E6%B3%95%E8%AF%AD/kaikki.org-dictionary-%E6%B3%95%E8%AF%AD.jsonl'
curl.exe --fail --location --output tmp/kaikki-french-zh-hant.jsonl 'https://kaikki.org/zhwiktionary/%E6%B3%95%E8%AA%9E/kaikki.org-dictionary-%E6%B3%95%E8%AA%9E.jsonl'
npm run dictionary:import-french -- --edition zh --source tmp/kaikki-french-zh-hans.jsonl --source tmp/kaikki-french-zh-hant.jsonl

# 可选：保留英语释义和额外明确词形关系。
curl.exe --fail --location --output tmp/kaikki-french.jsonl https://kaikki.org/dictionary/French/kaikki.org-dictionary-French.jsonl
npm run dictionary:import-french -- --source tmp/kaikki-french.jsonl
```

中文产物位于 `data/dictionary/imported/wiktionary-fr-zh/`，英语产物位于 `data/dictionary/imported/wiktionary-fr/`，含 `dictionary.sqlite`、`manifest.json`、`LICENSE.txt`，均属于可重建的本地外部数据。可分别设置 `DICTIONARY_FRENCH_CHINESE_DIR` 和 `DICTIONARY_FRENCH_DIR` 指向其他包目录。若目标目录已有词典，导入器拒绝覆盖；新快照可构建到新目录，再改变配置并重启服务。

导入器记录原始数据及 SQLite 文件的 SHA-256。来源加载时校验数据库摘要、大小和词条数；损坏、未完成安装等情况返回 `unavailable`。内容版本取决于下载快照的摘要，参与已有目录版本和缓存机制。Kaikki 的这个按语言后处理下载入口已被上游标记为未来将废弃，因此不要把它当成固定发布版本；更新数据时应保留实际下载快照及清单，后续可换用原始抽取数据，统一 v1 查询契约无需变化。

## 接口分工

- `packages/dictionary/languages/french.ts` 是独立 `LanguageAdapter`。它仅使用 winkNLP 的基础 tokenizer，关闭英语 POS、lemmatization 等分析管线；保留原文与 UTF-16 位置，按法语处理常见省音前缀，如 `l’homme` 的词汇部分 `homme`，保留 `aujourd’hui`。归一化保留重音，`été` 和 `ete` 不等价。
- `packages/dictionary/server/wiktionaryFrench.ts` 是独立 `DictionaryAdapter`。词形能力来自词典的明确关系，不写通用删后缀规则。保留关系所声明的词性，并沿明确关系最多追踪五层，如 `allés → allé → aller`；限制深度避免循环词形关系。一个表面词可能对应多个原词，单来源最多返回 40 个词条，未做上下文词性消歧。
- 服务注册一次语言 `fr`，分别注册已安装的来源 `wiktionary-fr` 和 `wiktionary-fr-zh`。已有 `lookup`、`lookupMany`、`getEntry`、`listSources` 均可直接使用；只会查询声明支持法语的已启用来源。核心公共契约没有修改。
- `DictionaryTrialScreen` 直接消费语言中立结果，并显示释义的语言标签，不经过英语展示兼容层，也不使用 ECDICT 补足法语信息。读库代码与 SQLite 数据不进入浏览器产物。

已有保存设置优先于启动配置，新增来源通常以禁用状态出现在列表中。启用法语来源后保持既有英语来源的启用状态、顺序和默认来源。

查询示例：

```json
{"text":"chevaux","language":"fr","dictionaryIds":["wiktionary-fr-zh"],"preferredDefinitionLanguages":["zh"]}
```

使用 `POST /api/dictionary/v1/lookup`，检查 `sources[].matches[].matchKind` 和 `entry.headword`。测试可从 `chevaux`、`mangent`、`allés`、`L’ÉCOLE` 开始；具体覆盖取决于安装快照。当前实验不承诺任意法语词、合成词、连字符结构或专业词汇都能识别。

## 导入书库与正式阅读

书库导入时选择“法语”，或从词典试读页点击“导入书库并阅读”。文章保存 `language: fr`，正式 `/read/…` 路由统一使用原有 `ReadingScreen`：相同正文排版、字号菜单、定位查词浮卡、完整词卡、选中翻译、全文与选中朗读，以及阅读位置保存。页面仅按语言选择分词器、查询接口、翻译源语言及朗读音色；不另建法语阅读布局。

法语词卡直接消费语言中立结果，按来源顺序展示各词典，不转成英语义项。法语查询及阅读不写入英语词汇复习记录，不触发英语 CEFR 编纂或英语复习测评。文章阅读进度仍正常保存。法语朗读安装与配置见 [朗读说明](tts.md)。
