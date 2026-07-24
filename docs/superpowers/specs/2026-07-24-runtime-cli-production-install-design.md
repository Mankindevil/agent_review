# 生产 Runtime CLI 本机中转部署设计

## 背景

生产平台已经通过 systemd 与 Nginx 运行在 Ubuntu x86_64 服务器上。当前生产探针显示 Doubao 方舟 API adapter 已就绪，但 Claude Code 与 Cursor Agent 尚未安装。开发机上的 Claude Code 是 Windows x64 原生程序，不能直接复制到 Linux 执行。

本设计采用“本机中转 Linux 安装产物”方案：开发机只负责从官方来源取得 Linux x86_64 安装产物、校验并通过 SCP 上传；生产运行阶段不依赖开发机、临时隧道或全局 VPN。

## 目标

- 在生产服务器安装并固定 Claude Code 与 Cursor Agent 的 Linux x86_64 版本。
- Claude Code 使用服务器现有火山方舟配置执行；该选择只属于评测 Runtime，不代表评审模型或参赛 Agent 的模型要求。
- Cursor Agent 使用专用文件凭据目录中的持久账户登录，并由服务器直接访问 Cursor 服务。
- Doubao 继续使用现有火山方舟 API adapter，不安装本地 CLI。
- 平台能够通过受限、非交互方式真实调用 Claude Code 与 Cursor Agent。
- 安装、启用、升级和回滚均不依赖开发机持续在线。

## 非目标

- 不在生产主机安装全局 VPN，不修改默认路由。
- 不把 Windows `claude.exe` 上传后冒充 Linux 程序。
- 不把 CLI 登录信息、代理凭据或 API Key 写入 Git、发布目录或命令日志。
- 不要求评审模型、Claude Code、Cursor Agent 或 Doubao 使用 DeepSeek V4 Pro；DeepSeek V4 Pro 仅是参赛 Agent 的外部声明与人工核验要求。
- 不允许 CLI 修改生产发布目录、Git 仓库、systemd 配置或持久化评测数据。

## 部署架构

### 安装产物

开发机从 Claude Code 与 Cursor 官方来源获取与服务器匹配的 Linux x86_64 产物。上传前记录：

- 工具名称；
- 版本；
- 来源 URL；
- SHA-256；
- 获取时间。

服务器布局：

```text
/opt/agent-review/tools/
├── claude/releases/        # 每个已校验语义版本一个只读目录
├── cursor-agent/releases/  # 每个已校验语义版本一个只读目录
└── bin/
    ├── claude              # 指向当前 Claude 版本
    └── cursor-agent        # 指向当前 Cursor 版本
```

版本目录由 `root:agent-review` 管理且不可由应用写入；可执行文件权限为 `0750`。`bin` 中的软链接作为原子切换点，保留上一版本用于回滚。

### 运行身份

CLI 由现有 `agent-review` systemd 服务派生，继承无特权用户、`NoNewPrivileges=true`、`ProtectSystem=strict`、`ProtectHome=true` 与 `PrivateTmp=true`。每次调用继续在独立临时目录执行，并在结束后删除。

systemd 环境文件补充工具 PATH、显式启用开关和独立凭据：

- `PATH=/opt/agent-review/tools/bin:/usr/local/bin:/usr/bin:/bin`
- `ENABLE_LOCAL_CLAUDE_CODE=true`
- `ENABLE_LOCAL_CURSOR_AGENT=true`
- Claude 方舟配置使用现有 `CLAUDE_BACKEND`、`ARK_BASE_URL`、`ARK_API_KEY` 与 `CLAUDE_ARK_MODEL`；所选后端配置不完整时失败关闭，不跨供应商回退
- Cursor 使用专用 `CURSOR_AUTH_CONFIG_HOME` 中的持久账户登录，设置 `AGENT_CLI_CREDENTIAL_STORE=file`，不向子进程传递 API Key
- 单次 Runtime 上限通过 `LOCAL_RUNTIME_TIMEOUT_MS` 控制，且不得超过赛事规定的 20 分钟

