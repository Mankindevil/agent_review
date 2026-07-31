# V1 / V2 Homepage Mode Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make V1 and V2 independently selectable and visibly usable from the same public homepage through `/?version=v1` and `/?version=v2`.

**Architecture:** Keep the existing shared HTML and submission endpoint, but separate URL-selected evaluation version from the server-reported V2 capability. Pure helpers parse and resolve version state; `app.js` applies that state to visibility, availability, navigation, and submission dispatch. Regular version links reload the page so URLs are shareable and unsaved tokens are cleared.

**Tech Stack:** Node.js 24, browser ES modules, HTML/CSS, Node built-in test runner, systemd, Nginx, SSH/SCP.

## Global Constraints

- `/?version=v1` always selects V1.
- `/?version=v2` selects V2 only when `/api/health` reports `a2aBlackBoxV1Enabled: true`.
- `/` defaults to V2 when available and V1 otherwise.
- Explicit unavailable V2 remains visibly selected, disables submission, and links back to V1.
- Switching versions reloads the page and never writes Agent authorization to URL or browser storage.
- V1 submission omits `schemaVersion: 2`; V2 submission includes `schemaVersion: 2`.
- Existing evaluation schemas, scoring, evidence, governance, Nginx exposure, and `/agent-check` behavior do not change.
- Do not stage or commit unrelated dirty-worktree files.

---

## File Map

- `public/a2a-ui-helpers.js`: pure query parsing and version/capability resolution.
- `test/a2a-ui-helpers.test.js`: unit coverage for health capability and version resolution.
- `public/index.html`: semantic V1/V2 navigation links and cache-busted assets.
- `public/styles.css`: existing-brand version switch, active state, focus, and narrow-screen behavior.
- `public/app.js`: client state, visibility, availability, and V1/V2 submission dispatch.
- `test/evaluation-version-ui.test.js`: static homepage and app integration contract.
- `docs/superpowers/specs/2026-07-31-v1-v2-mode-switch-design.md`: approved design source.
- `docs/superpowers/plans/2026-07-31-v1-v2-mode-switch.md`: execution checklist.

---

### Task 1: Pure URL and Capability Resolution

**Files:**
- Modify: `public/a2a-ui-helpers.js`
- Modify: `test/a2a-ui-helpers.test.js`

**Interfaces:**
- Produces: `requestedEvaluationVersion(search: string): 'v1' | 'v2' | null`
- Produces: `resolveEvaluationVersion(requestedVersion: 'v1' | 'v2' | null, v2Available: boolean): { selectedVersion: 'v1' | 'v2', usable: boolean }`
- Consumes: existing `evaluationModeFromHealth(payload)`

- [ ] **Step 1: Add failing URL parsing and resolution tests**

Append imports and tests equivalent to:

```js
import {
  evaluationModeFromHealth,
  requestedEvaluationVersion,
  resolveEvaluationVersion
} from '../public/a2a-ui-helpers.js';

test('parses only one explicit V1 or V2 query value', () => {
  assert.equal(requestedEvaluationVersion('?version=v1'), 'v1');
  assert.equal(requestedEvaluationVersion('?version=v2'), 'v2');
  assert.equal(requestedEvaluationVersion(''), null);
  assert.equal(requestedEvaluationVersion('?version=v3'), null);
  assert.equal(requestedEvaluationVersion('?version=v1&version=v2'), null);
});

test('separates selected evaluation version from V2 availability', () => {
  assert.deepEqual(resolveEvaluationVersion('v1', true), {
    selectedVersion: 'v1',
    usable: true
  });
  assert.deepEqual(resolveEvaluationVersion('v2', true), {
    selectedVersion: 'v2',
    usable: true
  });
  assert.deepEqual(resolveEvaluationVersion('v2', false), {
    selectedVersion: 'v2',
    usable: false
  });
  assert.deepEqual(resolveEvaluationVersion(null, true), {
    selectedVersion: 'v2',
    usable: true
  });
  assert.deepEqual(resolveEvaluationVersion(null, false), {
    selectedVersion: 'v1',
    usable: true
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/a2a-ui-helpers.test.js
```

