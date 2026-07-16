# 锐评局：A2A Agent 公开评测系统

一个可直接运行的全栈 MVP。用户提交 A2A Agent Card 和真实 prompt 后，平台依次判断 Agent 必要性、进行多模型专业度盲审、让不同 runtime 根据描述现场复刻 skill，再把所有选手放进同 prompt 竞技场，最终给出“夯 / 中 / 拉”的证据化锐评。

## 已实现功能

- A2A 1.0 Agent Card 校验，兼容 0.3 顶层 `url` 形态；
- 文件拖拽、文件选择或 JSON 粘贴；
- 1–5 个同 prompt 测试用例；
- Agent 必要性五维评分与明确判断；
- GPT、Claude、豆包三个模型视角的独立评分、评语和风险；
- Claude Code、Cursor、Doubao 三种 runtime 的 skill 现场复刻抽象；
- 提交 Agent 与三个复刻 skill 的逐用例输出和分数对比；
- SSE 实时进度、可恢复的评测详情和本地历史记录；
- 演示/真实双模式；
- 响应式前端、键盘焦点与 reduced-motion 支持；
- Node 原生测试，无第三方运行依赖。

详细实现、评分规则、接口和生产化建议见 [架构文档](./docs/ARCHITECTURE.md)。

## 快速启动

要求 Node.js 20 或更高版本。

```bash
npm start
```

打开 `http://localhost:4173`，点击“载入狠活示例”，再点击“送进评测舱”即可完整体验。

开发模式：

```bash
npm run dev
```

检查与测试：

```bash
npm run check
npm test
```

## 演示模式与真实模式

演示模式默认可用。它会完整执行协议校验、必要性打分、多模型评语、skill 构建、同题对测和最终分档，但模型与 runtime 输出是基于输入确定生成的模拟数据。界面和结果对象均标记 `DEMO`，不会伪装成真实线上调用。

真实模式会：

1. 调用 Agent Card 声明的 A2A endpoint；
2. 调用 `MODEL_REVIEWERS_JSON` 配置的评审模型；
3. 调用 `RUNTIME_ADAPTERS_JSON` 配置的隔离 runtime 服务。

如果未配置真实 adapter，相关项会保留为 demo；调用失败会记录错误并继续执行其余选手。

## 模型评审配置

`MODEL_REVIEWERS_JSON` 是一个 JSON 数组。OpenAI-compatible 示例：

```json
[
  {
    "id": "gpt",
    "name": "OpenAI 评审",
    "model": "your-model-id",
    "kind": "openai-compatible",
    "baseUrl": "https://your-endpoint.example.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  {
    "id": "claude",
    "name": "Anthropic 评审",
    "model": "your-claude-model-id",
    "kind": "anthropic",
    "baseUrl": "https://api.anthropic.com/v1/messages",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
]
```

配置只引用 API key 的环境变量名；密钥本身不应写入 JSON。

## Runtime adapter 契约

真实 Cursor / Claude Code 等执行器应运行在独立隔离服务中。Web 服务通过 `RUNTIME_ADAPTERS_JSON` 指向它们：

```json
{
  "claude-code": {
    "url": "https://runtime.example.com/claude-code",
    "apiKeyEnv": "RUNTIME_API_KEY"
  },
  "cursor": {
    "url": "https://runtime.example.com/cursor",
    "apiKeyEnv": "RUNTIME_API_KEY"
  },
  "doubao": {
    "url": "https://runtime.example.com/doubao",
    "apiKeyEnv": "RUNTIME_API_KEY"
  }
}
```

构建请求：

```json
{ "action": "build_skill", "agentCard": {} }
```

应返回：

```json
{ "skill": { "name": "...", "description": "...", "instructions": [], "tools": [] } }
```

运行请求：

```json
{ "action": "run_skill", "skill": {}, "prompt": "完全相同的测试 prompt" }
```

应返回：

```json
{ "output": "runtime 的可见最终结果" }
```

## 常用环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `4173` | HTTP 端口 |
| `DATA_FILE` | `data/evaluations.json` | 评测持久化文件 |
| `ALLOW_PRIVATE_AGENT_URLS` | `false` | 是否允许 localhost/私网 Agent URL，仅建议本地开发开启 |
| `MODEL_REVIEWERS_JSON` | 内置三位 demo 评审 | 真实模型 adapter 配置 |
| `RUNTIME_ADAPTERS_JSON` | 内置三种 demo runtime | 隔离 runtime adapter 配置 |

## Git 工作流

项目使用 `codex/agent-review-platform` 功能分支开发。建议后续遵循：

1. 每个功能或修复使用独立 `codex/<topic>` 分支；
2. 提交信息使用动词开头并描述用户可见结果；
3. 提交前运行 `npm run check && npm test`；
4. 不提交 `.env`、API key、运行时评测数据或用户输入产物；
5. 架构、接口或评分口径变化必须同步更新 `README.md` 和 `docs/ARCHITECTURE.md`。

## 当前边界

这是工程化 MVP，不是已经具备科学效度的排行榜。单次输出分数不代表稳定能力；真实生产评测必须增加重复运行、匿名随机排序、独立 judge、规则校验、人工抽查、成本/耗时统计和置信区间。Cursor 与 Claude Code 也没有被主服务直接执行——它们通过明确的隔离 runtime 契约接入，这是有意的安全边界。

协议实现参考 A2A 官方 1.0 规范：`https://a2a-protocol.org/latest/specification`。
