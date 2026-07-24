# Task 4 rereview fixes

## Scope and method

This pass addresses the complete rereview in
`.superpowers/sdd/task-4-rereview.md`. The Critical and all four Important
findings were reproduced with failing tests before their production changes.
The EvidenceVault boundary remains unchanged: the executor passes bytes only
to the injected persistence callback and never returns them in run evidence.

## C1 — authorization and encoded credential URLs

Status: fixed.

- Authorization now accepts only an RFC 6750 `b64token`, either raw or behind
  exactly one case-insensitive `Bearer SP` prefix. Other schemes, embedded or
  edge whitespace, an empty/short/oversized token, control characters, and a
  repeated Bearer prefix fail before transport.
- Outbound authorization is canonicalized to exactly `Bearer <token>`.
- The URL preflight and all evidence redaction surfaces share one scrubber for
  object keys/values, raw objects, normalized output, errors, snapshot
  metadata, and persistence references.
- Encoding coverage includes case-insensitive hexadecimal, arbitrary
  per-code-point percent case/mixing, form `+`, padded/unpadded standard
  Base64, and padded/unpadded Base64url.
- Recursive percent/form decoding is bounded to 3 levels and 8 views. Pattern
  construction is bounded to 24 patterns, 64 KiB per pattern, a 4096-byte
  authorization value, and 2 MiB decoded inputs. There is no combinatorial
  variant enumeration.
- Reviewer reproductions cover uppercase hex, mixed percent case, form plus,
  actual U+00FF code points, unpadded standard Base64/Base64url, path/query
  placement, and a recursively escaped percent representation. Malformed
  authorization is rejected at the configuration boundary; valid-token
  encodings are rejected as `credential-in-url`. Both paths make zero
  snapshot requests and retain no variant in run evidence.

## I1 — strict versioned wire validation

Status: fixed.

- JSON-RPC response IDs must have a legal string/finite-number type and match
  the request ID with strict type-and-value equality.
- A2A 1.0 rejects every legacy `kind` discriminator on Message, Task, Part,
  status update, and artifact update.
- A2A 1.0 TaskState accepts only the exact ProtoJSON `TASK_STATE_*` wire
  values. A2A 0.3 retains its exact lowercase/hyphenated states.
- Content-Type parameters are removed when obtaining the media-type essence,
  then the essence is matched against an exact allowlist. Legal parameterized
  1.0 and 0.3 JSON and event-stream responses remain accepted; JSONP,
  suffix-spoofed JSON, and suffix-spoofed event-stream types are rejected.

## I2 — optional final v1 HTTP Task snapshot

Status: fixed.

- The executor and exported stream validator now share one state machine.
- Only A2A 1.x HTTP+JSON streaming may emit one final Task snapshot after a
  terminal event. It must have the locked task/context identity, be terminal
  itself, and be the last object.
- Different identity, non-terminal snapshots, more than one snapshot, and any
  later event remain protocol errors. JSON-RPC and 0.3 behavior is unchanged.
- A later complete Task artifact snapshot is authoritative over earlier
  streamed chunks, preventing chunk replay. Status output records transitions
  rather than duplicate cumulative snapshots; messages/history are deduped by
  stable protocol identity.

## I3 — snapshot persistence deadline and cancellation

Status: fixed.

- Fetch, response processing/hash checks, and persistence all share the batch
  and turn wall-clock deadline.
- Fetch and persistence are each raced against a bounded internal abort
  signal linked to caller cancellation. Timers and listeners are removed in
  `finally`, and a late callback rejection remains observed by the race.
- `persistSnapshot` receives `signal` and `remainingMs`.
- A `batchTimeoutMs: 1` regression with a 30 ms persistence callback returns a
  timeout before persistence completes, produces no successful snapshot, and
  external abort is classified as signal cancellation.

## I4 — artifact Part multiplicity

Status: fixed.

- Global JSON-content deduplication was removed from normalized Parts.
- Message/history/status replay is deduped by stable message identity and
  source provenance.
- Assembled artifact Parts preserve event order and multiplicity, so two
  independent append events containing identical text remain two Parts and
  contribute twice to normalized text.
- Replayed cumulative Task snapshots remain deduplicated.

## Recorded Minor findings

- M1, partial-batch persistence orphaning, remains recorded. The current
  persistence interface has no transaction, rollback, or cleanup contract;
  changing that contract is outside this rereview fix. Deadline cancellation
  reduces exposure but cannot undo a callback that already committed.
- M2, timing separation, remains recorded by design. Existing `endedAt` and
  `durationMs` describe the Agent network response and are not extended to
  include platform snapshot/persistence work, so Agent efficiency scoring is
  not polluted. No ambiguous combined timing field was added.

## TDD and verification evidence

RED runs demonstrated the original credential prefetch/leak, ambiguous
authorization headers, permissive ID/enum/kind/media-type parsing, rejection
of the legal final Task snapshot, persistence overrun, and loss of duplicate
append chunks. A separate RED run proved recursively percent-escaped
credentials bypassed the initial fixed pattern set before bounded decoding
was added.

Final verification:

- Rereview five-file focused command: 109 passed, 0 failed.
- Full repository suite: 238 passed, 0 failed.
- `node --check` over every JavaScript file: passed.
- `git diff --check`: passed.

No Critical or Important rereview finding remains open.
