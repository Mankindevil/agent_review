# Agent Card 自测台独立包构建指南

本指南面向赛事组织者。参赛选手不运行构建命令，只需领取生成的 Windows 或 macOS ZIP。两个包均内置 Node.js，不要求选手安装 Docker 或 Node.js。

独立包采用文件白名单构建，只包含 Agent Card 自测页面、Card URL 解析、诊断 API 和最小网络安全模块，不包含主测评平台的首页、评测 API、评分、模型、Runtime、历史数据或生产密钥。

## 在线构建

在项目根目录执行：

```bash
npm run bundle:agent-check
```

首次构建会从 Node.js 官方发布地址下载三个锁定的运行时归档，并校验 SHA-256。校验通过的文件缓存在 `.cache/agent-check-runtimes/`。

输出：

```text
dist/agent-check/
├── windows/
├── mac/
├── agent-check-windows.zip
└── agent-check-mac.zip
```

## 离线构建

先在联网环境完成一次在线构建，再保留 `.cache/agent-check-runtimes/`。离线环境执行：

```bash
node scripts/build-agent-check-bundles.js --offline
```

离线模式只接受 SHA-256 完全匹配的缓存归档；缺失或被修改时立即失败，不生成不完整产物。也可以通过 `--runtime-cache <目录>` 指定缓存目录。

## 仅验证应用边界

不下载运行时，只生成并检查两个平台的应用白名单目录：

```bash
node scripts/build-agent-check-bundles.js --app-only
node --test test/agent-check-bundle.test.js test/diagnostics-server.test.js
```

验证器会拒绝白名单以外的文件、符号链接、越界路径以及导入主测评模块的依赖。产物中出现 `server.js`、`public/index.html`、`public/app.js`、`src/pipeline.js`、`src/scoring.js`、`src/runtimes.js`、`agents/`、`data/`、`deploy/` 或 `.env` 都会使构建失败。

## 发布前检查

1. 运行 `npm run check`。
2. 运行 `npm run test:node`。
3. 运行 `npm run bundle:agent-check`。
4. 在 Windows 上解压 `agent-check-windows.zip`，双击 `start.bat`。
5. 分别在 Apple Silicon 与 Intel Mac 上解压 `agent-check-mac.zip`，双击 `start.command`。
6. 确认 `/agent-check` 可用、`/api/health` 的 `mode` 为 `agent-check-standalone`，且 `/api/evaluations` 返回 `404`。
7. 将构建命令打印的两个 ZIP SHA-256 随发布页一并公布。

ZIP 与缓存目录均被 Git 忽略。不要提交大体积运行时，也不要把主项目 `.env`、Token 或评测数据复制到发布目录。
