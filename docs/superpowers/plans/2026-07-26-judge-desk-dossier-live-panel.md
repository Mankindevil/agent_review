# Judge Desk Dossier And Live Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open review desk shows absolute + replica redacted materials; V2 model panel auto-builds live seats from gateway `.env` (no silent demo).

**Architecture:** Extend `configuredReviewPanel` to prefer gateway live config; add `src/review-dossier.js` builders; attach `reviewDossier` on `/api/review-queue`; render in `public/judge.js`.

**Tech Stack:** Node ESM, vanilla judge desk JS, node:test.

## Global Constraints

- Do not change absolute lock / replica-human lock / finalize contracts
- Never leak Runtime real names or Δc on the desk
- Demo panel only when `MODEL_REVIEW_PANEL_MODE=demo` (tests)
- Production path: complete `OPENAI_*` + `ARK_*` + four `REVIEW_MODEL_*` → live

## File map

| File | Responsibility |
|------|----------------|
| `src/providers.js` | Gateway live panel + demo escape + missing-env throw |
| `src/review-dossier.js` | Absolute/replica dossier builders + text flatten/truncate |
| `src/arena-release.js` | Export sealed-material loader for dossier |
| `src/evaluation-projection.js` | Optional thin hook if needed; prefer attach in route |
| `server.js` | Async review-queue attaches `reviewDossier` |
| `public/judge.js` / `judge.html` / `judge.css` | Render 模型对照 / 同题对照 |
| `test/providers.test.js` | Live / throw / demo mode |
| `test/review-dossier.test.js` | Dossier shape + leak guards |
| `test/judge-ui.test.js` | UI markers |
| `test/phase2-services.test.js` | Explicit demo env |
| `test/api.test.js` | Queue includes dossier fields |

---

### Task 1: Live panel from gateway env

**Files:**
- Modify: `src/providers.js`
- Test: `test/providers.test.js`, `test/phase2-services.test.js`

**Interfaces:**
- Produces: `configuredReviewPanel(env)` → `{ mode: 'live'|'demo', primary[4], arbitrator, fallbacks }`
- Arbitrator identity: `withIdentity(reviewer, { seatSalt: 'arbitrator' })` so Ark+DeepSeek model does not collide with DeepSeek primary (`identityKey` gains `:${seatSalt}` when set)

- [ ] **Step 1: Update failing provider tests**

Replace empty-env demo default with:

```js
test('throws when live panel credentials are incomplete and demo mode is not set', () => {
  assert.throws(() => configuredReviewPanel({}), /OPENAI_|ARK_|REVIEW_MODEL_/iu);
});

test('builds live panel from gateway env without MODEL_REVIEW_PANEL_JSON', () => {
  const env = {
    OPENAI_BASE_URL: 'https://llmx.example/v1',
    OPENAI_API_KEY: 'o',
    ARK_BASE_URL: 'https://ark.example/v3',
    ARK_API_KEY: 'a',
    REVIEW_MODEL_OPENAI: 'g5.4',
    REVIEW_MODEL_ANTHROPIC: 'cs4.6',
    REVIEW_MODEL_DOUBAO: 'ep-doubao',
    REVIEW_MODEL_DEEPSEEK: 'ep-deepseek'
  };
  const panel = configuredReviewPanel(env);
  assert.equal(panel.mode, 'live');
  assert.equal(panel.primary.length, 4);
  assert.equal(panel.primary[0].kind, 'openai-compatible');
  assert.notEqual(panel.arbitrator.identityKey, panel.primary[3].identityKey);
});

test('allows demo panel only when MODEL_REVIEW_PANEL_MODE=demo', () => {
  const panel = configuredReviewPanel({ MODEL_REVIEW_PANEL_MODE: 'demo' });
  assert.equal(panel.mode, 'demo');
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test test/providers.test.js`

- [ ] **Step 3: Implement `configuredReviewPanel` branches**

Order: JSON → gateway live (all eight values set) → `MODE=demo` → throw listing missing keys.

Gateway mapping mirrors `configuredReviewers` (gpt/claude→LLMX, doubao/deepseek→Ark). Arbitrator on Ark + `REVIEW_MODEL_DEEPSEEK` with `seatSalt: 'arbitrator'`.

- [ ] **Step 4: Fix Phase2 tests** to pass `{ MODEL_REVIEW_PANEL_MODE: 'demo' }`

- [ ] **Step 5: Tests green; commit**

```bash
node --test test/providers.test.js test/phase2-services.test.js
git add src/providers.js test/providers.test.js test/phase2-services.test.js
git commit -m "feat(providers): auto-build live V2 panel from gateway env"
```

---

### Task 2: Review dossier builders

**Files:**
- Create: `src/review-dossier.js`
- Modify: `src/arena-release.js` (export loader helpers as needed)
- Test: `test/review-dossier.test.js`

**Interfaces:**
- `buildAbsoluteReviewDossier(evaluation) → { dimensions, leaves } | undefined`
- `async buildReplicaReviewDossier(evaluation, { evidenceVault }) → { cases } | { error }`
- `flattenOutputText(output) → string`
- `truncateText(text, limit=4000) → { text, truncated }`

Absolute: from `absoluteReview.modelPanel.primary[].reviews` + panel dimensions.  
Replica: load test plan prompts + submitted/replica texts via exported sealed loader; source ids `submitted` / `replica:{runtimeId}` only.

- [ ] **Step 1: Failing tests** for absolute leaf seats, replica cases, no `delta` / runtime displayName

- [ ] **Step 2: Implement builders + export sealed load path**

- [ ] **Step 3: Tests green; commit**

```bash
node --test test/review-dossier.test.js
git commit -m "feat(review): build absolute and replica desk dossiers"
```

---

### Task 3: Wire `/api/review-queue`

**Files:**
- Modify: `server.js` review-queue handler
- Test: `test/api.test.js`

- [ ] **Step 1: Failing API test** — open absolute + replica queue items include `reviewDossier.absolute` / `.replica.cases` (or `.error`); assert no `conservativeDelta` / Runtime name fields in dossier

- [ ] **Step 2: Make review-queue async map** — `projectEvaluation` then attach dossier using `evidenceVaultForRead`

- [ ] **Step 3: Tests green; commit**

```bash
git commit -m "feat(api): attach reviewDossier on open review queue"
```

---

### Task 4: Judge desk UI

**Files:**
- Modify: `public/judge.js`, `public/judge.html`, `public/judge.css`
- Test: `test/judge-ui.test.js`

- [ ] **Step 1: Failing UI tests** for `模型对照`, `同题对照`, `reviewDossier`, `renderAbsoluteDossier`, `renderReplicaDossier`

- [ ] **Step 2: Render dossiers above score forms** (textContent only; reuse `labelLeaf` if imported or inline map)

- [ ] **Step 3: CSS for dossier blocks; tests green; commit + push**

```bash
git commit -m "feat(judge): show model and replica dossiers on open desk"
git push -u origin HEAD
```

---

## Done when

Acceptance in `docs/superpowers/specs/2026-07-26-judge-desk-dossier-live-panel-design.md` is met and listed tests pass.