Expected: FAIL because both new exports are missing.

- [ ] **Step 3: Implement the two pure helpers**

Add:

```js
export function requestedEvaluationVersion(search = '') {
  const values = new URLSearchParams(String(search)).getAll('version');
  if (values.length !== 1) return null;
  return values[0] === 'v1' || values[0] === 'v2' ? values[0] : null;
}

export function resolveEvaluationVersion(requestedVersion, v2Available) {
  const selectedVersion = requestedVersion || (v2Available ? 'v2' : 'v1');
  return {
    selectedVersion,
    usable: selectedVersion === 'v1' || v2Available
  };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/a2a-ui-helpers.test.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit only Task 1 files**

```bash
git add public/a2a-ui-helpers.js test/a2a-ui-helpers.test.js
git diff --cached --check
git commit -m "feat(ui): resolve V1 and V2 URL selection"
```

---

### Task 2: Accessible Version Navigation

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Create: `test/evaluation-version-ui.test.js`

**Interfaces:**
- Produces: `[data-evaluation-version="v1"]` and `[data-evaluation-version="v2"]` links.
- Produces: `.evaluation-version-switch` visual and responsive contract.
- Consumes: query URLs `/?version=v1` and `/?version=v2`.

- [ ] **Step 1: Write the failing static UI contract**

Create `test/evaluation-version-ui.test.js` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('offers shareable V1 and V2 homepage links with accessible copy', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('public/index.html', root), 'utf8'),
    readFile(new URL('public/styles.css', root), 'utf8')
  ]);
  assert.match(html, /<nav[^>]*class="evaluation-version-switch"[^>]*aria-label="评测版本"/);
  assert.match(html, /href="\/\?version=v1"[^>]*data-evaluation-version="v1"/);
  assert.match(html, /href="\/\?version=v2"[^>]*data-evaluation-version="v2"/);
  assert.match(html, />V1 经典评测</);
  assert.match(html, />V2 证据评测</);
  assert.match(css, /\.evaluation-version-switch\s*\{/);
  assert.match(css, /\.evaluation-version-switch a\[aria-current="page"\]/);
  assert.match(css, /@media \(max-width: 700px\)/);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
node --test test/evaluation-version-ui.test.js
```

Expected: FAIL because the navigation is absent.

- [ ] **Step 3: Add semantic navigation before the intake card content**

Insert as the first child of `.intake-card`:

```html
<nav class="evaluation-version-switch" aria-label="评测版本">
  <a href="/?version=v1" data-evaluation-version="v1">
    <span>V1 经典评测</span>
    <small>模型竞技 · 同题对测</small>
  </a>
  <a href="/?version=v2" data-evaluation-version="v2">
    <span>V2 证据评测</span>
    <small>证据链 · Replica 复刻</small>
  </a>
</nav>
```

Update the homepage asset queries to:

```html
<link rel="stylesheet" href="/styles.css?v=20260731-version-switch1">
<script type="module" src="/app.js?v=20260731-version-switch1"></script>
```

- [ ] **Step 4: Add brand-consistent, accessible styles**

Add a two-column rail with:

```css
.evaluation-version-switch { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:0 0 22px; padding:4px; background:#dfe3e4; border:1px solid var(--ink); }
.evaluation-version-switch a { min-width:0; padding:11px 12px; color:var(--muted); text-decoration:none; border:1px solid transparent; }
.evaluation-version-switch a span,.evaluation-version-switch a small { display:block; }
.evaluation-version-switch a span { font:900 13px/1.2 var(--display); letter-spacing:.02em; }
.evaluation-version-switch a small { margin-top:4px; font:8px/1.35 var(--mono); }
.evaluation-version-switch a[aria-current="page"] { color:white; background:var(--ink); border-color:var(--ink); box-shadow:4px 4px 0 var(--lime); }
.evaluation-version-switch a:focus-visible { outline:3px solid var(--blue); outline-offset:2px; }
```

Within the existing `@media (max-width: 700px)` block, add:

```css
.evaluation-version-switch { grid-template-columns:1fr; }
```

