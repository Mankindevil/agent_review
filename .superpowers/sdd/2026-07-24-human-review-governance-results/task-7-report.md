# Task 7 delivery report

## Implemented

- Added append-only appeal records, immutable original snapshots, event timelines, participant ownership, a 72-hour configurable appeal window, and idempotent creation.
- Added fixed probe attribution. Only confirmed platform faults may authorize exactly one same-config replacement; Agent and Replica failures do not qualify.
- Added the ordered `runAppealResultVersion` orchestration contract, which appends immutable `resultVersions` and leaves the locked absolute result unchanged.
- Added participant and admin appeal APIs, all POST-protected by `Idempotency-Key`, plus the participant appeal page and navigation.

## Verification

- `node --test test/appeals.test.js test/appeal-recalculation.test.js test/failure-attribution.test.js test/api.test.js` — 59 passing.
- `npm run check` — `Syntax OK · 169 JavaScript files`.

## Scope note

`git diff --check` reports pre-existing trailing whitespace in the unrelated Task 3 report. It was not changed by Task 7.

## Repair round 1

- Triage and replacement authorization now derive attribution from submitted fixed probes; raw admin-supplied attributions cannot authorize a platform replacement.
- Admin replacement and sustained-recalculation routes invoke the injectable result-version workflow, appending a new immutable result version without changing the original locked absolute.
- Participant projections now expose safe appeal targets from manifest-backed test and evidence IDs, and project result-version metadata for before/after display in the appeal UI.
- API coverage verifies the probe gate, recalculation double invocation, appended `resultVersions`, locked-original preservation, and participant target projection.
- `node --test test/appeals.test.js test/appeal-recalculation.test.js test/failure-attribution.test.js test/api.test.js` — 61 passing.
- `npm run check` — `Syntax OK · 169 JavaScript files`.
