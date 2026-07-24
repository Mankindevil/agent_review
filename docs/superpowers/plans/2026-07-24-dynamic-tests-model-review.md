# Dynamic Tests and Model Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile whole-Agent examples into dynamic evaluation contracts, generate and independently scope-check hidden variants, execute every approved test three times, and obtain four independent evidence-grounded model reviews with conditional fifth-model arbitration.

**Architecture:** Build on Phase 1's normalized submission, A2A executor, evidence vault, rubric, and objective scorer. A deterministic compiler establishes the only allowed semantic scope. A generator proposes hidden tests, a different model approves or rejects them, and an immutable test plan feeds the submitted Agent. After execution, four isolated reviewer sessions score all applicable subcriteria from redacted evidence IDs; a fifth isolated session evaluates only disputed subcriteria. The model seat locks, but final absolute scores and replicas remain unavailable until human review.

**Tech Stack:** Node.js 20 ESM, native `node:test`, existing OpenAI-compatible and Anthropic provider adapters, JSON-only model contracts, Phase 1 evidence/scoring modules.

## Global Constraints

- The compiler, generator, scope reviewer, and scoring reviewers may use only the frozen Agent Card, frozen Agent examples, and platform-captured A2A evidence.
- No evaluation model may browse, fetch external facts, or infer unobserved internal tools, memory, subagents, model, prompts, cost, or token usage as verified facts.
- The generator model and scope-review model must be different configured models and isolated sessions.
- The four primary reviewers must be distinct model identities and cannot see one another's outputs.
- The fifth reviewer cannot see primary reviewer outputs; it receives the same evidence and only the disputed subcriterion IDs.
- Four valid primary reviews are mandatory. Same-model retry happens before a pre-registered fallback.
- Every approved original, equivalent, boundary, and multi-turn test is repeated three times.
- Hidden test content, rejected candidates, model scores, and future replica fields must pass through role projections and remain unavailable to public views.
- Phase 2 ends at `human_open`; it does not calculate final human-weighted dimensions, humor, replica advantage, or a 夯拉 rating.

---

### Task 1: Compile examples into locked scope and dynamic rubric checks

**Files:**
- Add: `src/example-compiler.js`
- Add: `test/example-compiler.test.js`
- Modify: `src/submission.js`
- Modify: `test/submission.test.js`
- Modify: `src/rubric.js`

**Interfaces:**
- Produces: `compileAgentExamples(agentCard, examples, options)`.
- Produces: `isExecutableCriterion(criterion)`.
- Consumes: Phase 1 `normalizeAgentExamples()`.

- [ ] **Step 1: Write failing compiler tests**

For a portfolio-risk example, expect:

```js
const compilation = compileAgentExamples(card, examples, {
  rubricVersion: 'a2a-black-box-v1'
});

assert.deepEqual(compilation.allowedDomains, ['portfolio-risk']);
assert.equal(compilation.contracts[0].goal, '分析本组合的行业集中度。');
assert.equal(compilation.contracts[0].externalTruthVerified, false);
assert.equal(compilation.objectiveApplicability.testSuccess, true);
assert.ok(compilation.rubricChecks.some(
  (check) => check.subcriterionId === 'professionalism.evidenceReasoning'
));
assert.ok(compilation.unverifiableClaims.some(
  (claim) => claim.kind === 'internal-tooling'
));
```

Add fixtures for a qualitative research report, a quantitative backtest, a retrieval Agent, and a plain formatting Agent. Assert the compiler does not force IC, backtest, benchmark, or trading-cost checks onto examples that never require them.

- [ ] **Step 2: Verify compiler tests fail**

```powershell
npm test -- test/example-compiler.test.js
```

Expected: module-not-found failure.

- [ ] **Step 3: Produce a closed compilation contract**

Return:

```js
{
  compilationVersion: 'example-compilation/v1',
  rubricVersion,
  sourceHashes: {
    agentCard: cardHash,
    agentExamples: examplesHash
  },
  allowedDomains: [],
  declaredCapabilities: [],
  contracts: [{
    exampleId,
    goal,
    inputSummary,
    contextPolicy,
    constraints,
    expectedDeliverables,
    executableCriteria,
    modelCriteria,
    externalTruthVerified: false,
    sourceRefs
  }],
  rubricChecks: [{
    checkId,
    dimensionId,
    subcriterionId,
    question,
    applicable,
    sourceRefs,
    allowedEvidenceGrades: ['A', 'B', 'C', 'D']
  }],
  objectiveApplicability,
  unverifiableClaims
}
```

