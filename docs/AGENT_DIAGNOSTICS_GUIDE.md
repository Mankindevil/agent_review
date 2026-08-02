# Agent Card 技术预检平台使用指南

Agent Card 技术预检平台是锐评局中的独立测试入口。参赛者可以上传或粘贴 A2A Agent Card JSON，也可以填写完整 Agent Card URL 或服务根地址。平台获取一张 Card 后验证结构、接口声明、自然语言 A2A 调用和响应时限，并生成一次性的参评技术预检报告。

入口：

```text
http://localhost:4173/agent-check
```

本平台不会创建正式投稿、不执行金融评分、不进入往期战绩，也不保存上传文件、Card、访问密钥、Agent Token 或预检结果。

## 1. 测试平台和最终报名表的边界

技术预检平台只处理运行验证所需的信息：

- 单个 Agent Card JSON、完整 Agent Card URL 或服务根地址；
- Agent 服务鉴权方式和可选 Bearer Token；
- 自然语言测试任务；
- 单次响应上限；
- DeepSeek V4 Pro 与授权数据访问声明。

以下材料不在测试平台重复填写，统一在最终报名表提交：

- Agent 名称与简介的正式报名版本；
- 团队名称、成员和联系方式；
- 正式 Agent Card URL；
- 作品说明文档；
- 示例问题与预期输出；
- 数据 Skills 和投研 Skills 清单；
- 可选的开源代码仓库地址。

远程 URL 模式可以证明 Card 在本次预检时可获取，但不能证明它在整个评审期间持续可访问。Card URL 长期可访问性、服务稳定性、材料真实性和输出可解释性仍需在正式报名与人工评审阶段核验。

## 2. 支持的 A2A 范围

当前支持：

| Card/协议 | Binding | 普通调用 | 流式调用 |
| --- | --- | --- | --- |
| A2A 1.0 | HTTP+JSON | 支持 | Card 声明 streaming 时支持 |
| A2A 1.0 | JSON-RPC | 支持 | Card 声明 streaming 时支持 |
| A2A 0.3 | JSON-RPC | 兼容 | Card 声明 streaming 时兼容 |

当前不支持 gRPC 和自定义 binding。平台按 `supportedInterfaces` 顺序选择第一个受支持接口；旧版 Card 使用顶层 `url`。

### 多 Agent 提交规则

一次只测试一张 Agent Card，一张 Card 对应一个技术预检结果。

- 如果作品内部包含多个子 Agent，但只通过一个编排 Agent 对外服务，可以提交编排 Agent 的 Card，平台把整个系统作为一个不透明参评对象。
- 如果多个 Agent 分别具有独立身份和独立对外接口，应分别提供 Card，逐个上传和测试。
- 多个 Agent 可以共用域名、网关或服务端点。
- A2A 1.0 接口声明 `tenant` 时，平台会在每次普通和流式请求中原样携带该 `tenant`；未声明时不会自行添加。
- `skills` 表示当前对外 Agent 或编排系统的公开能力，不要求暴露内部所有子 Agent。

## 3. 管理员配置

要求 Node.js 20 或更高版本。

复制环境模板：

```bash
cp .env.example .env
```

```dotenv
AGENT_DIAGNOSTICS_RATE_LIMIT=6
AGENT_DIAGNOSTICS_CONCURRENCY=4
ALLOW_PRIVATE_DIAGNOSTICS_URLS=false
ALLOW_PRIVATE_AGENT_URLS=false
```

启动：

```bash
npm start
```

变量说明：

| 变量 | 默认值 | 作用 |
| --- | ---: | --- |
| `AGENT_DIAGNOSTICS_RATE_LIMIT` | 6 | 全局每分钟最多执行的预检次数 |
| `AGENT_DIAGNOSTICS_CONCURRENCY` | 4 | 全局同时运行的预检数量 |
| `ALLOW_PRIVATE_DIAGNOSTICS_URLS` | false | 仅为 `/agent-check` 的 Card 获取和 A2A 调用允许内网/本机地址 |
| `ALLOW_PRIVATE_AGENT_URLS` | false | 为测试入口、Card 发现和正式测评 A2A 请求统一允许内网/本机地址 |

生产环境必须通过 HTTPS 提供页面和 API，否则 Agent Bearer Token 可能在传输过程中泄露。

## 4. 准备 Agent Card 来源

