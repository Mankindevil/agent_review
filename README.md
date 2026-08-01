# 锐评局：金融 A2A Agent 公开评测系统

## Panda Market Analyst production agent

This repository also ships a production-oriented, A2A 1.0 market analyst whose
only financial data source is `panda_data`. It creates a daily close report with
hot-topic, sell-pressure, and potential-watchlist sections, plus an Evidence
Pack and Run Trace for conclusion-level audit.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-data.txt
npm install
cp .env.example .env
npm run market-agent
npm run market-report -- --no-email
npm run market:smoke
```

Fill credentials only in a protected local environment file. The smoke command
fails closed unless Panda is explicitly enabled and real Panda credentials are
present. It sends mail only when `MARKET_SMOKE_EMAIL_TO` is explicitly set.
Production systemd units are in `deploy/`; the operator runbook is
`docs/PRODUCTION_OPERATIONS.md`, and the full agent contract is
`docs/MARKET_ANALYST_AGENT.md`.

## Agent Card 自测台独立包

组织者可生成只包含 `/agent-check` 自测台的 Windows 与 macOS 独立包：

```bash
npm run bundle:agent-check
```

产物内置 Node.js，选手无需安装 Docker 或 Node.js。独立包不包含主测评平台代码；构建、离线缓存和发布检查见 [独立包构建指南](./docs/AGENT_CHECK_LOCAL_BUNDLE.md)。

On Windows, create `.venv` with an installed `python` or `py` launcher and set
`PANDA_DATA_PYTHON` to `.\.venv\Scripts\python.exe` when the interpreter is not
discoverable from `PATH`. The data requirements pin the Parquet engine used by
the Market Worker cache; after installation, `npm run test:market-worker`
verifies the cache and provider-call contract with that interpreter.

一个面向 A2A 金融智能体黑客松的全栈评测系统。用户提交 Agent Card 和真实投研任务后，平台依次判断 Agent 必要性，按研究严谨性、数据纪律、回测可信度、风险合规、可复现性进行四模型审稿，让不同 runtime 只凭 description 现场直出 Skill，再把所有选手放进同题研究压测，最终给出“夯 / 人上人 / NPC / 拉”的证据化锐评。

未接入主办方 Data / Research Skills 时，平台只审查研究设计与输出纪律，不验证金融数字真伪，也不会把模拟结果包装成真实回测。接入数据能力后可在现有同题执行层增加 point-in-time 数据复算、回测结果校验和结构化验收断言。

## 当前公开入口：V1 真实对测

首页固定创建 V1 `live` 评测，不展示 V2 切换和演示入口。V2 与 demo 的服务端能力、历史记录和直接结果页仍保留，便于既有记录审计；它们不会被公开首页伪装成 V1 live。

新建 V1 的四方审稿只评价公开 Agent Card 的定位、Skills、协议、输入输出示例和边界风险。随后同 Prompt 对打采用 `v1-model-arena/v2`：`20% 场景价值 + 60% 专业度 + 20% 服务端可观测能力`。能力分由成功状态和端到端耗时计算，包含网络与协议开销；平台不观测 Agent 内部工具调用。完整公式、版本兼容和阈值见 [评测与打分规则](./docs/SCORING.md)。

完成的 V1 结果可下载中文完整 PDF（`GET /api/evaluations/:id/report.pdf`），包括 Card、四方审稿、场景、逐候选评分/耗时、评语、原始输出和 Panda/上下文审计。生成器使用 `REPORT_PDF_PYTHON`（默认 `.venv/bin/python`）并要求 `requirements-data.txt` 中的 ReportLab；不存在记录返回 404，V2 或未完成记录返回 409。

## 已实现功能

- A2A 1.0 Agent Card 校验，兼容 0.3 顶层 `url` 形态；
- 独立 Agent 协议检查台：受访问密钥保护，一次性检查发现、Card、普通调用和可选流式调用，不写入评测历史；
- 文件拖拽、文件选择、JSON 粘贴、Agent Card URL 与服务根地址自动发现；
- 1–5 个同 prompt 测试用例；
- 投研 Agent 必要性五维评分，识别金融数据、时点、因子、回测、组合风险、协作、证据与合规信号；
- OpenAI、Anthropic、豆包、DeepSeek 从研究严谨性、数据纪律、回测可信度、风险合规、可复现性独立审稿；
- Claude Code、Cursor、Doubao 三种 runtime 的 description-only Skill 现场直出抽象；
- 现场复刻采用 description-only 信息防火墙：Runtime 只收到顶层 `description` 原文；记录支持展开 Skill 文件浏览器，逐个查看 `SKILL.md`、原始 `skill.json`、输入 description 与运行清单，并可复制完整内容；
- 提交 Agent 与三个复刻 skill 的逐用例输出和 V1 模型竞技评分对比；支持 DeepSeek 默认单模型或 OpenAI、Anthropic、豆包、DeepSeek 四席匿名盲评；
- SSE 实时进度：复杂度、每位模型评语、每个 Runtime Skill 和每位对测选手完成后立即展示；
- 首次评测与单步重试都有定位到当前工作项的加载动效：评审卡、Description 直出行或对测选手卡会显示 LIVE/RETRY 扫描带、目标与序号；支持 reduced-motion；
- 可真正中止模型请求与本地 CLI 的停止按钮，以及服务重启后的遗留任务识别；
- 模型复审、Runtime 重建、单用例单选手重跑三种单步重试；新结果替换旧结果后自动重算均分、覆盖模式、等级与锐评，并保留复核审计历史；
- 可在页面或 `.env` 固定评测 seed；平台为每个模型、Runtime 和用例派生稳定子 seed，并默认使用 temperature 0；
- 结构化执行日志：协议、评分、模型、Runtime、对测、耗时与真实/演示模式；
- 往期战绩支持二次确认删除；运行中的任务必须先停止，避免误删执行现场；
- 本机 Runtime 探测，区分“已安装”“已配置可执行”和“缺失”；
- 评语保留段落、换行与列表结构；最终锐评生成后先自动定位，再触发分数计数与判词盖章动效，支持 reduced-motion；
- 演示/真实双模式；
- 响应式前端、键盘焦点与 reduced-motion 支持；
- Node 原生测试，无第三方运行依赖。

详细实现与接口见 [架构文档](./docs/ARCHITECTURE.md)，逐项公式和阈值见 [评测与打分规则](./docs/SCORING.md)，Agent Card JSON 技术预检见 [平台使用指南](./docs/AGENT_DIAGNOSTICS_GUIDE.md)，当前技术债和实施优先级见 [全仓代码审查](./docs/CODE_REVIEW.md)。项目启动后也可以直接打开 `http://localhost:4173/methodology.html`，或点击顶部“评测规则”。