环境文件保持 `root:root 0600`。服务状态接口只能返回版本、鉴权布尔值和就绪状态，不返回任何凭据。

### 网络

- 安装阶段由开发机下载并上传，不要求生产服务器访问安装源。
- Claude Code 通过平台的本地 Anthropic-to-Ark 协议桥访问火山方舟。
- Cursor Agent 由生产服务器直接访问 Cursor 服务。
- 上线前分别执行 DNS、TLS 和最小 API 调用探针。
- 如果 Cursor 无法直连，Cursor 保持关闭；后续单独设计受控出口代理，不在本次部署中修改生产默认路由。

## 应用兼容调整

安装前先用实际版本的 `--help` 确认非交互参数。应用只使用当前官方版本支持的参数：

- Claude Code：打印模式、JSON 输出、单轮限制、计划权限模式、禁用工具和预算限制。
- Cursor Agent：打印模式、JSON 输出、一次性空工作区 `--trust` 和权限配置文件；不使用当前版本未声明的旧参数。

权限配置明确禁止：

- Shell 与 Git 操作；
- WebFetch、WebSearch 与全部 MCP 工具；
- 读取 `.env`、密钥、证书和系统配置；
- 写入生产代码、发布目录和持久化数据；
- 网络访问比赛任务不需要的目标。

Runtime 状态探针必须分别判断：

1. 可执行文件存在且版本可读取；
2. 对应 adapter 已显式启用；
3. 鉴权或后端配置有效；
4. 最小非交互调用成功。

只有四项均满足时才显示 `runtimeReady=true`。

## 部署顺序

1. 从云控制台确认 SSH Host Key，并改用 SSH 公钥登录。
2. 轮换此前在聊天中暴露的 root 密码。
3. 获取服务器架构与操作系统信息，确认 Linux x86_64。
4. 在开发机取得官方 Linux 安装产物并计算 SHA-256。
5. 上传到服务器临时目录，远端再次计算 SHA-256 并比对。
6. 安装到独立版本目录，创建或切换工具软链接。
7. 以 `agent-review` 用户执行版本与帮助命令。
8. 更新应用的 CLI 参数兼容性、权限配置和状态探针，完成测试、提交并发布新应用版本。
9. 原子更新 root-only 环境文件并重启服务。
10. 执行运行时探针、真实非交互调用和平台端到端验收。

## 验收标准

- `claude --version` 与 `cursor-agent --version` 在 `agent-review` 用户下成功。
- Claude Code 最小调用返回合法 JSON，结果记录实际方舟 endpoint。
- Cursor Agent `status` 与最小只读调用成功。
- `/api/runtimes` 对 Claude Code、Cursor Agent 和 Doubao 均返回准确状态。
- 使用真实 A2A 示例完成一次 live 评测，三个 Runtime 均产生非 demo、非 failed 结果。
- systemd 重启后状态保持就绪。
- 主站、Agent 预检页、健康接口和现有 Doubao/PandaAI 能力无回归。
- 日志、API 响应、评测结果和进程环境检查均未泄露凭据。

## 失败处理与回滚

- 安装校验失败：不创建 `bin` 软链接，不重启应用。
- CLI 冒烟测试失败：保持对应启用开关为 `false`。
- 新应用版本失败：把 `/opt/agent-review/app` 恢复到上一发布目录并重启。
- CLI 版本不兼容：把工具软链接原子切回上一版本。
- Cursor 网络不可达：只关闭 Cursor adapter；Claude Code 与 Doubao 继续运行。
- 任何密钥出现在日志或命令历史：立即停止部署、清理暴露面并轮换对应密钥。

## 测试

- 单元测试覆盖 Claude/Cursor 参数构造、显式后端选择、状态探针和凭据脱敏。
- 集成测试使用模拟 CLI 验证成功、鉴权失败、超时、异常退出和取消传播。
- 生产冒烟测试只执行无副作用的只读 Prompt。
- 发布前运行 `npm test` 与 `npm run check`；发布后检查 systemd、Nginx、HTTPS 和 Runtime 状态。
