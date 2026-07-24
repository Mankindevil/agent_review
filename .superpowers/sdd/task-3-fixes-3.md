# Phase 1 Task 3 third repair report

Baseline: `1433d2614a75076f0325dfbab94f4beed35afcf1`

## RR2-I-1: evaluation window versus frozen submission

- Removed `evaluationWindow` from `freezeSubmission()`.
- Added `{ firstRunAt: null, lastRunAt: null }` as top-level V2 evaluation runtime state.
- Added public/admin projection allow-listing for those two fields only.
- Added Store regression coverage proving top-level window timestamps can change through `mutate()` while arbitrary deep submission changes still fail and leave stored state intact.
- Synchronized Task 2 and Task 6 plan paths so runtime code updates `evaluation.evaluationWindow`, never `evaluation.submission`.

## RR2-I-2: canonical manifest commitment

- Added `createEvidenceManifestItem(record, { summary, visibility, secrets })` as the canonical EvidenceRecord-to-manifest path.
- Added strict `validateEvidenceManifestItem(item)` validation for the closed shape, IDs, coordinates, ISO timestamp, SHA-256 hashes, visibility/redaction values, closed kind-grade contract, and the recomputed `recordHash` commitment.
- The builder sets `occurredAt = capturedAt`, includes required coordinate keys using `null` when absent, copies `payloadHash` and `recordHash`, defense-redacts the summary, and generates immutable redaction metadata.
- Projection now validates each item first and omits missing, malformed, unknown-field, closed-kind, or commitment-mismatched items.
- Replaced API and projection literals with records and items created by the canonical APIs; `platform-timing` replaces the invalid `timing` kind.
- Added the real `createEvidenceRecord` → `EvidenceVault.put` → manifest builder → public/admin projection → `EvidenceVault.get(evidenceId, projected.recordHash)` round trip.
- Synchronized the Phase 1 EvidenceRecord, envelope, AAD, Vault get, manifest, and Task 6 consumption contracts. The later governance plan now explicitly passes the projected manifest commitment into `EvidenceVault.get`.

## Verification

```text
npm test -- test/submission.test.js test/evaluation-model.test.js test/a2a.test.js test/evidence.test.js test/evidence-vault.test.js test/evaluation-projection.test.js test/store.test.js test/api.test.js
101 passed / 0 failed

npm test
171 passed / 0 failed

npm run check
Syntax OK · 54 JavaScript files

git diff --check
exit 0
```
