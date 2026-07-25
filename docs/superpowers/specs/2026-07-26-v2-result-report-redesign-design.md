# V2 Result Report Redesign

Date: 2026-07-26  
Status: approved for planning

## Goal

Replace the current V2 result page’s flat, hard-to-scan LOCKED FINDINGS dump with a report that is at least as clear as V1: verdict-first hierarchy, four-model review detail, Chinese leaf labels, and (after Replica release) Skill snapshots plus same-prompt reproduction outputs.

## Problem

1. `public/result-v2.js` flattens `absoluteReview.modelPanel.primary` findings into one long list; per-seat scores, confidence, repair text, and structure are unused.
2. Demo findings often repeat the same “found observable support…” boilerplate, so the page looks like four models are missing.
3. Leaf rows show only English technical ids (`professionalism.evidenceReasoning`).
4. Replica section shows status / Δc only; V1’s Skill inspector and battle outputs are absent even after release (projection currently exposes only `runtimeId` / `valid` / `median`).

## Non-goals

- Changing absolute scoring, model-lock, human-review, or dual-track finalize contracts
- Restoring V1’s five finance hard-metric bars as the absolute rubric
- Showing Skill content or reproduction scores/outputs before Replica `released`
- Redesigning the judge desk or evidence replay page (result page may deep-link to evidence)

## Decisions

1. **Approach** — Verdict-led V2 report (not a literal V1 shell). Keep V2 dual-track semantics; restore V1-grade readability for models, skills, and reproduction.
2. **Page order**
   1. Final verdict hero (rating seal + headline + one-line absolute / Replica Δc summary)
   2. Three absolute dimension scores
   3. Replica advantage strip (moved up)
   4. Four-model overview cards
   5. Leaf contrast (Chinese labels; expand to four comment cards)
   6. Test matrix + declared×observed
   7. Humor list + human opinions + evidence gaps
3. **Four-model overview** — One card per primary seat: display name, model, locked badge, seat mean score, three dimension means, seat review blurb, leaf/dispute/confidence summary. No full dump of every leaf finding on the card.
4. **Seat review blurb** — Prefer `resultV2.humor.items[].line` for the seat’s representative leaf; else that leaf’s first finding text. Footnote: Chinese leaf label (+ repair suggestion when present). Representative leaf: prefer largest deviation from leaf median among `disputedSubcriterionIds` for that seat; else the seat’s lowest-scoring applicable leaf.
5. **Leaf contrast** — Rows show Chinese title + muted technical id; dispute badge when applicable. Default collapsed. Expanded row: four cards (score, confidence, finding/comment, repair).
6. **Chinese leaf labels** — Frontend map (e.g. `public/rubric-labels.js`) covering all `a2a-black-box-v1` leaves. Missing key falls back to id.
7. **Replica detail visibility** — Only when `resultV2.replica.status === 'released'` (and projection allows release): show Skill build list with inspectable snapshot, and same-prompt reproduction rounds (submitted + each valid runtime) with score and full output. Before release: status copy only (待复刻 / 密封中 / human-review links), no Δc leak beyond existing sealed rules.
8. **Data exposure for Replica detail** — Keep large Skill bodies and full case outputs off the main evaluation payload. After release, expose thin runtime/case metadata on the projected replica object (runtime display name, skill name, case titles/prompts, per-source scores), and load Skill snapshots / full outputs via dedicated read APIs modeled on V1 `GET /api/evaluations/:id/builds/:runtimeId/skill` (V2 paths under the same evaluation, e.g. replica skill + case output). Sealed/pending responses must omit both metadata that reveals advantage-critical outputs and the detail endpoints’ bodies (404 or 409 with no leak).
9. **Demo findings quality** — Improve deterministic panel copy so seats are distinguishable (implementation detail; must not invent facts beyond supplied evidence).
10. **Live / incomplete states** — Keep existing live progress / skip-human / finalize panels above the report; unfinished sections show empty copy, not legacy “0 / 4 组已出”.

## Chinese leaf label table

