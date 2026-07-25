# Phase 4 Task 3 Report

Hardened the absolute-result lock so it calculates and persists only the
server-derived result, while retaining idempotency-key request binding. The
post-lock orchestrator now releases the sealed Replica Arena, records the
`absolute_locked → replica_released → final` path (or directly final with
`待复刻`), and is reachable through the authenticated admin lock endpoint.

Confidence now preserves uncited compiled checks as zero-evidence gaps,
non-applicable objective metrics are redistributed across applicable metrics,
and an arbitration must contain complete scored fifth-model coverage for every
disputed leaf.

Verification:

```text
node --test test/result-v2.test.js test/confidence.test.js test/review-governance.test.js test/pipeline-replica-arena.test.js test/evaluation-projection.test.js test/api.test.js
87 passed, 0 failed

node scripts/check-syntax.js
Syntax OK · 155 JavaScript files

git diff --check
exit 0
```
