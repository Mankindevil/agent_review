# V1 Scoring and PDF Report Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade only newly created V1 evaluations to Card-design review plus auditable 20/60/20 same-prompt scoring, hide V2/demo from the public intake, safely use Panda Data within bounded Runtime context, and provide a complete downloadable Chinese PDF report.

**Architecture:** Preserve every legacy V1/V2 record and backend path. Add versioned pure contracts for Card review, Arena v2 scoring, execution capability, Runtime context budgeting, and report projection; wire them into the existing V1 pipeline and renderer behind persisted version fields. Generate PDFs on demand from a public allowlist DTO through a bounded ReportLab subprocess.

**Tech Stack:** Node.js 20 ESM, built-in `node:test`, browser-native JavaScript, Python 3 + ReportLab 4.4.9, pypdf/pdfplumber, Poppler (`pdfinfo`, `pdftoppm`).

## Global Constraints

- Only new V1 evaluations use `v1-card-review/v2` and `v1-model-arena/v2`; historical V1 and every V2 record keep their persisted semantics.
- V2/demo backend APIs and historical result rendering remain available; only public intake controls are hidden and new browser submissions are fixed to V1 live.
- Formal candidate total is `20% scenario + 60% professionalism + 20% capability`; an execution/build failure is a hard total of `0`.
- Capability is objective: `70% execution success + 30% latency`; latency is `100` through 60 seconds, `0` at/after 600 seconds, linear between.
- Duration is end-to-end wall-clock and includes network/protocol/runtime/model overhead; internal tool invocation is explicitly unavailable.
- Panda credentials never enter prompts. Query results are bounded to 240,000 bytes each and 600,000 bytes total, with a 1,500,000-byte complete Runtime input ceiling and 0.8 warning ratio.
- The PDF contains complete public Card, reviews, CASE outputs, Skill definitions, data/context audit, and timeline; secrets and internal evidence are excluded by an allowlist DTO.
- Existing unrelated worktree changes must remain unstaged. For overlapping dirty files, stage only task hunks and verify the staged tree independently before each commit.
- Every production behavior follows RED -> GREEN -> REFACTOR. Do not write production code until the named failing test has been observed.

---

### Task 1: Runtime Context Budget and Panda Result Compaction

**Files:**
- Create: `src/runtime-context.js`
- Modify: `src/runtimes.js`
- Modify: `src/panda-runtime.js`
- Create: `test/runtime-context.test.js`
- Modify: `test/panda-runtime.test.js`

**Interfaces:**
- Produces: `inspectRuntimeContext(system, prompt, options) -> { system, prompt, usage }`
- Produces: `compactPandaQueries(queries, options) -> { queries, budget }`
- Produces: `RuntimeContextBudgetError` with `code === "MODEL_CONTEXT_BUDGET_EXCEEDED"`
- Extends: `buildSkill(..., { onContextUsage })` and `runSkill(..., { onContextUsage })`
- Preserves: existing `buildSkill` return type and `runSkill` string return type

- [ ] **Step 1: Write failing Runtime budget tests**

Add tests that define the exact public behavior:

```js
test('Runtime context reports warning and rejects before invocation when required input exceeds 1.5 MB', () => {
  const warning = inspectRuntimeContext('system', '中'.repeat(40), {
    scope: 'runtime-final', maxInputBytes: 128, warnRatio: 0.8
  });
  assert.equal(warning.usage.status, 'warning');
  assert.throws(
    () => inspectRuntimeContext('system', '中'.repeat(100), {
      scope: 'runtime-final', maxInputBytes: 128
    }),
    (error) => error.code === 'MODEL_CONTEXT_BUDGET_EXCEEDED'
  );
});

test('Panda compaction keeps complete rows under per-query and aggregate byte budgets', () => {
  const compacted = compactPandaQueries([
    { method: 'get_factor', status: 'ready', result: { rowCount: 4, data: rows } },
    { method: 'get_fina_reports', status: 'ready', result: { rowCount: 4, data: rows } }
  ], { perQueryBytes: 180, totalBytes: 300 });
  assert.ok(Buffer.byteLength(JSON.stringify(compacted.queries[0])) <= 180);
  assert.ok(Buffer.byteLength(JSON.stringify(compacted.queries)) <= 300);
  assert.equal(compacted.queries[0].result.truncated, true);
  assert.equal(
    compacted.queries[0].result.originalRows,
    compacted.queries[0].result.keptRows + compacted.queries[0].result.droppedRows
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test test/runtime-context.test.js test/panda-runtime.test.js
```

