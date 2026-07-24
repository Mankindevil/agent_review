# Replica Arena and Dual-Track Rating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on-site reconstruction into an isolated replaceability stress test, compare submitted-Agent and temporary-Skill outputs anonymously, calculate a bootstrap-conservative replica advantage, and derive the existing 夯 / 人上人 / NPC / 拉 rating without contaminating the three-dimension absolute score.

**Architecture:** Build one temporary Skill per Runtime from a strict whitelist of Card semantics and all public whole-Agent examples. Keep hidden tests, submitted outputs, endpoints, credentials, and scores outside the build package. Execute each Replica against the same immutable current-test input used by the submitted Agent, normalize both sides to common Parts/Artifacts, and seal all Replica material. Fresh sessions of the same four-model panel judge anonymously. A deterministic bootstrap resamples the full test × repeat × judge cube and recomputes the best Replica each time. Release and rating remain gated on Phase 4's immutable absolute-score lock.

**Tech Stack:** Node.js 20 ESM, native `node:test`, current Claude Code/Cursor/Doubao adapters, Phase 2 model provider panel, deterministic seeded JavaScript statistics, Phase 1 encrypted evidence vault.

## Global Constraints

- A submitted entry is a complete Agent; every Runtime builds exactly one temporary Skill for that Agent.
- Replica build input is Card semantic fields plus all public Agent examples. It is never description-only in V2.
- Use a positive field whitelist. Recursive blacklisting alone is not sufficient.
- Replica build never sees endpoint URLs, authentication, documentation URLs, submitted outputs, hidden tests, model/human reviews, or other Replica artifacts.
- Build time is five minutes. All Runtime adapters use the same locked token, output, network, and local-tool policy.
- Execution receives only the current normalized test input. It cannot preview the test plan.
- Independent tests use clean workspaces and no context. Multi-turn context exists only inside one example/repeat and is destroyed afterward.
- Replica infrastructure failure invalidates that Replica and never counts as a submitted-Agent win. A valid Replica Skill's own per-test crash, timeout, or invalid output scores zero.
- Arena judges receive no Agent/Runtime identity, protocol metadata, latency, A2A compliance, or reveal map.
- Arena model sessions are fresh and cannot alter or inform absolute model/human scores.
- Replica outputs, arena scores, reveal maps, advantage, and rating stay sealed until `governance.phase === 'absolute_locked'`.

---

### Task 1: Create a whitelisted Replica Package

**Files:**
- Add: `src/replica-package.js`
- Add: `test/replica-package.test.js`
- Modify: `src/runtimes.js`
- Modify: `test/runtime-skill-retry.test.js`

**Interfaces:**
- Produces: `createReplicaPackage(agentCard, examples, options)`.
- Produces: `assertReplicaPackageSafe(replicaPackage, prohibitedValues)`.
- Preserves: legacy `buildSkill(runtime, description, mode, options)`.

- [ ] **Step 1: Write a failing whitelist test**

Use a Card containing top-level `url`, `supportedInterfaces`, security schemes, provider/documentation/icon URLs, metadata secrets, and harmless semantic fields. Expect:

```js
const packet = createReplicaPackage(card, examples, {
  rubricVersion: 'a2a-black-box-v1',
  packageVersion: 'replica-package/v1'
});

assert.equal(packet.agent.name, card.name);
assert.equal(packet.agent.description, card.description);
assert.equal(packet.agent.skills[0].description, card.skills[0].description);
assert.equal(packet.agentExamples.length, examples.length);
assert.equal(JSON.stringify(packet).includes('https://agent.example/a2a'), false);
assert.equal(JSON.stringify(packet).includes('Bearer'), false);
assert.equal(JSON.stringify(packet).includes('submittedOutput'), false);
assert.match(packet.manifest.contentHash, /^[a-f0-9]{64}$/);
```

- [ ] **Step 2: Verify package tests fail**