| Id | 中文 |
|----|------|
| `scenarioValue.agentNecessity` | Agent 必要性 |
| `scenarioValue.researchDecisionValue` | 投研决策价值 |
| `scenarioValue.utilityReuse` | 效用与复用 |
| `scenarioValue.productNovelty` | 产品新颖性 |
| `professionalism.taskCompletion` | 任务完成度 |
| `professionalism.methodAssumptions` | 方法与假设 |
| `professionalism.evidenceReasoning` | 证据推理 |
| `professionalism.riskUncertainty` | 风险与不确定性 |
| `professionalism.artifactUsability` | 产物可用性 |
| `agentCapability.testSuccess` | 测试成功率 |
| `agentCapability.robustness` | 稳健性 |
| `agentCapability.contextContinuity` | 上下文连续性 |
| `agentCapability.a2aCompliance` | A2A 合规 |
| `agentCapability.efficiency` | 效率 |
| `agentCapability.claimErrorHandling` | 声明与错误恢复 |

Dimension titles already used in UI: 任务价值 / 专业度 / Agent 能力.

## UI structure

Primary renderer: `public/result-v2.js` (called from `public/app.js`). Styles in `public/styles.css` (add rules for overview grid, leaf rows, seat review, skill/battle blocks under the replica section). Reuse V1 patterns from `renderReviews` / `renderBuilds` / `renderBattle` / skill inspector where practical, without routing V2 evaluations through `renderLegacyResult`.

### Verdict hero

- Rating from `resultV2.rating` / `trackStatus` (「进行中」 until final)
- Headline: prefer locked humor aggregate line or a short status sentence derived from rating + absolute readiness (no new model call in v1 of this redesign)
- Summary chips: absolute total, confidence, Replica Δc or 待复刻, four seats locked

### Replica block (section 03)

**Always:** header + status / Δc (when released) + existing sealed/pending copy.

**When released only:**

1. **复刻直出 Skill** — per valid runtime: name, skill name, status;「查看 Skill」loads snapshot (file tree + preview), read-only.
2. **同题复现对打** — per case: prompt; grid of submitted + runtimes with score and `<details>` full output (V1 battle parity).

### Model panel (sections 04–05)

Derive seat aggregates client-side from projected `absoluteReview.modelPanel.primary[]` reviews (mean score, means by dimension prefix, confidence mean). Map `reviewRunId` / panel seat order to `DEFAULT_REVIEWERS` / configured panel names when available on the client; otherwise parse `primary_N_<id>` and fall back to id.

Remove the flat `.v2-result-findings` dump as the primary model UX. Humor list remains in section 07 (and feeds overview blurbs per decision 4).

## Data flow

```text
evaluation (projected)
  ├─ resultV2.rating / absolute / humor / replica
  ├─ absoluteReview.modelPanel.primary[4]
  ├─ trackStatus / governance panels
  └─ (released only) replica skill snapshots + case outputs
        → renderV2Result HTML
```

Seat blurb selection and leaf medians are pure view helpers (no server write).

## Error / empty handling

| State | UI |
|-------|----|
| Model panel not locked | Existing live console; no fake four-model cards with zeros |
| Panel locked, humor missing | Overview uses finding text; humor section shows 尚未生成 |
| Replica pending / sealed / disabled | Status copy only; no Skill/battle |
| Released but skill fetch fails | Inline error in inspector (V1 parity) |
| Unknown leaf id | Show raw id |

## Testing

- Extend `test/result-ui.test.js` for section order, Chinese labels, overview cards, leaf expand markup, and absence of flat findings-only primary UX when panel is present.
- Projection/API tests for released-only skill/output fields (or new endpoints).
- Keep dual-track / sealed leakage tests green: sealed responses must not include skill bodies or reproduction outputs.

## Acceptance

- Result page no longer presents four-model detail as a single undifferentiated findings list
- Four seats visible with scores and a seat review blurb (humor-preferred)
- Leaves show Chinese names; expand shows four comment cards
- Replica Skill + same-prompt outputs appear only after release
- Absolute / lock / seal contracts unchanged