## 快速启动

要求 Node.js 20 或更高版本。

```bash
test -f .env || cp .env.example .env
npm start
```

项目会在启动时自动读取根目录 `.env`；当前工作区已经生成该文件，首次克隆时可用上面的命令从模板创建。系统或终端中已经存在的同名环境变量优先级更高，便于 CI、容器和临时命令覆盖。

打开 `http://localhost:4173`，选择任一“本地真实样本”，再点击“送进评测舱”即可体验演示评测。

打开 `http://localhost:4173/agent-check` 即可使用 Agent Card 技术预检平台。一次测试一张 Card，支持上传或粘贴 JSON、填写完整 Agent Card URL，以及通过服务根地址自动发现 `/.well-known/agent-card.json`。私人部署可用 `ALLOW_PRIVATE_AGENT_URLS=true` 为测试入口和正式测评统一放行平台服务器可达的内网/本机地址，页面和诊断结果会明确标注；若只想放行测试入口，可改用 `ALLOW_PRIVATE_DIAGNOSTICS_URLS=true`。平台会执行真实 A2A 自然语言任务，并提供 1、5、10、20 分钟的单次响应上限；团队与作品材料仍在最终报名表提交。Agent Bearer Token 的配置与安全说明见 [完整使用指南](./docs/AGENT_DIAGNOSTICS_GUIDE.md)。

开发模式：

```bash
npm run dev
```

启动三个可实际调用的本地 A2A Agent 和评测平台：

```bash
npm run demo:real
```

在 Claude Code 与 Cursor Agent 已完成登录后，同时启用本地真实 Runtime：

```bash
npm run demo:real-runtimes
```

### 使用火山方舟 DeepSeek 驱动 Claude Code

当前默认让 Claude Code 使用火山方舟的 DeepSeek 在线推理接入点，不需要登录 Claude 账号。编辑被 Git 忽略的 `.env`：

```bash
cd "/Users/jintingzhou/Documents/Agent锐评系统"
# ARK_API_KEY=你的方舟Key
# CLAUDE_BACKEND=ark
# CLAUDE_ARK_MODEL=ep-20260708162855-pcf9x
npm run demo:deepseek
```

方舟在线推理 endpoint 使用 OpenAI Chat Completions，而 Claude Code 使用 Anthropic Messages。项目会为每次 Claude 调用启动一个只监听 `127.0.0.1` 随机端口的短生命周期协议桥：

- Claude Code 把 Anthropic Messages 请求发给本地协议桥；
- 协议桥转换后调用 `${ARK_BASE_URL}/chat/completions`；
- 主模型、Haiku、Sonnet、Opus 和 Subagent 都映射到指定 DeepSeek endpoint；
- 无头执行使用评测专用 system prompt 覆盖 Claude Code 默认代码代理提示，禁止虚构 Bash、Explore 或子代理调用；
- 调用结束立即关闭协议桥，不把方舟 Key 传给 Claude 子进程。

如果模型偶发返回截断 JSON 或缺少 Skill 必填字段，运行时会携带纠错约束自动重试一次；认证、网络和命令执行错误不会被这种格式重试掩盖。

Runtime Probe 与“Description 直出记录”会显示实际后端：Ark 模式下展示方舟 DeepSeek endpoint ID，不再把它误标为 Claude Sonnet。

Key 只应写入本机 `.env` 或密钥管理系统，不要写入 `.env.example`。如需恢复 DeepSeek 官方 Anthropic-compatible API，可设置 `CLAUDE_BACKEND=deepseek` 并填写 `DEEPSEEK_API_KEY`。

本地 Runtime 使用受限非交互模式：Claude Code 采用 `--tools "" --permission-mode plan --safe-mode`；Cursor Agent 只使用官方支持的 `-p <prompt> --output-format json --trust`，其中 `--trust` 仅确认平台刚创建的一次性空工作区，并由该工作区内的 `.cursor/cli.json` 禁止 Shell、WebFetch、WebSearch、全部 MCP、全部相对文件读写及 `/proc`、`/run`、`/tmp`、`/var` 等绝对路径读取。两个 CLI 都在独立进程组与一次性 HOME/cache/data/state/TMP 中运行，超时后依次向整个进程组发送 `SIGTERM` 和 `SIGKILL`。Claude 单次调用默认设置 `$0.25` 预算上限，可通过 `CLAUDE_MAX_BUDGET_USD` 调整。Cursor 仍需访问其模型服务，因此生产网络层还应把该服务账户的出口限制为业务所需目标；CLI 权限文件不是网络命名空间或防火墙的替代品。

