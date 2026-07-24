# Human Review, Governance, and Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-blind human review after model review, server-side score locking and confidence aggregation, evidence replay, post-lock humorous commentary, Replica reveal, role-safe final results, and append-only appeals.

**Architecture:** Separate execution state from governance state. Authenticated judges receive redacted Card/examples, full submitted-Agent evidence, objective metrics, and model opinions, but no Replica information before lock. Two judges score every applicable leaf; a greater-than-15-point spread creates third-judge arbitration for those leaves. The server combines model, human, and objective seats, locks an immutable absolute result hash, then releases the sealed arena and computes the rating. Appeals create new versions and replacement runs only for confirmed platform faults.

**Tech Stack:** Node.js 20 ESM, native HTTP/SSE, native `node:test`, Phase 1 revisioned store/evidence vault, Phase 2 model panel, Phase 3 arena/rating, vanilla accessible HTML/CSS/JavaScript.

## Global Constraints

- Human review is intentionally not blind: judges see model scores, reasons, disagreements, objective metrics, and submitted-Agent evidence.
- Human judges never see Replica artifacts, outputs, Runtime identities, arena scores, or advantage before the absolute score is locked.
- Judge identity comes from a server-verified token. Never trust a client-supplied `judgeId`, role, total, weight, applicability, or aggregate.
- Two distinct primary judges must submit every applicable leaf. A leaf spread greater than 15 creates a third distinct arbitrator assignment for that leaf.
- Submitted human reviews are immutable. Drafts use optimistic revision checks.
- Human overturns of a model conclusion require a rationale and valid evidence IDs.
- All weights, medians, dimension totals, confidence, absolute total, advantage, and rating are calculated server-side.
- Humor is generated only after the structured absolute result is locked and can neither add facts nor change scores.
- Public, participant, judge, and admin views are server-built allow-list projections; hiding a field only in JavaScript is insufficient.
- Appeals target a concrete test, evidence item, or scoring path. Original results and runs remain immutable.
- Only confirmed platform failures may create one same-config replacement run. Agent failures and Replica Skill failures cannot be rerun to select a higher score.

---

### Task 1: Add role authentication and leak-proof projections

**Files:**
- Add: `src/review-access.js`
- Add: `src/access-audit-store.js`
- Add: `test/review-access.test.js`
- Add: `test/access-audit-store.test.js`
- Modify: `src/evaluation-projection.js`
- Modify: `test/evaluation-projection.test.js`
- Modify: `server.js`
- Modify: `test/api.test.js`
- Modify: `.env.example`

**Interfaces:**
- Produces: `authenticatePrincipal(request, evaluation, env)`.
- Produces: `requireRole(principal, roles)`.
- Produces: `AccessAuditStore.append(event)` without changing evaluation/assignment revisions.
- Extends: `projectEvaluation(evaluation, { audience, principal })`.

- [ ] **Step 1: Write failing identity tests**

Configure:

```js
const principals = [{
  principalId: 'judge-1',
  displayName: '评委一',
  role: 'judge',
  tokenSha256: sha256('judge-secret')
}, {
  principalId: 'admin-1',
  displayName: '管理员',
  role: 'admin',
  tokenSha256: sha256('admin-secret')
}];
```

Assert missing/invalid tokens return 401, a judge calling an admin route returns 403, and a request body containing `{ judgeId: 'judge-2' }` cannot change the authenticated identity.

- [ ] **Step 2: Write failing projection tests for every role**

Before absolute lock:

- public: released submission/result summary only;
- participant: own submission, execution status, redacted evidence manifest, appeal state;
- judge: Card, Agent examples, test type/content, submitted-Agent redacted evidence, objective metrics, four/fifth model reviews;
- admin: governance/audit/config metadata and redacted evidence access.

All four must omit raw secrets. Public/participant/judge must omit sealed Replica artifacts, Runtime names, outputs, score cube, reveal maps, delta, and Replica logs.

- [ ] **Step 3: Verify access/projection tests fail**

```powershell
npm test -- test/review-access.test.js test/evaluation-projection.test.js test/api.test.js
```

Expected: role authentication and four audience projections are absent.

- [ ] **Step 4: Implement constant-time token verification**

Read only token hashes from:

```text
REVIEW_PRINCIPALS_JSON=[]
REVIEW_GOVERNANCE_ENABLED=false
```

