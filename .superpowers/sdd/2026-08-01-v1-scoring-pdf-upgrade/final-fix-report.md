# V1 final-fix report

## Scope

- Base commit: `d45211ef27da`
- Scope: V1 creation, execution/scoring hard gate, Card-review semantics, V1 Arena v2 audit presentation, PDF projection/download, public V2-control suppression, and the V1 release gate.
- Commit: this report is included in the scoped final-fix commit; its hash is reported after commit creation.

## RED evidence

The first targeted regression run executed 119 tests: 105 passed and 14 failed. Twelve failures reproduced the requested V1 gaps; two additional failures were sandbox `EPERM` errors from localhost integration tests and were rerun outside the sandbox.

The reproduced gaps covered:

1. fresh V1 records missing `schemaVersion: 1` and the create-to-report flow;
2. empty, whitespace-only, and non-string Runtime results incorrectly reaching scoring;
3. retry classification/CASE replacement coherence;
4. completed-page wording and valid zero-score reviewer counting;
5. missing execution capability and scenario-uncertainty audit fields;
6. incomplete Agent Card, runtime-context, and complexity projection in the PDF DTO;
7. public V2 controls pointing at routes intentionally blocked by Nginx;
8. the report filename and absence of an explicit V1-only release gate.

## Implemented fixes

- Fresh V1 evaluations persist `schemaVersion: 1` immediately and complete/report without requiring a store reload.
- Runtime output must be a non-blank string. Failed output is marked at `failureStage: final-output`, receives zero capability/total, and is never sent to the model judge. Retry replacement remains atomic.
- The completed triad now describes Agent Card design quality and counts every error-free finite review, including a legitimate score of zero.
- V1 Arena v2 audit rendering exposes execution state, success/latency/capability scores, end-to-end wall-clock scope, network/protocol inclusion, unavailable tool observation, failure state, and escaped scenario uncertainty.
- PDF projection now preserves accepted public Agent Card structures, real runtime-context usage fields, and the actual complexity dimension names while continuing to exclude unknown top-level/private values.
- Public retained-V2 views no longer expose evidence, Skill, or raw-output controls whose endpoints are private.
- Downloads use `agent-review-<safe-id>.pdf`.
- Production promotion uses the fixed `test:v1-release` suite plus syntax validation. The runbook explicitly prohibits claiming that the known non-green full V2 suite passed.

## Changed files

- `src/pipeline.js`
- `src/v1-model-scoring.js`
- `src/v1-report.js`
- `public/app.js`
- `public/index.html`
- `public/result-v2.js`
- `server.js`
- `package.json`
- `docs/PRODUCTION_OPERATIONS.md`
- `test/api.test.js`
- `test/deploy-config.test.js`
- `test/evaluation-version-ui.test.js`
- `test/pipeline-control.test.js`
- `test/result-ui.test.js`
- `test/v1-model-scoring.test.js`
- `test/v1-report-route.test.js`
- `test/v1-report.test.js`

## GREEN evidence

- `npm run test:v1-release` — 140/140 passed in the working tree and again from the exact exported staged tree.
- `node --test --test-name-pattern="creates a V1 demo evaluation from agentExamples|downloads a completed V1 report" test/api.test.js` — 2/2 passed outside the sandbox and again from the exact staged tree.
- `npm run check` — syntax OK for the exact staged tree's 204 JavaScript files (and for all 206 files in the dirty working tree, including unrelated user changes).
- `git diff --check` — passed.

## Self-review and remaining concerns

- Each of the eight final-review findings has direct regression coverage and a production change where required.
- The full `npm test` suite is deliberately not a V1 release criterion because retained V2 has documented known non-green coverage; no full-suite-green claim is made.
- Previously parked PDF-parser defense-in-depth hardening remains outside this V1 scope. The route still accepts bytes only from the fixed ReportLab renderer and its focused malformed-output tests pass.
- The previously parked homepage destination tokenizer remains a test-strength concern only. Production has no judge/appeal links and Nginx blocks those paths.
- Push and remote deployment are intentionally left to the parent release step after this scoped commit is reviewed.
