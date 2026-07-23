# Agent Card JSON Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace URL-based diagnostics input with a single uploaded/pasted Agent Card JSON and report competition-aligned A2A technical readiness.

**Architecture:** The browser parses one Card for immediate feedback but the server remains authoritative. `src/agent-diagnostics.js` validates the uploaded Card, selects the first supported interface through `src/a2a.js`, performs ordinary and optional streaming calls, and derives a separate technical-readiness summary. Existing safe HTTP, access-key, rate-limit, concurrency, cancellation, redaction, and A2A request builders remain the security and protocol foundation.

**Tech Stack:** Node.js 20 ESM, native `node:test`, native HTTP server, vanilla HTML/CSS/JavaScript.

## Global Constraints

- One uploaded JSON object equals one Agent Card and one technical-readiness result; arrays are rejected.
- A composite multi-Agent system may expose one orchestrator Card; independently exposed Agents are tested one Card at a time.
- Preserve A2A 1.0 HTTP+JSON, A2A 1.0 JSON-RPC, A2A 0.3 JSON-RPC, and `tenant` propagation.
- Keep streaming disabled by default and require explicit confirmation for its second real execution.
- Accept per-call timeouts from `60_000` through `1_200_000` ms; default to `300_000` ms.
- Require `DeepSeek V4 Pro` and authorized-data-only attestations.
- Keep credentials, Card JSON, and results memory-only and never write diagnostics history.
- The final registration form, not this page, owns team, documentation, examples, Skills lists, repository, and formal Card URL.

---

### Task 1: Uploaded Card input and readiness orchestration

**Files:**
- Modify: `test/agent-diagnostics.test.js`
- Modify: `src/agent-diagnostics.js`

**Interfaces:**
- Consumes: `validateAgentCard(card)`, `selectInterface(card)`, `buildA2ARequest(target, prompt, options)`.
- Produces: `validateDiagnosticsInput(input)` returning normalized `agentCard`, auth, prompt, timeout, streaming, and attestations; `runAgentDiagnostics(input, options)` returning `technicalReadinessOk` and `technicalReadiness.checks`.

- [ ] **Step 1: Replace legacy-input tests with failing uploaded-Card tests**

Add assertions equivalent to:

```js
const baseInput = {
  agentCard: card,
  authMethod: 'none',
  prompt: 'status',
  timeoutMs: 300_000,
  attestations: { deepseekV4Pro: true, authorizedDataOnly: true }
};

assert.throws(() => validateDiagnosticsInput({ ...baseInput, agentCard: [card] }), /单个|对象/);
assert.throws(() => validateDiagnosticsInput({ ...baseInput, url: 'https://other.example' }), /旧地址字段|agentCard/);
assert.throws(() => validateDiagnosticsInput({ ...baseInput, timeoutMs: 59_999 }), /60000/);
assert.throws(() => validateDiagnosticsInput({ ...baseInput, timeoutMs: 1_200_001 }), /1200000/);
assert.equal(validateDiagnosticsInput(baseInput).timeoutMs, 300_000);

assert.throws(() => validateDiagnosticsInput({
  ...baseInput,
  authMethod: 'bearer',
  agentAuthorization: 'secret',
  confirmAuthorizationTarget: false
}), /目标 origin/);

assert.throws(() => validateDiagnosticsInput({
  ...baseInput,
  attestations: { deepseekV4Pro: false, authorizedDataOnly: true }
}), /DeepSeek V4 Pro/);
```

Add a request-spy test that calls `runAgentDiagnostics(baseInput, { request })`, verifies the first network request is the A2A POST rather than Card discovery, verifies `params.tenant === 'finance'`, verifies no Authorization header for `none`, and expects:

```js
assert.deepEqual(report.checks.map(({ id, status }) => [id, status]), [
  ['card-input', 'passed'],
  ['card-validation', 'passed'],
  ['call', 'passed'],
  ['stream', 'skipped']
]);
assert.equal(report.ok, true);
assert.equal(report.technicalReadinessOk, true);
assert.deepEqual(
  report.technicalReadiness.checks.map(({ id, status }) => [id, status]),
  [
    ['agent-card', 'passed'],
    ['a2a-call', 'passed'],
    ['response-time', 'passed'],
    ['competition-attestations', 'declared']
  ]
);
```

Add a zero-network test for malformed Card validation, a Card-array rejection test, Bearer target-confirmation/redaction tests, timeout boundary tests, and streaming tests using the uploaded Card directly.

- [ ] **Step 2: Run the diagnostics tests and verify the new expectations fail**

Run:

```powershell
node --test test/agent-diagnostics.test.js
```

Expected: failures showing the legacy `sourceType`/`url` contract and discovery request are still active.

- [ ] **Step 3: Implement the normalized uploaded-Card contract**

Replace URL/source validation with:

```js
const MIN_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 1_200_000;
const MAX_CARD_BYTES = 1024 * 1024;
const CHECK_IDS = ['card-input', 'card-validation', 'call', 'stream'];

export function validateDiagnosticsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw clientError('请求体必须是 JSON 对象');
  if (Object.hasOwn(input, 'url') || Object.hasOwn(input, 'sourceType')) {
    throw clientError('请只提交 agentCard，不要同时提交旧地址字段 url 或 sourceType');
  }
  if (!input.agentCard || typeof input.agentCard !== 'object' || Array.isArray(input.agentCard)) {
    throw clientError('agentCard 必须是单个 JSON 对象');
  }
  let cardBytes;
  try {
    cardBytes = Buffer.byteLength(JSON.stringify(input.agentCard));
  } catch {
    throw clientError('agentCard 必须可以序列化为 JSON');
  }
  if (cardBytes > MAX_CARD_BYTES) throw clientError('agentCard 不能超过 1 MiB');

  const authMethod = input.authMethod;
  if (!['none', 'bearer'].includes(authMethod)) throw clientError('authMethod 必须是 none 或 bearer');
  const token = input.agentAuthorization ?? '';
  if (typeof token !== 'string' || Buffer.byteLength(token) > 8192 || /[\r\n]/.test(token)) {
    throw clientError('agentAuthorization 必须是不含换行且不超过 8 KiB 的 Token');
  }
  if (authMethod === 'none' && token) throw clientError('无鉴权模式不得提交 Agent Token');
  if (authMethod === 'bearer' && !token) throw clientError('Bearer 鉴权必须填写 Agent Token');
  if (authMethod === 'bearer' && input.confirmAuthorizationTarget !== true) {
    throw clientError('发送 Agent Token 前必须确认目标 origin');
  }

  if (typeof input.prompt !== 'string' || !input.prompt.trim() || [...input.prompt].length > 4000) {
    throw clientError('prompt 必须是 1–4000 个字符的字符串');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw clientError('timeoutMs 必须是 60000–1200000 之间的整数');
  }
  const runStreaming = input.runStreaming === true;
  if (runStreaming && input.confirmStreamingSideEffects !== true) {
    throw clientError('启用流式检查前必须确认它会再次真实执行 Prompt');
  }
  if (input.attestations?.deepseekV4Pro !== true) throw clientError('必须确认底座模型为 DeepSeek V4 Pro');
  if (input.attestations?.authorizedDataOnly !== true) throw clientError('必须确认 Agent 仅访问授权数据');

  return {
    agentCard: input.agentCard,
    cardBytes,
    authMethod,
    agentAuthorization: token,
    confirmAuthorizationTarget: authMethod === 'bearer',
    prompt: input.prompt.trim(),
    timeoutMs,
    runStreaming,
    confirmStreamingSideEffects: runStreaming,
    attestations: { deepseekV4Pro: true, authorizedDataOnly: true }
  };
}
```

- [ ] **Step 4: Replace discovery with Card intake and independent per-call timeouts**

