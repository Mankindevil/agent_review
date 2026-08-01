# Market Analyst Evidence Projection Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve complete, validated Evidence Pack lineage when Market Analyst projects any analytical A2A operation with more than 500 sources.

**Architecture:** Keep the global trace sanitizer limits unchanged. Add a private Evidence Pack sanitizer inside `task-service.js` that resets the existing sanitizer budget for each semantic collection item, assembles the complete pack, and validates it before analytical projection. Route every `evidence-pack.json` input shape through that helper; leave other artifacts on the current generic path.

**Tech Stack:** Node.js 20+, ECMAScript modules, `node:test`, existing Market Analyst A2A harness and Evidence Pack validator.

## Global Constraints

- Do not increase the global `sanitizeTraceValue` limits.
- Do not change Panda Worker scoring, data retrieval, caching, degradation, email, or narrative behavior.
- Do not discard leaderboard rows, conclusions, metrics, or sources to make validation pass.
- Preserve owner isolation, artifact integrity, output-mode negotiation, stream truncation, A2A paths, artifact names, and media types.
- Do not stage or commit unrelated pre-existing workspace changes.

---

### Task 1: Reproduce large-lineage projection failure

**Files:**
- Modify: `test/market-analyst-a2a.test.js:148-222`
- Modify: `test/market-analyst-a2a.test.js:1538-1620`

**Interfaces:**
- Consumes: `analyticalArtifacts`, `traceableRow`, `traceableConclusion`, `traceableSource`, and `startHarness` from the same test module.
- Produces: `largeAnalyticalArtifacts(runId)` with more than 500 sources and one post-limit source referenced by each analytical leaderboard.

- [x] **Step 1: Add a large-lineage fixture**

Add this helper after `analyticalArtifacts`:

```js
function largeAnalyticalArtifacts(runId = 'run-large-analytical') {
  const artifacts = analyticalArtifacts(runId);
  const evidence = artifacts.find(({ name }) => name === 'evidence-pack.json').data;
  evidence.sources.push(
    ...Array.from({ length: 510 }, (_, index) =>
      traceableSource(`source-filler-${String(index).padStart(3, '0')}`)
    )
  );
  const cases = [
    ['hotIndustries', 'HOT-AFTER-LIMIT', 'source-hot-after-limit', 'ret1', 'hot-topics'],
    ['sellPressure', 'SELL-AFTER-LIMIT', 'source-sell-after-limit', 'downside_volume', 'sell-pressure'],
    ['potentialWatchlist', 'POTENTIAL-AFTER-LIMIT', 'source-potential-after-limit', 'trend', 'potential-watchlist']
  ];
  for (const [board, identity, sourceId, sourceRole, sectionId] of cases) {
    const row = traceableRow(board, identity, sourceId, sourceRole);
    evidence.leaderboards[board].push(row);
    evidence.conclusions.push(traceableConclusion(board, row, sourceId, sectionId));
    evidence.sources.push({
      ...traceableSource(sourceId),
      apiKey: 'large-lineage-secret-must-never-escape'
    });
  }
  validateEvidencePack(evidence);
  return artifacts;
}
```

- [x] **Step 2: Add a table-driven A2A regression test**

Use `artifactLoader: async (summary) => largeAnalyticalArtifacts(summary.runId)` and send one request for each analytical operation. For each returned Task assert:

```js
assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
const evidence = task.artifacts.find(
  ({ name }) => name === 'evidence-pack.json'
).parts[0].data;
assert.deepEqual(Object.keys(evidence.leaderboards), expectedLeaderboardKeys);
assert.doesNotThrow(() => validateEvidencePack(evidence));
assert.ok(evidence.sources.some(({ id }) => id === expectedSourceId));
assert.equal(
  JSON.stringify(evidence).includes('large-lineage-secret-must-never-escape'),
  false
);
```

