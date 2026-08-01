# Task 6 implementation report: V1 complete PDF download

## Scope delivered

- Added a V1-only `GET /api/evaluations/:id/report.pdf` download endpoint.
- Added a strict public DTO projection that rejects V2 and incomplete evaluations.
- Added a bounded Python/ReportLab renderer for a complete, paginated Chinese A4 report.
- Added the completed-V1-only result-page download link.

The DTO copies only named public fields. It includes the full projected Agent Card,
candidate outputs, Card reviews, seat reviews, data verification, context usage and
logs; it does not pass evaluation objects wholesale. Nested public JSON drops keys
matching credential/secret/internal names before crossing the renderer boundary.

## Error handling and bounds

- Input DTO cap: 8 MiB; generated PDF cap: 32 MiB.
- Renderer timeout: 45 seconds by default (overridable by the module caller).
- Spawn/input failure returns a 503, timeout a 504, and renderer/invalid-PDF failure
  a 502. The HTTP route only writes a response after a valid `%PDF-` buffer is
  available, so it never streams a partial PDF.

## TDD and automated verification

The new focused tests cover the public projection, V2/running rejection, Chinese
multi-page PDF generation, the successful API headers/content, missing/ineligible
records, unavailable renderer handling, and the V1-only UI affordance.

Commands run successfully:

```text
node --test test/v1-report.test.js test/api.test.js test/result-ui.test.js
npm run check
git diff --check
```

## PDF QA

Generated fixture (not staged):

```text
output/pdf/v1-agent-review-fixture.pdf
```

`pdfinfo` reports 15 pages at A4 (595.276 x 841.89 points). I rendered every page
with `pdftoppm` to `tmp/pdfs/v1-agent-review-*.png` and inspected pages 1–15:
headers, footers, Chinese text, wrapped tables and long candidate outputs render
without clipping, blank pages or unsupported-glyph boxes. I replaced the initially
unsupported middle-dot glyph and consolidated candidate summary tables to eliminate
an orphan summary page.

`pdfplumber` validation confirmed all 15 pages are A4 and that the final PDF contains
the complete-output and Chinese-review sentinels.

## Files changed

- `src/v1-report.js`
- `scripts/render-v1-report.py`
- `server.js`
- `public/index.html`, `public/app.js`, `public/styles.css`
- `requirements-data.txt`
- `test/v1-report.test.js`, `test/api.test.js`, `test/result-ui.test.js`

## Fix round 1 / 5

### Root cause and red phase

- The earlier V1 guard only rejected one historical schema version, so other
  non-V1 shapes and partially populated completed records could reach the
  renderer.
- A recursive copy followed by a blacklist allowed unrecognised nested fields
  to cross the public-report boundary, including a plausible credential-shaped
  value in Panda data parameters/facts.
- The report omitted several final-result sections (tier/CASE ranking, all five
  professionalism dimensions, capability components and audit uncertainty),
  and its PDF check accepted a header-only/truncated renderer response.

Focused tests were written first for each failure: schema 2/3 and incomplete
completed records, nested unknown/credential sentinels, all required report
sentinels, bad renderer output, non-zero renderer exit, timeout and oversize
output. They failed against the previous implementation before the fixes.

### Green implementation

- `projectV1Report` now accepts *only* `schemaVersion === 1`, requires the
  completed V1 Card/config/Card-review/CASE-entry shape, and uses named nested
  projections rather than cloning then filtering. Panda query parameters and
  facts are separately allowlisted at their own boundaries.
- The download route safely decodes the evaluation id and maps malformed id,
  unavailable renderer, invalid renderer output and timeout to distinct HTTP
  failures without returning partial PDF bytes.
- The report now has a final-tier cover, Card summary and per-CASE rankings,
  five professionalism dimensions, execution/latency/capability components,
  audit uncertainty, white table-header text and running header/footer.
- Renderer acceptance requires a bounded PDF with a header, `startxref` and
  terminal `%%EOF`; the generator rejects invalid, timed-out, non-zero and
  oversized output.