```powershell
npm test -- test/replica-package.test.js
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement a positive Card-field whitelist**

Keep only:

```js
{
  name,
  description,
  version,
  capabilities: {
    streaming: Boolean(card.capabilities?.streaming),
    pushNotifications: Boolean(card.capabilities?.pushNotifications)
  },
  defaultInputModes: stringArray(card.defaultInputModes),
  defaultOutputModes: stringArray(card.defaultOutputModes),
  skills: card.skills.map(({ id, name, description, tags, examples }) => ({
    id, name, description,
    tags: stringArray(tags),
    examples: stringArray(examples)
  }))
}
```

Do not copy unknown fields, `extensions`, interfaces, URLs, provider, security, authentication, metadata, signatures, or Card documentation.

- [ ] **Step 4: Include all public whole-Agent examples**

Include normalized:

```js
{
  id,
  name,
  turns: [{
    input,
    expectedDeliverable,
    acceptanceCriteria,
  }],
  constraints
}
```

These are Agent examples, not per-Skill examples. Omit test-plan IDs, hidden variants, execution evidence, and any output captured from the submitted Agent.

An example input may legitimately contain a `Part.type === 'url'`. Preserve it only at the exact path `agentExamples[*].turns[*].input.parts[*].url` after Phase 1 safe-URL validation. Reject it if its host matches any submitted Agent endpoint/provider/documentation host. If the URL contains a signed or secret-looking query, replace it in the build package with the locked one-hop snapshot reference, MIME, size, and hash; never expose the query credential. The current-test execution path still supplies the same authorized normalized input to Agent and Replica under the test sandbox.

- [ ] **Step 5: Add package manifests and safety scanning**

Manifest:

```js
{
  packageVersion: 'replica-package/v1',
  rubricVersion,
  generatedAt,
  sourceHashes: { agentCard, agentExamples },
  contentHash,
  exclusions: [
    'agent-endpoints',
    'credentials',
    'documentation-urls',
    'submitted-outputs',
    'hidden-tests',
    'reviews',
    'other-replicas'
  ]
}
```

`assertReplicaPackageSafe()` is path-aware. It rejects URL values everywhere except the validated public-example URL-Part path above, rejects authorization/JWT/Cookie shapes and known original endpoint hosts at every path, and rejects every forbidden key. It also verifies the canonical content hash.

- [ ] **Step 6: Preserve legacy Runtime bundles**

Keep `createSkillBundle(build, description)` and description-only tests for `schemaVersion: 1`. Add V2 functions rather than changing historical artifact claims.

- [ ] **Step 7: Run and commit package tests**

```powershell
npm test -- test/replica-package.test.js test/runtime-skill-retry.test.js
git add -- src/replica-package.js src/runtimes.js test/replica-package.test.js test/runtime-skill-retry.test.js
git commit -m "feat: package safe public inputs for replicas"
```

### Task 2: Standardize Replica adapters, budgets, and failure attribution

**Files:**
- Add: `src/replica-adapter.js`
- Add: `src/replica-budgets.js`
- Add: `src/replica-failures.js`
- Add: `test/replica-adapter.test.js`
- Add: `test/replica-failures.test.js`
- Modify: `src/runtimes.js`
- Modify: `src/prompts.js`
- Modify: `test/prompts.test.js`
- Modify: `.env.example`

**Interfaces:**
- Produces: `createReplicaAdapter(runtime, mode, dependencies)`.
- Produces: `validateReplicaArtifact(artifact, budget)`.
- Produces: `normalizeReplicaResult(value, metadata)`.
- Produces: `classifyReplicaFailure(error, healthEvidence)`.

- [ ] **Step 1: Lock first-version budgets**

Export:

```js
export const REPLICA_BUILD_BUDGET_V1 = Object.freeze({
  wallClockMs: 300_000,
  maxTokens: 16_000,
  maxOutputBytes: 2 * 1024 * 1024,
  toolAllowlist: ['workspace-read', 'workspace-write'],
  network: 'none'
});

