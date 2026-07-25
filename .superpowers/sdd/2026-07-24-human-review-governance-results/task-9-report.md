# Phase 4 Task 9 — Complete governed evaluation verification

**Status:** DONE_WITH_CONCERNS  
**Date:** 2026-07-25

## Commands

- `npm test` passed after the verification fixes: Node TAP reports `821` passed,
  `0` failed, `24` skipped; the market-worker suite reports `87` tests passed.
- `npm run check` passed: `Syntax OK · 169 JavaScript files`.
- `git diff --check` reports trailing whitespace in the unrelated, already-modified
  `.superpowers/sdd/2026-07-24-human-review-governance-results/task-3-report.md`
  (lines 3-4). The scoped check excluding that file passed. It was not changed.

## Verification fixes

Three stale test fixtures were corrected without changing production behavior:

1. `test/api-v2.test.js` now enables review governance and supplies the current
   hash-backed `REVIEW_PRINCIPALS_JSON` judge credential. The legacy
   `JUDGE_PREVIEW_ACCESS_KEY` no longer authenticates the route.
2. `test/evaluation-model.test.js` includes the review-assignment, human-review,
   and human-aggregate fields now created by `createEvaluationRecord()`.
3. `test/evidence-vault.test.js` supplies the required admin principal when
   requesting an admin projection.

## Governed-chain coverage

The suite covers the required fixture transitions as a composed integration
chain:

| Transition / invariant | Coverage |
| --- | --- |
| V2 creation, qualification, four test types × three repeats | `test/api-v2.test.js` create flow; `test/black-box-pipeline.test.js` “executes the exact four-test by three-repeat matrix...” and “locks a complete four-type matrix...” |
| Four model reviews and required fifth decision | `test/review-governance.test.js` “opens human review only after four model reviews and required fifth decision” |
| Two primary human reviews and `>15` arbitration | `test/review-governance.test.js` “submits immutable primary reviews and triggers per-leaf arbitration above 15 points” |
| Absolute lock, deterministic server calculation, idempotency, immutable hash | `test/result-v2.test.js` “locks only a server-calculated absolute result...” and “refuses an absolute lock...” |
| Post-lock Replica release / no-valid-Replica final state | `test/pipeline-replica-arena.test.js` release gate tests and `test/result-v2.test.js` “locks and releases the Replica Arena to final pending status” |
| Bootstrap Δc, rating, and guarded humor | `test/bootstrap-rating.test.js`, `test/pipeline-replica-arena.test.js`, and `test/humor.test.js` |
| Participant appeal, confirmed replacement, append-only version | `test/appeals.test.js`, `test/api.test.js` appeal APIs, and `test/appeal-recalculation.test.js` “recalculation runs the complete ordered chain and appends a result version” |

`appeal-recalculation.test.js` asserts the full ordered replacement sequence:
evidence → acceptance → objective → model → human → arbitration → absolute →
arena → bootstrap → rating → humor; it also asserts that the original locked
absolute result is not overwritten.

## Role-leak audit

- `test/evaluation-projection.test.js` tests participant, judge, public, admin,
  and judge-preview projections; verifies secret redaction, distinct allow-lists,
  pre-lock Replica sealing, stale-release resealing, and post-lock
  server-released summaries only.
- `test/api-v2.test.js` now verifies the judge-preview API rejects unauthenticated
  access and returns no Replica material to an authenticated judge.
- `test/review-governance.test.js` rejects admin-only evidence citations.
- Search and static inspection of `public/judge.js` confirmed that the judge
  surface shows the seal notice until absolute lock and keeps the Bearer token
  in page memory; `test/judge-ui.test.js` prohibits browser storage, cookies,
  and `innerHTML`.

No credential, PII, signed-URL, hidden-test, reveal-map, other-judge draft, or
pre-lock Replica leakage was found in the tested projections.

## Formula and UI boundaries

- `test/judge-panel.test.js` covers model range `20` and model confidence below
  `0.60` arbitration triggers.
- `test/review-governance.test.js` covers human spread above `15` and primary
  review immutability.
- `test/objective-scoring.test.js` covers exact `0.70` objective coverage and
  the value immediately below it.
- `test/bootstrap-rating.test.js` covers bootstrap percentiles, valid Replica
  selection, `Δc` interval stability, 夯 / 人上人 / NPC boundaries, no-valid
  Replica, and ineligible results.
- `test/result-v2.test.js` covers fixed 40/60 and 50/20/30 seat calculations,
  objective redistribution, evidence gaps, and no Replica input to the
  absolute result.
- `test/humor.test.js` covers post-lock-only, evidence-grounded rewrite output.
- `test/judge-ui.test.js` and `test/result-ui.test.js` statically verify the
  judge, result, and evidence IDs/states. `public/appeal.html` exposes the
  participant form, status region, target selector, and append-only timeline.

## Audit chain and vault

- `test/evidence-vault.test.js` verifies AES-256-GCM round trips, append-only
  evidence IDs, duplicate write rejection, payload/record hash commitments,
  ciphertext/tag/AAD tamper rejection, and copy/replacement rejection.
- `test/access-audit-store.test.js` verifies the event `previousEventHash` link
  and 64-character event hashes.
- `test/result-v2.test.js` verifies the absolute-lock audit event and frozen
  result object.

## Concerns

1. The end-to-end governance path is covered by linked unit/integration tests,
   but there is no single persisted fixture that drives every listed transition
   in one process.
2. Page validation was static; no interactive browser pass was run because this
   task did not start a stable main-server fixture for UI interaction.
3. The unrelated Task 3 SDD report still has two trailing-whitespace errors.
