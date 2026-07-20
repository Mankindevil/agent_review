# 评测与打分规则

本文件记录当前版本实际执行的评测规则。网页版本源码为 [`public/methodology.html`](../public/methodology.html)，运行项目后访问 `/methodology.html`。规则实现以 `src/a2a.js`、`src/scoring.js`、`src/prompts.js` 和 `src/pipeline.js` 为准。

## 0. A2A 准入

准入只决定能否创建评测，不计分。Agent Card 必须：

- 是 JSON 对象，包含非空 `name`、`description`；
- 至少声明一个 skill，且每个 skill 都有 `id`、`name`、`description`；
- 包含 A2A 1.0 `supportedInterfaces`，或兼容 0.3 的顶层 `url`。

失败返回 HTTP 400，不进入后续阶段。Card URL / 服务发现还检查 HTTP(S)、私网 URL 策略、1 MB 响应上限与禁止重定向。

## 1. Agent 必要性

从 Card 描述、skill 名称/描述/标签/示例和用户测试 prompt 中识别信号。定义：

- `C`：命中的复杂信号组数量，最多 8 组；
- `S`：是否命中简单变换信号，当前为 0 或 1；
- `K`：skill 数量；
- `N`：测试用例数量；
- `U`：是否有测试用例，正常提交为 1；
- `B`：能力加分，streaming +5、push notifications +6、extensions +4。

复杂信号组为：多步编排、人机确认、外部系统、文件文档、跨文档核对、证据/合规、状态/异步、规划/重试。简单信号包括整理文件、重命名、摘要、翻译、改写、分类和 format。

五维公式均限制在 0–100：

```text
步骤深度   = clamp(18 + 10C - 5S)
工具依赖   = clamp(12 + 9C + 3K)
状态与分支 = clamp(10 + 8C + B)
不确定性   = clamp(22 + 8U + 5C)
复用价值   = clamp(26 + 7K + 4N + 4C)
必要性总分 = round(五维算术平均)
```

阈值：

- 0–35：模型直出更划算，最终评级强制为“拉”；
- 36–59：Agent 价值存疑；
- 60–100：值得 Agent 化。

## 2. 多模型专业度

每个评审只看公开 Card，并独立给出领域深度、流程设计、异常处理、输出契约、可评测性五个维度，以及总分、评语与首要风险。

后端使用模型返回的 `score` 作为该模型总分，不从五维二次计算。仅 `score > 0` 的成功评审进入专业度算术平均；调用失败保留 0 分和错误，但不进入平均。全部失败时专业度为 0。

专业度进入报告与审计，但当前不直接参与最终四档决策树。Demo 模式的评审是由 Card、reviewer ID 与 seed 确定生成的模拟结果。

## 3. Runtime Skill 复刻

Claude Code、Cursor Agent 与 Doubao Agent 只接收同一 Agent Card，生成包含 `name`、`description`、`instructions`、`tools` 的 Skill。构建阶段不打 0–100 分。

模型输出无效 JSON 或缺少 Skill 必填字段时，携带格式纠错提示再试一次。构建最终失败时，该 Runtime 在每个对测用例中记失败，实战分强制为 0；其他选手继续运行。

## 4. 同 Prompt 实战分

评分只读取可见输出。四维基础分：

```text
任务完成 = 输出长度 > 25 ? 76 : 42
依据证据 = 命中 因为/依据/evidence/source/文件/步骤/结果 ? 83 : 60
结构表达 = 含换行、项目符号或编号 ? 82 : 62
可用性   = clamp(45 + min(输出长度, 900) / 30)
单局分   = round(clamp(四维平均 + 稳定扰动[-5, +5]))
```

执行失败时覆盖为 0。每个选手的最终实战分为其全部测试用例分数的算术平均，保留 1 位小数。

当前启发式偏好较长、有结构、带依据词的输出，不能验证事实真假。生产版本需要结构化验收断言、独立 Judge 与人工抽检。

## 5. 最终分档

设 `A` 为提交 Agent 均分，`C` 为 Claude Code 均分，`D` 为豆包均分，`N` 为必要性分。按顺序命中第一条：

1. `N < 36`：拉；
2. `A - C >= 3`：夯；
3. `A - C >= 0`：人上人；
4. `A - D < 0`：拉；
5. 其他情况：NPC。

因此必要性不足拥有最高优先级。专业度当前不改变这棵分档树。

## 6. 重试、Seed 与执行模式

- 重跑模型：替换指定评审结果；
- 重建 Runtime：替换 Skill 并回放全部用例；
- 重跑一局：替换指定用例、指定选手结果。

重试不取历史最高分。最新结果原位替换后，专业度、各选手均分、差值和最终评级全部重算，前后摘要写入 `retryHistory`。

根 seed 为 reviewer、Runtime、用例与 Judge 派生稳定子 seed。OpenAI-compatible 与方舟链路会发送 seed；Cursor CLI 和外部 A2A Agent 只能尽力复现。

结果中的 `mode` 会区分 `live`、`demo`、`rules`、`failed` 与 `mixed`，不得将混合或模拟评测解释为全链路真实结果。
