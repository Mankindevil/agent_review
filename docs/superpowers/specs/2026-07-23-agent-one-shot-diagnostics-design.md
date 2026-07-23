# 一次性 Agent 诊断平台设计

## 目标

为金融 Agent 锐评项目新增独立诊断页面。持有平台访问密钥的用户提交 A2A 服务地址、可选 Agent Bearer Token 和测试 Prompt 后，平台在一次 HTTP 请求内完成发现、校验和普通调用；用户可额外选择流式调用。诊断立即返回结构化结果，不创建评测记录、不进入历史列表、不写入磁盘。

诊断调用是真实的 A2A 调用，不是模拟或只读探测。普通调用执行一次 Prompt；流式检查会再次执行同一 Prompt，因此默认关闭，并要求用户显式确认。

## 设计选择

采用“受访问密钥保护的同步诊断管线”：

- 保留一次请求返回完整报告的体验，不引入任务队列和诊断历史。
- 由应用自身校验平台访问密钥，不依赖反向代理提供鉴权。
- 抽取现有 A2A 协议能力，避免诊断模块复制一套逐渐漂移的实现。
- 所有出站请求都经过统一安全传输层，负责 DNS/IP 校验、地址固定、超时、取消和字节限制。

不采用异步任务制，因为它会引入任务状态与持久化语义；不只依赖反向代理鉴权，因为这无法保证不同部署环境具备相同安全边界。

## 用户流程

1. 用户打开 `/agent-check.html`。
2. 输入平台访问密钥。密钥只保存在页面内存，不写入 URL、Cookie 或 Web Storage。
3. 输入公开可访问的 Agent 服务根地址或 Agent Card URL，可选输入 Agent Token 和测试 Prompt。
4. Agent 接口与发现 URL 不同源时，用户必须额外确认才允许跨域转发 Agent Token。
5. 普通诊断默认执行发现、Card 校验和普通调用。
6. 流式调用默认关闭；开启时页面提示“将再次真实执行 Prompt”，用户确认后才能提交。
7. 页面展示四阶段状态、耗时、协议细节、截断响应、错误原因和修复建议。
8. 页面刷新后访问密钥、Agent Token 和结果全部消失。

## 架构

- `public/agent-check.html`：独立“协议检查台”入口，不混入完整金融评测流程。
- `public/agent-check.js`：表单校验、内存状态、提交和报告渲染。
- `public/agent-check.css`：延续主站视觉语言，并支持窄屏、键盘焦点和减少动态效果。
- `POST /api/agent-diagnostics`：访问密钥保护的一次性诊断接口，不使用 `EvaluationStore`。
- `src/agent-diagnostics.js`：阶段编排、凭据范围检查、错误分类和报告脱敏。
- `src/safe-http.js`：DNS/IP 安全校验、地址固定、超时、取消和流式字节上限。
- `src/a2a.js`：共享 Card 校验、接口选择、普通/流式请求构造和响应解析。
- `src/diagnostics-guard.js`：访问密钥校验、调用频率限制和全局并发控制。

## 配置

- `AGENT_DIAGNOSTICS_ACCESS_KEY`：必填；未配置时诊断 API 返回 `503`。
- `AGENT_DIAGNOSTICS_RATE_LIMIT`：每个访问密钥摘要每分钟允许的请求数，默认 `6`。
- `AGENT_DIAGNOSTICS_CONCURRENCY`：全局同时运行的诊断数，默认 `4`。
- `ALLOW_PRIVATE_AGENT_URLS=true`：只用于本地开发和测试，生产环境不得启用。

访问密钥使用恒定时间比较。限流只保存访问密钥的单向摘要，不保存明文。

## 请求与结果契约

平台访问密钥使用请求头 `Authorization: Bearer <AGENT_DIAGNOSTICS_ACCESS_KEY>`。JSON 请求体为：

```json
{
  "url": "https://agent.example.com",
  "sourceType": "service-url",
  "agentAuthorization": "agent bearer token",
  "allowCrossOriginAuthorization": false,
  "prompt": "请返回一句简短的服务状态说明，不执行任何外部操作。",
  "timeoutMs": 30000,
  "runStreaming": false,
  "confirmStreamingSideEffects": false
}
```