### Final verification and visual QA

Commands passed:

```text
node --test test/v1-report.test.js test/api.test.js test/result-ui.test.js
npm run check
git diff --check
```

Final fixture: `output/pdf/v1-agent-review-fixture.pdf` (not staged).
`pdfinfo` reports 15 A4 pages (595.276 x 841.89 points). `pdfplumber` confirmed
all 10 report titles, every candidate output sentinel, Chinese reviews,
uncertainty/capability labels, and the running header/footer on all 15 pages.

I rendered r6 and the final r9 pages with `pdftoppm`; their 15 page PNGs are
pixel-identical (matching hashes), so the previously completed page-by-page
inspection applies to the final artifact. The inspection found readable Chinese
text, white table headers, no clipping, unsupported-glyph boxes, accidental blank
pages or orphan headings. Earlier r1/r4 pagination defects (candidate-table
continuation and a one-row audit tail) were eliminated before the final render.

## Fix round 2 / 5

### Root cause and TDD red phase

- The first eligibility guard proved only that review and candidate arrays were
  nonempty. It did not prove the native V1 panel topology, so a completed record
  could contain missing or duplicate Card-review seats and Runtime candidates.
- Fact selector objects are supported by `data-verifier`, but the report DTO
  silently discarded them because only `first`/`last` selectors were projected.
- `%PDF-` plus an arbitrary `startxref` trailer passed the previous structural
  regex, even if the offset did not point at an xref table or the file lacked a
  Catalog/Pages tree.

New focused tests first failed for incomplete/duplicate V1 seat and candidate
topologies, an object-valued fact selector containing credential-shaped fields,
and a fake PDF with a real `startxref` offset but no Pages tree.

### Fixes

- The completed-V1 gate now derives its required Card reviewer ids from
  `V1_REVIEWER_IDS` and Runtime candidates from `RUNTIMES`; each set must be
  exact, unique and complete for every CASE.
- Data-verifier selector objects become bounded `{ field, expected }` entries.
  Only identifier-like non-credential field names and scalar public values pass;
  arbitrary nested objects and credential-like selectors are removed.
- PDF validation now resolves the `startxref` byte offset, parses the bounded
  traditional xref/trailer produced by ReportLab, resolves `/Root`, requires a
  `/Catalog`, `/Pages`, positive `/Count` and at least one `/Page` object.
- The route accepts a bounded `REPORT_PDF_MAX_BYTES` setting for operations and
  test coverage, and route tests cover non-zero renderer and oversize errors
  without exposing partial bytes.
- Candidate summaries use `LongTable(..., repeatRows=1)` again, retaining the
  compact styles while allowing large accepted reports to paginate safely.

### Verification and final PDF QA

Focused V1 tests passed after the changes. The fixture was regenerated and
`pdfinfo` reports 15 A4 pages. The final r10 render is pixel-identical to r9 on
all 15 pages (matching hashes); those final pages were therefore inspected
page-by-page for white headers, no orphan headings, clipping or blank pages.
`pdfplumber` also verified every title/sentinel and every running header/footer.

The full `test/api.test.js` remains unable to enter its cases in this sandbox:
its global `test.before` receives `EPERM listen EPERM: operation not permitted
127.0.0.1` while binding a loopback socket, before the report route is reached.
This is not an application child-process or server-handle leak. The committed
`test/v1-report-route.test.js` uses the real exported server and direct request
emission (no socket) to execute the same route-level incomplete-topology,
non-zero-renderer and oversize/no-partial-response assertions in this sandbox.

## Fix round 3 / 5

### Root cause and TDD red phase

- A persisted custom `reviewPlan` is the authoritative Card-review topology,
  but report eligibility always required the default reviewer ids. This rejected
  a valid completed record with its configured failed seat recorded.
- The structural PDF gate found `/Type /Page` by scanning raw object text. A
  `/Bogus` dictionary could therefore pass by placing that text in a literal
  string, and there was no proof of `/Kids` ownership, parent links, counts or
  an acyclic page tree.

