# Task 7 report — documentation, production verification, release preparation

## Scope

- Documented the V1-only public intake while retaining V2/demo APIs and history.
- Documented persisted V1 Card/Arena versions, no automatic historical migration,
  20/60/20 scoring, 70/30 capability calculation, 60/600-second latency bounds,
  end-to-end/network timing scope, and unavailable internal-tool observation.
- Documented Panda query/context budgets and complete-V1 Chinese PDF route/error
  behavior; added `REPORT_PDF_PYTHON` to the environment example.
- Added deployment documentation assertions for the ReportLab/PDF acceptance path.

## RED

Command:

```bash
node --test test/deploy-config.test.js
```

Result: expected failure in `V1 release runbook installs and smoke-tests the
complete PDF report path`, because `.env.example` did not define
`REPORT_PDF_PYTHON`.

## GREEN

Commands:

```bash
node --test test/deploy-config.test.js
npm run check
```

Result: `13/13` deployment assertions passed; syntax check passed (`206 JavaScript
files`).

## Staged-tree verification

Method: wrote the intended index tree (`fc6095ed2d88dc4e1689677f5142f0ca770b0e72`),
exported it with `git archive` to `/private/tmp/agent-review-staged.zKZWn3`, and
linked only the existing `node_modules` and `.venv` dependency directories.

The isolated no-socket V1 suite passed:

```bash
npm run check
node --test test/v1-report-route.test.js test/v1-report.test.js \
  test/runtime-context.test.js test/panda-runtime.test.js \
  test/v1-card-review.test.js test/v1-model-scoring.test.js \
  test/evaluation-version-ui.test.js test/result-ui.test.js
```

Result: syntax check passed (`204 JavaScript files` in the staged tree) and
`65/65` tests passed.

The wider staged command (including `pipeline-control`) passed all V1/PDF/runtime
tests but had one unrelated deployment-doc failure: the index deliberately leaves
the pre-existing `deploy/nginx-production.conf` and its matching updated assertions
unstaged, while the newly staged production guide describes the full public app.
The old staged assertion still requires `require_404 https://14.103.143.171/`.
This is an existing unstaged deployment-configuration dependency, not a V1 scoring
or PDF regression.

The combined staged suite including `test/api.test.js` also exposed existing V2
appeal/evidence failures before completion; the no-socket V1 route suite above was
used as the fallback required for this task.

## Full-suite status

`npm test` was run outside the sandbox. It did not finish green: observed unrelated
V2 failures were `participant appeal APIs require idempotency and preserve
append-only timeline`, `appeal admin routes require probe attribution and append
recalculated result versions`, `keeps the absolute lock isolated from a pending
replica-human track and finalizes only once both close`, and `allows public evidence
replay for public-projected manifest items`. The run also logged V2 evidence-vault
rejections because the configured evidence-root ancestor was a symlink. Do not
represent the full suite as green.

## Staged files and commit intent

- `.env.example`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/PRODUCTION_OPERATIONS.md`
- `docs/SCORING.md`
- `test/deploy-config.test.js`

No push or deployment was attempted. The pre-existing dirty runtime/V2 files,
deployment config, generated directories, and other unrelated changes were left
unstaged.

Committed as `1b160e7 docs: operate V1 scoring and PDF reports`.

## Fix round 1/5

Review found that the first staged release tree omitted the public-app Nginx
configuration while its runbook described the public V1 application. This round
stages the coherent Nginx and matching deployment-test hunks, so the deploy test
and runbook now agree in the intended release tree.

### RED

```bash
node --test test/runtime-context.test.js
node --test test/deploy-config.test.js
```

The added runtime-context test failed as expected because
`MODEL_CONTEXT_MAX_BYTES=64` was ignored and the runtime retained `1500000`.
The added release assertion failed as expected because Poppler installation and
the guarded in-transaction PDF/Panda acceptance steps were missing.

### GREEN

```bash
node --test test/deploy-config.test.js test/runtime-context.test.js test/panda-runtime.test.js
npm run check
```

Result: `27/27` tests passed; syntax passed (`206 JavaScript files`).

`src/runtime-context.js` now reads strict environment values (positive safe
integer bytes and ratio strictly inside `(0, 1)`), falls back safely for invalid
values, and keeps valid explicit options authoritative. Regression coverage also
pins Panda defaults to 240,000 bytes per query and 600,000 bytes aggregate.

### Final intended-index tree

Tree `d62d428fbe7b95be165fe406287024915ebe18c8` was exported to
`/private/tmp/agent-review-staged-fix1-final.Lw6wZe`, with dependency directories
linked only for test execution. This command passed:

```bash
node --test test/deploy-config.test.js test/runtime-context.test.js \
  test/panda-runtime.test.js test/v1-card-review.test.js \
  test/v1-model-scoring.test.js test/pipeline-panda-runtime.test.js \
  test/evaluation-version-ui.test.js test/result-ui.test.js \
  test/v1-report.test.js test/v1-report-route.test.js
