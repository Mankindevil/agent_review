# 评测与打分规则

本文件记录当前版本实际执行的评测规则。网页版本源码为 [`public/methodology.html`](../public/methodology.html)，运行项目后访问 `/methodology.html`。规则实现以 `src/a2a.js`、`src/scoring.js`、`src/prompts.js` 和 `src/pipeline.js` 为准。

## 0. A2A 准入

准入只决定能否创建评测，不计分。Agent Card 必须：

- 是 JSON 对象，包含非空 `name`、`description`；
- 至少声明一个 skill，且每个 skill 都有 `id`、`name`、`description`；
- 包含 A2A 1.0 `supportedInterfaces`，或兼容 0.3 的顶层 `url`。

失败返回 HTTP 400，不进入后续阶段。Card URL / 服务发现还检查 HTTP(S)、私网 URL 策略、1 MB 响应上限与禁止重定向。

## 1. Agent 必要性

程序先把以下字段以空格拼成一段文本：Card 的 `description`；每个 skill 的 `name`、`description`、`tags[]`、`examples[]`；全部测试用例的 `prompt`。URL、Runtime 输出和源码不参与必要性信号匹配。

变量定义：

- `C`（Complex signal groups）：命中的复杂信号组数量，取值 0–8；
- `S`（Simple-transform signal）：是否命中简单变换组，取值 0 或 1；
- `K`（Skill count）：Card 的 skill 数量；字母 S 已用于简单信号，因此取 skill 中的 K；
- `N`（Number of use cases）：测试用例数量，正常范围 1–5；
- `U`（Use-case indicator）：有测试用例为 1，否则为 0；正常提交恒为 1；
- `B`（Capability bonus）：`streaming=true` 加 5，`pushNotifications=true` 加 6，`extensions` 非空加 4，可叠加，范围 0–15。

这些变量只在“必要性”阶段内有效。最终分档章节会重新定义局部变量，其中 `C` 表示 Claude Code 均分；它与本节表示 Complex signals 的 `C` 不会进入同一个公式。

复杂信号分为 8 个正则组。每个组扫描一次完整拼接文本，不区分英文大小写；组内任意词出现即命中该组。同组重复出现只计 1，不同组可以由同一段文字同时命中。

| 组 | 含义 | 当前匹配词 | 命中效果 |
|---|---|---|---|
| G1 | 多步编排 | 多步、multi-step / multi step、workflow、编排、`orchestrat*` | `C + 1` |
| G2 | 人机节点 | 审批、human-in-the-loop、确认、澄清、`clarif*` | `C + 1` |
| G3 | 外部系统 | 外部系统、API、database、数据库、检索、browser、工具 | `C + 1` |
| G4 | 文件文档 | 文件、document、PDF、合同、附件、artifact | `C + 1` |
| G5 | 跨文档核对 | 制度、跨文档、multiple documents、交叉核对、cross-check / cross check | `C + 1` |
| G6 | 证据与合规 | 证据、风险、冲突、审查、verify、validation、合规 | `C + 1` |
| G7 | 状态与异步 | 状态、记忆、memory、异步、async、long-running | `C + 1` |
| G8 | 规划与恢复 | 规划、plan、分支、重试、retry、监控、monitor | `C + 1` |

简单变换组匹配：整理文件、重命名、摘要、翻译、改写、分类、format、summarize / summarise、translate、rename。无论命中多少个词都只令 `S=1`。复杂组与简单组可同时命中，例如“整理文件”会命中 G4，同时令 `S=1`。

`clamp` 的默认上下限是 0 和 100，准确实现为：

```text
clamp(x) = min(100, max(0, x))
```

因此 `x < 0` 返回 0，`0 ≤ x ≤ 100` 返回 x，`x > 100` 返回 100。

五维公式均限制在 0–100：

```text
步骤深度   = clamp(18 + 10C - 5S)
工具依赖   = clamp(12 + 9C + 3K)
状态与分支 = clamp(10 + 8C + B)
不确定性   = clamp(22 + 8U + 5C)
复用价值   = clamp(26 + 7K + 4N + 4C)
必要性总分 = round(五维算术平均)
```

手算示例：若 `C=5、S=0、K=1、N=2、U=1、B=5`，五维依次为 68、60、55、55、61；总分为 `round((68+60+55+55+61)/5) = round(59.8) = 60`。

当前命中属于可审计的关键词/正则启发式，不是语义理解，可能存在漏判或字符串误命中。算法保持透明是为了便于复算，不代表必要性分是客观真理。

阈值：

- 0–35：模型直出更划算，最终评级强制为“拉”；
- 36–59：Agent 价值存疑；
- 60–100：值得 Agent 化。

## 2. 多模型专业度

每个评审只看公开 Card，并独立给出领域深度、流程设计、异常处理、输出契约、可评测性五个维度，以及总分、评语与首要风险。

后端使用模型返回的 `score` 作为该模型总分，不从五维二次计算。仅 `score > 0` 的成功评审进入专业度算术平均；调用失败保留 0 分和错误，但不进入平均。全部失败时专业度为 0。

专业度进入报告与审计，但当前不直接参与最终四档决策树。Demo 模式的评审是由 Card、reviewer ID 与 seed 确定生成的模拟结果。

## 3. Runtime Skill 复刻

Claude Code、Cursor Agent 与 Doubao Agent 只接收 Agent Card 顶层 `description` 的同一段原文，生成包含 `name`、`description`、`instructions`、`tools` 的 Skill。它们不接收 Card 的 name、skills、examples、tags、capabilities、接口地址，也不接收提交 Agent 的实现或输出。构建阶段不打 0–100 分。

这是刻意设置的 description-only 基线：它衡量“只把产品描述交给强模型，临时直出一个 Skill”能做到什么程度。若把完整 Card 或原 Agent 产物交给 Runtime 再增强，得到的就不再是独立基线，不能用于判断固定 Agent 流程是否真的带来增益。

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
- 重建 Runtime：替换 Skill，并重新执行全部同 Prompt 对测用例；
- 重跑一局：替换指定用例、指定选手结果。

重试不取历史最高分。最新结果原位替换后，专业度、各选手均分、差值和最终评级全部重算，前后摘要写入 `retryHistory`。

根 seed 为 reviewer、Runtime、用例与 Judge 派生稳定子 seed。OpenAI-compatible 与方舟链路会发送 seed；Cursor CLI 和外部 A2A Agent 只能尽力复现。

结果中的 `mode` 会区分 `live`、`demo`、`rules`、`failed` 与 `mixed`，不得将混合或模拟评测解释为全链路真实结果。
