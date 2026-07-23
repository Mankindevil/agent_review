# Agent 参评资格预检设计

## 目标

将现有 Agent 协议检查台升级为“参评资格预检 + A2A 实测”入口。平台同时检查参评材料完整性、参评声明和可自动验证的技术要求，并继续保持一次性执行、不保存历史、不进入正式评分。

最终结果区分：

- `eligibilityOk`：参评材料、强制声明和响应时限是否满足要求；
- `diagnosticsOk`：Agent Card 发现、协议校验和普通调用是否通过；
- `ok`：以上两者均为 `true`。

## 判断边界

平台只把能由当前请求可靠证明的项目标记为自动验证通过。

### 自动验证

- 参评材料必填字段完整且格式有效；
- Agent Card 可访问、字段完整，并声明平台支持的 A2A 接口；
- 所选接口与提交的服务地址一致；
- Agent 能接收自然语言 Prompt 并返回合法 Message 或 Task；
- 单次普通调用在用户选择的 1–20 分钟上限内完成；
- 用户启用流式检查时，第二次调用在同样的独立上限内到达明确终态。

### 声明后进入人工核验

- Agent Card 内容真实；
- 服务在评审期间稳定在线；
- 输出过程和最终结果清晰、可解释；
- Agent 不绕过平台权限访问未授权数据；
- 底座模型为 `DeepSeek V4 Pro`。

勾选声明表示提交者承诺满足要求，不表示平台已从技术上证明。结果页面必须明确显示“已声明，待人工核验”。

## 方案

沿用独立页面 `/agent-check.html` 和接口 `POST /api/agent-diagnostics`，不新增持久化投稿系统。

一次请求分两层执行：

1. 服务端先校验参评材料和强制声明。硬门槛失败时直接返回结构化报告，不进行任何出站请求。
2. 静态门槛通过后，执行 Agent Card 发现、接口核验、普通调用及可选流式调用。

不采用纯前端校验，避免绕过；不新增数据库和投稿历史，避免把一次性检查台扩张为作品管理系统。

## 提交数据

请求体新增必填 `submission` 对象：

```json
{
  "submission": {
    "agentName": "研究 Agent",
    "description": "Agent 的能力、使用场景和限制",
    "team": "团队名称、成员或联系方式",
    "cardUrl": "https://example.com/.well-known/agent-card.json",
    "serviceUrl": "https://example.com/a2a",
    "authMethod": "none",
    "documentationUrl": "https://example.com/docs/agent",
    "examples": [
      {
        "question": "分析某项自然语言投研任务",
        "expectedOutput": "预期的输出范围、结构和证据"
      }
    ],
    "dataSkills": ["行情数据"],
    "researchSkills": ["因子研究"],
    "repositoryUrl": "https://github.com/example/agent",
    "foundationModel": "DeepSeek V4 Pro",
    "attestations": {
      "accurateCard": true,
      "stableOnline": true,
      "clearExplainableOutput": true,
      "authorizedDataOnly": true,
      "deepseekV4Pro": true
    }
  },
  "agentAuthorization": "",
  "prompt": "请完成一个无外部副作用的自然语言测试任务，并清晰说明结论与依据。",
  "timeoutMs": 300000,
  "runStreaming": false,
  "confirmStreamingSideEffects": false
}
```

字段规则：

- `agentName`：1–120 个 Unicode 字符；
- `description`：1–2,000 个 Unicode 字符；
- `team`：1–1,000 个 Unicode 字符；
- `cardUrl`、`serviceUrl`：必填公开 HTTP(S) URL，最大 2,048 字符；
- `authMethod`：`none` 或 `bearer`；选择 `bearer` 时页面提供现有 Agent Token 输入框；
- `documentationUrl`：必填 HTTP(S) URL，最大 2,048 字符；
- `examples`：1–3 组；问题最大 2,000 字符，预期输出最大 4,000 字符；
- `dataSkills`、`researchSkills`：各至少 1 项、最多 30 项，每项最大 120 字符；
- `repositoryUrl`：可选 HTTP(S) URL；
- `foundationModel`：去除首尾空格并忽略大小写后必须等于 `DeepSeek V4 Pro`；
- 五项 `attestations` 均必须为 `true`。

请求体上限由 32 KiB 调整为 64 KiB。平台访问密钥与 Agent Token 的既有范围、脱敏和不持久化规则不变。

## 地址和鉴权

- Agent Card 始终从 `submission.cardUrl` 获取，不再要求页面用户选择地址类型。
- `submission.serviceUrl` 是参评者声明的服务地址。
- Card 校验阶段选择首个受支持接口后，要求其 URL 与 `serviceUrl` 同源，且接口 URL 的路径位于提交服务地址路径下；不一致时阻断调用并提示修正材料或 Card。
- Agent Token 不用于 Card 获取，只用于所选 A2A 调用接口。
- Card URL 与调用接口不同源时，继续要求显式勾选跨域 Token 转发。
- `authMethod=none` 时不得提交 Agent Token；`authMethod=bearer` 时 Token 为可选，因为部分服务可能允许匿名测试。