### 生产 Runtime 工具、凭据与模型边界

生产主机将 Claude 固定版本放在 `/opt/agent-review/tools/claude/releases/2.1.218/`，将 Cursor Agent 固定版本放在 `/opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b/`，均由 `root` 安装和维护；`/opt/agent-review/tools/bin` 仅放受控启动器并加入服务的 `PATH`。服务运行账户不得写入工具发布目录，也不要把 `PATH` 指向用户可写的 Node、npm 或临时安装目录。升级时先安装新的固定 release，再原子切换启动器；不要让应用自行下载或替换 CLI。

模板默认保持 `ENABLE_LOCAL_CLAUDE_CODE=false` 和 `ENABLE_LOCAL_CURSOR_AGENT=false`。在当前受控单机生产部署中，只有完成 root 管理的固定版本安装、systemd 文件系统隔离、持久认证目录权限和最小调用验收后，才设置 `ENABLE_LOCAL_CLAUDE_CODE=true` 与 `ENABLE_LOCAL_CURSOR_AGENT=true`；更强隔离需求仍可通过 `RUNTIME_ADAPTERS_JSON` 使用独立 Runtime 服务。

#### 评审模型与 Runtime 模型独立配置

评审模型、Runtime 模型、参赛 Agent 资格是三件事。评审模型由 `OPENAI_*`、`ARK_*`、`REVIEW_MODEL_*` 或 `MODEL_REVIEWERS_JSON` 配置；Runtime 模型由本地 CLI、方舟豆包 adapter 或 `RUNTIME_ADAPTERS_JSON` 配置；它们可以分别启用、分别使用各自的凭据。只有参赛 Agent Card 与最终报名表的声明要求 DeepSeek V4 Pro；这是参赛资格声明，不会改写平台的评审或 Runtime 配置。评审模型以及 Claude、Cursor、Doubao Runtime 不受该底模限制。

- V1 “单模型”评分直接复用上述现有评审配置，可选择 `gpt`、`claude`、`doubao` 或 `deepseek`，默认 DeepSeek；旧 API 客户端省略 `scoringConfig` 时也规范化为 DeepSeek 单模型，不需要配置第二套凭据。
- V1 “四模型匿名盲评”是网页默认选项，固定需要 OpenAI、Anthropic、豆包和 DeepSeek 四席。`live` 创建阶段会检查所需 ID 均为受支持的 `openai-compatible` / `anthropic` 席位，且 `baseUrl`、`model`、`apiKeyEnv` 和其引用的本地密钥均已配置：单模型检查所选席位，四模型检查全部四席；不满足时请求失败，不会先运行 Agent 或 Runtime。该检查不发送网络请求，因此网关连通性、远端鉴权和模型可用性错误仍可能在评分调用时暴露。
- V1 CASE 评分时，四模型至少两席成功才产生正式分数；单席失败或四席成功数不足时保留输出和席位错误，但不回退关键词规则分、模拟分或历史分。`demo` 可在无凭据时使用确定性模拟席位并明确标记；已存在的旧 V1 记录不会自动迁移或重算，页面标记为“历史规则评分”。如果操作者显式重跑历史记录中的某一 CASE，缺失的旧评分配置会按 DeepSeek 单模型缺省值处理，并用本次模型评分替换该 CASE 的旧快照。

- Claude Code 继续使用既有的 Ark 协议桥：`CLAUDE_BACKEND=ark` 时只通过 `ARK_BASE_URL`、`ARK_API_KEY` 和 `CLAUDE_ARK_MODEL` 访问方舟 DeepSeek endpoint，方舟 Key 不传入 Claude 子进程。后端选择严格失败关闭：`ark` 或 `deepseek` 的专属配置不完整时，不会回退到另一供应商或继承的 `ANTHROPIC_*` 凭据。
- Cursor Agent 只使用持久账户登录，不接收 API Key。把 `CURSOR_AUTH_CONFIG_HOME` 设为仅服务账户可访问的绝对目录（生产为 `/var/lib/agent-review/cursor-auth`）；平台为 CLI 设置 `AGENT_CLI_CREDENTIAL_STORE=file`，仅将 `XDG_CONFIG_HOME` 指向该目录，其余 HOME/XDG/TMP 仍是一次性目录。登录凭据位于 `$CURSOR_AUTH_CONFIG_HOME/cursor/auth.json`，模型工具权限同时显式禁止读取该路径。
- Doubao Runtime 维持原有方舟 API adapter：同时提供 `ARK_BASE_URL`、`ARK_API_KEY` 与 `REVIEW_MODEL_DOUBAO` 即可就绪，或由隔离的 `RUNTIME_ADAPTERS_JSON` adapter 覆盖。

`GET /api/runtimes` 只报告运行时可用性，不判断参赛资格。每个条目的 `installed` 表示 CLI 是否可执行且能读取版本，`authenticated` 表示相应凭据或隔离环境中的登录状态有效，`enabled` 表示本地开关或远程 adapter 已启用；`runtimeReady` 还要求真实的最小非交互调用成功。四个状态独立计算，因此“已安装”“已登录”或“已配置”都不等于平台会真实调用它。

随后在页面选择样本，把评测模式切换为“真实对测”。三个 Agent 分别监听：