`goal`, domains, constraints, and deliverables must be extractive or deterministic summaries. Do not call a model in this function.

- [ ] **Step 4: Mark claims without scoring them**

Recognize Card/metadata claims about:

- internal model;
- named tools or tool chains;
- memory backend and TTL;
- sub-Agent count or roles;
- prompts and reasoning;
- tokens, cost, cache, retries, or planning.

Emit them as grade-C `unverifiableClaims`. Their presence must not change applicability or score. A later observed behavior can support a separate black-box check but never confirm the internal implementation.

- [ ] **Step 5: Build dynamic checks under the fixed 15 subcriteria**

Every rubric check maps to one fixed subcriterion from `RUBRIC_V1`. Examples:

```js
{
  checkId: 'portfolio-risk:uncertainty',
  dimensionId: 'professionalism',
  subcriterionId: 'professionalism.riskUncertainty',
  question: '是否区分已知持仓、未知数据和推断，并说明集中风险的局限？',
  applicable: true,
  sourceRefs: ['example:portfolio-risk:constraint:0']
}
```

Scenario-value checks use Card/examples plus observed deliverables. Professionalism checks are task-specific. Agent-capability model checks explain black-box behavior but do not replace Phase 1 objective metrics.

- [ ] **Step 6: Run compiler and contract tests**

```powershell
npm test -- test/submission.test.js test/example-compiler.test.js
```

Expected: all tests pass and no compiled check introduces an unsupported finance method.

- [ ] **Step 7: Commit the example compiler**

```powershell
git add -- src/example-compiler.js src/submission.js src/rubric.js test/example-compiler.test.js test/submission.test.js
git commit -m "feat: compile agent examples into dynamic rubrics"
```

### Task 2: Generate hidden variants and independently enforce scope

**Files:**
- Add: `src/hidden-tests.js`
- Add: `src/test-plan.js`
- Add: `test/hidden-tests.test.js`
- Add: `test/test-plan.test.js`
- Modify: `src/prompts.js`
- Add: `test/prompts.test.js`

**Interfaces:**
- Produces: `hiddenVariantGenerationPrompt(compilation)`.
- Produces: `hiddenScopeReviewPrompt(compilation, candidates)`.
- Produces: `generateHiddenVariants(compilation, services)`.
- Produces: `reviewHiddenVariantScopes(compilation, candidates, services)`.
- Produces: `finalizeTestPlan(compilation, candidates, decisions, policy)`.

- [ ] **Step 1: Write failing generation-contract tests**

Require one approved candidate slot of each generated type per example:

```js
['equivalent', 'boundary', 'multi-turn']
```

Each candidate must include:

```js
{
  candidateId,
  sourceExampleId,
  variantType,
  changeSummary,
  turns,
  inheritedCriteriaIds,
  proposedCriteria,
  timingClass
}
```

Assert candidates cannot introduce new URLs, external answer keys, new domains, new capabilities, or expected facts not present in the compilation. A URL Part already present in the source example may be preserved unchanged after the Phase 1 safe-URL and secret scan.

- [ ] **Step 2: Write failing scope-decision tests**

Require:

```js
{
  candidateId,
  checks: {
    sameDomain: true,
    declaredOrDemonstratedCapabilityOnly: true,
    noExternalTruthDependency: true,
    difficultyFromAllowedTransformation: true,
    sameInputForAgentAndReplica: true
  },
  approved,
  reasons
}
```

All five checks must be exactly `true` for approval. Rejected candidates remain in `scopeAudit.rejected` and never enter executable tests.

- [ ] **Step 3: Verify hidden-test tests fail**

```powershell
npm test -- test/hidden-tests.test.js test/test-plan.test.js test/prompts.test.js
```

Expected: missing exports/modules.

- [ ] **Step 4: Add strict JSON prompts**

The generation system prompt must:

- quote the closed compilation JSON;
- prohibit external facts, browsing, new domains, and capability expansion;
- prohibit answer keys based on current market or company facts;
- require only equivalent wording/format, in-scope parameters/edge cases, or in-scope multi-turn interaction;
- return a single JSON object.

The scope prompt must not include generator rationale beyond candidate `changeSummary`; it independently compares source scope and candidate inputs.

- [ ] **Step 5: Enforce independent model identities**

`generateHiddenVariants` and `reviewHiddenVariantScopes` receive explicit reviewer configurations. Reject:

```js
generator.identityKey === scopeReviewer.identityKey
```

where `identityKey` is `${providerKind}:${baseUrlHost}:${model}`. Separate request IDs or seeds do not make the same model independent.

- [ ] **Step 6: Finalize the immutable test plan**

For each required `example × generated variant type` slot, allow at most three generator attempts. Scope-review every attempt independently. A rejected attempt is retained in audit and cannot run. If no candidate is approved after three attempts, set the evaluation stage to `scope-incomplete` as a platform readiness failure; do not silently drop the variant or calculate a formal score from an incomplete four-type matrix.

Add deterministic original tests from the public examples and approved generated candidates:

```js
{
  testPlanVersion: 'black-box-test-plan/v1',
  rubricVersion: 'a2a-black-box-v1',
  defaultRepeatCount: 3,
  generatedAt,
  generatorIdentity,
  scopeReviewerIdentity,
  tests: [{
    testId,
    sourceExampleId,
    variantType: 'original' | 'equivalent' | 'boundary' | 'multi-turn',
    visibility: 'public' | 'hidden',
    contextPolicy: 'fresh' | 'reuse-within-example',
    turns,
    criteria,
    repeatCount: 3,
    weight,
    timing: { targetMs, timeoutMs },
    normalizedInputHash,
    scopeDecisionId
  }],
  scopeAudit: { approved, rejected }
}
```

Lock weights deterministically:

```text
each source example receives 1 / exampleCount of total test weight
within an example, original/equivalent/boundary/multi-turn each receive 1/4
within a test, its three repeats each receive 1/3 of that test weight
```

A multi-turn test passes executable completion only when every required executable criterion across its turns passes. A test with no required executable criterion remains semantic `N/A`.

Add one non-arena standardized protocol-error/recovery probe per evaluation: send a bounded malformed A2A message, require a specification-valid error, then send the next valid planned input in a fresh context and require normal protocol handling. This makes core error handling objectively applicable without relying on the generator to invent an error case. Card-specific optional claim probes remain additive.

Default timing policy:

```js
export const TEST_TIMING_POLICY_V1 = {
  singleTurn: { targetMs: 45_000, timeoutMs: 180_000 },
  multiTurnPerTurn: { targetMs: 45_000, timeoutMs: 180_000 }
};
```

Allow an organizer timing-policy override only when it is frozen in the submission configuration before generation.

- [ ] **Step 7: Prove input parity**

Export:

```js
export function inputForTurn(test, turnIndex) {
  return structuredClone(test.turns[turnIndex].input);
}
```

Both the submitted Agent and later Replica path must call this function. Test hashes must match byte-for-byte canonical input for both competitors.

- [ ] **Step 8: Run and commit hidden-test modules**

```powershell
npm test -- test/hidden-tests.test.js test/test-plan.test.js test/prompts.test.js
git add -- src/hidden-tests.js src/test-plan.js src/prompts.js test/hidden-tests.test.js test/test-plan.test.js test/prompts.test.js
git commit -m "feat: generate scope-checked hidden tests"
```

### Task 3: Execute the approved test plan and recalculate objective capability

**Files:**
- Add: `src/test-executor.js`
- Add: `test/test-executor.test.js`
- Modify: `src/black-box-pipeline.js`
- Modify: `test/black-box-pipeline.test.js`
- Modify: `src/objective-scoring.js`
- Modify: `test/objective-scoring.test.js`

**Interfaces:**
- Produces: `executeTestPlan(testPlan, { existingRunIndex, ...options })`.
- Consumes: `executeA2ATurn()`, `evaluateAcceptance()`, and `inputForTurn()`.

- [ ] **Step 1: Write a failing execution matrix test**

With one example and four variant types, expect:

