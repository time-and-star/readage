# 内置词典统一底座

本项目的运行词典由独立的 `native-reviewed` 和 `ecdict` 两个来源提供，自编已审核内容优先。通用接口、版本、启动配置和扩展方式见 [通用词典接口 v1](dictionary-interface-v1.md)。此阶段不导入 Oxford 文件；基础包仍以 `vendor/nextword-local-dictionary/data/dictionary.pack` 为输入，包中丢失的编辑历史不推断为人工来源。

## 可重复构建

```text
npm run dictionary:extract
npm run dictionary:report
npm run dictionary:sample
npm run dictionary:validate
npm run dictionary:pack
```

`dictionary:extract` 将 pack 的 records 区原样写入 `data/dictionary/source/ecdict.csv`，并提取增强区、CEFR、词族和 `extraction-manifest.json`。这些文件是只读底稿，由 `.gitignore` 排除，不应手工修订。

`dictionary:report` 输出 `data/dictionary/reports/quality-report.json` 及各异常词表，覆盖缺失中英文、重复定义、异常词性、串接释义、无法确认中英对应和词形异常。

`dictionary:pack` 只重建基础包，修订不会写回原始记录；它使用临时文件和完成后替换，构建中断不会覆盖已有目标包。构建报告会记录输入文件校验值、输出校验值、版本和“修订独立存储”的变更说明。相同输入会得到相同 pack 校验值。

## 修订模型

`data/dictionary/revisions/curated-50.jsonl` 是独立的已审核数据源，运行时自行建立索引，基础包缺失时仍可直接查询。通用查询分别返回各来源，旧英语展示的兼容层采用优先词条，并记录从基础包补充的音标、词形等字段来源。`server/dictionary/model.ts` 保留 canonical 模型的转发入口。词条以词性组、义项、例句、搭配、短语和编辑信息为中心；无法确认的中文不伪装成某条英文释义的翻译。

`data/dictionary/sample-words.json` 固定 50 词名单：十个指定词加上按有效词频升序、同频按字母排序选出的 40 个原形词。没有 `--force` 时不会重新生成已固定名单。

ReadAge 自编词典目前只加载这 50 个已审核词条，审核中的批次不参与查询。开启词典只启用已安装内容，不会扩充覆盖范围；例如 `see` 已收录，字母 `C` 和 `sea` 尚未收录。来源目录用可选的 `entryCount` 和 `description` 显示实际覆盖范围；查词响应的 `dictionarySourceMisses` 说明已启用来源未收录此词，与 `dictionarySourceIssues` 的读取故障分开，正常未命中仍可缓存。

## API 与缓存

`POST /api/dictionary/lookup` 和原有批量请求保持不变，响应新增 `version`、`schemaVersion`，每个结果新增 canonical 的词性组、义项、短语和编辑信息；已有字段继续由同一模型派生。

搜索、阅读查词和扩展共用 `toDictionaryWordCard`。卡片按配置顺序分别展示所有命中的词典，每家默认每个词性组显示两个义项，可展开全部；阅读句子使用“阅读原句”标签，不计入编纂例句。网页词卡缓存使用 `v6`，扩展词典缓存使用 `dictionary-cache.v2`，按协议、语言、来源配置和内容版本隔离，目录校验有效期 60 秒。学习身份使用独立的 `LearningTermRef`；既有学习记录、存储键和复习状态不迁移。

