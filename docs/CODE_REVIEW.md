# 全仓代码审查记录

审查日期：2026-07-20

## 审查范围

本轮检查了主服务、A2A client、评测流水线、模型与 Runtime adapter、JSON 持久化、前端单页应用、评分规则、示例 Agent、脚本、样式和全部 Node 测试。当前仓库约 3,000 行 JavaScript、CSS 与测试代码。

## 本轮已修复

| 优先级 | 问题 | 处理 |
|---|---|---|
| P1 | `.nav-button` 使用 Grid 后，按钮文字与数量徽标成为两个网格单元，导致“往期战绩 / 数量”上下排列 | 改为单行 Flex，增加 `white-space: nowrap` 和静态回归测试 |
| P1 | A2A Card 或用例字段为错误类型时，`.trim()` / `.forEach()` 可能抛出 500 | 对 Card、skill 和 case prompt 执行严格字符串/数组校验，错误稳定返回 400 |
| P1 | 模型返回越界分数、缺失维度或空评语时仍可能进入汇总 | 增加专业评审结果契约校验，只接受完整的 0–100 数字维度和非空评语/风险 |
| P1 | 真实 Agent 调用失败后，覆盖模式仍可能显示为 LIVE | coverage 改为根据实际 benchmark entry 与失败评审计算，失败标记为 `failed` |
| P1 | SSRF 文本检查没有正确识别带方括号的 IPv6 loopback，也未覆盖 ULA/link-local | 规范化 IPv6 hostname，并拦截 `::/::1`、`fc00::/7`、`fe80::/10` 和 IPv4-mapped IPv6 |
| P2 | 未知 `GET /api/*` 路由会落入 SPA fallback，错误返回 HTML 200 | API namespace 未命中时统一返回 JSON 404 |
| P2 | 历史 JSON 直接覆盖写入，进程中断时可能留下半文件；一次写失败后队列会持续失败 | 改为同目录临时文件 + 原子 rename，并让后续写入可从前一次错误恢复 |
| P2 | 快速连续打开战绩或并发刷新历史列表时，旧请求可能覆盖新状态 | 增加 evaluation/history 请求 token，丢弃过期响应；SSE 绑定具体评测 ID |
| P2 | 远程 Runtime adapter 可通过响应覆盖平台身份字段，且 Skill/output 未严格校验 | 固定 `runtimeId/runtime/mode`，校验 Skill 契约和非空 output，缺少 adapter Key 时直接报错 |
| P2 | `npm run check` 手写文件清单，新增模块可能漏掉语法检查 | 改为自动枚举主服务、源码、前端、脚本、示例与测试中的全部 JavaScript 文件 |

## 仍建议继续优化

### P1：影响评测可信度或生产安全

1. **升级 output judge**：`src/scoring.js` 仍主要按长度、列表和“依据”等关键词评分，容易被格式化长文本刷分。应把用户用例的结构化验收点接入规则断言，再叠加匿名独立 Judge，并记录评分证据。
2. **补齐网络隔离**：`src/a2a.js` 的文本 URL 检查不能阻止 DNS rebinding。生产环境应在解析后校验所有 A/AAAA 地址、固定连接目标，并配合容器出网 allowlist。
3. **限制远程响应体**：Agent Card 有 1 MB 事后检查，但 A2A 输出、模型网关和 Runtime adapter 尚未使用流式字节上限。应在读取过程中截断并返回明确错误，避免异常响应占满内存。
4. **增加身份与租户边界**：当前 API 适合本机 Demo，没有登录、CSRF、租户隔离、配额和删除审计。公网部署前必须补齐。
5. **加固提示词边界**：Agent Card、Skill 与用户 prompt 都是不可信文本。应使用明确的数据分隔、提示注入检测和输出 schema，生产 Runtime 保持工具最小权限。

### P2：影响性能、维护与可访问性

1. **拆分前端模块**：`public/app.js` 同时负责表单、路由、SSE、历史、报告和动效，已超过 500 行。建议按 `api / state / views / renderers / motion` 拆分并增加纯函数测试。
2. **受控并发**：四模型评审和三个 Runtime 构建目前串行，真实模式耗时是各阶段相加。可增加 2–3 的并发上限，同时保留逐项 SSE 落盘和网关限流。
3. **替换单文件存储**：原子 JSON 适合单进程 MVP，但不适合多实例、检索、分页和审计。下一阶段建议迁移 SQLite/PostgreSQL，并给评测、步骤尝试和日志分表。
4. **增加浏览器级 CI**：当前有 Node/API 测试和人工浏览器验收，但缺少固定 viewport 的导航、抽屉、滚动定位和 reduced-motion E2E。
5. **完善抽屉可访问性**：往期战绩抽屉还应增加焦点圈定、Escape 关闭、打开后聚焦标题/关闭按钮以及关闭后恢复触发按钮焦点。

## 推荐实施顺序

1. 结构化验收断言 + 独立 Judge；
2. DNS/出网隔离 + 全链路响应体上限；
3. SQLite/PostgreSQL 与删除审计；
4. 前端模块拆分 + 浏览器 E2E；
5. 有限并发和成本/耗时指标进入最终报告。