Hash the submitted Bearer token with SHA-256 and compare fixed-length buffers using `crypto.timingSafeEqual`. Never put literal judge/admin tokens in configuration. Participant access uses the per-evaluation token hash generated at V2 creation.

- [ ] **Step 5: Reuse and generalize Phase 1 participant access**

Use Phase 1's one-time base64url participant token and stored SHA-256 hash. `review-access.js` must authenticate the same token for resume, private evidence, and appeal routes without generating a second credential. Never send it through SSE, history, logs, or GET.

The existing public result remains readable through the public projection.

- [ ] **Step 6: Extend projections using positive field lists**

Do not pass a full evaluation into a serializer and delete fields afterward. Build each role response explicitly. Add a recursive assertion used in tests:

```js
assertNoReplicaLeak(projectedJudgeView);
assertNoSecretShape(projectedView);
```

After `absolute_locked`, judge/admin/public release policy may include the Phase 3 released arena summary, but never the encrypted reveal map or credentials.

- [ ] **Step 7: Project all API and SSE responses**

Apply role resolution and projection to:

- evaluation list/detail;
- evaluation SSE;
- review assignment endpoints;
- evidence manifest/item endpoints;
- result endpoint;
- appeal endpoints.

No route may call `JSON.stringify(evaluation)` directly for V2.

- [ ] **Step 8: Keep read-access auditing independent from review revisions**

Store evidence-view events in an append-only hash-chained access log such as `data/access-audit/2026-07-24.ndjson`. Each event contains principal ID, evaluation ID, evidence ID, role, time, and previous/event hash, but no evidence content. Appending this log must not call `EvaluationStore.mutate()` or increment evaluation/assignment revisions.

- [ ] **Step 9: Run and commit the access boundary**

```powershell
npm test -- test/review-access.test.js test/access-audit-store.test.js test/evaluation-projection.test.js test/api.test.js
git add -- src/review-access.js src/access-audit-store.js src/evaluation-projection.js server.js .env.example test/review-access.test.js test/access-audit-store.test.js test/evaluation-projection.test.js test/api.test.js
git commit -m "feat: enforce role-safe evaluation projections"
```

### Task 2: Implement assignments, drafts, submissions, and third-judge arbitration

**Files:**
- Add: `src/review-governance.js`
- Add: `test/review-governance.test.js`
- Modify: `src/evaluation-model.js`
- Modify: `src/store.js`
- Modify: `test/store.test.js`
- Modify: `server.js`
- Modify: `test/api.test.js`

**Interfaces:**
- Produces: `assignHumanReviewer(evaluation, principal, role, scope)`.
- Produces: `saveHumanDraft(evaluation, assignment, payload, expectedRevision)`.
- Produces: `submitHumanReview(evaluation, assignment, payload)`.
- Produces: `aggregateHumanReviews(evaluation)`.
- Produces: `advanceGovernance(evaluation)`.

- [ ] **Step 1: Lock the governance state machine in tests**

Valid phases:

```text
waiting_model
→ human_open
→ human_arbitration
→ absolute_locked
→ replica_released
→ final
```

Execution remains separate:

```text
queued | running | completed | failed | cancelled | interrupted
```

Reject opening human review before four valid primary model reviews and all required fifth-model decisions complete.

- [ ] **Step 2: Define assignment and review records**

Use:

```js
{
  assignmentId,
  evaluationId,
  judgeId,
  role: 'primary' | 'arbitrator',
  criterionScope: ['scenarioValue.agentNecessity'],
  status: 'assigned' | 'draft' | 'submitted' | 'recused',
  assignedAt,
  submittedAt,
  revision
}
```

and:

```js
{
  reviewId,
  assignmentId,
  judgeId,
  role,
  status: 'draft' | 'submitted',
  rubricVersion: 'a2a-black-box-v1',
  scores: {
    'scenarioValue.agentNecessity': {
      score: 74,
      evidenceIds: ['ev_1'],
      checkEvidence: [{
        checkId: 'portfolio-risk:agent-necessity',
        evidenceIds: ['ev_1']
      }],
      rationale: '该任务需要跨轮澄清并形成可复用风险产物。',
      modelDisposition: 'modify',
      overrideReason: ''
    }
  },
  submittedAt,
  payloadHash
}
```

Primary assignments include every applicable fixed leaf. Arbitrators include only disputed leaves.

- [ ] **Step 3: Write failing validation tests**

Reject:

