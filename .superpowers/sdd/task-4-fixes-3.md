# Task 4 second-rereview fix

## Scope

This pass closes the remaining Critical authorization-evidence finding from
the second rereview. It is limited to the A2A credential scrubber and its
regression tests.

## Reproduction and root cause

The legal RFC 6750 token `a/b`, after five `encodeURIComponent` passes, is
`a%252525252Fb`. The prior scrubber inspected at most three decode levels and
eight views, but returned only the views it had reached. It did not report
that normalization had stopped while another decode would still change the
value. Consequently, callers interpreted "not found in these bounded views"
as safe:

- URL preflight invoked the snapshot transport once.
- `rawObjects` and `normalized` retained the encoded URL.
- Other evidence strings could retain the same nested representation.

The same open behavior existed when the input length bound was exceeded or a
decode raised an exception.

## Fix

Secret normalization now returns both its bounded views and an `unsafe`
state.

- At the configured depth boundary, it performs only a bounded next-step
  probe. If either percent or form normalization would still change the
  value, the result is unsafe.
- An input beyond 2 MiB, an attempt to create more than eight views, exhaustion
  of the 16 MiB normalization-work budget, or any decode exception is unsafe.
- Work is linear in input length under fixed depth/view/work constants.
  Form decoding uses a same-length `+` to space transform; no variant
  enumeration or unbounded recursion is used.
- `contains` treats unsafe normalization as sensitive, so URL preflight fails
  before snapshot transport.
- `text` and recursive `value` scrubbing replace an unsafe string or object
  key/value leaf in full with `[REDACTED]` before pattern scans.
- Inputs within the bounds still use the existing exact credential patterns.
  A normal single-layer percent URL that stabilizes and has no credential
  match remains allowed.

## TDD evidence

The new regressions were run before the production change and failed for the
expected reasons:

- The exact depth-five URL and a malformed percent URL each made one snapshot
  request.
- The far-over-limit chain and overlength URL fell through to generic unsafe
  URL handling rather than credential preflight.
- The nested representation remained in arbitrary message text and metadata.
- The normal non-nested `%20` URL already succeeded, establishing the
  non-regression baseline.

After the fix, the tests require:

- zero snapshot requests for depth five, a 100,000-layer representation, an
  input beyond 2 MiB, explicit view/work-budget exhaustion, and malformed
  percent encoding;
- `credential-in-url` classification;
- exact `[REDACTED]` URL leaves in `rawObjects` and `normalized`;
- no encoded value, full URL, error echo, snapshot, or `sourceUrl` residue;
- bounded completion under one second in each adversarial case;
- full-leaf redaction for arbitrary nested evidence strings; and
- one successful snapshot request for a normal non-nested `%20` URL.

## Verification

Fresh pre-commit verification:

- Rereview five-file focused suite: 118 passed, 0 failed.
- Full repository suite: 247 passed, 0 failed.
- `npm run check`: syntax passed for all 56 JavaScript files.
- `git diff --check`: passed.

An independent read-only security review found no Critical or Important
issues. Its only Minor request was direct view/work-limit coverage; those two
regressions were added before the final verification above.