- `url`：必填，最大 2,048 字符，只接受 HTTP(S)，拒绝 URL userinfo。
- `sourceType`：必填，只能是 `service-url` 或 `card-url`。
- `agentAuthorization`：可选，最大 8 KiB，只接受无换行的 Token 值。
- `allowCrossOriginAuthorization`：默认 `false`。存在 Agent Token 且接口与发现 URL 不同源时，必须显式开启。
- `prompt`：最大 4,000 个 Unicode 字符，默认值明确要求不执行外部操作。
- `timeoutMs`：整个诊断的总预算，钳制到 5,000–60,000 ms，默认 30,000 ms。
- `runStreaming`：默认 `false`。
- `confirmStreamingSideEffects`：`runStreaming=true` 时必须为 `true`，否则返回 `400`。

预期的 Agent 诊断失败仍返回 HTTP `200` 和 `ok:false`。无效输入返回 `400`，访问密钥错误返回 `401`，请求体过大返回 `413`，频率超限返回 `429`，密钥未配置或并发已满返回 `503`。

响应包含 `ok`、`durationMs`、`streamingRequested`、`streamingOk` 和 `checks`。固定检查 ID 为 `discovery`、`card-validation`、`call`、`stream`；固定状态为 `passed`、`failed`、`skipped`、`blocked`。

发现失败时后续阶段为 `blocked`；Card 校验失败时两个调用阶段为 `blocked`。普通调用失败不阻止用户明确选择的流式调用。顶层 `ok` 只要求发现、Card 校验和普通调用均为 `passed`；未请求流式调用时 `streamingOk` 为 `null`。

每个检查包含 `id`、`status`、`durationMs`、`summary`、安全的 `details` 和可选 `suggestion`。平台访问密钥、Agent Token、请求头和完整敏感响应不进入响应或日志，Agent 输出预览最大 4 KiB。

## 诊断规则

1. **发现**：按输入类型读取 Card，服务地址使用 `/.well-known/agent-card.json`；禁止重定向。Card 上限为 1 MiB，并在读取过程中计数。
2. **校验与接口选择**：复用 `validateAgentCard`，按 `supportedInterfaces` 顺序选择平台支持的第一个接口。未知或自定义 binding 不得默认为 HTTP+JSON。保留所选接口的 `tenant`。
3. **普通调用**：支持 A2A 1.0 HTTP+JSON、A2A 1.0 JSON-RPC 和兼容 0.3 JSON-RPC；按版本构造 `SendMessage`、`message/send` 或 `POST /message:send`，并验证 HTTP 状态、Content-Type、JSON/JSON-RPC 包装、请求 ID 和 Message/Task 结构。JSON-RPC `error` 即使使用 HTTP 200 也判失败。
4. **流式调用**：仅在用户选择、确认二次调用且 `card.capabilities.streaming===true` 时执行。未选择或未声明能力时为 `skipped`，不根据接口类型猜测能力。
5. **流式协议**：按 binding 使用 `SendStreamingMessage`、兼容 0.3 的 `message/stream` 或 `POST /message:stream`；要求 HTTP 200 和 `text/event-stream`。SSE 支持分块边界、CRLF、注释和多行 `data`，并校验 JSON-RPC 请求 ID。
6. **流式成功条件**：单个 Message 事件后正常关闭可判成功；Task 流必须到达完成或明确终止状态。只收到 `working`、错误事件、超时或提前断流均失败。累计上限 2 MiB、256 个事件，单帧和预览均有限制。
7. **汇总**：发现、校验和普通调用成功即认定 Agent 可识别且可调用；流式结果独立展示。

普通调用和流式调用分别生成新的消息 ID，因此后者是第二次真实执行 Prompt。

## 凭据范围

- 平台访问密钥只供诊断 API 鉴权，永不用于任何出站请求。
- Agent Token 只发送给所选 A2A 调用接口，不用于 Card 发现。
- 接口与发现 URL 同源时可直接转发 Agent Token。
- 不同源且 `allowCrossOriginAuthorization=false` 时，调用阶段为 `blocked`，报告目标 origin 并提示确认后重试。
- 用户明确授权后，只向报告中的目标 origin 发送 Token；禁止重定向到第三个 origin。
- 报告生成前对全部字符串执行精确 Token 脱敏，防止恶意 Agent 主动回显 Token。

