# Phase 3 Task 4 Report

Status: DONE

Commit: `63b6092 feat: judge agent and replicas anonymously`

## Files changed

- `src/arena.js`
- `src/prompts.js`
- `src/providers.js`
- `test/anonymous-arena.test.js`
- `test/prompts.test.js`
- `test/providers.test.js`

## Delivered

- Builds one arena cell per `testId × repeatIndex`, with submitted output and valid
  Replica outputs on the same task input, constraints, and expected deliverable.
- Creates deterministic opaque candidate labels and judge-specific deterministic
  candidate ordering. Packets project only task data and output Parts/artifacts,
  excluding source identifiers and execution metadata.
- Uses the frozen four-primary review panel only; arena requests are independent,
  derived-seed calls and never use arbitration context.
- Adds a comparison-only JSON prompt, validates every returned candidate and
  dimension, and recalculates totals server-side as 40/30/20/10.
- Persists reveal maps as encrypted evidence-vault records and returns separate
  anonymous and internally revealed scoring cubes.

## Test evidence

Passed:

```text
node --test test/anonymous-arena.test.js test/prompts.test.js test/providers.test.js
# 22 tests passed, 0 failed

git diff --check
# exit 0
```

The arena tests were written and observed failing before `src/arena.js` existed,
then passed after implementation. An additional nested-output metadata leakage
test was added during self-review, observed failing, and passed after the packet
projection was hardened.

## Self-review

- Completeness: all four requested interfaces are exported and covered.
- Anonymity: candidate labels are opaque; source/runtime/model/protocol/latency
  metadata and nested artifact metadata are excluded from judge packets.
- Discipline: the commit includes only the six requested Task 4 files. Unrelated
  V2 run-log work remains unstaged. No push was performed.
- Scope: release, absolute-score lock, bootstrap advantage, and rating wiring
  were intentionally not changed.

## Concerns

None for Task 4 scope. Task 5/6 must consume `scoringCube` only after the
existing absolute-lock gate is wired; this task deliberately does not add that
release path.

## Repair round 1

- `normalizeCell()` now whitelists the shared task fields only (`input`,
  `constraints`, and optional `expectedDeliverable`) before any judge packet is
  constructed.
- URL snapshots now require the exact locked metadata shape
  (`reference`, `mediaType`, `byteLength`, `sha256`) before being included in
  projected output Parts.
- Judge-reported totals must be finite values in the 0–100 range before the
  server recalculates the authoritative weighted total.
- Added regression coverage for malicious task fields, malformed URL snapshots,
  and negative or over-range reported totals.