```js
assert.equal(result.testRuns.length, 4 * 3);
assert.deepEqual(
  [...new Set(result.testRuns.map((run) => run.repeatIndex))],
  [0, 1, 2]
);
```

For a two-turn test, assert the returned context is reused only within that test/repeat. Assert every independent test/repeat starts without a prior `contextId` or `taskId`.

Add three Phase 1 original-example runs to `existingRunIndex` and assert the executor reuses them when `testId`, repeat, canonical input hash, timing policy, seed, protocol config, and rubric version all match. It must execute only the missing hidden cells and must not create a second selectable original sample.

- [ ] **Step 2: Test planned failures versus platform replacements**

Cover:

- Agent timeout/protocol/task failure: retain the planned run and score it as Agent behavior.
- platform network/storage/instrumentation failure: mark the run invalid and permit one replacement with the same test hash, seed, and config;
- unknown attribution: exclude temporarily and record `attribution-pending`;
- no extra Agent retry after a scored Agent failure.

The three planned repetitions are statistical samples, not retries.

- [ ] **Step 3: Implement execution ordering**

Use a deterministic shuffled order derived from the frozen evaluation seed, but persist the original `testId`/repeat mapping. Execute one current test at a time. Do not send future hidden tests, expected deliverables, criteria, scope decisions, or the full test plan to the Agent.

For evaluations already processed by the Phase 1 shadow path, index original runs by the full locked cell identity and reuse exact matches. A mismatch makes the prior shadow run non-scoring historical evidence; it does not permit choosing between old and new results. For evaluations created after Phase 2 is enabled, compile/finalize the complete test plan before formal scored execution and run each original cell only once.

- [ ] **Step 4: Persist each run before proceeding**

For every turn:

1. run A2A;
2. store raw encrypted A/B evidence;
3. append redacted manifest entries;
4. evaluate executable criteria;
5. append acceptance evidence;
6. update the record revision;
7. continue to the next turn/run.

An interrupted worker can resume only missing planned cells; it cannot rerun completed Agent-error cells.

- [ ] **Step 5: Recalculate all objective subcriteria**

Feed original and approved hidden results into `buildObjectiveMetrics()`. Explicitly calculate:

- required executable-test success;
- repetition consistency;
- equivalent/boundary robustness;
- same-context retention and correction;
- cross-context isolation;
- A2A lifecycle compliance;
- locked timing performance;
- Card claim checks and normalized error-input recovery.

Keep semantic success `N/A` for tests with only model criteria. Recompute `coverage` and `provisional` from original rubric weights.

- [ ] **Step 6: Run execution tests**

```powershell
npm test -- test/test-executor.test.js test/objective-scoring.test.js test/black-box-pipeline.test.js
```

Expected: the exact test/repeat matrix, context policies, append-only evidence, and objective recalculation pass.

- [ ] **Step 7: Commit test-plan execution**

```powershell
git add -- src/test-executor.js src/black-box-pipeline.js src/objective-scoring.js test/test-executor.test.js test/black-box-pipeline.test.js test/objective-scoring.test.js
git commit -m "feat: execute repeated black-box test plans"
```

### Task 4: Generalize provider calls and configure a five-seat panel

**Files:**
- Modify: `src/providers.js`
- Modify: `test/providers.test.js`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: `configuredReviewPanel(env)`.
- Produces: `requestJson(reviewer, system, prompt, signal, sampling)`.
- Preserves: `configuredReviewers()` and `reviewAgent()` for legacy evaluations.

- [ ] **Step 1: Write failing panel-configuration tests**

Given:

```js
MODEL_REVIEW_PANEL_JSON = JSON.stringify({
  version: 'panel-v1',
  primary: [reviewerA, reviewerB, reviewerC, reviewerD],
  arbitrator: reviewerE,
  fallbacks: [reviewerF, reviewerG]
});
```

Assert:

- exactly four primary identities;
- one distinct arbitrator;
- no duplicate `identityKey`;
- every live reviewer has a configured secret name, not a literal secret;
- invalid live panels prevent V2 model review;
- demo mode provides five deterministic mock identities.

- [ ] **Step 2: Verify provider tests fail**

```powershell
npm test -- test/providers.test.js
```

Expected: `configuredReviewPanel` and `requestJson` are missing.

