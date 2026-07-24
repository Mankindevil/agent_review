# A2A Evidence and Scoring Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned Agent submission contract, immutable full-fidelity A2A evidence, executable acceptance checks, objective capability scoring, and confidence formulas without breaking the current evaluation path.

**Architecture:** Keep every existing record and endpoint on the legacy path unless `A2A_BLACK_BOX_V1_ENABLED=true` and the request explicitly uses `schemaVersion: 2`. The V2 path freezes a canonical Card-and-examples snapshot, executes only public examples in this phase, stores encrypted raw evidence separately from redacted projections, and calculates an objective capability snapshot. Model review, hidden tests, replicas, and human review remain pending for later plans.

**Tech Stack:** Node.js 20 ESM, native HTTP/SSE, native `node:test`, Node `crypto` AES-256-GCM, Ajv 8.17.1 for JSON Schema criteria, vanilla JavaScript.

## Global Constraints

- Formal V2 input is one complete Agent Card plus whole-Agent usage examples. Never require `skillId` and never call an example a “Skill example”.
- Only the Card, examples, direct A2A observations, and directly returned `Part.url` snapshots may enter evidence.
- Preserve raw A2A Message, Task, status, history, Artifact, Part, and stream events; extracted text is only a convenience field.
- Never persist authorization values, Cookie headers, or submitted connection credentials.
- Raw evidence must be append-only and encrypted at rest. Public/API/SSE payloads receive redacted allow-list projections only.
- A retry appends a new `runId` and evidence records; it never replaces a previous run.
- A protocol terminal state without a required executable criterion is not objective semantic success.
- Keep the current pipeline, history, scoring, Runtime flow, and legacy tests available while the feature flag is off.
- Phase 1 must not produce a final three-dimension score, final confidence, replica result, or 夯拉 rating.

---

### Task 1: Make test discovery deterministic

**Files:**
- Modify: `scripts/run-tests.js`
- Add: `test/test-runner.test.js`

**Interfaces:**
- Produces: `npm test` running only the repository root `test/*.test.js`.
- Preserves: `npm test -- test/a2a.test.js` as an explicit-file invocation.

- [ ] **Step 1: Write a failing test for root-only discovery**

Export a pure helper and test it:

```js
import { selectTestFiles } from '../scripts/run-tests.js';

assert.deepEqual(
  selectTestFiles(
    ['test/a2a.test.js', '.worktrees/old/test/a2a.test.js', 'src/a2a.js'],
    []
  ),
  ['test/a2a.test.js']
);
assert.deepEqual(
  selectTestFiles(['test/a.test.js'], ['test/providers.test.js']),
  ['test/providers.test.js']
);
```

- [ ] **Step 2: Verify the new test fails**

Run:

```powershell
node --test test/test-runner.test.js
```

Expected: the import fails because `selectTestFiles` is not exported.

- [ ] **Step 3: Restrict automatic discovery to the root test directory**

Refactor `scripts/run-tests.js` so it enumerates `test/`, sorts files ending in `.test.js`, and uses explicit CLI paths when supplied:

```js
export function selectTestFiles(discovered, requested) {
  if (requested.length) return [...requested];
  return discovered
    .filter((file) => /^test\/[^/]+\.test\.js$/u.test(file.replaceAll('\\', '/')))
    .sort();
}
```

Guard process spawning with:

```js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTests();
}
```

- [ ] **Step 4: Verify focused and full discovery**

Run:

```powershell
node --test test/test-runner.test.js
npm test -- test/a2a.test.js
npm test
```

Expected: the helper test passes, the focused command runs only `test/a2a.test.js`, and the full command does not discover tests under `.worktrees`.

- [ ] **Step 5: Commit the test-runner correction**

```powershell
git add -- scripts/run-tests.js test/test-runner.test.js
git commit -m "test: limit discovery to root test suite"
```

### Task 2: Define and freeze the V2 submission contract

**Files:**
- Add: `schemas/agent-use-examples-v1.schema.json`
- Add: `src/submission.js`
- Add: `src/evaluation-model.js`
- Add: `test/submission.test.js`
- Add: `test/evaluation-model.test.js`
- Modify: `src/a2a.js`
- Modify: `test/a2a.test.js`

**Interfaces:**
- Produces: `normalizeAgentExamples(rawExamples)`.
- Produces: `freezeSubmission({ agentCard, agentExamples, validation, config, frozenAt })`.
- Produces: `createEvaluationRecord(snapshot, options)`.
- Produces: `migrateStoredEvaluation(raw)`.

- [ ] **Step 1: Add failing contract tests**

Use this valid fixture:

```js
const examples = [{
  id: 'portfolio-risk',
  name: '组合风险复盘',
  turns: [{
    input: {
      parts: [
        { type: 'text', text: '分析本组合的行业集中度。' },
        { type: 'data', data: { holdings: [{ symbol: 'A', weight: 0.6 }] } }
      ]
    },
    expectedDeliverable: '行业暴露、集中风险和调整建议',
    acceptanceCriteria: [{
      id: 'risk-word',
      type: 'contains',
      expected: ['集中', '风险'],
      required: true,
      description: '明确指出集中风险'
    }]
  }],
  constraints: ['不得补写未知持仓']
}];
```

