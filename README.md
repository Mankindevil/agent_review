# 锐评局：A2A Agent 公开评测系统

一个可直接运行的全栈 MVP。用户提交 A2A Agent Card 和真实 prompt 后，平台依次判断 Agent 必要性、进行多模型专业度盲审、让不同 runtime 根据描述现场复刻 skill，再把所有选手放进同 prompt 竞技场，最终给出“夯 / 人上人 / NPC / 拉”的证据化锐评。

## 已实现功能

- A2A 1.0 Agent Card 校验，兼容 0.3 顶层 `url` 形态；
- 文件拖拽、文件选择、JSON 粘贴、Agent Card URL 与服务根地址自动发现；
- 1–5 个同 prompt 测试用例；
- Agent 必要性五维评分与明确判断；
- OpenAI、Anthropic、豆包、DeepSeek 四个模型视角的独立评分、评语和风险；
- Claude Code、Cursor、Doubao 三种 runtime 的 skill 现场复刻抽象；
- 提交 Agent 与三个复刻 skill 的逐用例输出和分数对比；
- SSE 实时进度：复杂度、每位模型评语、每个 Runtime Skill 和每位对测选手完成后立即展示；
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

详细实现与接口见 [架构文档](./docs/ARCHITECTURE.md)，逐项公式和阈值见 [评测与打分规则](./docs/SCORING.md)，当前技术债和实施优先级见 [全仓代码审查](./docs/CODE_REVIEW.md)。项目启动后也可以直接打开 `http://localhost:4173/methodology.html`，或点击顶部“评测规则”。

## 快速启动

要求 Node.js 20 或更高版本。

```bash
test -f .env || cp .env.example .env
npm start
```

项目会在启动时自动读取根目录 `.env`；当前工作区已经生成该文件，首次克隆时可用上面的命令从模板创建。系统或终端中已经存在的同名环境变量优先级更高，便于 CI、容器和临时命令覆盖。

打开 `http://localhost:4173`，选择任一“本地真实样本”，再点击“送进评测舱”即可体验演示评测。

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

Runtime Probe 与“现场复刻记录”会显示实际后端：Ark 模式下展示方舟 DeepSeek endpoint ID，不再把它误标为 Claude Sonnet。

Key 只应写入本机 `.env` 或密钥管理系统，不要写入 `.env.example`。如需恢复 DeepSeek 官方 Anthropic-compatible API，可设置 `CLAUDE_BACKEND=deepseek` 并填写 `DEEPSEEK_API_KEY`。

本地 Runtime 使用只读模式：Claude Code 采用 `--tools "" --permission-mode plan --safe-mode`，Cursor Agent 采用 `--mode ask --sandbox enabled`。每次调用都在独立临时目录运行并在结束后删除。Claude 单次调用默认设置 `$0.25` 预算上限，可通过 `CLAUDE_MAX_BUDGET_USD` 调整。

随后在页面选择样本，把评测模式切换为“真实对测”。三个 Agent 分别监听：

- `http://127.0.0.1:4181`：文件收纳员，A2A 1.0 HTTP+JSON；
- `http://127.0.0.1:4182`：合同风险猎手，A2A 1.0 JSON-RPC；
- `http://127.0.0.1:4183`：生产事故指挥官，A2A 0.3 JSON-RPC 兼容样本。

每个服务都在 `/.well-known/agent-card.json` 暴露 Agent Card。也可以只运行示例 Agent：

```bash
npm run agents
```

检查与测试：

```bash
npm run check
npm test
```

## 演示模式与真实模式

演示模式默认可用。它会完整执行协议校验、必要性打分、多模型评语、skill 构建、同题对测和最终分档，但模型与 runtime 输出是基于输入确定生成的模拟数据。界面和结果对象均标记 `DEMO`，不会伪装成真实线上调用。

真实模式会：

1. 调用 Agent Card 声明的 A2A endpoint；
2. 调用 LLMX、火山方舟或 `MODEL_REVIEWERS_JSON` 配置的评审模型；
3. 调用显式启用的本机 Claude/Cursor、方舟豆包或 `RUNTIME_ADAPTERS_JSON` 隔离服务复刻 Skill。

