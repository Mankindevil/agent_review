# Open Human Review And Skip

Date: 2026-07-26

## Goal

Remove the admin / assignment / judge-token gate. Everyone on the platform can view results and optionally submit human scores. Skipping human review is available at multiple stages.

## Decisions

1. **Remove admin system** — drop admin role requirements and `/api/admin/*` review-assignment / admin-only governance routes that exist only for assignment management. Prefer deleting assignment creation entirely.
2. **No judge Bearer required** for reading or human scoring / skip.
3. **Public results** — default projection exposes former judge-visible model opinions and results once available (not wait for absolute lock to hide model panel from everyone).
4. **No assignments** — human_open dossiers are listed and opened by evaluation ID.
5. **Skip human review** available at:
   - **Create**: checkbox `skipHumanReview` on start form / create API
   - **Judge desk**: list all `human_open` evaluations; score or one-click skip
   - **Main detail page**: 「跳过人工打分」 while in `human_open`
6. **Skip semantics** — when skipped (create flag after model lock, or explicit skip action): synthesize human aggregate from locked model leaf medians (or mark human path skipped), clear arbitrationRequired, set aggregate complete, then lock absolute result (and existing release path if already wired). Record audit `human-review-skipped`.
7. **Optional human scoring** — if not skipped, anyone may submit a human review against a human_open evaluation without two-judge minimum when locking via skip; if users do score then lock, keep a simplified path: either skip or require at least one submitted review OR allow lock only via skip / explicit finalize. Prefer: **lock absolute only via skip button or create-time skip**; optional scoring can still save drafts/submissions for display but skip remains the fast path to finalize.  
   Simpler rule for v1 of this change:
   - Create with `skipHumanReview=true` → auto-skip after model lock
   - Otherwise stay `human_open` until someone clicks skip (desk or detail) OR until human reviews are submitted and a simplified finalize is used
   - For v1: **finalize = skip human review** (model-only absolute). Optional human scores may be saved later as enhancement; prioritize skip + open viewing + remove admin/assignments.

## Create API

`POST /api/evaluations` accepts optional boolean `skipHumanReview` (default false). Persist on the evaluation record (e.g. `governance.skipHumanReview` or `submission`/top-level flag) so the pipeline can auto-skip after model lock.

## Acceptance

- No admin assignment required to use judge desk
- Judge desk lists human_open without Bearer
- Create checkbox persists and auto-skips after model lock
- Detail page and judge desk can skip an in-flight human_open evaluation
- Public/detail views show model results without judge token
- Existing admin-only assignment tests updated or removed
