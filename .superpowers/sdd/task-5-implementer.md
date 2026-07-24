# Phase 1 Task 5 Implementer Record

## Scope

Implemented executable acceptance, the frozen V1 rubric, six objective-capability
metrics, aggregation, and confidence math. The only compatibility changes outside
the original Task 5 files are the authorized `caseSensitive` and numeric tolerance
updates in the submission schema, normalizer, and tests.

No pipeline, server, UI, executor, vault, legacy scoring, Task 6 integration, final
three-dimension result, final rating, replica result, or roast was added.

## Dependency

- First ordinary `npm install --save-exact ajv@8.17.1` attempt failed with sandbox
  network `EACCES`.
- Re-ran the same narrowly scoped command with approved network access.
- `package.json` and `package-lock.json` both lock Ajv exactly to `8.17.1`.
- Acceptance uses `ajv/dist/2020.js`, synchronous compilation, a fresh Ajv instance
  per schema, and no remote loader.

## RED evidence

1. Submission compatibility:
   - `npm test -- test/submission.test.js`
   - 16 passed, 3 failed as expected: closed schema lacked `caseSensitive`,
     normalization dropped `caseSensitive:false`, and omitted numeric tolerance
     remained undefined.
2. Acceptance:
   - Initial acceptance run failed because `src/acceptance.js` did not exist.
   - Adversarial follow-up RED exposed async-schema handling, cross-call candidate
     selection/accessor safety, and native Artifact-kind selection.
3. Objective scoring:
   - Initial objective run failed because `src/objective-scoring.js` did not exist.
   - Planned applicability follow-up RED rejected the newly locked
     `plannedTests[].requiredExecutable` field until implemented.
   - Closed-observation follow-up RED proved acceptance objects/checks still
     accepted injected fields before the boundary was tightened.
4. Confidence:
   - Initial confidence run failed because `src/confidence.js` did not exist.

Production changes were made only after the corresponding failing tests.

## GREEN evidence

- Submission focused: 19/19 passed.
- Acceptance focused: 11/11 passed.
- Objective scoring focused: 18/18 passed.
- Confidence focused: 10/10 passed.
- Required combined focused command: 58/58 passed.
- Full root suite: 288/288 passed.
- `npm run check`: `Syntax OK · 63 JavaScript files`.
- `git diff --check`: exit 0; only Git line-ending notices were emitted.

## Locked interface decisions

### Submission and acceptance

- `contains.caseSensitive` is an optional boolean. Omission means case-sensitive;
  an explicit `false` is preserved in the frozen canonical submission and hash.
- Omitted numeric tolerance freezes to `0`; the evaluator also uses `?? 0`.
- Structured evaluation consumes only the caller-supplied current-turn final
  projection. It never parses prose JSON or searches history/status content.
- Direct own `data` wins when non-null/defined, including falsy values. Otherwise
  the first eligible Artifact and its first own data Part win. Native eligible
  shapes are V1 `{ data }` and V0.3 `{ kind: "data", data }`. Accessors,
  inherited data, other kinds, and later passing Artifacts cannot be selected.
- Ajv rejects async schemas and every non-fragment `$ref`, does not coerce,
  default, remove, mutate, load remotely, or retain duplicate `$id` state across
  calls.

### Objective observations and attribution

- `plannedTests[].requiredExecutable` is a required non-negative safe integer
  frozen from the planned turn criteria. It determines `testSuccess`
  applicability even when all cells are missing, platform-attributed, or pending.
- Each run acceptance summary must match that planned count and be internally
  consistent with its closed, duplicate-free required-check vector,
  `passedRequiredExecutable`, and `semanticSuccess`.
- Duplicate repeat cells are rejected; no latest/best-of selection exists.
- Agent-attributed failures remain scored. Platform and pending cells lower
  coverage and create distinct stable gaps.
- Context applicability comes only from explicit `contextChecks`, including
  isolation-only plans.

### Evidence boundary

- Task 5 accepts pipeline-attributed observations and does not claim to validate
  evidence provenance, record commitments, grades, or coordinates.
- Task 5 validates evidence IDs as safe identifiers and deduplicates them in
  stable first-seen order. IDs and grades cannot change objective scores.
- Task 6 owns the trusted-manifest/recordHash and test/turn/repeat provenance gate.
  No new evidence kind was introduced.

### Partial and unavailable scoring

- Robustness scores only observable terminal/result component weight; missing
  components lower coverage and are not converted to disagreements.
- Aggregation uses canonical rubric weights only. Applicable metrics with
  `score:null` never coerce to zero:
  - at least one scorable metric plus an applicable-unscored metric:
    `status:"incomplete"`;
  - no scorable metric: `status:"unavailable", score:null`.
- N/A metrics are excluded from the score denominator but keep their original
  zero coverage contribution. Coverage exactly `0.70` is not provisional.

### Confidence shapes

- Successful confidence results use `{ status:"complete", value }` with optional
  components.
- No model scores returns exactly
  `{ status:"pending-model-review", value:null }`.
- Final stage without human scores returns
  `{ status:"pending-human-review", value:null }`.
- Dimension items are
  `{ id, weight, applicable, confidence:{ status, value } }`; N/A is excluded and
  applicable pending status propagates.
- Total confidence consumes the named
  `scenarioValue`/`professionalism`/`agentCapability` object. Pending or
  unavailable status propagates; complete zero remains a valid zero.