如果未配置真实 adapter，相关项会保留为 demo；调用失败会记录错误并继续执行其余选手。

运行页不会等待最终锐评才出报告。后端在每位评审、每个 Runtime 和每个同题选手结束时持久化完整快照并通过 SSE 推送；前端按“跑完一项，解锁一项”持续追加阶段产物。运行中的评测可点击“停止本次评测”，后端会通过 `AbortController` 中止当前 HTTP 请求或 CLI 子进程，并保留已经完成的结果。若服务在任务期间重启，遗留的 `queued/running` 记录会被标记为 `interrupted`，不再显示假运行。

评测结束后，每张模型评审卡可“重跑该模型”，每条 Runtime 构建记录可“重建并回放”，每个同题选手可“重跑这一局”。Runtime 重建会自动用新 Skill 回放全部已有测试用例，避免构建物与对战输出版本不一致。重试期间状态为 `retrying`，仍可停止；完成后新结果原位替换旧结果，平台重新计算专业度、四方实战均分、覆盖模式与最终“夯 / 人上人 / NPC / 拉”，并将前后摘要写入 `retryHistory`。

提交页的 `SEED` 默认是 `20260720`。同一个 seed 会为每位评审、每个 Runtime 构建和每个“用例 × 选手”派生不同但稳定的整数 seed；单步重试继续使用原来的子 seed。OpenAI-compatible、方舟豆包以及 Claude Code 的方舟协议桥会实际发送 `seed`，同时默认把 `temperature` 设为 `0`。原生 Anthropic Messages、Cursor Agent CLI 与用户提交的外部 A2A Agent 不保证支持 seed，因此这是“尽力确定性”，不能承诺底层服务升级、并发调度或模型权重变化后逐字节一致。

“本机已安装”不等于“平台已真实调用”。`GET /api/runtimes` 会分别检查 Claude/Cursor 的 CLI、鉴权与启用开关；豆包既可以来自 `doubao` CLI，也可以在 `ARK_BASE_URL`、`ARK_API_KEY` 和豆包 endpoint 同时存在时直接使用方舟 API。远程隔离 adapter 仍可通过 `RUNTIME_ADAPTERS_JSON` 覆盖。主服务不会把 Cursor Desktop 的 `cursor` 命令误认成 `cursor-agent`。

## A2A 提交方式

| 页面入口 | 输入内容 | 适用场景 | 是否属于 A2A 标准发现 |
|---|---|---|---|
| 文件 / JSON | `.json`、`.a2a.json` 文件 | 评审草稿、离线或内网 Agent Card | 直接配置 |
| 文件 / JSON | 粘贴完整 Agent Card | 调试与快速修改 | 直接配置 |
| Card URL | Agent Card JSON 的完整 URL | Card 不在标准路径或由网关托管 | 直接配置 URL |
| 服务地址发现 | 例如 `https://agent.example.com` | 公开 Agent 的标准自动发现 | `/.well-known/agent-card.json` |
| Registry（规划中） | 企业目录中的 Agent ID | 大规模治理、权限与目录检索 | Registry API 尚未由 A2A 统一规定 |

源码压缩包、Git 仓库、Docker 镜像不是 A2A 规定的发现形式。后续可以把它们作为“托管验收”入口：平台先在隔离环境部署，再要求部署结果暴露 Agent Card 与 A2A endpoint。认证信息同样不放入 Agent Card；私有 Agent 应通过独立的凭据引用或企业密钥管理接入。

### 示例资产

- `examples/submissions/`：三份可直接上传的 Agent Card；
- `examples/use-cases.json`：每个 Agent 的真实 prompt 和验收点；
- `examples/agents/server.js`：三个实际提供 well-known discovery 与 A2A 调用接口的本地服务。

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

配置只引用 API key 的环境变量名；密钥本身不应写入 JSON。

## Prompt 文件

所有由平台维护的模型与 Runtime prompt 已集中在 [`src/prompts.js`](./src/prompts.js)：

