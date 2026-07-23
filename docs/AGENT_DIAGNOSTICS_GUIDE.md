# Agent 协议检查台使用指南

Agent 协议检查台是现有锐评平台内的独立测试入口，用于一次性验证 A2A Agent 是否可发现、Card 是否有效、普通调用是否可用，以及可选的流式调用是否能到达终态。

它不会创建评测记录、不进行金融评分、不进入往期战绩，也不保存诊断历史。

当前支持 A2A 1.0 的 HTTP+JSON、JSON-RPC，以及兼容 A2A 0.3 的 JSON-RPC；不支持 gRPC 和自定义 binding。

## 1. 管理员配置

复制环境模板并设置一个足够长、不可猜测的平台访问密钥：

```bash
cp .env.example .env
```

```dotenv
AGENT_DIAGNOSTICS_ACCESS_KEY=替换为随机生成的长密钥
AGENT_DIAGNOSTICS_RATE_LIMIT=6
AGENT_DIAGNOSTICS_CONCURRENCY=4
```

PowerShell 临时启动示例：

```powershell
$env:AGENT_DIAGNOSTICS_ACCESS_KEY = "替换为随机生成的长密钥"
npm start
```

POSIX shell 临时启动示例：

```bash
AGENT_DIAGNOSTICS_ACCESS_KEY='替换为随机生成的长密钥' npm start
```

然后打开：

```text
http://localhost:4173/agent-check.html
```

配置含义：

| 变量 | 默认值 | 作用 |
| --- | ---: | --- |
| `AGENT_DIAGNOSTICS_ACCESS_KEY` | 无 | 保护诊断 API；留空时 API 返回 503 |
| `AGENT_DIAGNOSTICS_RATE_LIMIT` | 6 | 每个访问密钥每分钟最多执行的诊断数 |
| `AGENT_DIAGNOSTICS_CONCURRENCY` | 4 | 全局同时运行的诊断数 |
| `ALLOW_PRIVATE_AGENT_URLS` | false | 仅本地开发可设为 true，生产环境禁止启用 |

## 2. 两类密钥不要混用

### 平台访问密钥

用于进入本平台的诊断 API，对应 `AGENT_DIAGNOSTICS_ACCESS_KEY`。浏览器通过 HTTP `Authorization` 请求头发送给本平台。

平台访问密钥绝不会发送给 Agent。

生产环境必须通过 HTTPS 访问检查台，否则平台访问密钥和 Agent Token 可能在传输途中泄露。

### Agent Bearer Token

用于调用被测试 Agent，是可选字段。页面只要求填写 Token 值，不要添加 `Bearer ` 前缀。

Agent Token：

- 不用于读取公开 Agent Card；
- 只发送给 Card 选定的 A2A 调用接口；
- 不写入日志、历史、URL、Cookie 或 Web Storage；
- 页面刷新后消失。

如果 Card 的调用接口与发现地址不同源，默认不会发送 Agent Token。确认目标 origin 可信后，勾选“允许跨域转发 Agent Token”，其 API 字段为 `allowCrossOriginAuthorization`。

## 3. 执行一次诊断

1. 输入平台访问密钥。
2. 选择地址类型：
   - “服务根地址”会读取同源 `/.well-known/agent-card.json`；
   - “Agent Card URL”会读取指定的完整 URL。
3. 输入 Agent 地址。
4. 需要鉴权时填写 Agent Bearer Token。
5. 使用默认安全 Prompt，或填写不产生外部副作用的测试 Prompt。
6. 点击“开始一次性诊断”。

默认执行三项真实检查：

1. 发现 Agent Card；
2. 校验 Card 与接口声明；
3. 执行一次普通 A2A 调用。

## 4. 流式检查与真实副作用

流式检查默认关闭。启用后，必须确认“我确认进行第二次真实调用”。

流式检查会再次真实执行同一个 Prompt，不是对普通调用的被动监听。它可能：

