# Panda Market Analyst 生产运行手册

Panda Market Analyst 是 A2A 1.0 市场分析服务。它在每个已完成的上海交易日生成热点主题、卖压观察榜、潜力研究观察榜、Evidence Pack 与 Run Trace，并可通过 SMTP 发送日报。

## 数据边界

所有价格、成交、资金、行业/概念、基本面、估值和风险等金融数据只能来自 `panda_data`。模型只能改写 Evidence Pack 中已有事实，不能补充数据；邮件、进程、缓存和任务状态只属于运行证据。服务不浏览其他金融数据源，不下单、不执行组合，也不提供投资建议。

## 安装

要求 Node.js 20+、Python 3.10，以及可用的 `panda_data` 账号。

Linux/macOS：

```bash
npm ci
python3.10 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-data.txt
cp .env.example .env
```

Windows PowerShell：

```powershell
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements-data.txt
$env:PANDA_DATA_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path
npm run test:market-worker
Copy-Item .env.example .env
```

如果机器只安装了 Windows `py` launcher，可把第一行改为
`py -3.10 -m venv .venv`。测试入口的解释器优先级为
`PANDA_DATA_PYTHON`、仓库 `.venv`、Windows `python`/`py` 或 POSIX
`python3`/`python`；都不可用时会明确失败。

生产环境应锁定 `requirements-data.txt` 中的版本，并把 `PANDA_DATA_PYTHON` 设为虚拟环境 Python 的绝对路径。先用该解释器验证：

```bash
/srv/agent-review/.venv/bin/python -c "import panda_data, pandas, pyarrow; print('panda_data and parquet ready')"
```

## 配置

凭据只写入权限受限的 `.env` 或密钥管理系统，不提交到 Git。服务进程读取以下设置：

| 类别 | 变量 | 说明 |
|---|---|---|
| Panda | `PANDA_DATA_USERNAME`, `PANDA_DATA_PASSWORD` | `panda_data` 登录凭据 |
| Panda | `PANDA_DATA_BASE_URL` | Panda API 地址 |
| Python | `PANDA_DATA_PYTHON` | Python 3.10 解释器绝对路径 |
| Python | `PANDA_DATA_TIMEOUT_MS` | Python worker deadline 的基数（毫秒）；运行时取该值的 10 倍作为整个 worker 子进程期限，不是单次 Panda API 调用超时 |
| A2A | `MARKET_AGENT_HOST`, `MARKET_AGENT_PORT` | 监听地址与端口，默认 `127.0.0.1:4190` |
| A2A | `MARKET_AGENT_PUBLIC_BASE_URL` | 反向代理后的公开 HTTPS 根地址 |
| A2A | `MARKET_AGENT_ACCESS_TOKEN` | 保护任务与运行详情的 Bearer token |
| A2A | `MARKET_AGENT_PRINCIPAL_ID` | 稳定、非密钥的所有者标识；轮换 Bearer token 时保持不变 |
| A2A | `MARKET_AGENT_ALLOW_INSECURE_LOOPBACK` | 仅本机开发可设 `true` 以允许无 token |
| 模型 | `MARKET_REPORT_MODEL_ENABLED` | 是否启用可选叙事改写 |
| 模型 | `MARKET_REPORT_MODEL` | 底模名；默认 DeepSeek V4 Pro（继承 `REVIEW_MODEL_DEEPSEEK` / `CLAUDE_ARK_MODEL` / `DEEPSEEK_CLAUDE_MODEL`，否则 `deepseek-v4-pro[1m]`） |
| 模型 | `MARKET_REPORT_BASE_URL`, `MARKET_REPORT_API_KEY` | 可选专用 OpenAI-compatible 接口；未设置且模型为 DeepSeek V4 Pro 时使用 `ARK_*`，否则回退 `OPENAI_*` |
| 模型 | `MARKET_REPORT_MODEL_PRICING_JSON` | 带版本的输入/输出 token 单价 JSON |
| SMTP | `MARKET_REPORT_EMAIL_TO`, `MARKET_REPORT_EMAIL_FROM` | 逗号分隔收件人和发件人 |
| SMTP | `MARKET_REPORT_SMTP_HOST`, `MARKET_REPORT_SMTP_PORT` | SMTP 地址和端口 |
| SMTP | `MARKET_REPORT_SMTP_SECURE` | `true` 表示隐式 TLS |
| SMTP | `MARKET_REPORT_SMTP_STARTTLS` | 默认要求 STARTTLS；仅明确需要时设 `false` |
| SMTP | `MARKET_REPORT_SMTP_USERNAME`, `MARKET_REPORT_SMTP_PASSWORD` | SMTP 登录凭据 |
| SMTP | `MARKET_REPORT_SEND_FAILURE_ALERTS` | 已实现的失败提醒开关；仅在计划/手动邮件运行、mailer 已配置且失败时生效，设 `false` 禁用 |
| 存储 | `MARKET_REPORT_STATE_DIR` | 任务、产物、trace、邮件状态和锁的根目录 |
| 存储 | `MARKET_REPORT_RETENTION_DAYS` | 预留配置；当前仅解析但尚未执行自动清理，不能据此承诺产物已按期删除 |
| 缓存 | `MARKET_REPORT_CACHE_DAYS` | Panda 日级缓存保留天数 |
| 分析 | `MARKET_REPORT_MIN_LIQUIDITY_CNY` | 默认最低流动性门槛 |
| 调度 | `MARKET_REPORT_TIMEZONE` | 必须为 `Asia/Shanghai` |