Assert:

```js
const normalized = normalizeAgentExamples(examples);
assert.equal(normalized[0].turns[0].input.parts[1].type, 'data');
assert.equal(normalized[0].turns[0].acceptanceCriteria[0].required, true);
assert.equal(Object.hasOwn(normalized[0], 'skillId'), false);
```

Reject duplicate example IDs, duplicate criterion IDs within a turn, empty turns, empty parts, unsupported part/criterion types, non-JSON data, malformed URL parts, missing `expected` values, negative numeric tolerances, and a top-level `cases` field on a formal V2 request.

- [ ] **Step 2: Verify contract tests fail**

Run:

```powershell
npm test -- test/submission.test.js
```

Expected: module-not-found failure for `src/submission.js`.

- [ ] **Step 3: Implement explicit normalization limits**

Set and export:

```js
export const SUBMISSION_LIMITS = {
  examples: 20,
  turnsPerExample: 20,
  partsPerTurn: 50,
  criteriaPerTurn: 50,
  totalCanonicalBytes: 2 * 1024 * 1024
};

export const PART_TYPES = new Set(['text', 'data', 'raw', 'url']);
export const CRITERION_TYPES = new Set([
  'model', 'contains', 'exact', 'json-schema', 'numeric'
]);
```

Use these exact normalized Part shapes:

```js
{ type: 'text', text: 'question' }
{ type: 'data', data: { holdings: [] } }
{ type: 'raw', raw: 'BASE64_BYTES', mediaType: 'application/pdf', filename: 'input.pdf' }
{ type: 'url', url: 'https://files.example/input.csv', mediaType: 'text/csv', filename: 'input.csv' }
```

`raw` must be valid base64 and is decoded only inside the bounded A2A serializer. `url` must be HTTP(S), contain no userinfo credentials, and pass the safe-URL validator before it can be sent. `mediaType` and `filename` are optional for `text/data/url`, required `mediaType` for `raw`, and bounded by the total canonical submission limit.

Use these concrete criterion contracts:

```js
// contains
{ id, type: 'contains', expected: ['token'], required: true, description }

// exact
{ id, type: 'exact', expected: 'complete output', required: true, description }

// json-schema
{ id, type: 'json-schema', schema: { type: 'object' }, required: true, description }

// numeric
{ id, type: 'numeric', path: 'metrics.drawdown', expected: 0.12, tolerance: 0.01,
  required: true, description }

// model: intentionally non-executable
{ id, type: 'model', description: '解释集中风险的传导路径', required: true }
```

If `required` is omitted, normalize it to `true` for every criterion type. An author must explicitly set `required: false` for an advisory check; advisory checks are reported but never enter objective semantic success.

Copy and freeze normalized values. Do not retain unknown fields that could smuggle hidden instructions into later prompts.

- [ ] **Step 4: Upgrade Agent Card validation before freezing**

Extend `validateAgentCard()` without breaking its current callers. Select the declared A2A 0.3 or 1.x shape first, then validate all known fields that are present:

- Card `name`, `description`, optional `version`, input/output MIME arrays, and capability booleans;
- every Skill `id`, `name`, `description`, optional string `tags/examples`, and optional mode arrays;
- every 1.x `supportedInterfaces` entry's URL, protocol binding, protocol version, and optional tenant;
- the 0.3 top-level URL, version, and preferred transport;
- optional provider, security, signatures, and extension containers by type without treating their self-reported contents as verified behavior.

Require at least one interface supported by this platform. Return a normalized selected-interface record and schema version. Unknown extension fields may be preserved in the frozen Card but cannot bypass known-field validation or add score.

Add tests for malformed nested fields, unsupported-only interfaces, mixed valid/invalid interfaces, 0.3 compatibility, 1.x interfaces, and optional fields. Validation must report all structural errors without making a network request.

- [ ] **Step 5: Test canonical freezing and version metadata**

Expect:

```js
const snapshot = freezeSubmission({
  agentCard: card,
  agentExamples: examples,
  validation: validateAgentCard(card),
  config: {
    rubricVersion: 'a2a-black-box-v1',
    hiddenTestPackageVersion: null,
    modelConfigVersion: null,
    runtimeConfigVersion: null
  },
  frozenAt: '2026-07-24T10:00:00.000Z'
});

assert.equal(snapshot.submissionVersion, '1.0');
assert.match(snapshot.agentCard.sha256, /^[a-f0-9]{64}$/);
assert.match(snapshot.agentExamples.sha256, /^[a-f0-9]{64}$/);
assert.equal(snapshot.selectedInterface.binding, 'HTTP+JSON');
assert.equal(Object.hasOwn(snapshot, 'evaluationWindow'), false);
```

The canonical serializer must recursively sort object keys while preserving array order. Hash the canonical UTF-8 bytes and store the canonical object snapshot, not credentials or request headers. Runtime state such as the evaluation window belongs on the V2 evaluation record, never inside the deeply immutable submission.

- [ ] **Step 6: Implement the versioned record**

Use:

