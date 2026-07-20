# Agent 锐评系统：架构与实现说明

## 1. 系统目标

系统接收一个符合 A2A 协议的 Agent Card 与 1–5 个真实使用实例，回答三个问题：

1. 这个任务是否真的需要 Agent，还是单次模型调用就足够？
2. Agent 的领域与工程设计是否足够专业？
3. 在相同 prompt 下，提交 Agent 的可见结果能否胜过不同 runtime 根据描述现场复刻出的 skill？

平台不依赖 Agent 的内部思维链。评测证据来自公开能力声明、可见输出、可复核的评分维度和运行错误。

## 2. 总体架构

```text
Browser
  ├─ 上传 / 粘贴 / URL 发现 Agent Card
  ├─ 提交 1–5 个同题用例
  ├─ EventSource 接收实时进度
  └─ 展示必要性、专业度、对战与锐评
            │
            ▼
Node HTTP API
  ├─ A2A Validator / Client
  ├─ Complexity Scorer
  ├─ Model Reviewer Adapters
  ├─ Runtime Skill Adapters
  ├─ Output Judge
  ├─ Runtime Availability Probe
  └─ JSON Store + SSE Event Bus
            │
      ┌─────┴───────────┐
      ▼                 ▼
A2A Agent endpoint   Model / Runtime endpoints
```

当前版本刻意使用 Node.js 内置模块，不需要安装第三方依赖，降低首次运行成本。持久化默认使用 JSON 文件，写入采用同目录临时文件与原子 rename，适合单进程 MVP；生产环境应替换为 PostgreSQL，并把执行流水线放入任务队列。

运行中的评测对象使用 `activeWork` 暴露当前实际工作项，而不是让前端猜测日志：`type` 区分 protocol / review / build / benchmark，`key` 定位模型、Runtime 或选手，`caseIndex` 定位用例，`label` / `detail` / `index` / `total` 驱动局部加载状态。首次流水线和单步重试共用这套契约；成功、失败、停止或服务恢复时都会清空 `activeWork`。前端因此能在对应评审卡、Description 直出行或对测卡中显示加载扫描带，同时保留已经完成的旧结果。

### 2.1 配置加载

`src/env.js` 在服务和 DeepSeek 启动器执行实际业务模块前加载项目根目录 `.env`，不依赖第三方 dotenv 包。解析器支持注释、`export`、单/双引号和空值，但环境 JSON 配置仍要求写在单行。加载时只补充尚不存在的变量，因此进程环境、CI Secret 或容器注入值始终优先于文件值。外部进程可通过 `ENV_FILE` 指定另一份配置文件。

本机 `.env` 包含全部配置入口且被 Git 忽略；`.env.example` 只保留安全默认值和空的密钥占位，可进入版本控制。加载器不会输出变量值，API Key 也不得进入评测对象或日志。

## 3. 评测流水线

### 3.1 A2A 协议体检

`src/a2a.js` 校验：

- `name`、`description` 和至少一个 `skill`；
- 每个 skill 的 `id`、`name`、`description`；
- A2A 1.0 的 `supportedInterfaces`；
- 兼容 A2A 0.3 常见的顶层 `url` 与 `preferredTransport`。

真实调用优先选择 `supportedInterfaces` 第一项。支持 `HTTP+JSON` 的 `message:send`、A2A 1.0 JSON-RPC 的 `SendMessage` 和 0.3 JSON-RPC 的 `message/send`，再从 Message 或 Artifact 的 parts 中提取文本结果。

A2A 1.0 JSON-RPC 使用 `SendMessage`，0.3 兼容调用使用 `message/send`。HTTP+JSON 则在 Agent Card 声明的接口基址后调用 `message:send`。示例服务覆盖即时 `Message` 与包含 `Artifact` 的 `Task` 两类响应。

### 3.1.1 提交与发现策略

平台区分“Agent Card 如何进入平台”和“A2A 如何发现 Agent”：

1. JSON 文件上传与文本粘贴会直接校验 Card，属于 A2A 的直接配置场景；
2. Agent Card URL 直接获取指定 JSON，适合自定义路径或网关；
3. 服务根地址会严格解析为同一 origin 下的 `/.well-known/agent-card.json`；
4. 企业 Registry 是合理扩展，但 A2A 当前没有规定统一的 Registry API，因此本版本只预留产品入口，不伪造协议；
5. Git 仓库、源码包和镜像属于平台托管部署输入，不是 A2A discovery。生产实现必须在沙箱部署成功后，再按 Agent Card 和 endpoint 进入相同评测流水线。