Expected: FAIL because `src/runtime-context.js`, `inspectRuntimeContext`, and `compactPandaQueries` do not exist and current Panda compaction only slices 500 rows.

- [ ] **Step 3: Implement the pure budget module**

Create constants and exact usage shape:

```js
export const RUNTIME_CONTEXT_MAX_BYTES = 1_500_000;
export const RUNTIME_CONTEXT_WARN_RATIO = 0.8;
export const PANDA_QUERY_MAX_BYTES = 240_000;
export const PANDA_EVIDENCE_MAX_BYTES = 600_000;

export class RuntimeContextBudgetError extends RangeError {
  constructor(usage) {
    super(`runtime context ${usage.scope} exceeds ${usage.maxInputBytes} bytes`);
    this.code = 'MODEL_CONTEXT_BUDGET_EXCEEDED';
    this.contextUsage = usage;
  }
}
```

`inspectRuntimeContext` must measure UTF-8 bytes for the complete system + user prompt, estimate tokens as `Math.ceil(inputBytes / 4)`, emit `ok|warning|exceeded`, call `options.onUsage`, and throw before any provider/CLI invocation on `exceeded`.

`compactPandaQueries` must add rows one at a time, serialize the whole candidate envelope before accepting a row, never slice a JSON string, preserve non-array result metadata, and publish:

```js
{
  originalRows,
  keptRows,
  droppedRows,
  truncated,
  data: keptRowsArray
}
```

- [ ] **Step 4: Integrate all Runtime adapters**

Before local CLI, model API, or remote adapter requests, call `inspectRuntimeContext` with scopes:

- `runtime-build:<runtimeId>`
- `runtime-panda-plan:<runtimeId>`
- `runtime-final:<runtimeId>`
- `runtime-remote-request:<runtimeId>`

Pass every usage record to `onContextUsage`. Replace `compactPandaResult` with aggregate `compactPandaQueries` after all 1–3 platform queries finish. The final evidence prompt must include `originalRows/keptRows/droppedRows/truncated` and require explicit disclosure when truncated.

Change `buildPandaInterfaceReference` so a required allowlisted method is never silently removed by `reference.slice`; throw a budget error if the complete allowlisted contract exceeds its declared maximum.

- [ ] **Step 5: Verify GREEN and regressions**

Run:

```bash
node --test test/runtime-context.test.js test/panda-runtime.test.js test/runtime-skill-retry.test.js
npm run check
```

Expected: all pass; a test-injected provider is never called after an exceeded preflight.

- [ ] **Step 6: Commit only Task 1**

```bash
git add src/runtime-context.js src/runtimes.js src/panda-runtime.js test/runtime-context.test.js test/panda-runtime.test.js
git commit -m "feat: bound V1 Runtime Panda context"
```

---

### Task 2: Versioned Agent Card Design Review

**Files:**
- Create: `src/v1-card-review.js`
- Modify: `src/prompts.js`
- Modify: `src/providers.js`
- Modify: `src/scoring.js`
- Modify: `src/pipeline.js`
- Create: `test/v1-card-review.test.js`
- Modify: `test/prompts.test.js`
- Modify: `test/providers.test.js`
- Modify: `test/pipeline-control.test.js`

**Interfaces:**
- Produces: `V1_CARD_REVIEW_VERSION = "v1-card-review/v2"`
- Produces: `CARD_REVIEW_DIMENSIONS` in the frozen five-key order
- Produces: `normalizeV1CardReview(value) -> { version, score, dimensions, comment, risk }`
- Produces: `aggregateV1CardReviews(reviews) -> professional snapshot`
- Changes new review dimensions to `positioningClarity`, `skillDesign`, `protocolCoherence`, `ioExampleQuality`, `boundaryRiskDisclosure`

- [ ] **Step 1: Write failing Card-contract tests**

