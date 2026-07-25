# Task 6 Report — Absolute-lock release gate

## Implemented

- Added `releaseReplicaArena(evaluation, services)` with a synchronous absolute-lock guard:
  `governance.phase === 'absolute_locked'`, ISO `absoluteLockedAt`, and matching
  SHA-256 governance/absolute `resultHash` are all required.
- Preserved one-way arena results: sealed can become released or unavailable; an
  already released result is returned unchanged.
- Released output reuses the locked absolute result, runs the anonymous arena,
  bootstrap advantage, and dual-track rating without adding Replica values to
  absolute dimensions or total.
- Added the unavailable / `PENDING_REPLICA` / `待复刻` path when no valid
  Runtime exists.
- Kept pre-lock projections and UI sealed, and added a server-driven released
  renderer plus methodology for the counterfactual interpretation and thresholds.

## Verification

- `node --test test/pipeline-replica-arena.test.js test/evaluation-projection.test.js`
  passed: 12 tests, 0 failures.
- `npm run check` passed: `Syntax OK · 147 JavaScript files`.
- `git diff --check` passed.
- The requested three-file test command has two unrelated existing failures in
  `test/api.test.js`: its cache-key assertion expects `app.js?v=20260725-a2a1`
  while `public/index.html` currently serves `app.js?v=20260725-examples1`, and
  its diagnostics-helper assertion expects an inline `skills` reference while
  `public/agent-check-helpers.js` delegates to `allSkillExampleTexts`.
  Task 6 API assertions pass.

## Repair round 1

- Projection now treats a `released` Replica record as sealed unless its
  absolute-lock commitment is valid and `replicaReleasedAt` is present; stale
  pre-lock runtime IDs, medians, delta, interval, and rating are not published.
- The release path now reconstructs arena inputs from the committed test plan,
  submitted Phase 2 outputs, sealed Replica checkpoint evidence, and encrypted
  evidence vault before invoking the anonymous arena.
- The browser renderer applies the same absolute-lock/release gate and renders
  locked absolute results with `待复刻` messaging for unavailable Replicas.
- Verification: `node --test test/pipeline-replica-arena.test.js
  test/evaluation-projection.test.js` passed (14 tests, 0 failures); `npm run
  check` and `git diff --check` passed.

## Repair round 2

- Public governance projection now allowlists `resultHash` alongside
  `absoluteLockedAt` and `replicaReleasedAt`, so the browser release gate can
  verify the immutable absolute-lock commitment from server-provided state.
- The V2 renderer applies the same SHA-256 `resultHash` validation as
  `hasAbsoluteLock()` and requires `absoluteLocked` before rendering released
  or unavailable replica panels.
- Added projection and pipeline tests asserting public governance lock fields
  survive release, plus API source assertions for the aligned UI gate.
- Verification: `node --test test/pipeline-replica-arena.test.js
  test/evaluation-projection.test.js` passed (15 tests, 0 failures); `npm run
  check` and `git diff --check` passed.