远程发现拒绝重定向，限制响应为 1 MB，并复用 Agent URL 的 SSRF 防护。生产环境还需要 DNS 解析后的地址复核与域名 allowlist。

### 3.2 Agent 必要性评分

复杂度评分为五个可解释维度的等权平均：

| 维度 | 关注内容 |
|---|---|
| 步骤深度 | 是否存在规划、多步执行、重试或顺序依赖 |
| 工具依赖 | 是否必须访问文件、浏览器、API 或数据库；是否需要跨文档核对 |
| 状态与分支 | 是否包含异步、记忆、人机确认或条件分支 |
| 不确定性 | 是否需要澄清、判断和失败恢复 |
| 复用价值 | 固定流程是否会高频重复并获得稳定性收益 |

阈值：低于 36 判定“模型直出更划算”；36–59 判定“Agent 价值存疑”；60 以上判定“值得 Agent 化”。当前实现是透明的启发式初筛，生产版可用标注数据训练校准器，但不应只用另一个大模型的主观结论替代结构化信号。

### 3.3 多模型专业度盲审

每个模型独立返回总分、评语、主要风险，并评价：

- 领域深度；
- 流程设计；
- 异常处理；
- 输出契约；
- 可评测性。

模型调用失败不会中止整场评测，失败评审会保留错误且不进入专业度平均分。OpenAI 与 Anthropic 默认通过 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 接入 LLMX；豆包与 DeepSeek 通过 `ARK_BASE_URL` / `ARK_API_KEY` 接入火山方舟在线推理，分别使用独立 endpoint ID。豆包评审属于短结构化评分，Chat Completions 请求设置 `thinking.type=disabled` 并受 `MODEL_REVIEW_MAX_TOKENS` 限制，避免为短 JSON 生成长推理；超时由 `MODEL_REVIEW_TIMEOUT_MS` 统一控制。任一网关未配置 Key 时，只把对应模型降级为演示评审，其余已配置模型仍可真实运行。`MODEL_REVIEWERS_JSON` 可覆盖为任意数量的 OpenAI-compatible 或 Anthropic Messages API。

模型评审、Runtime 构建 Skill 和 Runtime 执行 Skill 的 prompt 集中在 `src/prompts.js`。Runtime 构建要求单个 JSON 对象，但平台不会假设 CLI 永远严格服从格式：`safeJson()` 会从代码围栏或前后说明文字中提取第一个完整、可解析的平衡 JSON 值，随后再校验 Skill 的 `name`、`description`、`instructions` 和 `tools` 契约。这避免 Claude Code 或 Cursor Agent 输出简短前言时被误判为 0 分。

### 3.4 Runtime description-only 现场直出

`src/runtimes.js` 当前声明 Claude Code、Cursor Agent、Doubao Agent 三个 adapter。Runtime 构建边界只接收 Agent Card 顶层 `description` 字符串，再生成统一结构的 skill：名称、描述、指令、工具和 fingerprint。完整 Card 只用于协议校验、必要性与专业度评审，以及调用提交 Agent；它不会跨入复刻边界。

这道 description-only 信息防火墙同时存在于四层：流水线调用 `buildSkill(runtime, item.agentCard.description, ...)`；`buildSkill()` 拒绝非字符串输入；本地 CLI / 模型 API prompt 只插入 description；远程 adapter 请求体只发送 `description` 与 `inputPolicy`，不含 `agentCard`。因此 Runtime 看不到 name、skills、examples、tags、capabilities、接口地址和提交 Agent 输出。

演示模式会生成确定性 skill 与输出。真实模式按优先级使用 `RUNTIME_ADAPTERS_JSON` 外部隔离服务、显式启用的本地 Claude/Cursor CLI，或火山方舟豆包 model API。所有实现只接收平台生成的 prompt，不执行用户提交的 shell 命令。

开发机也支持显式启用本地 CLI adapter。Claude Code 被限制为无工具、plan、安全模式和单次预算；Cursor Agent 被限制为 ask/read-only 与内置 sandbox。两个 CLI 都在随机临时目录执行，不接触仓库文件。只有安装、登录和环境开关同时满足时，Runtime Probe 才显示 `READY`。生产环境仍应使用远程容器 adapter，本地 CLI 仅用于受信任开发机验收。