Start `runAgentDiagnostics` with a passed `card-input` check containing safe metadata (`name`, serialized byte count, and whether the root is a single object). Validate and select the Card before any network call. Remove discovery HTTP, cross-origin discovery comparison, and the shared deadline.

Use:

```js
const requestOptions = (overrides = {}) => ({
  signal: options.signal,
  timeoutMs: input.timeoutMs,
  ...overrides
});
```

For `card-validation`, include `version`, `binding`, `targetOrigin`, `streaming`, `tenant`, and `skillsCount`. On validation or safe-URL failure, block call and stream without invoking `request`.

- [ ] **Step 5: Derive the competition-aligned technical summary**

Implement:

```js
function readinessCheck(id, status, summary, details = {}) {
  return { id, status, summary, details };
}

function buildTechnicalReadiness(checks, timeoutMs) {
  const card = checks.find((check) => check.id === 'card-validation');
  const call = checks.find((check) => check.id === 'call');
  const cardStatus = card?.status === 'passed' ? 'passed' : card?.status === 'failed' ? 'failed' : 'blocked';
  const callStatus = call?.status === 'passed' ? 'passed' : call?.status === 'failed' ? 'failed' : 'blocked';
  const responseStatus = call?.status === 'passed' ? 'passed' : call?.status === 'failed' ? 'failed' : 'blocked';
  const result = {
    checks: [
      readinessCheck('agent-card', cardStatus, card?.summary || 'Agent Card 尚未校验'),
      readinessCheck('a2a-call', callStatus, call?.summary || 'A2A 调用尚未执行'),
      readinessCheck('response-time', responseStatus,
        call?.status === 'passed' ? `普通调用在 ${timeoutMs} ms 上限内完成` : '普通调用未在上限内完成',
        { timeoutMs, durationMs: call?.durationMs || 0 }),
      readinessCheck('competition-attestations', 'declared', '两项参评声明已确认，仍需人工核验')
    ]
  };
  result.ok = result.checks.slice(0, 3).every((check) => check.status === 'passed');
  return result;
}
```

Return `technicalReadinessOk` and `technicalReadiness` from `finalize`.

- [ ] **Step 6: Run diagnostics tests and verify green**

Run:

```powershell
node --test test/agent-diagnostics.test.js
```

Expected: all diagnostics tests pass.

- [ ] **Step 7: Commit backend behavior**

```powershell
git add -- test/agent-diagnostics.test.js src/agent-diagnostics.js
git commit -m "feat: test uploaded agent cards for readiness"
```

### Task 2: API body budget and endpoint contract