- `http://127.0.0.1:4181`：因子显微镜，A2A 1.0 HTTP+JSON；
- `http://127.0.0.1:4182`：策略验钞机，A2A 1.0 JSON-RPC；
- `http://127.0.0.1:4183`：组合风控台，A2A 0.3 JSON-RPC 兼容样本。

每个服务都在 `/.well-known/agent-card.json` 暴露 Agent Card。也可以只运行示例 Agent：

```bash
npm run agents
```

检查与测试：

```bash
npm run check
npm test
```

### Production operations

The production server deployment layout, health checks, release and rollback steps, backup and restore procedure, and credential rotation requirements are documented in the [Production Operations Guide](docs/PRODUCTION_OPERATIONS.md).

## PandaAI Quant 金融数据源

金融分支通过官方 `panda_data` Python SDK 接入 PandaAI Quant。官方文档使用 `panda_data.init_token(username, password)` 登录，账号为 86 开头的账号；项目允许 `.env` 填写 11 位中国大陆手机号并自动补齐 `86`。受限 Python bridge 调用 SDK，Node 服务不会把账号、密码或 JWT 返回给浏览器。

先安装 SDK：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-data.txt
```

然后在被 Git 忽略的 `.env` 中配置：

```env
PANDA_DATA_ENABLED=true
PANDA_DATA_AUTO_VERIFY=true
PANDA_DATA_USERNAME=你的11位手机号或86开头账号
PANDA_DATA_PASSWORD=你的密码
PANDA_DATA_BASE_URL=http://pandadata.pandaaiquant.com
PANDA_DATA_ACCESS_KEY=用于保护本系统数据查询网关的随机长字符串
PANDA_DATA_PYTHON=.venv/bin/python
PANDA_DATA_TIMEOUT_MS=60000
PANDA_DATA_MAX_ROWS=500
```

`GET /api/data-source` 返回非敏感状态；`GET /api/data-source?probe=1` 额外检查本机 SDK。受保护的数据查询网关示例：

```http
POST /api/data-source/query
Authorization: Bearer <PANDA_DATA_ACCESS_KEY>
Content-Type: application/json

{
  "method": "get_stock_daily",
  "params": {
    "symbol": ["000001.SZ"],
    "start_date": "20250101",
    "end_date": "20250131",
    "fields": []
  }
}
```

只有 `PANDA_DATA_ALLOWED_METHODS` 白名单中的 SDK 方法可以调用，结果会按 `PANDA_DATA_MAX_ROWS` 截断。`PANDA_DATA_ACCESS_KEY` 留空时查询网关强制关闭，避免公开部署后被匿名消耗数据额度。接口字段以 [PandaAI Quant 数据 API 文档](https://www.pandaaiquant.com/data-service/api-docs?api=data_fetch_doc) 和比赛提供的本地接口文档为准。

### Benchmark 自动数据验真

设置 `PANDA_DATA_AUTO_VERIFY=true` 后，真实模式会在每个同题用例执行前建立一次 PandaAI 参考快照。提交 Agent 与三个 Runtime 共用该快照；快照不进入 Prompt，只在输出完成后校验数值。常见的沪深 300、中证 500、上证指数、深证成指、创业板指和带交易所后缀的股票代码会根据 Prompt 截止日期自动生成小窗口行情锚点。

需要强约束时，可在用例中声明最多 3 个 `dataQueries`，每个查询最多 10 个事实：

```json
{
  "name": "指数数据锚点",
  "prompt": "截至 2025-01-10，报告沪深 300 期末收盘。",
  "dataQueries": [{
    "method": "get_index_daily",
    "params": { "symbol": ["000300.SH"], "start_date": "20250101", "end_date": "20250110", "fields": [] },
    "requiredFields": ["date", "symbol", "close"],
    "facts": [{
      "label": "沪深 300 期末收盘",
      "field": "close",
      "where": "last",
      "aliases": ["期末收盘", "基准收盘"],
      "tolerance": 0.01,
      "required": true
    }]
  }]
}
```

结果中的 `benchmark[].dataEvidence` 保存行数、字段、尾部样本、SHA-256 指纹和解析出的参考事实；每位选手的 `dataVerification` 标明 `verified / partial / contradicted / missing / not-claimed / unavailable`。查询失败只会标记验真不可用，不会伪造参考值。对新 V1 模型竞技评分而言，`dataVerification` 只作为独立审计结果保存，不会进入发送给评审模型的候选包或 Prompt，V1 评分器也不读取它来计算“证据与风险意识”维度或总分。

## 演示模式与真实模式

演示模式默认可用。它会完整执行协议校验、必要性打分、多模型评语、skill 构建、同题对测和最终分档，但模型与 runtime 输出是基于输入确定生成的模拟数据。界面和结果对象均标记 `DEMO`，不会伪装成真实线上调用。

真实模式会：

1. 调用 Agent Card 声明的 A2A endpoint；
2. 调用 LLMX、火山方舟或 `MODEL_REVIEWERS_JSON` 配置的评审模型；
3. 调用显式启用的本机 Claude/Cursor、方舟豆包或 `RUNTIME_ADAPTERS_JSON` 隔离服务，仅凭 description 直出 Skill。
4. 在开启自动验真时，通过 PandaAI 建立同局共享的参考数据快照并复核可见输出。

如果未配置真实 adapter，演示模式中的相关项会保留为 demo。V1 真实模式创建时会拒绝缺失、`mock`、类型不受支持、必要字段不完整或本地密钥不存在的评审席；该本地预检不探测网关，连通性、远端鉴权和模型可用性错误可能到评分调用时才暴露。运行中的单个调用失败会记录错误并按对应流程处理其余选手。

运行页不会等待最终锐评才出报告。后端在每位评审、每个 Runtime 和每个同题选手结束时持久化完整快照并通过 SSE 推送；前端按“跑完一项，解锁一项”持续追加阶段产物。运行中的评测可点击“停止本次评测”，后端会通过 `AbortController` 中止当前 HTTP 请求或 CLI 子进程，并保留已经完成的结果。若服务在任务期间重启，遗留的 `queued/running` 记录会被标记为 `interrupted`，不再显示假运行。

评测结束后，每张模型评审卡可“重跑该模型”，每条 Runtime 构建记录可“重建并对测”，每个同题选手可“重跑这一局”。Runtime 重建会自动用新 Skill 重新执行全部同 Prompt 测试用例，避免构建物与对战输出版本不一致。V1 模型评分属于同场比较，因此任一候选重跑后会重新匿名评分该 CASE 的全部成功输出，并整体替换旧评分快照。重试期间状态为 `retrying`，仍可停止；完成后平台重新计算专业度、四方实战均分、覆盖模式与最终“夯 / 人上人 / NPC / 拉”，并将前后摘要写入 `retryHistory`。

提交页的 `SEED` 默认是 `20260720`。同一个 seed 会为每位评审、每个 Runtime 构建和每个“用例 × 选手”派生不同但稳定的整数 seed；单步重试继续使用原来的子 seed。OpenAI-compatible、方舟豆包以及 Claude Code 的方舟协议桥会实际发送 `seed`，同时默认把 `temperature` 设为 `0`。原生 Anthropic Messages、Cursor Agent CLI 与用户提交的外部 A2A Agent 不保证支持 seed，因此这是“尽力确定性”，不能承诺底层服务升级、并发调度或模型权重变化后逐字节一致。

“本机已安装”不等于“平台已真实调用”。`GET /api/runtimes` 会分别检查 Claude/Cursor 的可执行版本、隔离鉴权、启用开关与真实最小调用；昂贵的最小调用会短暂缓存并合并并发探针。豆包真实执行来自已配置的方舟 API、model-api 或远程隔离 adapter；本机 `doubao` CLI 只作安装信息展示。主服务不会把 Cursor Desktop 的 `cursor` 命令误认成 `cursor-agent`。

## A2A 提交方式

| 页面入口 | 输入内容 | 适用场景 | 是否属于 A2A 标准发现 |
|---|---|---|---|
| 文件 / JSON | `.json`、`.a2a.json` 文件 | 评审草稿、离线或内网 Agent Card | 直接配置 |
| 文件 / JSON | 粘贴完整 Agent Card | 调试与快速修改 | 直接配置 |
| Card URL | Agent Card JSON 的完整 URL | Card 不在标准路径或由网关托管 | 直接配置 URL |
| 服务地址发现 | 例如 `https://agent.example.com` | 公开 Agent 的标准自动发现 | `/.well-known/agent-card.json` |
| Registry（规划中） | 企业目录中的 Agent ID | 大规模治理、权限与目录检索 | Registry API 尚未由 A2A 统一规定 |