```js
export const CONTRACT_VERSIONS = Object.freeze({
  store: '1.0',
  evaluation: '2.0',
  submission: '1.0',
  evidence: '1.0',
  rubric: 'a2a-black-box-v1'
});

export function createEvaluationRecord(snapshot, options) {
  return {
    schemaVersion: 2,
    id: options.id,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
    execution: { status: 'queued', stage: 'qualification', progress: 0 },
    governance: { phase: 'waiting_model' },
    submission: snapshot,
    evaluationWindow: { firstRunAt: null, lastRunAt: null },
    qualification: { status: 'pending', attemptRunIds: [] },
    evidenceManifest: { version: '1.0', items: [] },
    objectiveCapability: { status: 'pending' },
    absoluteReview: { status: 'pending-model-review' },
    replicaArena: { status: 'disabled' },
    resultV2: null,
    revision: 0,
    auditEvents: []
  };
}
```

`evaluationWindow` is mutable top-level runtime state. Public and admin projections allow-list only `firstRunAt` and `lastRunAt`; the Store continues to reject any deep change to `submission`. `migrateStoredEvaluation(raw)` must return legacy array entries as `schemaVersion: 1` without inventing evidence or scores.

- [ ] **Step 7: Run contract/model tests**

```powershell
npm test -- test/submission.test.js test/evaluation-model.test.js test/a2a.test.js
```

Expected: all tests pass.

- [ ] **Step 8: Commit the V2 contract**

```powershell
git add -- schemas/agent-use-examples-v1.schema.json src/submission.js src/evaluation-model.js src/a2a.js test/submission.test.js test/evaluation-model.test.js test/a2a.test.js
git commit -m "feat: define versioned agent example submissions"
```

### Task 3: Add safe projections, revisioned storage, and encrypted evidence

**Files:**
- Add: `src/evidence.js`
- Add: `src/evidence-vault.js`
- Add: `src/evaluation-projection.js`
- Add: `test/evidence.test.js`
- Add: `test/evidence-vault.test.js`
- Add: `test/evaluation-projection.test.js`
- Modify: `src/store.js`
- Modify: `test/store.test.js`
- Modify: `server.js`
- Modify: `test/api.test.js`

**Interfaces:**
- Produces: `createEvidenceRecord(input)`.
- Produces: `createEvidenceManifestItem(record, { summary, visibility, secrets })`.
- Produces: `validateEvidenceManifestItem(item)`.
- Produces: `redactEvidence(value, secrets)`.
- Produces: `EvidenceVault.put(record)` and `EvidenceVault.get(evidenceId, expectedRecordHash)`.
- Produces: `projectEvaluation(evaluation, { audience })`.
- Produces: `EvaluationStore.mutate(id, expectedRevision, updater)`.

- [ ] **Step 1: Write failing redaction and projection tests**

Cover recursive objects, arrays, URL query values, Bearer/JWT strings, Cookie-like fields, email addresses, mainland phone numbers, and explicit per-run secrets:

```js
const redacted = redactEvidence({
  headers: { authorization: 'Bearer aaa.bbb.ccc', cookie: 'sid=secret' },
  url: 'https://agent.example/file?signature=secret',
  message: 'mail a@b.com or call 13800138000',
  nested: { token: 'run-secret' }
}, ['run-secret']);

assert.equal(JSON.stringify(redacted).includes('secret'), false);
assert.match(redacted.message, /\[EMAIL_REDACTED\]/);
assert.match(redacted.message, /\[PHONE_REDACTED\]/);
```

Create a V2 evaluation containing raw evidence, replica data, hidden tests, and authorization-shaped fields. Assert `projectEvaluation(..., { audience: 'public' })` and the SSE event projection contain none of them.

- [ ] **Step 2: Verify evidence tests fail**

```powershell
npm test -- test/evidence.test.js test/evidence-vault.test.js test/evaluation-projection.test.js
```

Expected: module-not-found failures.

- [ ] **Step 3: Implement immutable evidence records**

Use:

```js
export function createEvidenceRecord({
  evidenceId = `ev_${crypto.randomUUID()}`,
  runId,
  grade,
  kind,
  testId,
  turnIndex,
  repeatIndex,
  capturedAt,
  payload
}) {
  if (!['A', 'B', 'C', 'D'].includes(grade)) throw new TypeError('invalid evidence grade');
  const canonicalPayload = canonicalJson(payload);
  const payloadHash = sha256(canonicalPayload);
  const record = {
    evidenceId,
    evidenceVersion: '1.0',
    runId,
    grade,
    kind,
    testId,
    turnIndex,
    repeatIndex,
    capturedAt,
    payloadHash,
    payload
  };
  return deepFreeze({
    ...record,
    recordHash: sha256(canonicalJson({
      evidenceId,
      evidenceVersion: '1.0',
      runId,
      grade,
      kind,
      testId,
      ...(turnIndex === undefined ? {} : { turnIndex }),
      ...(repeatIndex === undefined ? {} : { repeatIndex }),
      capturedAt,
      payloadHash
    }))
  });
}
```

Grade platform timing and transport facts as A, protocol objects as B, Agent-authored output and Card/Agent claims as C, and reviewer inferences as D. Enforce this as a closed kind-to-grade contract. `recordHash` commits the evidence version, all identity and coordinate fields, grade/kind, capture timestamp, and `payloadHash`.