Focused tests were first added for the persisted custom plan (including a
`failed` seat) and for valid-looking traditional PDFs containing a bogus page,
a `/Kids` cycle, an incorrect `/Parent`, or a `/Pages` node without `/Kids`.
They failed against the previous gate.

### Fixes

- When `evaluation.reviewPlan` is persisted, eligibility now derives the exact
  unique reviewer-id set from that array; it falls back to `V1_REVIEWER_IDS`
  only when no plan is persisted. Runtime candidate requirements remain the
  submitted candidate plus all three configured runtimes.
- The PDF gate now parses bounded classic xref entries and object dictionaries,
  ignores literal strings/comments rather than scanning arbitrary content, and
  walks only `/Kids`. It rejects cycles, tree depth above 64, more than 100,000
  page-tree nodes, mismatched `/Parent` links, malformed `/Count` values and
  missing `/Kids` collections.
- Parser work is bounded by the existing 32 MiB output cap plus a 100,000-entry
  xref limit, 1 MiB object limit and 400,000-token limit. Parsed dictionaries
  use null-prototype maps so untrusted PDF names cannot affect parser state.

### Verification

Commands passed:

```text
node --test test/v1-report.test.js test/v1-report-route.test.js test/result-ui.test.js
npm run check
git diff --check
```

The renderer was not changed in this round, so the final fixture was not
regenerated. Structural QA on `output/pdf/v1-agent-review-fixture.pdf` still
reports a 15-page A4 PDF; `pdfplumber` confirms the title, running footer and
submitted-output sentinel. As in round 2, the sandbox-wide API suite remains
blocked before route execution by loopback `listen` returning `EPERM`; the
no-socket route harness above remains green.

## Fix round 4 / 5

### Root cause and focused TDD RED

- `pdfDictionaryAt` used an unbounded `source.indexOf('endobj', offset)` before
  comparing the result with the 1 MiB object cap. It could therefore scan far
  beyond the cap, and a malformed page object without `endobj` could borrow a
  later indirect object's terminator because only the first dictionary in the
  combined slice was parsed.
- The page-tree walk validated `/Parent` only when a parent reference had been
  supplied. Consequently the root `/Pages` dictionary could declare a bogus
  `/Parent` and still pass.

Four focused parser cases were added before the production change. The
shared-later-`endobj` and root-`/Parent` cases failed with “Missing expected
rejection”; the oversized missing-`endobj` bound control and a valid PDF using
nonzero xref generations passed.

### GREEN implementation

- The traditional-xref parser now builds one reader with sorted physical xref
  offsets and a per-reference dictionary cache. Every object is bounded by the
  nearer of its following live xref object and `MAX_PDF_OBJECT_BYTES` before any
  dictionary search or allocation.
- Dictionary boundaries are scanned directly within that window. The parsed
  dictionary must be followed only by PDF whitespace/comments and its own
  genuine, token-delimited `endobj`; it cannot overlap or swallow a following
  indirect object header. The exact bounded dictionary is then tokenized once.
- Root `/Pages` requires `/Parent` to be absent. Descendant `/Pages` and `/Page`
  nodes continue to require the exact generation-aware parent reference.

### Self-review and verification

Self-review removed a redundant second dictionary-boundary scan, confirmed that
the xref boundary index is computed once rather than once per page-tree node,
and checked that all source lookahead is constrained to the established object
window. The renderer, route, UI and topology code were not changed.

Commands passed:

```text
node --test test/v1-report.test.js test/v1-report-route.test.js test/result-ui.test.js
npm run check
git diff --check
```

The focused command reports 17/17 passing tests. The existing untracked fixture
remains a 15-page A4 ReportLab PDF; `pdfplumber` reconfirmed its report title,
running footer and submitted-output sentinel. The known full `api.test.js`
loopback `EPERM` suite was not rerun; the no-socket route suite above passed.
