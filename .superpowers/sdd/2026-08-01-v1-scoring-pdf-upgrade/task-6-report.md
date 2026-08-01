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
