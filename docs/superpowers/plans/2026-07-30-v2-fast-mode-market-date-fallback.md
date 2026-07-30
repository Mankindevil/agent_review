# V2 Fast Mode and Market Date Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the local V2 fast profile and make date-less market analysis requests use the latest completed Shanghai trading day with an explicit audit note.

**Architecture:** Keep explicit dates strict. Add a small Node-side report-date resolver that uses the existing Panda bridge to choose and verify an effective trading date before the orchestrator acquires its per-date lock. Pass the immutable date-selection record through the worker into the Evidence Pack, Run Trace, and all report formats.

**Tech Stack:** Node.js ESM, Python 3 `unittest`, `node:test`, Panda Data bridge, JSON Evidence Pack, Markdown/HTML/text rendering.

## Global Constraints

- Set local `.env` to `A2A_MULTI_TURN_ENABLED=false` and `A2A_REPEAT_COUNT=1`.
- Configuration changes affect only evaluations created after the V2 process restarts.
- Explicit `YYYY-MM-DD` or structured `date` requests never fall back.
- Date-less requests use the latest completed Shanghai trading day, including weekends and holidays.
- If the candidate trading day has no stock-universe data, fall back once to the previous trading day and record the reason.
- Panda authentication, network, malformed-date, or repeated no-data failures remain failures; never guess a date.
- Do not change the existing same-report-date run lock or queueing behavior.
- Do not expose Panda credentials or raw provider responses in artifacts.
- Preserve all unrelated dirty-worktree changes and runtime data.

---

### Task 1: Local V2 Fast Profile

**Files:**
- Modify: `.env`
- Verify: `src/execution-tuning.js`
- Verify: `test/execution-tuning.test.js`

**Interfaces:**
- Consumes: `readA2AExecutionTuning(env)`
- Produces: local runtime configuration `{ multiTurnEnabled: false, repeatCount: 1, requiredHiddenVariants: ['equivalent', 'boundary'] }`

- [ ] **Step 1: Add the local fast-profile variables**

Use `apply_patch` to add the following beside the existing V2 black-box settings in `.env`:

```dotenv
A2A_MULTI_TURN_ENABLED=false
A2A_REPEAT_COUNT=1
```

- [ ] **Step 2: Verify the loaded environment**

Run:

```bash
node --input-type=module -e "await import('./src/env.js'); const {readA2AExecutionTuning}=await import('./src/execution-tuning.js'); console.log(JSON.stringify(readA2AExecutionTuning(process.env)))"
```

Expected:

```json
{"multiTurnEnabled":false,"repeatCount":1,"requiredHiddenVariants":["equivalent","boundary"]}
```

- [ ] **Step 3: Run the existing tuning tests**

Run:

```bash
node --test test/execution-tuning.test.js
```

Expected: all execution-tuning tests pass.

No commit is required for `.env` because it is local secret-bearing configuration and is not tracked.

---

### Task 2: Resolve an Effective Completed Trading Date Before Locking

**Files:**
- Create: `agents/market-analyst/report-date.js`
- Create: `test/market-report-date.test.js`

**Interfaces:**
- Consumes: `queryPandaData(method, params, { signal })`, an optional explicit date, current time, and timezone
- Produces: `resolveMarketReportDate(options) -> Promise<{ requestedDate, effectiveDate, mode, reason }>`

- [ ] **Step 1: Write failing resolver tests**

Create `test/market-report-date.test.js` with injected `query` and `clock` dependencies. Cover these exact cases:

```js
function fakePanda(responses) {
  return async (method, params = {}) => {
    const configured = responses[method];
    const data = method === 'get_trade_list'
      && configured
      && !Array.isArray(configured)
      ? configured[params.date]
      : configured;
    return {
      data,
      rowCount: Array.isArray(data) ? data.length : null,
      method,
      provider: 'pandaai',
      truncated: false
    };
  };
}

test('explicit dates remain strict and do not query Panda', async () => {
  const calls = [];
  const result = await resolveMarketReportDate({
    explicitDate: '2026-07-30',
    now: new Date('2026-07-30T05:00:00Z'),
    query: async (...args) => calls.push(args)
  });
  assert.deepEqual(result, {
    requestedDate: '2026-07-30',
    effectiveDate: '2026-07-30',
    mode: 'explicit',
    reason: null
  });
  assert.deepEqual(calls, []);
});

test('an implicit intraday request uses the previous completed trading day', async () => {
  const query = fakePanda({
    get_last_trade_date: '20260730',
    get_prev_trade_date: '20260729',
    get_trade_list: [{ symbol: '000001.SZ', date: '20260729' }]
  });
  const result = await resolveMarketReportDate({
    now: new Date('2026-07-30T05:00:00Z'),
    query
  });
  assert.equal(result.effectiveDate, '2026-07-29');
  assert.equal(result.reason, 'REQUEST_DATE_NOT_COMPLETED');
});

test('an implicit weekend request uses Panda latest trading day', async () => {
  const query = fakePanda({
    get_last_trade_date: '20260724',
    get_trade_list: [{ symbol: '000001.SZ', date: '20260724' }]
  });
  const result = await resolveMarketReportDate({
    now: new Date('2026-07-26T04:00:00Z'),
    query
  });
  assert.equal(result.effectiveDate, '2026-07-24');
});

test('a completed candidate with no universe data falls back once', async () => {
  const query = fakePanda({
    get_last_trade_date: '20260730',
    get_prev_trade_date: '20260729',
    get_trade_list: {
      '20260730': [],
      '20260729': [{ symbol: '000001.SZ', date: '20260729' }]
    }
  });
  const result = await resolveMarketReportDate({
    now: new Date('2026-07-30T08:30:00Z'),
    query
  });
  assert.equal(result.effectiveDate, '2026-07-29');
  assert.equal(result.reason, 'REQUEST_DATE_DATA_UNAVAILABLE');
});
```

Also assert rejection for an empty/malformed latest date and for no data on both the candidate and its predecessor.

- [ ] **Step 2: Run resolver tests and confirm RED**

Run:

```bash
node --test test/market-report-date.test.js
```

Expected: FAIL because `agents/market-analyst/report-date.js` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `agents/market-analyst/report-date.js` with:

```js
import { queryPandaData } from '../../src/panda-data.js';

export async function resolveMarketReportDate({
  explicitDate,
  now = new Date(),
  timezone = 'Asia/Shanghai',
  query = queryPandaData,
  signal
} = {}) {
  // Return explicit dates unchanged.
  // For implicit dates, normalize Panda YYYYMMDD values.
  // Before 15:00 Shanghai, if Panda latest equals today, request
  // get_prev_trade_date({ date: todayCompact, exchange: 'SH', n: 1 }).
  // Verify the candidate with get_trade_list({ date, exchange: 'SH' }).
  // If the candidate is empty, resolve one previous trading date and verify it.
  // Reject invalid, future, or repeatedly empty provider results.
}
```

Use `Intl.DateTimeFormat(..., { timeZone: timezone, hourCycle: 'h23' })` for Shanghai date/hour calculation. Treat a Panda bridge result as nonempty only when `result.data` is a nonempty array or `result.rowCount > 0`.

- [ ] **Step 4: Run resolver tests and confirm GREEN**

Run:

```bash
node --test test/market-report-date.test.js
```

Expected: all resolver tests pass.

- [ ] **Step 5: Commit the resolver**

```bash
git add agents/market-analyst/report-date.js test/market-report-date.test.js
git commit -m "feat(agent): resolve latest completed report date"
```

---

### Task 3: Carry Date Selection Through Orchestration and Evidence

**Files:**
- Modify: `agents/market-analyst/orchestrator.js`
- Modify: `agents/market-analyst/worker-runner.js`
- Modify: `agents/market-analyst/tools/panda_market_worker.py`
- Modify: `agents/market-analyst/schemas.js`
- Modify: `agents/market-analyst/run-trace.js`
- Modify: `test/market-analyst-integration.test.js`
- Modify: `test/market-worker/test_market_worker.py`
- Modify: `test/market-analyst-config.test.js`
- Modify: `test/market-analyst-state.test.js`

**Interfaces:**
- Consumes: `resolveMarketReportDate({ explicitDate, now, timezone, signal })`
- Produces: Evidence Pack and Run Trace `dateSelection` object whose `effectiveDate` equals `reportDate`

- [ ] **Step 1: Write failing orchestrator tests**

Add integration tests that inject `resolveReportDate` into `MarketOrchestrator`:

```js
const fixture = dependencies(stateDir, {
  async resolveReportDate() {
    return {
      requestedDate: '2026-07-30',
      effectiveDate: '2026-07-29',
      mode: 'latest-completed-trading-day',
      reason: 'REQUEST_DATE_NOT_COMPLETED'
    };
  }
});
```