Tests must assert that the Prompt says Card claims are declarations, forbids execution/tool inference, and contains only the five design dimensions. Add normalization tests:

```js
test('Card review recomputes an equal-weight score and drops provider prose', () => {
  const review = normalizeV1CardReview({
    score: 1,
    dimensions: {
      positioningClarity: 80,
      skillDesign: 70,
      protocolCoherence: 60,
      ioExampleQuality: 50,
      boundaryRiskDisclosure: 40
    },
    comment: 'Skills 边界清楚，但示例不足。',
    risk: '未声明数据失败状态。',
    providerNote: 'ignored'
  });
  assert.equal(review.score, 60);
  assert.equal(review.providerNote, undefined);
});
```

Also assert missing/unknown dimension keys, non-Chinese comment/risk, and out-of-range values fail.

- [ ] **Step 2: Verify RED**

```bash
node --test test/v1-card-review.test.js test/prompts.test.js test/providers.test.js
```

Expected: FAIL on old finance-result dimensions and old Prompt language.

- [ ] **Step 3: Implement the versioned pure contract**

`normalizeV1CardReview` must require every scoring key, allow harmless top-level provider prose, reject unknown dimension keys, recompute score as the rounded equal-weight mean, and require Han characters in `comment` and `risk`.

The strict output schema becomes:

```json
{"score":0,"dimensions":{"positioningClarity":0,"skillDesign":0,"protocolCoherence":0,"ioExampleQuality":0,"boundaryRiskDisclosure":0},"comment":"","risk":""}
```

Update mock reviews to the same v2 contract. `reviewAgent` returns `version: "v1-card-review/v2"`. `professionalSnapshot` delegates to the versioned aggregator for new reviews and retains the old aggregator for historical stored reviews.

- [ ] **Step 4: Update pipeline copy and retry behavior**

Change active work text from finance-result metrics to “定位、Skills、协议、输入输出与能力边界”. Review retry must preserve the review version and replace only the selected seat. New creates persist `professional.version`.

- [ ] **Step 5: Verify GREEN**

```bash
node --test test/v1-card-review.test.js test/prompts.test.js test/providers.test.js test/pipeline-control.test.js
npm run check
```

- [ ] **Step 6: Commit only Task 2 hunks**

Because `src/prompts.js`, `src/providers.js`, `test/prompts.test.js`, and `test/providers.test.js` already contain unrelated worktree changes, use `git add -p` and inspect `git diff --cached` before commit.

```bash
git add src/v1-card-review.js src/scoring.js src/pipeline.js test/v1-card-review.test.js test/pipeline-control.test.js
git add -p src/prompts.js src/providers.js test/prompts.test.js test/providers.test.js
git commit -m "feat: review V1 Agent Card design"
```

---

### Task 3: V1 Arena v2 Hybrid Scoring Engine

**Files:**
- Modify: `src/v1-model-scoring.js`
- Modify: `src/prompts.js`
- Modify: `test/v1-model-scoring.test.js`
- Modify: `test/prompts.test.js`

**Interfaces:**
- Produces: `V1_SCORING_VERSION = "v1-model-arena/v2"`
- Preserves: `LEGACY_V1_SCORING_VERSION = "v1-model-arena/v1"`
- Produces: `latencyScore(durationMs)` and `capabilityScore(execution)`
- New judge result: `{ scenario, scores }`
- New entry dimensions: `{ scenarioValue, professionalQuality, agentCapability }`
- New detail: `{ scenario, professionalism, capability }`

- [ ] **Step 1: Write failing scoring tests**

Define exact boundaries:

```js
assert.equal(latencyScore(60_000), 100);
assert.equal(latencyScore(330_000), 50);
assert.equal(latencyScore(600_000), 0);
assert.equal(capabilityScore({ status: 'failed', durationMs: 1 }), 0);
assert.equal(capabilityScore({ status: 'succeeded', durationMs: 60_000 }), 100);
assert.equal(capabilityScore({ status: 'succeeded', durationMs: 600_000 }), 70);
```

Add a panel fixture where each seat returns:

```js
{
  scenario: {
    dimensions: { problemComplexity: 80, agentSuitability: 60 },
    rationale: '该任务包含多阶段研究，但部分步骤可固定化。',
    uncertainties: []
  },
  scores: [{
    candidateId,
    dimensions: {
      taskCompletion: 90,
      methodProfessionalism: 80,
      evidenceDataQuality: 70,
      riskUncertainty: 60,
      artifactUsability: 50
    },
    rationale: '方法完整且结果可复核。',
    uncertainties: []
  }]
}
```

Assert scenario is emitted once per seat, is shared across candidates, server totals use 20/60/20, failed execution is exactly zero, provider prose is ignored, and unknown scoring dimensions fail.

- [ ] **Step 2: Verify RED**

```bash
node --test test/v1-model-scoring.test.js test/prompts.test.js
```

Expected: FAIL because current v1 contract has four candidate dimensions and no scenario/capability.

- [ ] **Step 3: Implement v2 validation and aggregation**

Use frozen weights:

```js
const SCENARIO_WEIGHTS = { problemComplexity: 0.5, agentSuitability: 0.5 };
const PROFESSIONAL_WEIGHTS = {
  taskCompletion: 0.3,
  methodProfessionalism: 0.25,
  evidenceDataQuality: 0.2,
  riskUncertainty: 0.15,
  artifactUsability: 0.1
};
const TOTAL_WEIGHTS = { scenarioValue: 0.2, professionalQuality: 0.6, agentCapability: 0.2 };
```

For every subdimension, aggregate successful seats by median, then recompute composites. Never median model-reported totals. Publish each seat's scenario review once in `judging.scenario.reviews`, and each candidate's professional review in `judgeReviews`.

The judge receives only test case and shuffled anonymous output. Do not include `execution`, `durationMs`, latency, names, Runtime IDs, or data verification metadata in the model packet.

- [ ] **Step 4: Preserve historical v1 behavior**

Move current four-dimension logic behind `LEGACY_V1_SCORING_VERSION`. `scoreV1ArenaCase` dispatches on `config.version`. `normalizeV1ScoringConfig` returns v2 for new input; an already-persisted v1 config remains valid on explicit retry. Accept both versions in pipeline completion checks and the frontend renderer.

- [ ] **Step 5: Verify GREEN**

```bash
node --test test/v1-model-scoring.test.js test/prompts.test.js
npm run check
```

- [ ] **Step 6: Commit Task 3**

```bash
git add src/v1-model-scoring.js test/v1-model-scoring.test.js
git add -p src/prompts.js test/prompts.test.js
git commit -m "feat: score V1 Arena on scenario output and capability"
```

---

### Task 4: Persist End-to-End Execution Metrics Through Pipeline and Retry

**Files:**
- Modify: `src/pipeline.js`
- Modify: `test/pipeline-control.test.js`
- Modify: `test/pipeline-panda-runtime.test.js`

**Interfaces:**
- Extends every new V1 benchmark entry with `execution`
- Passes `execution` unchanged into `scoreV1ArenaCase`
- Stores Runtime `contextUsage` under `entry.execution.contextUsage`
- Uses one monotonic measurement for both log `durationMs` and scoring entry `durationMs`

- [ ] **Step 1: Write failing pipeline tests**

Inject a clock sequence and assert submitted/Runtime entries receive:

```js
{
  status: 'succeeded',
  durationMs: 12_345,
  timingScope: 'end-to-end-wall-clock',
  includesNetwork: true,
  toolObservation: 'unavailable',
  contextUsage: []
}
```

Assert a thrown call stores `status: "failed"`, its measured duration, score `0`, and capability `0`. Assert a Runtime build failure uses `durationMs: 0` and `failureStage: "skill-build"`. Assert benchmark retry replaces the old execution snapshot and recalculates the complete CASE once.

- [ ] **Step 2: Verify RED**

```bash
node --test test/pipeline-control.test.js test/pipeline-panda-runtime.test.js
```

- [ ] **Step 3: Implement one measurement helper**

Add an injected `monotonicNow` option defaulting to `performance.now`. Use a helper that returns both value/error and rounded non-negative duration. Do not call the clock independently for logs and entries.

Update `makeUnscoredEntry` to require an execution object for v2 scoring. Pass `onContextUsage` into `buildSkill`/`runSkill`; copy usage records into build trace and the corresponding entry execution.