- [ ] **Step 4: Implement AES-256-GCM append-only storage**

`EVIDENCE_ENCRYPTION_KEY` is a base64-encoded 32-byte key and is mandatory whenever V2 is enabled. Store one envelope per evidence ID under `data/evidence/<evaluationId>/<evidenceId>.json.enc` with `flag: 'wx'`.

Envelope:

```js
{
  version: 1,
  algorithm: 'aes-256-gcm',
  iv: iv.toString('base64'),
  tag: cipher.getAuthTag().toString('base64'),
  ciphertext: encrypted.toString('base64'),
  payloadHash,
  recordHash
}
```

Use `evaluationId:evidenceId:recordHash` as authenticated additional data. `put` must fail on duplicate IDs. `get(evidenceId, expectedRecordHash)` requires the independent expected commitment and verifies it against the envelope precheck, AAD, decrypted record, canonical reconstruction, and `payloadHash`.

- [ ] **Step 5: Add a public manifest and allow-list projections**

The evaluation record stores only:

```js
{
  evidenceId,
  runId,
  grade,
  kind,
  testId,
  turnIndex,
  repeatIndex,
  occurredAt,
  summary,
  payloadHash,
  recordHash,
  visibility,
  redaction: { status: 'applied', count }
}
```

Create every item through `createEvidenceManifestItem(record, options)`. It must canonicalize the `EvidenceRecord`, set `occurredAt = capturedAt`, copy both hashes and all record identity/coordinate metadata, defense-redact the summary, and generate the redaction status/count. Coordinates remain required manifest keys and use `null` when absent from the record.

`validateEvidenceManifestItem` is a closed-shape validator. It enforces safe IDs, non-negative integer-or-null coordinates, canonical ISO timestamps, SHA-256 hashes, visibility/redaction enums, the closed kind-to-grade contract, and recomputes the record commitment from manifest metadata. `projectEvaluation` must be an allow-list constructor, not a clone followed by deletions, and must omit invalid items rather than projecting arbitrary fixtures. Before later governance exists, support `public` and `admin`; `public` omits raw payloads, hidden inputs, authorization, replica seals, anonymous mappings, and sensitive logs.

- [ ] **Step 6: Version the store without breaking legacy callers**

Persist:

```json
{
  "schemaVersion": "1.0",
  "items": []
}
```

`load()` accepts both the current bare array and the wrapper. Add:

```js
async mutate(id, expectedRevision, updater) {
  return this.enqueueMutation(async () => {
    const current = structuredClone(this.items.get(id));
    if (!current) return null;
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw Object.assign(new Error('revision conflict'), { statusCode: 409 });
    }
    const next = await updater(current);
    next.revision = (current.revision || 0) + 1;
    next.updatedAt = new Date().toISOString();
    this.items.set(id, next);
    await this.persistUnlocked();
    return structuredClone(next);
  });
}
```

Keep `get()` and `set()` behavior for legacy `schemaVersion: 1`. V2 code must use `mutate()`.

- [ ] **Step 7: Route every V2 read and SSE event through projection**

Modify list, detail, and `streamEvents()` so a V2 item is never serialized directly:

```js
const body = item.schemaVersion === 2
  ? projectEvaluation(item, { audience: 'public' })
  : item;
```

Do this before any raw evidence is connected to the pipeline. A V2 `DELETE` must soft-archive the public view and retain immutable evidence; preserve hard delete only for legacy records.

- [ ] **Step 8: Run storage/security tests**

```powershell
npm test -- test/evidence.test.js test/evidence-vault.test.js test/evaluation-projection.test.js test/store.test.js test/api.test.js
```

Expected: encryption tampering is rejected, revision conflicts return 409, legacy arrays load, and no V2 secret/raw/hidden/replica field appears in GET or SSE output.

- [ ] **Step 9: Commit the evidence boundary**

```powershell
git add -- src/evidence.js src/evidence-vault.js src/evaluation-projection.js src/store.js server.js test/evidence.test.js test/evidence-vault.test.js test/evaluation-projection.test.js test/store.test.js test/api.test.js
git commit -m "feat: store immutable encrypted evaluation evidence"
```

### Task 4: Execute full-fidelity A2A turns and examples

**Files:**
- Add: `src/a2a-executor.js`
- Add: `test/a2a-executor.test.js`
- Modify: `src/a2a.js`
- Modify: `src/safe-http.js`
- Modify: `test/a2a.test.js`
- Modify: `test/safe-http.test.js`
- Modify: `src/agent-diagnostics.js`
- Modify: `test/agent-diagnostics.test.js`
- Modify: `examples/agents/server.js`
- Modify: `test/example-agents.test.js`

**Interfaces:**
- Extends: `buildA2ARequest(target, input, options)`.
- Produces: `executeA2ATurn(options)`.
- Produces: `executeA2AExample(options)`.
- Produces: `normalizeA2AResult(target, rawObjects)`.
- Produces: `snapshotUrlParts(parts, options)`.

- [ ] **Step 1: Write failing multipart and context tests**

