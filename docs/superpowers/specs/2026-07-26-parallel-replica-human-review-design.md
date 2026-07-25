# Parallel Replica Track And Human Replica Quality Scores

Date: 2026-07-26  
Status: implemented on `codex/finance-roast` (cube merge → replica-human lock → finalize dual-track → UI)

## Goal

Let the Replica track (build → execute → seal → model Arena → human Runtime quality scores) run in parallel with absolute-score human review. Final dual-track rating is emitted only when both tracks are complete. Human Runtime quality scores enter the Arena scoring cube as an additional judge channel, equal weight with each model Arena judge, then feed the existing bootstrap Δ / Δc.

## Non-goals

- Changing the three-dimension absolute rubric or letting Replica evidence alter `resultV2.absolute`
- Per test×repeat human scoring (humans score at source level only)
- Provisional public final ratings before both tracks finish

## Decisions

1. **Approach: dual-track gate** — after absolute model panel lock, absolute human review and Replica work proceed concurrently.
2. **Human form** — humans score `submitted` plus each `validity === 'valid'` Replica Runtime using the existing Arena four dimensions and weights; composite 0–100 per source.
3. **Cube merge** — each completed human primary is one judge channel (`judgeId = human:{principalId}`); source scores are broadcast onto every `(testId, repeatIndex)` cell beside model judgements; collapse by per-cell median across judges; then `bootstrapReplicaAdvantage`.
4. **Visibility** — per evaluation, chosen by operators before replica-human review starts: `full_blind` | `semi_blind` | `open` | `split_blind` (absolute open, replica forced full-blind projection).
5. **Final rating** — only when absolute is locked **and** replica-human is locked (or Replica is unavailable). No provisional final label.
6. **Human count** — `replicaReviewPolicy.requiredPrimaries` default **1**. If set to 2, require two primaries and arbitrator when any source composite differs by more than 15.
7. **Seat overlap** — same person may sit on absolute and replica tracks by default; `forceSeparateJudges` may forbid overlap for that evaluation.
8. **`lock-absolute` no longer releases Replica** — release / rating move to `finalize-dual-track` (or auto-finalize when the second track closes).

## State machine

```text
waiting_model
    ↓ absolute model panel locked
┌─────────────────────────────┬──────────────────────────────────┐
│ Absolute track              │ Replica track                    │
│ human_open                  │ build → execute → seal           │
│   → (human_arbitration)     │   → model Arena (sealed store)   │
│   → absolute_locked         │   → replica_human_open           │
│                             │   → (replica_human_arbitration)  │
│                             │   → replica_human_locked         │
│                             │   or replica_unavailable         │
└─────────────────────────────┴──────────────────────────────────┘
                    ↓ both ready
         merge cube → Δc → rating → final
```

### Phase notes

- **Seal** means: withhold participant-facing advantage / Runtime identity as required by policy; it does **not** block model Arena or replica-human scoring.
- Governance may keep a single `phase` for compatibility plus explicit sub-flags, e.g. `absoluteLockedAt`, `replicaHumanLockedAt`, `replicaUnavailableAt`, or nested `tracks.absolute` / `tracks.replica`. Implementations must not require `absolute_locked` before starting replica-human review.
- Until finalize: UI FINAL label stays 「进行中」, with sub-status 「等绝对分」 / 「等复刻人工」 / 「等双轨」.

## Policy record

Set once per evaluation before any replica-human submission is accepted; reject mutations afterward.

```json
{
  "visibility": "full_blind",
  "requiredPrimaries": 1,
  "forceSeparateJudges": false
}
```

- `visibility`: `full_blind` | `semi_blind` | `open` | `split_blind`
- `requiredPrimaries`: positive integer, default `1`
- `forceSeparateJudges`: boolean, default `false`

Storage: `evaluation.governance.replicaReviewPolicy` (or equivalent top-level governance field). If unset at first replica-human open, apply the defaults above and persist them so later reads are stable.

## Replica human review

### Roles

- **Human primary** (internal role name e.g. `replica_primary`): scores sources. Default one primary completes the track.
- **Human arbitrator** (`replica_arbitrator`): only when `requiredPrimaries >= 2` and a source composite spread exceeds 15.

