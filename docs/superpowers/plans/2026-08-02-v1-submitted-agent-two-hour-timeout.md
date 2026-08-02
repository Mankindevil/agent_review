# V1 Submitted Agent Two-Hour Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give only the V1 submitted Agent a configurable two-hour A2A deadline, while preserving shorter limits for replicas, judging, data, Card resolution, and V2.

**Architecture:** Parse a bounded `V1_SUBMITTED_AGENT_TIMEOUT_MS` once when `EvaluationPipeline` is constructed and pass it through the existing prompt and Agent Example submission paths. Keep the single-turn A2A executor's absolute deadline unchanged and give the V1 Agent Example wrapper an opt-in total deadline shared by every turn, without changing V2's existing per-turn policy. Split the public Nginx cancel/retry location so only synchronous retries receive a 7,500-second proxy window.

**Tech Stack:** Node.js 24 ESM, `node:test`, Nginx, systemd EnvironmentFile, Markdown operations documentation.

## Global Constraints

- `V1_SUBMITTED_AGENT_TIMEOUT_MS` defaults to and is capped at `7200000` milliseconds.
- Only V1 submitted-Agent execution uses the new timeout.
- Agent Card resolution remains 30 seconds; local runtimes and model judging remain 180 seconds; Panda Data remains 60 seconds; V2 is unchanged.
- A2A retries, sends, polls, and snapshots consume one shared absolute deadline.
- A received HTTP 502 is terminal and must not be replayed.
- Synchronous V1 retry proxy timeouts are 7,500 seconds so the 7,200-second application deadline wins.
- Preserve all unrelated dirty worktree changes.

---

### Task 1: V1 submitted-Agent deadline configuration

**Files:**
- Modify: `test/pipeline-control.test.js`
- Modify: `test/a2a-executor.test.js`
- Modify: `src/pipeline.js`
- Modify: `src/a2a.js`
- Modify: `src/a2a-executor.js`

**Interfaces:**
- Produces: `v1SubmittedAgentTimeoutMs(value): number`, returning a positive integer no greater than `7_200_000`, with invalid values defaulting to `7_200_000`.
- Produces: `EvaluationPipeline` private fields `submittedAgentTimeoutMs`, `callA2AAgent`, and `callA2AAgentExample`.
- Produces: optional `policy.totalTimeoutMs` in `executeA2AExample()`, which passes the remaining shared budget to each turn; callers that omit it retain the existing per-turn behavior.
- Consumes: existing `callA2AAgent(card, prompt, timeoutMs, signal, options)` and `callA2AAgentExample(card, example, options)`.

- [x] **Step 1: Write failing parser and prompt-path tests**

Add tests with hand-derived expectations:

```js
assert.equal(v1SubmittedAgentTimeoutMs(undefined), 7_200_000);
assert.equal(v1SubmittedAgentTimeoutMs('7200000'), 7_200_000);
assert.equal(v1SubmittedAgentTimeoutMs('90000'), 90_000);
assert.equal(v1SubmittedAgentTimeoutMs('7200001'), 7_200_000);
assert.equal(v1SubmittedAgentTimeoutMs('invalid'), 7_200_000);
```

Construct a live pipeline with `submittedAgentTimeoutMs: 7_200_000` and `callA2AAgentFn` that records its third argument. Call `pipeline.runSubmittedAgent()` with a normal prompt and assert the observed timeout is exactly `7_200_000`.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test test/pipeline-control.test.js
```

Expected: FAIL because `v1SubmittedAgentTimeoutMs` and the injectable submitted-Agent calls do not exist, while the production call still receives `90_000`.

- [x] **Step 3: Implement the bounded configuration and prompt path**

In `src/pipeline.js`, export:

```js
const V1_SUBMITTED_AGENT_TIMEOUT_MS = 7_200_000;

export function v1SubmittedAgentTimeoutMs(value) {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return V1_SUBMITTED_AGENT_TIMEOUT_MS;
  return Math.min(timeout, V1_SUBMITTED_AGENT_TIMEOUT_MS);
}
```

Store the resolved value and injectable function dependencies in `PIPELINE_PRIVATE`. Update `runSubmittedAgent()` to use the private dependencies and the resolved value instead of literal `90_000`.

- [x] **Step 4: Add the failing Agent Example test**

Inject `callA2AAgentExampleFn`, call `pipeline.runSubmittedAgent()` with `agentExamples[0]`, and assert `options.timeoutMs === 7_200_000`. The test fails until the Example branch uses the private dependency and resolved timeout.

- [x] **Step 5: Implement the Agent Example path and verify GREEN**

Pass `timeoutMs: state.submittedAgentTimeoutMs` to the injected Example call. Run:

```bash
node --test test/pipeline-control.test.js
```

Expected: all tests pass. The existing `replaceBenchmarkOutput()` calls `runSubmittedAgent()`, so initial execution and targeted retry share this tested boundary.

- [x] **Step 6: Enforce one total deadline across multi-turn V1 Agent Examples**

Add a failing executor test showing three turns receiving decreasing budgets from one `policy.totalTimeoutMs`, while the existing per-turn test continues receiving the same budget every turn when the optional total is absent. Implement the optional total budget in `executeA2AExample()` and make only `callA2AAgentExample()` opt in, preserving V2 behavior.

---

### Task 2: Public retry proxy window

**Files:**
- Modify: `test/deploy-config.test.js`
- Modify: `deploy/nginx-production.conf`

**Interfaces:**
- Produces: POST-only `/api/evaluations/:id/cancel` location with ordinary proxy behavior.
- Produces: POST-only `/api/evaluations/:id/retry` location with `proxy_send_timeout 7500s` and `proxy_read_timeout 7500s`.

- [x] **Step 1: Write the failing Nginx contract test**

Use the existing location extraction helper to assert that cancel and retry are separate regex locations, retry contains both 7,500-second timeouts, and cancel does not inherit the long timeout.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/deploy-config.test.js
```