Assert V1 and 0.3 serialization of `text`, `data`, `raw`, and `url` parts. Assert:

```js
const request = buildA2ARequest(target, {
  parts: [{ type: 'text', text: 'continue' }]
}, {
  requestId: 'req-2',
  messageId: 'msg-2',
  contextId: 'ctx-1',
  taskId: 'task-1'
});

assert.equal(request.body.message.contextId, 'ctx-1');
assert.equal(request.body.message.taskId, 'task-1');
```

Preserve the existing string-prompt overload so diagnostics and legacy tests continue to work.

- [ ] **Step 2: Add failing transport timing tests**

Extend the safe request fixture to send headers, delay its first chunk, send a second chunk, and end. Assert `onHeaders` fires once and `onChunk` receives monotonic timestamps without changing body limits, DNS pinning, timeout, redirect, or abort behavior.

- [ ] **Step 3: Add safe timing hooks**

Extend `safeHttpRequest()` options:

```js
{
  onHeaders({ status, headers, at }),
  onChunk({ bytes, at, first })
}
```

Invoke hooks synchronously from the pinned request callback/data handler. A hook exception aborts the request and is categorized as a platform instrumentation error. Do not pass request headers or socket details to hooks.

- [ ] **Step 4: Implement one-turn execution**

Implement `executeA2ATurn(options)` against this complete call shape:

```js
const run = await executeA2ATurn({
  card,
  input,
  contextId,
  taskId,
  streaming = false,
  timeoutMs,
  authorization,
  testId,
  turnIndex,
  repeatIndex,
  signal,
  request = safeHttpRequest,
  clock = () => Date.now()
});
```

Return:

```js
{
  runId,
  testId,
  turnIndex,
  repeatIndex,
  protocol: { binding, version, endpointHash },
  request: { requestId, messageId, body, bodyHash },
  response: {
    httpStatus, mediaType, byteLength, rawObjects, rawHash,
    normalized: {
      responseKind, terminal, terminalState, taskId, contextId,
      statusSequence, messages, history, artifacts, parts, text
    }
  },
  timing: {
    startedAt, headersAt, firstByteAt, firstEventAt, endedAt,
    firstByteMs, firstEventMs, durationMs
  },
  outcome: { status: 'succeeded' | 'agent-error' | 'platform-error' | 'unknown' },
  error: null
}
```

Authorization may be added to the actual request but must be deleted before request evidence is built.

- [ ] **Step 5: Handle Task and streaming lifecycles**

For blocking `SendMessage`, accept direct Message or terminal/interrupted Task. If a non-terminal Task is returned, poll `GetTask` with history length 50 at locked intervals `250, 500, 1000, 2000` ms and then every `2000` ms until the same wall-clock timeout.

For streaming, parse SSE frames incrementally so `firstEventAt` reflects arrival, not post-buffer parsing. Require a Message-only terminal stream or a Task terminal state. Save every stream object and status transition.

Add `buildGetTaskRequest(target, { taskId, requestId, historyLength })` with JSON-RPC `GetTask` and HTTP+JSON `GET /tasks/{id}` mappings. Preserve A2A 0.3 method names where required by the existing compatibility fixtures.

- [ ] **Step 6: Execute multi-turn examples with correct context isolation**

Implement:

```js
export async function executeA2AExample({
  card,
  example,
  repeatIndex,
  policy,
  authorization,
  signal,
  executeTurn = executeA2ATurn
}) {
  // fresh context per repeat; reuse returned contextId/taskId only inside the example
}
```

Do not synthesize a returned `contextId`. If the Agent omits it, record the context check as unavailable rather than treating `messageId` as context. Fix the example Agent fixture so it returns and consumes actual context IDs.

- [ ] **Step 7: Snapshot directly returned URL parts once**

`snapshotUrlParts()` may fetch only URLs present in the normalized response Parts. Use the existing SSRF-safe client, no redirects, a 10-second timeout, and a 1 MiB cap. Persist encrypted bytes, MIME, size, SHA-256, and a query-redacted source URL. Never follow links contained in the fetched body.

- [ ] **Step 8: Keep the legacy wrapper**

Refactor:

```js
export async function callA2AAgent(card, prompt, timeoutMs, signal) {
  const run = await executeA2ATurn({
    card,
    input: { parts: [{ type: 'text', text: String(prompt) }] },
    timeoutMs,
    signal
  });
  if (run.outcome.status !== 'succeeded') throw new Error(run.error.message);
  return {
    raw: run.response.rawObjects.at(-1),
    text: run.response.normalized.text,
    run
  };
}
```

`extractAgentText()` must return an empty string when no textual/data deliverable exists; it must not stringify the whole protocol object and accidentally imply task success.

- [ ] **Step 9: Run protocol and fixture tests**

```powershell
npm test -- test/a2a.test.js test/a2a-executor.test.js test/safe-http.test.js test/agent-diagnostics.test.js test/example-agents.test.js
```

Expected: multipart requests, polling, SSE timing, Task status history, context reuse/isolation, URL snapshot limits, and all legacy A2A tests pass.

- [ ] **Step 10: Commit the full-fidelity executor**