export const REPLICA_RUN_BUDGET_V1 = Object.freeze({
  maxTokens: 8_000,
  maxOutputBytes: 2 * 1024 * 1024,
  toolAllowlist: ['workspace-read', 'workspace-write'],
  network: 'none'
});
```

Per-test `wallClockMs` comes from the frozen test timeout. A Runtime is tournament-valid only if its adapter reports hard enforcement for wall clock, output size, network isolation, and the configured token limit. Adapters that cannot prove hard enforcement may run in shadow diagnostics but cannot become the best valid baseline.

- [ ] **Step 2: Write failing adapter contract tests**

The adapter must expose:

```js
{
  health(options),
  build(replicaPackage, buildBudget, options),
  run(replicaArtifact, testInput, contextHandle, runBudget, options),
  disposeContext(contextHandle)
}
```

Require normalized build output:

```js
{
  artifactId,
  runtimeId,
  skill,
  files: [{ path, mediaType, byteLength, sha256, content }],
  manifest: {
    packageHash,
    budgetVersion: 'replica-budget/v1',
    budgetEnforcement: {
      wallClock: 'hard',
      tokens: 'hard',
      outputBytes: 'hard',
      network: 'hard'
    }
  },
  buildEvidence
}
```

Require normalized run output:

```js
{
  status: 'completed' | 'failed' | 'timed-out' | 'invalid-output',
  messageParts,
  artifacts,
  durationMs,
  error,
  budgetUsage,
  evidence
}
```

- [ ] **Step 3: Verify adapter tests fail**

```powershell
npm test -- test/replica-adapter.test.js test/replica-failures.test.js
```

Expected: missing modules.

- [ ] **Step 4: Add V2 build and run prompts**

`replicaBuildPrompt(replicaPackage, buildBudget)` tells a Runtime to create one Skill for the entire Agent, use only supplied public material, avoid external facts/network, and return the artifact contract.

`replicaRunPrompt(replicaArtifact, testInput, contextHistory, runBudget)` includes exactly one current turn and only same-example prior turns. It does not contain future tests, criteria answers, submitted output, or scores.

- [ ] **Step 5: Implement local and remote adapters**

Remote HTTP contract:

```js
{
  action: 'build_replica',
  replicaPackage,
  buildBudget,
  seed,
  temperature
}
```

and:

```js
{
  action: 'run_replica',
  replicaArtifact,
  testInput,
  contextHandle,
  runBudget,
  seed,
  temperature
}
```

Keep `build_skill` and `run_skill` for legacy. Local adapters create a fresh temp workspace, disable network, allow only workspace read/write, enforce the same output cap, and remove the workspace in `finally`.

- [ ] **Step 6: Validate every artifact before execution**

Reject absolute/traversal paths, symlinks, executable files, oversized files, endpoint/auth strings, manifest hash mismatches, missing Skill instructions, and budget-enforcement gaps. Scan both file content and structured Skill fields.

- [ ] **Step 7: Distinguish infrastructure from Skill failure**

Use:

```js
{
  source: 'replica-infrastructure' | 'replica-skill' | 'unknown',
  code,
  scoreSemantics: 'invalidate-replica' | 'score-zero' | 'hold-for-review'
}
```

- failed health, sandbox startup, adapter transport, or platform storage: invalidate Replica;
- build failure or unsafe artifact: no valid Replica, never a submitted-Agent win;
- valid artifact's single-test timeout/crash/invalid result: keep Replica valid and score that cell zero;
- ambiguous failure: seal and hold for operator review.

A Replica becomes `valid` only after health succeeds, build completes, artifact validation passes, and the adapter starts its first standard run through the normalized call boundary. If the boundary starts and the temporary Skill itself then fails, that cell scores zero; if the sandbox/adapter cannot start the call, invalidate the Replica as infrastructure failure.

- [ ] **Step 8: Test workspace and context isolation**

Assert:

- different independent tests receive distinct workspace/context handles;
- turns inside one multi-turn test reuse one handle;
- `disposeContext` runs at example completion and on errors;
- no subsequent test sees previous files/history;
- network attempts fail deterministically.

- [ ] **Step 9: Run and commit adapter changes**

```powershell
npm test -- test/replica-adapter.test.js test/replica-failures.test.js test/runtime-skill-retry.test.js test/prompts.test.js
git add -- src/replica-adapter.js src/replica-budgets.js src/replica-failures.js src/runtimes.js src/prompts.js .env.example test/replica-adapter.test.js test/replica-failures.test.js test/runtime-skill-retry.test.js test/prompts.test.js
git commit -m "feat: standardize isolated replica adapters"
```

### Task 3: Build once, run the same current tests, and seal Replica evidence

**Files:**
- Add: `src/replica-runner.js`
- Add: `test/replica-runner.test.js`
- Modify: `src/black-box-pipeline.js`
- Modify: `test/black-box-pipeline.test.js`
- Modify: `src/evaluation-projection.js`
- Modify: `test/evaluation-projection.test.js`

**Interfaces:**
- Produces: `buildReplicas(options)`.
- Produces: `executeReplicas(options)`.
- Produces: `sealReplicaArena(options)`.
- Consumes: Phase 2 `inputForTurn()`.

- [ ] **Step 1: Write a failing build-secrecy test**

Instrument adapters and assert build receives:

- one package per Runtime;
- no hidden test, test-plan object, submitted output, model review, score, endpoint, or credential;
- identical package hash across Runtime adapters;
- exactly one build call per Runtime for the whole Agent.

- [ ] **Step 2: Write a failing input-parity test**

For every `testId × repeatIndex × turnIndex`, assert:

```js
canonicalJson(replicaInput) === canonicalJson(submittedAgentInput);
```

Execution may supply prior same-context normalized messages separately, but it cannot mutate the current input.

- [ ] **Step 3: Verify runner tests fail**

```powershell
npm test -- test/replica-runner.test.js
```

Expected: missing runner module.

- [ ] **Step 4: Build all healthy Runtime replicas**

For each configured Runtime:

1. capture health evidence;
2. build within the fixed five-minute budget;
3. validate the artifact and budget enforcement;
4. encrypt raw artifact/build evidence;
5. append a redacted manifest;
6. mark `valid`, `invalid-infrastructure`, `invalid-build`, or `attribution-pending`.

Do not select a best Replica at this stage.

- [ ] **Step 5: Execute one current test at a time**

Use the same deterministic order and `inputForTurn()` output as the submitted Agent. Each approved test has three planned Replica runs. Normalize text, data, and files to the common Part/Artifact representation, then run the same secret/PII redaction and evidence-vault flow used for Agent evidence.

- [ ] **Step 6: Seal all Replica material**

Persist:

```js
replicaArena = {
  status: 'sealed',
  sealVersion: 'replica-arena-seal/v1',
  packageHash,
  runtimeSummaries: [{
    runtimeId,
    validity,
    artifactEvidenceIds,
    runCount,
    failureCategory
  }],
  encryptedArenaEvidenceIds,
  releasedAt: null
};
```

The public, participant, and human-judge projections expose only:

```js
{ status: 'sealed', validReplicaCount, pendingAttributionCount }
```

They must not expose Runtime names, artifacts, outputs, scores, logs, or failure details before absolute lock.

- [ ] **Step 7: Permit parallel work without early reveal**

`black-box-pipeline` may build/run replicas after the immutable test plan exists and in parallel with absolute model review. Store it only behind the seal. No absolute-review prompt or human projection can read the sealed payload.

- [ ] **Step 8: Run and commit runner tests**

```powershell
npm test -- test/replica-runner.test.js test/black-box-pipeline.test.js test/evaluation-projection.test.js
git add -- src/replica-runner.js src/black-box-pipeline.js src/evaluation-projection.js test/replica-runner.test.js test/black-box-pipeline.test.js test/evaluation-projection.test.js
git commit -m "feat: execute and seal replica baselines"
```

### Task 4: Judge outputs anonymously in fresh model sessions

**Files:**
- Add: `src/arena.js`
- Add: `test/anonymous-arena.test.js`
- Modify: `src/prompts.js`
- Modify: `test/prompts.test.js`
- Modify: `src/providers.js`
- Modify: `test/providers.test.js`

**Interfaces:**
- Produces: `buildArenaCells(options)`.
- Produces: `createArenaJudgePacket(cell, reviewer, seed)`.
- Produces: `runAnonymousArena(options)`.
- Produces: `aggregateArenaScores(judgements, validReplicaIds)`.

- [ ] **Step 1: Write failing anonymity tests**

One cell is `testId × repeatIndex`. It contains the shared task input and submitted/valid-Replica outputs.

Assert each judge packet:

- replaces competitors with deterministic opaque labels such as `candidate-7f2a`;
- randomizes candidate order independently per judge;
- contains no Agent name, Runtime name, protocol, latency, A2A status, evidence grade, reveal map, or source ID;
- contains the same task input, constraints, and expected deliverable for every candidate;
- keeps mapping only in encrypted internal evidence.

- [ ] **Step 2: Write failing arena-schema tests**

Require each judge to return:

```js
{
  scores: [{
    candidateId,
    dimensions: {
      taskConstraint: 0,
      professionalQuality: 0,
      evidenceRisk: 0,
      artifactUsability: 0
    },
    total: 0,
    rationale: '',
    uncertainties: []
  }]
}
```

Server-recalculate `total` as `40/30/20/10`; reject unknown/missing candidates and out-of-range scores.

- [ ] **Step 3: Verify arena tests fail**

```powershell
npm test -- test/anonymous-arena.test.js test/prompts.test.js
```

Expected: arena functions are missing.

- [ ] **Step 4: Build a comparison-only prompt**

The system prompt must explain:

- compare only task result quality shared by Agent and Skill;
- ignore protocol implementation, latency, identity, and presumed internal architecture;
- do not browse or inject outside facts;
- uncertainty about external truth should lower confidence/rationale, not invent a verdict;
- return one JSON object only.

- [ ] **Step 5: Use the same panel versions in fresh calls**

Use the four primary identities and exact model/sampling config frozen for absolute review, but invoke new independent requests with new derived seeds and no prior conversation. Do not reuse absolute-review outputs or fifth-model arbitration context.

- [ ] **Step 6: Preserve the full score cube**

Store:

```js
{
  arenaVersion: 'anonymous-arena/v1',
  cells: [{
    testId,
    repeatIndex,
    judgeId,
    anonymousScores,
    encryptedRevealMapEvidenceId
  }]
}
```

After internal reveal, create the scoring cube:

```js
{
  testId,
  repeatIndex,
  judgeId,
  scores: {
    submitted: 81.5,
    'replica:claude-code': 76,
    'replica:cursor': 72
  }
}
```

- [ ] **Step 7: Run and commit arena judging**

```powershell
npm test -- test/anonymous-arena.test.js test/prompts.test.js test/providers.test.js
git add -- src/arena.js src/prompts.js src/providers.js test/anonymous-arena.test.js test/prompts.test.js test/providers.test.js
git commit -m "feat: judge agent and replicas anonymously"
```

### Task 5: Bootstrap conservative advantage and classify the rating

**Files:**
- Add: `src/statistics.js`
- Add: `src/rating.js`
- Add: `test/bootstrap-rating.test.js`

**Interfaces:**
- Produces: `median(values)`.
- Produces: `bootstrapReplicaAdvantage(scoreCells, validReplicaIds, options)`.
- Produces: `intervalCrossesThreshold(interval, threshold)`.
- Produces: `classifyDualTrackRating(input)`.

- [ ] **Step 1: Write failing deterministic statistics tests**

Use a small hand-checkable cube. Assert:

- fixed seed produces byte-identical output;
- point estimate is submitted median minus the highest valid Replica median;
- invalid Replicas are excluded;
- 10,000 iterations are the default;
- 95% interval uses the 2.5th and 97.5th percentiles;
- `conservativeDelta === interval.low`.

- [ ] **Step 2: Recompute the best Replica inside every bootstrap draw**

Implement:

```text
for each draw:
  sample score cells with replacement
  submitted = median(sampled submitted scores)
  eachReplica = median(sampled scores for that valid replica)
  delta = submitted - max(eachReplica)
