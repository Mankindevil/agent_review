# Finance Roast Post-Merge Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the merged V2 ownership, submission-boundary, browser-state, legacy-compatibility, and Market Worker verification gaps, then verify and push `codex/finance-roast`.

**Architecture:** Keep destructive V2 state transitions inside `EvaluationPipeline` and pass participant credentials through HTTP and memory-only browser state. Tighten input contracts at the submission boundary, preserve legacy body semantics in the shared reader, and make the Python verification entry point reproducible without weakening worker cache assertions.

**Tech Stack:** Node.js 20 ESM, native `node:test`, browser JavaScript, Python 3.12 `unittest`, pandas, PyArrow 25.0.0, Git

## Global Constraints

- Do not persist participant tokens or Agent authorization in storage, URLs, logs, events, or public projections.
- Preserve exact legacy cancel/delete behavior and the feature-flag-off 1,000,000-byte body limit.
- V2 cancel/archive missing or wrong ownership must return 401 with zero mutation side effects.
- Do not stage `.playwright-mcp/`, `.runlogs/`, screenshots, Python bytecode, or the unrelated untracked integration plan.
- Use tests before production changes and run the full Node and Python suites before committing.

---

### Task 1: Complete V2 cancel/archive ownership

**Files:**
- Modify: `test/api-v2.test.js`
- Modify: `test/pipeline-control.test.js`
- Modify: `test/server-startup.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `bearerToken(value) -> string`, `pipeline.cancel(id, token)`, `pipeline.archive(id, token)`
- Produces: participant-authenticated HTTP `POST /api/evaluations/:id/cancel` and `DELETE /api/evaluations/:id`

- [x] **Step 1: Migrate direct V2 test cleanup calls**

Pass each `pipeline.create()` result's `participantAccessToken` into every direct V2 `pipeline.cancel()` call while leaving legacy calls unchanged.

- [x] **Step 2: Run the focused tests and record the expected remaining HTTP failure**

Run:

```powershell
node --test test/api-v2.test.js test/pipeline-control.test.js test/server-startup.test.js
```

Expected: the fixture/cleanup authorization failures disappear; the authorized HTTP cancel/archive contract still fails because `server.js` drops or bypasses the token.

- [x] **Step 3: Route HTTP destructive actions through the pipeline**

In `server.js`, extract the Bearer token for V2 cancel/archive, call:

```js
await pipeline.cancel(id, bearerToken(request.headers.authorization));
await pipeline.archive(id, bearerToken(request.headers.authorization));
```

Keep legacy delete on `store.delete()` and serialize the V2 archive receipt from the pipeline result.

- [x] **Step 4: Verify the focused ownership tests**

Run the Task 1 command again. Expected: all tests pass.

### Task 2: Reject every malformed declared endpoint

**Files:**
- Modify: `test/submission.test.js`
- Modify: `src/submission.js`

**Interfaces:**
- Consumes: `freezeSubmission()` and `assertFrozenSubmissionIntegrity()`
- Produces: strict rejection for any present top-level or interface `url` that is not a safe string

- [x] **Step 1: Add failing endpoint-type tests**

Add cases for top-level `url` values `null`, `{ hidden: '?token=secret' }`, and `['#secret']` on an otherwise valid V1-shaped Card. Assert rejection without echoing the sentinel secret, and add a frozen-integrity tamper case.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test test/submission.test.js
```

Expected: the new non-string top-level URL cases fail because they are currently accepted.

- [x] **Step 3: Apply the strict declaration guard**

Use `Object.hasOwn(agentCard, 'url')` and `Object.hasOwn(declaredInterface, 'url')` to call `assertV2EndpointCredentialBoundary()` whenever an endpoint field is declared. Keep its error generic so raw credentials are never echoed.

- [x] **Step 4: Verify GREEN**

Run the Task 2 command again. Expected: all tests pass.

### Task 3: Preserve malformed legacy body limits with V2 enabled

**Files:**
- Modify: `test/api-v2.test.js`
- Modify: `src/utils.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `readJsonBodyWithSize(request, limit)`
- Produces: parse errors carrying non-secret `bodySize`, allowing `readEvaluationCreateBody()` to convert oversized malformed legacy input to 413

- [x] **Step 1: Add the failing HTTP compatibility test**

Post a 1,000,001-byte malformed JSON body to `/api/evaluations` while V2 is enabled and assert 413. Retain coverage proving a valid V2 request may exceed the legacy limit.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test test/api-v2.test.js
```

Expected: malformed oversized input returns 400 instead of 413.

- [x] **Step 3: Expose parse-error size and classify safely**

Attach `bodySize: size` to the 400 error from `readJsonBodyWithSize()`. In `readEvaluationCreateBody()`, convert a parse error with `bodySize > LEGACY_EVALUATION_BODY_LIMIT` to a generic 413 without including body data.

- [x] **Step 4: Verify GREEN**

Run the Task 3 command again. Expected: all tests pass.

### Task 4: Align browser ownership and state affordances

**Files:**
- Create: `public/evaluation-actions.js`
- Create: `test/browser-evaluation-actions.test.js`
- Modify: `test/api.test.js`
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `state.participantTokens`, `#resume-participant-token`, V2 public projections
- Produces: memory-only Bearer headers for cancel/archive and status-correct controls

- [x] **Step 1: Add failing browser-action behavior tests**

Import the wished-for production helpers from `public/evaluation-actions.js` and exercise observable results with literal fixtures:

- `resolveParticipantToken(id, tokenMap, manualValue)` returns the memory token first, otherwise the trimmed manual token, and rejects a missing token;
- `participantActionOptions(method, token)` produces the exact Bearer header;
- `canStopEvaluation(item)` is false for archived or terminal V2 records;
- `canArchiveEvaluation(item)` is true only for unarchived `completed`, `failed`, `cancelled`, or `interrupted` V2 records;
- `restoreV2StartButton(button)` enables a minimal fake button and restores its visible label.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test test/browser-evaluation-actions.test.js
```

Expected: module import fails because the production action helpers do not exist.

- [x] **Step 3: Implement one memory-only token helper**

Create the tested pure helpers, import them from `public/app.js`, and add a small DOM adapter that stores a manually entered token only in `state.participantTokens`, clears the input, and throws an actionable error if missing. Use it only for V2 cancel/archive.

- [x] **Step 4: Correct control states**

Restore the create button after receipt dismissal and in `showLanding()`, hide/no-op stop for archived items, and compute archive eligibility from terminal archiveable V2 statuses.

- [x] **Step 5: Verify GREEN**

Run:

```powershell
node --test test/browser-evaluation-actions.test.js test/api.test.js
```

Expected: helper behavior and served-page integration tests pass.

### Task 5: Make Market Worker verification reproducible

**Files:**
- Modify: `test/market-worker-runner.test.js`
- Modify: `scripts/run-market-worker-tests.js`
- Modify: `requirements-data.txt`
- Modify: `README.md`
- Modify: `docs/MARKET_ANALYST_AGENT.md`

**Interfaces:**
- Consumes: optional `PANDA_DATA_PYTHON`, repository `.venv`
- Produces: exported `resolvePythonCommand()` and a direct-run test runner using PyArrow 25.0.0

- [x] **Step 1: Add failing runner-selection tests**

Create a Node test that imports `resolvePythonCommand()` and covers precedence:

```text
PANDA_DATA_PYTHON -> repository .venv -> Windows python -> Windows py -> POSIX python3
```

Dependency-inject `existsSync`/command discovery so the test does not depend on the host PATH.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test test/market-worker-runner.test.js
```

Expected: import/export fails because the resolver does not yet exist.

- [x] **Step 3: Extract the resolver and guard direct execution**

Export `resolvePythonCommand(options)` and run the child process only when the script is the entry point. On Windows prefer `python` when discoverable, then `py`; preserve the environment and `.venv` precedence.

- [x] **Step 4: Pin the Parquet engine**

Add:

```text
pyarrow==25.0.0
```

to `requirements-data.txt`, and document `PANDA_DATA_PYTHON` plus Windows `.venv` commands in README and the Market Agent guide.

- [x] **Step 5: Verify the runner tests**

Run the Task 5 Node command. Expected: all tests pass.

- [x] **Step 6: Verify the real Python worker suite**

Install PyArrow 25.0.0 into a temporary verification target, expose it only through `PYTHONPATH`, set `PANDA_DATA_PYTHON` to the bundled Python, and run:

```powershell
node scripts/run-market-worker-tests.js
```

Expected: 87 tests pass without modifying the shared Python runtime or committing installed packages.

### Task 6: Complete diagnostics capability negotiation

**Files:**
- Modify: `src/a2a.js`
- Modify: `src/agent-diagnostics.js`
- Modify: `public/agent-check.js`
- Create: `public/agent-check-helpers.js`
- Modify: `test/a2a.test.js`
- Modify: `test/agent-diagnostics.test.js`
- Create: `test/agent-check-helpers.test.js`
- Modify: `test/market-analyst-a2a.test.js`

**Interfaces:**
- Consumes: Agent Card `defaultOutputModes` and `skills[].examples[]`
- Produces: binding-correct accepted output modes and a Card-compatible default diagnostics Prompt

- [x] **Step 1: Add failing request, negotiation, and Prompt-selection tests**

Cover JSON-RPC and HTTP+JSON serialization, order-preserving mode
intersection, fail-before-network behavior, and preservation of user-edited
Prompts.

- [x] **Step 2: Implement output-mode negotiation**

Pass the same supported Card intersection to ordinary and streaming requests,
retain conservative defaults for omitted declarations, and report an
incompatible declared list as a protocol-stage failure.

- [x] **Step 3: Select a declared skill example in the browser**

For pasted Cards, select the first non-empty example immediately. For URL
sources, pre-resolve through the existing same-origin endpoint before
submission while leaving the diagnostics endpoint authoritative for the
actual source resolution.

- [x] **Step 4: Verify against the protected Panda Market Analyst**

Exercise authenticated ordinary and streaming calls against the real local
Market Agent harness and require both to pass with
`text/markdown`/`application/json`.

### Task 7: Full verification and delivery

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-finance-roast-post-merge-hardening-design.md`
- Modify: `docs/superpowers/plans/2026-07-25-finance-roast-post-merge-hardening.md`
- Verify: all tracked files

**Interfaces:**
- Consumes: Tasks 1-5
- Produces: one verified commit pushed to `origin/codex/finance-roast`

- [x] **Step 1: Run syntax and whitespace checks**

```powershell
npm run check
git diff --check
```

- [x] **Step 2: Run complete Node verification**

```powershell
npm run test:node
```

Expected: zero failures.

- [x] **Step 3: Run the complete repository test command**

Use the temporary PyArrow verification target and explicit `PANDA_DATA_PYTHON`:

```powershell
npm test
```

Expected: Node and all 87 Python worker tests pass.

- [x] **Step 4: Review exact staged paths**

Stage only the spec, plan, source, tests, requirements, and documentation named above. Confirm no user artifacts or generated caches are staged.

- [x] **Step 5: Commit and push**

```powershell
git commit -m "fix: finish finance roast post-merge hardening"
git push -u origin codex/finance-roast
```