源码压缩包、Git 仓库、Docker 镜像不是 A2A 规定的发现形式。后续可以把它们作为“托管验收”入口：平台先在隔离环境部署，再要求部署结果暴露 Agent Card 与 A2A endpoint。认证信息同样不放入 Agent Card；私有 Agent 应通过独立的凭据引用或企业密钥管理接入。

### Phase 1 black-box V2 API

The evidence-backed V2 path is opt-in. Set `A2A_BLACK_BOX_V1_ENABLED=true`,
provide a canonical base64-encoded 32-byte `EVIDENCE_ENCRYPTION_KEY`, and
optionally set `EVIDENCE_ROOT`. With the flag off, the legacy evaluation API
and its request limits remain unchanged.

Create a V2 evaluation with `POST /api/evaluations` using
`schemaVersion: 2`, an `agentCard`, and `agentExamples`. The `202` response is
the public evaluation projection. The evaluation ID is the participant handle for
later reads, cancel, resume, delete, and appeals.

V2 create is non-idempotent. If its HTTP response is lost, create a new
evaluation; the replacement has a new evaluation ID.

After a restart marks an evaluation `interrupted` or `credentials-required`,
resume only the missing planned work with:

```http
POST /api/evaluations/:id/resume
Idempotency-Key: <unique 16-128 byte printable value>
Content-Type: application/json

{ "agentAuthorization": "Bearer <fresh Agent credential>" }
```

The resume body may contain only fresh Agent authorization. Reusing the same
idempotency key with the same body returns the original `202` receipt without
rerunning completed work; changing the body for that key returns `409`.
Participant and Agent credentials are never persisted, projected, or logged.
For a public Agent that did not require authorization at create time, the
resume JSON body may be `{}`. An Agent that originally required authorization
must provide fresh Agent authorization on every accepted resume.

### 示例资产

- `examples/submissions/`：三份可直接上传的 Agent Card；
- `examples/use-cases.json`：每个 Agent 的真实 prompt 和验收点；
- `examples/agents/server.js`：三个实际提供 well-known discovery 与 A2A 调用接口的本地服务。

### 受治理的黑盒评测：模型先评、人工不盲审、再开封复刻