```powershell
git add -- src/a2a.js src/a2a-executor.js src/safe-http.js src/agent-diagnostics.js examples/agents/server.js test/a2a.test.js test/a2a-executor.test.js test/safe-http.test.js test/agent-diagnostics.test.js test/example-agents.test.js
git commit -m "feat: capture complete a2a execution evidence"
```

### Task 5: Evaluate executable criteria and objective capability

**Files:**
- Modify: `package.json`
- Add: `package-lock.json`
- Add: `src/acceptance.js`
- Add: `src/objective-scoring.js`
- Add: `src/confidence.js`
- Add: `src/rubric.js`
- Add: `test/acceptance.test.js`
- Add: `test/objective-scoring.test.js`
- Add: `test/confidence.test.js`

**Interfaces:**
- Produces: `evaluateAcceptance(criteria, normalizedOutput)`.
- Produces: `buildObjectiveMetrics(input)`.
- Produces: `aggregateObjectiveCapability(metrics, rubric)`.
- Produces: `computeSubcriterionConfidence(input)`.
- Produces: `computeDimensionConfidence(items)`.
- Produces: `computeTotalConfidence(dimensions)`.

- [ ] **Step 1: Install the pinned JSON Schema validator**

Run:

```powershell
npm install --save-exact ajv@8.17.1
```

Expected: `package.json` and `package-lock.json` record exactly `8.17.1`.

- [ ] **Step 2: Write failing acceptance tests**

Cover all five criterion types. Assert that `model` is non-executable:

```js
const result = evaluateAcceptance(
  [{ id: 'quality', type: 'model', required: true, description: '专业解释' }],
  { text: 'done', data: null, artifacts: [] }
);

assert.equal(result.requiredExecutable, 0);
assert.equal(result.semanticSuccess, null);
assert.equal(result.checks[0].status, 'not-executable');
```

Assert all required executable checks must pass for `semanticSuccess === true`; protocol terminal status alone must not change it.

- [ ] **Step 3: Implement deterministic criteria**

- `contains`: Unicode-normalized, case-sensitive unless `caseSensitive: false`, all expected tokens required.
- `exact`: compare the normalized output text after CRLF normalization and trailing-space removal.
- `json-schema`: validate `normalizedOutput.data` first, then the first JSON Artifact; do not parse arbitrary prose as JSON.
- `numeric`: resolve the declared dot path from normalized data/Artifact JSON and pass when `abs(actual - expected) <= tolerance`.
- `model`: return `not-executable`; it is evaluated only by the later model panel.

- [ ] **Step 4: Lock rubric constants**

Export:

```js
export const RUBRIC_V1 = Object.freeze({
  version: 'a2a-black-box-v1',
  dimensions: {
    scenarioValue: {
      agentNecessity: 30,
      researchDecisionValue: 30,
      utilityReuse: 25,
      productNovelty: 15
    },
    professionalism: {
      taskCompletion: 25,
      methodAssumptions: 25,
      evidenceReasoning: 25,
      riskUncertainty: 15,
      artifactUsability: 10
    },
    agentCapability: {
      testSuccess: 30,
      robustness: 20,
      contextContinuity: 15,
      a2aCompliance: 15,
      efficiency: 10,
      claimErrorHandling: 10
    }
  },
  seatWeights: {
    scenarioValue: { model: 0.4, human: 0.6 },
    professionalism: { model: 0.4, human: 0.6 },
    agentCapability: { objective: 0.5, model: 0.2, human: 0.3 }
  }
});
```

- [ ] **Step 5: Write failing objective-score tests**

Cover:

- weighted pass rate for required executable criteria;
- terminal-only runs returning `testSuccess.applicable === false`;
- repeat terminal consistency and schema/criterion consistency split 50/50;
- context retention, correction, and isolation checks;
- A2A Card/binding/object/status/Part/Artifact checks;
- efficiency at `duration <= T`, halfway between T and B, at B, and timeout;
- streaming efficiency as `0.3 * firstEvent + 0.7 * completion`;
- claim checks only when applicable plus always-applicable error handling;
- `N/A` weight redistribution and original-weight coverage.

- [ ] **Step 6: Implement the six objective metrics**

Each metric returns:

```js
{
  id,
  weight,
  applicable,
  coverage,
  score,
  numerator,
  denominator,
  evidenceIds,
  gaps
}
```

Efficiency per run:

```js
export function durationScore(durationMs, targetMs, timeoutMs) {
  if (durationMs <= targetMs) return 100;
  if (durationMs >= timeoutMs) return 0;
  return 100 * (timeoutMs - durationMs) / (timeoutMs - targetMs);
}
```

Aggregate:

```js
const applicableWeight = metrics
  .filter((item) => item.applicable)
  .reduce((sum, item) => sum + item.weight, 0);

const score = metrics
  .filter((item) => item.applicable)
  .reduce((sum, item) => sum + item.score * item.weight, 0) / applicableWeight;

const coverage = metrics.reduce(
  (sum, item) => sum + item.weight * item.coverage,
  0
) / 100;
```

Set `provisional: coverage < 0.70`.

- [ ] **Step 7: Implement exact confidence math**