平台支持三种互斥的输入方式：

1. 上传或粘贴 Agent Card JSON；
2. 填写完整 Agent Card URL，例如 `https://agent.example.com/cards/public.json`；
3. 填写服务根地址，例如 `https://agent.example.com`，平台自动读取同一 origin 下的 `/.well-known/agent-card.json`。

JSON 文件要求：

- 扩展名建议为 `.json`；
- UTF-8 编码；
- JSON 根节点必须是对象，不能是数组、字符串或 `null`；
- Card 序列化后不超过 1 MiB；
- 必须包含非空 `name`、`description` 和至少一个合法 `skill`；
- 必须声明至少一个平台支持的接口；
- 接口必须使用 HTTP(S) 地址；是否允许内网/本机由诊断网络策略决定。

A2A 1.0 示例：

```json
{
  "name": "Research Agent",
  "description": "完成公开市场研究任务并返回依据。",
  "supportedInterfaces": [
    {
      "url": "https://agents.example.com/a2a",
      "protocolBinding": "HTTP+JSON",
      "protocolVersion": "1.0",
      "tenant": "research"
    }
  ],
  "capabilities": {
    "streaming": false
  },
  "skills": [
    {
      "id": "market-research",
      "name": "市场研究",
      "description": "分析公开市场信息并给出结构化结论。"
    }
  ]
}
```

URL 获取仅用于得到 Agent Card。平台不会把 Card 来源地址当作 A2A 服务地址；实际调用目标仍完全来自 Card 选中的接口，避免发现地址与服务声明互相混淆。

远程 Card 获取限制：

- 仅支持不含账号密码的 HTTP(S) URL；
- URL 最长 2048 字节；
- Card 响应最大 1,000,000 字节；
- 获取总时限为 30 秒；DNS/TCP/TLS 建连失败最多进行 2 次瞬时重试（共 3 次尝试），所有尝试共享该总时限；
- 不跟随重定向；
- `ALLOW_PRIVATE_DIAGNOSTICS_URLS=false` 时拒绝 localhost、私网、链路本地和其他非公网地址；
- 私有测试部署可以设置为 `true`，页面和报告会标注已放行内网/本机；
- Agent Bearer Token 不会用于获取 Card。

## 5. 页面操作步骤

1. 打开 `/agent-check`。
2. 选择一种 Card 来源：
   - 把 `.json` 文件拖到上传区、点击“选择文件”，或直接粘贴 Agent Card JSON；
   - 填写完整 Agent Card URL；
   - 填写服务根地址，由平台自动发现 `/.well-known/agent-card.json`。
3. 检查页面生成的摘要：
   - Agent 名称和简介；
   - 协议版本与 binding；
   - 调用目标；
   - `tenant`；
   - Skills 数量；
   - streaming 能力；
   - Card 大小。
4. 选择 Agent 鉴权方式。
5. 输入无外部副作用的自然语言测试任务。
6. 选择 1、5、10 或 20 分钟的单次响应上限。
7. 确认“底座模型使用 DeepSeek V4 Pro”和“仅访问授权数据”两项声明。
8. 如需测试流式调用，打开流式开关并确认第二次真实执行。
9. 点击“开始技术预检”。

JSON 模式会即时生成 Card 摘要；URL 模式先显示待解析地址，在开始预检后由服务端获取并校验。服务端始终重新执行全部类型、大小、协议和安全校验。

## 6. Agent Bearer Token

Agent Bearer Token 用于 Card 选定的 A2A 接口。页面只填写 Token 值，不要手工添加 `Bearer ` 前缀。

选择 Bearer 鉴权后：

1. JSON 模式直接显示 Card 选中接口的目标 origin；URL 模式在提交前提示目标将从远程 Card 声明中确定，并在结果中显示实际 origin；
2. 用户必须勾选“我确认把 Token 发往上方 origin”；使用 URL 来源时，这表示确认信任该远程 Card 声明的服务 origin；
3. API 字段 `confirmAuthorizationTarget` 必须为 `true`；
4. Card 改变后确认会自动清除，必须重新检查目标。

Agent Token：

- 不用于获取或发现 Card；
- 只发送给 Card 选定的接口；
- 不写入 URL、Cookie、Web Storage、日志或评测历史；
- 不出现在返回报告中；
- 页面刷新或离开后清除。