- [ ] **Step 5: Run the static UI and branding tests**

Run:

```bash
node --test test/evaluation-version-ui.test.js test/branding-ui.test.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit only Task 2 files**

```bash
git add public/index.html public/styles.css test/evaluation-version-ui.test.js
git diff --cached --check
git commit -m "feat(ui): add V1 V2 homepage navigation"
```

---

### Task 3: Apply Version State and Dispatch the Correct Schema

**Files:**
- Modify: `public/app.js`
- Modify: `test/evaluation-version-ui.test.js`
- Modify: `test/api.test.js`

**Interfaces:**
- Consumes: `requestedEvaluationVersion(location.search)`
- Consumes: `resolveEvaluationVersion(requestedVersion, v2Available)`
- Produces client state: `selectedVersion`, `v2Available`, `healthResolved`
- Produces: `applyEvaluationVersion(versionState, v2Available)`

- [ ] **Step 1: Add failing app integration assertions**

Extend `test/evaluation-version-ui.test.js`:

```js
test('dispatches and renders from selected version instead of capability alone', async () => {
  const script = await readFile(new URL('public/app.js', root), 'utf8');
  assert.match(script, /requestedEvaluationVersion\(location\.search\)/);
  assert.match(script, /resolveEvaluationVersion\(requestedVersion,\s*mode\.enabled\)/);
  assert.match(script, /state\.selectedVersion === 'v2'/);
  assert.match(script, /data-evaluation-version/);
  assert.match(script, /setAttribute\('aria-current', 'page'\)/);
  assert.match(script, /V2 证据评测当前未启用/);
  assert.doesNotMatch(script, /if \(state\.blackBoxEnabled\) return submitV2Evaluation/);
});
```

Update the V2 intake assertions in `test/api.test.js` to expect the new
version-selection function names instead of `setBlackBoxMode`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/evaluation-version-ui.test.js test/api.test.js
```

Expected: FAIL on missing version-state integration.

- [ ] **Step 3: Import helpers and separate state**

Update the helper import:

```js
import {
  evaluationModeFromHealth,
  nextAvailableEditorId,
  recordActionCopy,
  recordActionFailure,
  requestedEvaluationVersion,
  resolveEvaluationVersion
} from './a2a-ui-helpers.js?v=20260731-version-switch1';
```

Replace `blackBoxEnabled` in initial state with:

```js
selectedVersion: null,
v2Available: null,
```

Add:

```js
const requestedVersion = requestedEvaluationVersion(location.search);
```

- [ ] **Step 4: Dispatch submissions by selected version**

Change the branch in `submitEvaluation()` to:

```js
if (state.selectedVersion === 'v2') return submitV2Evaluation(agentCard);
return submitV1Evaluation(agentCard);
```

Replace other UI-only `state.blackBoxEnabled` checks with
`state.selectedVersion === 'v2'`.

- [ ] **Step 5: Replace capability-driven visibility with version-driven visibility**

After health validation, resolve and apply:

```js
const versionState = resolveEvaluationVersion(requestedVersion, mode.enabled);
applyEvaluationVersion(versionState, mode.enabled);
```

Implement `applyEvaluationVersion` so it:

```js
function applyEvaluationVersion({ selectedVersion, usable }, v2Available) {
  const isV2 = selectedVersion === 'v2';
  state.selectedVersion = selectedVersion;
  state.v2Available = v2Available;
  state.healthResolved = true;

  $$('[data-evaluation-version]').forEach((link) => {
    const selected = link.dataset.evaluationVersion === selectedVersion;
    link.classList.toggle('selected', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  $$('.legacy-only').forEach((element) => element.classList.toggle('hidden', isV2));
  $('#v2-card-heading').classList.toggle('hidden', !isV2);
  $('#v2-intake').classList.remove('hidden');
  $$('.v2-only').forEach((element) => element.classList.toggle('hidden', !isV2));

  const button = $('#start-evaluation');
  button.disabled = !usable;
  $('span', button).textContent = isV2 ? '启动 A2A 证据评测' : '送进研究终审台';
  if (!usable) showError('V2 证据评测当前未启用，请切换到 V1 经典评测。');
}
```

