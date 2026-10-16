# 浏览器运行与部署

## 个人本机使用

安装 Node.js 22.13 或更新版本，执行 `npm install`，再执行 `npm run start:local`。浏览器访问 `http://localhost:3000`；Windows 可以双击 `start-local.cmd`。保持服务进程运行。

本机启动器绑定本机地址，关闭启动时全库外刊同步。电脑本机模式将文章、正文、词汇记忆和偏好保存至 `local-data/library/learning.sqlite`；PDF 与图片位于 `data/magazines/`。第三方词典、翻译和朗读模型单独准备，见对应专项文档。

`npm start` 运行已经构建的生产服务。个人日常使用优先选 `npm run start:local`，不要为了绕过生产凭证检查而放宽公网访问。

## 公网部署

配置 `.env.local` 或服务器环境变量，再构建并启动：

```dotenv
HOST=0.0.0.0
PORT=3000
APP_API_TOKEN=<自行生成的长随机串>
VITE_APP_API_TOKEN=<与 APP_API_TOKEN 相同的值>
MAGAZINE_SYNC_ON_BOOT=false
```

```bash
npm run build
npm start
```

使用反向代理提供 HTTPS。`VITE_*` 在构建时写入前端；更改后须重新构建。共享访问凭证适合受控的小范围访问，前端内嵌值不能当作私密用户身份凭证。昂贵接口仍应配置合理访问范围与限流。

供应商密钥留在服务端。在线 AI 能力还受当前产品开关和供应商可用状态约束；配置密钥不会自动开放已关闭的解释或讨论入口。

公网模式默认关闭电脑本地档案接口，各访客使用各自浏览器的 localStorage / IndexedDB。换浏览器、清站点数据和无痕模式均不保证保留进度，使用者应自行导出备份。个人生产模式仅在绑定本机地址并显式设置 `LOCAL_DATABASE_ENABLED=true` 时使用电脑 SQLite 档案，接口校验本机同源请求。

## 材料与外刊

在文章库中按来源、期号与目录选择文章。Node 服务保存目录和正文缓存，已授权的来源可通过手动更新取得材料。同步范围、网络开关和平台差异见 [跨端说明](platform-parity.md)；Windows 的手动更新例外不代表 Android 开放联网更新。

外刊缓存与原文件位于被 Git 忽略的 `data/magazines/`，不随源码提交。请自行准备有权使用的内容。既有 API 包括来源、期号、文章、同步状态与手动同步，具体实现位于 `server/magazines/routes.ts`。