- missing/extra applicable leaves;
- scores outside 0–100;
- evidence IDs outside the judge-visible manifest;
- evidence from another evaluation;
- a missing/extra `checkEvidence` entry for any applicable compiled check under the scored leaf;
- empty rationale;
- client-supplied weights/totals/applicability;
- an `overturn` disposition without evidence and `overrideReason`;
- a duplicate submitted review;
- the same judge as both primary and arbitrator;
- two primary assignments to the same judge.

- [ ] **Step 4: Add assignment-scoped revision-safe drafts**

Return `ETag: W/"assignment:<assignmentId>:<assignmentRevision>"` from assignment detail. Require `If-Match` for draft updates. Call Phase 1 `store.mutate(evaluationId, undefined, updater)` for serialization, then compare the parsed value to that assignment's own revision inside `updater` and increment only the assignment/draft revision. Do not pass the evaluation revision as the draft precondition. An unrelated evaluation audit event or evidence read cannot stale this ETag. A genuinely stale draft returns 409 and does not silently overwrite another browser/session update.

Submitted reviews are immutable; later changes require an appeal/result version, not draft mutation.

- [ ] **Step 5: Aggregate two primary judges**

For each applicable leaf:

```js
const values = primaryReviews.map((review) => review.scores[criterionId].score);
const spread = Math.max(...values) - Math.min(...values);
```

- if `spread <= 15`, human leaf score is the two-value median;
- if `spread > 15`, create an arbitration requirement and move to `human_arbitration`;
- after one distinct arbitrator submits, use the three-value median.

Do not average reviewer totals.

- [ ] **Step 6: Add tamper-evident audit events**

Every assignment, draft, submit, recusal, arbitration trigger, and phase transition appends:

```js
{
  eventId,
  type,
  actorId,
  at,
  payloadHash,
  previousEventHash,
  eventHash
}
```

Hash canonical event content plus `previousEventHash`. Audit events never store credentials or full review text.

- [ ] **Step 7: Add review APIs**

Implement:

```text
GET  /api/review-assignments
GET  /api/review-assignments/:evaluationId
PUT  /api/review-assignments/:evaluationId/draft
POST /api/review-assignments/:evaluationId/submit
POST /api/review-assignments/:evaluationId/recuse
POST /api/admin/evaluations/:id/review-assignments
```

Use 401/403 for identity/role errors, 409 for revision/phase conflicts, and 422 for invalid scores/evidence. Require `Idempotency-Key` on assignment and submit POSTs and return the original response on safe replay.

- [ ] **Step 8: Run and commit governance tests**

```powershell
npm test -- test/review-governance.test.js test/store.test.js test/api.test.js
git add -- src/review-governance.js src/evaluation-model.js src/store.js server.js test/review-governance.test.js test/store.test.js test/api.test.js
git commit -m "feat: orchestrate human review and arbitration"
```

### Task 3: Calculate and immutably lock the absolute result

**Files:**
- Add: `src/result-v2.js`
- Add: `test/result-v2.test.js`
- Modify: `src/confidence.js`
- Modify: `test/confidence.test.js`
- Modify: `src/review-governance.js`
- Modify: `src/arena-release.js`
- Modify: `test/pipeline-replica-arena.test.js`

**Interfaces:**
- Produces: `calculateAbsoluteResult(evaluation, rubric)`.
- Produces: `lockAbsoluteResult(evaluation, result, actor)`.
- Invokes: `releaseReplicaArena()` only after lock.

- [ ] **Step 1: Write failing seat-weight tests**

Use known seat values:

```js
assert.equal(
  combineScenarioOrProfessional({ model: 70, human: 80 }),
  76
);
assert.equal(
  combineCapability({ objective: 90, model: 70, human: 80 }),
  83
);
```

because:

```text
70 × .4 + 80 × .6 = 76
90 × .5 + 70 × .2 + 80 × .3 = 83
```

Assert the absolute total is the equal-third mean of the three dimensions.

- [ ] **Step 2: Aggregate seats at the correct level**

For scenario value and professionalism:

1. take the model median per leaf;
2. take the human median per leaf;
3. apply the fixed leaf weights to form model/human dimension seats;
4. combine dimension seats 40/60.

For Agent capability:

1. aggregate the six objective metrics with applicable-weight redistribution;
2. independently aggregate model leaves with 30/20/15/15/10/10;
3. independently aggregate human leaves with the same weights;
4. combine objective/model/human dimension seats 50/20/30.