- [ ] **Step 3: Extract a shared JSON request adapter**

Implement:

```js
export async function requestJson(
  reviewer,
  system,
  prompt,
  signal,
  { seed, temperature = 0, maxTokens = 6000 } = {}
) {
  const text = reviewer.kind === 'anthropic'
    ? await callAnthropic(reviewer, system, prompt, signal, { seed, temperature, maxTokens })
    : await callOpenAICompatible(reviewer, system, prompt, signal, { seed, temperature, maxTokens });
  return safeJson(text);
}
```

Do not log request bodies, model responses, or API keys. Keep per-call timeout and cancellation semantics.

- [ ] **Step 4: Add pre-registered retry/fallback semantics**

Provide a helper:

```js
requestReviewerWithFallback({
  reviewer,
  fallbacks,
  invoke,
  maxSameReviewerAttempts: 2
})
```

Retry the same identity once with identical prompt/config. Only then select the first unused registered fallback. Persist every failed platform attempt as audit data, but only valid normalized reviews enter scoring.

- [ ] **Step 5: Document live-panel configuration**

Add:

```text
MODEL_REVIEW_PANEL_JSON=
MODEL_REVIEW_TIMEOUT_MS=120000
MODEL_REVIEW_MAX_TOKENS=6000
```

Document that live V2 cannot lock its model seat without four valid distinct primary reviews and a configured distinct arbitrator for possible disputes.

- [ ] **Step 6: Run and commit provider changes**

```powershell
npm test -- test/providers.test.js
git add -- src/providers.js test/providers.test.js .env.example README.md
git commit -m "feat: configure independent model review panel"
```

### Task 5: Score every subcriterion and trigger fifth-model arbitration

**Files:**
- Add: `src/judge-panel.js`
- Add: `test/judge-panel.test.js`
- Modify: `src/prompts.js`
- Modify: `test/prompts.test.js`
- Modify: `src/confidence.js`
- Modify: `test/confidence.test.js`

**Interfaces:**
- Produces: `absolutePanelPrompt(rubricChecks, evidencePackage, options)`.
- Produces: `normalizePanelReview(value, contract)`.
- Produces: `arbitrationReasons(reviews)`.
- Produces: `runModelPanel(options)`.
- Produces: `aggregateModelPanel(primaryRuns, arbitrationRun, rubric)`.

- [ ] **Step 1: Write the failing review-schema test**

Require one entry for every applicable fixed subcriterion:

```js
{
  subcriterionId: 'professionalism.evidenceReasoning',
  score: 76,
  confidence: 0.72,
  evidenceIds: ['ev_a', 'ev_b'],
  checkEvidence: [{
    checkId: 'portfolio-risk:reasoning-chain',
    evidenceIds: ['ev_b']
  }],
  findings: [{
    text: '结论引用了 Agent 返回的行业暴露表，但没有解释缺失持仓的影响。',
    evidenceIds: ['ev_b']
  }],
  counterEvidence: [{
    text: '风险段明确说明了未知持仓。',
    evidenceIds: ['ev_a']
  }],
  uncertainties: ['没有外部真值，不能核验行业分类是否真实'],
  repairSuggestion: '补充行业分类口径和未知权重处理。',
  conclusions: {
    taskCompleted: 'partial',
    criticalRisk: 'yes'
  }
}
```

Allow `taskCompleted` values `yes | partial | no | not-applicable` and `criticalRisk` values `yes | no | uncertain | not-applicable`. Require exactly one `checkEvidence` entry for every applicable compiled `checkId` under that subcriterion; an unsupported check has an empty `evidenceIds` array rather than being omitted. Reject missing/extra checks, missing/extra subcriterion IDs, scores outside 0–100, confidence outside 0–1, unknown evidence IDs, empty findings, unsupported conclusion values, and any output that claims an internal tool/memory/subagent was verified without observable evidence.

- [ ] **Step 2: Write arbitration trigger tests**

Assert:

```js
arbitrationReasons([40, 60, 59, 55]).includes('score-range');
```

because the inclusive range is 20.

Also trigger on:

- any `yes`/`no` conflict for `taskCompleted` or `criticalRisk`;
- at least three of four confidences below `0.60`.

Do not trigger for two low-confidence reviews or range 19.