Claude Code 默认通过火山方舟 DeepSeek endpoint 运行。由于方舟在线推理是 OpenAI Chat Completions 协议，而 Claude Code 是 Anthropic Messages 协议，`src/ark-anthropic-proxy.js` 会为单次 CLI 调用启动仅监听 loopback 随机端口的短生命周期协议桥。桥接器负责消息块、非流式响应、合成 SSE 事件和 token-count 请求的转换；方舟 Key 仅由父进程持有，不传入 Claude 子进程。无头调用通过 `--system-prompt` 覆盖 Claude Code 默认代码代理提示，明确禁止 Bash、Explore、子代理等虚构工具调用。`CLAUDE_BACKEND=deepseek` 仍可回退到 DeepSeek 官方 Anthropic-compatible endpoint。

Doubao Runtime 不要求本机存在 `doubao` CLI。当 `ARK_BASE_URL`、`ARK_API_KEY` 与 `REVIEW_MODEL_DOUBAO` 同时存在时，它会通过方舟 Chat Completions API 先构建结构化 Skill，再使用完全相同的用户 prompt 执行该 Skill；Runtime Probe 此时直接显示 `READY`。

#### Skill 目录快照

Runtime 构建阶段的跨执行器契约是结构化 Skill JSON，而不是允许 CLI 在宿主项目中任意写文件。详情接口会把该次评测实际使用的结构化产物确定性地标准化为一个只读、可移植目录：

```text
<skill-name>/
├── SKILL.md                       人类可读的用途、边界、执行流程与工具声明
├── skill.json                     Runtime 返回并通过校验的原始结构化 Skill
├── references/source-description.txt  构建时唯一可见的任务描述原文
└── .agent-roast/manifest.json         Runtime、输入策略、模型、模式、adapter、seed 与 fingerprint
```

这个目录是规范化产物快照，不冒充已被清理的 CLI 临时工作区，也不会暴露完整 Agent Card、环境变量、认证头或 API Key。新产物在 manifest 中记录 `inputPolicy: description-only`。信息防火墙上线前的旧评测缺少该字段，详情接口会增加 `references/legacy-input-warning.txt` 并在前端警告“不能作为公平基线”，用户必须“重建并对测”后才能得到合规基线。前端使用目录树和带行号的只读预览展示；文件内容进入 DOM 前统一 HTML 转义。

### 3.5 同 prompt 对测与锐评分档

每个用例同时发送给：

- 用户提交的 A2A Agent；
- Claude Code description 直出 skill；
- Cursor description 直出 skill；
- Doubao description 直出 skill。

当前 output judge 使用任务完成、证据、结构与可用性四维启发式打分。生产版应使用独立 judge 模型、规则校验器和人工抽检，并随机化选手顺序以减少位置偏差。复杂度信号会区分“只整理文件”与“跨文件核对、风险取证、人工确认”：出现文件本身不会自动证明 Agent 必要性。

最终只使用四个分档：

- 必要性低于 36，单次模型已经足够：`拉`；
- 提交 Agent 比 Claude Code 基线高至少 3 分：`夯`；
- 提交 Agent 不低于 Claude Code、但领先少于 3 分：`人上人`；
- 提交 Agent 低于 Claude Code、但不低于豆包基线：`NPC`；
- 提交 Agent 低于豆包基线：`拉`。

### 3.6 单步重试与派生结果重算

只有 `completed`、`failed`、`cancelled`、`interrupted` 终态允许发起单步重试，避免主流水线和复核任务同时修改同一评测。重试分为三类：

- `review`：只重新调用指定评审模型，原位替换该模型结果；
- `build`：重新生成指定 Runtime Skill，并自动用新 Skill 重新执行全部同 Prompt 对测用例；
- `benchmark`：只重跑指定用例中的指定选手，适合处理单次网络或模型抖动。

执行期间评测状态改为 `retrying`，复用 SSE、日志和停止机制。旧结果会保持可见，直到新结果返回；随后相同 `key` 的结果被替换而不是追加。平台再从事实结果重新派生 `professional`、`averages`、`coverage`、`overallMode` 和 `roast`，因此等级与判词不会沿用过期缓存。

每次尝试写入 `retryHistory`，记录步骤类型、目标 key、用例索引、开始时间、耗时以及前后结果摘要，最多保留最近 100 条。意外异常会恢复重试前状态；用户停止则进入 `cancelled` 并保留已落盘产物。服务启动时也会把遗留 `retrying` 状态恢复为 `interrupted`。

### 3.7 可复现 seed