- [ ] **Step 3: Calculate final confidence**

For each applicable leaf use Phase 1:

```text
E  = mean(highest evidence grade per rubric check)
Am = 1 - min(1, model IQR / 30)
Ah = 1 - min(1, human range / 30)
A  = .6 Am + .4 Ah
R  = median model confidence
Csub = .5 E + .3 A + .2 R
```

Build `E` deterministically per compiled `checkId`: union that check's evidence IDs from the normalized primary/fifth model `checkEvidence`, every submitted human review's `checkEvidence`, and objective-check evidence generated by the platform; select the highest A/B/C/D grade in that union, or zero when empty. Then average those per-check maxima inside the leaf. Do not infer evidence strength from a leaf-level free-text rationale.

Dimension confidence is the fixed applicable leaf-weighted mean. Total confidence is the geometric mean. Return explicit evidence gaps and low-confidence leaves.

- [ ] **Step 4: Build the immutable absolute result**

Return:

```js
{
  status: 'locked',
  rubricVersion: 'a2a-black-box-v1',
  dimensions: {
    scenarioValue: { score, confidence, leaves, seats },
    professionalism: { score, confidence, leaves, seats },
    agentCapability: {
      score, confidence, leaves, seats,
      objectiveCoverage,
      provisional: objectiveCoverage < 0.70
    }
  },
  total,
  confidence,
  evidenceGaps,
  lockedAt,
  resultHash
}
```

No Replica field may be an input to this function.

- [ ] **Step 5: Enforce one-way locking**

`lockAbsoluteResult()` requires:

- model seat locked;
- two complete primary reviews;
- every spread-greater-than-15 leaf arbitrated;
- current rubric/config hashes unchanged;
- no existing `absoluteLockedAt`.

Append a lock audit event and set `governance.phase = 'absolute_locked'`. A repeated lock with the same idempotency key returns the same result; any different payload returns 409.

- [ ] **Step 6: Release the sealed arena after the lock**

Only after the store persists the absolute result hash, invoke Phase 3 `releaseReplicaArena()`. Then transition:

```text
absolute_locked → replica_released → final
```

or:

```text
absolute_locked → final
```

with rating “待复刻” when no valid Replica exists.

- [ ] **Step 7: Run and commit result tests**

```powershell
npm test -- test/result-v2.test.js test/confidence.test.js test/review-governance.test.js test/pipeline-replica-arena.test.js
git add -- src/result-v2.js src/confidence.js src/review-governance.js src/arena-release.js test/result-v2.test.js test/confidence.test.js test/pipeline-replica-arena.test.js
git commit -m "feat: lock human weighted absolute results"
```

### Task 4: Generate guarded humor after score lock

**Files:**
- Add: `src/humor.js`
- Add: `test/humor.test.js`
- Modify: `src/prompts.js`
- Modify: `test/prompts.test.js`
- Modify: `src/providers.js`
- Modify: `src/result-v2.js`

**Interfaces:**
- Produces: `humorRewritePrompt(lockedFindings)`.
- Produces: `generateLockedHumor(evaluation, services)`.
- Produces: `validateHumorItems(items, lockedFindings)`.

- [ ] **Step 1: Write failing post-lock tests**

Assert humor generation refuses:

- an unlocked result;
- an unknown subcriterion/finding ID;
- a line containing a new number, company/instrument name, tool, model, or factual claim absent from source findings;
- any response containing a score or proposed score change;
- more or fewer than one line per applicable leaf.

- [ ] **Step 2: Build a rewrite-only prompt**

Input contains only:

```js
{
  subcriterionId,
  sourceFindings: [{ findingId, text }],
  repairSuggestion
}
```

It contains no raw evidence, Replica output, model score, human score, or total. Require:

```js
{
  items: [{
    subcriterionId,
    findingIds,
    line
  }]
}
```

Each line must be concise, non-abusive, and rewrite—not extend—the cited finding.

- [ ] **Step 3: Validate and provide a deterministic fallback**

Reject unknown proper nouns/numerals and known internal-capability claims not present in sources. On model failure or guard rejection, derive a neutral line from the source finding, for example:

```js
`${shortFinding}——有思路，但证据还没把工牌戴好。`
```

The fallback must not introduce a domain fact.

- [ ] **Step 4: Preserve serious explanations**

Save humor separately:

```js
{
  generatedAt,
  modelIdentity,
  sourceResultHash,
  items: [{ subcriterionId, findingIds, line }]
}
```

