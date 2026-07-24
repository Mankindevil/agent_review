# Task 4 review fixes

## Scope

This pass addresses every Critical and Important finding in
`.superpowers/sdd/task-4-review.md` and includes the safe Minor cleanups.
The EvidenceVault contract was not weakened: snapshot bytes remain confined
to the injected persistence boundary, while execution results contain only
durable references and derived metadata.

## Review finding traceability

- Hardened authorization handling before transport. Unsafe, malformed, or
  ambiguous credentials are rejected, and raw, Bearer-prefixed,
  JSON-escaped, slash-escaped, URI-encoded, base64/base64url, and hexadecimal
  representations are scrubbed from metadata keys and values.
- Added executor-integrated URL Part snapshot capture for agent-attributable
  output. User-history URLs are ignored, credentials are never forwarded,
  credential-bearing URLs are rejected before snapshot transport, query and
  fragment data are not retained, and bytes are never returned from the
  executor.
- Bounded snapshot work to 16 URLs, 1 MiB per URL, 4 MiB aggregate, a
  10-second fetch timeout, and a 30-second batch deadline. Snapshot capture
  requires an explicit persistence callback.
- Replaced permissive streaming acceptance with a strict Message-or-Task
  lifecycle state machine. It rejects mixed oneofs, updates before the
  initial Task, identity changes, events after terminal state, and missing
  required task/context identifiers.
- Locked GetTask polling to the original task/context identity and a single
  wall-clock deadline. Empty task identifiers are rejected before endpoint
  construction.
- Corrected multi-turn lifecycle behavior: input, authorization, and
  interruption states become resumable interruptions; task IDs are reused
  only for interrupted turns; completed turns retain context without
  resubmitting completed task IDs; terminal failures stop execution.
- Made response parsing operation-, binding-, and version-specific. JSON-RPC
  envelopes, Message/Task/Part schemas, status updates, artifact updates,
  task states, and legacy 0.3 discriminators are now validated strictly.
- Completed evidence normalization for cumulative Task snapshots, stable
  message/part/text fields, raw objects, artifact append assembly, and the
  artifact timeline.
- Added a documented public failure taxonomy for configuration, signal,
  timeout, instrumentation, transport, HTTP, content type, JSON, protocol,
  and agent failures while preserving JSON-RPC protocol codes.
- Moved the safe HTTP byte-limit check ahead of instrumentation callbacks and
  classified timing/chunk hook failures as instrumentation failures.
- Updated the legacy example Agent response to the valid 0.3 direct Task
  result shape and removed obsolete permissive parsing helpers.

## TDD evidence

Each review group was driven by a failing regression test before the
implementation change. The red cases covered authorization validation and
encoding leaks, strict response/Part/stream shapes, polling identity,
interrupted multi-turn reuse, snapshot persistence and limits, normalization,
failure taxonomy, and safe HTTP overflow/instrumentation ordering. Each group
was rerun to green before proceeding.

Final verification:

- Focused A2A and safe HTTP tests: 66 passed, 0 failed.
- Full repository suite: 211 passed, 0 failed.
- `node --check` over every tracked JavaScript source/test file: passed.
- `git diff --check`: passed.

## Design decision and residual risk

The stream validator intentionally rejects an optional final same-Task
snapshot after a terminal status update. This is stricter than the most
permissive interpretation of the protocol and prevents accepting evidence
after terminal state; the received raw events remain available to the
evidence path. No blocking review findings remain.
