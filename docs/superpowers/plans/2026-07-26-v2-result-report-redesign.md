# V2 Result Report Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved V2 result page redesign: verdict-first layout, four-model + leaf UX with Chinese labels, and released-only Replica Skill/reproduction detail.

**Architecture:** Frontend-heavy rewrite of `public/result-v2.js` (+ labels module + CSS). Thin released replica metadata via projection; Skill bodies and full case outputs via dedicated read APIs that 409/404 while sealed. Demo panel copy made distinguishable.

**Tech Stack:** Node ESM, vanilla public JS, existing evaluation projection / Express routes, node:test.

## Global Constraints

- Do not change absolute lock, human-review, or dual-track finalize contracts
- No Skill/reproduction output leakage before Replica `released`
- Keep V2 on `renderV2Result`, not `renderLegacyResult`

---

## File map

| File | Responsibility |
|------|----------------|
| `public/rubric-labels.js` | Chinese leaf/dimension labels |
| `public/result-v2.js` | Full report render + leaf/seat helpers |
| `public/styles.css` | New result section styles |
| `public/app.js` | Wire replica skill/output fetch + leaf expand toggles if needed |
| `public/index.html` | Script tag for rubric-labels if not bundled |
| `src/evaluation-projection.js` | Released thin replica detail metadata |
| `src/phase2-services.js` | Distinctive demo findings |
| `server.js` (or route module) | Replica skill + case output read endpoints |
| `test/result-ui.test.js` | UI section/order assertions |
| `test/evaluation-projection.test.js` / `test/api.test.js` | Released-only leakage + endpoints |

---

### Task 1: Rubric labels + failing UI tests

- [ ] Add `public/rubric-labels.js` with the spec’s Chinese map + `labelLeaf(id)` helper
- [ ] Update `test/result-ui.test.js` for new section ids (`verdict-hero`, `model-panel`, `leaf-contrast`), Chinese label presence, no flat findings-primary UX, replica skill/battle markers
- [ ] Run tests (expect fail) → implement labels import in `index.html` / result renderer

### Task 2: Rewrite `renderV2Result` order and model/leaf UI

- [ ] Verdict hero, absolute triad, replica strip, model overview, leaf contrast, matrix/coverage, humor/human/gaps
- [ ] Seat aggregates + humor-preferred blurb + leaf four-card expand (details/summary OK without JS)
- [ ] CSS for grids/cards
- [ ] Improve demo findings in `phase2-services.js`
- [ ] `node --test test/result-ui.test.js` green; commit

### Task 3: Released replica metadata + APIs

- [ ] Projection: when released, attach thin `builds[]` / `cases[]` metadata (no full outputs)
- [ ] Endpoints: replica skill snapshot + case source output; reject when not released
- [ ] Tests for sealed leakage and happy path
- [ ] Commit

### Task 4: Replica Skill + battle UI on result page

- [ ] Render skill list + inspect button; reuse V1 inspector patterns via `app.js`
- [ ] Render case battle grid with lazy output fetch or embedded thin scores + details fetch
- [ ] Wire click handlers; verify sealed UI shows no controls
- [ ] Full relevant tests; commit + push

---

## Done when

Acceptance criteria in `docs/superpowers/specs/2026-07-26-v2-result-report-redesign-design.md` are met and tests pass.
