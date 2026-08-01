# Market Analyst Evidence Pack 投影保真修复设计

日期：2026-08-01

## 背景与问题

Market Analyst 的 `hot-topic-analysis`、`sell-pressure-scan` 和
`potential-watchlist` 会从完整日报产物中投影各自需要的榜单、结论、数据源和
运行轨迹。生产数据中，一个分析结论可能引用 500 条以上 Panda 调用证据。

当前任务服务先用 `sanitizeTraceValue` 清洗完整 Evidence Pack，再执行分析型
投影。该通用清洗器面向日志和小型响应，使用 500 项数组上限、256 KiB 总字节
预算和 4,096 节点预算。大型 Evidence Pack 因此在投影前丢失部分 `sources`，
但 leaderboard metrics 和 conclusions 仍引用这些数据源。投影后的
`validateEvidencePack` 会正确拒绝断裂 lineage，最终导致 A2A 任务返回
`TASK_STATE_FAILED`，即使 Panda Worker 和报告生成已经成功。

## 目标

- 三个分析型 A2A operation 都能投影并返回超过 500 个 sources 的有效
  Evidence Pack。
- 投影必须保留 leaderboard、conclusion、metric 与 source 之间的完整 lineage。
- 输出仍需脱敏；凭据型字段不得进入 A2A Task、run detail 或流式事件。
- 投影结果必须再次通过 `validateEvidencePack`。
- 大型流式 artifact 继续返回受保护的 Task 获取提示，不得链接到未投影的完整
  run artifact。
- `daily-market-report`、artifact 完整性检查、owner 隔离和输出模式协商保持兼容。

## 非目标

- 不提高 `sanitizeTraceValue` 的全局限制。
- 不改变 Panda Worker 的评分、取数、缓存或 degradation 规则。
- 不通过丢弃榜单行、结论或 source 来规避校验。
- 不修改报告邮件投递或模型叙事行为。

## 方案比较

### 采用：Evidence Pack 专用保真清洗

任务服务识别 `evidence-pack.json`，对完整 pack 的语义集合逐项执行现有脱敏器，
而不是让整个 pack 共用一次全局预算。`sources`、`conclusions`、各 leaderboard
行、`missingData` 等集合保持原有 cardinality；每个独立元素仍受字符串、对象、
深度、节点和字节限制。组装完成后再次调用 `validateEvidencePack`。

这一方案把限制范围收敛到已受 artifact 大小限制和 Evidence Pack schema 约束的
数据，同时继续复用现有敏感键识别和脱敏逻辑。

### 不采用：提高通用清洗器上限

该方案改动小，但会扩大所有 trace、错误和任务元数据的内存及响应面，且仍把
Evidence Pack 的业务完整性偶然绑定到日志预算。

### 不采用：截断投影结果

该方案能让部分小型投影通过校验，但会静默遗漏用户请求的结果或证据，破坏
A2A operation 的输出契约。

## 设计

### 专用清洗边界

在 `agents/market-analyst/task-service.js` 中增加一个内部 Evidence Pack 清洗
helper。helper 接收已经解析的 pack，按以下原则生成新对象：

- 普通顶层值沿用 `sanitizeTraceValue`；
- `conclusions`、`sources`、`missingData` 按元素分别清洗；
- `leaderboards` 和 `excluded` 按 key 保留，再按行分别清洗；
- 不信任清洗前的结构，清洗后的完整对象必须通过 `validateEvidencePack`；
- helper 不导出，不扩大其他模块的公共 API。

`#buildArtifact` 在处理 `evidence-pack.json` 的 `data`、JSON `content` 或预构造
`parts[].data` 时统一调用该 helper。其他 artifact 继续使用现有通用清洗路径。

### 数据流

1. Artifact loader 读取并校验持久化 artifact 的大小与 SHA-256。
2. `#buildArtifact` 解析 Evidence Pack。
3. 专用 helper 逐项脱敏，保留所有语义集合，并验证完整 lineage。
4. 分析型 operation 从完整、已脱敏的 pack 中筛选目标 conclusions、leaderboards
   和 sources。
5. 投影结果再次通过 `validateEvidencePack`。
6. Task GET 返回完整的投影 artifact；SSE 超过既有阈值时仍返回 Task URL 提示。

### 错误处理

- JSON 无法解析时维持当前无效 JSON 处理，不把未解析内容直接暴露给调用方。
- 专用清洗后校验失败时让任务失败关闭，避免返回 lineage 断裂或未验证的 pack。
- 不吞掉 artifact 完整性、owner scope 或 run identity 错误。

## 测试策略

先增加一个回归测试，构造至少 501 个有效 sources，并让分析结果引用第 500 条
之后的数据源。修复前该测试应以 `TASK_STATE_FAILED` 或投影校验错误失败。

修复后验证：

- `hot-topic-analysis`、`sell-pressure-scan`、`potential-watchlist` 均返回
  `TASK_STATE_COMPLETED`；
- 每个投影只包含本 operation 的 leaderboard 和 conclusion；
- 第 500 条之后的 source 仍存在，且 `validateEvidencePack` 通过；
- source 中注入的凭据型字段被替换为脱敏值；
- 大型 SSE artifact 仍不暴露 `/runs/...` 的未投影 artifact；
- `test/market-analyst-a2a.test.js`、相关 Market Analyst 测试和全量 Node 测试通过；
- 重启本机 Market Analyst 后，真实 `hot-topic-analysis` A2A 请求返回完成状态和
  可读取的投影 Evidence Pack。

## 兼容性与回滚

接口路径、请求 schema、artifact 名称和 media type 不变。修复只影响 Evidence
Pack 在任务服务内部的清洗方式。若出现回归，可回滚专用 helper 与调用点，不需要
迁移持久化 state 或历史报告。
