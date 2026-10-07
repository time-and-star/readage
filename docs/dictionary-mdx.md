# 浏览器 MDX 词典导入

从“数据 / 学习概况 → 设置与工具 → 词典设置”进入 `/settings/dictionaries`，点击“导入词典”选择本机 `.mdx` 文件，再点击“导入”。语言默认 `en`，可在“语言与名称”中指定词头语言和展示名称；未填写名称时读取文件内标题或文件名。文件发送到当前应用服务，保存于服务所在设备，不加载到网页或扩展产物中。

导入成功即成为独立词典来源，默认启用、排在当前顺序末尾，原默认词典保持不变。无需重启即可查询，安装与选择重启后保留。相同文件内容和语言按 SHA-256 去重，再次导入返回已有来源，保留已有名称与启用选择；同一文件指定不同语言会返回无效请求。来源卡片可拖动排序，拖动手柄支持上下方向键；排序松手、启停和默认来源调整均自动保存并生效，失败时提供重试，发生其他窗口的修订冲突时要求重新加载。

## 支持范围与限制

| 项目 | 当前范围 |
| --- | --- |
| MDX 版本 | 1.x、2.0 |
| 数据压缩 | 未压缩、zlib；不支持 LZO |
| 加密 | 支持 2.0 的 key-info 加密标记 `Encrypted=2`；不支持用户密码 / 记录加密标记 `1` 或其他加密组合 |
| 文件大小 | 最多 256 MiB（界面显示为 256 MB） |
| 来源数量 | 最多安装 32 个 MDX 来源 |
| 索引规模 | 每个文件最多 1,000,000 条索引记录 |
| 单词条 | 最多 2 MiB 原始记录 |
| 数据块 | 单块最多解压 32 MiB；词头块累计索引最多 128 MiB、记录最多 512 MiB |
| 重复词头 | 同一词头最多 64 条记录 |
| 预检时间 | 30 秒处理预算，超时返回明确错误 |
| 资源 | 暂不读取独立 MDD，不加载图片、音频、外部样式或脚本 |

导入先检查头部、大小、偏移、校验和及压缩块，再使用固定版本的 [js-mdict 6.0.8](https://github.com/terasum/js-mdict)（MIT）建立索引。应用使用自己的受限解压和记录读取边界；上游库支持的其他能力不等于本应用全部支持。`@@@LINK` / `@@LINK` 记录转向最多解析 8 层，循环或缺失目标明确失败，不伪装成未收录。

词条语言标识用于来源注册和查询，不自动引入语言分词器。没有语言处理器时 v1 查询保留 Unicode 原文精确查询；本阶段阅读和学习流程仍使用当前英语模型，没有接入真实日语分词或学习身份分析。

## 查询和原文展示

MDX 适配器实现已有 `DictionaryAdapter`，词条返回 `{ kind: 'original', mediaType: 'text/html', content }`，协议仍为 `dictionary-api.v1` / `dictionary-entry.v1`。纯文本投影置于可忽略扩展 `readage.originalPlainText.v1`，不把原文推断成已审核的结构化义项。来源 ID 为 `mdx-<文件 SHA-256>`，内容版本为 `mdx:<SHA-256>`；词条 ID 位于该内容快照内，不用展示词头代替学习 ID。

兼容展示的 `DictionarySourceView` 增加可选 `originalContent: { mediaType, content, plainText }`。阅读小弹窗与扩展使用纯文本，网页完整详情按来源展示基本原文排版：段落、强调、列表、表格、代码和 ruby 等。义项保持来源独立，导入词典或排序不更改已有英语学习 ID、证据去重和复习状态。

`src/lib/dictionaryOriginalContent.ts` 使用 `htmlparser2` 将 HTML 转成应用自己的安全节点，`DictionaryOriginalContent.tsx` 只创建允许的 React 元素，不使用 `dangerouslySetInnerHTML`。脚本、样式、表单、媒体、iframe、SVG、MathML 等活动容器连同子树丢弃；原始事件、类名、内联样式和 URL 属性不传入 DOM。未知自定义标签保留文字；普通链接保留可读标签，不跳转或发起资源请求。只有 `entry://词头` 可以变成调用应用查询回调的按钮，不作为浏览器 URL 打开。

每次 HTML 展示最多解析 1 MiB 输入、访问 4,000 个节点、嵌套 32 层、输出 100,000 个 UTF-16 文字单元；超限显示前一部分并提示。纯文本或不支持的 MIME 类型使用有界纯文本回退，React 自动转义。该展示保留可读语义，不恢复原词库 CSS 布局、JavaScript 或资源文件。

## 保存与恢复

默认安装目录为 `local-data/dictionary/imports`，可通过 `DICTIONARY_IMPORTS_DIR` 指定。每个来源保存为：

```text
local-data/dictionary/imports/
  mdx-<SHA-256>/
    dictionary.mdx
    manifest.json
```

清单格式为 `dictionary-mdx-import.v1`，记录来源 ID、名称、语言、SHA-256、字节数、索引条数和原文件名。上传文件名仅作为元信息，不作为输出路径。导入使用暂存目录，完整检查后移动到生成的固定来源目录；安装注册与设置保存串行处理，失败会回滚新增来源和文件，既有来源继续可用。

应用启动只发现生成 ID 下的有效清单。有效清单指向缺失或损坏文件时来源报告不可用；未知目录和无效清单不会成为可执行适配器。读取数据时再核对文件哈希和索引数量。设置文件位置与原子保存、冲突处理见 [通用接口文档](dictionary-interface-v1.md#词典设置与保存)。

## HTTP 接口

`POST /api/dictionary/v1/import` 使用原始二进制请求体，不使用 multipart 或 JSON：

| 请求头 | 含义 |
| --- | --- |
| `Content-Type: application/octet-stream` | MDX 文件原始字节 |
| `X-Import-Filename` | URI 编码后的 `.mdx` 文件名，必填 |
| `X-Dictionary-Language` | 词头语言标识，默认 `en` |
| `X-Dictionary-Name` | 可选 URI 编码展示名称；页面最多 128 字符，服务最多 160 字符 |

成功返回：

```ts
{
  ok: true,
  settings, // dictionary-settings.v1 配置及新 revision
  catalog,  // 新来源目录及目录版本
  imported: { dictionaryId, name, entryCount },
  warning,  // 可选：当前不加载的资源能力
}
```

400 表示文件为空、输入无效、损坏或格式不支持，413 表示超过文件大小，503 表示导入忙或保存/服务故障。接口使用应用敏感 API 访问控制，拒绝跨来源浏览器写入（403）；同时只缓冲一个上传。客户端为 `dictionarySettingsClient.importFile(file, { language, name, signal })`，支持取消等待。上传或索引暂存阶段取消会回滚；原子安装已经开始后，安装可能在连接断开后完成。未收到成功响应时重新加载目录确认当前结果。

## 验证

```powershell
node --import tsx --test tests/dictionaryMdxImport.test.ts tests/dictionaryOriginalContent.test.ts
```

`tests/helpers/mdxFixture.ts` 生成应用自己的小型 MDX 夹具，覆盖压缩、键、索引、记录转向、导入及持久化，不分发出版社词库。原文测试覆盖格式保留、活动内容与 URL 丢弃、内部查询引用、纯文本回退以及大小/深度边界。浏览器上传和全量构建另验证 MDX 读取代码及词库文件留在服务端。