Never replace model/human findings, evidence citations, uncertainty, or repair suggestions.

- [ ] **Step 5: Run and commit humor tests**

```powershell
npm test -- test/humor.test.js test/prompts.test.js test/result-v2.test.js
git add -- src/humor.js src/prompts.js src/providers.js src/result-v2.js test/humor.test.js test/prompts.test.js test/result-v2.test.js
git commit -m "feat: add post-lock evidence-grounded humor"
```

### Task 5: Build the non-blind judge workbench

**Required during execution:** invoke `frontend-design:frontend-design` before editing the workbench UI.

**Files:**
- Add: `public/judge.html`
- Add: `public/judge.js`
- Add: `public/judge.css`
- Add: `test/judge-ui.test.js`
- Modify: `server.js`
- Modify: `public/index.html`

**Interfaces:**
- Consumes: authenticated assignment/evidence/model-review APIs.
- Produces: three-column evidence-led human review, server-saved drafts, and immutable submission.

- [ ] **Step 1: Write failing static UI tests**

Require IDs for:

```js
[
  'judge-access-form',
  'assignment-list',
  'submission-panel',
  'test-filter',
  'evidence-timeline',
  'model-opinions',
  'disagreement-summary',
  'human-score-form',
  'draft-status',
  'submit-review',
  'recuse-review',
  'replica-seal-notice'
]
```

Assert the page says model review happens first, human review is not blind, `>15` triggers arbitration, and Replica results stay sealed until lock. Assert no Web Storage API is used for credentials.

- [ ] **Step 2: Verify UI resource tests fail**

```powershell
npm test -- test/judge-ui.test.js
```

Expected: judge assets do not exist.

- [ ] **Step 3: Build the three-column workbench**

- left: Card, Agent examples, test type, run/repeat selector, A2A timeline, Part/Artifact evidence;
- center: four model leaf scores, fifth result when present, findings, counter-evidence, uncertainty, repair suggestions, and disagreement markers;
- right: every applicable human leaf score, evidence picker, rationale, model disposition, override reason, draft state, and submit action.

Keep the evidence view primary. Do not turn it into a leaderboard.

- [ ] **Step 4: Keep credentials and evidence safe**

Hold the judge token in memory only. Clear it on `pagehide/pageshow`. Render all evidence with `textContent` or explicit escaping. Never inject Agent HTML. URL artifacts open only through the platform's snapshotted evidence endpoint, not the original URL.

- [ ] **Step 5: Implement revision-safe drafts**

Read `ETag`, send `If-Match`, debounce server drafts, and handle 409 by showing a conflict state with reload—not by overwriting. Never calculate authoritative totals in the browser.

- [ ] **Step 6: Implement irreversible submit/recuse**

Before submit, show missing leaves/evidence reasons and require explicit confirmation. On success, make inputs read-only. If arbitration is required, show only assigned disputed leaves to the arbitrator.

- [ ] **Step 7: Meet accessibility/responsive requirements**

Provide keyboard navigation, visible focus, form labels, status announcements, reduced motion, usable 1280px three-column layout, and stacked narrow layout. Evidence/code areas must wrap or scroll without hiding score controls.

- [ ] **Step 8: Run UI tests and inspect visually**

```powershell
npm test -- test/judge-ui.test.js test/api.test.js
npm run check
```

Start the app and inspect primary, conflict, submitted, and arbitration states at desktop and mobile widths. Confirm no Replica field appears in DOM/network payload before lock.

- [ ] **Step 9: Commit the judge workbench**

```powershell
git add -- public/judge.html public/judge.js public/judge.css public/index.html server.js test/judge-ui.test.js test/api.test.js
git commit -m "feat: add non blind human review workbench"
```

### Task 6: Publish evidence-led dual-track results

**Required during execution:** invoke `frontend-design:frontend-design` before reshaping the result UI.

**Files:**
- Add: `public/result-v2.js`
- Add: `public/evidence.html`
- Add: `public/evidence.js`
- Add: `public/evidence.css`
- Add: `test/result-ui.test.js`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `server.js`
- Modify: `test/api.test.js`

**Interfaces:**
- Adds: `GET /api/evaluations/:id/result`.
- Adds: `GET /api/evaluations/:id/evidence-manifest`.
- Adds: `GET /api/evaluations/:id/evidence/:evidenceId`.
- Produces: a role-projected, server-calculated result and evidence replay.

