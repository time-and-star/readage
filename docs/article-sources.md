# 文章导入来源与致谢

ReadAge 提供文章组织、阅读和学习工具。材料可以来自用户自行准备的文件、外刊资源仓库以及配置中的网站或订阅源；来源类型和平台入口分别说明如下。

## 用户自行导入的材料

“导入文章”支持粘贴正文、设置可选标题，并选择英语、法语或日语。文件入口接受 TXT / Markdown / HTML、DOCX、EPUB 和 PDF，具体扩展名及类型以当前导入界面为准。MOBI 未列入当前文件导入格式；资源网站提供某种格式不表示 ReadAge 已支持该格式。

这类文章由用户自行准备。个人文章、附件、阅读与学习记录留在各端的本机档案中，GitHub 源码和 Release 安装包不携带个人文章库。三端档案可通过备份包手动恢复或迁移，当前没有自动双向云同步。

## 外刊资源仓库

特别感谢 **[@hehonghui](https://github.com/hehonghui)** 及 **[@hehonghui/awesome-english-ebooks](https://github.com/hehonghui/awesome-english-ebooks)** 的贡献者持续整理、维护外刊资源。

ReadAge 当前配置直接引用该仓库，默认分支配置为 `master`，可通过 `MAGAZINE_REPO_REF` 指定版本。期刊目录对应如下：

| ReadAge 期刊 | 上游资源目录 |
| --- | --- |
| The Economist | [`01_economist`](https://github.com/hehonghui/awesome-english-ebooks/tree/master/01_economist) |
| The New Yorker | [`02_new_yorker`](https://github.com/hehonghui/awesome-english-ebooks/tree/master/02_new_yorker) |
| The Atlantic | [`04_atlantic`](https://github.com/hehonghui/awesome-english-ebooks/tree/master/04_atlantic) |
| Wired | [`05_wired`](https://github.com/hehonghui/awesome-english-ebooks/tree/master/05_wired) |

这里感谢的是资源整理、维护和分享工作。文章、插图及出版物本身的版权仍属于相应作者和出版方。ReadAge 的 Apache 2.0 许可证适用于项目自有源码，不替代外刊或用户导入材料的授权。

## 配置中的网站与订阅源

| 来源 | 原站或实际订阅入口 |
| --- | --- |
| News in Levels | [Level 1](https://www.newsinlevels.com/level/level-1/) / [Level 2](https://www.newsinlevels.com/level/level-2/) |
| The Conversation | [网站](https://theconversation.com/) / [配置中的 Atom](https://theconversation.com/us/articles.atom) |
| JSTOR Daily | [网站](https://daily.jstor.org/) / [RSS](https://daily.jstor.org/feed/) |
| Science News Explores | [网站](https://www.snexplores.org/) / [RSS](https://www.snexplores.org/feed) |
| The MIT Press Reader | [网站](https://thereader.mitpress.mit.edu/) / [RSS](https://thereader.mitpress.mit.edu/feed/) |

感谢这些平台的作者、编辑及维护者。来源类型、原站地址和适用语言保留在各自配置与文章来源中。全文提取按已有正文清洗、图片说明、附件和拆篇规则处理；来源不可用或仅提供摘要时不能把它伪装成完整正文。

## 三端入口与交付范围

| 端 | 文章材料的进入方式 |
| --- | --- |
| 本地浏览器 | 粘贴或文件导入；本机服务按配置手动更新外刊与网站来源 |
| Windows | 粘贴或文件导入；允许用户主动更新已配置来源，其余离线规则继续适用 |
| Android | 粘贴、系统文件选择及本机备份迁移；已有外刊可离线阅读，当前联网更新入口关闭 |

来源配置见 [`server/magazines/config.ts`](../server/magazines/config.ts)，文件入口见 [`src/components/EnterArticleModal.tsx`](../src/components/EnterArticleModal.tsx)。跨端实现和已有差异以 [交付说明](platform-parity.md) 与 [逐项验收](user-feature-acceptance.md) 为准。
