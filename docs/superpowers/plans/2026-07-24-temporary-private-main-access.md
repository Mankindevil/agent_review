# Temporary Private Main Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicly expose only the Agent Card diagnostics console while keeping the full evaluation platform reachable through an SSH tunnel.

**Architecture:** The Node server serves `/agent-check` as an alias for the existing diagnostics HTML. Production Nginx uses exact public allowlist locations and returns `404` for all other HTTPS paths. The diagnostics access key remains an application-level Bearer credential and is rotated atomically during deployment.

**Tech Stack:** Node.js HTTP server, Nginx, systemd, PowerShell/OpenSSH deployment.

## Global Constraints

- Do not add an application login flow.
- Keep `/api/health` public for monitoring.
- Keep `/api/agent-diagnostics` protected by `AGENT_DIAGNOSTICS_ACCESS_KEY`.
- Preserve HTTPS, ACME challenge handling, 21-minute proxy timeouts, and rollback backups.
- Commit and push every tracked change before production deployment.

---

### Task 1: Add the suffixless diagnostics route

**Files:**
- Modify: `test/api.test.js`
- Modify: `server.js`
- Modify: `README.md`
- Modify: `docs/AGENT_DIAGNOSTICS_GUIDE.md`
- Modify: `docs/PRODUCTION_OPERATIONS.md`

**Interfaces:**
- Consumes: the existing `staticFile(pathname, response)` handler.
- Produces: `GET /agent-check` returning the same HTML as `GET /agent-check.html`.

- [ ] **Step 1: Write the failing API test**

Add a fetch for `${origin}/agent-check`, assert status `200`, and assert its body contains `diagnostics-form`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/api.test.js`

Expected: the suffixless response is the main SPA and lacks `diagnostics-form`.

- [ ] **Step 3: Implement the alias**

In `staticFile`, map `pathname === '/agent-check'` to `/agent-check.html` before resolving the public path.

- [ ] **Step 4: Update current user-facing links**

Replace operational and current-guide `/agent-check.html` links with `/agent-check`. Keep historical specs and plans unchanged.

- [ ] **Step 5: Verify GREEN**

Run: `node --test test/api.test.js`

Expected: all API tests pass.

---

### Task 2: Restrict production Nginx to diagnostics routes

**Files:**
- Modify: `deploy/nginx-production.conf`
- Modify: `test/deploy-config.test.js`

**Interfaces:**
- Consumes: the Node service at `127.0.0.1:4173`.
- Produces: exact Nginx locations for `/agent-check`, its assets, `/api/agent-diagnostics`, and `/api/health`; catch-all `404`.

- [ ] **Step 1: Write the failing deployment test**

Assert the config contains exact public locations, a `308` redirect from `/agent-check.html`, and a catch-all `return 404`.

- [ ] **Step 2: Verify RED**

Run: `node --test test/deploy-config.test.js`

Expected: assertions fail because the current `location /` proxies the full application.

- [ ] **Step 3: Implement exact Nginx locations**

Use one shared proxy parameter include pattern inline for the diagnostic API and exact static locations. Proxy `/agent-check` to `/agent-check.html`; redirect the old suffix path; return `404` from `location /`.

- [ ] **Step 4: Verify locally**

Run: `npm test`

Run: `npm run check`

Expected: all tests and syntax checks pass.

- [ ] **Step 5: Commit and push**

Commit the implementation, push `codex/private-main-access`, and build the deployment configuration from that exact commit.

- [ ] **Step 6: Deploy atomically**

Back up `/etc/nginx/sites-available/agent-review` and `/etc/agent-review/agent-review.env`. Install the rendered Nginx configuration, rotate the diagnostics key without printing it in remote logs, run `nginx -t`, reload Nginx, and restart `agent-review`.

- [ ] **Step 7: Production acceptance**

Verify public allowlisted routes, public `404` responses for the main platform, expected `401` without a diagnostics key, successful diagnostics guard behavior with the new key, SSH-tunnel access, service health, and rollback paths.