**Files:**
- Modify: `test/api.test.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `runAgentDiagnostics(input, options)`.
- Produces: protected `POST /api/agent-diagnostics` accepting up to 1.25 MiB and returning input errors as 400, oversized bodies as 413, and upstream failures as HTTP 200 reports.

- [ ] **Step 1: Write failing endpoint and static-page assertions**

Change the diagnostics body-limit test to send a body larger than `1_310_720` bytes and expect 413. Change API inputs to use:

```js
{
  agentCard: {
    name: 'Local Agent',
    description: 'Local failure target.',
    url: 'http://127.0.0.1:1',
    protocolVersion: '0.3',
    skills: [{ id: 'status', name: 'Status', description: 'Return status.' }]
  },
  authMethod: 'none',
  prompt: 'status',
  timeoutMs: 60_000,
  attestations: { deepseekV4Pro: true, authorizedDataOnly: true }
}
```

Assert an uploaded Card array returns 400, and an unreachable valid Card returns HTTP 200 with `card-input=passed`, `card-validation=passed`, `call=failed`, and unchanged evaluation history.

- [ ] **Step 2: Run endpoint tests and verify red**

Run:

```powershell
node --test test/api.test.js
```

Expected: 32 KiB requests are still rejected and legacy input assertions fail.

- [ ] **Step 3: Raise only the diagnostics body limit**

Change the diagnostics route to:

```js
const input = await readJsonBody(request, Math.floor(1.25 * 1024 * 1024));
```

Do not change limits for any other API.

- [ ] **Step 4: Run endpoint tests and verify green**

Run:

```powershell
node --test test/api.test.js
```

Expected: all endpoint tests pass.

- [ ] **Step 5: Commit the API contract**

```powershell
git add -- test/api.test.js server.js
git commit -m "feat: accept agent card payloads in diagnostics api"
```

### Task 3: Agent Card upload console

**Files:**
- Modify: `test/api.test.js`
- Modify: `public/agent-check.html`
- Modify: `public/agent-check.js`
- Modify: `public/agent-check.css`

**Interfaces:**
- Consumes: user-selected `.json` file or pasted JSON; `POST /api/agent-diagnostics`.
- Produces: an in-memory parsed Card, selected-interface summary, Bearer target confirmation, attestations, and rendered technical-readiness report.

- [ ] **Step 1: Write failing static UI assertions**

Require these IDs:

```js
[
  'diagnostics-form', 'platform-key', 'agent-card-file', 'agent-card-json',
  'card-drop-zone', 'card-summary', 'auth-method', 'agent-token',
  'auth-target-origin', 'confirm-auth-target', 'diagnostic-prompt',
  'timeout-ms', 'attestation-deepseek', 'attestation-authorized',
  'run-streaming', 'confirm-streaming', 'technical-readiness',
  'check-card-input', 'check-card-validation', 'check-call', 'check-stream'
]
```

Assert the HTML includes all four timeout values (`60000`, `300000`, `600000`, `1200000`), “一次只测试一张 Agent Card”, “内部多 Agent”, “最终报名表”, and “再次真实执行”. Assert the script contains `agentCard`, `confirmAuthorizationTarget`, file-size validation, `/api/agent-diagnostics`, `pageshow`, and no Web Storage API.

- [ ] **Step 2: Run the UI resource test and verify red**

Run:

```powershell
node --test --test-name-pattern "standalone diagnostics console" test/api.test.js
```

Expected: missing upload, attestation, readiness, and new check IDs.

- [ ] **Step 3: Replace the legacy address form**

Implement four input sections:

1. platform access key;
2. file drop/selection plus JSON textarea and Card summary;
3. auth method, conditional Token and target-origin confirmation, prompt, timeout, and streaming;
4. the two required attestations.

Replace discovery copy with uploaded-Card copy and update asset query versions to `20260724`.

- [ ] **Step 4: Implement memory-only Card parsing and form submission**

Maintain:

```js
const MAX_CARD_BYTES = 1024 * 1024;
let parsedAgentCard = null;
let selectedTargetOrigin = '';
```

`applyCardText(text)` must reject invalid JSON, non-object roots, arrays, and oversized UTF-8 text; then display name, description, version, selected interface, target origin, tenant, Skills count, and streaming capability using `textContent`.

When `authMethod` is `bearer`, require Token and `confirm-auth-target`; reset confirmation whenever the Card changes. Submit:

```js
{
  agentCard: parsedAgentCard,
  authMethod: authMethod.value,
  agentAuthorization: authMethod.value === 'bearer' ? agentToken.value : '',
  confirmAuthorizationTarget: authMethod.value === 'bearer' && confirmAuthTarget.checked,
  prompt: diagnosticPrompt.value,
  timeoutMs: Number(timeoutSelect.value),
  runStreaming: runStreaming.checked,
  confirmStreamingSideEffects: confirmStreaming.checked,
  attestations: {
    deepseekV4Pro: attestationDeepseek.checked,
    authorizedDataOnly: attestationAuthorized.checked
  }
}
```

`clearSensitiveState()` must clear platform key, Agent Token, file input, pasted Card, parsed state, target confirmation, and rendered summary on `pageshow`/`pagehide`.

- [ ] **Step 5: Render technical readiness**

Render `technicalReadiness.checks` into `#technical-readiness` with labels for `passed`, `failed`, `blocked`, and `declared`. Rename the first trace element from `discovery` to `card-input`.

