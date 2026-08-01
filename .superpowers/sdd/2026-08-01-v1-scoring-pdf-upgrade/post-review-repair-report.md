# Post-review release blocker repair

Date: 2026-08-02

Base: `136c4de`

Commit: `fix: clear V1 release blockers` (this report is included in that scoped commit)

## Scope

This repair clears the three blockers from the final review without changing the V1 scoring contract:

1. Prevent accepted Agent Card nested credentials, accessors, or prototypes from entering the V1 PDF DTO.
2. Keep retained public V2 history/detail passive and remove controls for blocked/private endpoints.
3. Make PDF release tests resolve Python from environment or the repository `.venv`, with no developer-host path in release tests.

## RED evidence

### Initial blocker probes

Command:

```sh
node --test --test-name-pattern='accepted Card projections|retained V2 public states|production loadHistory|production V2 history|passive dual-track|resolves report Python|V1 release runbook' test/v1-report.test.js test/deploy-config.test.js test/result-ui.test.js
```

Result: `7` tests, `2` passed, `5` failed as intended.

- Accepted Card projection invoked a nested getter (`accessorReads: 1`) and copied credential-bearing nested fields.
- Human-open V2 emitted `data-skip-human-review`.
- Dual-track-ready V2 emitted `data-finalize-dual-track` and `/judge.html`.
- The static recovery panel and `/resume` handler remained public.
- Running/completed V2 history emitted a DELETE control even though production Nginx allows only GET on detail.

### Extension-array accessor probe

Command:

```sh
node --test --test-name-pattern='accepted Card projections' test/v1-report.test.js
```

Result: `1` failed as intended because `Array.prototype.slice` invoked an accessor-backed extension element.

### Fully read-only V2 running-state probe

Command:

```sh
node --test --test-name-pattern='retained V2 public states' test/deploy-config.test.js
```

Result: `1` failed as intended because the shared stop button was still visible for a running V2 record.

## Implementation

### V1 PDF Card security boundary

- Replaced permissive recursive Card copying with field-specific projections for provider, security schemes, OAuth flows, security requirements, signatures, capabilities, skills, and interfaces.
- Kept public OAuth endpoint fields such as `tokenUrl` and public scheme names such as `bearer`, while excluding credential values such as `token`, `clientSecret`, `apiToken`, and `password`.
- Added a bounded arbitrary-metadata projector only for extension containers: maximum depth, node count, item count, and string length.
- Sensitive key detection is case-insensitive, separator-insensitive, NFKC-normalized, and decodes percent-encoded key variants before filtering.
- Extension maps/lists use own data-property descriptors, skip accessors without invoking them, reject inherited prototypes from projection, and exclude prototype-control keys.

### Retained V2 public read-only surface

- Removed skip-human-review, finalize-dual-track, judge navigation, resume form/handler, Replica Skill fetch, and Replica raw-output fetch from the public bundle.
- Removed V2 history DELETE controls and hid the shared stop button for all V2 records.
- Preserved passive V2 progress, result, released Replica summary, and history opening.
- Added a multi-state route contract covering human-open, dual-track-ready, credentials-required/running, and released states.

### Portable PDF release gate

- Added `test/report-python.js` with this order: `REPORT_PDF_PYTHON`, `PANDA_DATA_PYTHON`, repository `.venv/bin/python` (or `.venv/Scripts/python.exe` on Windows).
- Removed both hard-coded macOS Python paths from the PDF suites.
- Added a release-test source assertion rejecting `/Users/.../python*` interpreter paths.
- Verified an exported staged tree with no report-Python environment override and `.venv` linked to a ReportLab-capable runtime, matching the documented production path shape.

## GREEN evidence

### Focused regression set

The initial seven-test command: `7/7` passed.

The extension-array accessor probe: `1/1` passed.

The running-V2 read-only probe: `1/1` passed.

### Relevant PDF/security/V2 suites

```sh
REPORT_PDF_PYTHON=<ReportLab-capable Python> node --test test/v1-report.test.js test/v1-report-route.test.js
```

Result: `18/18` passed.

```sh
node --test test/evaluation-version-ui.test.js test/result-ui.test.js test/deploy-config.test.js
```

Result: `33/33` passed.

### Complete V1 release suite

The sandboxed first run produced `140` passes and only two `listen EPERM 127.0.0.1` infrastructure failures. Re-running with localhost binding permission:

```sh
REPORT_PDF_PYTHON=<ReportLab-capable Python> npm run test:v1-release
```

Result: `142/142` passed, `0` failed.

### Exported intended tree

The exact staged tree was exported with `git checkout-index`; `node_modules` was linked as the production `npm ci` stand-in and `.venv` was linked to a ReportLab 4.4.9 environment. No `REPORT_PDF_PYTHON` or `PANDA_DATA_PYTHON` override was present.

```sh
cd <exported-staged-tree>
npm run test:v1-release
```

Result: `142/142` passed, `0` failed. This proves the tests use `<release>/.venv/bin/python` rather than a developer-host path.

### Syntax and diff gates

```sh
npm run check
```

Workspace result: `Syntax OK · 207 JavaScript files`.

Exported staged tree result: `Syntax OK · 205 JavaScript files` (the workspace has two unrelated untracked JavaScript files).

```sh
git diff --cached --check
```

Result: exit `0`, no whitespace errors.

## Changed files

- `src/v1-report.js`
- `public/app.js`
- `public/index.html`
- `public/result-v2.js`
- `public/styles.css`
- `test/v1-report.test.js`
- `test/v1-report-route.test.js`
- `test/report-python.js`
- `test/deploy-config.test.js`
- `test/result-ui.test.js`
- `.superpowers/sdd/2026-08-01-v1-scoring-pdf-upgrade/post-review-repair-report.md`

## Self-review

- Only repair files are staged; pre-existing user changes and generated/untracked data remain untouched.
- The Card projector is fail-closed for oversized extension metadata and never treats unknown top-level Card data as public.
- Stable public security metadata is projected explicitly, so secret-key filtering cannot accidentally remove legitimate OAuth modes or endpoint URLs.
- Public V2 is now presentation-only; backend V2/admin behavior remains available outside the public surface but was not expanded.
- The portable test helper intentionally fails with a clear message if neither an explicit interpreter nor the documented repository `.venv` exists.
- `npm test` was not used as the release gate because the repository runbook explicitly defines `npm run test:v1-release` for this V1-only release and documents unrelated V2 suites as not globally green.
- No push or deployment was performed in this task.
