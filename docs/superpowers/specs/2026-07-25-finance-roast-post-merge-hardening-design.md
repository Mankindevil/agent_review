# Finance Roast Post-Merge Hardening Design

**日期：** 2026-07-25

**状态：** 已批准实施

## 目标

把已经合并到 `codex/finance-roast` 的四条功能分支从“历史已整合”推进到“安全契约闭环、测试可复现、可推送交付”。本轮不改变睿评的评分产品定义，只修复合并后暴露的 A2A 所有权鉴权、输入边界、前端状态、兼容性和 Market Worker 验证环境。

## 设计原则

- V2 destructive action 必须以 participant access token 证明所有权；公开评测 ID 不是授权凭据。
- Agent connection authorization 和 participant token 只允许停留在请求与页面内存中，不进入持久化、URL、日志或公开投影。
- 服务端复用 `EvaluationPipeline.cancel()` 和 `EvaluationPipeline.archive()` 的原子状态转换，不在路由层重复实现 V2 mutation。
- V2 Agent Card 的每个 endpoint 字段只要被声明，就必须是无 query、fragment 和 userinfo 的安全字符串。
- 开启 V2 后仍保持 legacy 请求的 1,000,000-byte 限制和 413 语义；V2 请求继续使用 3 MiB 限制。
- Market Worker 测试入口必须能显式选择 Python，并由仓库依赖清单提供 Parquet engine。

## 方案

### 1. V2 cancel/archive 所有权链路

`server.js` 从 `Authorization: Bearer <participantAccessToken>` 提取 token，并分别传给 `pipeline.cancel(id, token)` 与 `pipeline.archive(id, token)`。缺失或错误 token 保持 401，且不得产生 revision、audit、abort、credential-vault 或 event 副作用；正确 token 成功；legacy cancel/delete 保持原行为。

`public/app.js` 为 cancel/archive 复用内存中的 `state.participantTokens`。若内存中没有 token，则允许用户在现有 participant token 输入框中手工提供；不使用 localStorage、sessionStorage、URL 或日志。测试中的 V2 直接 pipeline 调用全部迁移为传入 create 返回的 token。

### 2. Agent Card endpoint 边界

`assertV2CardEndpointCredentialBoundary()` 不再只检查字符串值。顶层 `url` 或 `supportedInterfaces[*].url` 只要存在，就统一调用严格 endpoint guard；非字符串、含 query 或 fragment 的值全部拒绝。现有 A2A Card schema validator继续负责选择合法 interface，submission guard 负责冻结前的 credential boundary。

### 3. Legacy/V2 body 大小兼容

请求先在 3 MiB 的绝对上限内读取。解析成功后，只有顶层 `schemaVersion: 2` 可以使用完整的 V2 上限，其他请求继续执行 1,000,000-byte legacy 限制；解析失败且 body 已超过 legacy 上限时返回 413。这样无需根据不完整 JSON 猜测 schema，1,000,001-byte malformed body 仍返回 413，合法 V2 body 仍可超过 legacy 上限。

### 4. 前端状态一致性

- token 收据关闭后恢复创建按钮；回到 landing 时也按 health/feature 状态刷新按钮。
- 已归档记录不显示停止按钮，handler 也拒绝 archived item。
- V2 历史归档按钮只在 completed、failed、cancelled、interrupted 且未归档时启用。
- cancel/archive 请求都发送 participant Bearer token，并在 token 缺失时给出可操作提示。

### 5. Market Worker 可复现验证

保留 `PANDA_DATA_PYTHON` 优先级；Windows fallback 同时探测 `python` 和 `py`，并输出明确的解释器缺失错误。将运行 Parquet cache 所需的 engine 固定在 `requirements-data.txt`，使按 README 创建 `.venv` 后可以完整运行 87 项 worker tests。业务缓存协议和测试断言不因当前机器缺依赖而放宽。

## 错误处理与兼容性

- 所有 V2 ownership 失败统一返回 401，不泄露 token、hash 或私有 Card 内容。
- 归档状态冲突继续返回 409；重复合法归档保持幂等。
- legacy delete、cancel、retry 和 feature-flag-off 行为不变。
- UI 不自动持久化 participant token；页面刷新后要求用户重新输入是预期安全行为。

## 验证

1. 针对每个缺口先增加或修正回归测试并观察预期失败。
2. 运行 `test/api-v2.test.js`、`test/pipeline-control.test.js`、`test/server-startup.test.js`、`test/submission.test.js` 和 `test/api.test.js`。
3. 使用仓库声明的 Python 环境运行 87 项 Market Worker 测试。
4. 运行 `npm run check`、`npm run test:node` 和完整 `npm test`。
5. 运行 `git diff --check`，确认只提交本轮文件，不纳入截图、日志、浏览器缓存或 Python bytecode。