无鉴权模式不得提交 Token；Bearer 模式必须提交 Token 并确认目标。

## 7. 响应时限与流式调用

可选的单次响应上限：

| 页面选项 | `timeoutMs` |
| --- | ---: |
| 1 分钟 | 60000 |
| 5 分钟，默认 | 300000 |
| 10 分钟 | 600000 |
| 20 分钟 | 1200000 |

服务端只接受 `60000–1200000` 之间的整数，超出范围返回 400，不会静默修改。

普通调用拥有一份完整预算，DNS、连接、TLS、请求和响应读取都计入该调用。流式调用默认关闭；启用后会再次真实执行同一个 Prompt，并拥有另一份独立的相同预算。

流式调用可能：

- 再次产生模型或工具费用；
- 重复发送消息、创建任务或修改外部状态；
- 对交易类或通知类 Agent 造成危险副作用。

只有在 Agent 和任务可以安全重复执行时才启用。平台不替 Agent 提供幂等或沙箱保证。

## 8. 预检结果

### 协议轨迹

| 阶段 ID | 含义 |
| --- | --- |
| `card-input` | 确认服务端收到大小合规的 Card 对象，或从 URL 成功获取 Card |
| `card-validation` | 校验字段、版本、binding、`tenant`、Skills、能力和目标 URL |
| `call` | 执行普通 A2A 调用并校验 Message 或 Task |
| `stream` | 可选的第二次流式调用与 SSE 终态校验 |

### 技术门槛

`technicalReadiness.checks` 固定包含：

| 检查 ID | 含义 |
| --- | --- |
| `agent-card` | Card 结构和接口声明是否通过 |
| `a2a-call` | 自然语言 A2A 普通调用是否通过 |
| `response-time` | 普通调用是否在所选上限内完成 |
| `competition-attestations` | 两项参评声明是否已确认 |

状态：

| 状态 | 含义 |
| --- | --- |
| `passed` | 平台已经自动验证 |
| `failed` | 已执行但未满足技术要求 |
| `skipped` | 用户没有请求可选检查，或 Card 没有声明相应能力 |
| `blocked` | 前置失败或安全策略阻止后续执行 |
| `declared` | 提交者已声明，仍需人工核验 |

顶层字段：

- `ok=true`：Card 输入、Card 校验、普通调用和技术门槛全部通过；
- `technicalReadinessOk=true`：Card、普通调用和响应时限通过，两项声明已确认；
- `streamingOk=null`：未请求流式检查；
- `streamingOk=true`：请求流式检查且到达终态；
- `streamingOk=false`：请求后失败、跳过或被阻断。

未请求流式检查不影响基础技术预检。只收到 `working` 不算流式成功；Message 必须正常结束，Task 必须到达完成、失败、取消、拒绝、中断或其他明确终态。

## 9. API 请求示例

请求体总上限为 1.25 MiB。JSON 模式的 `agentCard` 本身最大 1 MiB；URL 模式改为提交 `cardSource`。

```bash
curl http://localhost:4173/api/agent-diagnostics \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer platform-access-key' \
  --data '{
    "agentCard": {
      "name": "Research Agent",
      "description": "完成公开市场研究任务。",
      "url": "https://agents.example.com/a2a",
      "protocolVersion": "0.3",
      "skills": [
        {
          "id": "research",
          "name": "Research",
          "description": "Return a documented research result."
        }
      ]
    },
    "authMethod": "none",
    "agentAuthorization": "",
    "prompt": "请返回一条带依据的服务能力说明。",
    "timeoutMs": 300000,
    "runStreaming": false,
    "confirmStreamingSideEffects": false,
    "attestations": {
      "deepseekV4Pro": true,
      "authorizedDataOnly": true
    }
  }'
```

完整 Agent Card URL 模式把 `agentCard` 替换为：

```json
{
  "cardSource": {
    "type": "card-url",
    "url": "https://agent.example.com/.well-known/agent-card.json"
  }
}
```

服务根地址模式使用：

```json
{
  "cardSource": {
    "type": "service-url",
    "url": "https://agent.example.com"
  }
}
```

Bearer 模式额外提交：

```json
{
  "authMethod": "bearer",
  "agentAuthorization": "agent-token-value",
  "confirmAuthorizationTarget": true
}
```

