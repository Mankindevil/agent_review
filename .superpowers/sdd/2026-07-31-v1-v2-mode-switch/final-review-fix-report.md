# Final Review Fix Report — V1/V2 Homepage Eligibility

## Scope

Addressed the final-review findings only in the homepage version-selection
flow, its cache-busted assets, and focused UI tests. No deployment, `.env`,
or Nginx files were changed.

## Root cause

`showLanding()` called `restoreV2StartButton()` for every selected V2 state.
That helper always enabled the button, so an explicitly selected but
unavailable V2 could become submit-ready after returning home. Submission
also dispatched from the selected string without first checking whether
health had resolved or that version was usable. The landing reset additionally
discarded `location.search`.

## TDD record

### RED

Added behavioral tests to `test/evaluation-version-ui.test.js` before adding
the new shared version-UI module. The first focused run was intentionally
red:

```sh
node --test test/evaluation-version-ui.test.js
```

Exact result: exit `1`, `0` passing test files, `1` failing test file. Node
reported `ERR_MODULE_NOT_FOUND` for
`public/evaluation-version-ui.js`, the missing production boundary required
by the new behavioral tests.

### GREEN

Implemented `public/evaluation-version-ui.js` as the shared eligibility,
landing-button, history-URL, and create-request boundary. `public/app.js`
uses it to block unresolved/unusable submission before parsing or resolving
an Agent Card, to restore the same disabled state on landing return, and to
preserve `location.search` while clearing the hash.

Focused behavior run:

```sh
node --test test/evaluation-version-ui.test.js
```

Exact result: exit `0`; `7` tests passed, `0` failed.

Required verification run:

```sh
node --test test/a2a-ui-helpers.test.js test/evaluation-version-ui.test.js test/branding-ui.test.js test/v1-scoring-ui.test.js
```

Exact result: exit `0`; `24` tests passed, `0` failed.

Syntax verification:

```sh
npm run check
```

Exact result: exit `0`; `Syntax OK · 195 JavaScript files`.

## Behavioral coverage

- Explicit V1/V2 and default V1/V2 resolution under both V2-capability
  values.
- Explicit unavailable V2 remains selected, disabled, and shows the
  unavailable message after landing restoration.
- Submission chooses the V1/V2 request shape only when the resolved version
  is usable; unresolved health and unavailable V2 select no submission.
- Landing history URLs preserve `?version=v1` / `?version=v2` (and other
  query parameters) while removing an evaluation hash.
- Unselected version-nav text is tested at `4.91:1` contrast against
  `#dfe3e4`, exceeding the `4.5:1` normal-text requirement.

## Self-review

- V1 is usable whenever health is resolved, including when V2 is unavailable.
- V2 is usable only after resolved health confirms V2 capability.
- `showLanding()` and `submitEvaluation()` derive their eligibility from the
  same state function, preventing the prior enable-on-return mismatch.
- Homepage CSS and JavaScript asset queries were advanced to
  `20260731-version-switch2`, with their existing static assertions updated.
- `git diff --check` is clean for all scoped files.

## Concern

The known pre-existing `test/api.test.js` lifecycle hang was not rerun, per
the task instruction. Its two cache-query assertions were updated to match
the intentional asset cache bump; the required non-hanging focused suite and
syntax verification completed successfully.