- [ ] **Step 6: Apply the approved visual direction**

Preserve the current utilitarian “protocol workbench” palette and signal rail. Use the upload zone as the page signature: a blueprint-like JSON drop surface with a live interface summary, while keeping the rest restrained. Add responsive, focus-visible, drag-active, disabled, reduced-motion, readiness-status, and conditional-auth styles.

- [ ] **Step 7: Run resource and syntax tests**

Run:

```powershell
node --test --test-name-pattern "standalone diagnostics console" test/api.test.js
npm run check
```

Expected: both commands pass.

- [ ] **Step 8: Commit the browser experience**

```powershell
git add -- test/api.test.js public/agent-check.html public/agent-check.js public/agent-check.css
git commit -m "feat: add agent card upload readiness console"
```

### Task 4: Complete operator and participant documentation

**Files:**
- Modify: `test/api.test.js`
- Modify: `docs/AGENT_DIAGNOSTICS_GUIDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: implemented UI/API behavior.
- Produces: a complete standalone usage guide and concise repository entry-point description.

- [ ] **Step 1: Write failing documentation assertions**

Require the guide to contain:

```text
Agent Card JSON
一次只测试一张
多 Agent
tenant
DeepSeek V4 Pro
最终报名表
confirmAuthorizationTarget
1 MiB
1.25 MiB
20 分钟
technicalReadinessOk
declared
SSRF
```

Remove the expectation for `allowCrossOriginAuthorization`. Require README to describe “Agent Card JSON 技术预检”.

- [ ] **Step 2: Run the documentation test and verify red**

Run:

```powershell
node --test --test-name-pattern "documents diagnostics" test/api.test.js
```

Expected: missing new workflow and limits.

- [ ] **Step 3: Rewrite the guide around the uploaded-Card workflow**

Document:

- administrator access-key, rate, concurrency, HTTPS, and private-address settings;
- participant file/paste workflow and supported Card versions/bindings;
- composite versus independent multi-Agent submissions and exact `tenant` behavior;
- platform key versus Agent Bearer Token and target-origin confirmation;
- DeepSeek/authorized-data declarations and what remains for the final form/manual review;
- 1/5/10/20 minute options and separate ordinary/streaming budgets;
- trace statuses, `technicalReadinessOk`, `streamingOk`, HTTP codes, errors, SSRF, no persistence, and troubleshooting;
- an example Card and example API request without real credentials.

- [ ] **Step 4: Update README entry points**

Change the diagnostics link sentence and configuration description to “Agent Card JSON 技术预检”, mentioning the 20-minute upper bound and separate formal registration form.

- [ ] **Step 5: Run documentation test and verify green**

Run:

```powershell
node --test --test-name-pattern "documents diagnostics" test/api.test.js
```

Expected: pass.

- [ ] **Step 6: Commit documentation**

```powershell
git add -- test/api.test.js docs/AGENT_DIAGNOSTICS_GUIDE.md README.md
git commit -m "docs: explain agent readiness testing workflow"
```

### Task 5: Full verification and publication

**Files:**
- Verify all modified files.

**Interfaces:**
- Produces: a clean, tested, committed, and pushed branch.

- [ ] **Step 1: Run the complete test suite**

```powershell
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run syntax validation**

```powershell
npm run check
```

Expected: syntax check passes.

- [ ] **Step 3: Run patch and repository checks**

```powershell
git diff --check
git status --short --branch
```

Expected: no whitespace errors and no unstaged implementation changes after commits.

- [ ] **Step 4: Inspect the page at desktop and mobile widths**

Start the server with a test access key, open `/agent-check.html`, inspect the empty state, valid Card summary, Bearer target confirmation, attestation gating, report layout, keyboard focus, and narrow viewport. Fix any visible regression and rerun Tasks 3–5 checks.

- [ ] **Step 5: Push the current branch**

```powershell
git push origin codex/finance-roast
```

Expected: remote branch advances to the final implementation commit.
