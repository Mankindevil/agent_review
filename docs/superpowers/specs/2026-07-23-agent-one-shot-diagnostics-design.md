# 一次性 Agent 诊断平台设计

## 目标

为金融 Agent 锐评项目新增独立诊断页面。用户提交 A2A 服务地址、可选 Bearer Token 和测试 Prompt 后，平台在一次请求内完成发现、校验、普通调用和流式调用，并立即返回可理解的诊断结果。诊断不创建评测记录、不进入历史列表、不写入磁盘。

## 用户流程

1. 用户打开 `/agent-check.html`。
2. 输入公开可访问的 Agent 服务根地址或 Agent Card URL，可选输入 Bearer Token 和测试 Prompt。
3. 页面显示发现、Card 校验、普通调用、流式调用四个检查阶段。
4. 服务端完成一次性诊断，页面展示各阶段状态、耗时、协议细节、截断后的响应预览、错误原因和修复建议。
5. 页面刷新后结果消失；用户可以修改输入后重新测试。

## 架构

- `public/agent-check.html`：独立单页入口，不混入完整金融评测流程。
- `public/agent-check.js`：表单、加载状态和诊断报告渲染。
- `public/agent-check.css`：复用现有视觉语言，并保持页面独立。
- `POST /api/agent-diagnostics`：执行一次性诊断，不使用 `EvaluationStore`。
- `src/agent-diagnostics.js`：发现 Card、验证协议、选择接口、构造 A2A 请求、解析普通及流式结果、生成安全的结构化报告。

## 请求与结果契约

请求字段：

- `url`：服务根地址或完整 Agent Card URL。
- `sourceType`：`service-url` 或 `card-url`，前端可自动判断，用户也可切换。
- `authorization`：可选 Bearer Token，仅保存在当前请求内存中。
- `prompt`：测试消息，提供安全默认值。
- `timeoutMs`：服务端钳制到安全范围。

响应包含 `ok`、总耗时以及 `checks` 数组。每个检查包含 `id`、`status`、`durationMs`、`summary`、安全的 `details` 和可选 `suggestion`。Token、请求头和完整敏感响应不进入响应或日志。Agent 输出仅返回有限长度预览。

## 诊断规则

1. 发现：按输入类型读取 Card，服务地址使用 `/.well-known/agent-card.json`。
2. 校验：复用现有 A2A Card 验证逻辑，报告协议版本、接口绑定及声明能力。
3. 普通调用：依据 A2A 1.0 HTTP+JSON、A2A 1.0 JSON-RPC 或兼容 0.3 JSON-RPC 构造请求，验证 HTTP 状态和响应结构。
4. 流式调用：仅在 Card 声明流式能力或接口支持时尝试；解析 SSE 数据帧并验证至少收到一个有效事件。未声明流式时标记为 `skipped`，不判定整体验证失败。
5. 汇总：发现、校验和普通调用全部成功即认定 Agent 可识别且可调用；流式结果独立展示。

## 安全与错误处理

- 沿用现有 URL 安全策略，默认拒绝 loopback、内网、链路本地地址和非 HTTP(S) 协议。
- 限制 Card、普通响应和流式响应大小，并设置整体超时。
- Bearer Token 不持久化、不打印、不回显。
- 对 DNS、连接、HTTP、JSON、协议结构、超时分别给出用户可执行的修复建议。
- 诊断 API 不保存历史；前端结果仅存在页面内存。

## 测试

- 单元测试覆盖 Card 发现、接口选择、鉴权转发、普通响应解析、SSE 解析、超时和响应大小限制。
- API 测试确认诊断接口不创建历史记录且不泄露 Token。
- 前端静态测试确认入口、表单、阶段状态和结果容器存在。
- 全量运行语法检查与 Node 测试套件。

## 非目标

- 不执行金融评分、模型评审或 Runtime 复刻。
- 不保存、分享或导出诊断历史。
- 不支持需要浏览器交互登录的 Agent。
- 不绕过公网访问和 SSRF 安全限制。