Use evidence values `A=1`, `B=.8`, `C=.35`, `D=.1`, none `0`. Define quartiles with linear interpolation at `(n - 1) * p`.

```js
E = mean(highestEvidenceLevelPerCheck);
Am = 1 - Math.min(1, iqr(modelScores) / 30);
Ah = 1 - Math.min(1, range(humanScores) / 30);
A = stage === 'model' ? Am : 0.6 * Am + 0.4 * Ah;
R = median(modelConfidences);
Csub = 0.5 * E + 0.3 * A + 0.2 * R;
```

Dimension confidence is the applicable rubric-weighted mean. Total confidence is:

```js
Math.cbrt(sceneConfidence * professionalismConfidence * capabilityConfidence)
```

If no model scores exist in Phase 1, return `{ status: 'pending-model-review', value: null }`; do not substitute coverage for confidence.

- [ ] **Step 8: Run scoring tests**

```powershell
npm test -- test/acceptance.test.js test/objective-scoring.test.js test/confidence.test.js
```

Expected: all deterministic formula and N/A tests pass.

- [ ] **Step 9: Commit the scoring foundation**

```powershell
git add -- package.json package-lock.json src/acceptance.js src/objective-scoring.js src/confidence.js src/rubric.js test/acceptance.test.js test/objective-scoring.test.js test/confidence.test.js
git commit -m "feat: calculate objective capability and confidence"
```

### Task 6: Run the V2 foundation behind a feature flag

**Files:**
- Add: `src/credential-vault.js`
- Add: `src/participant-access.js`
- Add: `src/black-box-pipeline.js`
- Add: `test/participant-access.test.js`
- Add: `test/black-box-pipeline.test.js`
- Modify: `src/pipeline.js`
- Modify: `server.js`
- Modify: `.env.example`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `test/pipeline-control.test.js`
- Modify: `test/api.test.js`
- Modify: `README.md`

**Interfaces:**
- Produces: `EphemeralCredentialVault.put/get/delete`.
- Produces: `createParticipantAccess()` and `verifyParticipantAccess(token, storedHash)`.
- Produces: `runBlackBoxFoundation(evaluation, services)`.
- Consumes: `createEvidenceManifestItem(record, options)` and `EvidenceVault.get(evidenceId, expectedRecordHash)`.
- Routes: V2 `POST /api/evaluations` only when the flag is enabled.

- [ ] **Step 1: Write failing flag and credential tests**

Assert:

- V2 returns 404 or 409 with a clear disabled message while the flag is false.
- V2 rejects `cases`, accepts `agentExamples`, and legacy continues to accept `cases`.
- an `agentAuthorization` sentinel appears in the outgoing request but never in the evaluation store, evidence manifest, GET response, SSE event, log, or thrown error;
- a missing/invalid `EVIDENCE_ENCRYPTION_KEY` prevents V2 startup rather than falling back to plaintext;
- a Card failure or three failed qualification attempts produces `qualification.status = 'ineligible'`, no score, and no rating.
- a parseable protocol-valid Task with terminal state `FAILED` produces `qualification.status = 'eligible'`; the same state in a formal repetition lowers Agent performance.
- V2 creation returns a participant access token once, persists only its hash, and an interrupted evaluation resumes only with that token plus newly supplied Agent authorization.

- [ ] **Step 2: Verify integration tests fail**

```powershell
npm test -- test/participant-access.test.js test/black-box-pipeline.test.js test/pipeline-control.test.js test/api.test.js
```

Expected: the V2 route and pipeline do not exist.

- [ ] **Step 3: Keep credentials memory-only**

Implement an in-process vault keyed by evaluation ID. It stores only for the lifetime of an active run and zeroes/deletes the value in `finally`. V2 recovery after process restart marks execution interrupted and requires a newly authorized resume; it never serializes a credential.

- [ ] **Step 4: Add participant-authenticated resume**

At V2 creation, generate a 32-byte base64url `participantAccessToken`, return it only in the 202 response, and persist only its SHA-256 hash. Add:

```text
POST /api/evaluations/:id/resume
Authorization: Bearer <participantAccessToken>
Idempotency-Key: <unique value>
```

The body may contain only fresh connection authorization. Accept resume only from `interrupted` or `credentials-required`, verify all frozen hashes/config versions, place the connection secret in `EphemeralCredentialVault`, and execute only missing planned cells. Completed cells—including scored Agent-error cells—cannot be rerun or selected against. A replayed idempotency key returns the original resume response.

- [ ] **Step 5: Implement qualification**

Use the first example's first turn as the disclosed standard preflight input. Attempt once, then at most two retries after 250 ms and 1000 ms. Each attempt is a separate immutable run. Qualification evidence does not enter scored repetitions.

Set:

```js
qualification = {
  status: 'eligible' | 'ineligible',
  reason,
  attemptRunIds,
  selectedInterface,
  completedAt
};
```

Card schema failure, unsupported interface, or three attempts without any version-valid, parseable A2A Message/Task response is ineligible. A legal A2A Task whose terminal state is `FAILED`, `REJECTED`, `INPUT_REQUIRED`, or another protocol-valid non-success state still proves callability and therefore passes connection qualification; that behavior is scored only in the formal planned repetitions. HTTP/auth/transport failure, malformed protocol objects, or no parseable A2A response may consume the two qualification retries. Later formal timeouts and Task failures remain Agent performance.

