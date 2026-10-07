# WordNet 3.1 第三方词典接入

来源为 Princeton 官方离线 WordNet 3.1：

- [官方数据包下载](https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz)
- [官方文件格式说明](https://wordnet.princeton.edu/documentation/wndb5wn)
- [许可说明](https://wordnet.princeton.edu/license-and-commercial-use)
- 实际 3.1 版权及许可副本：`vendor/wordnet/LICENSE.txt`。下载包中每个索引、数据文件也保留原始许可头。

此来源提供英文定义、词性、义项及部分例句，没有中文译文或音标。它是英语词汇语义数据库，适合验证外部结构化数据接入；不包含商业学习词典的全部教学内容。

## 安装与启用

```powershell
npm run dictionary:import-wordnet
```

已有官方压缩包时可离线导入：

```powershell
npm run dictionary:import-wordnet -- --archive tmp/wn3.1.dict.tar.gz
```

脚本校验固定 SHA-256，只提取四组 `index.*` / `data.*` 数据，保留许可并生成清单。压缩包中的其他文件和路径不会执行或作为输出路径。数据存放于忽略版本控制的 `data/dictionary/imported/wordnet-3.1`；可在其他机器重新下载，不把完整词库打进网页或扩展。

已验证快照：147,478 个独立词头、207,235 个按词头索引的义项引用。一个同义词集可被多个词头引用，该义项引用数不等同于独立同义词集数。下载包 SHA-256 为 `3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a`。

导入后重启服务，应用会自动发现默认目录中的清单并把 WordNet 列为已安装来源，无需设置环境变量。进入“数据 / 学习概况 → 设置与工具 → 词典设置”（`/settings/dictionaries`），可启用 WordNet、调整排列顺序和指定默认来源。点击“保存设置”后立即用于后续查词，选择存入 `local-data/dictionary/settings.json`，重启后保留；`DICTIONARY_SETTINGS_FILE` 可调整保存位置。

首次启动尚未保存词典偏好时，已安装 WordNet 默认启用并排在自编词典、ECDICT 后面。若已经保存过选择，再导入的新来源会追加到列表并保持停用，请在词典设置中启用并保存。调整显示来源不会改动已确认的学习 ID 或复习状态。

自定义数据路径和首次启动偏好可以使用环境变量：

```dotenv
DICTIONARY_WORDNET_DIR=data/dictionary/imported/wordnet-3.1
DICTIONARY_SOURCES=native-reviewed,ecdict,wordnet
DICTIONARY_SOURCE_ORDER=native-reviewed,ecdict,wordnet
DICTIONARY_DEFAULT_SOURCE=native-reviewed
```

试用外部词典优先时，在词典设置中把 WordNet 上移；默认来源可以单独指定。上面的启用、顺序和默认来源变量只提供启动偏好，已保存配置优先。`DICTIONARY_WORDNET_DIR` 明确配置的路径优先于自动发现；未发现默认目录且未指定路径时只注册原有来源。指定路径缺失或数据校验失败时，WordNet 仍列为已安装但暂不可用，其他词典继续查询。

设置保存 API 为 `GET` / `PUT /api/dictionary/v1/settings`，`PUT` 需携带读取时的 `expectedRevision`；冲突时重新加载再保存。它只管理来源选择；页面另提供 [MDX 文件导入](dictionary-mdx.md)，与 WordNet 官方离线包的安装流程分离。完整字段、错误状态和配置优先级见 [通用接口文档](dictionary-interface-v1.md#词典设置与保存)。

## 查询与边界

```ts
await client.lookup({ text: 'bank', language: 'en', dictionaryIds: ['wordnet'] });
await client.getEntry({ dictionaryId: 'wordnet', entryId: 'ice cream' });
```

`WordNetAdapter` 只实现公共 `DictionaryAdapter`，没有旧英语记录扩展。只需注册即可使用 v1 接口；通用英语兼容转换允许现有词卡直接消费此类结构化词条。所有命中来源通过兼容字段 `dictionarySources` 按配置顺序传给页面，阅读小弹窗、完整详情和扩展均分段显示每家词典。优先级决定先后次序，不能隐藏后面的来源。展示层显示词典名称、英文释义和原词典例句，不把缺少中文译文标成编纂待审核，也不把第三方内容标成已通过本应用审核。

每个来源区块的义项及例句独立，不与其他词典的义项拼接。兼容响应的顶层仍保留首个来源的旧格式字段，供既有教学、导出和简释消费者使用；同一词头缺少音标、词形等字段时可在这些顶层字段补充 ECDICT 信息，逐字段记录来源。`dictionarySources` 内各家记录保持原始独立内容。词头不同时不补充，避免将 `run` 的音标显示在 WordNet 的独立 `running` 词条上。

学习身份继续独立解析：WordNet 展示 `running` 自身的名词/形容词义项时，现有英语学习标识仍是 `run`，不会重写已有复习状态。WordNet 不自行猜测词干；英语语言处理器与已有已确认词形关系承担候选生成。

内容版本包含清单摘要，清单记录每个数据文件的字节数和 SHA-256；初始化逐文件验证。替换词库文件需要重启，调整已安装来源的启用和顺序可直接保存生效。来源配置变化更新目录版本与展示缓存键，学习存储键保持不变。词条缓存上限为 500，取消、批量顺序、故障状态及浏览器边界沿用 v1 核心。

`tests/wordnetAdapter.test.ts` 使用小型格式夹具进行常规验证；本机存在真实导入包时另执行官方数据与学习标识集成测试。缺少包只跳过该真实数据测试，其余测试无需网络。
