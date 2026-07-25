# Phase 4 Task 6 — Evidence-led dual-track results

## Delivered

- Added server-authoritative result and evidence-manifest routes.
- Evidence detail reads now verify a projected manifest commitment, decrypt from the vault, reapply redaction, and append an independent access-audit event.
- Added a dual-track result renderer plus a filtered, text-only evidence replay page.

## Security boundaries

- Query parameters never influence scores, weights, deltas, confidence, or ratings.
- Evidence manifests remain role-projected; the detail API refuses items absent from that projection.
- Evidence responses contain only a redacted payload and committed metadata; access audit records contain no payload.

## Verification

```text
node --test test/result-ui.test.js test/api.test.js test/evaluation-projection.test.js
60 passed / 0 failed

npm run check
Syntax OK · 162 JavaScript files

git diff --check --cached -- <Task 6 staged files>
exit 0
```

## Scope

Only Task 6 UI, API, projection, and test files are included in the commit.

## Commit

`9f928fd feat: publish evidence led dual track results`

## Repair round 1

- Public projections now expose locked model findings, human-review aggregate/opinion fields, and safe locked-humor fields only after the absolute lock.
- The result renderer now renders these findings, humor lines, human adjustments, and submitted-versus-each-valid-Replica median rows with Δc, confidence interval, and best baseline.
- Public evidence detail replay now permits only an evidence ID already present in the public projected manifest; authenticated participant/judge/admin reads remain role-projected. The replay page also sends an `access` query token when supplied.
- Removed the unused legacy V2 renderer from `public/app.js`.

Verification: `node --test test/result-ui.test.js test/api.test.js test/evaluation-projection.test.js` — 61 passed / 0 failed.