生产必须配置 `MARKET_AGENT_ACCESS_TOKEN`，并由 HTTPS 反向代理终止 TLS。`MARKET_AGENT_PRINCIPAL_ID` 是稳定身份而不是凭据；轮换 token 时不要修改它，否则历史定时报告会被有意隔离到旧 owner scope。不要把 token、Panda 或 SMTP 凭据写进 Agent Card、A2A 请求、日志和 trace。

`market-agent` 服务入口会加载仓库 `.env`；一次性 CLI 只继承其启动进程的环境。生产 CLI 应由 systemd `EnvironmentFile` 或等价的受控启动器注入变量，本地运行前也要先在当前会话设置变量，不能假设 CLI 自动读取 `.env`。

## 本地启动与一次性运行

启动 A2A 服务：

```bash
npm run market-agent
```

以当前配置时区的本地日期运行并发送邮件：

```bash
npm run market-report
```

指定历史交易日、仅生成不发信：

```bash
npm run market-report -- --date 2026-07-23 --no-email
```

对同一日期的成功产物会复用；普通重跑可只恢复失败的邮件发送。`--force-delivery` 可能造成重复邮件，只能在人工核对 SMTP/收件箱、确认此前没有投递后使用。

省略 `--date` 不会自动选择上一个已完成交易日：CLI 把当前本地日期交给 worker。若当天是周末或交易所休市日，任务返回 `skipped`；若当天是交易日但上海时间尚未到 15:00，任务失败并报告交易时段未完成。指定未来日期同样失败。

## A2A 1.0

公开探针：

```bash
curl -fsS http://127.0.0.1:4190/health
curl -fsS http://127.0.0.1:4190/.well-known/agent-card.json
```

认证后的完整日报请求：

```bash
curl -fsS -X POST http://127.0.0.1:4190/a2a/v1/message:send \
  -H "Authorization: Bearer ${MARKET_AGENT_ACCESS_TOKEN}" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/a2a+json" \
  --data '{"message":{"messageId":"report-20260723-01","role":"ROLE_USER","parts":[{"mediaType":"application/json","data":{"operation":"daily-market-report","date":"2026-07-23","topN":10}}]},"configuration":{"acceptedOutputModes":["text/markdown","application/json"]}}'
```

流式请求把路径改为 `/a2a/v1/message:stream`，并加 `Accept: text/event-stream`。其他结构化操作为 `hot-topic-analysis`、`sell-pressure-scan`、`potential-watchlist`，以及只读的：

```bash
curl -fsS -X POST http://127.0.0.1:4190/a2a/v1/message:send \
  -H "Authorization: Bearer ${MARKET_AGENT_ACCESS_TOKEN}" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/a2a+json" \
  --data '{"message":{"messageId":"trace-01","role":"ROLE_USER","parts":[{"mediaType":"application/json","data":{"operation":"inspect-run-trace","runId":"RUN_ID"}}]}}'
```

任务接口：

