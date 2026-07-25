# Agent Card 自测台独立打包设计

## 目标

为参赛选手提供 Windows 与 macOS 两套可解压即用的 Agent Card 自测台离线安装包。安装包内置 Node.js 运行时，不要求预装 Docker 或 Node.js；选手通过双击启动脚本，在本机浏览器访问 `http://127.0.0.1:4173/agent-check`。

打包产物只包含 Agent Card 自测台及其运行依赖。主测评平台的首页、评测记录、模型评审、评分、Runtime 对测、数据源和运维部署内容不得进入产物。

## 采用方案

采用独立服务入口与显式文件白名单。

新增独立的诊断服务入口，只注册以下路由：

- `GET /agent-check`
- `GET /agent-check.html`
- `GET /agent-check.js`
- `GET /agent-check-helpers.js`
- `GET /agent-check.css`
- `GET /api/health`
- `POST /api/agent-diagnostics`
- `POST /api/agent-cards/resolve`

其他 `/api/*` 路由统一返回 `404`。根路径 `/` 重定向到 `/agent-check`，方便本地使用，但不提供主测评平台首页。

独立入口只依赖 Agent Card 校验、A2A 调用、安全 HTTP 请求和诊断限流模块，不导入现有 `server.js`、评测流水线、评分、Runtime、存储、模型供应商或数据源模块。

## 产物结构

打包脚本生成以下目录并分别压缩：

```text
dist/agent-check/
├── windows/
│   ├── runtime/
│   │   └── node.exe
│   ├── app/
│   │   ├── diagnostics-server.js
│   │   ├── package.json
│   │   ├── public/
│   │   └── src/
│   ├── config.env
│   ├── start.bat
│   └── 使用说明.md
├── mac/
│   ├── runtime/
│   │   ├── arm64/bin/node
│   │   └── x64/bin/node
│   ├── app/
│   ├── config.env
│   ├── start.command
│   └── 使用说明.md
├── agent-check-windows.zip
└── agent-check-mac.zip
```

Windows 首发支持 64 位 Windows。macOS 包同时包含 Apple Silicon 与 Intel 运行时，`start.command` 根据 `uname -m` 自动选择。

## 打包边界

打包器只允许复制以下应用文件：

- 独立诊断服务入口；
- `public/agent-check.html`
- `public/agent-check.js`
- `public/agent-check-helpers.js`
- `public/agent-check.css`
- `src/agent-diagnostics.js`
- `src/diagnostics-guard.js`
- `src/a2a.js`
- `src/safe-http.js`
- 为上述模块新增或确认的最小通用依赖；
- 独立包使用的 `package.json`、启动脚本、配置和使用文档。

禁止将以下内容复制到产物：

- `server.js`
- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `public/methodology.*`
- `src/pipeline.js`
- `src/scoring.js`
- `src/store.js`
- `src/runtimes.js`
- `src/providers.js`
- `src/panda-data.js`
- `agents/`
- `data/`
- `deploy/`
- 主项目 `.env`
- 任何评测记录、密钥、Token 或本机缓存。

打包脚本从白名单构建产物，不从项目根目录做排除式复制。打包后再执行禁止项扫描；发现任一禁止项即失败并删除未完成 ZIP。

## 本地启动与配置

Windows 使用 `start.bat`，macOS 使用 `start.command`。启动脚本：

1. 定位自身目录，不依赖当前工作目录；
2. 读取同目录 `config.env`；
3. 使用包内 Node.js 启动独立服务；
4. 等待健康检查成功；
5. 使用系统默认浏览器打开 `/agent-check`；
6. 保持终端窗口显示服务日志，用户关闭窗口或按 `Ctrl+C` 停止服务。

默认配置：

```dotenv
HOST=127.0.0.1
PORT=4173
AGENT_DIAGNOSTICS_RATE_LIMIT=30
AGENT_DIAGNOSTICS_CONCURRENCY=4
ALLOW_PRIVATE_DIAGNOSTICS_URLS=true
```

`ALLOW_PRIVATE_DIAGNOSTICS_URLS=true` 仅影响自测台对 Agent Card 和 A2A 目标的访问，便于选手测试本机或局域网 Agent。服务本身只监听 loopback，不对局域网开放。包内不提供 `ALLOW_PRIVATE_AGENT_URLS`，避免与主测评平台语义混淆。

端口被占用、运行时架构不支持、应用文件缺失或服务未能通过健康检查时，启动脚本显示中文错误并保留窗口，方便排查。

## 安全与数据

- 自测台不创建评测记录，不写入 Card、Agent Token 或诊断结果。
- 独立包不包含主项目 `.env` 或任何生产凭据。
- 服务仅监听 `127.0.0.1`。
- Agent Bearer Token 只存在于本次浏览器请求和服务内存中。
- 使用说明明确提醒：仅在可信电脑使用 Token；本地 HTTP 只适用于 loopback，禁止将监听地址改为公网地址。

## 使用文档

Windows 与 macOS 目录分别包含中文 `使用说明.md`，覆盖：

- 解压和一键启动；
- Windows SmartScreen 与 macOS Gatekeeper/执行权限提示；
- Apple Silicon 与 Intel 自动适配；
- 页面入口和停止方法；
- 端口修改；
- 本机 Agent 地址中 `127.0.0.1` 的含义；
- Docker/Node.js 均无需安装；
- 常见错误：端口占用、Card URL 不可达、Agent 超时、Token 错误；
- 安全注意事项。

## 测试与验收

自动化验收包括：

1. 独立服务入口测试：只暴露自测台静态资源、健康检查、Card URL 解析和诊断 API；主评测 API 返回 `404`。
2. 依赖边界测试：独立入口的静态导入图不触达主测评模块。
3. 白名单测试：生成的应用目录只包含允许文件。
4. 禁止项测试：产物不包含主站、评测、评分、Runtime、数据、部署或密钥文件。
5. 启动烟测：使用当前平台 Node.js 启动打包后的应用，确认 `/agent-check` 和 `/api/health` 可用，`/` 不返回主站。
6. 启动脚本静态测试：Windows 与 macOS 脚本引用包内运行时、读取配置并打开正确地址。
7. 压缩包清单测试：ZIP 内容与对应目录一致，且不包含项目根目录层级或绝对路径。

实际下载的 Windows 与 macOS Node.js 运行时通过固定版本和 SHA-256 校验。若构建环境无网络，可使用预先下载并通过校验的运行时缓存；缺少缓存时打包命令明确失败，不生成伪完成产物。

## 不在范围内

- 不修改或替换主测评平台现有部署。
- 不为选手安装系统服务或开机启动项。
- 不提供 Linux 安装包。
- 不在本地包中加入 HTTPS 证书或公网访问能力。
- 不把诊断结果持久化或上传到主测评平台。