创建评测时可传入 `seed`；未传时使用 `EVALUATION_SEED`，再回退到 `20260720`。评测对象会持久化根 seed 和 temperature，避免运行期间环境变量变化导致同一任务前后采样配置不一致。平台不会把同一个整数机械地发给所有调用，而是按照以下 scope 派生稳定子 seed：

- `review:<reviewerId>`：单模型专业度评审；
- `build:<runtimeId>`：Runtime Skill 构建；
- `run:<caseIndex>:<runtimeId>`：指定 Skill 的指定用例执行；
- `judge:<caseIndex>:<competitorId>`：平台输出评分中的稳定扰动。

OpenAI-compatible 模型、方舟模型 API 和 Claude Code 的 Ark 协议桥会发送标准 `seed` 字段；远程 Runtime adapter 请求也携带 `seed` 与 `temperature`。原生 Anthropic Messages、Cursor Agent CLI、DeepSeek Anthropic-compatible CLI 链路以及用户提供的 A2A Agent 可能没有 seed 能力，因此系统将该能力标为 best-effort。固定 seed 只降低采样抖动，不能抵消模型版本、服务端实现或外部数据变化。

## 4. 数据与接口

### `POST /api/evaluations`

```json
{
  "mode": "demo",
  "seed": 20260720,
  "agentCard": {},
  "cases": [
    { "name": "案例名称", "prompt": "完全原始的用户 prompt" }
  ]
}
```

返回 `202` 与评测对象。后端在当前进程异步执行流水线。

### `POST /api/agent-cards/resolve`

```json
{
  "sourceType": "service-url",
  "url": "https://agent.example.com"
}
```

`service-url` 会读取标准 well-known 地址；`card-url` 会读取指定 URL。返回解析后的 Card、最终解析地址和协议校验结果。

### `GET /api/evaluations/:id`

返回评测快照，包括 `progress`、`stage`、`logs`、各阶段结果和最终锐评。

### `GET /api/evaluations/:id/builds/:runtimeId/skill`

返回指定 Runtime 直出结果的标准化 Skill 目录快照，包含 `root`、`source`、`inputPolicy`、`legacyBaseline` 与 `files[]`；每个文件提供相对 `path`、`language` 和完整 `content`。不存在的评测或 Runtime 返回 `404`，构建失败或无 Skill 产物返回 `409`。该接口只接受已落入评测记录的 runtimeId，不读取客户端指定的磁盘路径，也不返回完整 Agent Card。

### `GET /api/evaluations/:id/events`

SSE 流。每次数据事件都是完整评测快照，客户端断线后可直接用 GET 恢复，不依赖事件增量。流水线在每位模型评审、每个 Runtime Skill 以及每个同题选手完成时更新 `professional.reviews`、`builds` 或 `benchmark[].entries`，前端可以立即渲染阶段产物。

### `POST /api/evaluations/:id/cancel`

幂等停止接口。运行中或重试中的任务，其 `AbortController` 会传播到模型 fetch、A2A fetch、本地 Claude/Cursor 子进程和方舟协议桥；状态更新为 `cancelled`，已持久化的阶段结果不删除。服务启动时还会把历史遗留的 `queued/running/retrying` 记录转为 `interrupted`，避免进程已消失而 UI 仍显示运行。

### `POST /api/evaluations/:id/retry`

返回 `202` 并异步执行一个精确复核步骤。请求示例：

```json
{ "type": "review", "key": "gpt" }
```

```json
{ "type": "build", "key": "claude-code" }
```

```json
{ "type": "benchmark", "key": "submitted", "caseIndex": 0 }
```

可用的评审 key 来自评审配置 `id`；Runtime/对测 key 为 `claude-code`、`cursor`、`doubao`，提交 Agent 的对测 key 为 `submitted`。主任务非终态时返回 `409`，目标不存在或参数无效时返回 `400`。进度继续通过原 SSE 接口推送。

### `DELETE /api/evaluations/:id`

永久删除一条历史评测及其阶段结果。只有 `completed`、`failed`、`cancelled`、`interrupted` 终态记录可以删除；`queued`、`running`、`retrying` 返回 `409`，用户必须先停止任务。前端采用 3.5 秒内二次点击确认，删除当前正在查看的记录后自动回到评测首页。

### 其他接口

- `GET /api/health`：健康检查；
- `GET /api/runtimes`：探测本机 CLI 是否存在，并区分是否已配置为可执行 adapter；
- `GET /api/evaluations`：历史评测摘要。

