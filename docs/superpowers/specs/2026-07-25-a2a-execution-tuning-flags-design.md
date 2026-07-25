# A2A Execution Tuning Flags Design

**Date:** 2026-07-25  
**Status:** Approved for implementation

## Problem

Formal Phase 2 execution is wall-clock bound by sequential A2A calls. A 7-example submission plans ~108 agent turns (4 variants × 3 repeats, with multi-turn adding a second turn). Local smoke runs take hours.

## Decision

Two independent environment flags (opt-out / override):

| Flag | Default | Meaning |
|---|---|---|
| `A2A_MULTI_TURN_ENABLED` | enabled unless exact `false` | When `false`, do not generate, require, or execute hidden `multi-turn` variants. Original examples that already have multiple turns still run. |
| `A2A_REPEAT_COUNT` | `3` | Positive integer applied to Phase 1 cells and Phase 2 `repeatCount` / `defaultRepeatCount`. Invalid or missing → `3`. |

Recommended local smoke: `A2A_MULTI_TURN_ENABLED=false` and `A2A_REPEAT_COUNT=1`.

## Behavior

1. Required hidden variants become `equivalent` + `boundary` (+ `multi-turn` only when enabled).
2. Per-example scored weight is split evenly across `1 + requiredHiddenVariants.length` tests (original + each required hidden variant).
3. Already-locked `testPlan` on resume is not rewritten.
4. Out of scope: example caps, skipping equivalent/boundary, parallel A2A dispatch.

## Wiring

- `readA2AExecutionTuning(env)` returns `{ multiTurnEnabled, repeatCount, requiredHiddenVariants }`.
- Thread into Phase 1 policy, `createPhase2Services`, `finalizeTestPlan`, and slot-completeness checks.
- Document in `.env.example` and README env table.