- `PROFESSIONAL_REVIEW_SYSTEM_PROMPT`：多模型专业度评审的 system prompt；
- `professionalReviewPrompt()`：包含复杂度背景和 Agent Card 的评审 user prompt；
- `runtimeBuildSkillPrompt()`：Claude Code、Cursor Agent 现场复刻 Skill 的 prompt；
- `runtimeRunSkillPrompt()`：用相同用户原始 prompt 执行复刻 Skill 的 prompt。

用户提交的同题对测 prompt 不做改写，来源是前端表单或 `examples/use-cases.json`，后端保存在评测对象的 `cases[].prompt`。

## Runtime adapter 契约

生产环境中的 Cursor / Claude Code 等执行器应运行在独立隔离服务中，Web 服务通过 `RUNTIME_ADAPTERS_JSON` 指向它们。开发机可显式启用受限的本地 CLI；豆包也可直接使用已配置的火山方舟 endpoint：

```json
{
  "claude-code": {
    "url": "https://runtime.example.com/claude-code",
    "apiKeyEnv": "RUNTIME_API_KEY"
  },
  "cursor": {
    "url": "https://runtime.example.com/cursor",
    "apiKeyEnv": "RUNTIME_API_KEY"
  },
  "doubao": {
    "url": "https://runtime.example.com/doubao",
    "apiKeyEnv": "RUNTIME_API_KEY"
  }
}
```

构建请求：

```json
{ "action": "build_skill", "agentCard": {} }
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

所有项目配置集中在根目录 `.env`，可提交的字段模板见 [`.env.example`](./.env.example)。加载优先级为“已有进程环境变量 > `.env` > 代码默认值”；需要使用另一份文件时，在启动进程中设置绝对路径 `ENV_FILE=/path/to/custom.env`。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | 运行环境标识 |
| `PORT` | `4173` | HTTP 端口 |
| `DATA_FILE` | `data/evaluations.json` | 评测持久化文件 |
| `ALLOW_PRIVATE_AGENT_URLS` | `false` | 是否允许 localhost/私网 Agent URL，仅建议本地开发开启 |
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
| `CLAUDE_MAX_BUDGET_USD` | `0.25` | Claude Code 单次无头调用预算上限 |
| `LOCAL_RUNTIME_TIMEOUT_MS` | `180000` | 本地 CLI 单次执行时限 |
| `CLAUDE_BACKEND` | `ark` | Claude Code 的 DeepSeek 后端：`ark` 或 `deepseek` |
| `CLAUDE_ARK_MODEL` | `ep-20260708162855-pcf9x` | Claude Code 使用的方舟 DeepSeek 接入点 |
| `DEEPSEEK_API_KEY` | 空 | 仅供 `CLAUDE_BACKEND=deepseek` 直连回退使用 |
| `DEEPSEEK_CLAUDE_MODEL` | `deepseek-v4-pro[1m]` | DeepSeek 官方直连回退模型 |
| `ANTHROPIC_*` / `CLAUDE_CODE_*` | 见模板 | Anthropic-compatible endpoint 与 Claude Code 模型映射 |
| `ENV_FILE` | 项目根目录 `.env` | 从进程环境指定另一份 env 文件 |

## Git 工作流

项目使用 `codex/agent-review-platform` 功能分支开发。建议后续遵循：

1. 每个功能或修复使用独立 `codex/<topic>` 分支；
2. 提交信息使用动词开头并描述用户可见结果；
3. 提交前运行 `npm run check && npm test`；
4. 不提交 `.env`、API key、运行时评测数据或用户输入产物；
5. 架构、接口或评分口径变化必须同步更新 `README.md` 和 `docs/ARCHITECTURE.md`。

## 当前边界

这是工程化 MVP，不是已经具备科学效度的排行榜。单次输出分数不代表稳定能力；真实生产评测必须增加重复运行、匿名随机排序、独立 judge、规则校验、人工抽查、成本/耗时统计和置信区间。本地 Claude/Cursor adapter 仅用于受信任开发机，使用只读参数和随机临时目录；生产环境仍应改用隔离 runtime 服务。

协议实现参考 A2A 官方 1.0 规范：`https://a2a-protocol.org/latest/specification`。