- 再次产生模型或工具费用；
- 重复发送消息、创建任务或修改外部状态；
- 对具有交易能力的金融 Agent 造成危险副作用。

只在 Agent 和 Prompt 可安全重复执行时开启。平台不会替 Agent 提供幂等或沙箱保证。

## 5. 结果解释

固定阶段：

| 阶段 | 含义 |
| --- | --- |
| `discovery` | 读取并解析 Agent Card |
| `card-validation` | 校验字段、版本、binding、tenant 和能力 |
| `call` | 执行普通 A2A 调用并校验 Message/Task |
| `stream` | 可选的第二次流式调用与 SSE 终态校验 |

阶段状态：

| 状态 | 含义 |
| --- | --- |
| `passed` | 已执行且满足协议要求 |
| `failed` | 已执行但失败 |
| `skipped` | 用户未选择或 Card 未声明相应能力 |
| `blocked` | 前置失败或安全策略阻止执行 |

顶层 `ok=true` 表示发现、Card 校验和普通调用全部通过。流式结果独立使用 `streamingOk`：

- 未请求流式检查时为 `null`；
- 请求且到达终态时为 `true`；
- 请求但失败、跳过或阻断时为 `false`。

只收到 `working` 事件不算流式成功；Message 必须正常结束，Task 必须到达完成、失败、取消、拒绝或中断等明确终态。

## 6. HTTP 状态

| HTTP 状态 | 含义 | 处理 |
| ---: | --- | --- |
| 200 | 诊断已受理；Agent 自身失败也使用 200 | 查看 `ok` 和各阶段状态 |
| 400 | 输入无效，或流式调用未确认 | 修正表单 |
| 401 | 平台访问密钥缺失或错误 | 核对管理员提供的密钥 |
| 413 | 请求体超过 32 KiB | 缩短 Prompt 或 Token |
| 429 | 一分钟内请求过多 | 按 `Retry-After` 等待 |
| 503 | 未配置密钥或并发已满 | 检查服务配置或稍后重试 |

## 7. 常见错误

| 分类 | 常见原因 | 建议 |
| --- | --- | --- |
| `dns` | 域名不存在或不可公开解析 | 检查域名与 A/AAAA 记录 |
| `connection` | 服务未启动、端口或防火墙阻断 | 从公网确认端口可达 |
| `tls` | 证书过期、域名不匹配、证书链不完整 | 修复 HTTPS 证书 |
| `http` | 路径错误、鉴权失败或服务端异常 | 检查 Agent 日志和接口路径 |
| `content-type` | 返回类型与 JSON/SSE 不符 | 设置正确的 Content-Type |
| `json` | Card 或普通响应不是合法 JSON | 修复序列化 |
| `protocol` | binding、请求 ID、Message/Task 或 SSE 结构错误 | 按声明版本修复 A2A 实现 |
| `timeout` | Agent 未在总预算内完成 | 缩短执行或提高超时 |
| `response-too-large` | Card、普通响应或流式事件超限 | 缩短输出和事件数量 |
| `security` | SSRF 策略拒绝内网、本机或危险地址 | 使用公开 HTTP(S) 地址 |
| `cancelled` | 页面关闭或客户端断连 | 保持页面连接后重试 |

## 8. 安全边界

- SSRF 防护会检查 URL、全部 DNS 结果和实际连接地址。
- 禁止重定向，避免凭据被转发到第三方地址。
- Card 最大 1 MiB，普通与流式响应最大 2 MiB。
- 总超时限制在 5–60 秒。
- Agent 输出只展示截断预览。
- 页面和服务端均不保存诊断历史。
- 浏览器交互登录、OAuth 跳转、gRPC 和自定义 binding 不在支持范围内。

本地示例 Agent 使用 loopback 地址，因此只有开发环境可以临时设置：

```dotenv
ALLOW_PRIVATE_AGENT_URLS=true
```

生产环境必须保持 `false`。