Expected: FAIL because cancel and retry currently share one location with 1,260-second timeouts.

- [x] **Step 3: Split the locations and implement the retry window**

Replace the combined `(?:cancel|retry)` block with two POST-only blocks. Keep buffering/request buffering settings for retry and set both retry timeouts to `7500s`; cancel remains a short ordinary request.

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/deploy-config.test.js
```

Expected: all tests pass.

---

### Task 3: Configuration documentation and regression verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/PRODUCTION_OPERATIONS.md`

**Interfaces:**
- Produces: documented `V1_SUBMITTED_AGENT_TIMEOUT_MS=7200000` configuration and production rollout check.

- [x] **Step 1: Document the environment variable**

Add `V1_SUBMITTED_AGENT_TIMEOUT_MS=7200000` near the core evaluation settings in `.env.example`. Add the default and submitted-Agent-only scope to the README environment table. Add a production verification command that prints only this non-secret variable or validates it without printing other environment values.

- [x] **Step 2: Run static and focused verification**

Run:

```bash
git diff --check
node --test test/pipeline-control.test.js test/deploy-config.test.js test/a2a.test.js test/a2a-executor.test.js
node scripts/check-syntax.js
```

Expected: zero failures and zero syntax errors.

- [x] **Step 3: Run the full V1 gate**

Run:

```bash
npm test
```

Expected: the repository's full configured suite passes. If unrelated dirty work causes failures, create an exact clean snapshot containing HEAD plus only this plan's files and run the same gate there; report both results without modifying unrelated files.

Observed on 2026-08-02: after the shared multi-turn deadline review fix, the scoped V1/A2A/Nginx gate passed 181/181; the exact clean release snapshot passed syntax for 208 tracked JavaScript files. The full suite also completed in an exact HEAD-plus-scoped-changes snapshot after binding `TMPDIR` to a non-symlink path; it retained unrelated baseline failures in V2 dual-track state, stale UI asset assertions, live-reviewer-dependent examples, Windows-only conflict simulation, and replica projection expectations. No scoped V1/A2A/Nginx test failed.

- [x] **Step 4: Review and commit only scoped files**

Review:

```bash
git diff -- src/pipeline.js test/pipeline-control.test.js deploy/nginx-production.conf test/deploy-config.test.js .env.example README.md docs/PRODUCTION_OPERATIONS.md
git status --short
```

Commit only these files plus this plan:

```bash
git add src/pipeline.js test/pipeline-control.test.js deploy/nginx-production.conf test/deploy-config.test.js .env.example README.md docs/PRODUCTION_OPERATIONS.md docs/superpowers/plans/2026-08-02-v1-submitted-agent-two-hour-timeout.md
git commit -m "feat: allow two-hour V1 Agent runs"
```

---

### Task 4: Push and production deployment

**Files:**
- Remote modify: `/etc/agent-review/agent-review.env`
- Remote install: `/opt/agent-review/releases/${implementation_commit}` where `implementation_commit="$(git rev-parse HEAD)"` is captured after the scoped commit
- Remote modify: `/etc/nginx/sites-available/agent-review`
- Remote switch: `/opt/agent-review/app`

**Interfaces:**
- Consumes: committed release archive, current production EnvironmentFile, current release symlink, and Nginx site.
- Produces: production process with `V1_SUBMITTED_AGENT_TIMEOUT_MS=7200000`, deployed code commit, and 7,500-second retry proxy window.

- [ ] **Step 1: Push the branch**

Run:

```bash
git push origin codex/finance-roast
```

Expected: remote branch advances to the implementation commit.

- [ ] **Step 2: Prepare and verify an immutable candidate release**

Set `implementation_commit="$(git rev-parse HEAD)"`, archive exactly that commit, upload it to `14.103.143.171`, extract to `/opt/agent-review/releases/${implementation_commit}`, reuse the production virtual environment/dependencies according to the existing release process, and run the focused tests plus syntax checks inside the candidate before promotion.

- [ ] **Step 3: Stage environment and Nginx changes transactionally**

Create root-only backups of `/etc/agent-review/agent-review.env` and `/etc/nginx/sites-available/agent-review`. Add or replace exactly:

```text
V1_SUBMITTED_AGENT_TIMEOUT_MS=7200000
```

Render the candidate Nginx template with public IP `14.103.143.171`, install it atomically, and require `nginx -t` before reload. Do not output secret environment values.

- [ ] **Step 4: Promote with rollback**

Atomically switch `/opt/agent-review/app` to the candidate, restart `agent-review.service`, reload `nginx.service`, and poll `http://127.0.0.1:4173/api/health`. On failure, restore the previous symlink, environment file, and Nginx file, then restart/reload the prior version.

- [ ] **Step 5: Verify production behavior**

Require all of the following:

```text
agent-review.service = active
nginx.service = active
xray.service = inactive and disabled
public /api/health returns ok=true
live release symlink equals the implementation commit
process environment contains V1_SUBMITTED_AGENT_TIMEOUT_MS=7200000
live Nginx retry location contains proxy_send_timeout/read_timeout 7500s
```

Run a bounded A2A request-definition/configuration check rather than waiting two hours. Do not claim that this change fixes a PandaOS-originated HTTP 502; verify only that the platform passes the new deadline and remains healthy.