These are humans, not models. Model Arena judges remain the existing automatic panel.

### Work product

For each required source (`submitted` + each valid `replica:{runtimeId}`):

- Four dimension scores (same keys/weights as `src/arena.js`)
- Optional short rationale
- Server recomputes weighted total; client totals are ignored for locking

Invalid / infrastructure-failed Replicas are omitted and never count as a submitted-Agent win.

### Completion

- At least `requiredPrimaries` complete primary submissions covering all required sources
- Arbitration resolved if required
- Persist `replica_human_locked` with immutable receipt hash and idempotency key

### Seat separation

When `forceSeparateJudges` is true, reject a replica-human submission (or assignment) if the same `principalId` already submitted or is assigned on the absolute human track for that evaluation.

### Open-review compatibility

If platform review becomes assignment-free (see `2026-07-26-open-human-review-skip-design.md`), replica-human scoring follows the same open desk pattern: anyone may submit; the first `requiredPrimaries` complete valid submissions satisfy the gate. Policy and finalize rules in this doc still apply. Skip-human on the **absolute** track does not skip replica-human when valid Replicas exist, unless an explicit replica skip is added later (out of scope here).

## Cube merge and finalize

1. After seal, run anonymous model Arena; store judgements as `replicaArena.modelScoringCube` (sealed).
2. On replica-human lock, append human judge rows: for every cell present in the model cube, emit `{ testId, repeatIndex, judgeId, scores }` using the human’s source composites (broadcast).
3. Collapse to bootstrap `scoreCells`: for each `(testId, repeatIndex)`, median across judges per source key.
4. Run existing `bootstrapReplicaAdvantage` and `classifyDualTrackRating`.
5. Write `resultV2.replica`, `resultV2.rating`, transition governance to `final`.
6. If no valid Replicas: set `replica_unavailable` / rating 「待复刻」; absolute remains independently locked; replica-human review not required.

### Finalize entry points

- `POST .../finalize-dual-track` (idempotent): succeeds only if absolute locked and (replica-human locked or replica unavailable).
- Optional auto-call when the second track becomes ready.
- `lock-absolute` must **not** call `releaseReplicaArena` / finalize rating.

## API surface

Exact paths may live under public or governance prefixes depending on open-review work; behavior matters more than prefix.

| Action | Behavior |
|--------|----------|
| Set replica review policy | Before first replica-human submission; validates enum/defaults |
| Submit replica-human review | Validates dimensions, policy, seat separation, source set |
| Lock absolute | Absolute only; no replica release |
| Finalize dual track | Dual gate → merge → rating |

List/detail projections expose `track: absolute | replica` for review dossiers and apply visibility masking on replica materials.

## UI

- Result strip: 「进行中」 until finalize; show which track is missing.
- Replica card: sealed → human review in progress → released Δc (or 「待复刻」).
- Judge / detail desk: absolute dossier and replica quality dossier; honor `forceSeparateJudges` and visibility.
- Create or pre-review ops UI: set visibility, `requiredPrimaries`, `forceSeparateJudges`.

## Data integrity

- Absolute totals never recompute from Replica or human replica scores.
- Reveal maps and identity unmasking for participant-facing views remain gated by finalize (and visibility policy for judge projections).
- Audit events: policy set, replica-human submitted/locked, dual-track finalized, phase transitions.

## Acceptance

- Absolute human review and Replica seal/Arena/human scoring can proceed without waiting on each other.
- Default one human primary can lock the replica-human track.
- Human scores change Δc relative to model-only cube in tests.
- `lock-absolute` leaves rating/FINAL unsettled when Replica track still open.
- Finalize requires both tracks (or unavailable Replica).
- Policy visibility modes project judge payloads correctly; policy frozen after first replica-human submission.
- `forceSeparateJudges` rejects overlapping principals when enabled.
- No valid Replica → 「待复刻」 without requiring replica-human scores.

## Testing focus

- Unit: broadcast merge, cell median collapse, bootstrap input shape.
- Governance: dual-gate finalize; lock-absolute isolation; policy immutability.
- API/UI: sub-status copy; one-primary happy path; two-primary + arbitration when configured.
