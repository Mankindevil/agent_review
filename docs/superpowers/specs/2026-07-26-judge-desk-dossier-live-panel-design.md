# Judge Desk Review Dossier And Live Panel

Date: 2026-07-26  
Status: approved for planning

## Goal

Make the open human-review desk usable: reviewers can see redacted materials for both absolute and replica tracks while scoring. **Production must not use demo model panels.** When `OPENAI_*` / `ARK_*` / four `REVIEW_MODEL_*` are configured (the expected operator `.env`), V2 automatically builds a live four-seat panel—no `MODEL_REVIEW_PANEL_JSON` required. Incomplete credentials fail loudly instead of silent demo.

## Problem

1. Replica human-review cards on `/judge.html` only show empty four-dimension inputs (`提交 Agent` / `replica:{id}`) with no prompt or outputs. `projectReplicaHumanReview` exposes `requiredSources` only. Detail pages keep Replica Skill/outputs sealed until release, so “查看详情” does not help.
2. Absolute human-review cards likewise lack inline model leaf opinions, so reviewers must hunt elsewhere (and often still lack enough context).
3. Unset `MODEL_REVIEW_PANEL_JSON` falls back to `configuredReviewPanel` `mode: 'demo'`, so every leaf gets the same per-seat score (`70/72/74/76`) and templated `(demo N)` findings—misleading on the result page.

## Non-goals

- Changing absolute lock, replica-human lock, cube merge, or dual-track finalize contracts
- Participant-facing Replica release / Δc unmasking before finalize
- Revealing Runtime real names or Arena model scores on the open desk
- Improving deterministic demo finding copy (demo is an explicit escape hatch only)
- Restoring admin assignments or judge Bearer gates

## Decisions

1. **Approach** — Embed a light `reviewDossier` on `GET /api/review-queue` projections while tracks are open; render it on both absolute and replica cards. Prefer this over a separate lazy dossier API or detail-page-only fix.
2. **Visibility vs desk materials** — `replicaReviewPolicy.visibility` (`full_blind` default and others) continues to hide Runtime identity and Δc. The open review desk **always** receives redacted dossier text (prompts + anonymous source outputs) when the replica-human track is open. Blindness is identity/advantage, not “no materials.”
3. **Absolute dossier** — When `governance.phase === 'human_open'`, attach model-panel leaf contrast: Chinese-capable leaf ids, per primary seat score + short finding text (and confidence when present). Sourced from already-projected locked `absoluteReview.modelPanel`; no Replica decrypt.
4. **Replica dossier** — When `replicaHumanPhase === 'replica_human_open'` (track open), server loads sealed Arena materials (same family of helpers as release: test plan + submitted outputs + valid replica outputs via evidence vault), projects cases as `{ testId, title?, prompt, sources: [{ sourceId, text, truncated }] }` with `sourceId` in `{ submitted, replica:{runtimeId} }`. Never include Runtime display names, Δc, or model Arena judgements.
5. **Truncation** — Default ~4000 characters per source text; set `truncated: true` when cut. UI may note truncation.
6. **Live panel auto-config** — Extend `configuredReviewPanel`. Operator path (complete gateway `.env`) is the default success case:
   1. If `MODEL_REVIEW_PANEL_JSON` set → parse as today (`mode: 'live'`). Optional override only.
   2. Else if `OPENAI_BASE_URL`+`OPENAI_API_KEY`, `ARK_BASE_URL`+`ARK_API_KEY`, and four `REVIEW_MODEL_*` (OpenAI / Anthropic / Doubao / DeepSeek) are set → build a live panel: four primaries with the same gateway mapping as `configuredReviewers` (gpt/claude → LLMX; doubao/deepseek → Ark), plus arbitrator `{ id: 'arbitrator', … }` on Ark using `REVIEW_MODEL_DEEPSEEK` (distinct `identityKey` from the DeepSeek primary). **This is the intended production path.**
   3. Else if `MODEL_REVIEW_PANEL_MODE=demo` (tests / explicit local escape only) → allow deterministic demo panel.
   4. Else → **throw** with an explicit message listing missing credentials/models. Never silent demo when the operator intended live reviews.
7. **Create-time failure** — V2 evaluation create / Phase-2 panel construction surfaces the same error so a misconfigured server cannot run mock seats under a live-looking UI. A correctly filled gateway `.env` creates live panels with no extra JSON.
8. **Decrypt failure** — If replica materials cannot be loaded, queue item still lists; replica card shows an inline error (“材料不可用”) and keeps the score form. Absolute skip remains available when absolute is open.

## Data shape

```text
reviewDossier?: {
  absolute?: {
    dimensions: { scenarioValue?, professionalism?, agentCapability? },
    leaves: [{
      subcriterionId,
      seats: [{ seatId|name, score, confidence?, finding? }]
    }]
  },
  replica?: {
    error?: string,
    cases?: [{
      testId,
      title?,
      prompt,
      sources: [{ sourceId, label?, text, truncated }]
    }]
  }
}
```

Omit `reviewDossier` (or each branch) when the corresponding track is not open.

## UI

- **Absolute card**: above the leaf score form, a “模型对照” block (default expanded summary; per-leaf rows collapsible). Scoring controls unchanged.
- **Replica card**: above the four-dimension forms, a “同题对照” block: per case prompt + `<details>` (or equivalent) per anonymous source output.
- Keep “查看详情” links; desk must be self-sufficient without them for scoring.

## Error / empty handling

| State | Behavior |
|-------|----------|
| Incomplete gateway and no `MODEL_REVIEW_PANEL_JSON` | Fail V2 create / panel resolve with missing-field list |
| `MODEL_REVIEW_PANEL_MODE=demo` | Demo panel allowed (tests / explicit escape) |
| Replica decrypt/load failure | `reviewDossier.replica.error`; form remains |
| Output too long | Truncate + `truncated: true` |
| No open tracks | No `reviewDossier` |

## Testing

- `test/providers.test.js`: complete gateway env → live panel; missing one field → throw; `MODE=demo` → demo. Update prior “empty env ⇒ demo” expectation.
- Projection / API: open queue items include absolute and/or replica dossier; assert absence of Runtime real names and Δc fields in desk payload.
- `test/judge-ui.test.js`: script/HTML markers for 模型对照 / 同题对照 rendering.
- Phase-2 / pipeline tests that relied on implicit demo panel must set `MODEL_REVIEW_PANEL_MODE=demo` (or pass injected env).

## Acceptance

- Open replica-human card shows prompts and anonymous outputs so a reviewer can score without guessing
- Open absolute card shows model leaf scores/findings beside the human form
- `full_blind` still hides Runtime identity and Δc; desk materials remain available
- With complete gateway `.env` (no `MODEL_REVIEW_PANEL_JSON`), V2 panel is `mode: 'live'` and leaf scores are real model outputs—not `(demo N)` templates
- Silent demo default is gone; demo only via explicit `MODEL_REVIEW_PANEL_MODE=demo` in tests
- Lock / finalize / sealed participant release behavior unchanged