- [ ] **Step 1: Write failing API/UI tests**

Assert the result endpoint does not accept score/weight query overrides. Assert public evidence never includes encrypted/raw payloads, credentials, PII, original signed URLs, or hidden reveal maps.

Require result sections in this order:

1. absolute total and total confidence;
2. 夯 / 人上人 / NPC / 拉 or pending status;
3. submitted versus each valid Replica and `Δc`/95% CI;
4. declared versus observed capabilities;
5. original/equivalent/boundary/multi-turn/stability;
6. serious model findings plus humorous line;
7. human final opinions and adjustments;
8. unverifiable claims and evidence gaps.

- [ ] **Step 2: Add evidence APIs**

The manifest endpoint returns redacted metadata according to role. The evidence-item endpoint takes the independently projected manifest item's `recordHash`, decrypts through `EvidenceVault.get(evidenceId, recordHash)`, applies current redaction again, records an event through the independent `AccessAuditStore`, and returns only content allowed for that principal. Judges never receive Replica evidence before lock. Evidence reads must not advance the assignment draft ETag.

- [ ] **Step 3: Render server-authoritative results**

In `public/app.js`:

```js
item.resultV2
  ? renderV2Result(item)
  : renderLegacyResult(item);
```

Move V2 rendering into `public/result-v2.js`. Do not recompute medians, confidence, delta, or rating client-side.

- [ ] **Step 4: Make the dual track unmistakable**

Label:

- “三维绝对分：Agent 本身做得怎么样”
- “复刻优势：是否胜过五分钟临时 Skill”

State that Replica results never enter the absolute total. If CI crosses a relevant threshold, show “差异未稳定”. If no valid Replica exists, show the absolute score and “待复刻”.

- [ ] **Step 5: Add evidence replay**

Filter by test type, test ID, repeat, turn, evidence grade, and kind. Show platform timing, protocol lifecycle, redacted Messages/Tasks/Artifacts/Parts, acceptance checks, and URL snapshot metadata. Keep raw sensitive content unavailable.

- [ ] **Step 6: Avoid false cross-track rankings**

Display the evaluation track/task type near the result. Do not sort unlike investment-research tasks into a single absolute leaderboard. History may filter within a track but must label comparisons as same-track only.

- [ ] **Step 7: Run and commit result UI**

```powershell
npm test -- test/result-ui.test.js test/api.test.js test/evaluation-projection.test.js
npm run check
git add -- public/result-v2.js public/evidence.html public/evidence.js public/evidence.css public/app.js public/index.html public/styles.css server.js test/result-ui.test.js test/api.test.js
git commit -m "feat: publish evidence led dual track results"
```

### Task 7: Add append-only appeals and controlled replacement runs

**Files:**
- Add: `src/appeals.js`
- Add: `src/appeal-recalculation.js`
- Add: `src/failure-attribution.js`
- Add: `test/appeals.test.js`
- Add: `test/appeal-recalculation.test.js`
- Add: `test/failure-attribution.test.js`
- Add: `public/appeal.js`
- Add: `public/appeal.css`
- Modify: `server.js`
- Modify: `src/black-box-pipeline.js`
- Modify: `src/result-v2.js`
- Modify: `test/api.test.js`
- Modify: `.env.example`

**Interfaces:**
- Produces: `createAppeal(evaluation, participant, input)`.
- Produces: `triageAppeal(evaluation, appealId, input, admin)`.
- Produces: `authorizeReplacementRun(evaluation, appealId, runId, admin)`.
- Produces: `decideAppeal(evaluation, appealId, input, admin)`.
- Produces: `attributeFailure(probes)`.
- Produces: `runAppealResultVersion(evaluation, appeal, services)`.

- [ ] **Step 1: Define the appeal record and state machine**

Use:

```js
{
  appealId,
  version: 1,
  status: 'submitted' | 'triaged' | 'replacement-authorized' |
    'replacement-completed' | 'evidence-recomputed' | 'model-rereview' |
    'human-rereview' | 'absolute-relocked' | 'arena-rejudged' |
    'upheld' | 'rejected',
  target: {
    kind: 'test' | 'evidence' | 'score',
    id,
    path
  },
  grounds: 'platform-error' | 'evidence-missing' | 'rubric-misapplied',
  statement,
  evidenceIds,
  originalSnapshot: {
    resultHash,
    evidenceManifestHash,
    runIds
  },
  events,
  replacementRunIds,
  decision
}
```