Assert:

- an operation without `date` locks and invokes the worker with `date: '2026-07-29'`;
- the worker request contains the exact `dateSelection`;
- a structured explicit date produces `mode: 'explicit'` and is not changed;
- resolver failure produces a rejected/failed task without invoking the worker.

- [ ] **Step 2: Write failing Worker and schema tests**

In Python Worker tests, pass:

```python
"dateSelection": {
    "requestedDate": "2026-07-30",
    "effectiveDate": "2026-07-29",
    "mode": "latest-completed-trading-day",
    "reason": "REQUEST_DATE_NOT_COMPLETED",
}
```

Assert the same object appears in complete and skipped Evidence Packs.

In Node schema tests, assert:

- valid `dateSelection` passes;
- invalid dates, unknown mode/reason, extra keys, or `effectiveDate !== reportDate` fail;
- `reason` must be `null`, `REQUEST_DATE_NOT_COMPLETED`, or `REQUEST_DATE_DATA_UNAVAILABLE`.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
node --test test/market-analyst-integration.test.js test/market-analyst-config.test.js test/market-analyst-state.test.js
npm run test:market-worker
```

Expected: new date-selection assertions fail.

- [ ] **Step 4: Integrate the resolver before the run lock**

In `MarketOrchestrator`:

- add `this.resolveReportDate = dependencies.resolveReportDate || resolveMarketReportDate`;
- call it after `validateOperation()` and before `acquireRunLock()`;
- pass `explicitDate: operation.date`, `now: this.clock()`, configured timezone, and `input.signal`;
- set `reportDate = dateSelection.effectiveDate`;
- carry `dateSelection` into task state, trace metadata, step detail, and worker request.

This ordering ensures the lock key and artifact directory use the effective trading date.

- [ ] **Step 5: Validate and pass the Worker payload**

In `worker-runner.js`, validate the exact four-key `dateSelection` record and include it in the Python JSON payload. Reject extra keys or a mismatched `effectiveDate`/`date`.

In `panda_market_worker.py`, copy the validated record into both `_skipped_evidence_pack()` and the normal Evidence Pack result without changing its values.

- [ ] **Step 6: Validate Evidence Pack and trace metadata**

In `schemas.js`, add an optional exact-record validator:

```js
{
  requestedDate: 'YYYY-MM-DD',
  effectiveDate: 'YYYY-MM-DD',
  mode: 'explicit' | 'latest-completed-trading-day',
  reason: null | 'REQUEST_DATE_NOT_COMPLETED' | 'REQUEST_DATE_DATA_UNAVAILABLE'
}
```

Require `dateSelection.effectiveDate === value.reportDate`.

In `run-trace.js`, copy `evidence.dateSelection` in `addEvidenceMetadata()` so the final trace and Evidence Pack agree.

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run:

```bash
node --test test/market-report-date.test.js test/market-analyst-integration.test.js test/market-analyst-config.test.js test/market-analyst-state.test.js
npm run test:market-worker
```

Expected: all focused tests pass.

- [ ] **Step 8: Commit orchestration and evidence propagation**

```bash
git add agents/market-analyst/orchestrator.js agents/market-analyst/worker-runner.js agents/market-analyst/tools/panda_market_worker.py agents/market-analyst/schemas.js agents/market-analyst/run-trace.js test/market-analyst-integration.test.js test/market-worker/test_market_worker.py test/market-analyst-config.test.js test/market-analyst-state.test.js
git commit -m "feat(agent): audit implicit trading-date fallback"
```

---

### Task 4: Render the Fallback Notice in Every Report Format

**Files:**
- Modify: `agents/market-analyst/report-renderer.js`
- Modify: `agents/market-analyst/report-validator.js`
- Modify: `test/market-analyst-report.test.js`

**Interfaces:**
- Consumes: validated `evidence.dateSelection`
- Produces: one consistent Chinese fallback notice in Markdown, HTML, and plain text

- [ ] **Step 1: Write a failing rendering test**

Add a fixture with:

```js
dateSelection: {
  requestedDate: '2026-07-30',
  effectiveDate: '2026-07-29',
  mode: 'latest-completed-trading-day',
  reason: 'REQUEST_DATE_NOT_COMPLETED'
}
```

Render it and assert all formats contain both dates and:

```text
请求日期 2026-07-30 尚未形成完整收盘数据，已使用最近已完成交易日 2026-07-29。
```

Also assert an explicit-date report does not display a fallback warning.

- [ ] **Step 2: Run the report test and confirm RED**

Run:

```bash
node --test test/market-analyst-report.test.js
```

Expected: fallback-notice assertions fail.

- [ ] **Step 3: Implement one shared notice formatter**

Add a private formatter in `report-renderer.js`:

```js
function dateSelectionNotice(selection) {
  if (!selection || selection.reason === null) return '';
  if (selection.reason === 'REQUEST_DATE_DATA_UNAVAILABLE') {
    return `请求日期 ${selection.requestedDate} 暂无完整市场数据，已使用最近已完成交易日 ${selection.effectiveDate}。`;
  }
  return `请求日期 ${selection.requestedDate} 尚未形成完整收盘数据，已使用最近已完成交易日 ${selection.effectiveDate}。`;
}
```

Add the notice to the shared run overview so Markdown and HTML render from the same value. Ensure plain text, which is derived from rendered sections, contains the same notice. Update report validation to require the notice when `dateSelection.reason` is non-null.

- [ ] **Step 4: Run report tests and confirm GREEN**

Run:

```bash
node --test test/market-analyst-report.test.js
```

Expected: all report tests pass.

- [ ] **Step 5: Commit report rendering**

```bash
git add agents/market-analyst/report-renderer.js agents/market-analyst/report-validator.js test/market-analyst-report.test.js
git commit -m "feat(agent): disclose report-date fallback"
```

---

### Task 5: Full Verification and Safe Service Restart

**Files:**
- Verify: `.env`
- Verify: all files changed in Tasks 2–4
- Runtime: V2 on `0.0.0.0:4173`
- Runtime: V1 on `0.0.0.0:4174`
- Runtime: Agent on `0.0.0.0:4190`

**Interfaces:**
- Consumes: completed implementation and local environment
- Produces: passing tests plus running V1, V2, and Agent services

- [ ] **Step 1: Run syntax and focused Node tests**

Run:

```bash
npm run check
node --test test/execution-tuning.test.js test/market-report-date.test.js test/market-analyst-a2a.test.js test/market-analyst-config.test.js test/market-analyst-integration.test.js test/market-analyst-report.test.js test/market-analyst-state.test.js
```

Expected: exit 0 with zero failing tests.

- [ ] **Step 2: Run the full Python Worker suite**

Run:

```bash
npm run test:market-worker
```

Expected: exit 0 with zero failing tests.

- [ ] **Step 3: Run the full repository test suite**

Run:

```bash
npm test
```

Expected: exit 0 with zero failing tests.

- [ ] **Step 4: Verify the real Panda date resolver**

Run a Node command that imports `src/env.js`, calls `resolveMarketReportDate()` without an explicit date, and prints only its non-secret selection record.

Expected: `effectiveDate` is a real completed Shanghai trading day, and the result contains no credentials.

- [ ] **Step 5: Avoid interrupting an active evaluation**

Read `data/evaluations.json`. If any V2 evaluation is still nonterminal, report that the new configuration is saved but defer the V2/Agent restart until it becomes terminal. Do not cancel or interrupt it without explicit user authorization.

- [ ] **Step 6: Restart Agent and V2 after the active run is terminal**

Stop only the known Agent and V2 sessions/PIDs, then restart:

```bash
npm run market-agent
npm start
```

Keep V1 running on its existing `PORT=4174`, `DATA_FILE=data/evaluations-v1.json`, and `A2A_BLACK_BOX_V1_ENABLED=false` process.

- [ ] **Step 7: Verify services and authentication**

Check:

```text
http://10.0.10.139:4173/api/health
http://10.0.10.139:4174/api/health
http://10.0.10.139:4190/health
```

Expected: all return HTTP 200; V2 reports black-box enabled; V1 reports it disabled; Agent rejects an A2A request without Token and accepts it with the `.env` Token.

- [ ] **Step 8: Verify new-process tuning**

In the restarted process environment, verify `readA2AExecutionTuning(process.env)` returns:

```json
{
  "multiTurnEnabled": false,
  "repeatCount": 1,
  "requiredHiddenVariants": ["equivalent", "boundary"]
}
```

- [ ] **Step 9: Review the final diff**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Confirm no unrelated dirty files were staged or modified by this implementation.