## 资格报告

响应新增：

```json
{
  "ok": true,
  "eligibilityOk": true,
  "diagnosticsOk": true,
  "eligibility": {
    "checks": [
      {
        "id": "submission-materials",
        "status": "passed",
        "summary": "参评材料完整"
      },
      {
        "id": "competition-declarations",
        "status": "declared",
        "summary": "强制声明已确认，仍需人工核验"
      },
      {
        "id": "response-time",
        "status": "passed",
        "summary": "普通调用在 20 分钟内完成"
      }
    ]
  },
  "checks": []
}
```

资格状态固定为：

- `passed`：平台已自动验证；
- `failed`：硬门槛不满足；
- `declared`：提交者已声明，仍需人工核验；
- `blocked`：依赖的技术调用未完成，无法判断。

静态材料或声明失败时：

- HTTP 仍返回 `200`；
- `eligibilityOk=false`、`diagnosticsOk=false`、`ok=false`；
- 四个协议检查均为 `blocked`；
- 不解析 DNS、不读取 Card、不调用 Agent。

`response-time` 以普通调用阶段的实际 `durationMs` 为准。普通调用失败或超时则为 `failed`；因前置失败未调用则为 `blocked`。流式耗时独立显示，不重复决定基础参评资格。

## 超时语义

页面提供：

- 1 分钟；
- 5 分钟，默认；
- 10 分钟；
- 20 分钟。

服务端把 `timeoutMs` 钳制到 `60,000–1,200,000` ms，默认 `300,000` ms。

为准确对应“Agent 从收到任务到完成结果返回不超过 20 分钟”：

- Card 发现使用独立的 30 秒上限；
- 普通 Agent 调用使用用户选择的完整上限；
- 流式调用是第二次真实执行，也使用一份独立的完整上限；
- 浏览器断连仍立即取消当前请求；
- 任何单次 Agent 调用都不能超过 20 分钟。

## 页面调整

页面保持现有“协议检查台”视觉语言，增加两个输入区和一个资格结果区：

1. **参评材料**：名称、简介、团队、Card URL、服务地址、鉴权方式、说明文档、示例问答、两类 Skills、可选仓库、底座模型；
2. **参评声明**：五个必须逐项确认的声明，旁边固定显示“声明不等于自动证明”；
3. **服务实测**：Agent Token、跨域授权、测试 Prompt、单次响应上限、流式开关；
4. **资格门槛**：材料完整性、参评声明、20 分钟响应要求；
5. **协议轨迹**：保留发现、Card、普通调用和流式调用四张结果卡。

示例问答首版提供一组问题和预期输出输入框，API 结构保留最多三组的能力；后续可以增加动态“添加示例”而不改变接口。

## 错误处理

- JSON 类型或字段格式错误返回 HTTP `400`；
- 格式正确但不满足参评门槛返回 HTTP `200` 和资格失败报告；
- 平台访问密钥、频率、并发、SSRF、响应大小和上游错误继续沿用现有状态码与错误分类；
- 所有动态内容继续使用 `textContent` 渲染；
- 返回报告不包含 Agent Token、平台访问密钥、完整响应正文或其他敏感请求头。

## 测试

- 输入测试覆盖所有必填材料、URL、数组上限、模型名称、五项声明和 64 KiB 请求体；
- 门槛测试确认材料失败时零出站请求且四个协议阶段均为 `blocked`；
- 地址测试覆盖 Card 接口与提交服务地址同源/路径匹配和不匹配；
- 超时测试覆盖 1 分钟下限、5 分钟默认、20 分钟上限和超范围钳制；
- 资格汇总测试覆盖 `eligibilityOk`、`diagnosticsOk`、综合 `ok` 和响应耗时状态；
- 前端静态测试覆盖全部提交字段、声明、四个超时选项和资格结果容器；
- 回归测试继续覆盖凭据隔离、SSRF、A2A 1.0/0.3、流式二次确认和不写入历史；
- 完成后运行 `npm test`、`npm run check` 和补丁格式检查。

## 文档

同步更新：

- `docs/AGENT_DIAGNOSTICS_GUIDE.md`：参评材料填写、自动验证与人工核验边界、20 分钟规则；
- `.env.example`：无需新增环境变量；
- `README.md`：将入口描述改为参评资格预检和协议实测。

## 非目标

- 不保存正式投稿；
- 不上传或托管作品说明文件；
- 不自动检测实际底座模型；
- 不通过单次请求证明服务长期稳定；
- 不自动审计 Agent 内部的数据访问实现；
- 不执行正式评分、排名或评委模型评审；
- 不新增 OAuth、API Key 自定义请求头或浏览器交互登录。