- [ ] **Step 4: Make retry coherent**

Benchmark and build retries must collect fresh duration/context usage, replace the affected candidate, invoke the same v2 CASE scoring path, and preserve the old coherent CASE until the new score commits. Historical v1 retry continues using its stored version.

- [ ] **Step 5: Verify GREEN**

```bash
node --test test/pipeline-control.test.js test/pipeline-panda-runtime.test.js test/v1-model-scoring.test.js
npm run check
```

- [ ] **Step 6: Commit Task 4**

```bash
git add src/pipeline.js test/pipeline-control.test.js test/pipeline-panda-runtime.test.js
git commit -m "feat: audit V1 execution capability"
```

---

### Task 5: Hide Public V2/Demo Intake and Render New V1 Audit

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/evaluation-version-ui.js`
- Modify: `public/styles.css`
- Modify: `test/evaluation-version-ui.test.js`
- Modify: `test/result-ui.test.js`

**Interfaces:**
- Produces: `publicEvaluationVersion(search) -> "v1"` for every public homepage query
- Public landing selection always returns usable `v1`
- Browser V1 request always contains `mode: "live"`
- Historical V2 and demo detail rendering stays unchanged
- New render helpers distinguish `v1-model-arena/v2` from legacy v1

- [ ] **Step 1: Write failing intake tests**

Replace old navigation expectations with:

```js
assert.doesNotMatch(html, /data-evaluation-version=/);
assert.doesNotMatch(html, />演示评测</);
assert.equal(publicEvaluationVersion('?version=v2'), 'v1');
assert.equal(buildEvaluationCreateRequest('v1', { ...input, mode: 'demo' }).mode, 'live');
```

Retain direct unit tests proving `buildEvaluationCreateRequest('v2', ...)` still builds a V2 API request and server pipeline tests proving direct demo creates remain supported.

- [ ] **Step 2: Write failing renderer tests**

Assert the Card section contains all five new Chinese labels and `AGENT CARD DESIGN REVIEW`. For an Arena v2 fixture assert the CASE displays:

- `场景价值`, `专业度`, `Agent 能力`
- five professional subdimensions
- `端到端耗时`
- “包含网络及协议开销”
- “未观测 Agent 内部工具调用”
- per-seat scenario and candidate reviews

Assert a persisted `v1-model-arena/v1` fixture still displays `任务约束/专业质量/证据风险/产物可用性`.

- [ ] **Step 3: Verify RED**

```bash
node --test test/evaluation-version-ui.test.js test/result-ui.test.js
```

- [ ] **Step 4: Implement public-only hiding**

Remove the version switch and demo button group from public HTML. Initialize `state.mode = "live"` and `state.selectedVersion = "v1"`. Landing health handling must not call the old V2 default resolver. Keep V2 form/render functions for historical/direct API records, but never expose them from the homepage.

- [ ] **Step 5: Implement versioned V1 rendering**

Add separate label maps and render paths. Arena v2 CASE order is shared scenario card, candidate three-dimension totals, professional five rows, objective execution metrics, then model audit. Legacy v1 uses the existing HTML path without reinterpretation.

- [ ] **Step 6: Verify GREEN and browser syntax**

```bash
node --test test/evaluation-version-ui.test.js test/result-ui.test.js test/browser-evaluation-actions.test.js
npm run check
```

- [ ] **Step 7: Commit Task 5**

```bash
git add public/index.html public/app.js public/evaluation-version-ui.js public/styles.css test/evaluation-version-ui.test.js test/result-ui.test.js
git commit -m "feat: expose only live V1 intake"
```

---

### Task 6: Complete Chinese PDF Report Projection Generator API and Link

**Files:**
- Create: `src/v1-report.js`
- Create: `scripts/render-v1-report.py`
- Modify: `server.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `requirements-data.txt`
- Create: `test/v1-report.test.js`
- Modify: `test/api.test.js`
- Modify: `test/result-ui.test.js`

**Interfaces:**
- Produces: `projectV1Report(evaluation) -> strict public DTO`
- Produces: `generateV1ReportPdf(dto, options) -> Promise<Buffer>`
- Adds: `GET /api/evaluations/:id/report.pdf`
- Adds: completed-V1-only `#download-v1-report`