- [x] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern="large Evidence Pack lineage" test/market-analyst-a2a.test.js
```

Expected: FAIL because the returned Task is `TASK_STATE_FAILED`; the current whole-pack sanitizer truncates `sources` before analytical projection.

---

### Task 2: Add lineage-preserving Evidence Pack sanitation

**Files:**
- Modify: `agents/market-analyst/task-service.js:460-492`
- Modify: `agents/market-analyst/task-service.js:1182-1207`
- Test: `test/market-analyst-a2a.test.js`

**Interfaces:**
- Consumes: `sanitizeTraceValue(value)` and `validateEvidencePack(value)`.
- Produces: private `sanitizeEvidencePack(value)` and `sanitizeArtifactData(name, value)` helpers.

- [x] **Step 1: Implement semantic collection sanitation**

Add private helpers before `projectAnalyticalArtifacts`:

```js
function sanitizeCollection(value) {
  return Array.isArray(value)
    ? value.map((item) => sanitizeTraceValue(item))
    : value;
}

function sanitizeRecordCollections(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, rows]) => [
    key,
    sanitizeCollection(rows)
  ]));
}

function sanitizeEvidencePack(value) {
  const base = sanitizeTraceValue({
    ...value,
    conclusions: [],
    leaderboards: {},
    excluded: {},
    sources: [],
    missingData: []
  });
  const sanitized = {
    ...base,
    conclusions: sanitizeCollection(value?.conclusions),
    leaderboards: sanitizeRecordCollections(value?.leaderboards),
    sources: sanitizeCollection(value?.sources)
  };
  if (value?.excluded !== undefined) {
    sanitized.excluded = sanitizeRecordCollections(value.excluded);
  } else {
    delete sanitized.excluded;
  }
  if (value?.missingData !== undefined) {
    sanitized.missingData = sanitizeCollection(value.missingData);
  } else {
    delete sanitized.missingData;
  }
  validateEvidencePack(sanitized);
  return sanitized;
}

function sanitizeArtifactData(name, value) {
  return name === 'evidence-pack.json'
    ? sanitizeEvidencePack(value)
    : sanitizeTraceValue(value);
}
```

Preserve absence rather than manufacturing optional fields. Ensure sanitizer metadata does not violate Evidence Pack key-count or schema constraints.

- [x] **Step 2: Route every Evidence Pack input shape through the helper**

Update `#buildArtifact` so `descriptor.data` and parsed JSON `descriptor.content` call `sanitizeArtifactData(name, value)`. For `descriptor.parts`, map each part and call the helper for `part.data`; continue using `sanitizeTraceValue` for text and URL parts. Do not change metadata sanitation or non-Evidence Pack artifacts.

- [x] **Step 3: Verify GREEN and the complete A2A file**

Run:

```bash
node --test --test-name-pattern="large Evidence Pack lineage" test/market-analyst-a2a.test.js
node --test test/market-analyst-a2a.test.js
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 4: Commit the implementation and plan**

Stage only:

```bash
git add agents/market-analyst/task-service.js test/market-analyst-a2a.test.js docs/superpowers/plans/2026-08-01-market-analyst-evidence-projection-fix.md
git commit -m "fix(market-agent): preserve projected evidence lineage"
```

---

### Task 3: Verify the complete behavior

**Files:**
- Verify: `agents/market-analyst/task-service.js`
- Verify: `test/market-analyst-a2a.test.js`
- Verify: `data/market-analyst/` runtime artifacts without modifying tracked files.

**Interfaces:**
- Consumes: fixed Market Analyst A2A server and existing npm test scripts.
- Produces: fresh automated and real-service evidence for the completion claim.

- [ ] **Step 1: Run syntax and Market Analyst checks**

Run:

```bash
npm run check
node --test test/market-analyst-a2a.test.js test/market-analyst-integration.test.js test/market-analyst-state.test.js
```

Expected: exit 0 with zero failures.

- [ ] **Step 2: Run the full Node test suite**

Run `npm run test:node` and require exit 0 with zero failed tests. Do not modify unrelated dirty files to make failures pass.

- [ ] **Step 3: Restart only Market Analyst and run the real A2A request**

Confirm the PID on port 4190 belongs to `panda-market-analyst`, stop only that process, and run `npm run market-agent`. Confirm `/health`, then send a fresh authenticated `hot-topic-analysis` request for `2026-07-23` and fetch the protected Evidence Pack.

Expected:

```text
TASK_STATE_COMPLETED
validateEvidencePack: PASS
required post-limit sources present
no credential values in response
```

- [ ] **Step 4: Inspect final scope**

Run `git diff --check HEAD^..HEAD` and `git status --short`. The implementation commit must contain only the plan, task service, and A2A regression test; all pre-existing unrelated changes must remain untouched.