- `GET /a2a/v1/tasks`：列出当前调用者的任务；
- `GET /a2a/v1/tasks/{taskId}`：任务状态和产物；
- `POST /a2a/v1/tasks/{taskId}:cancel`：取消活动任务；
- `GET /a2a/v1/tasks/{taskId}:subscribe`：订阅活动任务。

服务按认证主体隔离任务、运行和幂等键；不可访问的资源统一返回 not-found。

## 报告与可追溯详情

以下 URL 都要求相同 Bearer token：

- `/runs/{runId}`：清洗后的运行摘要与详情入口；
- `/runs/{runId}/report`：Markdown 报告；
- `/runs/{runId}/evidence`：Evidence Pack；
- `/runs/{runId}/trace`：工具、Panda 调用、响应时间、行数、缓存、重试、token/费用、错误、哈希与结论证据链。

运行数据保存在 `MARKET_REPORT_STATE_DIR`。备份时应保持目录结构和文件权限；任何 trace 和 artifact 哈希不一致都按完整性故障处理。

## 每日 18:30 调度

CLI 会用 Panda 交易日历验证当前日期。周末和交易所休市日安全跳过；交易日 15:00 前会失败而不是跳过；实现不会回退到前一个交易日。默认 18:30 调度位于收盘后，但交易所日历仍是最终依据。

