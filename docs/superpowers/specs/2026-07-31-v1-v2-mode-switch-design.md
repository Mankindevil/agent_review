# V1 / V2 Homepage Mode Switch Design

## Goal

Make both evaluation generations visibly accessible from the same public
homepage while preserving distinct, copyable entry URLs:

- `/?version=v1` opens the classic V1 evaluation flow.
- `/?version=v2` opens the evidence-backed V2 evaluation flow.
- `/` defaults to V2 when V2 is available.

The current server capability flag must no longer double as the user's selected
evaluation version. Enabling V2 must not hide or disable V1.

## Scope

This change covers homepage mode selection, URL behavior, form visibility,
submission routing, accessibility, automated tests, and production deployment.
It does not change either evaluation schema, scoring logic, evidence storage,
governance authorization, or the `/agent-check` diagnostics page.

## User Experience

Add a compact version navigation rail near the top of the homepage, above the
evaluation intake:

- **V1 经典评测** links to `/?version=v1`.
- **V2 证据评测** links to `/?version=v2`.
- The selected link is visually active and carries `aria-current="page"`.
- Each link includes a short plain-language description so users understand
  that V1 is the classic model-scoring flow and V2 is the evidence and Replica
  flow.

The controls are regular links rather than an in-place JavaScript toggle.
Switching versions therefore reloads the page, produces a shareable URL, and
clears any Agent authorization token or other unsaved sensitive input.

On V1:

- Show demo/live mode, Seed, data/runtime status, and single-model/four-model
  scoring controls.
- Keep the shared Agent Card and examples editors visible.
- Hide V2-only skip-human-review and Replica policy controls.
- Submit the existing V1 request without `schemaVersion: 2`.

On V2:

- Hide V1-only mode, Seed, runtime status, and scoring controls.
- Show the V2 heading, evidence-oriented copy, skip-human-review, and Replica
  policy controls.
- Keep the shared Agent Card and examples editors visible.
- Submit the existing V2 request with `schemaVersion: 2`.

## URL and Capability Rules

URL selection and server capability are separate state:

1. `?version=v1` always selects V1.
2. `?version=v2` selects V2 only when `/api/health` reports
   `a2aBlackBoxV1Enabled: true`.
3. With no valid `version` parameter, select V2 when available and V1
   otherwise.
4. If `?version=v2` is requested while V2 is unavailable, keep the V2 link
   selected, disable submission, show a specific availability error, and leave
   the V1 link usable.
5. Unknown or repeated `version` values are treated as no valid selection and
   follow the default rule.

The URL query parameter is the source of user intent. The health response is
only the source of V2 availability and service defaults.

## State and Data Flow

Introduce separate client state for:

- selected evaluation version (`v1` or `v2`);
- whether V2 capability is available;
- whether health resolution has completed.

Initialization proceeds in this order:

1. Parse the requested version from `location.search`.
2. Fetch `/api/health`.
3. Resolve the effective version using the URL and V2 availability rules.
4. Apply form visibility and selected-navigation state.
5. Enable the submission button only when the effective version is usable.

Submission dispatches by selected version, not directly by the capability
flag. Existing V1 and V2 request builders remain the schema boundaries.

## Error Handling

- If health cannot be loaded, disable submission and retain both navigation
  links. Explain that the platform cannot confirm V2 availability.
- If V2 is explicitly requested but disabled, show “V2 证据评测当前未启用” and
  direct the user to V1.
- A V1 request remains usable when the health response successfully reports
  V2 disabled.
- Existing submission errors remain version-specific and unchanged.

## Accessibility and Visual Fit

The switch follows the existing Panda AI锐评局 visual language rather than
introducing a new design system. It uses semantic navigation, keyboard-focus
styles, sufficient contrast, and responsive wrapping on narrow screens. The
active state is conveyed by text and `aria-current`, not color alone. No new
animation is required.

## Security

- Version switching uses navigation, so sensitive unsaved fields are cleared
  by page reload.
- No token is placed in the URL or browser storage.
- The change does not widen the Nginx surface beyond the already authorized
  full-platform proxy.
- Existing V2 evidence encryption and governance authorization remain
  unchanged.

## Tests

Add automated coverage for:

- URL parsing for V1, V2, missing, invalid, and repeated values;
- default selection with V2 enabled and disabled;
- explicit unavailable V2 behavior;
- V1 and V2 visibility decisions;
- submission dispatch selecting the V1 or V2 request builder;
- static homepage presence of the two version links and accessibility state.

Run the focused mode-selection and homepage tests, deployment configuration
tests, syntax checks, and the existing relevant Node test set. Production
acceptance must independently verify:

- `/?version=v1` visibly shows V1 controls and hides V2-only controls;
- `/?version=v2` visibly shows V2 controls and hides V1-only controls;
- `/` defaults to V2 while the production V2 flag is enabled;
- both URLs load their JavaScript and CSS over trusted HTTPS;
- `/api/health` still reports V2 enabled and the application service remains
  loopback-only.

## Deployment and Rollback

Package the current approved source state as a new immutable release, switch
`/opt/agent-review/app` atomically, and restart only `agent-review`. Nginx and
the certificate configuration do not require behavioral changes for the query
parameter URLs.

Retain the previous release symlink target for rollback. If either version
fails visibility or submission-path acceptance, restore the previous release,
restart `agent-review`, and verify `/api/health` and the existing public
homepage before further diagnosis.
