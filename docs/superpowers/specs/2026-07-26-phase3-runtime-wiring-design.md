# Phase 3 Runtime Wiring And Create-Time Readiness Gate

Date: 2026-07-26  
Status: approved for implementation  
Related: `2026-07-24-replica-arena-dual-track-rating`, `2026-07-26-parallel-replica-human-review-design`

## Goal

Wire production V2 black-box evaluations to Phase 3 Replica (Claude Code / Cursor / Doubao) so dual-track scoring is real, not UI fiction. Refuse to create a formal V2 evaluation when fewer than one Runtime is `runtimeReady`.

## Decisions

1. **Create gate (A + A1):** `POST /api/evaluations` for `schemaVersion === 2` calls the same readiness source as `GET /api/runtimes`. If `runtimeReady` count `< 1`, reject with `REPLICA_RUNTIME_NOT_READY` and a per-runtime summary (no secrets). Do not enqueue.
2. **Enforcement (E1):** Local CLI adapters reuse existing V1 CLI process paths via `localBuild` / `localRun`. Health declares hard budget enforcement; `assertNetworkDenied` satisfies the adapter contract. This is **declarative**, not OS-proven network isolation.
3. **Approach:** `createPhase3Services` + inject into `server.js` `blackBoxServices.phase3`. Prefer `createReplicaAdapter` contracts over bypassing into raw `buildSkill`/`runSkill`.
4. **Doubao / model-api:** Extend adapter (or phase3 factory) so `kind: 'model-api'` can build/run replica artifacts using `replicaBuildPrompt` / `replicaRunPrompt`.
5. **Runtimes in a run:** Only runtimes that were `runtimeReady` at create (or at phase3 construction) are included. Others are omitted, not silent-disabled as a whole track.
6. **Unavailable vs disabled:** After wiring, `disabled` means Phase 3 off (V1 / ineligible paths only). Zero valid replicas after attempt → `unavailable` / 「待复刻」, never “Phase 3 not plugged in”.

## When Replica is not used

| Case | Behavior |
|------|----------|
| Create-time 0 ready runtimes | Reject create — evaluation never starts |
| ≥1 ready at create; some fail at build/run | Those runtimes invalid; others continue |
| All attempted runtimes invalid after seal | `unavailable` / 「待复刻」 |
| V1 or black-box disabled | No Phase 3 |
| Qualification ineligible | No Replica (unchanged) |

## Components

- `src/phase3-services.js` — `createPhase3Services({ env, getRuntimeStatusFn })` → `{ enabled, runtimes, createAdapter|adapters }`
- Local bridge helpers for `localBuild` / `localRun` mapping package/artifact ↔ CLI
- `src/replica-adapter.js` — `model-api` execution path (if not fully owned by phase3 deps)
- `server.js` — inject `phase3`; gate V2 create on readiness
- UI — surface create rejection; live replica `activeWork` when Phase 3 runs

## Non-goals

- OS-level proven network deny (E2)
- Changing absolute score formula or letting Replica enter `resultV2.absolute`
- Requiring all three runtimes ready at create

## Acceptance

- With ≥1 `runtimeReady` runtime, a new V2 run enters Replica build/execute and shows replica progress.
- With 0 ready, create fails with `REPLICA_RUNTIME_NOT_READY`.
- Dual-track finalize rules unchanged (absolute locked + replica-human locked or unavailable).