- [ ] **Step 1: Write failing DTO security tests**

Build a complete fixture containing sentinel secrets in unknown keys and assert:

```js
const dto = projectV1Report(fixture);
const serialized = JSON.stringify(dto);
assert.match(serialized, /完整候选输出/);
assert.match(serialized, /完整中文评语/);
assert.doesNotMatch(serialized, /agent-secret|panda-password|internal-path/);
assert.throws(() => projectV1Report({ ...fixture, schemaVersion: 2 }), /V1/);
assert.throws(() => projectV1Report({ ...fixture, status: 'running' }), /completed/);
```

Projection must enumerate fields rather than clone-and-delete.

- [ ] **Step 2: Write failing PDF generator tests**

Generate a fixture with four reviewers, four candidates, two CASES, long Chinese output, JSON, and page-breaking paragraphs. Reopen the bytes with pypdf/pdfplumber and assert all ten section titles, every candidate, every complete output sentinel, `%PDF-` header, A4 pages, and more than one page.

- [ ] **Step 3: Verify RED**

```bash
node --test test/v1-report.test.js
```

Expected: FAIL because projection/generator do not exist.

- [ ] **Step 4: Implement allowlist projection and bounded subprocess**

`projectV1Report` accepts only completed non-V2 records and explicitly maps metadata, Card, Card reviews, builds/Skills, benchmark CASES, entry execution/context usage, public judge reviews, data verification, derived scores, roast, and public logs.

`generateV1ReportPdf` chooses Python in this order:

```js
options.python
  || process.env.REPORT_PDF_PYTHON
  || process.env.PANDA_DATA_PYTHON
  || '.venv/bin/python'
```

Spawn `scripts/render-v1-report.py`, send one bounded JSON document on stdin, collect stdout bytes with a PDF-size ceiling, collect sanitized stderr, kill on timeout, and reject unless stdout begins `%PDF-`.

- [ ] **Step 5: Implement ReportLab renderer**

Pin `reportlab==4.4.9`. The script must use `SimpleDocTemplate(A4)`, `UnicodeCIDFont('STSong-Light')`, `PageTemplate`/callbacks for header/footer/page number, `Paragraph` for wrapped prose, `LongTable(..., repeatRows=1)` for score tables, and `PageBreak` between major appendices.

Render exactly these sections: cover; scoring disclaimer; overview; complete Card; four Card reviews; per-CASE scenario; per-candidate battle/capability; per-seat audit; complete raw outputs; Runtime/data/context/timeline appendix. Escape XML-sensitive text before `Paragraph`; use a monospaced-like small style for JSON/output while retaining Chinese glyph support. Never truncate supplied DTO text.

- [ ] **Step 6: Add API tests and route**

Tests require:

- completed V1 -> 200, `application/pdf`, attachment filename, `no-store`, valid bytes;
- missing -> 404;
- V2/running -> 409;
- unavailable Python -> 503;
- timeout -> 504;
- generator failure never writes partial PDF.

Add the report route before the generic evaluation detail matcher.

- [ ] **Step 7: Add completed-V1 download link**

Add a hidden anchor to the run controls. Rendering sets `href=/api/evaluations/<encoded-id>/report.pdf` and unhides it only for completed non-V2 records. Navigating home or opening running/V2 records hides and clears it.

- [ ] **Step 8: Verify generated PDF structurally and visually**

Generate `output/pdf/v1-agent-review-fixture.pdf`, then run:

```bash
pdfinfo output/pdf/v1-agent-review-fixture.pdf
pdftoppm -png output/pdf/v1-agent-review-fixture.pdf tmp/pdfs/v1-agent-review
```

Inspect every rendered PNG. Fix any black glyph, clipping, overlap, table overflow, orphan heading, footer collision, or abnormal blank page, then regenerate and repeat. Use `pdfplumber` to verify every full-output sentinel remains in the final PDF.

- [ ] **Step 9: Verify GREEN**

```bash
node --test test/v1-report.test.js test/api.test.js test/result-ui.test.js
npm run check
```

- [ ] **Step 10: Commit Task 6**

