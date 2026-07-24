# Agent Check URL Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete Agent Card URL and service-root discovery inputs to `/agent-check` without exposing an unauthenticated resolver.

**Architecture:** Extend the authenticated diagnostics request contract with a mutually exclusive `cardSource`. Resolve it inside `runAgentDiagnostics()` through the existing SSRF-safe `resolveAgentCard()`, then reuse the unchanged validation and A2A call stages. Add a three-way source selector to the current page and document the behavior.

**Tech Stack:** Node.js ESM, native HTTP server, browser JavaScript, CSS, `node:test`.

## Global Constraints

- Keep JSON upload and paste backward compatible.
- Accept only `card-url` and `service-url` source types.
- Do not expose `/api/agent-cards/resolve` through the public Nginx allowlist.
- Keep the existing platform access-key guard, 1 MB Card limit, 12-second Card fetch timeout, SSRF checks, DNS pinning, and no-redirect behavior.
- Derive the tested Agent service URL only from the resolved Card.

---

### Task 1: Diagnostics URL resolution

**Files:**
- Modify: `src/agent-diagnostics.js`
- Test: `test/agent-diagnostics.test.js`

**Interfaces:**
- Consumes: `resolveAgentCard(sourceType, url, timeoutMs)` from `src/a2a.js`
- Produces: `validateDiagnosticsInput()` output containing either `agentCard` or `cardSource`, and `runAgentDiagnostics(rawInput, { resolveCard })`

- [ ] **Step 1: Write failing contract tests**

Add table-driven tests proving that complete Card URLs and service roots normalize to `cardSource`, while missing, mixed, unknown, oversized, credential-bearing, and malformed source inputs fail with HTTP 400 client errors.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/agent-diagnostics.test.js`

Expected: URL-source cases fail because `validateDiagnosticsInput()` currently requires `agentCard`.

- [ ] **Step 3: Implement minimal input normalization and resolution**

Allow exactly one source, resolve `cardSource` before the existing Card stages, inject the resolver for deterministic tests, and convert resolver errors into a failed `card-input` check with remaining checks blocked.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/agent-diagnostics.test.js`

Expected: all diagnostics tests pass.

### Task 2: API and browser input modes

**Files:**
- Modify: `public/agent-check.html`
- Modify: `public/agent-check.js`
- Modify: `public/agent-check.css`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `POST /api/agent-diagnostics` with either `agentCard` or `cardSource`
- Produces: three source-mode controls and a mutually exclusive request payload

- [ ] **Step 1: Write failing API/page tests**

Assert the page exposes JSON, Card URL, and service-root controls, and exercise the authenticated diagnostics route with an injected URL resolver through the server integration boundary where practical.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/api.test.js`

Expected: selectors and URL request behavior are absent.

- [ ] **Step 3: Implement the source selector**

Add accessible source buttons, URL input/help copy, request payload switching, URL-source summaries, busy/error handling, and form reset behavior. Preserve file upload, JSON paste, auth target confirmation, streaming consent, and all current result rendering.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/api.test.js`

Expected: all API/page tests pass.

### Task 3: Documentation and release verification

**Files:**
- Modify: `docs/AGENT_DIAGNOSTICS_GUIDE.md`
- Modify: `README.md`
- Test: `test/api.test.js`

**Interfaces:**
- Produces: operator and participant instructions matching the deployed behavior

- [ ] **Step 1: Add failing documentation expectations where they protect a user-facing contract**

Require the diagnostics guide to identify both URL modes, automatic well-known discovery, and URL-fetch restrictions.

- [ ] **Step 2: Update documentation**

Document the three inputs, exact request shapes, retrieval limits, error categories, and the rule that the service target comes only from the Card.

- [ ] **Step 3: Run full verification**

Run: `npm test`

Run: `node --check src/agent-diagnostics.js`

Run: `node --check public/agent-check.js`

Expected: all tests and syntax checks pass.

- [ ] **Step 4: Commit, push, and deploy**

Commit the implementation on `codex/private-main-access`, push without force, deploy the exact commit using the existing production release procedure, and verify `/agent-check`, its static assets, `/api/health`, protected diagnostics behavior, and the continued denial of private-platform routes.
