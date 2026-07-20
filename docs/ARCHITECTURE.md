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

当前版本刻意使用 Node.js 内置模块，不需要安装第三方依赖，降低首次运行成本。持久化默认使用 JSON 文件，适合单机 MVP；生产环境应替换为 PostgreSQL，并把执行流水线放入任务队列。

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

模型调用失败不会中止整场评测，失败评审会保留错误且不进入专业度平均分。`MODEL_REVIEWERS_JSON` 可配置 OpenAI-compatible 或 Anthropic Messages 风格的 API。

### 3.4 Runtime 现场复刻

`src/runtimes.js` 当前声明 Claude Code、Cursor Agent、Doubao Agent 三个 adapter。每个 adapter 只拿到相同的 Agent Card，不拿提交 Agent 的实现，再生成统一结构的 skill：名称、描述、指令、工具和 fingerprint。

演示模式会生成确定性 skill 与输出；真实模式通过 `RUNTIME_ADAPTERS_JSON` 调用外部隔离 runtime 服务。这样 Web 服务本身不会直接执行用户提供的 shell 命令，避免远程代码执行。

开发机也支持显式启用本地 CLI adapter。Claude Code 被限制为无工具、plan、安全模式和单次预算；Cursor Agent 被限制为 ask/read-only 与内置 sandbox。两个 CLI 都在随机临时目录执行，不接触仓库文件。只有安装、登录和环境开关同时满足时，Runtime Probe 才显示 `READY`。生产环境仍应使用远程容器 adapter，本地 CLI 仅用于受信任开发机验收。

Claude Code 也可以使用 DeepSeek 官方 Anthropic-compatible endpoint。`scripts/deepseek-demo.js` 只从父进程读取 `DEEPSEEK_API_KEY`，在内存中映射为 `ANTHROPIC_AUTH_TOKEN`，并把 base URL 固定为 `https://api.deepseek.com/anthropic`。这种方式无需 Claude OAuth；Runtime Probe 会把进程内 token 视为已认证。脚本不持久化 Key，日志也不记录环境变量或请求头。

### 3.5 同 prompt 对测与锐评分档

每个用例同时发送给：

- 用户提交的 A2A Agent；
- Claude Code 复刻 skill；
- Cursor 复刻 skill；
- Doubao 复刻 skill。

当前 output judge 使用任务完成、证据、结构与可用性四维启发式打分。生产版应使用独立 judge 模型、规则校验器和人工抽检，并随机化选手顺序以减少位置偏差。复杂度信号会区分“只整理文件”与“跨文件核对、风险取证、人工确认”：出现文件本身不会自动证明 Agent 必要性。

最终分档：

- 必要性低于 36：`大炮打蚊子`；
- 提交 Agent 比 Claude Code 基线高至少 3 分：`夯`；
- 提交 Agent 低于豆包基线：`拉完了`；
- 其余：`有点东西，但不多`。

## 4. 数据与接口

### `POST /api/evaluations`

```json
{
  "mode": "demo",
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

### `GET /api/evaluations/:id/events`

SSE 流。每次数据事件都是完整评测快照，客户端断线后可直接用 GET 恢复，不依赖事件增量。

### 其他接口

- `GET /api/health`：健康检查；
- `GET /api/runtimes`：探测本机 CLI 是否存在，并区分是否已配置为可执行 adapter；
- `GET /api/evaluations`：历史评测摘要。

### 可观察性日志

每条日志至少包含 `at`、`level`、`source`、`phase`、`text` 与 `mode`；可选包含脱敏后的 `detail` 和 `durationMs`。其中 `mode` 明确区分 `live`、`demo`、`rules` 与 `failed`，前端不会把混合评测展示成全真实。

SSE 发送完整评测快照，因此断线重连后日志不会丢失。URL 日志只记录协议、host 与 path，不记录查询参数、认证头或密钥。前端 Trace Console 展示最近 80 条，并且只在用户已经停留底部时自动跟随。

## 5. 安全边界

- 请求体限制为 1 MB；前端也限制上传文件大小。
- A2A endpoint 只允许 HTTP(S)。
- 默认拒绝 localhost、`.local` 与常见私有 IPv4 地址，减少 SSRF 风险；开发环境可显式设置 `ALLOW_PRIVATE_AGENT_URLS=true`。
- Runtime 通过 HTTP adapter 接入，不在主服务执行用户命令。
- API key 只从环境变量读取，不写入评测记录或返回前端。
- 生产版仍需补充 DNS 重绑定防护、出网 allowlist、容器隔离、租户鉴权、配额、审计日志和敏感输出脱敏。

## 6. 代码结构

```text
.
├── server.js               HTTP API、SSE 与静态文件服务
├── src/
│   ├── a2a.js              Agent Card 校验、binding 选择和 A2A client
│   ├── pipeline.js         评测状态机与容错编排
│   ├── providers.js        多模型评审 adapter
│   ├── runtimes.js         Skill 构建与 runtime 执行 adapter
│   ├── scoring.js          必要性、输出与最终分档规则
│   ├── store.js            JSON 持久化
│   └── utils.js            ID、数值、请求体等通用工具
├── public/
│   ├── index.html          单页应用语义结构
│   ├── styles.css          视觉系统与响应式布局
│   └── app.js              表单、SSE、路由、历史与报告渲染
├── examples/               示例 A2A Agent Card
│   ├── agents/server.js    三个可真实调用的本地 A2A 服务
│   ├── submissions/        三种协议/复杂度样本 Card
│   └── use-cases.json      Prompt 与结构化验收点
├── scripts/real-demo.js    同时启动平台与本地 Agent
├── test/                   Node 原生单元与 API 测试
└── docs/                   架构与实现文档
```

## 7. 生产化路线

1. 把内存流水线迁移到 Redis/BullMQ 或云任务队列，支持重启恢复与并发控制。
2. 把 JSON Store 替换为 PostgreSQL，对评测、case、run、artifact、score 单独建表。
3. 对每次运行创建无网络或受控网络的短生命周期容器，记录镜像与依赖摘要。
4. 使用独立 judge 模型做成对比较，并加入规则检查、人工复核与评审一致性指标。
5. 给 Agent 输出和 runtime 输出做匿名化与随机排序，减轻模型品牌偏差。
6. 引入可重复运行、置信区间、成本、耗时、成功率和污染检测，不用单次分数冒充稳定结论。