Preserve the existing version-specific example blurb within this function.
Rename the unavailable-health function to describe health resolution rather
than V2 mode and keep submission disabled on fetch failure.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --test \
  test/a2a-ui-helpers.test.js \
  test/evaluation-version-ui.test.js \
  test/branding-ui.test.js \
  test/v1-scoring-ui.test.js \
  test/api.test.js
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 7: Run syntax verification**

Run:

```bash
npm run check
```

Expected: `Syntax OK` and exit code 0.

- [ ] **Step 8: Commit only Task 3 files**

```bash
git add public/app.js test/evaluation-version-ui.test.js test/api.test.js
git diff --cached --check
git commit -m "feat(ui): select V1 or V2 independently"
```

---

### Task 4: Package and Atomically Deploy the Current Source State

**Files:**
- Deploy current workspace to a new directory below `/opt/agent-review/releases`, named by the computed archive SHA-256.
- Update symlink: `/opt/agent-review/app`
- Do not modify `/etc/agent-review/agent-review.env`
- Do not modify the already validated Nginx or certificate configuration

**Interfaces:**
- Consumes: existing SSH control socket `/tmp/agent-review-deploy.ogSJoM/control`
- Produces: immutable content-addressed release and atomic live symlink

- [ ] **Step 1: Build a release archive without local secrets or mutable data**

Run from the workspace:

```bash
archive=/tmp/agent-review-deploy.ogSJoM/agent-review-v1-v2.tar.gz
COPYFILE_DISABLE=1 tar \
  --exclude=.git \
  --exclude=.env \
  --exclude=.venv \
  --exclude=.cache \
  --exclude=data \
  --exclude='*/__pycache__' \
  -czf "$archive" .
shasum -a 256 "$archive"
```

Record the printed SHA-256 as the release identifier.

- [ ] **Step 2: Upload and extract into a new immutable release directory**

```bash
scp -o ControlPath=/tmp/agent-review-deploy.ogSJoM/control \
  -o BatchMode=yes \
  "$archive" \
  root@14.103.143.171:/root/agent-review-upload/agent-review-v1-v2.tar.gz
```

Then run:

```bash
release_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
test "${#release_sha}" -eq 64
ssh -S /tmp/agent-review-deploy.ogSJoM/control \
  -o BatchMode=yes \
  root@14.103.143.171 \
  "set -eu
   archive=/root/agent-review-upload/agent-review-v1-v2.tar.gz
   actual=\$(sha256sum \"\$archive\" | awk '{print \$1}')
   test \"\$actual\" = '$release_sha'
   release=/opt/agent-review/releases/$release_sha
   test ! -e \"\$release\"
   install -d -o root -g root -m 0755 \"\$release\"
   tar -xzf \"\$archive\" -C \"\$release\"
   chown -R root:root \"\$release\"
   test -f \"\$release/package.json\"
   printf '%s\n' \"\$release\""
```

Expected: the printed path ends with the local archive SHA-256.

- [ ] **Step 3: Verify the staged release before switching**

Run:

```bash
ssh -S /tmp/agent-review-deploy.ogSJoM/control \
  -o BatchMode=yes \
  root@14.103.143.171 \
  "set -eu
   cd /opt/agent-review/releases/$release_sha
   runuser -u agent-review -- node --test \
     test/a2a-ui-helpers.test.js \
     test/evaluation-version-ui.test.js \
     test/branding-ui.test.js \
     test/v1-scoring-ui.test.js \
     test/api.test.js
   runuser -u agent-review -- npm run check"
```

Expected: all focused tests and syntax checks pass.

- [ ] **Step 4: Atomically switch with automatic rollback**

Run:

```bash
ssh -S /tmp/agent-review-deploy.ogSJoM/control \
  -o BatchMode=yes \
  root@14.103.143.171 \
  "set -eu
   release=/opt/agent-review/releases/$release_sha
   previous_release=\$(readlink -f /opt/agent-review/app)
   test -d \"\$previous_release\"
   stage=/opt/agent-review/app.next.\$\$
   recovery=/opt/agent-review/app.recovery.\$\$
   switched=0
   wait_for_health() {
     for attempt in \$(seq 1 30); do
       if curl -fsS http://127.0.0.1:4173/api/health |
         python3 -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get(\"ok\") is True else 1)'; then
         return 0
       fi
       sleep 2
     done
     return 1
   }
   cleanup() {
     status=\$?
     rm -f -- \"\$stage\" \"\$recovery\"
     if test \"\$status\" -ne 0 && test \"\$switched\" -eq 1; then
       ln -s \"\$previous_release\" \"\$recovery\"
       mv -Tf \"\$recovery\" /opt/agent-review/app
       systemctl restart agent-review
       wait_for_health || true
     fi
     exit \"\$status\"
   }
   trap cleanup EXIT
   ln -s \"\$release\" \"\$stage\"
   test \"\$(readlink -f \"\$stage\")\" = \"\$release\"
   mv -Tf \"\$stage\" /opt/agent-review/app
   switched=1
   systemctl restart agent-review
   wait_for_health
   trap - EXIT
   printf 'previous_release=%s\ncurrent_release=%s\n' \"\$previous_release\" \"\$release\""
```

Expected: both release paths print and the command exits 0. Preserve the
printed previous release path until browser acceptance completes.

- [ ] **Step 5: Verify service boundaries after restart**

Run through SSH:

```bash
ssh -S /tmp/agent-review-deploy.ogSJoM/control \
  -o BatchMode=yes \
  root@14.103.143.171 \
  "set -eu
   systemctl is-active agent-review
   systemctl is-active nginx
   systemctl show agent-review -p MainPID -p NRestarts
   ss -ltn | grep -F '127.0.0.1:4173'
   if ss -ltn | grep -F '0.0.0.0:4173'; then exit 1; fi"
```

Expected: both services active, Node still loopback-only, and no restart loop.

---

### Task 5: Public Browser Acceptance for V1 and V2

**Files:**
- No source changes unless acceptance reveals a reproducible defect.

**Interfaces:**
- Consumes: `https://14.103.143.171/?version=v1`
- Consumes: `https://14.103.143.171/?version=v2`
- Consumes: `https://14.103.143.171/`

- [ ] **Step 1: Verify HTTP and capability contracts**

Require exact `200` for the three homepage URLs, `/app.js`, `/styles.css`, and
`/api/health`. Parse health JSON and require:

```js
payload.ok === true
payload.mode === 'full-stack'
payload.a2aBlackBoxV1Enabled === true
```

- [ ] **Step 2: Inspect V1 in a real browser**

Open `https://14.103.143.171/?version=v1` and require:

- V1 link has `aria-current="page"`;
- `#legacy-intake` is visible;
- `#v1-scoring-config` is visible;
- `.v2-only` controls are hidden;
- start button text is `送进研究终审台`.

- [ ] **Step 3: Inspect V2 in a real browser**

Open `https://14.103.143.171/?version=v2` and require:

- V2 link has `aria-current="page"`;
- `#legacy-intake` is hidden;
- `#v2-card-heading` and V2-only controls are visible;
- start button text is `启动 A2A 证据评测`.

- [ ] **Step 4: Verify the default and sensitive-input reset**

Open `https://14.103.143.171/` and require V2 selected because production
reports V2 enabled. Enter a non-secret sentinel into the Agent authorization
field, follow the V1 link, and verify the field is empty after reload.

- [ ] **Step 5: Run final local and remote verification**

Run fresh:

```bash
node --test \
  test/a2a-ui-helpers.test.js \
  test/evaluation-version-ui.test.js \
  test/branding-ui.test.js \
  test/v1-scoring-ui.test.js \
  test/api.test.js \
  test/deploy-config.test.js
npm run check
```

Then verify the deployed release hash, systemd status, Nginx configuration,
certificate validity, timer status, and both public version URLs. Report any
unrelated pre-existing full-suite failures separately; do not claim the full
suite passes unless a fresh full-suite run has zero failures.
