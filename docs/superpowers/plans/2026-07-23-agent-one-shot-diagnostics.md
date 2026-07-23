# One-Shot Agent Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an access-key-protected one-shot A2A diagnostics page that safely discovers, validates, calls, and optionally stream-tests a public Agent, then document its operation.

**Architecture:** A shared A2A protocol layer constructs and validates binding-specific messages. A new safe HTTP layer pins validated DNS results and enforces redirect, byte, cancellation, and timeout limits. The diagnostics orchestrator produces a stable four-check report, while the server guard handles platform authentication, rate limits, and concurrency before the standalone browser UI calls it.

**Tech Stack:** Node.js 20 ESM, built-in `node:http`, `node:https`, `node:dns`, `node:test`, vanilla HTML/CSS/JavaScript.

## Global Constraints

- `AGENT_DIAGNOSTICS_ACCESS_KEY` is required; the API returns `503` when it is not configured.
- Streaming is disabled by default and requires `confirmStreamingSideEffects=true`.
- Platform access credentials never leave this server; Agent credentials never participate in Card discovery.
- Private, loopback, link-local, multicast, unspecified, and private IPv4-mapped IPv6 targets are rejected unless `ALLOW_PRIVATE_AGENT_URLS=true`.
- Request body limit is 32 KiB; Card response limit is 1 MiB; call and stream response limits are 2 MiB.
- Total timeout is clamped to 5–60 seconds.
- Diagnostic check IDs are `discovery`, `card-validation`, `call`, and `stream`; statuses are `passed`, `failed`, `skipped`, and `blocked`.
- No diagnostics state is written to `EvaluationStore` or browser storage.

---

### Task 1: Shared A2A protocol primitives

**Files:**
- Modify: `src/a2a.js`
- Modify: `test/a2a.test.js`

**Interfaces:**
- Produces: `selectInterface(card)`, `buildA2ARequest(target, prompt, options)`, `parseA2AResponse(target, payload, requestId)`, `parseSseEvents(text)`, and `validateStreamResult(target, events, requestId)`.
- Preserves: `validateAgentCard`, `getInterfaces`, `resolveAgentCard`, `callA2AAgent`, and `extractAgentText`.

- [ ] **Step 1: Write failing interface-selection and tenant tests**

Add tests proving unsupported bindings are skipped, the first supported binding is selected, and `tenant` survives normalization.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/a2a.test.js`

Expected: FAIL because `selectInterface` and the normalized `tenant` field do not exist.

- [ ] **Step 3: Implement supported-interface selection**

Normalize only `HTTP+JSON` and `JSONRPC`; preserve preference order and `tenant`; do not coerce unknown bindings to HTTP+JSON.

- [ ] **Step 4: Add failing request/response tests**

Cover A2A 1.0 JSON-RPC `SendMessage`, legacy `message/send`, HTTP+JSON `/message:send`, `tenant`, request ID matching, and JSON-RPC errors.

- [ ] **Step 5: Implement request builders and strict response parsing**

Move version/binding-specific construction out of `callA2AAgent` and keep the public function as a compatibility wrapper.

- [ ] **Step 6: Add failing SSE terminal-state tests**

Cover split lines, CRLF, comments, multiline `data`, mismatched JSON-RPC IDs, error objects, terminal Message, completed Task, and premature end after `working`.

- [ ] **Step 7: Implement SSE parsing and terminal validation**

Accept a single Message or a Task sequence ending in a terminal/interrupted state; reject partial or errored streams.

- [ ] **Step 8: Run focused tests**

Run: `node --test test/a2a.test.js`

Expected: PASS.

### Task 2: DNS-pinned safe HTTP transport

**Files:**
- Create: `src/safe-http.js`
- Create: `test/safe-http.test.js`
- Modify: `src/a2a.js`

**Interfaces:**
- Produces: `assertPublicAddress(address)`, `resolveSafeAddress(url, options)`, and `safeHttpRequest(url, options)`.
- `safeHttpRequest` returns `{ status, headers, body }` and accepts `{ method, headers, body, signal, timeoutMs, maxBytes, lookup, allowPrivate }`.

- [ ] **Step 1: Write failing address-policy tests**

Cover URL userinfo, loopback/private/link-local/multicast/unspecified IPv4 and IPv6, IPv4-mapped IPv6, mixed public/private DNS results, and the explicit private-address development override.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/safe-http.test.js`

Expected: FAIL because `src/safe-http.js` does not exist.

- [ ] **Step 3: Implement URL and resolved-address validation**

Resolve all A/AAAA records, reject the entire target when any answer is unsafe, and provide a validated lookup callback that returns the pinned selected address to the socket.

- [ ] **Step 4: Write failing transport-limit tests**

Use local test servers with `allowPrivate:true` to prove Host preservation, redirect non-following, byte limits while reading, timeout, and external abort propagation.

- [ ] **Step 5: Implement the HTTP(S) transport**

Use `node:http`/`node:https` requests with the validated lookup callback, original Host and TLS server name, composed abort signals, incremental byte accounting, and socket destruction on completion/error.

- [ ] **Step 6: Route existing A2A Card and call traffic through safe transport**

Keep current public behavior while replacing unbounded `fetch().text()/json()` reads.

- [ ] **Step 7: Run safe transport and existing A2A tests**

Run: `node --test test/safe-http.test.js test/a2a.test.js test/example-agents.test.js`

Expected: PASS.

### Task 3: Diagnostics guard and orchestration

