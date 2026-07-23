# Agent 参评技术预检设计

> 2026-07-24 修订：测试平台以单个 Agent Card JSON 为技术输入；团队与作品材料由最终报名表收集。

## 目标

将现有 Agent 协议检查台升级为与评选标准一致的“一次性技术预检”入口。用户上传或粘贴一份 A2A Agent Card JSON，平台验证 Card、真实调用 Agent，并检查自然语言任务与 20 分钟响应要求。

平台继续保持：

- 使用平台访问密钥；
- 一次请求返回完整报告；
- 不保存上传文件、凭据、测试历史或正式投稿；
- 不执行正式评分、排名和人工评审。

最终报名表单独收集团队信息、作品说明文档、示例问题与预期输出、数据 Skills、投研 Skills、代码仓库地址及正式 Agent Card URL。测试平台不重复收集这些字段。

## 参评对象与多 Agent 规则

一份上传 JSON 必须是一张 Agent Card，而不是 Card 数组或平台自定义的多 Agent 清单；一张 Card 对应一个技术预检结果。

- 内部由多个子 Agent 组成、但只通过一个编排 Agent 对外服务的系统，可以提交编排 Agent 的一张 Card。平台把整个系统视为一个不透明的参评对象，不探测内部拓扑、子 Agent、提示词、记忆或工具。
- 多个 Agent 分别具有独立身份和独立对外接口时，每个 Agent 应分别提供 Agent Card，并逐个上传、逐个测试。
- 多个 Agent 可以共用域名、网关或服务端点。平台支持 Card 中不同 URL 路径、由鉴权凭据路由，以及 A2A 1.0 `supportedInterfaces[].tenant` 路由。
- 所选接口声明 `tenant` 时，平台必须把该值原样放入每一次对应的 A2A 请求；未声明时不得擅自添加。
- Card 的 `skills` 描述当前对外 Agent 或编排系统的公开能力，不用列出内部所有子 Agent。

## 自动验证与人工边界

### 测试平台自动验证

- 上传内容是单个合法 JSON 对象；
- Agent Card 必填信息完整，并声明平台支持的 A2A 接口；
- Card 中的服务地址为公开 HTTP(S) 地址并通过 SSRF 检查；
- Agent 能接收自然语言 Prompt；
- Agent 返回合法的 A2A Message 或 Task；
- 普通调用在用户选择的 1–20 分钟上限内完成；
- 用户启用流式检查时，第二次调用在同样的独立上限内到达明确终态；
- Card 声明的 `tenant` 被正确透传。

### 提交者声明，后续人工核验

测试前必须确认：

- 底座模型为 `DeepSeek V4 Pro`；
- Agent 不绕过平台权限访问未授权数据。

以下要求不可能通过一次技术调用可靠证明，由最终报名表与评审流程核验：

- Agent Card 内容真实；
- 正式 Agent Card URL 在评审期间保持可访问；
- 服务在评审期间稳定在线；
- 输出过程和最终结果清晰、可解释；
- 团队、作品说明、示例问答、Skills 和代码仓库材料真实完整。

声明只代表提交者确认，不代表平台已经从技术上证明。

## 用户流程

1. 用户打开 `/agent-check.html`。
2. 输入平台访问密钥。密钥只存在页面内存中。
3. 通过文件选择器上传 `.json` 文件，或把 Agent Card JSON 粘贴到文本框。两者同时存在时，以最后一次有效输入为准。
4. 页面在本地解析 JSON，并显示 Agent 名称、描述、协议版本、所选接口、`tenant`、Skills 数量和流式能力摘要。
5. 用户选择 Agent 鉴权方式：无鉴权或 Bearer Token。选择 Bearer 时，页面显示 Card 选中接口的完整目标 origin，用户确认后 Token 才能发出。
6. 用户填写自然语言测试 Prompt，选择 1、5、10 或 20 分钟的单次响应上限。
7. 用户确认 `DeepSeek V4 Pro` 与“仅访问授权数据”两项声明。
8. 流式检查默认关闭。开启后必须确认同一 Prompt 将再次真实执行。
9. 页面提交预检并展示 JSON 输入、Card 校验、普通调用、可选流式调用和参评技术门槛结果。
10. 页面刷新后，访问密钥、Agent Token、上传内容和结果全部消失。

## 请求契约

沿用 `POST /api/agent-diagnostics`。平台访问密钥继续使用：

```http
Authorization: Bearer <AGENT_DIAGNOSTICS_ACCESS_KEY>
```

JSON 请求体：

```json
{
  "agentCard": {
    "name": "Research Agent",
    "description": "完成公开市场研究任务",
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
    "skills": []
  },
  "authMethod": "bearer",
  "agentAuthorization": "agent bearer token",
  "confirmAuthorizationTarget": true,
  "prompt": "请完成一个无外部副作用的自然语言测试任务，并说明结论与依据。",
  "timeoutMs": 300000,
  "runStreaming": false,
  "confirmStreamingSideEffects": false,
  "attestations": {
    "deepseekV4Pro": true,
    "authorizedDataOnly": true
  }
}
```

