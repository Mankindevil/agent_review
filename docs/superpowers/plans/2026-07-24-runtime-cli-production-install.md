# Production Runtime CLI Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install production-ready Linux x64 Claude Code and Cursor Agent runtimes through locally relayed official artifacts, then make the evaluation platform invoke them safely and report their status accurately.

**Architecture:** The Windows workstation downloads pinned official Linux x64 artifacts, verifies them, and uploads them through SCP. The production host installs immutable tool releases under `/opt/agent-review/tools`, while the Node application invokes each CLI as the unprivileged `agent-review` user in a disposable workspace. Claude uses the existing loopback Anthropic-to-Ark bridge; Cursor uses a dedicated persistent file-backed account login while every non-authentication directory remains disposable.

**Tech Stack:** Node.js 24 ESM, native Node test runner, Claude Code 2.1.218 native Linux x64, Cursor Agent `2026.07.23-e383d2b` Linux x64, PowerShell, OpenSSH/SCP, Ubuntu systemd, Nginx.

## Global Constraints

- Do not install a global VPN or change the production host's default route.
- Do not copy the Windows `claude.exe` to Linux.
- Runtime execution must not depend on the workstation remaining online.
- Claude must use the existing Ark configuration; Cursor must use file-backed account login under `CURSOR_AUTH_CONFIG_HOME` and must not receive an API key; Doubao remains the existing Ark API adapter.
- Reviewer models and Runtime models are independent of the contestant-only DeepSeek V4 Pro requirement.
- Tool releases are immutable and owned by `root:agent-review`; the application may only execute them.
- Environment secrets remain in `/etc/agent-review/agent-review.env` with `root:root 0600`; Cursor's account token exists only in the service-owned mode-0600 `cursor/auth.json`.
- Runtime workspaces are disposable and may not expose production code, `.env` files, certificates, or persistent evaluation state.
- Any single Runtime invocation must remain within the competition's 20-minute ceiling.
- The SSH host key must be verified through the cloud console before credentialed login.
- The root password previously posted in chat must be rotated before deployment; subsequent access should use an SSH key.

---

## File Map

- Modify `src/runtimes.js`: build version-compatible local CLI arguments and prepare the Cursor sandbox before execution.
- Create `src/runtime-sandbox.js`: materialize a deny-by-default Cursor permissions file in the disposable workspace.
- Modify `src/runtime-status.js`: probe executables using the configured PATH and distinguish installation, enablement, authentication, and readiness.
- Modify `test/runtime-skill-retry.test.js`: cover CLI arguments and workspace sandbox preparation.
- Modify `test/api.test.js`: cover honest runtime status after injecting mock CLI executables.
- Modify `.env.example`: document production PATH and Cursor's dedicated file-backed account-login directory without adding secrets.
- Modify `README.md`: document pinned local Runtime installation and independent model responsibilities.
- Use `docs/PRODUCTION_OPERATIONS.md`: follow the existing immutable release, restart, health, and rollback procedures.

---

### Task 1: Version-Compatible Local CLI Invocation

**Files:**
- Modify: `src/runtimes.js`
- Test: `test/runtime-skill-retry.test.js`

**Interfaces:**
- Produces: `localCliArgs(runtimeId: string, prompt: string, options?: { budget?: string }): string[]`
- Consumes: existing `callLocalCli(runtimeId, prompt, signal, sampling)` flow.

- [ ] **Step 1: Add failing argument-construction tests**

Add this import and tests to `test/runtime-skill-retry.test.js`:

```js
import { buildSkill, createSkillBundle, localCliArgs, materializeSkillFolder, runSkill } from '../src/runtimes.js';

test('uses supported read-only Claude Code arguments', () => {
  const args = localCliArgs('claude-code', 'build a skill', { budget: '0.25' });
  assert.deepEqual(args.slice(0, 3), ['-p', 'build a skill', '--system-prompt']);
  assert.equal(typeof args[3], 'string');
  assert.match(args[3], /只输出/);
  assert.deepEqual(args.slice(4), [
    '--output-format', 'json',
    '--tools', '',
    '--permission-mode', 'plan',
    '--safe-mode',
    '--no-session-persistence',
    '--max-turns', '1',
    '--max-budget-usd', '0.25'
  ]);
});

test('uses documented Cursor Agent print arguments', () => {
  assert.deepEqual(localCliArgs('cursor', 'build a skill'), [
    '-p', 'build a skill',
    '--output-format', 'json'
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node --test test/runtime-skill-retry.test.js
```

Expected: FAIL because `localCliArgs` is not exported.

- [ ] **Step 3: Extract the argument builder**

In `src/runtimes.js`, add:

```js
export function localCliArgs(runtimeId, prompt, { budget = '0.25' } = {}) {
  if (runtimeId === 'claude-code') {
    return [
      '-p', prompt,
      '--system-prompt', CLAUDE_RUNTIME_SYSTEM_PROMPT,
      '--output-format', 'json',
      '--tools', '',
      '--permission-mode', 'plan',
      '--safe-mode',
      '--no-session-persistence',
      '--max-turns', '1',
      '--max-budget-usd', budget
    ];
  }
  if (runtimeId === 'cursor') {
    return ['-p', prompt, '--output-format', 'json'];
  }
  throw new Error(`不支持的本地 Runtime：${runtimeId}`);
}
```

Replace the inline `args` expression in `callLocalCli()` with:

```js
const args = localCliArgs(runtimeId, prompt, { budget });
```

- [ ] **Step 4: Run the focused test**

Run:

```powershell
node --test test/runtime-skill-retry.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/runtimes.js test/runtime-skill-retry.test.js
git commit -m "fix: use supported runtime CLI arguments"
```

---

### Task 2: Disposable Cursor Permission Sandbox

**Files:**
- Create: `src/runtime-sandbox.js`
- Modify: `src/runtimes.js`
- Test: `test/runtime-skill-retry.test.js`

**Interfaces:**
- Produces: `prepareRuntimeWorkspace(runtimeId: string, workspace: string, options?): Promise<void>`
- Consumes: the temporary directory returned by `mkdtemp()` in `callLocalCli()`.

- [ ] **Step 1: Add the failing sandbox test**

Add:

```js
import { readFile } from 'node:fs/promises';
import { prepareRuntimeWorkspace } from '../src/runtime-sandbox.js';

test('writes deny-by-default Cursor permissions only inside the temporary workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-sandbox-'));
  try {
    await prepareRuntimeWorkspace('cursor', root);
    const payload = JSON.parse(await readFile(path.join(root, '.cursor', 'cli.json'), 'utf8'));
    assert.deepEqual(payload.permissions.allow, []);
    for (const rule of [
      'Shell(*)', 'WebFetch(*)', 'WebSearch(*)', 'Mcp(*)',
      'Write(**)', 'Write(/**)', 'Read(**)', 'Read(/**)',
      'Read(/proc/**)', 'Read(/run/**)', 'Read(/tmp/**)',
      'Read(/var/lib/agent-review/cursor-auth/**)'
    ]) {
      assert.ok(payload.permissions.deny.includes(rule));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node --test test/runtime-skill-retry.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runtime-sandbox.js`.

- [ ] **Step 3: Implement the workspace preparation**

Create `src/runtime-sandbox.js`:

```js
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const DEFAULT_CURSOR_AUTH_CONFIG_HOME = '/var/lib/agent-review/cursor-auth';
const ABSOLUTE_READ_DENIES = [
  '/proc/**', '/run/**', '/tmp/**', '/sys/**', '/dev/**',
  '/etc/**', '/opt/**', '/var/**', '/home/**', '/root/**',
  '/mnt/**', '/media/**'
];

export async function prepareRuntimeWorkspace(runtimeId, workspace, {
  cursorAuthConfigHome = process.env.CURSOR_AUTH_CONFIG_HOME
} = {}) {
  if (runtimeId !== 'cursor') return;
  const directory = path.join(workspace, '.cursor');
  const authHome = normalizeAbsoluteRulePath(cursorAuthConfigHome)
    || DEFAULT_CURSOR_AUTH_CONFIG_HOME;
  const permissions = {
    permissions: {
      allow: [],
      deny: [
        'Shell(*)',
        'WebFetch(*)',
        'WebSearch(*)',
        'Mcp(*)',
        'Write(**)',
        'Write(/**)',
        'Read(**)',
        'Read(/**)',
        'Read(**/.env*)',
        'Read(**/*.key)',
        'Read(**/*.pem)',
        ...ABSOLUTE_READ_DENIES.map((target) => `Read(${target})`),
        `Read(${authHome}/**)`,
        'Read(/opt/agent-review/**)',
        'Read(/var/lib/agent-review/**)'
      ]
    }
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, 'cli.json'),
    `${JSON.stringify(permissions, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function normalizeAbsoluteRulePath(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) return null;
  return value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
}
```

Import and call it immediately after the temporary directory is created:

```js
import { prepareRuntimeWorkspace } from './runtime-sandbox.js';

await prepareRuntimeWorkspace(runtimeId, workspace, {
  cursorAuthConfigHome: parentEnv.CURSOR_AUTH_CONFIG_HOME
});
```

- [ ] **Step 4: Run the focused test**

Run:

```powershell
node --test test/runtime-skill-retry.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/runtime-sandbox.js src/runtimes.js test/runtime-skill-retry.test.js
git commit -m "feat: sandbox Cursor runtime workspace"
```

---

### Task 3: Honest Runtime Readiness Probe

**Files:**
- Modify: `src/runtime-status.js`
- Test: `test/api.test.js`

**Interfaces:**
- Produces: `getRuntimeStatus()` entries with `installed`, `authenticated`, `enabled`, and `runtimeReady`.
- Consumes: `PATH`, `RUNTIME_ADAPTERS_JSON`, `ENABLE_LOCAL_CLAUDE_CODE`, `ENABLE_LOCAL_CURSOR_AGENT`, `CURSOR_AUTH_CONFIG_HOME`, and existing Claude backend configuration.

- [ ] **Step 1: Add failing readiness assertions**

Extend the runtime API test so every item exposes an explicit `enabled` Boolean:

```js
for (const runtime of runtimes) {
  assert.equal(typeof runtime.installed, 'boolean');
  assert.equal(typeof runtime.authenticated, 'boolean');
  assert.equal(typeof runtime.enabled, 'boolean');
  assert.equal(typeof runtime.runtimeReady, 'boolean');
}
```

Import `getRuntimeStatus` and add:

```js
test('reports enablement independently from local installation', async () => {
  const previousClaude = process.env.ENABLE_LOCAL_CLAUDE_CODE;
  const previousCursor = process.env.ENABLE_LOCAL_CURSOR_AGENT;
  const previousPath = process.env.PATH;
  try {
    process.env.ENABLE_LOCAL_CLAUDE_CODE = 'true';
    process.env.ENABLE_LOCAL_CURSOR_AGENT = 'true';
    process.env.PATH = '';
    const runtimes = await getRuntimeStatus();
    const claude = runtimes.find((item) => item.id === 'claude-code');
    const cursor = runtimes.find((item) => item.id === 'cursor');
    assert.equal(claude.enabled, true);
    assert.equal(cursor.enabled, true);
    assert.equal(claude.installed, false);
    assert.equal(cursor.installed, false);
    assert.equal(claude.runtimeReady, false);
    assert.equal(cursor.runtimeReady, false);
  } finally {
    restoreEnv('ENABLE_LOCAL_CLAUDE_CODE', previousClaude);
    restoreEnv('ENABLE_LOCAL_CURSOR_AGENT', previousCursor);
    restoreEnv('PATH', previousPath);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
```

- [ ] **Step 2: Run the API test and verify failure**

Run:

```powershell
node --test test/api.test.js
```

Expected: FAIL because runtime entries do not expose `enabled`.

- [ ] **Step 3: Implement explicit status fields**

In `src/runtime-status.js`:

```js
const claudeEnabled = remoteConfig.includes('claude-code')
  || process.env.ENABLE_LOCAL_CLAUDE_CODE === 'true';
const cursorEnabled = remoteConfig.includes('cursor')
  || process.env.ENABLE_LOCAL_CURSOR_AGENT === 'true';
```

Add `enabled: claudeEnabled` and `enabled: cursorEnabled` to the respective entries. Probe Cursor authentication with the same minimal environment and persistent config directory used for execution:

```js
async function probeCursorAuth() {
  try {
    const { stdout } = await execFileAsync('cursor-agent', ['status'], {
      timeout: 5_000,
      maxBuffer: 64_000,
      env: localCliEnv('cursor', workspace, process.env)
    });
    return /\blogged in\b|\bauthenticated\b/i.test(stdout)
      && !/not logged|logged out|unauthenticated/i.test(stdout);
  } catch {
    return false;
  }
}
```

Keep executable lookup scoped to the exact configured production PATH; the production target is Linux and no Windows executable behavior is required for this deployment.

- [ ] **Step 4: Run API and complete tests**

Run:

```powershell
node --test test/api.test.js
npm test
npm run check
```

Expected: all tests and syntax checks PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/runtime-status.js test/api.test.js
git commit -m "fix: report runtime readiness accurately"
```

---

### Task 4: Production Configuration Documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Test: `test/api.test.js`

**Interfaces:**
- Documents the exact production PATH and independent runtime credentials.
- Does not add any secret value to Git.

- [ ] **Step 1: Add failing documentation assertions**

Extend the documentation API test:

```js
assert.match(envExample, /CURSOR_AUTH_CONFIG_HOME=/);
assert.match(envExample, /\/opt\/agent-review\/tools\/bin/);
assert.match(readme, /评审模型与 Runtime 模型独立配置/);
assert.match(readme, /Cursor Agent.*CURSOR_AUTH_CONFIG_HOME/s);
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```powershell
node --test test/api.test.js
```

Expected: FAIL because the required documentation is absent.

- [ ] **Step 3: Update the environment template**

Add:

```env
# 生产工具目录由 root 管理；不要指向用户可写目录。
# PATH=/opt/agent-review/tools/bin:/usr/local/bin:/usr/bin:/bin
CURSOR_AUTH_CONFIG_HOME=/var/lib/agent-review/cursor-auth
```

Keep both local Runtime enable flags defaulted to `false`.

- [ ] **Step 4: Update the README**

Document:

- the pinned release layout under `/opt/agent-review/tools`;
- Claude's existing Ark bridge;
- Cursor's dedicated file-backed account login and isolated config directory;
- Doubao's unchanged API adapter;
- the fact that reviewer models, Runtime models, and contestant model eligibility are three separate concerns;
- the `/api/runtimes` readiness semantics.

- [ ] **Step 5: Run checks and commit**

```powershell
node --test test/api.test.js
npm test
npm run check
git add .env.example README.md test/api.test.js
git commit -m "docs: document production runtime tools"
```

Expected: PASS, then commit succeeds.

---

### Task 5: Download and Verify Official Linux Artifacts on the Workstation

**Files:**
- Produce temporary binary artifacts outside the repository.
- Do not modify tracked source files.

**Interfaces:**
- Produces a Claude binary with SHA-256 `e12071751a9336b8af1012c103358ff04ac18f9aaff4a738cff7ba5cdfaf63f2`.
- Produces Cursor package version `2026.07.23-e383d2b` and a locally calculated SHA-256 used again after upload.

- [ ] **Step 1: Create a scoped temporary artifact directory**

```powershell
$runtimeArtifactRoot = Join-Path $env:TEMP 'agent-review-runtime-20260724'
New-Item -ItemType Directory -Force -Path $runtimeArtifactRoot | Out-Null
```

Resolve the path and confirm it is under the current user's temporary directory before downloading.

- [ ] **Step 2: Download Claude Code 2.1.218 Linux x64**

```powershell
$claudeUrl = 'https://downloads.claude.ai/claude-code-releases/2.1.218/linux-x64/claude'
$claudeFile = Join-Path $runtimeArtifactRoot 'claude-2.1.218-linux-x64'
Invoke-WebRequest -UseBasicParsing -Uri $claudeUrl -OutFile $claudeFile
$claudeHash = (Get-FileHash -Algorithm SHA256 $claudeFile).Hash.ToLowerInvariant()
if ($claudeHash -ne 'e12071751a9336b8af1012c103358ff04ac18f9aaff4a738cff7ba5cdfaf63f2') {
  throw "Claude SHA-256 mismatch: $claudeHash"
}
```

Expected: no exception; file size is 273,177,584 bytes.

- [ ] **Step 3: Download Cursor Agent Linux x64**

```powershell
$cursorVersion = '2026.07.23-e383d2b'
$cursorUrl = "https://downloads.cursor.com/lab/$cursorVersion/linux/x64/agent-cli-package.tar.gz"
$cursorFile = Join-Path $runtimeArtifactRoot "cursor-agent-$cursorVersion-linux-x64.tar.gz"
Invoke-WebRequest -UseBasicParsing -Uri $cursorUrl -OutFile $cursorFile
$cursorHash = (Get-FileHash -Algorithm SHA256 $cursorFile).Hash.ToLowerInvariant()
$cursorLength = (Get-Item $cursorFile).Length
if ($cursorLength -ne 82521188) {
  throw "Cursor package size mismatch: $cursorLength"
}
```

Expected: a non-empty `$cursorHash` and exact size 82,521,188 bytes. The official installer does not publish a SHA-256, so the locally calculated hash becomes the transfer integrity value.

- [ ] **Step 4: Record artifact metadata without secrets**

```powershell
[pscustomobject]@{
  ClaudeVersion = '2.1.218'
  ClaudeSha256 = $claudeHash
  CursorVersion = $cursorVersion
  CursorSha256 = $cursorHash
  CursorLength = $cursorLength
} | Format-List
```

Expected: both hashes contain 64 lowercase hexadecimal characters.

---

### Task 6: Establish Trusted SSH Access and Preflight the Host

**Files:**
- Update the operator's OpenSSH `known_hosts` only after out-of-band fingerprint confirmation.
- Do not change application files yet.

**Interfaces:**
- Produces trusted, key-based administrative access to `14.103.143.171`.
- Produces verified `linux/x86_64` host facts and resource headroom.

- [ ] **Step 1: Collect the presented SSH host keys**

```powershell
$hostKeyScan = ssh-keyscan -T 10 -t ed25519,rsa 14.103.143.171 2>$null
$hostKeyScan
$hostKeyScan | ssh-keygen -lf -
```

Expected: one or more fingerprints. Do not add them to `known_hosts` yet.

- [ ] **Step 2: Verify the fingerprint out of band**

Use the cloud provider console to display the server SSH host-key fingerprint and compare it byte-for-byte with Step 1. Stop if the console value is unavailable or differs.

- [ ] **Step 3: Rotate the exposed root password and install an operator SSH public key**

Perform password rotation in the cloud console. Add the operator's existing Ed25519 public key to `/root/.ssh/authorized_keys` with directory mode `0700` and file mode `0600`. Do not paste the private key or new password into the repository, command transcript, or chat.

- [ ] **Step 4: Trust the verified host key and test key login**

Append only the verified `ssh-keyscan` output to the operator's `known_hosts`, then run:

```powershell
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@14.103.143.171 `
  'uname -s; uname -m; . /etc/os-release; printf "%s %s\n" "$ID" "$VERSION_ID"; df -h / /opt /var; free -h'
```

Expected: `Linux`, `x86_64`, Ubuntu version, sufficient disk for at least 1 GiB of new Runtime artifacts, and no swap/memory exhaustion.

- [ ] **Step 5: Verify existing services and release**

```powershell
ssh -o BatchMode=yes root@14.103.143.171 `
  'systemctl is-active agent-review nginx; readlink -f /opt/agent-review/app; /usr/local/bin/node --version; stat -c "%U:%G %a %n" /etc/agent-review/agent-review.env'
```

Expected: both services `active`, Node 24.x, an immutable release target, and `root:root 600` for the environment file.

---

### Task 7: Upload and Install Immutable Runtime Releases

**Files:**
- Remote create: `/opt/agent-review/tools/claude/releases/2.1.218/claude`
- Remote create: `/opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b/`
- Remote create/update: `/opt/agent-review/tools/bin/claude`
- Remote create/update: `/opt/agent-review/tools/bin/cursor-agent`

**Interfaces:**
- Consumes the verified local artifacts and their SHA-256 values.
- Produces executables accessible to the `agent-review` service user.

- [ ] **Step 1: Upload artifacts to explicit temporary paths**

```powershell
scp -o BatchMode=yes $claudeFile root@14.103.143.171:/tmp/claude-2.1.218-linux-x64
scp -o BatchMode=yes $cursorFile root@14.103.143.171:/tmp/cursor-agent-2026.07.23-e383d2b-linux-x64.tar.gz
```

- [ ] **Step 2: Verify remote transfer hashes before installation**

```powershell
$remoteHashes = ssh -o BatchMode=yes root@14.103.143.171 `
  'sha256sum /tmp/claude-2.1.218-linux-x64 /tmp/cursor-agent-2026.07.23-e383d2b-linux-x64.tar.gz'
$remoteHashes
```

Expected: Claude matches the fixed official hash and Cursor matches `$cursorHash`. Stop before installing on any mismatch.

- [ ] **Step 3: Install Claude into an immutable release directory**

```powershell
ssh -o BatchMode=yes root@14.103.143.171 @'
set -eu
install -d -o root -g agent-review -m 0750 /opt/agent-review/tools/claude/releases/2.1.218
install -o root -g agent-review -m 0750 /tmp/claude-2.1.218-linux-x64 /opt/agent-review/tools/claude/releases/2.1.218/claude
/opt/agent-review/tools/claude/releases/2.1.218/claude --version
'@
```

Expected: Claude Code 2.1.218.

- [ ] **Step 4: Install Cursor into an immutable release directory**

```powershell
ssh -o BatchMode=yes root@14.103.143.171 @'
set -eu
install -d -o root -g agent-review -m 0750 /opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b
tar -xzf /tmp/cursor-agent-2026.07.23-e383d2b-linux-x64.tar.gz --strip-components=1 -C /opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b
chown -R root:agent-review /opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b
find /opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b -type d -exec chmod 0750 {} +
find /opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b -type f -exec chmod 0640 {} +
chmod 0750 /opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b/cursor-agent
/opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b/cursor-agent --version
'@
```

Expected: a Cursor Agent version string and zero exit code.

- [ ] **Step 5: Atomically switch tool links**

```powershell
ssh -o BatchMode=yes root@14.103.143.171 @'
set -eu
install -d -o root -g agent-review -m 0750 /opt/agent-review/tools/bin
ln -s /opt/agent-review/tools/claude/releases/2.1.218/claude /opt/agent-review/tools/bin/claude.next
mv -Tf /opt/agent-review/tools/bin/claude.next /opt/agent-review/tools/bin/claude
ln -s /opt/agent-review/tools/cursor-agent/releases/2026.07.23-e383d2b/cursor-agent /opt/agent-review/tools/bin/cursor-agent.next
mv -Tf /opt/agent-review/tools/bin/cursor-agent.next /opt/agent-review/tools/bin/cursor-agent
sudo -u agent-review env PATH=/opt/agent-review/tools/bin:/usr/local/bin:/usr/bin:/bin claude --version
sudo -u agent-review env PATH=/opt/agent-review/tools/bin:/usr/local/bin:/usr/bin:/bin cursor-agent --version
'@
```

Expected: both version checks succeed as `agent-review`.

---

### Task 8: Configure Credentials and Enable the Runtimes

**Files:**
- Remote modify atomically: `/etc/agent-review/agent-review.env`
- Remote backup: root-only timestamped environment backup.

**Interfaces:**
- Consumes existing Ark configuration and an independently provisioned Cursor account login.
- Produces a systemd process environment with immutable tool PATH and explicit enable flags.

- [ ] **Step 1: Verify required secret names without printing values**

On the server, use a root-only script that reports only presence:

```bash
set -a
. /etc/agent-review/agent-review.env
set +a
for name in ARK_BASE_URL ARK_API_KEY CLAUDE_ARK_MODEL AGENT_DIAGNOSTICS_ACCESS_KEY; do
  eval "value=\${$name-}"
  test -n "$value" || { echo "missing:$name"; exit 1; }
  echo "present:$name"
done
```

Expected: every listed variable reports `present`.

- [ ] **Step 2: Create the dedicated Cursor account-login directory**

Create `/var/lib/agent-review/cursor-auth` as `agent-review:agent-review` mode `0700`. Run the official interactive account login as the service user with `AGENT_CLI_CREDENTIAL_STORE=file` and `XDG_CONFIG_HOME` set to that directory. Confirm `cursor/auth.json` is owned by `agent-review` and mode `0600`. Do not configure or pass a Cursor API key.

- [ ] **Step 3: Atomically update the environment file**

Use a root-only temporary file in `/etc/agent-review`, preserve all existing values, and set:

```env
PATH="/opt/agent-review/tools/bin:/usr/local/bin:/usr/bin:/bin"
ENABLE_LOCAL_CLAUDE_CODE="true"
ENABLE_LOCAL_CURSOR_AGENT="true"
CURSOR_AUTH_CONFIG_HOME="/var/lib/agent-review/cursor-auth"
LOCAL_RUNTIME_TIMEOUT_MS="1200000"
```

Validate that the final file contains no newlines inside values, then set `root:root 0600` and atomically rename it over the old file. The account token remains only in the dedicated file-backed credential directory.

- [ ] **Step 4: Verify Cursor network and authentication as the service user**

```bash
workspace="$(mktemp -d /tmp/cursor-status.XXXXXX)"
sudo -u agent-review env \
  PATH=/opt/agent-review/tools/bin:/usr/local/bin:/usr/bin:/bin \
  HOME="$workspace" \
  XDG_CONFIG_HOME=/var/lib/agent-review/cursor-auth \
  XDG_CACHE_HOME="$workspace" \
  XDG_DATA_HOME="$workspace" \
  XDG_STATE_HOME="$workspace" \
  TMPDIR="$workspace" \
  AGENT_CLI_CREDENTIAL_STORE=file \
  cursor-agent status
rm -rf "$workspace"
```

Expected: authenticated status. If DNS, TLS, region, or connection fails, set `ENABLE_LOCAL_CURSOR_AGENT=false` and continue with Claude and Doubao only.

---

### Task 9: Publish the Compatible Application Release

**Files:**
- Local source commits from Tasks 1–4.
- Remote create: a release directory keyed by the exact output of `git rev-parse HEAD`
- Remote switch: `/opt/agent-review/app`

**Interfaces:**
- Consumes the tested application commit.
- Produces a production release that uses installed CLI tools.

- [ ] **Step 1: Run pre-release verification**

```powershell
npm test
npm run check
git status --short --branch
```

Expected: all checks PASS and no uncommitted source changes.

- [ ] **Step 2: Push the implementation commits**

```powershell
git push -u origin codex/finance-roast
```

Expected: remote branch advances to local HEAD.

- [ ] **Step 3: Build an archive from the exact pushed commit**

```powershell
$releaseSha = git rev-parse HEAD
$releaseArchive = Join-Path $runtimeArtifactRoot "agent-review-$releaseSha.tar.gz"
$releaseShaFile = Join-Path $runtimeArtifactRoot 'agent-review-release-sha'
$releaseSha | Set-Content -NoNewline -Encoding ascii $releaseShaFile
git archive --format=tar.gz --output=$releaseArchive $releaseSha
scp -o BatchMode=yes $releaseArchive root@14.103.143.171:/tmp/
scp -o BatchMode=yes $releaseShaFile root@14.103.143.171:/tmp/agent-review-release-sha
```

- [ ] **Step 4: Validate and switch the release**

Follow the immutable release procedure in `docs/PRODUCTION_OPERATIONS.md`:

```bash
set -eu
release_sha="$(cat /tmp/agent-review-release-sha)"
release_dir="/opt/agent-review/releases/$release_sha"
install -d -o root -g agent-review -m 0750 "$release_dir"
tar -xzf "/tmp/agent-review-$release_sha.tar.gz" -C "$release_dir"
chown -R root:agent-review "$release_dir"
find "$release_dir" -type d -exec chmod 0750 {} +
find "$release_dir" -type f -exec chmod 0640 {} +
sudo -u agent-review -- sh -c 'cd "$1" && npm test && npm run check' sh "$release_dir"
ln -s "$release_dir" /opt/agent-review/app.next
mv -Tf /opt/agent-review/app.next /opt/agent-review/app
systemctl restart agent-review
```

Expected: remote tests PASS and service restarts.

---

### Task 10: Production Acceptance and Rollback Proof

**Files:**
- No source changes.
- Produces operational evidence only.

**Interfaces:**
- Confirms the complete production outcome.

- [ ] **Step 1: Poll health instead of assuming restart readiness**

```bash
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 15 https://14.103.143.171/api/health |
     python3 -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'; then
    exit 0
  fi
  sleep 2
done
exit 1
```

Expected: success within 60 seconds.

- [ ] **Step 2: Verify public pages and runtime status**

```bash
curl --fail --silent --show-error https://14.103.143.171/ >/dev/null
curl --fail --silent --show-error https://14.103.143.171/agent-check.html >/dev/null
curl --fail --silent --show-error https://14.103.143.171/api/runtimes | python3 -m json.tool
```

Expected: Claude Code and Doubao ready; Cursor ready only when direct connectivity, persistent account status, and its minimum call all work.

- [ ] **Step 3: Execute isolated CLI smoke tests**

Run Claude with the same environment and restricted flags used by the application, using a prompt that only returns a small JSON object. Run Cursor with `-p` and `--output-format json` in a new empty temporary directory. Confirm both produce valid JSON and do not create files outside their disposable workspace.

- [ ] **Step 4: Execute one real live platform evaluation**

Use one local example A2A Agent and one short, read-only financial prompt. Confirm:

- submitted Agent result is live;
- Claude build and benchmark are live;
- Cursor build and benchmark are live when enabled;
- Doubao build and benchmark remain live;
- no runtime entry falls back to demo without an explicit UI marker;
- total runtime stays within 20 minutes.

- [ ] **Step 5: Inspect bounded logs and secrets**

```bash
journalctl -u agent-review --since '-30 minutes' --no-pager -n 500
systemctl show agent-review -p MainPID -p ActiveState -p SubState
```

Review output for errors and verify that no Ark key, Cursor account token, platform access key, bearer token, or full environment value appears.

- [ ] **Step 6: Prove rollback commands without invoking them**

Record:

- previous `/opt/agent-review/app` target;
- previous Claude symlink target;
- previous Cursor symlink target;
- root-only environment backup path.

Validate each recorded path exists. The actual rollback remains:

```bash
previous_dir="$(cat /root/agent-review-previous-release-path)"
test -d "$previous_dir"
ln -s "$previous_dir" /opt/agent-review/app.next
mv -Tf /opt/agent-review/app.next /opt/agent-review/app
systemctl restart agent-review
```

Do not execute rollback when acceptance passes.