Require a concrete valid target, non-empty statement, and participant ownership. Default window is 72 hours from finalization.

- [ ] **Step 2: Write failing immutability/retry tests**

Assert:

- creating/triaging/deciding appends versions/events without modifying the original result/evidence hash;
- Agent timeout, protocol error, or task failure cannot authorize replacement;
- Replica Skill test failure cannot authorize replacement;
- confirmed platform failure authorizes at most one same-seed/config/input replacement;
- a replacement appends run/evidence IDs and never replaces originals;
- a completed replacement cannot directly edit a locked score; it must pass the complete result-version recalculation chain;
- concurrent/idempotent requests do not duplicate appeals or runs.

- [ ] **Step 3: Implement fixed failure probes**

`attributeFailure()` consumes:

1. scheduler, evidence-store, and organizer control-endpoint probe;
2. one bounded independent-worker connection check to the same Agent endpoint;
3. contemporaneous unrelated-Agent health evidence.

Return:

```js
{
  attribution: 'platform' | 'agent' | 'replica' | 'pending',
  reasons,
  evidenceIds
}
```

If a control probe fails or unrelated Agents fail together, classify platform. If controls pass and only the target repeatedly fails, classify Agent. Ambiguous cases stay pending and unscored until an admin decision.

- [ ] **Step 4: Implement same-config replacement**

A platform replacement must copy:

- canonical test input hash;
- seed and temperature;
- timeout/target;
- protocol/runtime/model config versions;
- acceptance criteria and weight.

It appends `replacementForRunId` and never permits a second replacement for the same invalid run.

- [ ] **Step 5: Recalculate a complete independent result version**

`runAppealResultVersion()` creates a new version namespace and performs, in order:

```text
replacement or corrected evidence cell
→ executable acceptance re-evaluation
→ all six objective metrics and coverage recomputation
→ four fresh model reviews for every affected absolute subcriterion
→ conditional fresh fifth review
→ two new human appeal-review assignments for affected leaves
→ greater-than-15 third-human arbitration when required
→ new absolute result calculation and immutable lock
→ rejudge every arena cell whose candidate output changed
→ rerun the full fixed-seed bootstrap cube
→ recalculate Δc and rating
→ regenerate guarded humor from the new locked findings
```

Unchanged evidence/review/arena cells may be referenced by hash from the prior version; they are not copied and made mutable. Updated model and human reviews must see the new evidence version and cannot reuse old scores as inputs. If a Replica cell itself was invalidated by a confirmed platform fault, replace that cell under the same Runtime/test/config rules before rejudging.

- [ ] **Step 6: Version changed results**

If a sustained appeal changes evidence or scoring, append:

```js
resultVersions: [{
  version,
  supersedesResultHash,
  reason: 'appeal:<appealId>',
  absolute,
  replica,
  rating,
  createdAt,
  resultHash
}]
```

Keep the original visible in the audit trail. Never edit it in place.

- [ ] **Step 7: Add appeal APIs**

```text
POST /api/evaluations/:id/appeals
GET  /api/evaluations/:id/appeals
POST /api/admin/appeals/:appealId/triage
POST /api/admin/appeals/:appealId/replacement-run
POST /api/admin/appeals/:appealId/decision
```

Require participant/admin roles as appropriate and `Idempotency-Key` on POSTs.

- [ ] **Step 8: Add the participant appeal UI**

Let participants select a concrete test/evidence/score path, cite visible evidence, choose grounds, submit a statement, and view an append-only status timeline and before/after result versions. Do not offer a generic “rerun everything” button.

- [ ] **Step 9: Run and commit appeal tests**

```powershell
npm test -- test/appeals.test.js test/appeal-recalculation.test.js test/failure-attribution.test.js test/api.test.js
npm run check
git add -- src/appeals.js src/appeal-recalculation.js src/failure-attribution.js src/black-box-pipeline.js src/result-v2.js server.js public/appeal.js public/appeal.css .env.example test/appeals.test.js test/appeal-recalculation.test.js test/failure-attribution.test.js test/api.test.js
git commit -m "feat: add append only evaluation appeals"
```

### Task 8: Complete methodology, operations, and rollout documentation