前端对模型评语进行安全的结构化呈现：所有内容先 HTML 转义，再保留自然段、单换行、无序列表与编号列表。最终判词属于短标题，会先把来源中的换行折叠为空格，再交给浏览器按完整可用列宽平衡换行，避免固定字符宽度造成中文过早断行和右侧大面积留白。最终锐评首次渲染时，页面先平滑定位到判词区域，滚动结束或达到兜底时间后才触发盖章和计数动画；重新打开已完成的历史记录也遵循同一顺序，`prefers-reduced-motion` 下改为即时定位。

### 可观察性日志

每条日志至少包含 `at`、`level`、`source`、`phase`、`text` 与 `mode`；可选包含脱敏后的 `detail` 和 `durationMs`。其中 `mode` 明确区分 `live`、`demo`、`rules` 与 `failed`，前端不会把混合评测展示成全真实。

SSE 发送完整评测快照，因此断线重连后日志不会丢失。URL 日志只记录协议、host 与 path，不记录查询参数、认证头或密钥。前端 Trace Console 展示最近 80 条，并且只在用户已经停留底部时自动跟随。

## 5. 安全边界

- 请求体限制为 1 MB；前端也限制上传文件大小。
- A2A endpoint 只允许 HTTP(S)。
- 默认拒绝 localhost、`.local` 与常见私有 IPv4 地址，减少 SSRF 风险；开发环境可显式设置 `ALLOW_PRIVATE_AGENT_URLS=true`。
- Runtime 使用受限本地 CLI、方舟模型 API 或远程 HTTP adapter，均不执行用户提交的命令。
- API key 只从环境变量读取，不写入评测记录或返回前端。
- 生产版仍需补充 DNS 重绑定防护、出网 allowlist、容器隔离、租户鉴权、配额、审计日志和敏感输出脱敏。

## 6. 代码结构

```text
.
├── server.js               HTTP API、SSE 与静态文件服务
├── .env.example            可提交的完整环境变量模板
├── src/
│   ├── env.js              零依赖 .env 解析、优先级与加载
│   ├── ark-anthropic-proxy.js 方舟 OpenAI API 到 Anthropic Messages 的本地协议桥
│   ├── claude-env.js       Claude Code 的 Ark / DeepSeek 环境映射
│   ├── a2a.js              Agent Card 校验、binding 选择和 A2A client
│   ├── pipeline.js         评测、单步复核、派生结果重算与容错状态机
│   ├── prompts.js          模型评审、Skill 构建与同题执行 prompt
│   ├── providers.js        多模型评审 adapter
│   ├── runtimes.js         Skill 构建、目录快照与 runtime 执行 adapter
│   ├── scoring.js          必要性、输出与最终分档规则
│   ├── store.js            JSON 持久化
│   └── utils.js            ID、数值、请求体等通用工具
├── public/
│   ├── index.html          单页应用语义结构
│   ├── methodology.html    可在网页查看的完整评分规则说明书
│   ├── methodology.css     规则页面的审计式布局与响应式样式
│   ├── styles.css          视觉系统与响应式布局
│   └── app.js              表单、SSE、路由、历史与报告渲染
├── examples/               示例 A2A Agent Card
│   ├── agents/server.js    三个可真实调用的本地 A2A 服务
│   ├── submissions/        三种协议/复杂度样本 Card
│   └── use-cases.json      Prompt 与结构化验收点
├── scripts/
│   ├── real-demo.js        同时启动平台与本地 Agent
│   ├── deepseek-demo.js    使用 DeepSeek/Ark 配置启动真实 Runtime 演示
│   └── check-syntax.js     自动检查仓库内全部 JavaScript 文件语法
├── test/                   Node 原生单元与 API 测试
└── docs/
    ├── ARCHITECTURE.md     架构与实现文档
    ├── SCORING.md          打分公式、阈值、失败处理与分档顺序
    └── CODE_REVIEW.md      全仓审查结果、剩余风险与实施优先级
```

## 7. 生产化路线

1. 把内存流水线迁移到 Redis/BullMQ 或云任务队列，支持重启恢复与并发控制。
2. 把 JSON Store 替换为 PostgreSQL，对评测、case、run、artifact、score 单独建表。
3. 对每次运行创建无网络或受控网络的短生命周期容器，记录镜像与依赖摘要。
4. 使用独立 judge 模型做成对比较，并加入规则检查、人工复核与评审一致性指标。
5. 给 Agent 输出和 runtime 输出做匿名化与随机排序，减轻模型品牌偏差。
6. 引入可重复运行、置信区间、成本、耗时、成功率和污染检测，不用单次分数冒充稳定结论。