- [ ] **Step 3: Verify judge tests fail**

```powershell
npm test -- test/judge-panel.test.js test/prompts.test.js
```

Expected: missing panel functions.

- [ ] **Step 4: Build the evidence-only prompt**

The prompt packet contains:

```js
{
  rubricVersion,
  submission: { redactedCard, redactedExamples },
  testCatalog: [{ testId, variantType, constraints, criteriaKinds }],
  evidenceManifest,
  redactedEvidence,
  objectiveCapability,
  rubricChecks
}
```

It must never contain `replica`, `runtime`, `build`, `benchmark`, `arena`, another review, or external URLs not returned as snapshotted Agent artifacts. State clearly that no browsing or outside fact checking is allowed.

The scoring instructions must also state:

- product/collaboration novelty is based only on public interaction and observable product effect, never a claimed sub-Agent count;
- professionalism checks are compiled for the actual task rather than assuming every Agent must run a backtest;
- Card claims can route a check but cannot earn capability points without observed A/B evidence;
- absent external truth permits judging completion, method, consistency, uncertainty, and usability, but not factual correctness against the outside world.

- [ ] **Step 5: Run four isolated reviewers**

Invoke four primary calls concurrently with deterministic per-reviewer derived seeds. Give each the same packet and no shared conversation. Normalize outputs and assign platform finding IDs:

```js
findingId = `finding_${reviewRunId}_${subcriterionId}_${index}`;
```

Evidence IDs remain references; findings are grade-D reviewer interpretations.

- [ ] **Step 6: Run one independent arbitration call when required**

Create a list of disputed subcriterion IDs after all four valid primary reviews. The arbitrator prompt includes the original evidence packet and those IDs only. It does not include scores, findings, ranges, trigger reasons, or reviewer identities.

The fifth score joins the original four:

```js
modelSubcriterionScore = median([
  primary1, primary2, primary3, primary4, arbitrator
]);
```

Non-disputed subcriteria retain the four-score median.

- [ ] **Step 7: Aggregate model-seat dimensions**

For each fixed subcriterion, store raw valid reviews, optional arbitration, median score, median confidence, evidence coverage, and model-stage confidence. Then calculate each dimension using `RUBRIC_V1` subcriterion weights.

Also store a normalized `checkEvidenceIndex` keyed by `checkId`. It is the union of valid cited evidence IDs from primary reviews and the optional fifth review; Phase 4 will union the human check-level citations before calculating the final evidence-strength term `E`.

Status rules:

```js
{
  status: fourValidPrimaryReviews
    ? allRequiredArbitrationsValid ? 'model-locked' : 'waiting-arbitration'
    : 'waiting-primary-reviewers'
}
```

Do not average entire answer sheets.

- [ ] **Step 8: Run and commit judge-panel tests**

```powershell
npm test -- test/judge-panel.test.js test/prompts.test.js test/confidence.test.js
git add -- src/judge-panel.js src/prompts.js src/confidence.js test/judge-panel.test.js test/prompts.test.js test/confidence.test.js
git commit -m "feat: add four-model review and arbitration"
```

### Task 6: Orchestrate Phase 2 and open human review

**Files:**
- Modify: `src/black-box-pipeline.js`
- Modify: `test/black-box-pipeline.test.js`
- Modify: `src/evaluation-projection.js`
- Modify: `test/evaluation-projection.test.js`
- Modify: `server.js`
- Modify: `test/api.test.js`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `public/methodology.html`

**Interfaces:**
- Produces: a V2 `human_open` governance state.
- Preserves: sealed/disabled replica state and legacy rendering.

- [ ] **Step 1: Write a failing end-to-end state test**

Use deterministic mock generator, scope reviewer, four primary judges, and an arbitrator. Expect:

```js
assert.equal(result.exampleCompilation.compilationVersion, 'example-compilation/v1');
assert.equal(result.testPlan.tests.every((test) => test.repeatCount === 3), true);
assert.equal(result.absoluteReview.status, 'model-locked');
assert.equal(result.governance.phase, 'human_open');
assert.equal(result.resultV2.absolute.status, 'model-provisional');
assert.equal(result.resultV2.rating.status, 'pending-human');
assert.equal(result.replicaArena.status, 'disabled');
```

