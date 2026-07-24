# Agent Diagnostics Capability Negotiation Design

## Goal

Make the Agent diagnostics platform send A2A requests that match the tested
Agent Card instead of assuming one fixed output mode and one generic task.
The Panda Market Analyst must pass ordinary and streaming protocol checks when
the user supplies its valid Bearer token.

## Current Failure

The diagnostics request builder always advertises `text/plain` and
`application/json`. The Panda Market Analyst declares `text/markdown` and
`application/json`, and rejects unsupported requested output modes.

The diagnostics page also starts with a generic natural-language task. The
market Agent intentionally accepts only its declared market operations, so the
generic task is rejected before execution.

These are request-negotiation failures. Authentication is working: an invalid
or missing Agent token returns HTTP 401, while the incompatible authenticated
requests return HTTP 400.

## Design

### Output-mode negotiation

The diagnostics service will derive accepted output modes from the Agent Card.
It will intersect `defaultOutputModes` with the formats the diagnostics parser
can inspect:

- `text/plain`
- `text/markdown`
- `application/json`

The intersection will preserve the Agent Card order and remove duplicates.
Both ordinary and streaming requests will receive the same negotiated list.

If the card does not declare `defaultOutputModes`, the request builder will
retain its current conservative defaults for compatibility with existing
cards. If the card declares the field but there is no supported intersection,
diagnostics will fail before network execution with a specific protocol error.

`buildA2ARequest` will accept an optional `acceptedOutputModes` option rather
than inspecting the full Agent Card. This keeps request serialization separate
from capability selection.

### Diagnostic Prompt selection

When a valid card is loaded or resolved, the browser will locate the first
non-empty string in `skills[].examples[]`.

For URL-based Card sources, the browser will pre-resolve the Card through the
existing same-origin resolver before submitting diagnostics. This preview is
used only to select the example Prompt; the diagnostics endpoint will still
resolve the submitted Card source itself so its source and network-policy
checks remain authoritative.

If the prompt field still contains the original stock diagnostics prompt, the
page will replace it with that skill example. If the user has edited the
field, their text will be preserved. Cards without examples keep the stock
prompt.

The server will continue treating the submitted prompt as authoritative. It
will not silently rewrite a user's task.

### Streaming declaration

Streaming remains controlled by `capabilities.streaming === true`.

- When true and the user enables streaming, diagnostics execute the streaming
  request with the same negotiated output modes as the ordinary request.
- When false or absent, diagnostics skip the streaming stage.

The Panda Market Analyst already declares streaming support, so both paths are
expected to run for that card.

## Error Handling

Capability negotiation errors will be reported as protocol-stage failures and
will not make an Agent request. HTTP failures from a compatible request retain
their existing classification.

No credentials, prompts, or Agent responses will be persisted. Existing
redaction behavior remains unchanged.

## Testing

Tests will be written before production changes and will cover:

1. `buildA2ARequest` serializes explicitly negotiated output modes.
2. Diagnostics choose the Agent Card intersection for ordinary and streaming
   requests.
3. Diagnostics fail clearly when a declared output-mode list has no supported
   intersection.
4. The page selects the first skill example only while the stock prompt is
   untouched.
5. A market Agent request using the negotiated modes succeeds instead of
   returning HTTP 400.
6. Existing diagnostics and market Agent test suites remain green.

## Out of Scope

- Loosening the market Agent to accept undeclared output formats.
- Inferring arbitrary business operations from a generic prompt.
- Changing Agent authentication or the diagnostics platform access key.
- Enabling streaming when the Agent Card does not declare it.
