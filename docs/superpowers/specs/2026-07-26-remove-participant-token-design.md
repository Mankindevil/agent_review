# Remove Participant Access Token

Date: 2026-07-26

## Goal

Delete the V2 participant access token system. Evaluation identity is the evaluation ID. Anyone who knows the ID can view participant-level projections and perform cancel / resume / delete. Judge/admin principals and agent runtime credentials stay unchanged.

## Decisions

1. **No token issuance** — create no longer returns `participantAccessToken`; do not write `participantAccess` on new records.
2. **ID is enough** — cancel, resume, appeals, and participant-level reads require no Bearer participant token.
3. **Default projection** — unauthenticated detail/events/evidence/result use the former participant audience (appealTargets, non-public evidence items).
4. **Hard delete restored** — `DELETE /api/evaluations/:id` hard-deletes V2 records (terminal statuses only), same as V1. Soft-archive path and history “归档” UX are removed; label is「删除」.
5. **Legacy records** — existing `participantAccess.tokenHash` on disk is ignored; records remain usable under the new rules. No migration required.
6. **Keep** — `REVIEW_PRINCIPALS_JSON` judge/admin auth; `agentAuthorization` / credential vault.

## Out of scope

- Changing judge/admin governance flows
- Forced purge of `participantAccess` fields from on-disk JSON
- New session/cookie auth

## Acceptance

- Create response has no `participantAccessToken`
- Cancel / resume / appeals / delete work without Authorization
- History delete removes the record; button says「删除」
- Old V2 fixtures with `tokenHash` still load and delete
- Judge/admin Bearer still works