Include one rejected out-of-domain candidate and prove it has no runs or score impact.

- [ ] **Step 2: Add pipeline stages**

Execute:

```text
qualification
→ example_compilation
→ hidden_generation
→ scope_review
→ test_execution
→ objective_scoring
→ model_review
→ optional_model_arbitration
→ human_open
```

Persist each stage and its config/model identity version. Platform model failures retry according to Task 4; unresolved panel failures leave the evaluation waiting, not falsely completed.

For newly created V2 evaluations, pass the locked hidden-test, generator, scope-reviewer, model-panel, and timing-policy versions into `freezeSubmission()` at intake. Phase 1 shadow records with null versions remain explicitly shadow-only and cannot be promoted to a formal final result by mutating their frozen submission snapshot.

- [ ] **Step 3: Strengthen role projections**

Public/participant views may show stage, counts, objective coverage, and model-review readiness. They must not show hidden test bodies, rejected candidate bodies, model findings before the configured release point, or future replica fields.

Add a temporary `judge-preview` projection containing redacted submitted-Agent evidence and model reviews but no replica-related keys. Phase 4 replaces it with authenticated judge access.

- [ ] **Step 4: Render a non-final V2 progress result**

In `public/app.js`:

```js
item.schemaVersion === 2
  ? renderBlackBoxProgress(item)
  : renderLegacyResult(item);
```

Show test-type counts, repetition coverage, objective capability coverage, provisional flag, model-seat completion, and “等待人工复核”. Do not show a final total, final confidence, roast, or tier.

- [ ] **Step 5: Explain methodology**

Update the methodology page with:

- public Agent examples rather than Skill examples;
- original/equivalent/boundary/multi-turn variants;
- independent scope review;
- three planned repetitions;
- four isolated model reviewers and inclusive 20-point arbitration threshold;
- confidence `<0.60` rule;
- no external browsing/fact injection;
- final scores waiting for non-blind human review.

- [ ] **Step 6: Run integration/UI resource tests**

```powershell
npm test -- test/black-box-pipeline.test.js test/evaluation-projection.test.js test/api.test.js
npm run check
```

Expected: full Phase 2 orchestration passes, hidden data does not leak, and legacy UI remains usable.

- [ ] **Step 7: Commit the Phase 2 orchestration**

```powershell
git add -- src/black-box-pipeline.js src/evaluation-projection.js server.js public/app.js public/styles.css public/methodology.html test/black-box-pipeline.test.js test/evaluation-projection.test.js test/api.test.js
git commit -m "feat: orchestrate dynamic tests and model review"
```

### Task 7: Verify Phase 2 isolation and completeness

**Files:**
- Verify all Phase 2 files.

**Interfaces:**
- Produces: a locked model seat ready for human review.

- [ ] **Step 1: Run the complete suite and syntax check**

```powershell
npm test
npm run check
git diff --check
```

Expected: all root tests and syntax checks pass with no whitespace errors.

- [ ] **Step 2: Audit prompt isolation**

Run:

```powershell
rg -n "replica|runtime|builds|benchmark|arena" src/prompts.js src/judge-panel.js
```

Expected: those terms appear only in explicit rejection/guard code, never as absolute-review packet fields.

- [ ] **Step 3: Audit test-plan scope**

Use fixtures for at least four investment-research task types and one simple transform. Inspect approved/rejected audit records and verify:

- no new finance domain appears;
- no current external fact is required;
- difficulty only changes wording, format, in-scope parameters, edge cases, or interaction;
- submitted Agent inputs match `inputForTurn()` hashes exactly.

- [ ] **Step 4: Audit reviewer independence**

Record invocation metadata and verify:

- four distinct primary identity keys;
- no primary output in another primary prompt;
- fifth prompt has no primary score/finding/identity;
- same-model retry preserves prompt/config;
- fallback identity was pre-registered and unused.

- [ ] **Step 5: Record the phase gate**

If verification requires a change, return to the owning task, stage only the exact files listed in that task's **Files** block, rerun its focused verification, and commit with `fix: close dynamic evaluation verification gaps`. Never use a repository-wide staging command.

Phase 2 is complete only when V2 stops at a model-locked, human-open state and no final rating can be generated.
