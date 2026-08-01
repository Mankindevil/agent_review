# Task 5 report — expose only live V1 intake

## Scope delivered

- Removed the public homepage's V1/V2 selector, V2 intake controls, and demo-mode selector.
- Public browser state starts on V1/live and ignores all `?version=` values; the V1 request builder enforces `mode: "live"`.
- Kept direct V2 request creation functions and stored V2 result/resume rendering in the client, with no public intake entry.
- Replaced the hidden V2 Example editor dependency for V1 with a visible V1 same-prompt case editor that compiles to normalized `agentExamples`.
- Rendered Agent Card reviews with five design-specific labels and `AGENT CARD DESIGN REVIEW`.
- Rendered `v1-model-arena/v2` in audit order: shared scenario, candidate three totals, professional five rows, objective end-to-end timing declaration, then model-seat audits. Legacy `v1-model-arena/v1` labels remain unchanged.

## TDD evidence

RED (before implementation):

```text
node --test test/evaluation-version-ui.test.js test/result-ui.test.js
failed: publicEvaluationVersion export absent; Agent Card / Arena v2 labels absent
```

GREEN:

```text
node --test test/evaluation-version-ui.test.js test/result-ui.test.js test/v1-scoring-ui.test.js test/browser-evaluation-actions.test.js
17 passed, 0 failed

npm run check
Syntax OK · 203 JavaScript files
```

## Changed files

- `public/index.html`: live-only public intake; V2/demo controls removed.
- `public/app.js`: live V1 state/request wiring, V1 case-to-example collection, versioned review/Arena renderers.
- `public/evaluation-version-ui.js`: public V1 resolver and live-only V1 request construction.
- `public/styles.css`: three-layer V1 Arena audit stack styles and responsive treatment.
- `test/evaluation-version-ui.test.js`, `test/result-ui.test.js`, `test/v1-scoring-ui.test.js`: live-only entry, preserved V2 direct paths, and versioned rendering coverage.

## Self-review and concerns

- `git diff --check` is clean. Responsive CSS was reviewed for the existing 1000px/700px breakpoints and reduced-motion rule. I attempted to connect an in-app browser for a visual check, but this environment reported no available browser; no visual screenshot was produced.
- The full repository suite was not run because the shared worktree contains unrelated in-progress changes. The focused UI suite and repository syntax check above are green.

## Fix round 1/5

### Review findings addressed

1. Restored the direct/historical V2 UI state path: `evaluationVersionUiState({ selectedVersion: 'v2', healthResolved: true, v2Available: true })` now returns a usable V2 state without adding any public V2 entry.
2. Escaped unknown Card-review and Arena-scenario dimension keys before inserting them into HTML.
3. Added executed renderer coverage for Card design review version selection, five labels, zero values, absent dimensions, unsafe reviewer/comment/risk/key text, legacy labels, zero duration/score, and malformed V1 Arena v2 details.

### TDD evidence

RED:

```text
node --test test/evaluation-version-ui.test.js test/result-ui.test.js
3 failures: undefined isV2 in direct V2 state; raw scenario key; Card renderer edge assertions
```

GREEN:

```text
node --test test/evaluation-version-ui.test.js test/result-ui.test.js test/v1-scoring-ui.test.js test/browser-evaluation-actions.test.js
20 passed, 0 failed

npm run check
Syntax OK · 203 JavaScript files
```