`agentCard` 与 `cardSource` 必须二选一。旧的顶层 `url` 和 `sourceType` 输入契约仍已停用；A2A 服务地址只能来自最终获得的 `agentCard`。

## 10. HTTP 状态

| HTTP 状态 | 含义 | 处理 |
| ---: | --- | --- |
| 200 | 预检已受理；Agent 自身失败也使用 200 | 查看 `ok`、`technicalReadinessOk` 和各阶段状态 |
| 400 | Card、鉴权、Prompt、超时、声明或流式确认无效 | 根据错误信息修正输入 |
| 413 | 整个请求体超过 1.25 MiB | 缩小 Card 或其他输入 |
| 429 | 一分钟内请求过多 | 按 `Retry-After` 等待 |
| 503 | 并发已满 | 稍后重试 |

## 11. 常见错误

| 分类 | 常见原因 | 建议 |
| --- | --- | --- |
| `dns` | Card 目标域名不存在或不可公开解析 | 检查域名与 A/AAAA 记录 |
| `connection` | 服务未启动、端口或防火墙阻断 | 从公网确认端口可达 |
| `tls` | 证书过期、域名不匹配、证书链不完整 | 修复 HTTPS 证书 |
| `http` | 接口路径错误、鉴权失败或服务端异常 | 检查 Card、Token 和 Agent 日志 |
| `content-type` | 普通响应不是 JSON，或流式响应不是 SSE | 设置规范要求的 Content-Type |
| `json` | Agent 响应不是合法 JSON | 修复响应序列化 |
| `protocol` | binding、版本、请求 ID、Message/Task 或 SSE 结构错误 | 按 Card 声明的 A2A 版本修复 |
| `timeout` | Agent 未在 1–20 分钟所选上限内完成 | 缩短任务执行时间或调整合理上限 |
| `response-too-large` | 普通响应、流式累计内容或事件超限 | 缩短输出和事件数量 |
| `security` | URL 含凭据、协议不受支持，或当前诊断策略没有放行非公网地址 | 修正 URL，或由管理员确认诊断专用内网策略 |
| `cancelled` | 页面关闭或客户端断连 | 保持页面连接后重试 |

## 12. 安全与隐私边界

- SSRF 防护校验 URL、全部 DNS 结果和实际连接地址。
- 默认拒绝 localhost、私网、链路本地、未指定、组播和其他危险地址；私有测试环境可以仅对诊断入口显式放行。
- DNS 校验后的地址直接用于连接，降低 DNS rebinding 风险。
- 禁止重定向，防止凭据被转发到第三方。
- Agent 普通与流式响应分别限制为 2 MiB。
- SSE 最多处理 256 个事件，单事件最大 64 KiB。
- Agent 输出只展示截断预览。
- Agent Token 仅发送到用户确认的 Agent origin，并在报告生成前脱敏。
- 页面不使用 Cookie、Local Storage 或 Session Storage 保存凭据。
- 服务端不把技术预检写入 `EvaluationStore`。
- 浏览器交互登录、OAuth 跳转、gRPC 和自定义 binding 不在支持范围内。

只有测试入口需要访问内网或本机 Agent 时，可以设置诊断专用开关：

```dotenv
ALLOW_PRIVATE_DIAGNOSTICS_URLS=true
```

如果测试入口和正式测评平台都需要访问内网或本机 Agent，使用全平台开关：

```dotenv
ALLOW_PRIVATE_AGENT_URLS=true
```

全平台开关同时作用于 Card 发现、诊断调用和正式测评 A2A 请求，诊断入口也会继承它。页面会显示“内网测试已允许”，报告的 `networkPolicy` 和 `targetScope` 会标注目标范围。地址是从平台服务器发起访问，因此 `127.0.0.1` 指平台服务器自身，不是提交者浏览器所在电脑。只有私人或受控环境应开启。

## 13. 哪些结果仍需人工核验

即使 `technicalReadinessOk=true`，也不代表作品已经正式通过评选。以下项目仍需最终报名和人工核验：

- Agent Card 信息真实、正式 URL 可访问；
- 服务在整个评审期间稳定在线；
- 输出过程和最终结果清晰、可解释；
- Agent 实际底座模型确为 DeepSeek V4 Pro；
- Agent 不绕过权限访问未授权数据；
- 团队、作品说明、示例问题、Skills 和仓库材料真实完整；
- 正式评分维度与排名。