- [ ] **Step 6: Execute public examples three times**

For every normalized example:

- create a fresh context for each repeat;
- reuse returned `contextId`/`taskId` only for turns in that example;
- lock per-test target `T` and timeout `B` before execution;
- evaluate required executable criteria after each turn;
- append each canonical record to the encrypted Vault, then append its redacted manifest item only through `createEvidenceManifestItem(record, options)`;
- when reading evidence, pass the independently projected `manifestItem.recordHash` to `EvidenceVault.get(manifestItem.evidenceId, manifestItem.recordHash)`;
- set top-level `evaluation.evaluationWindow.firstRunAt` and `lastRunAt`; never mutate `evaluation.submission`. Record endpoint hash, Agent version/build ID when returned, and response fingerprints in their dedicated top-level runtime state.

Use `repeatCount: 3`. Hidden variants are intentionally absent in this phase.

- [ ] **Step 7: Calculate the Phase 1 result state**

After execution:

```js
execution.status = 'completed';
governance.phase = 'waiting_model';
objectiveCapability = aggregateObjectiveCapability(objectiveMetrics, RUBRIC_V1);
absoluteReview = {
  status: 'pending-model-review',
  confidence: { status: 'pending-model-review', value: null }
};
replicaArena = { status: 'disabled' };
resultV2 = {
  absolute: { status: 'pending-model-review' },
  replica: { status: 'disabled' },
  rating: { status: 'pending-model-and-human', code: null, label: null }
};
```

Do not call legacy `scoreComplexity`, `judgeOutput`, or `buildRoast`.

- [ ] **Step 8: Add the feature-flag router**

Set:

```text
A2A_BLACK_BOX_V1_ENABLED=false
EVIDENCE_ENCRYPTION_KEY=
EVIDENCE_ROOT=data/evidence
```

`EvaluationPipeline.create()` routes `schemaVersion === 2` to the black-box service only when enabled; otherwise it preserves the exact current path. V2 cancel/recovery appends audit events. Disable legacy single-step overwrite retries for V2 with a 409 response.

- [ ] **Step 9: Update the submission labels without removing legacy form support**

When V2 is enabled, show:

- “A2A Agent Card”
- “Agent 使用示例”
- repeatable example/turn/part inputs
- optional deliverable, criteria, and constraints

Do not display `skillId` or “Skill 使用示例”. Keep the current simple case editor behind the legacy flag until the later result/reviewer UI plan completes.

- [ ] **Step 10: Run focused integration tests**

```powershell
npm test -- test/participant-access.test.js test/black-box-pipeline.test.js test/pipeline-control.test.js test/api.test.js test/example-agents.test.js
npm run check
```

Expected: V2 produces qualification, three public-example repetitions, immutable evidence, objective coverage, and pending review; legacy evaluations remain unchanged.

- [ ] **Step 11: Commit the shadow pipeline**

```powershell
git add -- src/credential-vault.js src/participant-access.js src/black-box-pipeline.js src/pipeline.js server.js .env.example public/index.html public/app.js README.md test/participant-access.test.js test/black-box-pipeline.test.js test/pipeline-control.test.js test/api.test.js
git commit -m "feat: run black-box evidence pipeline in shadow mode"
```

### Task 7: Verify Phase 1 end to end

**Files:**
- Verify all Phase 1 files.

**Interfaces:**
- Produces: a backward-compatible, encrypted, evidence-complete V2 shadow path.

- [ ] **Step 1: Run the complete root suite**

```powershell
npm test
```

Expected: all root tests pass; no `.worktrees` test is executed.

- [ ] **Step 2: Run syntax and patch checks**

```powershell
npm run check
git diff --check
git status --short
```

Expected: syntax passes, no whitespace errors, and only intentional uncommitted changes remain.

- [ ] **Step 3: Execute a local live V2 fixture**

Start `examples/agents/server.js`, submit one multipart two-turn example with a contains criterion, and verify:

- qualification succeeds;
- exactly three scored example repetitions exist;
- turns within a repetition share the Agent-returned context;
- other repetitions use distinct contexts;
- raw evidence decrypts through `EvidenceVault`;
- GET/SSE exposes only manifest projections;
- objective success is `N/A` for a second example containing only `model` criteria.

- [ ] **Step 4: Scan for prohibited leaks and terminology**

Run:

```powershell
rg -n "agentAuthorization|authorization|cookie|EVIDENCE_ENCRYPTION_KEY" data public
rg -n "Skill 使用示例|skillId" public src schemas
```

Expected: no credential value or prohibited V2 example label is present. Legitimate implementation field names may appear in source, but not generated public data.

- [ ] **Step 5: Record the phase gate**

If verification requires a fix, return to the owning task, stage only the exact files listed in that task's **Files** block, rerun that task's focused verification, and commit with `fix: close evidence foundation verification gaps`. Never use a repository-wide staging command.

Phase 1 is complete only when the feature flag can be disabled for exact legacy behavior and enabled for evidence-complete V2 shadow results.
