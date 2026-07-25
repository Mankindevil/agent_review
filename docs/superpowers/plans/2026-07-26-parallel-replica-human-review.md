# Parallel Replica Human Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run absolute human review and Replica (Arena + human quality scores) as dual tracks; finalize rating only when both are ready; human Runtime scores merge into the Arena cube as equal-weight judge channels.

**Architecture:** Split `lockAbsolute` from replica release. After model panel lock, absolute stays in `human_open` while a sealed Replica opens `replica_human_open` (model Arena stored sealed). Replica-human submissions lock the replica track. `finalize-dual-track` merges model+human cube → bootstrap Δc → rating → `final`.

**Tech Stack:** Node.js ESM, existing `arena.js` / `statistics.js` / `rating.js` / `arena-release.js` / `result-v2.js` / `review-governance.js`, `server.js` HTTP API, `public/` desk UI, `node --test`.

## Global Constraints

- Absolute totals never recompute from Replica or replica-human scores.
- `lock-absolute` / absolute skip / absolute human submit must NOT call `releaseReplicaArena` or emit final rating while replica track is open.
- Default `replicaReviewPolicy`: `{ visibility: "full_blind", requiredPrimaries: 1, forceSeparateJudges: false }`; freeze after first replica-human submission.
- Skip absolute human does not skip replica-human when valid Replicas exist.
- No provisional public FINAL until dual finalize (or replica unavailable).
- Open-review style: no admin assignment required for replica-human; first `requiredPrimaries` complete submissions satisfy the gate.
- Pragmatic pipeline note: keep Phase-3 seal before/at model lock if already implemented; on model lock + sealed valid replicas, open `replica_human_open` and run model Arena into `replicaArena.modelScoringCube` without waiting for absolute lock. Do not require `absolute_locked` before replica-human scoring.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/replica-human-review.js` (new) | Policy defaults/freeze, submit/lock replica-human, arbitration when requiredPrimaries≥2 |
| `src/arena-cube-merge.js` (new) | Broadcast human source composites onto cube cells; per-cell median collapse |
| `src/arena-release.js` | Split: run sealed model Arena; finalize dual-track merge+rating; stop requiring absolute_locked for Arena run |
| `src/result-v2.js` | `lockAbsoluteResult` only; remove release from `lockAndReleaseAbsoluteResult` or rename and update callers |
| `src/review-governance.js` | Phases/sub-flags; wire absolute lock without finalize |
| `src/black-box-pipeline.js` | After model lock: open replica track / run model Arena; absolute skip → lock absolute only + maybe auto-finalize if replica unavailable |
| `src/evaluation-model.js` | Default `governance.replicaReviewPolicy`, replica-human collections |
| `src/evaluation-projection.js` | Track status UI fields; visibility masking for replica materials |
| `server.js` | Routes: set policy, submit replica-human, lock-absolute (absolute only), finalize-dual-track; fix skip/human-reviews |
| `public/app.js`, `public/judge.js`, `public/result-v2.js`, HTML/CSS | Create/policy controls; dual-track sub-status; replica quality desk; skip absolute ≠ finalize |
| `test/*.test.js` | Unit merge, governance dual-gate, API happy path |

---

### Task 1: Cube merge unit (TDD)

**Files:**
- Create: `src/arena-cube-merge.js`
- Create: `test/arena-cube-merge.test.js`

- [ ] Write failing tests: broadcast one human primary onto all cells; median across model+human judges; invalid replicas omitted
- [ ] Implement `mergeHumanJudgesIntoCube(modelCube, humanReviews, validReplicaIds)` and `collapseCubeToScoreCells(cube)`
- [ ] Run `node --test test/arena-cube-merge.test.js` — pass
- [ ] Commit

### Task 2: Replica review policy + submit/lock (TDD)

**Files:**
- Create: `src/replica-human-review.js`
- Create: `test/replica-human-review.test.js`
- Modify: `src/evaluation-model.js`, `src/review-governance.js` (phases/flags as needed)

- [ ] Tests: default policy persist; freeze after first submit; `requiredPrimaries=1` lock; `forceSeparateJudges` rejects absolute-track principal; spread>15 with requiredPrimaries=2 needs arbitrator
- [ ] Implement policy + `submitReplicaHumanReview` + `lockReplicaHumanReview` with receipt hash/idempotency fields on evaluation
- [ ] Run focused tests — pass
- [ ] Commit

### Task 3: Isolate lock-absolute from release + finalize-dual-track

**Files:**
- Modify: `src/result-v2.js`, `src/arena-release.js`, `src/review-governance.js`
- Modify: `test/result-v2.test.js`, `test/pipeline-replica-arena.test.js`

- [ ] Change callers: absolute lock paths use `lockAbsoluteResult` only
- [ ] Extract/ensure sealed model Arena can run without absolute lock; store `replicaArena.modelScoringCube`
- [ ] Implement `finalizeDualTrack(evaluation, services, actor)`: gate absolute locked + (replica_human_locked OR unavailable); merge cube; bootstrap; rating; `final`
- [ ] Update old `releaseReplicaArena` tests to new split (or thin wrapper deprecated)
- [ ] Commit

### Task 4: Pipeline open replica track after model lock

**Files:**
- Modify: `src/black-box-pipeline.js`
- Modify: `test/black-box-pipeline.test.js`

- [ ] After model panel lock: if sealed valid replicas, ensure model Arena cube present and set replica track open (`replica_human_open` / flags); if no valid replicas mark unavailable
- [ ] Absolute `skipHumanReview` → lock absolute only; auto-finalize only if replica unavailable or already replica-human locked
- [ ] Commit

### Task 5: HTTP API

**Files:**
- Modify: `server.js`, `test/api.test.js`

- [x] `PUT/POST` policy before first replica-human submit
- [x] `POST /api/evaluations/:id/replica-human-reviews` submit
- [x] `POST .../lock-absolute` absolute only (admin or open — match existing open-review style)
- [x] `POST .../finalize-dual-track` idempotent
- [x] Fix skip-human-review and human-reviews to lock absolute only + auto-finalize when dual gate met
- [x] Commit

### Task 6: Projection + UI

**Files:**
- Modify: `src/evaluation-projection.js`, `public/app.js`, `public/judge.js`, `public/result-v2.js`, related HTML/CSS/tests

- [ ] Expose track statuses / missing-track copy 「等绝对分」/「等复刻人工」/「等双轨」; FINAL only after finalize
- [ ] Judge/detail: replica quality scoring form (four Arena dims × sources) + finalize if needed
- [ ] Create/ops: optional policy controls (visibility, requiredPrimaries, forceSeparateJudges)
- [ ] Commit

### Task 7: Acceptance sweep

- [ ] Run full `node scripts/run-tests.js` (or project test script); fix regressions
- [ ] Verify acceptance bullets from the design spec
- [ ] Commit + push

## Spec Self-Check

- Parallel dual-gate covered
- Human cube merge covered
- lock-absolute isolation covered
- Policy + forceSeparateJudges covered
- UI sub-status covered