**Files:**
- Modify: `public/methodology.html`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SCORING.md`
- Modify: `docs/PRODUCTION_OPERATIONS.md`
- Modify: `README.md`
- Modify: `test/api.test.js`

**Interfaces:**
- Produces: participant, judge, and operator documentation matching implemented behavior.

- [ ] **Step 1: Add failing documentation assertions**

Require:

```text
Agent 使用示例
模型先评
人工不盲审
四模型
第五模型
大于 15 分
证据等级
客观覆盖率
暂定
绝对分锁定
复刻结果密封
保守复刻优势
Δc
差异未稳定
待复刻
申诉
平台错误
原始运行不覆盖
```

Reject “Skill 使用示例” in participant-facing V2 copy.

- [ ] **Step 2: Document exact formulas and thresholds**

Publish all fixed leaf weights, seat weights, confidence math, objective coverage semantics, four/fifth model triggers, human arbitration rule, arena 40/30/20/10 weights, bootstrap method, and rating boundaries.

- [ ] **Step 3: Document evidence/security operations**

Cover encryption-key rotation, evidence access auditing, retention, PII/secret redaction, participant token recovery policy, judge/admin token hashing, revision conflicts, audit-chain verification, sealed-arena incident response, and backup restoration.

- [ ] **Step 4: Document rollout flags**

Use:

```text
A2A_BLACK_BOX_V1_ENABLED=false
REVIEW_GOVERNANCE_ENABLED=false
ENABLE_REPLICA_ARENA_V2=false
PUBLIC_EVIDENCE_ENABLED=true
APPEAL_WINDOW_HOURS=72
```

Roll out in shadow mode, then judge pilot, then V2 default. Historical `schemaVersion: 1` records remain legacy and are never silently rescored.

- [ ] **Step 5: Run and commit documentation tests**

```powershell
npm test -- test/api.test.js
git add -- public/methodology.html docs/ARCHITECTURE.md docs/SCORING.md docs/PRODUCTION_OPERATIONS.md README.md test/api.test.js
git commit -m "docs: explain governed black box evaluation"
```

### Task 9: Verify the complete governed evaluation

**Files:**
- Verify all four implementation phases.

**Interfaces:**
- Produces: a complete model-first, human-weighted, evidence-led, dual-track evaluation.

- [ ] **Step 1: Run the complete automated suite**

```powershell
npm test
npm run check
git diff --check
```

Expected: all root tests pass, syntax is valid, and no whitespace error exists.

- [ ] **Step 2: Run an end-to-end governance fixture**

Execute:

```text
V2 submission
→ qualification
→ four test types × three repetitions
→ four model reviews
→ triggered fifth review
→ two primary human reviews
→ one >15 leaf arbitration
→ absolute lock
→ Replica release
→ bootstrap Δc
→ final rating
→ guarded humor
→ participant appeal
→ confirmed platform replacement
→ versioned result
```

Verify every transition and immutable hash.

- [ ] **Step 3: Perform a role-leak audit at every phase**

Capture public, participant, each judge, admin, result, evidence, history, and SSE payloads before/after lock. Search for credentials, raw PII, signed URLs, hidden-test leakage, Replica leakage, reveal maps, and other judges' drafts. Expect only fields authorized for that role and phase.

- [ ] **Step 4: Perform formula boundary tests against the UI**

Use fixtures exactly on:

- model range 20;
- model confidence 0.60;
- human spread 15 and 15.01;
- objective coverage 0.70;
- 夯, 人上人, and NPC total/scenario/`Δc` boundaries;
- no-valid-Replica;
- ineligible submission.

Confirm server JSON and rendered labels agree.

- [ ] **Step 5: Inspect judge/result/evidence/appeal pages**

Inspect desktop and narrow layouts, keyboard navigation, focus, reduced motion, long Chinese/English evidence, large JSON Parts, missing evidence, loading/error states, stale draft conflict, sealed state, provisional capability, unstable CI, and versioned appeal state.

- [ ] **Step 6: Verify the audit chain and evidence vault**

Decrypt sampled evidence with authorized operator tooling, verify ciphertext authentication and payload hashes, verify every audit event hash chain, and confirm duplicate evidence IDs cannot overwrite files.

- [ ] **Step 7: Record final verification fixes**

If verification requires a change, return to the owning task, stage only the exact files listed in that task's **Files** block, rerun its focused verification, and commit with `fix: close governed evaluation verification gaps`. Never use a repository-wide staging command.

The implementation is complete only when the absolute result cannot be altered after lock, Replica information cannot reach human review early, and appeals produce new traceable versions rather than overwritten scores.