字段规则：

- `agentCard`：必填 JSON 对象，序列化后最大 1 MiB；数组、字符串和 `null` 无效；
- `authMethod`：必填，取值为 `none` 或 `bearer`；
- `agentAuthorization`：`bearer` 时必填，最大 8 KiB 且不得包含换行；`none` 时必须为空；
- `confirmAuthorizationTarget`：`bearer` 时必须为 `true`，表示用户已确认页面显示的目标 origin；`none` 时必须为 `false` 或省略；
- `prompt`：必填，1–4,000 个 Unicode 字符；
- `timeoutMs`：服务端只接受 `60,000–1,200,000` ms，默认 `300,000` ms；
- `runStreaming`：默认 `false`；
- `confirmStreamingSideEffects`：`runStreaming=true` 时必须为 `true`；
- `attestations.deepseekV4Pro` 与 `attestations.authorizedDataOnly`：必须为 `true`。

HTTP 请求体上限调整为 1.25 MiB，以容纳最大 Card 和固定请求字段。浏览器在读取文件前拒绝超过 1 MiB 的文件；服务端仍独立执行大小和类型校验。

旧的 `url`、`sourceType` 输入模式不再用于页面提交。API 对同时出现旧地址字段和 `agentCard` 的请求返回 `400`，避免两个服务地址来源不一致。

## Agent Card 与接口选择

- A2A 1.0 按 `supportedInterfaces` 顺序选择平台支持的第一个接口。
- 兼容 A2A 0.3 Card 的顶层 `url` 与 `protocolVersion`。
- 平台支持 A2A 1.0 HTTP+JSON、A2A 1.0 JSON-RPC 和 A2A 0.3 JSON-RPC；不支持 gRPC 与自定义 binding。
- 未知 binding 不得猜测为 HTTP+JSON。
- 服务地址完全来自上传 Card 的所选接口，页面仅展示，不允许另填覆盖地址。
- 所选接口的 URL 必须通过现有公共地址、DNS/IP、地址固定和禁止重定向检查。
- Card 中存在多个独立接口时，本次只测试首个受支持接口，并在结果中明确显示选择依据。
- `tenant` 是不透明字符串；平台不解释其内容、不修改格式，也不将它当作组织或团队信息。

由于技术入口只接收上传的 Card JSON，而不接收正式 Card URL，本流程验证“Card 结构与声明接口可调用”，不声称验证“正式 Card URL 可访问”。正式报名表应收集 Card URL，并在报名或评审阶段另行执行可访问性检查。

## 执行与结果

一次请求依次执行：

1. **JSON 输入**：服务端确认 `agentCard` 为单个对象、大小合规且没有冲突的旧地址字段。
2. **Card 校验**：校验必填字段并选择受支持接口；静态校验失败时不进行 DNS 或出站请求。
3. **普通调用**：按版本和 binding 构造自然语言 `SendMessage` 请求，透传所选接口的 `tenant`，接受合法 Message 或 Task。
4. **流式调用**：仅在用户开启、二次确认且 Card 声明 streaming 时执行；它是第二次真实调用。
5. **技术门槛**：汇总 Card、普通调用、20 分钟限制和两项声明。

响应保留现有 `checks` 结构，并新增：

```json
{
  "ok": true,
  "technicalReadinessOk": true,
  "technicalReadiness": {
    "checks": [
      {
        "id": "agent-card",
        "status": "passed",
        "summary": "上传的 Agent Card 结构完整"
      },
      {
        "id": "a2a-call",
        "status": "passed",
        "summary": "自然语言 A2A 调用成功"
      },
      {
        "id": "response-time",
        "status": "passed",
        "summary": "普通调用在所选上限内完成"
      },
      {
        "id": "competition-attestations",
        "status": "declared",
        "summary": "两项参评声明已确认，仍需人工核验"
      }
    ]
  },
  "checks": []
}
```

状态固定为：

- `passed`：平台已自动验证；
- `failed`：技术门槛不满足；
- `declared`：提交者已确认，仍需人工核验；
- `skipped`：用户没有请求可选检查；
- `blocked`：依赖的前置阶段失败。

`ok` 与 `technicalReadinessOk` 都要求 Card 校验、普通调用和响应时限通过，且两项声明已确认。未请求流式检查不影响结果；请求后流式失败通过 `streamingOk=false` 独立显示，不改变普通调用已经得出的基础技术预检结论。

## 超时语义

页面提供：

- 1 分钟；
- 5 分钟，默认；
- 10 分钟；
- 20 分钟。