**Files:**
- Create: `src/diagnostics-guard.js`
- Create: `src/agent-diagnostics.js`
- Create: `test/agent-diagnostics.test.js`

**Interfaces:**
- Produces: `createDiagnosticsGuard(options)`, `validateDiagnosticsInput(input)`, and `runAgentDiagnostics(input, options)`.
- `runAgentDiagnostics` returns `{ ok, durationMs, streamingRequested, streamingOk, checks }`.

- [ ] **Step 1: Write failing guard tests**

Cover missing configuration (`503`), missing/wrong access key (`401`), rate limit (`429` with retry seconds), constant-time-compatible comparison, and immediate concurrency rejection (`503`).

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/agent-diagnostics.test.js`

Expected: FAIL because guard/orchestrator modules do not exist.

- [ ] **Step 3: Implement the in-memory guard**

Hash keys for rate-limit buckets, prune expired windows, enforce configured concurrency without an unbounded queue, and always release a slot in `finally`.

- [ ] **Step 4: Add failing input and four-check contract tests**

Cover URL/prompt/token limits, streaming confirmation, discovery failure dependency states, validation failure dependency states, ordinary failure with independent streaming, and streaming disabled/unsupported states.

- [ ] **Step 5: Implement validation and stage orchestration**

Share one deadline across stages, classify expected failures, return safe summaries/suggestions, and keep expected upstream failures inside HTTP-200-compatible reports.

- [ ] **Step 6: Add failing credential-scope and redaction tests**

Prove Agent Token is absent from Card discovery, same-origin call headers include it, cross-origin calls are blocked unless explicitly authorized, and echoed secrets are redacted recursively.

- [ ] **Step 7: Implement credential policy and report redaction**

Never expose either secret in errors, details, previews, or logger arguments.

- [ ] **Step 8: Run focused diagnostics tests**

Run: `node --test test/agent-diagnostics.test.js`

Expected: PASS.

### Task 4: Protected diagnostics API

**Files:**
- Modify: `server.js`
- Modify: `test/api.test.js`

**Interfaces:**
- Adds: `POST /api/agent-diagnostics`.
- Uses: `Authorization: Bearer <platform key>` and a maximum 32 KiB JSON body.

- [ ] **Step 1: Write failing API tests**

Cover unconfigured/missing/wrong key responses, input failures, successful report status, upstream failure as HTTP 200, streaming confirmation, no `EvaluationStore` mutation, and stable JSON errors.

- [ ] **Step 2: Run API tests and verify RED**

Run: `node --test test/api.test.js`

Expected: FAIL with the route returning 404.

- [ ] **Step 3: Implement the route**

Authenticate before reading the body, acquire the diagnostics guard, create an AbortController tied to client disconnect, run diagnostics, map only API-layer errors to non-200 status, and release resources in `finally`.

- [ ] **Step 4: Run API tests**

Run: `node --test test/api.test.js`

Expected: PASS.

### Task 5: Standalone diagnostics page

**Files:**
- Create: `public/agent-check.html`
- Create: `public/agent-check.js`
- Create: `public/agent-check.css`
- Modify: `test/api.test.js`

**Interfaces:**
- Calls: `POST /api/agent-diagnostics`.
- Renders: four fixed checks and top-level ordinary/streaming conclusions.

- [ ] **Step 1: Write failing static UI tests**

Assert the page contains separate platform/Agent secret inputs, source type, URL, prompt, cross-origin authorization, streaming opt-in, side-effect confirmation, submit action, and four result containers.

- [ ] **Step 2: Run the focused API/static tests and verify RED**

Run: `node --test test/api.test.js`

Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement semantic HTML and accessible interaction**

Keep secrets in input elements only, never touch Web Storage or the URL, disable confirmation unless streaming is selected, clear visible credentials on reload, and render escaped server data.

- [ ] **Step 4: Implement the visual system**

Use the existing audit-desk language with a distinct “signal trace” result rail, restrained motion, strong focus states, responsive layout, and no external assets.

- [ ] **Step 5: Run static tests and manually inspect markup/CSS**

Run: `node --test test/api.test.js`

Expected: PASS.

### Task 6: Operator and user documentation

**Files:**
- Create: `docs/AGENT_DIAGNOSTICS_GUIDE.md`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Documents: access-key configuration, two credential scopes, operation, status meanings, safety limits, streaming side effects, and troubleshooting.

- [ ] **Step 1: Add documentation assertions**

Extend static tests to require links from README and the guide’s critical configuration and safety terms.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/api.test.js`

Expected: FAIL until the guide and links exist.

- [ ] **Step 3: Write configuration and usage documentation**

Include PowerShell and POSIX environment examples, field-by-field instructions, result tables, HTTP/error tables, side-effect warnings, and local example-agent instructions.

- [ ] **Step 4: Update environment template and README**

Add safe defaults and link the standalone page and guide without exposing a real key.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/api.test.js`

Expected: PASS.

### Task 7: Full verification

**Files:**
- Review all files changed by Tasks 1–6.

**Interfaces:**
- Produces a verified, implementation-complete worktree.

- [ ] **Step 1: Run syntax checks**

Run: `npm run check`

Expected: exit 0.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check` and `git status --short`

Expected: no whitespace errors; only intended implementation, test, and documentation files changed.

- [ ] **Step 4: Re-read the design coverage**

Verify every requirement in `docs/superpowers/specs/2026-07-23-agent-one-shot-diagnostics-design.md` is implemented or explicitly reported as a remaining gap.