```bash
git add src/v1-report.js scripts/render-v1-report.py server.js public/index.html public/app.js public/styles.css requirements-data.txt test/v1-report.test.js test/api.test.js test/result-ui.test.js
git commit -m "feat: download complete V1 PDF report"
```

Do not commit `output/pdf/` or `tmp/pdfs/` QA artifacts unless the repository policy explicitly tracks generated fixtures.

---

### Task 7: Documentation Production Verification and Release

**Files:**
- Modify: `README.md`
- Modify: `docs/SCORING.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PRODUCTION_OPERATIONS.md`
- Modify: `.env.example`
- Modify: `test/deploy-config.test.js`

**Interfaces:**
- Documents persisted scoring versions, formulas, timing/tool disclaimer, Panda budgets, PDF Python dependency, report route, and public-only hiding.
- Adds `REPORT_PDF_PYTHON` and exact context/Panda budget defaults to the environment reference.

- [ ] **Step 1: Write failing documentation/deploy assertions**

Extend tests to require the production runbook to install `requirements-data.txt`, verify ReportLab import, smoke the report endpoint, inspect `Content-Type`, run `pdfinfo`, and retain rollback steps. Require `.env.example` to expose `REPORT_PDF_PYTHON`, `MODEL_CONTEXT_MAX_BYTES=1500000`, and `MODEL_CONTEXT_WARN_RATIO=0.8`.

- [ ] **Step 2: Verify RED**

```bash
node --test test/deploy-config.test.js
```

- [ ] **Step 3: Update documentation with exact semantics**

Document both Arena versions, no historical migration, 20/60/20 and 70/30 formulas, 60/600 second thresholds, end-to-end/network disclosure, tool unavailability, 240 KB/600 KB Panda limits, 1.5 MB input failure, V1-only public intake, and completed-V1 PDF behavior.

- [ ] **Step 4: Verify GREEN**

```bash
node --test test/deploy-config.test.js
npm run check
```

- [ ] **Step 5: Independently verify the staged release tree**

Before final commit/push, create a Git tree from the intended index and export it to a temporary directory. Link/install dependencies there, then run all feature tests and syntax checks. This proves the commit does not accidentally depend on unrelated working-tree changes.

Required focused suite:

```bash
node --test \
  test/runtime-context.test.js \
  test/panda-runtime.test.js \
  test/v1-card-review.test.js \
  test/v1-model-scoring.test.js \
  test/pipeline-control.test.js \
  test/pipeline-panda-runtime.test.js \
  test/evaluation-version-ui.test.js \
  test/result-ui.test.js \
  test/v1-report.test.js \
  test/api.test.js \
  test/deploy-config.test.js
npm run check
```

Run `npm test` outside the filesystem/network sandbox because integration tests bind localhost. Record unrelated pre-existing failures separately; do not represent a failing full suite as green.

- [ ] **Step 6: Commit documentation hunks only**

README, architecture, operations, `.env.example`, and deploy tests already have unrelated local changes. Use interactive staging and inspect the staged diff:

```bash
git add -p README.md docs/SCORING.md docs/ARCHITECTURE.md docs/PRODUCTION_OPERATIONS.md .env.example test/deploy-config.test.js
git commit -m "docs: operate V1 scoring and PDF reports"
```

- [ ] **Step 7: Push only after explicit remote approval**

The configured destination is `https://github.com/Mankindevil/agent_review.git`, branch `codex/finance-roast`. Because exporting source to that destination was previously blocked pending destination-specific approval, do not retry until the user explicitly approves that repository and branch after the risk notice.

- [ ] **Step 8: Deploy and verify production**

Follow `docs/PRODUCTION_OPERATIONS.md`: create immutable release `/opt/agent-review/releases/<SHA>`, install npm and Python dependencies, run syntax/tests in release, atomically switch `/opt/agent-review/app`, restart `agent-review`, and verify:

- health endpoint;
- homepage contains neither V2 nor demo intake;
- one completed V1 result renders new Card/scenario/professional/capability audit;
- PDF endpoint returns a valid Chinese PDF;
- Panda Runtime query uses the allowlisted platform bridge and records non-exceeded context usage;
- service logs contain no credentials or unhandled errors.

Rollback immediately to the previous symlink if health, V1 creation, PDF generation, or Panda bridge smoke fails.
