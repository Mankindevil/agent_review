# Agent Network Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Card discovery and A2A execution tolerate intermittent pre-connection failures without ever exceeding one bounded overall deadline.

**Architecture:** Extend the shared SSRF-safe HTTP client with opt-in retries that are allowed only before a TCP/TLS connection is established. Each attempt receives the remaining time from one outer deadline; Agent Card discovery uses three total attempts within 30 seconds and A2A uses three total attempts within a 90-second execution deadline.

**Tech Stack:** Node.js ESM, `node:http`, `node:https`, `node:test`, systemd, Nginx.

## Global Constraints

- Use three total attempts: one initial attempt plus two transient connection retries.
- Retry only DNS, TCP connection, and TLS setup failures before the request is connected; never retry HTTP responses, protocol errors, caller cancellation, or failures after the connection is established.
- Every retry shares the original operation deadline; no attempt may reset or extend it.
- Agent Card discovery total deadline is 30,000 ms with an 8,000 ms connection-attempt limit.
- Standard V1 A2A execution total deadline is 90,000 ms with a 10,000 ms connection-attempt limit.
- Preserve SSRF validation, DNS pinning, response size limits, cancellation, timing instrumentation, and credential redaction.

---

### Task 1: Shared pre-connection retry boundary

**Files:**
- Modify: `src/safe-http.js`
- Test: `test/safe-http.test.js`

**Interfaces:**
- Consumes: existing `safeHttpRequest(rawUrl, options)` and its `timeoutMs`, `signal`, DNS validation, and request hooks.
- Produces: opt-in `maxAttempts` and `connectTimeoutMs` options with one total deadline.

- [x] **Step 1: Write failing integration tests**

Add real local-server tests proving that two refused connections followed by a reachable third attempt succeed, that the total timeout terminates the retry sequence, and that a connection lost after establishment is not replayed.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test test/safe-http.test.js`

Expected: the retry-success test fails because the current client performs only one request.

- [x] **Step 3: Implement the minimal retry loop**

Keep one outer `deadline = Date.now() + timeoutMs`; for each attempt combine caller, total-deadline, and connection-attempt abort signals. Mark HTTPS connected only on `secureConnect` and HTTP connected on `connect`. Retry only `dns`, `connection`, or `tls` failures while `connected === false` and attempts remain.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/safe-http.test.js`

Expected: all tests pass, including cancellation and instrumentation tests.

### Task 2: Agent Card and A2A policy wiring

**Files:**
- Modify: `src/a2a.js`
- Modify: `src/a2a-executor.js`
- Modify: `src/agent-diagnostics.js`
- Modify: `src/pipeline.js`
- Modify: `deploy/nginx-production.conf`
- Modify: `docs/AGENT_DIAGNOSTICS_GUIDE.md`
- Test: `test/a2a.test.js`
- Test: `test/a2a-executor.test.js`
- Test: `test/agent-diagnostics.test.js`
- Test: `test/deploy-config.test.js`

**Interfaces:**
- Consumes: Task 1 `safeHttpRequest` retry options.
- Produces: Agent Card discovery with `{ timeoutMs: 30_000, maxAttempts: 3, connectTimeoutMs: 8_000 }`; A2A transport with `{ maxAttempts: 3, connectTimeoutMs: 10_000 }`; V1 A2A default and pipeline timeout of 90,000 ms.

- [x] **Step 1: Write failing policy tests**

Assert observable request behavior: Card resolution forwards the retry policy, an A2A turn without an explicit timeout receives approximately 90,000 ms and three attempts, diagnostics uses the 30,000 ms Card deadline, and Nginx allows more than the Card deadline.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/a2a.test.js test/a2a-executor.test.js test/agent-diagnostics.test.js test/deploy-config.test.js`

Expected: timeout and retry-policy assertions fail against the old 12,000/45,000 ms behavior.

- [x] **Step 3: Wire the policies**

Pass retry options only at Card and A2A call sites, change standard A2A defaults and V1 pipeline calls to 90,000 ms, change Card discovery to 30,000 ms, and set the public Card resolver Nginx send/read timeout to 40 seconds.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/a2a.test.js test/a2a-executor.test.js test/agent-diagnostics.test.js test/deploy-config.test.js`

Expected: all focused tests pass.

### Task 3: Release verification and production acceptance

**Files:**
- No additional production files.

**Interfaces:**
- Consumes: Tasks 1–2 implementation and tests.
- Produces: pushed Git commit and an immutable production release.

- [ ] **Step 1: Run regression gates**

Run: `node --test test/safe-http.test.js test/a2a.test.js test/a2a-executor.test.js test/agent-diagnostics.test.js test/deploy-config.test.js`

Run: `npm run test:v1-release`

Run: `npm run check`

- [ ] **Step 2: Review the staged diff**

Confirm only the plan, retry implementation, policy wiring, Nginx configuration, and their tests are staged; preserve unrelated user modifications.

- [ ] **Step 3: Commit and push**

Commit message: `fix: retry transient Agent connections`

- [ ] **Step 4: Deploy and accept**

Build an immutable release from the exact commit, run the release gates before switching, atomically update `/opt/agent-review/app`, reload Nginx, restart `agent-review.service`, verify public health, and run repeated production transport-only requests against the reported expired PandaAI Card URL. Treat any received HTTP response as network success; do not validate or invoke the expired Agent.