npm run check
```

Result: `81/81` passed and syntax passed (`204 JavaScript files` in the exported
tree).

The staged `pipeline-control + api + deploy-config` command still encountered the
same unrelated V2 appeal/evidence failures recorded above; its localhost/API
coverage is therefore not reported as green. The controller owns the requested
outside-sandbox full localhost rerun after Task review.

No push or deployment was attempted in this fix round.

Committed as `256aa1c fix: harden V1 release verification`.

## Fix round 2/5

### Public Nginx route audit and allowlist

The previous default `location /` proxy forwarded every path and method to Node.
That made the public V1 origin unintentionally expose V2-only administration,
appeal and evidence endpoints. Browser-fetch and server-route audit found that
the V1 homepage needs its static module graph, `GET /api/health`, runtime and
Panda status reads, card resolution, diagnostics, and the shared evaluation
collection/detail/history/event/report routes. V1 retry and cancellation use
the same evaluation namespace. The collection must retain `POST`, because the
user explicitly requires direct V2 creation to continue working even while the
homepage only presents V1.

`deploy/nginx-production.conf` now explicitly permits only those static assets
and route/method contracts. It returns `405` for disallowed methods (including
`DELETE /api/evaluations/:id`), returns `404` for unmatched paths, and explicitly
returns `404` before Node for admin/internal/appeal/evidence route families.
This leaves direct V2 create/list/detail/history supported only through the
shared collection/detail endpoints; it does not restore a V2 homepage entry.

### RED / GREEN

The expanded `test/deploy-config.test.js` first failed because `/`, the
evaluation collection, and the method-specific public route locations did not
exist while the catch-all proxy did. After replacing that proxy with the
allowlist, the test passed:

```bash
node --test test/deploy-config.test.js
```

Result: `14/14` passed. The tests assert the allowed static and API locations,
the collection's `GET|HEAD|POST` contract, GET-only detail/report/event paths,
POST-only mutation paths, blocked DELETE, blocked admin/appeal/evidence paths,
and the unmatched `404` fallback.

### Current-vs-baseline API/pipeline comparison

Outside the sandbox, the exact requested command was started against both the
current staged export and baseline `660566814b3ba8432a29aa56f987b68a48fef062`:

```bash
node --test test/pipeline-control.test.js test/api.test.js test/deploy-config.test.js
```

Both invocations failed to terminate after the same first 17 reported API test
outcomes. Each produced exactly 13 passes and these same 4 failures before the
runner stopped yielding output: `participant appeal APIs require idempotency
and preserve append-only timeline`; `appeal admin routes require probe
attribution and append recalculated result versions`; `keeps the absolute lock
isolated from a pending replica-human track and finalizes only once both close`;
and `allows public evidence replay for public-projected manifest items`.

This comparison establishes that the observed failures predate the V1 staged
tree. It is intentionally recorded as an incomplete, non-green command: no
overall pass/fail total is claimed because the runner did not reach its summary.

### Final intended-index verification

The operations guide now also documents the public allowlist and its health
checks (including `405` for detail DELETE and `404` for V2-only public paths),
while documenting SSH-tunnel access for the complete retained V2 backend.

Tree `835ce01edfa0382ce90c1036d838734696606ffb` was exported to
`/private/tmp/agent-review-staged-fix2-docs-final.UTyydG`. The focused command:

```bash
node --test test/deploy-config.test.js test/runtime-context.test.js \
  test/panda-runtime.test.js test/v1-card-review.test.js \
  test/v1-model-scoring.test.js test/pipeline-panda-runtime.test.js \
  test/evaluation-version-ui.test.js test/result-ui.test.js \
  test/v1-report.test.js test/v1-report-route.test.js