```

This preserves best-baseline selection uncertainty. Save the point-estimate `bestReplicaId` separately for display.

- [ ] **Step 3: Write exact rating-boundary tests**

Cover every inclusive boundary:

```js
assert.equal(classifyDualTrackRating({
  eligibilityStatus: 'eligible',
  absoluteTotal: 80,
  scenarioScore: 60,
  objectiveCoverage: 0.70,
  replicaAdvantage: { status: 'ready', conservativeDelta: 5 }
}).label, '夯');
```

Also test:

- 79.99 total does not qualify for 夯;
- `objectiveCoverage = 0.6999` cannot be 夯;
- 人上人 at `70 / 50 / -2`;
- NPC at `55 / 36 / -10`;
- any scenario score below 36 is 拉;
- ineligible returns no score/rating and “未通过参评资格”;
- no valid Replica returns `PENDING_REPLICA` and “待复刻”.

- [ ] **Step 4: Implement sequential classification**

Return:

```js
{
  status: 'final' | 'pending-replica' | 'ineligible',
  code: 'HARD' | 'ELITE' | 'NPC' | 'FLOP' | 'PENDING_REPLICA' | 'INELIGIBLE',
  label: '夯' | '人上人' | 'NPC' | '拉' | '待复刻' | '未通过参评资格',
  reasons,
  rubricVersion: 'a2a-black-box-v1',
  differenceStable
}
```

`differenceStable` is false when the confidence interval crosses any threshold relevant to the awarded/next rating. It changes display text, not the conservative threshold decision.

- [ ] **Step 5: Keep legacy roast logic isolated**

Do not modify V1 `buildRoast()` behavior. V2 uses `classifyDualTrackRating()` only. No humorous text enters the formula.

- [ ] **Step 6: Run and commit statistics/rating tests**

```powershell
npm test -- test/bootstrap-rating.test.js
git add -- src/statistics.js src/rating.js test/bootstrap-rating.test.js
git commit -m "feat: calculate conservative replica advantage"
```

### Task 6: Gate release and dual-track results on the absolute lock

**Files:**
- Add: `src/arena-release.js`
- Add: `test/pipeline-replica-arena.test.js`
- Modify: `src/black-box-pipeline.js`
- Modify: `src/evaluation-projection.js`
- Modify: `server.js`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `public/methodology.html`
- Modify: `test/api.test.js`

**Interfaces:**
- Produces: `releaseReplicaArena(evaluation, services)`.
- Produces: sealed results before Phase 4 and released dual-track results after a valid lock.

- [ ] **Step 1: Write a failing release-gate test**

Assert:

```js
assert.throws(
  () => releaseReplicaArena({ governance: { phase: 'human_open' } }, services),
  /absolute.*locked/i
);
```

With `governance.phase = 'absolute_locked'` and an immutable `absoluteLockedAt/resultHash`, expect arena judging, bootstrap, rating, and `replicaReleasedAt`.

- [ ] **Step 2: Enforce a one-way release transition**

Valid transitions:

```text
disabled → sealed
sealed → released
sealed → unavailable
```

Never transition released back to sealed or overwrite a released score cube. An appeal creates a new result version in Phase 4.

- [ ] **Step 3: Calculate but do not duplicate absolute scores**

Released result:

```js
resultV2 = {
  absolute: existingLockedAbsoluteResult,
  replica: {
    status: 'released',
    submittedMedian,
    runtimes: [{ runtimeId, valid, median }],
    bestBaseline,
    delta,
    conservativeDelta,
    ci95,
    differenceStable
  },
  rating: classifyDualTrackRating({
    eligibilityStatus,
    absoluteTotal: existingLockedAbsoluteResult.total,
    scenarioScore: existingLockedAbsoluteResult.dimensions.scenarioValue.score,
    objectiveCoverage: existingLockedAbsoluteResult.dimensions.agentCapability.objectiveCoverage,
    replicaAdvantage
  })
};
```

Replica values must not be added to any dimension or absolute total.

- [ ] **Step 4: Handle no-valid-Replica semantics**

If all Runtime failures are infrastructure/build/platform failures:

```js
resultV2.replica.status = 'unavailable';
resultV2.rating = {
  status: 'pending-replica',
  code: 'PENDING_REPLICA',
  label: '待复刻'
};
```

Publish the locked absolute score. Do not claim the submitted Agent won.

- [ ] **Step 5: Keep the Phase 3 UI sealed by default**

Before Phase 4:

- display “复刻结果已密封，等待绝对分锁定”;
- do not render Runtime names, outputs, medians, delta, CI, or rating;
- preserve the legacy result renderer.

Add the released-result renderer now behind the server-provided released state so Phase 4 can activate it without client-side recomputation.

- [ ] **Step 6: Document the counterfactual meaning**

Explain on the methodology page:

- temporary Skill versus complete Agent;
- public-information replaceability, not internal architecture proof;
- same input and anonymous result-only scoring;
- best valid Runtime median;
- bootstrap lower bound `Δc`;
- exact rating thresholds;
- no-valid-Replica “待复刻” behavior.

- [ ] **Step 7: Run and commit release integration**

```powershell
npm test -- test/pipeline-replica-arena.test.js test/evaluation-projection.test.js test/api.test.js
npm run check
git add -- src/arena-release.js src/black-box-pipeline.js src/evaluation-projection.js server.js public/app.js public/styles.css public/methodology.html test/pipeline-replica-arena.test.js test/api.test.js
git commit -m "feat: gate dual-track ratings on absolute lock"
```

### Task 7: Verify Phase 3 fairness and sealing

**Files:**
- Verify all Phase 3 files.

**Interfaces:**
- Produces: a sealed, statistically conservative Replica arena ready for Phase 4 release.

- [ ] **Step 1: Run full verification**

```powershell
npm test
npm run check
git diff --check
```

Expected: all root tests and syntax checks pass.

- [ ] **Step 2: Scan built artifacts and prompts for forbidden values**

For a fixture containing unique endpoint/auth/output markers, inspect every Replica package, Skill file, build prompt, and adapter request. All markers must be absent.

Run:

```powershell
rg -n "supportedInterfaces|documentationUrl|authorization|submittedOutput|hiddenTests|absoluteReview" data
```

Expected: no forbidden plaintext in Replica artifacts or public data; encrypted envelopes and field names alone are not leaks.

- [ ] **Step 3: Verify identical task delivery**

Compare canonical input hashes for every submitted and Replica test/turn/repeat. Expect zero mismatch. Confirm no adapter receives more than one current hidden test at a time.

- [ ] **Step 4: Verify anonymous judging**

Capture all arena prompts and confirm:

- each of four judge calls is fresh;
- candidate order differs by deterministic judge seed where possible;
- no identity/protocol/latency field appears;
- reveal maps remain encrypted;
- server, not models, recalculates 40/30/20/10 totals.

- [ ] **Step 5: Verify release isolation**

Fetch participant, public, judge-preview, detail, history, and SSE views before absolute lock. Search serialized responses for Runtime IDs, Replica outputs, arena scores, delta, and tier. Expect none.

- [ ] **Step 6: Record the phase gate**

If verification requires a fix, return to the owning task, stage only the exact files listed in that task's **Files** block, rerun its focused verification, and commit with `fix: close replica arena fairness gaps`. Never use a repository-wide staging command.

Phase 3 is complete only when the arena can finish internally while every user-facing role still sees a seal until an immutable absolute lock exists.
