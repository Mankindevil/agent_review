# V1 Model Arena Final Review Fix Report

Date: 2026-07-30

## Scope

This pass addresses the four Important findings from the final branch review:

1. preserve initial V1 cancellation while CASE scoring is pending;
2. treat a historical record's explicitly retried model-scoring round as model-era data;
3. reject malformed or uncredentialed custom live reviewers before any evaluation work starts;
4. prevent failed historical entries from winning a rule-era zero-score tie.

Unrelated pre-existing changes in the shared worktree were preserved and excluded from this fix commit.

## Fixes

### 1. Cancellation remains terminal

- `scoreV1ArenaCase` now checks the caller signal before scoring and immediately after all reviewer promises settle. A caller abort is propagated instead of being converted into an ordinary failed reviewer seat.
- The initial V1 pipeline checks the signal after the scoring await, before applying the returned round, before persistence, and before final verdict completion.
- Regression coverage holds a custom scorer pending, cancels the evaluation, resolves the stale scorer, and verifies that no judging snapshot, averages, roast, or completion timestamp overwrites the cancelled record.

### 2. Historical retries become round-aware

- Benchmark completeness now classifies each round independently. A top-level V1 model scoring configuration marks every round as model-era; for historical records without that field, a `v1-model-arena/v1` judging snapshot marks only that round as model-era.
- Model-era rounds require `judging.status === "scored"` and finite scores for every competitor. Pure historical rule rounds retain the legacy entry-presence interpretation.
- Retry failure detection and derived-output clearing use the same round-aware classification, so a failed explicit retry removes stale averages, roast, and `completedAt` and leaves the evaluation failed.

### 3. Live reviewer readiness fails closed

- Required live seats must use `openai-compatible` or `anthropic`.
- Each required seat must provide non-empty `baseUrl`, `model`, and `apiKeyEnv`, and the referenced environment variable must contain a secret.
- The check remains local and performs no gateway or model network probe.
- Built-in gateway reviewer shapes remain valid when their existing gateway secret is configured.
- Unit, pipeline, and API coverage verifies HTTP 503 behavior and that no record or worker is created for an uncredentialed custom seat.

### 4. Failed entries never win

- Winner eligibility now always excludes `entry.mode === "failed"` and `scoreStatus === "execution-failed"`.
- Model-era rounds additionally continue to require `scoreStatus === "scored"`.
- Historical all-failed and historical scored-zero-versus-failed-zero cases are covered.

## Documentation

- `README.md`, `.env.example`, and `docs/SCORING.md` now describe the local structural/secret readiness check and explicitly state that it does not probe the network.

## Verification

Red phase:

- `node --test test/v1-model-scoring.test.js test/pipeline-control.test.js test/v1-scoring-ui.test.js`
  - The new regressions failed for the intended reasons: missing readiness rejection, cancellation overwritten as `completed`, historical failed judging completed with a zero verdict, abort treated as model failure, and historical failed zeroes marked as winners.
  - Two unrelated loopback fixtures were blocked by the filesystem/network sandbox during this red run.

Green phase:

- `node --test test/v1-model-scoring.test.js test/v1-scoring-ui.test.js`
  - 13 passed, 0 failed.
- `node --test --test-name-pattern='uncredentialed custom live V1 reviewer|initial V1 cancellation|historical V1 retry failed' test/pipeline-control.test.js`
  - 3 passed, 0 failed.
- `node --test test/pipeline-control.test.js`
  - 43 passed, 0 failed.
- `node --test --test-name-pattern='serves the scoring methodology document|documents production runtime tool configuration|creates a V1 demo evaluation|rejects invalid V1 scoring configurations' test/api.test.js`
  - 4 passed, 0 failed.
- `node --test test/branding-ui.test.js`
  - 7 passed, 0 failed.
- `npm run check`
  - `Syntax OK · 193 JavaScript files`.
- `git diff --check`
  - exited 0 with no whitespace errors.

## Broad-suite caveat

The combined focused-file command that also ran all of `test/api.test.js` did not terminate cleanly in this shared dirty worktree and was stopped after approximately 99 seconds. All V1, pipeline, prompt, UI, and A2A cases reported by that run passed. The API file reported four unrelated V2/governance/evidence failures before hanging:

- two appeal assertions received HTTP 422 instead of 201;
- one dual-track assertion remained `absolute_locked` instead of `final`;
- one evidence-vault fixture rejected a symlinked configured root ancestor;
- the API test process retained a pending promise after those failures.

The selected V1 API and documentation cases were rerun separately and passed 4/4. No network provider probes were performed.
