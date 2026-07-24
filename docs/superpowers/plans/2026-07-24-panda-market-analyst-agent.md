# Panda Market Analyst Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-capable, email-delivering, A2A 1.0 market analyst agent whose only financial data source is `panda_data`.

**Architecture:** A Node.js A2A/orchestration layer spawns one fixed-operation Python worker per analytical run. Python authenticates to Panda once, performs bounded DataFrame retrieval and deterministic ranking, and returns a compact Evidence Pack plus trace events; Node persists tasks, renders and validates artifacts, optionally narrates from evidence, and delivers idempotent SMTP email.

**Tech Stack:** Node.js 20+ ESM, native `node:test`, Nodemailer 9.0.3, Python 3.10+, `panda-data==0.0.12`, pandas/NumPy/PyArrow/DuckDB from the Panda SDK, Python `unittest`, A2A 1.0 HTTP+JSON and SSE.

## Global Constraints

- `panda_data` is the only financial data source.
- Default schedule is China trading days at `18:30 Asia/Shanghai`.
- A-shares are the report core; Hong Kong, previous-session US, futures, options, funds/ETFs, and macro are optional context.
- Deterministic code owns every number, score, rank, confidence, penalty, and veto.
- The optional model receives only the Evidence Pack, has no tools, and must fall back to deterministic rendering.
- A2A uses `HTTP+JSON`, protocol version `1.0`, `application/a2a+json`, ordered SSE, and `A2A-Version: 1.0`.
- A2A runs never send email and never accept arbitrary Panda method names, credentials, recipients, file paths, or SMTP settings.
- Never persist Panda credentials/JWT, SMTP credentials, authorization headers, full recipient addresses, or unbounded raw provider responses.
- Do not copy GPL source from QuantSkills; implement repository-local Skills and add attribution links.
- Preserve the user-supplied `接口文档.md` unchanged.
- Follow strict TDD: add one failing behavior test, observe the expected failure, implement the minimum, then run the focused and full suites.

## File Structure

```text
agents/market-analyst/
├── server.js                    process entrypoint
├── cli.js                       one-shot scheduled/manual entrypoint
├── config.js                    validated env-to-config mapping
├── schemas.js                   Evidence Pack and operation validation
├── orchestrator.js              shared run workflow
├── task-store.js                atomic task persistence
├── run-lock.js                  cross-process report-date lock
├── run-trace.js                 trace builder and redaction
├── worker-runner.js             Python process/NDJSON trace adapter
├── report-renderer.js           deterministic Markdown/HTML
├── report-validator.js          evidence/narrative/report invariants
├── narrative-adapter.js         optional OpenAI-compatible narrator
├── smtp-mailer.js               idempotent SMTP delivery
├── agent-card.js                A2A 1.0 discovery document
├── a2a-server.js                HTTP+JSON/SSE request handling
├── task-service.js              A2A task lifecycle
├── public/
│   ├── run-detail.html
│   ├── run-detail.js
│   └── run-detail.css
├── skills/
│   ├── daily-market-report/SKILL.md
│   ├── hot-topic-analysis/SKILL.md
│   ├── sell-pressure-scan/SKILL.md
│   ├── potential-watchlist/SKILL.md
│   └── inspect-run-trace/SKILL.md
└── tools/
    └── panda_market_worker.py
scripts/
├── run-market-worker-tests.js
└── market-agent-live-smoke.js
test/
├── market-analyst-config.test.js
├── market-analyst-state.test.js
├── market-analyst-report.test.js
├── market-analyst-email.test.js
├── market-analyst-a2a.test.js
├── market-analyst-integration.test.js
└── market-worker/
    └── test_market_worker.py
deploy/
├── market-analyst.service
├── market-report.service
└── market-report.timer
```

---

### Task 1: Configuration, operation schema, and test runners

**Files:**
- Create: `agents/market-analyst/config.js`
- Create: `agents/market-analyst/schemas.js`
- Create: `test/market-analyst-config.test.js`
- Create: `scripts/run-market-worker-tests.js`
- Modify: `package.json`
- Modify: `scripts/check-syntax.js`

**Interfaces:**
- Produces: `marketAgentConfig(env, cwd) -> MarketAgentConfig`
- Produces: `validateOperation(value) -> { operation, date?, sections?, topN }`
- Produces: `validateEvidencePack(value) -> value`

- [ ] **Step 1: Add failing configuration and schema tests**

```js
// test/market-analyst-config.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketAgentConfig } from '../agents/market-analyst/config.js';
import { validateOperation } from '../agents/market-analyst/schemas.js';

test('builds non-secret market agent configuration with Shanghai defaults', () => {
  const config = marketAgentConfig({
    PANDA_DATA_PYTHON: 'python-test',
    MARKET_AGENT_ACCESS_TOKEN: 'secret',
    MARKET_REPORT_EMAIL_TO: 'one@example.com,two@example.com',
    MARKET_REPORT_SMTP_HOST: 'smtp.example.com',
    MARKET_REPORT_SMTP_PORT: '587',
    MARKET_REPORT_SMTP_USERNAME: 'mailer',
    MARKET_REPORT_SMTP_PASSWORD: 'mail-secret'
  }, 'C:\\repo');
  assert.equal(config.timezone, 'Asia/Shanghai');
  assert.equal(config.port, 4190);
  assert.deepEqual(config.email.to, ['one@example.com', 'two@example.com']);
  assert.equal(config.smtp.port, 587);
  assert.equal(config.public.accessProtected, true);
  assert.equal('accessToken' in config.public, false);
  assert.equal('password' in config.public.smtp, false);
});

test('accepts declared operations and rejects arbitrary Panda methods', () => {
  assert.deepEqual(validateOperation({
    operation: 'daily-market-report',
    date: '2026-07-23',
    topN: 10
  }), { operation: 'daily-market-report', date: '2026-07-23', sections: [], topN: 10 });
  assert.throws(() => validateOperation({ operation: 'get_stock_daily' }), /不支持的 operation/);
  assert.throws(() => validateOperation({ operation: 'daily-market-report', topN: 500 }), /topN/);
});
```

- [ ] **Step 2: Run the tests and verify the expected import failure**

Run: `node --test test/market-analyst-config.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `agents/market-analyst/config.js`.

- [ ] **Step 3: Implement exact configuration and operation validation**

```js
// agents/market-analyst/config.js
import path from 'node:path';