V2 参赛提交由 Agent Card 与 **Agent 使用示例**组成。平台执行黑盒测试后，四模型先
对适用评分叶给出结构化意见；仅模型争议叶由第五模型处理。随后两位不同人类评委进行
人工不盲审：可见脱敏提交、证据、客观指标和模型意见，但在绝对分锁定前完全看不到
Replica Runtime、输出、分数和优势。两份人工叶分相差大于 15 分时，第三位不同评委
仲裁，服务器使用中位数和 rubric 权重计算结果。

绝对分含场景价值、专业性和 Agent 能力三维；Replica 不参与该总分。Agent 能力的
客观覆盖率低于 0.70 会标记为“暂定”。结构化结论锁定为不可变哈希后，平台才生成
受约束的幽默改写并释放此前密封的匿名复刻对照。

复刻结果给出提交 Agent 相对最佳有效 Replica 的点估计 `Δ`、固定 seed bootstrap
10,000 次的 95% 区间，以及区间下界 `Δc`（保守复刻优势）。区间跨过当前评级门槛
时显示“差异未稳定”；没有有效复刻时保留绝对分并显示“待复刻”。详细公式、权重和
评级阈值见 [评测与打分规则](./docs/SCORING.md)。

参赛者可在 `APPEAL_WINDOW_HOURS`（默认 72）小时内针对具体测试、证据或评分路径
提交申诉。只有固定控制探针确认的平台错误可授权一次相同配置的替代运行；Agent 或
Replica Skill 自身失败不能用于重抽更高分。申诉产生新的可追溯结果版本，原始运行
不覆盖。

V2 使用实际存在的三个开关/参数：

```env
A2A_BLACK_BOX_V1_ENABLED=false
REVIEW_GOVERNANCE_ENABLED=false
APPEAL_WINDOW_HOURS=72
```

前两个设为精确 `true` 才分别开启 V2 提交与治理角色。Replica 发布和公开证据投影由
已实现的状态机和角色投影控制，未提供独立的 Replica 或 public-evidence 开关。迁移
时先 shadow V2、再 judge pilot、最后设为默认；`schemaVersion: 1` 历史记录保持 legacy，
不会被静默重评分。

## 模型评审配置

项目支持两组可独立启用的 OpenAI-compatible 网关：OpenAI 与 Anthropic 走 LLMX；豆包与 DeepSeek 走火山方舟在线推理。Base URL 和模型接入点已写入 `.env`：

```env
OPENAI_BASE_URL=https://llmx.tqx.ai/v1
OPENAI_API_KEY=你稍后填写的Key
REVIEW_MODEL_OPENAI=g5.4
REVIEW_MODEL_ANTHROPIC=cs4.6

ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_API_KEY=你稍后填写的方舟Key
REVIEW_MODEL_DOUBAO=ep-20260720110725-5rbml
REVIEW_MODEL_DEEPSEEK=ep-20260708162855-pcf9x
```

每组只有在自己的 Base URL 和 Key 都存在时才启用真实评审；Key 留空的模型继续使用演示评审，不会产生无意义的鉴权报错。两个网关都按 OpenAI Chat Completions 契约调用 `${BASE_URL}/chat/completions`。方舟控制台给出的裸域名需要补全 `/api/v3`，模型值使用接入点 ID。

需要完全自定义评审数量或不同 endpoint 时，可以使用下面的 `MODEL_REVIEWERS_JSON`。该配置非空时优先级最高。

`MODEL_REVIEWERS_JSON` 是一个 JSON 数组。OpenAI-compatible 示例：

```json
[
  {
    "id": "gpt",
    "name": "OpenAI 评审",
    "model": "your-model-id",
    "kind": "openai-compatible",
    "baseUrl": "https://your-endpoint.example.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  {
    "id": "claude",
    "name": "Anthropic 评审",
    "model": "your-claude-model-id",
    "kind": "anthropic",
    "baseUrl": "https://api.anthropic.com/v1/messages",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
]
```

V2 正式黑盒评测使用独立的 `MODEL_REVIEW_PANEL_JSON`，不会把旧版
`MODEL_REVIEWERS_JSON` 自动视为合格面板。它必须包含恰好 4 个
`primary`、1 个身份不同的 `arbitrator`，以及可选的预登记
`fallbacks`。每个 live reviewer 只能通过 `apiKeyEnv` 引用环境变量，
不得在 JSON 中写入明文 `apiKey`。四个主审未全部得到有效结构化结果时，
V2 不会锁定模型席；同一主审先以相同配置重试一次，随后才会使用尚未占席的
预登记备用模型。

```json
{
  "version": "panel-v1",
  "primary": [
    {
      "id": "reviewer-a",
      "name": "Reviewer A",
      "kind": "openai-compatible",
      "baseUrl": "https://models.example/v1",
      "model": "model-a",
      "apiKeyEnv": "REVIEWER_A_KEY"
    }
  ],
  "arbitrator": {
    "id": "reviewer-e",
    "name": "Reviewer E",
    "kind": "anthropic",
    "baseUrl": "https://api.anthropic.com/v1/messages",
    "model": "model-e",
    "apiKeyEnv": "REVIEWER_E_KEY"
  },
  "fallbacks": []
}
```

示例为节省篇幅只展示一个 `primary`；生产配置必须提供四个身份不同的
主审。身份按 provider kind、Base URL host 与 model 的组合锁定。

配置只引用 API key 的环境变量名；密钥本身不应写入 JSON。

## Prompt 文件

所有由平台维护的模型与 Runtime prompt 已集中在 [`src/prompts.js`](./src/prompts.js)：