服务端拒绝而非静默钳制超出 `60,000–1,200,000` ms 的值，避免页面显示值与实际执行值不一致。

- 普通 Agent 调用使用一份完整的用户选择上限；
- 流式调用使用另一份独立的相同上限；
- DNS 和连接建立计入对应调用耗时；
- 浏览器断连立即取消当前请求；
- 任何单次 Agent 调用都不能超过 20 分钟；
- 报告同时显示选择的上限与实际 `durationMs`。

## 页面设计

页面沿用现有协议检查台的深色操作台视觉，不改造成报名后台。信息结构收敛为四区：

1. **Agent Card JSON**：文件拖放/选择、粘贴文本框、解析摘要和错误定位；
2. **服务实测**：鉴权方式、Agent Token、Token 目标 origin 确认、测试 Prompt、超时选项和默认关闭的流式开关；
3. **参评声明**：`DeepSeek V4 Pro` 与“仅访问授权数据”两项确认，并明确标注待人工核验；
4. **预检报告**：技术门槛摘要，以及 JSON、Card、普通调用和流式调用轨迹。

页面固定提示：

- “一次只测试一张 Agent Card”；
- “内部多 Agent 可通过一个编排 Agent 整体参评；独立 Agent 请分别上传”；
- “团队与作品材料在最终报名表填写”；
- “测试会真实调用 Agent，流式检查会再次执行同一任务”。

所有动态 Card 内容和响应预览继续使用 `textContent` 渲染。界面支持窄屏、键盘焦点和 `prefers-reduced-motion`。

## 安全与错误处理

- JSON 语法、对象类型、字段格式、冲突字段或请求体大小错误返回 HTTP `400`；
- 平台访问密钥错误返回 `401`，未配置返回 `503`；
- 频率超限返回 `429`，并发已满返回 `503`；
- 预期的上游 Agent 失败仍返回 HTTP `200` 和 `ok:false` 的结构化报告；
- 静态 Card 或声明失败时不得解析 DNS、打开连接或调用 Agent；
- Agent Token 不用于任何 Card 获取；服务端只有在目标确认有效后才把它发往 Card 选择出的接口；
- 所选接口与任何其他来源不同源时也不自动转发 Token；
- 沿用禁止 URL userinfo、私网地址、重定向、DNS rebinding、超限响应和敏感数据回显的保护；
- 报告不包含平台访问密钥、Agent Token、完整请求头、完整上游响应或本地路径；
- 上传文件和解析结果仅存在浏览器内存，服务端不落盘、不写入评测历史。

## 测试

- 输入测试覆盖合法单对象、数组、`null`、无效 JSON、1 MiB Card、1.25 MiB 请求体和旧字段冲突；
- Card 测试覆盖 A2A 1.0、A2A 0.3、多个接口、未知 binding、缺失必填字段和服务 URL；
- 多 Agent 测试覆盖单张组合 Agent Card、拒绝 Card 数组，以及共享 URL 下的 `tenant` 透传与未声明时省略；
- 凭据测试覆盖 `none`/`bearer` 一致性、换行 Token、目标 origin 未确认、只向所选接口发送和结果脱敏；
- 门槛测试确认静态失败时零出站请求且后续阶段均为 `blocked`；
- 超时测试覆盖 1 分钟下限、5 分钟默认、10 分钟、20 分钟上限和超范围拒绝；
- 结果测试覆盖 `technicalReadinessOk`、综合 `ok`、声明状态与实际耗时；
- 前端静态和浏览器测试覆盖 JSON 文件/粘贴输入、摘要、两项声明、四个超时选项、流式二次确认和多 Agent 提示；
- 回归测试继续覆盖 SSRF、DNS 地址固定、A2A 1.0/0.3、SSE 终态、取消传播、不写入历史与凭据不进入 Web Storage；
- 完成后运行 `npm test`、`npm run check` 和补丁格式检查。

## 文档

同步更新：

- `docs/AGENT_DIAGNOSTICS_GUIDE.md`：上传格式、操作步骤、多 Agent 规则、鉴权、结果解释、安全边界和故障排查；
- `README.md`：将入口描述改为 Agent Card JSON 技术预检；
- `.env.example`：保留现有环境变量，无需增加正式报名表配置。

## 非目标

- 不收集团队、作品说明、示例问答、Skills 清单或仓库地址；
- 不保存、分享或导出正式投稿；
- 不接受 Agent Card 数组或平台自定义多 Agent 清单；
- 不发现或审计组合 Agent 内部的子 Agent；
- 不自动检测真实底座模型；
- 不通过单次调用证明服务长期稳定、Card 内容真实或输出始终可解释；
- 不验证正式 Agent Card URL 的持续可访问性；
- 不执行正式评分、排名或评委模型评审；
- 不新增 OAuth、API Key 自定义请求头或浏览器交互登录；
- 不支持 gRPC 或自定义 A2A binding。