npm run check
```

Result: `82/82` passed; syntax passed (`204 JavaScript files`). No push or
deployment was attempted in this fix round.

Committed as `a72b12d fix: enforce V1-only public boundary`.

Committed as `cfc021d fix: restrict public V1 route exposure`.

## Fix round 3/5

### V1-only browser and method contract correction

The public homepage no longer links to the reviewer console or appeal page;
those operations remain outside the browser entry. The operations guide now
states the boundary precisely: the public browser is V1-only, while shared
create/list/detail/events routes retain direct V2/history support, and
admin/appeal/evidence/full operations are loopback/SSH-only. Nginx contracts
are now GET-only for read routes (HEAD returns `405`), with the shared
evaluation collection retaining `GET|POST`.

The API tests were reconciled only for intentional V1 changes:

- cache bust version and the V1 Arena v2 scoring default;
- homepage V2/editor navigation expectations, while retaining the direct V2
  request-builder coverage;
- agent-check's restored homepage brand link;
- appeal fixtures whose fixed July finalization timestamp had aged beyond the
  72-hour appeal window;
- a completed V1 report download fixture with a minimal structurally-valid
  renderer, so it tests the route independently of a missing local ReportLab
  environment.

### Exact evidence and remaining non-V1 failures

The full requested combined command remains intentionally **non-green and
incomplete**; it must not be summarized as a pass. The current staged-export
run reached 17 named outcomes (15 pass, 2 fail) and then did not produce a TAP
summary or progress to the later suite files. The two concrete V2 failures are
unchanged from baseline `660566814b3ba8432a29aa56f987b68a48fef062`:

- `keeps the absolute lock isolated from a pending replica-human track and
  finalizes only once both close`: observed `absolute_locked`, while the old
  assertion expects `final`;
- `allows public evidence replay for public-projected manifest items`:
  EvidenceVault rejects the macOS `/var` symlink ancestor used by the legacy
  V2 test harness.

The old `records evidence-view audit events` test depends on evidence inserted
by the preceding replay test, so an isolated name-pattern run cannot establish
it independently; it was not reclassified or modified in this V1-only round.
No V2 governance behavior or evidence-root test setup was changed.

The six V1-caused stale API cases above passed their exact name-pattern run
(`6/6`).

### Final intended-index verification

The final staged index tree
`740c55329daca7a4288646eceeef9e85da388228` was exported to
`/private/tmp/agent-review-staged-fix3-final.lBFG5h` (dependencies linked only
for test execution). The required V1 release suite and syntax check passed:

```bash
node --test test/deploy-config.test.js test/runtime-context.test.js \
  test/panda-runtime.test.js test/v1-card-review.test.js \
  test/v1-model-scoring.test.js test/pipeline-panda-runtime.test.js \
  test/evaluation-version-ui.test.js test/result-ui.test.js \
  test/v1-report.test.js test/v1-report-route.test.js
npm run check
```

Result: `82/82` passed; syntax passed (`204 JavaScript files`). No push or
deployment was attempted in this fix round.

## Fix round 4/5

### Release-specific browser cache key

The public module script now uses `app.js?v=20260802-v1-pdf-release1`, replacing
the former runtime-probe cache key. Both the no-socket homepage test and the
exact API-served HTML assertion require the new key. A scan of public HTML and
documentation found no remaining reference to the stale app key; the public
homepage still exposes only V1 live intake and its completed-V1 PDF link.

### Retained shared V2 history coverage

`test/result-ui.test.js` now executes a source-extracted behavioral harness for
the retained shared V2 history path. It directly covers `statusOf`, `stageOf`,
and `progressOf` (including clamping and non-finite fallback), then renders
running and completed records through `renderV2HistoryItem`. The assertions
cover evidence count, fallback stage, progress, terminal delete state, and the
V2 record marker. The same test confirms that no V2 intake control, version
link, judge link, or appeal link was restored to the public homepage.

### RED / GREEN

The cache-key test failed first because `public/index.html` still served the
former runtime-probe key; it passed after the HTML key was updated.

The V2 history change is coverage-only because the retained renderer already
exists. Its behavioral test passed against the current renderer, then a
temporary mutation that removed the `renderV2HistoryItem` entrypoint failed
with `ReferenceError: renderV2HistoryItem is not defined`. The mutation was
reverted, `public/app.js` returned to a clean diff, and the test passed again.

Focused no-socket browser/result command:

```bash
node --test test/evaluation-version-ui.test.js test/result-ui.test.js
```

Result: `14/14` passed.

The focused API name-pattern command successfully started but did not reach a
named outcome or TAP summary. It was cancelled after 71 seconds and reported
the existing pending-Promise harness condition, so it is intentionally not
reported as green. The exact served-HTML assertion was retained in
`test/api.test.js`, while the no-socket homepage assertion covers the same key.

### V1 release regression suite

The prior 82-test release suite now contains one additional V2 history
behavioral test:

```bash
node --test test/deploy-config.test.js test/runtime-context.test.js \
  test/panda-runtime.test.js test/v1-card-review.test.js \
  test/v1-model-scoring.test.js test/pipeline-panda-runtime.test.js \
  test/evaluation-version-ui.test.js test/result-ui.test.js \
  test/v1-report.test.js test/v1-report-route.test.js
```

Result: `83/83` passed. `npm run check` also passed (`206 JavaScript files`),
and the scoped diff check was clean. No V2 controls or links were restored. No
push or deployment was attempted in this fix round.