- `PROFESSIONAL_REVIEW_SYSTEM_PROMPT`：多模型专业度评审的 system prompt；
- `professionalReviewPrompt()`：包含复杂度背景和 Agent Card 的评审 user prompt；
- `runtimeBuildSkillPrompt()`：Claude Code、Cursor Agent 仅凭顶层 description 直出 Skill 的 prompt；
- `runtimeRunSkillPrompt()`：用相同用户原始 prompt 执行复刻 Skill 的 prompt。

用户提交的同题对测 prompt 不做改写，来源是前端表单或 `examples/use-cases.json`，后端保存在评测对象的 `cases[].prompt`。

专业度评审仍读取完整公开 Agent Card；只有“Runtime 直出 Skill”阶段执行信息隔离。`buildSkill()` 的函数签名直接接收 description 字符串，调用方无法把 Card 对象传入；本地 CLI、模型 API 与远程 adapter 也都只收到这段文本。这样比较的是“完整 Agent”与“仅凭产品描述临时生成的 Skill”，而不是在原 Agent 配置上二次增强。

## Runtime adapter 契约

高风险或多租户生产环境应把 Cursor / Claude Code 执行器放入独立隔离服务，并通过 `RUNTIME_ADAPTERS_JSON` 接入。当前受控单机部署也可在满足前述固定版本、systemd、凭据目录和最小调用验收后显式启用本地 CLI；豆包可直接使用已配置的火山方舟 endpoint：

```json
{
  "claude-code": {
    "kind": "remote-http",
    "url": "https://runtime.example.com/claude-code",
    "apiKeyEnv": "RUNTIME_API_KEY"
  },
  "cursor": {
    "kind": "remote-http",
    "url": "https://runtime.example.com/cursor",
    "apiKeyEnv": "RUNTIME_API_KEY"
  },
  "doubao": {
    "kind": "remote-http",
    "url": "https://runtime.example.com/doubao",
    "apiKeyEnv": "RUNTIME_API_KEY"
  }
}
```

构建请求：

```json
{ "action": "build_skill", "description": "Agent Card 顶层 description 原文", "inputPolicy": "description-only", "seed": 17, "temperature": 0 }
```

应返回：

```json
{ "skill": { "name": "...", "description": "...", "instructions": [], "tools": [] } }
```

运行请求：

```json
{ "action": "run_skill", "skill": {}, "prompt": "完全相同的测试 prompt" }
```

应返回：

```json
{ "output": "runtime 的可见最终结果" }
```

## 常用环境变量