systemd 推荐拆分长期 A2A 服务和 oneshot 日报服务。Task 8 只定义运行契约，不交付这些 unit；Task 9 将创建并验证 `deploy/market-analyst.service`、`deploy/market-report.service` 与 `deploy/market-report.timer`。只有 Task 9 完成、unit 已安装后才执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now market-analyst.service
sudo systemctl enable --now market-report.timer
systemctl list-timers market-report.timer
```

timer 应使用 `OnCalendar=Mon..Fri *-*-* 18:30:00 Asia/Shanghai`、`Persistent=true`；服务器时区不同也不得改变上海时间语义。

Windows Task Scheduler：

1. 创建仅在服务账号登录与否都运行的任务，工作目录设为仓库绝对路径。
2. 触发器为每周一至周五 18:30，系统时区设为“中国标准时间”。
3. 程序为 Node.js 绝对路径，参数为 `agents\market-analyst\cli.js`。
4. 通过受控 PowerShell 启动器从服务账号可读的安全配置设置进程环境，勾选失败重试，并禁止同一任务并行启动；不要把凭据直接写进任务参数。
5. 用“运行”执行一次，检查退出码、任务状态、产物哈希和邮件 receipt。

## 故障恢复

### 运行锁

同一报告日只允许一个 owner。遇到 `RUN_LOCKED` 时先确认原进程是否仍在运行；不要直接删除锁。锁元数据变旧且 owner 已死亡时实现会安全回收。若元数据损坏，先停止所有 market-agent/report 进程，备份 `state/locks/{date}.lock`，再由运维人员隔离该特定目录并重启；不要递归删除整个状态目录。

### 邮件失败或状态不明

同日期普通重跑会验证已落盘的正文/HTML/哈希并只尝试所需投递。`delivery-unknown` 或 `reconciliation-needed` 表示服务器可能已经收信：先查 SMTP message ID、服务端日志和收件箱，避免自动重发。只有确认未送达后才使用：

```bash
npm run market-report -- --date 2026-07-23 --force-delivery
```

### 缓存陈旧或损坏

缓存位于 `MARKET_REPORT_STATE_DIR/cache`，带日期、请求和内容完整性约束。先停止写入进程，保留故障样本，把受影响的特定日期缓存移动到状态目录外的隔离位置，再重跑该日；worker 会从 Panda 重建。不得手工修改缓存，也不得用其他数据源填补。

### 失败任务

先读取 `/runs/{runId}/trace`，定位是 Panda、覆盖率、验证、模型还是 SMTP 阶段。保留失败 task 和 trace 供审计。修复凭据、网络或配置后以相同日期重跑；不要编辑任务状态或伪造成功 artifact。A2A 活动任务可取消，终态任务不可变更。

## 生产 live smoke

live smoke 需要真实 Panda 与 SMTP 凭据，不能用 mock 结果冒充：

1. 在隔离状态目录中配置真实凭据、绝对 `PANDA_DATA_PYTHON` 和测试收件人。
2. 运行 `npm test` 与 `npm run check`。
3. 先执行历史已完成交易日的 `--no-email`，确认报告、Evidence Pack、Run Trace、Panda 调用/行数/耗时/缓存与哈希完整。
4. 启动 A2A 服务，获取 Card；用 Bearer token 发送一条 `daily-market-report`，再读取 task、report、evidence、trace。
5. 执行一次邮件投递，核对确定性 Message-ID、SMTP receipt、纯文本/HTML 正文和测试收件箱。
6. 再跑同一日期，确认复用与幂等；模拟一次可恢复失败，确认 trace、锁清理和重试状态。
7. 删除 live-smoke 凭据前保存脱敏验收记录。若任一外部调用未真实完成，结论必须标为“未完成 live smoke”。

## Verification Record

Recorded on 2026-07-25. Automated evidence is distinct from credential-gated
external acceptance; fixture or fake-SMTP coverage is never represented as a
real Panda or mailbox result.

| # | Acceptance criterion | Evidence and status |
|---:|---|---|
| 1 | Real Panda run creates Markdown, HTML, Evidence Pack, and Run Trace | **Conditional — not run.** `npm run market:smoke` performs bounded real collection and validates all five artifact names, sizes, SHA-256 values, JSON schemas, and run identity. Real credentials were not available during this record. |
| 2 | SMTP receives exactly one message per delivery key | **Conditional — not run.** Fake-SMTP integration tests verify deterministic delivery key/Message-ID, accepted receipt persistence, and retry reconciliation. Real SMTP receipt/inbox confirmation requires `MARKET_SMOKE_EMAIL_TO`. |
| 3 | Repeated non-forced run does not duplicate email | **Automated fixture verified; external conditional.** Email/integration tests cover same-date reuse, already-sent suppression, and explicit force-delivery. Real mailbox acceptance was not run. |
| 4 | Email contains the three analyses, dates, confidence, and disclaimer | **Automated fixture verified; external conditional.** Report and email tests inspect the exact text/HTML artifacts used for delivery. Real mailbox rendering was not run. |
| 5 | Conclusions resolve to evidence and Panda call traces | **Automated verified.** Evidence schema, report validation, lineage, artifact-integrity, and integration tests reject orphaned claims. Real Panda evidence remains conditional under item 1. |
| 6 | Trace exposes durations, tools, Skills, rows, dates, cache/retry, and model usage | **Automated verified.** Trace/state/report tests cover bounded sanitized call timing, rows, hashes, cache/retries, Skill/tool steps, and optional model token/cost fields. |
| 7 | No secret appears in artifacts, logs, HTTP, or email | **Automated verified; external inspection conditional.** Redaction, bounded trace, A2A authorization, SMTP masking, and smoke-summary tests pass. A real external smoke still requires operator log/artifact inspection. |
| 8 | A2A 1.0 Card is discoverable and valid | **Automated verified.** Card discovery and protocol metadata conformance tests pass; live smoke fetches the ephemeral loopback Card. |
| 9 | A2A send, stream, get, list, cancel, subscribe conform | **Automated verified.** Full A2A lifecycle, media type/version, SSE ordering, owner isolation, idempotency, projection, and error-shape tests pass. |
| 10 | Model absence still renders and emails deterministically | **Automated fixture verified; external SMTP conditional.** Integration tests exercise model-disabled/fallback rendering with fake SMTP. |
| 11 | Optional data loss produces a marked degraded report | **Automated verified.** Worker and integration degradation fixtures assert explicit missing-data/confidence treatment. |
| 12 | Core data loss emits no conclusions and only optional failure notice | **Automated verified.** Worker/orchestrator/integration failure fixtures assert fail-closed conclusions and the configured alert boundary. |
| 13 | 18:30 Shanghai automation skips exchange holidays | **Automated verified.** The systemd contract test pins `Mon..Fri *-*-* 18:30:00 Asia/Shanghai`, persistence, and 30-second jitter; worker/CLI tests keep Panda’s calendar authoritative. |
| 14 | Full test and syntax commands pass | **Verified 2026-07-25.** `npm run check` validated 71 JavaScript files; the exact absolute-Python `npm test` command passed 240 Node tests and 62 Python tests; `git diff --check` passed. |
