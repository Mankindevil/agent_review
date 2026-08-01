# Task 4 report — V1 execution capability audit

## RED

After adding the execution-audit tests, before production changes:

```text
$ node --test test/pipeline-control.test.js test/pipeline-panda-runtime.test.js
✖ V1 v2 benchmark retry replaces the execution snapshot before rescoring the complete CASE
  AssertionError: expected execution record, received undefined
✖ V1 v2 records failed calls and build failures as zero-capability executions
  AssertionError: expected completed, received failed
✖ V1 pipeline supplies the Panda interface and credential-free query gateway to every Runtime build and run
  AssertionError: 0 !== 3
```

The Panda test failed because `onContextUsage` was not passed into Runtime build/run calls; V1 v2 retry had no replacement execution record; and v2 scoring correctly rejected entries with no authoritative execution.

## GREEN

```text
$ node --test test/pipeline-control.test.js test/pipeline-panda-runtime.test.js test/v1-model-scoring.test.js
tests 66
pass 66
fail 0

$ npm run check
Syntax OK · 203 JavaScript files
```

The pipeline-control invocation was run outside the restricted sandbox because two pre-existing tests bind temporary localhost HTTP ports; it passed all 46 pipeline/panda tests.

## Changes

- Added injected `monotonicNow` and one execution measurement helper; the resulting rounded duration is stored in `entry.execution` and reused by the matching benchmark/retry log.
- Every new V1 benchmark entry now carries the declared end-to-end execution contract: status, duration, network inclusion, unavailable tool observation, and collected Runtime context usage.
- Passed `onContextUsage` to Runtime build/run calls, persisted build trace usage, and attached run usage to the corresponding entry execution.
- Recorded runtime-call failures with their measured duration; represented build failures as zero-duration `failureStage: "skill-build"` entries so v2 scoring hard-zeros capability.
- Kept retry atomic by scoring the detached complete CASE before committing it, while replacing the candidate execution snapshot once scoring succeeds.
- Restored historical V1 retry routing when a stored record lacks `scoringConfig`, inferring the legacy contract from the saved judging/legacy dimensions instead of reinterpreting it as v2.

## Files

- `src/pipeline.js`
- `test/pipeline-control.test.js`
- `test/pipeline-panda-runtime.test.js`

## Self-review / concerns

- `contextUsage` is intentionally diagnostic metadata: it is retained in the persisted entry/build trace but is not supplied to the model judge.
- The actual internal tool-invocation duration remains unavailable; the stored duration is explicitly end-to-end wall-clock and includes network/protocol/runtime/model work.
- Existing V2 code paths were not changed; only V1 entry creation/retry scoring behavior was touched.

## Fix round 1 — monotonic clock authority

### RED

```text
$ node --test --test-name-pattern='undefined, NaN|end monotonic clock' test/pipeline-control.test.js
✖ V1 rejects undefined, NaN, Infinity, and thrown monotonic clock starts instead of assigning zero-duration capability
  expected failed, received completed
✖ V1 v2 retry keeps the prior CASE when the end monotonic clock is unavailable
  retry history exposed the raw clock error rather than a declared timing failure
```

### GREEN

```text
$ node --test --test-name-pattern='undefined, NaN|end monotonic clock|V1 v2 benchmark retry|Panda interface' test/pipeline-control.test.js test/pipeline-panda-runtime.test.js
tests 4
pass 4
fail 0
```

`readMonotonic` now rejects undefined, NaN, Infinity, and thrown clock reads with an explicit timing error. `executionSnapshot` also rejects non-finite durations rather than coercing them to zero. A timing error blocks the fresh run; during retry it is caught before the detached CASE can commit, so the prior complete CASE remains intact and no scorer call receives a fabricated 0ms record.