所有项目配置集中在根目录 `.env`，可提交的字段模板见 [`.env.example`](./.env.example)。加载优先级为“已有进程环境变量 > 当前分支 `.env` > `ENV_FALLBACK_FILE` 共享配置 > 代码默认值”。`ENV_FILE` 可完全替换主配置文件；`ENV_FALLBACK_FILE` 适合让金融分支复用通用分支的模型与 Runtime 密钥，同时保留自己的 PandaAI 配置。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | 运行环境标识 |
| `PORT` | `4173` | HTTP 端口 |
| `DATA_FILE` | `data/evaluations.json` | 评测持久化文件 |
| `A2A_BLACK_BOX_V1_ENABLED` | `false` | 精确设为 `true` 时启用 V2 黑盒证据管线（当前含 Phase 1–2） |
| `EVIDENCE_ENCRYPTION_KEY` | 空 | V2 必需的 canonical base64 32-byte AES-256 key；只存于密钥管理或本机 `.env` |
| `EVIDENCE_ROOT` | `data/evidence` | V2 加密证据 envelope 的根目录 |
| `A2A_MULTI_TURN_ENABLED` | `true` | 精确设为 `false` 时跳过生成/执行隐藏 multi-turn 变体；提交示例自带多轮仍会执行 |
| `A2A_REPEAT_COUNT` | `3` | Phase 1/2 与 Replica 同题执行每格重复次数；正整数，非法或未设置时回退为 `3` |
| `JUDGE_PREVIEW_ACCESS_KEY` | 空 | 非盲人工评审预览 API 的 Bearer 密钥；未配置时入口保持关闭 |
| `ALLOW_PRIVATE_AGENT_URLS` | `false` | 是否为测试入口、Card 发现和正式测评 A2A 请求统一允许平台服务器可达的 localhost/私网地址；仅私人或受控部署开启 |
| `ALLOW_PRIVATE_DIAGNOSTICS_URLS` | `false` | 是否仅为 `/agent-check` 的 Card 获取和 A2A 调用允许内网/本机地址 |
| `AGENT_DIAGNOSTICS_RATE_LIMIT` | `6` | Agent 诊断每分钟的全局调用上限 |
| `AGENT_DIAGNOSTICS_CONCURRENCY` | `4` | Agent 诊断全局并发上限 |
| `PANDA_DATA_ENABLED` | `false` | 是否启用 PandaAI Quant 数据源 |
| `PANDA_DATA_AUTO_VERIFY` | `false` | 真实 benchmark 前建立参考数据快照并验真输出 |
| `PANDA_DATA_USERNAME` | 空 | 11 位手机号或 86 开头的数据服务账号，仅写入本机 `.env` |
| `PANDA_DATA_PASSWORD` | 空 | 数据服务密码，仅写入本机 `.env` |
| `PANDA_DATA_BASE_URL` | `http://pandadata.pandaaiquant.com` | Panda Data SDK 服务地址，通常无需修改 |
| `PANDA_DATA_ACCESS_KEY` | 空 | 保护本系统数据查询网关的独立 Bearer Key；为空时网关关闭 |
| `PANDA_DATA_PYTHON` | `.venv/bin/python` | 安装了 `panda_data` SDK 的项目虚拟环境 Python |
| `PANDA_DATA_TIMEOUT_MS` | `60000` | 单次 Panda Data SDK 调用时限 |
| `PANDA_DATA_MAX_ROWS` | `500` | 单次响应最多返回的记录数 |
| `PANDA_DATA_ALLOWED_METHODS` | 只读金融方法白名单 | 允许通过网关调用的 SDK 方法 |
| `OPENAI_BASE_URL` | `https://llmx.tqx.ai/v1` | OpenAI-compatible 多模型评审网关 |
| `OPENAI_API_KEY` | 空 | 网关 Key，只填写在本机 `.env` 或部署密钥中 |
| `REVIEW_MODEL_OPENAI` | `g5.4` | OpenAI 视角评审模型 |
| `REVIEW_MODEL_ANTHROPIC` | `cs4.6` | Anthropic 视角评审模型 |
| `ARK_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | 火山方舟在线推理兼容网关 |
| `ARK_API_KEY` | 空 | 豆包与 DeepSeek 共用的方舟 Key；存在时也启用豆包 Runtime |
| `REVIEW_MODEL_DOUBAO` | `ep-20260720110725-5rbml` | 豆包评审与 Runtime 共用的接入点 ID |
| `REVIEW_MODEL_DEEPSEEK` | `ep-20260708162855-pcf9x` | DeepSeek 接入点 ID |
| `MODEL_REVIEW_TIMEOUT_MS` | `180000` | 单次模型盲审超时；错误会显示模型 ID 与实际秒数 |
| `MODEL_REVIEW_MAX_TOKENS` | `1200` | 单次模型盲审最大输出 token；豆包短评分同时关闭深度思考 |
| `EVALUATION_SEED` | `20260720` | 页面未指定时使用的评测根 seed；每个阶段会派生稳定子 seed |
| `MODEL_TEMPERATURE` | `0` | 支持显式采样参数的模型温度，限制在 0–2 |
| `MODEL_REVIEWERS_JSON` | 内置四位 demo 评审 | 真实模型 adapter 高级配置 |
| `RUNTIME_ADAPTERS_JSON` | 内置三种 demo runtime | 隔离 runtime adapter 配置 |
| `ENABLE_LOCAL_CLAUDE_CODE` | `false` | 允许真实调用已登录的本机 Claude Code |
| `ENABLE_LOCAL_CURSOR_AGENT` | `false` | 允许真实调用已登录的本机 Cursor Agent CLI |
| `CURSOR_AUTH_CONFIG_HOME` | `/var/lib/agent-review/cursor-auth` | Cursor Agent 专用持久登录目录；只把 `XDG_CONFIG_HOME` 指向这里，内部文件凭据不得暴露给模型工具 |
| `CLAUDE_MAX_BUDGET_USD` | `0.25` | Claude Code 单次无头调用预算上限 |
| `LOCAL_RUNTIME_TIMEOUT_MS` | `180000` | 本地 CLI 单次执行时限 |
| `RUNTIME_PROBE_TIMEOUT_MS` | `30000` | Runtime 最小非交互就绪探针时限，上限 60 秒 |
| `CLAUDE_BACKEND` | `ark` | Claude Code 的 DeepSeek 后端：仅支持 `ark` 或 `deepseek`；缺失、未知或对应凭据不完整时失败关闭 |
| `CLAUDE_ARK_MODEL` | `ep-20260708162855-pcf9x` | Claude Code 使用的方舟 DeepSeek 接入点 |
| `DEEPSEEK_API_KEY` | 空 | 仅供 `CLAUDE_BACKEND=deepseek` 直连回退使用 |
| `DEEPSEEK_CLAUDE_MODEL` | `deepseek-v4-pro[1m]` | `CLAUDE_BACKEND=deepseek` 时的官方直连模型 |
| `ANTHROPIC_API_KEY` | 空 | 仅在 `MODEL_REVIEWERS_JSON` / `RUNTIME_ADAPTERS_JSON` 显式引用时使用；本地 Claude Runtime 不继承 |
| `CLAUDE_CODE_EFFORT_LEVEL` | `max` | 本地 Claude Runtime 的推理强度；不参与后端或凭据选择 |
| `ENV_FILE` | 项目根目录 `.env` | 从进程环境指定另一份 env 文件 |
| `ENV_FALLBACK_FILE` | 空 | 共享基础 env 文件；只补充当前分支未定义的变量 |

## Git 工作流

通用版本保留在 `codex/agent-review-platform`，金融版本在 `codex/finance-roast` 独立开发。建议后续遵循：

1. 每个功能或修复使用独立 `codex/<topic>` 分支；
2. 提交信息使用动词开头并描述用户可见结果；
3. 提交前运行 `npm run check && npm test`；
4. 不提交 `.env`、API key、运行时评测数据或用户输入产物；
5. 架构、接口或评分口径变化必须同步更新 `README.md` 和 `docs/ARCHITECTURE.md`。

## 当前边界

这是工程化 MVP，不是已经具备科学效度的排行榜。单次输出分数不代表稳定能力；真实生产评测必须增加重复运行、匿名随机排序、独立 judge、规则校验、人工抽查、成本/耗时统计和置信区间。本地 Claude/Cursor adapter 只允许在受控主机上启用：工具发布物由 root 固定、服务账户无写权限、Cursor 认证目录独立、文件工具全局拒绝且 CLI 运行在一次性目录与独立进程组中；更高风险场景应使用独立 Runtime 服务。

协议实现参考 A2A 官方 1.0 规范：`https://a2a-protocol.org/latest/specification`。