## 安全与错误处理

- 所有出站请求统一拒绝 URL userinfo、非 HTTP(S)、localhost、`.local`、loopback、私网、链路本地、ULA、未指定地址、组播和 IPv4-mapped IPv6 私网。
- 每次连接前解析全部 A/AAAA 记录；任一结果属于禁止范围即拒绝。校验后的地址直接交给底层连接，TLS SNI 和 Host 仍使用原始主机名，避免 DNS rebinding 的二次解析窗口。
- 禁止重定向；Card 声明的接口作为新目标重新执行完整 DNS/IP 检查。
- `ALLOW_PRIVATE_AGENT_URLS=true` 只放宽地址类别检查，不放宽协议、重定向、大小和超时限制。
- 请求体上限 32 KiB；Card 上限 1 MiB；普通和流式响应分别上限 2 MiB，均在读取过程中计数。
- 每个访问密钥摘要每分钟默认最多 6 次诊断；全局默认最多并发 4 次，不建立无界等待队列。
- 所有阶段共享总超时预算。浏览器断连、超时、超限或解析完成后立即取消 DNS、请求和上游 socket。
- 平台密钥使用恒定时间比较。凭据不持久化、不打印、不回显，也不进入 URL、查询参数和 Web Storage。
- 错误归类为 `dns`、`connection`、`tls`、`http`、`content-type`、`json`、`protocol`、`timeout`、`response-too-large`、`security` 和 `cancelled`，分别给出固定修复建议。
- 日志只记录随机诊断 ID、阶段、错误分类、耗时和目标 origin，不记录 URL 查询参数、Prompt、请求体、Token、响应正文、内部堆栈或本地路径。
- 诊断 API 不保存历史；前端输入和结果只存在页面内存。

## 测试

- 安全传输测试覆盖字面私网、DNS 解析到私网、混合公网/私网记录、IPv4-mapped IPv6、URL userinfo、DNS rebinding、防重定向、地址固定、字节限制、总超时和取消传播。
- 凭据测试确认平台密钥缺失、错误、未配置分别返回 `401/401/503`，且永不出站；Agent Token 不用于 Card 发现，跨域默认阻止，显式授权后只发往目标 origin，Agent 回显 Token 时仍完成脱敏。
- 协议测试覆盖三种支持的 binding、首个受支持接口、未知 binding、`tenant` 透传、JSON-RPC error、普通 Message/Task/Artifact 和结构错误。
- SSE 测试覆盖分块、多行数据、注释、错误事件、ID 不匹配、终态、提前断流、事件数和字节限制。
- API 测试确认上游失败返回 HTTP 200 和稳定状态依赖；流式默认 `skipped`，缺少二次调用确认返回 400，且接口不创建或修改历史记录。
- 资源测试覆盖 32 KiB 请求体、频率限制、并发限制和客户端断连取消。
- 前端静态测试确认两类凭据、跨域授权、流式警告与确认控件、四阶段容器存在；浏览器检查确认密钥不进入 URL 或 Web Storage。
- 全量运行语法检查与 Node 测试套件。

## 使用文档

实现同时新增 `docs/AGENT_DIAGNOSTICS_GUIDE.md`，覆盖：

1. 管理员配置平台访问密钥、频率和并发限制。
2. 平台访问密钥与 Agent Token 的区别。
3. 服务地址、Card URL、跨域凭据授权和流式确认的填写方式。
4. 四阶段状态、顶层 `ok` 与 `streamingOk` 的含义。
5. HTTP 状态、错误分类与修复建议对照。
6. 真实执行 Prompt 的副作用与费用提示。
7. 不保存历史、凭据内存存放和 SSRF 限制。

## 非目标

- 不执行金融评分、模型评审或 Runtime 复刻。
- 不保存、分享或导出诊断历史。
- 不支持浏览器交互登录、OAuth 跳转或自动获取 Agent 凭据。
- 不支持 gRPC 或自定义 A2A binding。
- 不自动尝试 Card 声明的所有接口，只选择顺序中第一个受支持接口。
- 不绕过公网访问和 SSRF 安全限制。