const truthy = (value) => String(value).toLowerCase() === 'true';
const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};

export function marketAgentConfig(env = process.env, cwd = process.cwd()) {
  const to = String(env.MARKET_REPORT_EMAIL_TO || '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const accessToken = String(env.MARKET_AGENT_ACCESS_TOKEN || '');
  const smtpPassword = String(env.MARKET_REPORT_SMTP_PASSWORD || '');
  const config = {
    host: env.MARKET_AGENT_HOST || '127.0.0.1',
    port: positive(env.MARKET_AGENT_PORT, 4190),
    publicBaseUrl: String(env.MARKET_AGENT_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    accessToken,
    timezone: env.MARKET_REPORT_TIMEZONE || 'Asia/Shanghai',
    stateDir: path.resolve(cwd, env.MARKET_REPORT_STATE_DIR || 'data/market-analyst'),
    python: env.PANDA_DATA_PYTHON || (process.platform === 'win32' ? 'py' : 'python3'),
    workerTimeoutMs: positive(env.PANDA_DATA_TIMEOUT_MS, 60_000) * 10,
    retentionDays: positive(env.MARKET_REPORT_RETENTION_DAYS, 365),
    cacheDays: positive(env.MARKET_REPORT_CACHE_DAYS, 30),
    minLiquidityCny: positive(env.MARKET_REPORT_MIN_LIQUIDITY_CNY, 20_000_000),
    model: {
      enabled: truthy(env.MARKET_REPORT_MODEL_ENABLED),
      baseUrl: String(env.OPENAI_BASE_URL || ''),
      apiKey: String(env.OPENAI_API_KEY || ''),
      name: env.MARKET_REPORT_MODEL || env.REVIEW_MODEL_OPENAI || 'g5.4',
      pricing: env.MARKET_REPORT_MODEL_PRICING_JSON || ''
    },
    email: {
      to,
      from: String(env.MARKET_REPORT_EMAIL_FROM || ''),
      sendFailureAlerts: env.MARKET_REPORT_SEND_FAILURE_ALERTS !== 'false'
    },
    smtp: {
      host: String(env.MARKET_REPORT_SMTP_HOST || ''),
      port: positive(env.MARKET_REPORT_SMTP_PORT, 587),
      secure: truthy(env.MARKET_REPORT_SMTP_SECURE),
      requireTLS: env.MARKET_REPORT_SMTP_STARTTLS !== 'false',
      username: String(env.MARKET_REPORT_SMTP_USERNAME || ''),
      password: smtpPassword
    }
  };
  config.public = {
    host: config.host,
    port: config.port,
    timezone: config.timezone,
    accessProtected: Boolean(accessToken),
    modelEnabled: config.model.enabled,
    emailConfigured: Boolean(to.length && config.email.from && config.smtp.host),
    smtp: { host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure }
  };
  return config;
}
```

```js
// agents/market-analyst/schemas.js
const OPERATIONS = new Set([
  'daily-market-report',
  'hot-topic-analysis',
  'sell-pressure-scan',
  'potential-watchlist',
  'inspect-run-trace'
]);

export function validateOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('operation 请求必须是对象');
  if (!OPERATIONS.has(value.operation)) throw new RangeError(`不支持的 operation：${value.operation}`);
  if (value.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new TypeError('date 必须是 YYYY-MM-DD');
  const topN = value.topN === undefined ? 10 : Number(value.topN);
  if (!Number.isSafeInteger(topN) || topN < 1 || topN > 50) throw new RangeError('topN 必须是 1–50 的整数');
  const sections = value.sections === undefined ? [] : value.sections;
  if (!Array.isArray(sections) || sections.some((item) => typeof item !== 'string')) throw new TypeError('sections 必须是字符串数组');
  return { operation: value.operation, ...(value.date ? { date: value.date } : {}), sections, topN };
}

export function validateEvidencePack(value) {
  const required = ['schemaVersion', 'runId', 'reportDate', 'status', 'markets', 'conclusions', 'leaderboards', 'sources'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Evidence Pack 必须是对象');
  for (const key of required) if (!(key in value)) throw new TypeError(`Evidence Pack 缺少 ${key}`);
  if (!Array.isArray(value.conclusions) || !Array.isArray(value.sources)) throw new TypeError('Evidence Pack conclusions/sources 必须是数组');
  return value;
}
```

- [ ] **Step 4: Add Nodemailer and cross-platform Python test runner**

Run: `npm install nodemailer@9.0.3`

Expected: `package.json` contains `"nodemailer": "^9.0.3"` and `package-lock.json` pins the resolved graph.

```js
// scripts/run-market-worker-tests.js
import { spawn } from 'node:child_process';

const command = process.env.PANDA_DATA_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const child = spawn(command, ['-m', 'unittest', 'discover', '-s', 'test/market-worker', '-p', 'test_*.py'], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
});
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
```

Update `package.json` scripts to:

```json
{
  "market-agent": "node agents/market-analyst/server.js",
  "market-report": "node agents/market-analyst/cli.js",
  "test": "node scripts/run-tests.js && node scripts/run-market-worker-tests.js",
  "test:node": "node scripts/run-tests.js",
  "test:market-worker": "node scripts/run-market-worker-tests.js"
}
```

Change `scripts/check-syntax.js` to recursively walk `agents/market-analyst` and add `scripts/run-market-worker-tests.js` to the checked roots.

- [ ] **Step 5: Run focused and repository checks**

Run: `node --test test/market-analyst-config.test.js`

Expected: 2 tests pass.

Run: `npm run check`

Expected: `Syntax OK` and exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/check-syntax.js scripts/run-market-worker-tests.js agents/market-analyst/config.js agents/market-analyst/schemas.js test/market-analyst-config.test.js
git commit -m "feat: scaffold market analyst configuration"
```

---

### Task 2: Deterministic Python ranking engine

**Files:**
- Create: `agents/market-analyst/tools/panda_market_worker.py`
- Create: `test/market-worker/test_market_worker.py`

**Interfaces:**
- Produces: `winsorize(values, lower=0.025, upper=0.975)`
- Produces: `percentile_rank(values)`
- Produces: `effective_weights(values, weights, minimum_components)`
- Produces: `compute_hot_topics(groups, lhb_available=True)`
- Produces: `compute_sell_pressure(rows)`
- Produces: `compute_potential_watchlist(rows)`

- [ ] **Step 1: Write failing tests for normalization, coverage, scores, and vetoes**

```python
# test/market-worker/test_market_worker.py
import importlib.util
import pathlib
import unittest

WORKER = pathlib.Path("agents/market-analyst/tools/panda_market_worker.py")
spec = importlib.util.spec_from_file_location("panda_market_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class MarketWorkerTests(unittest.TestCase):
    def test_effective_weights_renormalize_without_treating_missing_as_zero(self):
        values = {"downside_volume": 90.0, "lhb_net_sell": None, "northbound_reduction": 70.0,
                  "margin_contraction": 50.0, "discount_event": None}
        score, coverage, used = worker.effective_weights(
            values,
            {"downside_volume": .25, "lhb_net_sell": .25, "northbound_reduction": .20,
             "margin_contraction": .15, "discount_event": .15},
            minimum_components=3,
        )
        self.assertAlmostEqual(score, (90*.25 + 70*.20 + 50*.15) / .60)
        self.assertAlmostEqual(coverage, .60)
        self.assertEqual(set(used), {"downside_volume", "northbound_reduction", "margin_contraction"})

    def test_hot_topic_requires_constituent_and_coverage_thresholds(self):
        result = worker.compute_hot_topics([
            {"id": "eligible", "constituent_count": 10, "coverage": .9, "ret1": 2, "ret5": 5,
             "breadth5": .8, "turnover_heat": 1.7, "acceleration": .03, "lhb_activity": 4},
            {"id": "too-small", "constituent_count": 4, "coverage": 1, "ret1": 8, "ret5": 9,
             "breadth5": 1, "turnover_heat": 3, "acceleration": .09, "lhb_activity": 8},
        ])
        self.assertEqual([item["id"] for item in result["ranked"]], ["eligible"])
        self.assertEqual(result["excluded"][0]["reason"], "MIN_CONSTITUENTS")

    def test_sell_pressure_requires_three_independent_components(self):
        result = worker.compute_sell_pressure([
            {"symbol": "000001.SZ", "downside_volume": 90, "lhb_net_sell": 80,
             "northbound_reduction": None, "margin_contraction": None, "discount_event": None}
        ])
        self.assertEqual(result[0]["status"], "EVIDENCE_INSUFFICIENT")

    def test_potential_watchlist_applies_audit_and_unlock_vetoes(self):
        rows = [
            {"symbol": "000001.SZ", "trend": 80, "theme": 80, "quality": 80, "valuation": 80,
             "capital": 80, "liquidity_stability": 80, "risk_penalty": 0, "st": False,
             "nonstandard_audit": False, "unlock_float_pct_30d": 0, "coverage": 1},
            {"symbol": "000002.SZ", "trend": 99, "theme": 99, "quality": 99, "valuation": 99,
             "capital": 99, "liquidity_stability": 99, "risk_penalty": 0, "st": False,
             "nonstandard_audit": True, "unlock_float_pct_30d": 0, "coverage": 1},
        ]
        ranked = worker.compute_potential_watchlist(rows)
        self.assertEqual(ranked[0]["symbol"], "000001.SZ")
        self.assertEqual(ranked[1]["status"], "VETOED")
        self.assertIn("NONSTANDARD_AUDIT", ranked[1]["vetoes"])

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run Python tests and verify missing-file failure**

Run: `node scripts/run-market-worker-tests.js`

Expected: FAIL because `panda_market_worker.py` does not exist.

- [ ] **Step 3: Implement pure deterministic scoring functions**

Implement `panda_market_worker.py` with no Panda import at module import time:

```python
import hashlib
import json
import math
import statistics
from datetime import date, datetime, timezone

HOT_WEIGHTS = {"ret1": .25, "ret5": .20, "breadth5": .20, "turnover_heat": .15,
               "acceleration": .15, "lhb_activity": .05}
SELL_WEIGHTS = {"downside_volume": .25, "lhb_net_sell": .25, "northbound_reduction": .20,
                "margin_contraction": .15, "discount_event": .15}
POTENTIAL_WEIGHTS = {"trend": .25, "theme": .15, "quality": .20, "valuation": .15,
                     "capital": .15, "liquidity_stability": .10}

def winsorize(values, lower=.025, upper=.975):
    finite = sorted(float(v) for v in values if v is not None and math.isfinite(float(v)))
    if not finite:
        return [None for _ in values]
    lo = finite[max(0, math.ceil((len(finite) - 1) * lower))]
    hi = finite[min(len(finite) - 1, math.floor((len(finite) - 1) * upper))]
    return [None if v is None else min(hi, max(lo, float(v))) for v in values]

def percentile_rank(values):
    finite = sorted((float(v), index) for index, v in enumerate(values) if v is not None)
    output = [None] * len(values)
    denominator = max(1, len(finite) - 1)
    for rank, (_, index) in enumerate(finite):
        output[index] = 100.0 * rank / denominator
    return output

def effective_weights(values, weights, minimum_components):
    used = [key for key in weights if values.get(key) is not None]
    if len(used) < minimum_components:
        return None, sum(weights[key] for key in used), used
    coverage = sum(weights[key] for key in used)
    score = sum(float(values[key]) * weights[key] for key in used) / coverage
    return score, coverage, used

def _percentile_components(rows, keys):
    output = [dict(row) for row in rows]
    for key in keys:
        ranked = percentile_rank(winsorize([row.get(key) for row in output]))
        for row, value in zip(output, ranked):
            row[key] = value
    return output

def compute_hot_topics(groups, lhb_available=True):
    eligible, excluded = [], []
    for group in groups:
        if group["constituent_count"] < 5:
            excluded.append({"id": group["id"], "reason": "MIN_CONSTITUENTS"})
        elif group["coverage"] < .80:
            excluded.append({"id": group["id"], "reason": "MIN_COVERAGE"})
        else:
            eligible.append(group)
    ranked_rows = _percentile_components(eligible, HOT_WEIGHTS)
    ranked = []
    for row in ranked_rows:
        values = {key: row.get(key) for key in HOT_WEIGHTS}
        if not lhb_available:
            values["lhb_activity"] = None
        score, coverage, used = effective_weights(values, HOT_WEIGHTS, 5)
        ranked.append({**row, "score": score, "weightCoverage": coverage, "componentsUsed": used})
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return {"ranked": ranked, "excluded": excluded}

def compute_sell_pressure(rows):
    ranked = []
    for row in rows:
        score, coverage, used = effective_weights(row, SELL_WEIGHTS, 3)
        ranked.append({**row, "score": score, "weightCoverage": coverage,
                       "componentsUsed": used,
                       "status": "RANKED" if score is not None else "EVIDENCE_INSUFFICIENT"})
    ranked.sort(key=lambda item: item["score"] if item["score"] is not None else -1, reverse=True)
    return ranked

def compute_potential_watchlist(rows):
    output = []
    for row in rows:
        vetoes = []
        if row.get("st"): vetoes.append("ST_OR_DELISTING_RISK")
        if row.get("nonstandard_audit"): vetoes.append("NONSTANDARD_AUDIT")
        if (row.get("unlock_float_pct_30d") or 0) > 10: vetoes.append("LARGE_UNLOCK_30D")
        score, coverage, used = effective_weights(row, POTENTIAL_WEIGHTS, 4)
        status = "VETOED" if vetoes else ("RANKED" if score is not None and coverage >= .70 else "EVIDENCE_INSUFFICIENT")
        final = None if score is None else max(0, score - float(row.get("risk_penalty") or 0))
        output.append({**row, "baseScore": score, "score": final, "weightCoverage": coverage,
                       "componentsUsed": used, "vetoes": vetoes, "status": status})
    output.sort(key=lambda item: (item["status"] == "RANKED", item["score"] or -1), reverse=True)
    return output
```

- [ ] **Step 4: Run tests**

Run: `npm run test:market-worker`

Expected: 4 tests pass.

- [ ] **Step 5: Add tests for ties, NaN, risk penalty floor, and missing LHB redistribution**

Add one focused test per behavior and run after each addition. Expected final result: 8 Python tests pass.

- [ ] **Step 6: Commit**

```bash
git add agents/market-analyst/tools/panda_market_worker.py test/market-worker/test_market_worker.py
git commit -m "feat: add deterministic market ranking engine"
```

---

### Task 3: Panda collector, point-in-time evidence, cache, and worker protocol

**Files:**
- Modify: `agents/market-analyst/tools/panda_market_worker.py`
- Modify: `test/market-worker/test_market_worker.py`
- Create: `test/fixtures/market-worker/snapshot.json`

**Interfaces:**
- Produces: `PandaCollector(module, trace, cache_dir, cache_days)`
- Produces: `build_evidence_pack(request, collector, now) -> dict`
- Process input: one JSON object on stdin
- Process stdout: one JSON Evidence Pack
- Process stderr: `TRACE <json>` lines only

- [ ] **Step 1: Add failing fake-Panda contract tests**

Add a `FakePanda` with `get_trade_cal`, `get_last_trade_date`, `get_trade_list`, `get_stock_daily`, and optional enrichment methods. Assert:

```python
def test_build_evidence_pack_uses_completed_trade_date_and_traces_every_call(self):
    trace = []
    collector = worker.PandaCollector(FakePanda(), trace.append, None, 0)
    pack = worker.build_evidence_pack(
        {"operation": "daily-market-report", "date": "2026-07-23", "topN": 10,
         "minLiquidityCny": 20000000, "cacheDir": None},
        collector,
        now="2026-07-24T10:30:00Z",
    )
    self.assertEqual(pack["schemaVersion"], "1.0")
    self.assertEqual(pack["reportDate"], "2026-07-23")
    self.assertIn("hotIndustries", pack["leaderboards"])
    self.assertTrue(all("durationMs" in item and "rowCount" in item for item in trace))
    self.assertNotIn("password", json.dumps(pack).lower())

def test_future_report_date_is_rejected(self):
    collector = worker.PandaCollector(FakePanda(), lambda _: None, None, 0)
    with self.assertRaisesRegex(ValueError, "未完成"):
        worker.build_evidence_pack(
            {"operation": "daily-market-report", "date": "2026-07-25", "topN": 10,
             "minLiquidityCny": 20000000, "cacheDir": None},
            collector,
            now="2026-07-24T10:30:00Z",
        )
```

- [ ] **Step 2: Run and verify `PandaCollector` failure**

Run: `npm run test:market-worker`

Expected: FAIL with `AttributeError: module ... has no attribute 'PandaCollector'`.

- [ ] **Step 3: Implement fixed query plans and trace records**

Implement:

```python
class PandaCollector:
    def __init__(self, module, trace, cache_dir, cache_days):
        self.module = module
        self.trace = trace
        self.cache_dir = cache_dir
        self.cache_days = cache_days

    def call(self, method, **params):
        if not method.startswith("get_") or not callable(getattr(self.module, method, None)):
            raise ValueError(f"panda-data==0.0.12 未导出方法：{method}")
        started = datetime.now(timezone.utc)
        rows, status, error = [], "error", None
        try:
            result = getattr(self.module, method)(**params)
            rows = result.to_dict(orient="records") if hasattr(result, "to_dict") else list(result or [])
            status, error = "ok", None
            return rows
        except Exception as cause:
            status, error = "error", f"{type(cause).__name__}: {cause}"
            raise
        finally:
            ended = datetime.now(timezone.utc)
            self.trace({
                "type": "panda-call", "method": method,
                "paramsHash": hashlib.sha256(json.dumps(params, sort_keys=True, default=str).encode()).hexdigest(),
                "startedAt": started.isoformat(), "endedAt": ended.isoformat(),
                "durationMs": round((ended - started).total_seconds() * 1000),
                "rowCount": len(rows) if status == "ok" else None,
                "status": status, "error": error,
            })
```

Build the report in the approved two stages:

1. resolve calendar and tradable universe;
2. fetch 60 trading days of A-share daily rows in documented batches;
3. compute broad metrics and candidate IDs;
4. fetch documented optional methods only for the bounded candidate set;
5. build leaderboards and market context;
6. attach source IDs and conclusions;
7. mark optional failures under `missingData`;
8. fail on calendar, universe, daily rows, truncation, or coverage violations.

Implement Parquet cache keys as SHA-256 of SDK version, method, sorted params, and report date. A cache entry must include metadata with creation time, data-as-of date, fields, row count, and content hash. Expired entries are ignored.

- [ ] **Step 4: Implement the stdin/stdout process boundary**

```python
def emit_trace(value):
    print("TRACE " + json.dumps(value, ensure_ascii=False, default=str), file=sys.stderr, flush=True)

def main():
    request = json.loads(sys.stdin.read() or "{}")
    import panda_data
    panda_data.init_token(
        username=os.environ["PANDA_DATA_USERNAME"],
        password=os.environ["PANDA_DATA_PASSWORD"],
        base_url=os.environ.get("PANDA_DATA_BASE_URL", "http://pandadata.pandaaiquant.com"),
    )
    collector = PandaCollector(
        panda_data, emit_trace, request.get("cacheDir"), int(request.get("cacheDays", 30))
    )
    pack = build_evidence_pack(request, collector, datetime.now(timezone.utc).isoformat())
    print(json.dumps(pack, ensure_ascii=False, allow_nan=False, default=str))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit_trace({"type": "worker-error", "error": f"{type(error).__name__}: {error}"})
        raise SystemExit(1)
```

Ensure `import panda_data` occurs only in `main()` so pure unit tests need no SDK.

- [ ] **Step 5: Add point-in-time and incomplete-universe regression tests**

Add tests proving:

- concept membership after the report date is excluded;
- financial publication after the report date is excluded;
- truncated broad daily data fails instead of ranking;
- hot-topic coverage under 80% is excluded;
- optional LHB failure redistributes 5% and lowers confidence;
- US data date is the previous completed US session.

Run: `npm run test:market-worker`

Expected: all Python tests pass.

- [ ] **Step 6: Commit**

```bash
git add agents/market-analyst/tools/panda_market_worker.py test/market-worker/test_market_worker.py test/fixtures/market-worker/snapshot.json
git commit -m "feat: build Panda market evidence worker"
```

---

### Task 4: Run trace, atomic task store, lock, and Python runner

**Files:**
- Create: `agents/market-analyst/run-trace.js`
- Create: `agents/market-analyst/task-store.js`
- Create: `agents/market-analyst/run-lock.js`
- Create: `agents/market-analyst/worker-runner.js`
- Create: `test/market-analyst-state.test.js`

**Interfaces:**
- Produces: `createRunTrace(meta) -> RunTrace`
- Produces: `MarketTaskStore`
- Produces: `acquireRunLock({ stateDir, reportDate, staleMs }) -> { release() }`
- Produces: `runMarketWorker({ request, config, signal, spawnImpl, onTrace }) -> EvidencePack`

- [ ] **Step 1: Write failing state, redaction, lock, and runner tests**

Test that:

- atomic persistence survives reload;
- task transitions reject terminal-to-working changes;
- `sanitizeTraceValue` removes usernames, passwords, tokens, authorization, and full email;
- a second lock for the same date throws `RUN_LOCKED`;
- stale lock recovery succeeds;
- worker runner parses `TRACE` stderr lines, validates stdout JSON, enforces timeout/output bounds, and propagates abort.

Use a fake child process built with `EventEmitter` and `PassThrough` so tests perform no Python calls.

- [ ] **Step 2: Run and observe module import failures**

Run: `node --test test/market-analyst-state.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement trace and state contracts**

Use these task states exactly:

```js
export const TASK_STATES = new Set([
  'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'
]);
```

`MarketTaskStore` must write `state.json.tmp` then rename, serialize writes through a promise queue, and expose `load()`, `create()`, `get()`, `list({ owner })`, `update(id, updater)`, and `findByMessageId(owner, messageId)`.

`RunTrace` must assign sequence numbers and expose:

```js
trace.startStep({ skillId, tool, parentSequence, detail })
trace.finishStep(sequence, { status, detail, error })
trace.addWorkerEvent(event)
trace.addModelUsage(usage)
trace.addEmailAttempt(attempt)
trace.toJSON()
```

`sanitizeTraceValue()` recursively redacts keys matching `/password|token|secret|authorization|username/i` and masks email strings.

- [ ] **Step 4: Implement bounded worker process handling**

Spawn:

```js
spawnImpl(config.python, [workerFile], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH || '',
    PYTHONIOENCODING: 'utf-8',
    PANDA_DATA_USERNAME: process.env.PANDA_DATA_USERNAME || '',
    PANDA_DATA_PASSWORD: process.env.PANDA_DATA_PASSWORD || '',
    PANDA_DATA_BASE_URL: process.env.PANDA_DATA_BASE_URL || ''
  }
});
```

Send only the validated fixed operation, report parameters, cache path, and cache retention. Parse each stderr line beginning `TRACE ` as JSON. Reject nonzero exit, malformed stdout JSON, output above 20 MB, timeout, or abort. Call `validateEvidencePack()` before resolving.

- [ ] **Step 5: Run tests**

Run: `node --test test/market-analyst-state.test.js`

Expected: all state/trace/lock/runner tests pass.

- [ ] **Step 6: Commit**

```bash
git add agents/market-analyst/run-trace.js agents/market-analyst/task-store.js agents/market-analyst/run-lock.js agents/market-analyst/worker-runner.js test/market-analyst-state.test.js
git commit -m "feat: add durable market run infrastructure"
```

---

### Task 5: Deterministic reports, constrained narrative, and detail artifacts

**Files:**
- Create: `agents/market-analyst/report-renderer.js`
- Create: `agents/market-analyst/report-validator.js`
- Create: `agents/market-analyst/narrative-adapter.js`
- Create: `agents/market-analyst/public/run-detail.html`
- Create: `agents/market-analyst/public/run-detail.js`
- Create: `agents/market-analyst/public/run-detail.css`
- Create: `test/market-analyst-report.test.js`

**Interfaces:**
- Produces: `renderReport(evidence, narrative?) -> { markdown, html, text }`
- Produces: `validateReport({ evidence, markdown, narrative })`
- Produces: `generateNarrative(evidence, config, { fetchImpl, signal }) -> { sections, usage }`
- Produces: `renderRunDetail({ run, evidence, trace }) -> escaped HTML`

- [ ] **Step 1: Write failing report and narrative validation tests**

Assert:

- required 12 report sections exist;
- every leaderboard row prints data date, confidence, and score contribution;
- degraded subject/body list missing methods;
- unsupported numeric text and unknown symbols reject the model narrative;
- valid conclusion IDs pass;
- model usage captures prompt/completion/total tokens;
- pricing produces cost only with a configured pricing version;
- HTML escapes `<script>` from Panda/model text.

- [ ] **Step 2: Run and observe import failures**

Run: `node --test test/market-analyst-report.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic rendering**

Render tables from evidence objects, never by parsing model prose. Use:

```js
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}
```

The Markdown/HTML sections must match Section 10 of the design spec. Each conclusion anchor uses `conclusion_id`; each source note prints method, data date, window, coverage, and trace sequence.

- [ ] **Step 4: Implement constrained narrative and usage accounting**

Send an OpenAI-compatible request only when enabled/configured. Require JSON:

```json
{
  "sections": [
    {
      "id": "executive-summary",
      "conclusionIds": ["conclusion_market_regime"],
      "text": "仅使用给定证据的中文摘要"
    }
  ]
}
```

Validate that conclusion IDs exist, stock symbols appear in evidence, and every numeric token appears in the serialized evidence allowlist. On any failure, return `{ sections: [], usage, fallbackReason }`; the orchestrator uses deterministic text.

Normalize model usage to:

```js
{
  provider, model, startedAt, endedAt, durationMs,
  inputTokens, outputTokens, reasoningTokens, cachedTokens, totalTokens,
  pricingVersion, cost, currency, finishReason, responseSha256
}
```

Unknown usage/cost fields are `null` with `usageUnavailableReason` or `pricingUnavailableReason`.

- [ ] **Step 5: Implement the protected detail page renderer**

The browser page must show run summary, skill/tool calls, Panda calls, model usage, email attempts, artifacts, and conclusion lineage. It fetches `/runs/{id}/report`, `/evidence`, and `/trace` with the same Bearer token supplied by the operator; it never stores the token in local storage.

- [ ] **Step 6: Run tests**

Run: `node --test test/market-analyst-report.test.js`

Expected: all report/narrative/detail tests pass.

- [ ] **Step 7: Commit**

```bash
git add agents/market-analyst/report-renderer.js agents/market-analyst/report-validator.js agents/market-analyst/narrative-adapter.js agents/market-analyst/public test/market-analyst-report.test.js
git commit -m "feat: render traceable market reports"
```

---

### Task 6: Orchestrator, SMTP delivery, and scheduled CLI

**Files:**
- Create: `agents/market-analyst/orchestrator.js`
- Create: `agents/market-analyst/smtp-mailer.js`
- Create: `agents/market-analyst/cli.js`
- Create: `test/market-analyst-email.test.js`
- Create: `test/market-analyst-integration.test.js`

**Interfaces:**
- Produces: `MarketOrchestrator.run({ operation, trigger, owner, deliverEmail, forceDelivery, signal })`
- Produces: `createSmtpMailer(config, { createTransport, wait })`
- Produces: `deliveryKey(reportDate, recipients, reportVersion)`

- [ ] **Step 1: Write failing SMTP and orchestration tests**

Test:

- deterministic Message-ID and delivery key;
- transient failures retry exactly three times;
- confirmed delivery is not duplicated;
- report success plus email failure can retry email without invoking the worker;
- non-trading-day `SKIPPED` does not email;
- optional-source failure emails `[数据降级]`;
- core failure sends no report and makes one best-effort failure-alert attempt;
- model failure uses deterministic report;
- artifacts are written under `runs/YYYYMMDD/<runId>/`.

Inject fake worker, store, renderer, narrator, mailer, clock, and wait; never use real network or sleep.

- [ ] **Step 2: Run and observe import failures**

Run: `node --test test/market-analyst-email.test.js test/market-analyst-integration.test.js`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement SMTP adapter**

Create a Nodemailer transport with:

```js
{
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  requireTLS: config.smtp.requireTLS,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
  auth: config.smtp.username ? { user: config.smtp.username, pass: config.smtp.password } : undefined,
  tls: { rejectUnauthorized: true }
}
```

Use delays 500 ms and 1500 ms plus injected jitter. Persist attempt number, start/end/duration, sanitized SMTP response, accepted/rejected counts, and message ID.

- [ ] **Step 4: Implement the shared orchestrator**

Run order:

1. validate operation;
2. acquire date lock;
3. create/update Task and Run Trace;
4. call worker;
5. optionally call narrator;
6. render and validate;
7. atomically write artifacts;
8. persist completed/degraded state;
9. send email only for scheduled/manual `deliverEmail=true`;
10. persist receipt;
11. release lock in `finally`.

Map core failures to failed tasks, optional failures to degraded evidence, abort to canceled task, and invalid inputs to rejected task.

- [ ] **Step 5: Implement one-shot CLI**

Support:

```text
node agents/market-analyst/cli.js
node agents/market-analyst/cli.js --date 2026-07-23
node agents/market-analyst/cli.js --date 2026-07-23 --force-delivery
node agents/market-analyst/cli.js --no-email
```

Default operation is `daily-market-report`, trigger is `scheduled`, and email is enabled. Print one sanitized JSON summary and exit 0 for complete/degraded/skipped, 1 for failure, and 130 for cancellation.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/market-analyst-email.test.js test/market-analyst-integration.test.js`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add agents/market-analyst/orchestrator.js agents/market-analyst/smtp-mailer.js agents/market-analyst/cli.js test/market-analyst-email.test.js test/market-analyst-integration.test.js
git commit -m "feat: deliver scheduled market report email"
```

---

### Task 7: A2A 1.0 Agent Card, task lifecycle, HTTP+JSON, and SSE

**Files:**
- Create: `agents/market-analyst/agent-card.js`
- Create: `agents/market-analyst/task-service.js`
- Create: `agents/market-analyst/a2a-server.js`
- Create: `agents/market-analyst/server.js`
- Create: `test/market-analyst-a2a.test.js`

**Interfaces:**
- Produces: `buildMarketAgentCard(origin, config)`
- Produces: `MarketTaskService`
- Produces: `createMarketAgentServer(options)`

- [ ] **Step 1: Write failing A2A conformance tests**

Start the server on an ephemeral loopback port with a fake orchestrator. Verify:

- well-known Card fields, five Skills, binding/version, input/output modes, security, streaming true, push false;
- unauthenticated protected requests return 401;
- unsupported/missing `A2A-Version` returns the A2A version error;
- `message:send` returns a Task and deduplicates messageId;
- `message:stream` emits Task, working status, artifact update, and terminal status in order;
- get/list enforce owner visibility;
- cancel is idempotent and aborts active work;
- subscribe rejects terminal tasks and streams active tasks;
- malformed input and unsupported operation use structured A2A error shapes;
- completed Task contains Markdown text, Evidence Pack data, and Run Trace data artifacts.

- [ ] **Step 2: Run and observe import failure**

Run: `node --test test/market-analyst-a2a.test.js`

Expected: FAIL with missing `a2a-server.js`.

- [ ] **Step 3: Implement Agent Card**

Use:

```js
{
  name: 'Panda Market Analyst',
  description: '基于 panda_data 的可追溯市场收盘分析 Agent，生成热点、卖压与潜力观察榜。',
  version: '1.0.0',
  supportedInterfaces: [{
    url: `${origin}/a2a/v1`,
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }],
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['text/markdown', 'application/json'],
  skills: [
    {
      id: 'daily-market-report',
      name: '每日市场报告',
      description: '生成基于 panda_data 的完整收盘报告、Evidence Pack 和 Run Trace。',
      tags: ['panda_data', 'A股', '收盘复盘', '市场报告'],
      examples: ['生成 2026-07-23 的每日市场报告']
    },
    {
      id: 'hot-topic-analysis',
      name: '热点主题分析',
      description: '根据涨幅、广度、成交、持续性和资金证据排名行业与概念热点。',
      tags: ['panda_data', '行业', '概念', '市场热点'],
      examples: ['分析最近一个交易日最热的行业和概念']
    },
    {
      id: 'sell-pressure-scan',
      name: '卖压观察榜',
      description: '识别多项市场行为证据汇聚的卖压观察标的，不推断未知卖方身份。',
      tags: ['panda_data', '卖压', '风险', '观察榜'],
      examples: ['列出卖压最明显的十只 A 股']
    },
    {
      id: 'potential-watchlist',
      name: '潜力研究观察榜',
      description: '综合趋势、主题、质量、估值、资金、流动性和风险生成研究候选。',
      tags: ['panda_data', '潜力', '研究候选', '观察榜'],
      examples: ['生成十只潜力研究候选并给出证据']
    },
    {
      id: 'inspect-run-trace',
      name: '运行溯源查询',
      description: '读取指定运行的工具、接口、耗时、Token、错误和结论证据链。',
      tags: ['运行追踪', 'Token', '接口耗时', '结论溯源'],
      examples: ['查看运行 run-20260723 的全部调用和结论来源']
    }
  ]
}
```

When protected, add the A2A 1.0 Bearer security scheme and requirement. Do not put the token in the Card.

- [ ] **Step 4: Implement HTTP+JSON operation routing**

Routes under the Card base:

- `POST /a2a/v1/message:send`
- `POST /a2a/v1/message:stream`
- `GET /a2a/v1/tasks/{id}`
- `GET /a2a/v1/tasks`
- `POST /a2a/v1/tasks/{id}:cancel`
- `POST /a2a/v1/tasks/{id}:subscribe`

Require `Content-Type: application/a2a+json` for request bodies and return it for JSON responses. Require `A2A-Version: 1.0`. Use repository `readJsonBody()` and a 1 MB limit.

Natural-language routing is a fixed keyword map to the five declared operations. Structured data parts pass through `validateOperation()`. A2A calls always set `deliverEmail=false`.

- [ ] **Step 5: Implement task events and artifacts**

Use EventEmitter per active task. SSE `data:` objects contain exactly one of `task`, `statusUpdate`, or `artifactUpdate`. Close after terminal/interrupted state. Store `createdAt`, `lastModified`, `contextId`, history, and artifacts. Escape CR/LF in SSE serialization by JSON-encoding the event.

- [ ] **Step 6: Implement protected detail and health routes**

Add:

- `GET /health`
- `GET /runs/{id}`
- `GET /runs/{id}/report`
- `GET /runs/{id}/evidence`
- `GET /runs/{id}/trace`

Only `/health` and the well-known Card are public. All run routes use the same Bearer authorization and return sanitized data.

- [ ] **Step 7: Run tests**

Run: `node --test test/market-analyst-a2a.test.js`

Expected: all A2A tests pass.

Run: `node --test test/a2a.test.js test/example-agents.test.js`

Expected: existing protocol/example tests remain green.

- [ ] **Step 8: Commit**

```bash
git add agents/market-analyst/agent-card.js agents/market-analyst/task-service.js agents/market-analyst/a2a-server.js agents/market-analyst/server.js test/market-analyst-a2a.test.js
git commit -m "feat: expose market analyst over A2A 1.0"
```

---

### Task 8: Repository-local Skills and trace inspection experience

**Required skill before editing these files:** `skill-creator:skill-creator`

**Files:**
- Create: `agents/market-analyst/skills/daily-market-report/SKILL.md`
- Create: `agents/market-analyst/skills/hot-topic-analysis/SKILL.md`
- Create: `agents/market-analyst/skills/sell-pressure-scan/SKILL.md`
- Create: `agents/market-analyst/skills/potential-watchlist/SKILL.md`
- Create: `agents/market-analyst/skills/inspect-run-trace/SKILL.md`
- Create: `docs/MARKET_ANALYST_AGENT.md`
- Create: `docs/THIRD_PARTY_NOTICES.md`
- Modify: `test/market-analyst-a2a.test.js`

**Interfaces:**
- Consumes: exact Skill IDs from `agent-card.js`
- Produces: complete, independently readable Skill instructions and operator guide

- [ ] **Step 1: Add failing metadata synchronization test**

Read each `SKILL.md` front matter and assert its `name` matches an Agent Card Skill ID, descriptions are non-empty, no Skill declares external data or trading, and all five Agent Card Skills have a file.

Run: `node --test test/market-analyst-a2a.test.js`

Expected: FAIL because Skill files do not exist.

- [ ] **Step 2: Write the five Skills**

Each `SKILL.md` must contain:

- trigger description;
- input contract;
- exact deterministic workflow;
- allowed internal tools;
- Panda-only data boundary;
- freshness, coverage, and missing-data rules;
- output schema;
- trace requirements;
- safety/non-advice boundary.

The analytical Skills may invoke only `panda-market-worker`, `report-renderer`, `report-validator`, and optional `narrative-adapter`. `inspect-run-trace` may invoke only `run-store`.

- [ ] **Step 3: Write operator and attribution docs**

`docs/MARKET_ANALYST_AGENT.md` includes:

- installation and Python environment;
- Panda, A2A, model, SMTP, storage, and schedule configuration;
- local server and one-shot CLI commands;
- systemd and Windows Task Scheduler instructions;
- A2A curl examples with required headers;
- report/detail URLs;
- recovery for locks, failed email, stale cache, and failed tasks;
- live-smoke procedure;
- statement that only Panda supplies financial data.

`docs/THIRD_PARTY_NOTICES.md` links the six QuantSkills references, records GPL-3.0 status, and states that no upstream source was copied.

- [ ] **Step 4: Run tests**

Run: `node --test test/market-analyst-a2a.test.js`

Expected: metadata synchronization tests pass.

- [ ] **Step 5: Commit**

```bash
git add agents/market-analyst/skills docs/MARKET_ANALYST_AGENT.md docs/THIRD_PARTY_NOTICES.md test/market-analyst-a2a.test.js
git commit -m "docs: add market analyst skills and runbook"
```

---

### Task 9: Deployment, environment, live smoke, and full verification

**Files:**
- Create: `deploy/market-analyst.service`
- Create: `deploy/market-report.service`
- Create: `deploy/market-report.timer`
- Create: `scripts/market-agent-live-smoke.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `docs/PRODUCTION_OPERATIONS.md`

**Interfaces:**
- Produces: `npm run market-agent`
- Produces: `npm run market-report`
- Produces: `npm run market:smoke`

- [ ] **Step 1: Add deployment and environment validation tests**

Extend `test/deploy-config.test.js` to assert:

- `market-analyst.service` runs `npm run market-agent`;
- the service reads `/etc/agent-review/agent-review.env`;
- state/cache paths are writable under `/var/lib/agent-review`;
- timer runs at `18:30:00 Asia/Shanghai`;
- report service is `Type=oneshot`;
- no credential value is embedded.

Extend `test/env.test.js` to assert `.env.example` contains every Section 18 variable with an empty or safe default.

- [ ] **Step 2: Run tests and observe missing deployment files**

Run: `node --test test/deploy-config.test.js test/env.test.js`

Expected: FAIL on missing market agent units/variables.

- [ ] **Step 3: Implement deployment units**

`market-analyst.service` is a hardened long-running A2A service with `ExecStart=/usr/bin/npm run market-agent`, `Restart=on-failure`, `ReadWritePaths=/var/lib/agent-review`, and the same hardening family as `agent-review.service`.

`market-report.service` is a hardened oneshot unit with:

```ini
[Service]
Type=oneshot
WorkingDirectory=/opt/agent-review/app
EnvironmentFile=/etc/agent-review/agent-review.env
Environment=MARKET_REPORT_STATE_DIR=/var/lib/agent-review/market-analyst
ExecStart=/usr/bin/npm run market-report
```

`market-report.timer` uses:

```ini
[Timer]
OnCalendar=Mon..Fri *-*-* 18:30:00 Asia/Shanghai
Persistent=true
RandomizedDelaySec=30
Unit=market-report.service
```

The CLI performs the authoritative exchange-holiday check.

- [ ] **Step 4: Implement credential-gated live smoke**

`scripts/market-agent-live-smoke.js` must:

1. require `PANDA_DATA_ENABLED=true` and credentials;
2. spawn the worker with `topN=3`;
3. validate Evidence Pack and artifacts;
4. start the A2A server on an ephemeral loopback port;
5. fetch the Card and send one `daily-market-report` message;
6. poll the Task to terminal;
7. send email only when `MARKET_SMOKE_EMAIL_TO` is explicitly supplied;
8. print a sanitized JSON summary.

Add `"market:smoke": "node scripts/market-agent-live-smoke.js"` to `package.json`.

- [ ] **Step 5: Update README, production operations, and `.env.example`**

Document exact commands:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-data.txt
npm install
npm run market-agent
npm run market-report -- --no-email
npm run market:smoke
```

Include credential rotation, SMTP test, timer inspection, artifact backup/restore, retention, and rollback steps.

- [ ] **Step 6: Run focused deployment tests**

Run: `node --test test/deploy-config.test.js test/env.test.js`

Expected: all deployment/environment tests pass.

- [ ] **Step 7: Run full verification**

Run: `npm run check`

Expected: exit 0 and syntax checks include `agents/market-analyst`.

Run: `npm test`

Expected: all Node and Python unit/integration tests pass with 0 failures.

Run: `git diff --check`

Expected: no output and exit 0.

Run, only when real credentials are configured: `npm run market:smoke`

Expected: sanitized summary with `status` equal to `COMPLETE` or explicitly justified `DEGRADED`; A2A Task terminal; no secret text.

- [ ] **Step 8: Review acceptance criteria line by line**

Open `docs/superpowers/specs/2026-07-24-panda-market-analyst-agent-design.md` Section 21 and record evidence for each of the 14 criteria in `docs/MARKET_ANALYST_AGENT.md` under `Verification Record`. Do not mark criteria requiring SMTP/live Panda as passed unless the real smoke test ran.

- [ ] **Step 9: Commit**

```bash
git add deploy/market-analyst.service deploy/market-report.service deploy/market-report.timer scripts/market-agent-live-smoke.js .env.example README.md package.json docs/PRODUCTION_OPERATIONS.md docs/MARKET_ANALYST_AGENT.md test/deploy-config.test.js test/env.test.js
git commit -m "ops: deploy Panda market analyst agent"
```

---

## Plan Self-Review Result

The plan was checked against every design-spec section before handoff:

| Design concern | Implementation coverage |
|---|---|
| Product boundary, terminology, and operations | Global constraints; Tasks 1, 6, 7, and 8 |
| Panda-only data policy and fixed query plan | Tasks 2 and 3 |
| Ranking formulas, confidence, vetoes, and missing data | Tasks 2 and 3 |
| Evidence Pack, report, and conclusion lineage | Tasks 3 and 5 |
| Run state, timing, rows, hashes, cache, retries, tools, tokens, and cost | Tasks 3, 4, 5, and 8 |
| Scheduling, holiday checks, idempotency, SMTP, and email-only retry | Tasks 4, 6, and 9 |
| A2A 1.0 Card, lifecycle, HTTP+JSON, SSE, auth, and email separation | Task 7 |
| Repository-local Skills and QuantSkills attribution without copied GPL source | Task 8 |
| Deployment, operations, fixture verification, and credential-gated live smoke | Task 9 |

Interface review confirmed that the Node worker runner and Python worker share one JSON request/response boundary, analytical operations never accept arbitrary Panda method names, and A2A calls always force `deliverEmail=false`. Failure tests distinguish core-data failure from optional-data degradation. SMTP idempotency and email-only retry are explicit test cases. Static tests can pass without credentials; live Panda and SMTP acceptance criteria remain visibly conditional until their smoke tests run.
