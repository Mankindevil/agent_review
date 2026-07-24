# Cursor Authentication Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run every Cursor status probe and real call with disposable XDG state while persisting only validated `cursor/auth.json` and `cursor/cli-config.json`.

**Architecture:** Add one Cursor-specific session wrapper that owns the persistent credential boundary, a per-auth-root process mutex, the disposable XDG snapshot, and atomic credential writeback. The status probe and real execution path both call that wrapper; the generic environment builder only accepts the disposable XDG path and never reads the persistent auth root itself.

**Tech Stack:** Node.js 20 ESM, `node:fs/promises`, `node:test`, existing local-runtime process and workspace helpers.

## Global Constraints

- The only persistent files are `cursor/auth.json` and `cursor/cli-config.json`.
- Persistent JSON files must be regular, non-symbolic-link JSON files no larger than 1 MiB and mode `0600`.
- `CURSOR_AUTH_CONFIG_HOME` and its direct `cursor` child must be real non-symbolic-link directories with mode `0700`.
- Cleanup may remove entries only below a verified realpath of the direct `cursor` child.
- The full snapshot, CLI call, and writeback lifecycle is serialized per normalized auth root.
- A missing temporary allowlisted file must not delete its persistent counterpart.
- Status probes and real execution must use the same wrapper.
- Do not touch production or push from this implementation task.

---

### Task 1: Disposable Cursor environment

**Files:**
- Modify: `src/runtime-environment.js`
- Modify: `test/runtime-skill-retry.test.js`

**Interfaces:**
- Consumes: `localCliEnv(runtimeId, workspace, parentEnv, options)`
- Produces: `options.cursorConfigHome`, an absolute disposable XDG root supplied by the session wrapper

- [ ] **Step 1: Write the failing environment test**

Change the Cursor environment test to pass a disposable session root and assert that the persistent root is never used:

```js
const sessionConfigHome = '/tmp/agent-roast-cursor/cursor-xdg-session';
const env = localCliEnv('cursor', workspace, {
  CURSOR_AUTH_CONFIG_HOME: authConfigHome,
  PATH: '/safe/bin'
}, { cursorConfigHome: sessionConfigHome });

assert.equal(env.XDG_CONFIG_HOME, sessionConfigHome);
assert.notEqual(env.XDG_CONFIG_HOME, authConfigHome);
```

Also call `localCliEnv('cursor', workspace, parentEnv)` without the option and assert that `XDG_CONFIG_HOME === workspace`.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
node --test --test-name-pattern="isolates Cursor Agent" test/runtime-skill-retry.test.js
```

Expected: FAIL because the current implementation points `XDG_CONFIG_HOME` at `CURSOR_AUTH_CONFIG_HOME`.

- [ ] **Step 3: Implement the minimal environment change**

Use this signature and Cursor selection rule:

```js
export function localCliEnv(
  runtimeId,
  workspace,
  parentEnv = process.env,
  { cursorConfigHome } = {}
) {
  // Existing allowlisted system variables remain unchanged.
  const disposableCursorConfigHome = runtimeId === 'cursor'
    ? normalizedAbsolutePath(cursorConfigHome)
    : null;

  return {
    ...env,
    XDG_CONFIG_HOME: disposableCursorConfigHome || workspace
  };
}
```

Keep `cursorAuthConfigHome()` as the persistent-root parser used only by the session wrapper and status precheck.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
node --test --test-name-pattern="isolates Cursor Agent" test/runtime-skill-retry.test.js
```

Expected: PASS.

---

### Task 2: Safe Cursor auth session wrapper

**Files:**
- Create: `src/cursor-auth-session.js`
- Create: `test/cursor-auth-session.test.js`

**Interfaces:**
- Consumes: `withCursorAuthSession(workspace, env, run, { signal } = {})`
- Produces: calls `run(temporaryXdgConfigHome)` exactly once while holding the auth-root lock and returns its result

- [ ] **Step 1: Write failing lifecycle tests**

Create real temporary workspace and auth roots. Cover these assertions:

```js
const result = await withCursorAuthSession(workspace, {
  CURSOR_AUTH_CONFIG_HOME: authRoot
}, async (xdgHome) => {
  assert.equal(path.relative(workspace, xdgHome).startsWith('..'), false);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(xdgHome, 'cursor', 'auth.json'), 'utf8')),
    { token: 'old' }
  );
  await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{"token":"new"}');
  await mkdir(path.join(xdgHome, 'cursor', 'chats'));
  await writeFile(path.join(xdgHome, 'cursor', 'store.db'), 'temporary');
  return 'done';
});

assert.equal(result, 'done');
assert.deepEqual(
  (await readdir(path.join(authRoot, 'cursor'))).sort(),
  ['auth.json', 'cli-config.json']
);
assert.deepEqual(
  JSON.parse(await readFile(path.join(authRoot, 'cursor', 'auth.json'), 'utf8')),
  { token: 'new' }
);
```

Add POSIX-only mode assertions for `0700` directories and `0600` allowlisted files. Add a case where the temporary `auth.json` is removed and the persistent old value remains.

- [ ] **Step 2: Write failing validation and concurrency tests**

Add cases for:

- malformed persistent JSON;
- an allowlisted path that is a directory;
- an allowlisted symbolic link when symlink creation is permitted;
- a symbolic-link auth root or `cursor` child when symlink creation is permitted;
- a file larger than `1_048_576` bytes;
- a temporary symbolic link or malformed JSON that must not replace the valid persistent file;
- two calls for one root where call two must not enter until call one exits and must snapshot call one's refreshed token;
- two calls for different roots that may enter concurrently;
- an aborted queued call that rejects without delaying the next queued call.

Use deferred promises in the same process rather than timing-only assertions:

```js
const firstEntered = deferred();
const releaseFirst = deferred();
const seen = [];
const first = withCursorAuthSession(workspaceOne, env, async (xdgHome) => {
  firstEntered.resolve();
  await releaseFirst.promise;
  await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{"token":"fresh"}');
});
await firstEntered.promise;
const second = withCursorAuthSession(workspaceTwo, env, async (xdgHome) => {
  seen.push(JSON.parse(await readFile(path.join(xdgHome, 'cursor', 'auth.json'), 'utf8')).token);
});
assert.deepEqual(seen, []);
releaseFirst.resolve();
await Promise.all([first, second]);
assert.deepEqual(seen, ['fresh']);
```

- [ ] **Step 3: Run the new suite to verify RED**

Run:

```bash
node --test test/cursor-auth-session.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` because the session module does not exist.

- [ ] **Step 4: Implement boundary validation and snapshot**

In `src/cursor-auth-session.js`, define:

```js
const CURSOR_DIRECTORY = 'cursor';
const ALLOWED_FILES = new Set(['auth.json', 'cli-config.json']);
const MAX_AUTH_FILE_BYTES = 1_048_576;
const authLocks = new Map();

export async function withCursorAuthSession(
  workspace,
  env,
  run,
  { signal } = {}
) {
  const authRoot = cursorAuthConfigHome(env);
  if (!authRoot) throw new Error('CURSOR_AUTH_CONFIG_HOME must be an absolute path');
  return withAuthRootLock(lockKey(authRoot), signal, async () => {
    const boundary = await ensurePersistentBoundary(authRoot);
    await prunePersistentCursorState(boundary);
    const temporaryXdg = await mkdtemp(path.join(workspace, '.cursor-xdg-'));
    try {
      await snapshotAllowedFiles(boundary.cursorDirectory, temporaryXdg);
      return await runAndWriteBack(run, temporaryXdg, boundary);
    } finally {
      await rm(temporaryXdg, { recursive: true, force: true });
    }
  });
}
```

`ensurePersistentBoundary()` must `lstat()` existing paths before use, reject symbolic links and non-directories, create missing directories with `0700`, normalize their modes, resolve realpaths, and require:

```js
path.dirname(realCursorDirectory) === realAuthRoot
  && path.basename(realCursorDirectory) === CURSOR_DIRECTORY
```

`readValidatedJsonFile()` must open with `O_RDONLY | O_NOFOLLOW` where supported, require a regular file, enforce the size limit before reading, parse a non-array JSON object, and return the validated bytes without logging content.

- [ ] **Step 5: Implement mutex, safe cleanup, and atomic writeback**

The mutex must queue the entire lifecycle and support abort while waiting. The writeback flow must:

1. collect and validate all temporary allowlisted updates before changing persistence;
2. write each update to a unique same-directory `wx` temporary file with mode `0600`;
3. call `FileHandle.sync()`, close it, and rename over the allowlisted target;
4. keep the persistent file when the corresponding temporary file is missing;
5. revalidate the boundary and prune every nonallowlisted entry after writeback;
6. preserve both the runtime and writeback errors in an `AggregateError` when both fail.

Cleanup resolves each child against the verified cursor realpath and requires its direct parent to equal that realpath before calling `rm(child, { recursive: true, force: true })`.

- [ ] **Step 6: Run the new suite to verify GREEN**

Run:

```bash
node --test test/cursor-auth-session.test.js
```

Expected: all lifecycle, validation, mode, and concurrency tests PASS; symlink cases may be skipped only when the host denies symlink creation.

---

### Task 3: Wire status and real Cursor calls through the session

**Files:**
- Modify: `src/runtime-status.js`
- Modify: `src/runtimes.js`
- Modify: `test/api.test.js`
- Modify: `test/runtime-skill-retry.test.js`

**Interfaces:**
- Consumes: `withCursorAuthSession(workspace, env, run, { signal })`
- Produces: status and execution child processes both receive the disposable XDG root through `localCliEnv(..., { cursorConfigHome })`

- [ ] **Step 1: Write the failing status integration test**

Use real temporary workspace/auth roots in the existing `probeCursorAuthentication` test. Inside the fake process:

```js
assert.notEqual(execOptions.env.XDG_CONFIG_HOME, authRoot);
assert.equal(
  path.relative(workspace, execOptions.env.XDG_CONFIG_HOME).startsWith('..'),
  false
);
await mkdir(path.join(execOptions.env.XDG_CONFIG_HOME, 'cursor', 'chats'));
await writeFile(
  path.join(execOptions.env.XDG_CONFIG_HOME, 'cursor', 'statsig-cache.json'),
  '{}'
);
await writeFile(
  path.join(execOptions.env.XDG_CONFIG_HOME, 'cursor', 'auth.json'),
  '{"token":"status-refreshed"}'
);
```

After the probe, assert only the two allowlisted files remain persistent and the refreshed auth value was written back.

- [ ] **Step 2: Write the failing real-call integration test**

Export `callLocalCli` and allow an optional `{ runProcess }` dependency for testing. Invoke a Cursor call with a fake process that writes temporary chats/cache and a refreshed auth file, then returns:

```js
{ stdout: '{"result":"visible result"}', stderr: '' }
```

Assert the call returns `visible result`, its XDG root is below the disposable runtime workspace rather than the persistent auth root, and only the refreshed allowlisted files remain persistent.

- [ ] **Step 3: Run focused integration tests to verify RED**

Run:

```bash
node --test --test-name-pattern="Cursor login|real Cursor call" test/api.test.js test/runtime-skill-retry.test.js
```

Expected: FAIL because status and real execution still pass the persistent auth root directly.

- [ ] **Step 4: Wire the status probe**

Wrap the `cursor-agent status` process call:

```js
return await withCursorAuthSession(workspace, env, async (cursorConfigHome) => {
  const { stdout, stderr } = await execFileImpl(executable, ['status'], {
    cwd: workspace,
    timeout: 5_000,
    maxBuffer: 64_000,
    env: localCliEnv('cursor', workspace, env, { cursorConfigHome })
  });
  return cursorStatusAuthenticated(stdout, stderr);
});
```

Keep the outer catch returning `false`, ensure the outer workspace is always removed, and never expose credential content.

- [ ] **Step 5: Wire the real execution path**

Refactor `callLocalCli` so the existing process body accepts an optional disposable Cursor config root:

```js
const execute = async (cursorConfigHome) => {
  const commandEnv = localCliEnv(runtimeId, workspace, parentEnv, {
    cursorConfigHome
  });
  return runProcess(command, args, {
    cwd: workspace,
    timeoutMs: timeout,
    maxBuffer: 5_000_000,
    env: commandEnv,
    signal
  });
};

const processResult = runtimeId === 'cursor'
  ? await withCursorAuthSession(workspace, parentEnv, execute, { signal })
  : await execute();
```

Retain the existing Claude Ark bridge and error mapping. The default `runProcess` remains `runLocalCliProcess`.

- [ ] **Step 6: Run focused and adjacent runtime tests**

Run:

```bash
node --test test/cursor-auth-session.test.js test/runtime-skill-retry.test.js test/api.test.js
```

Expected: PASS.

---

### Task 4: Operator documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PRODUCTION_OPERATIONS.md`
- Modify: `docs/superpowers/plans/2026-07-24-cursor-auth-session-isolation.md`

**Interfaces:**
- Consumes: the implemented allowlist, mode, cleanup, concurrency, and deployment boundaries
- Produces: accurate setup and incident guidance without credential values

- [ ] **Step 1: Update architecture and setup documentation**

Replace statements that Cursor directly uses the persistent root as `XDG_CONFIG_HOME`. Document:

- each invocation uses a disposable XDG root in its runtime workspace;
- only validated `auth.json` and `cli-config.json` are copied in and atomically copied back;
- one process serializes calls sharing an auth root;
- only a single Node service process may share the directory;
- multi-process operation requires an OS lock or external credential broker.

- [ ] **Step 2: Add an operator verification block**

Add commands that check metadata without printing credential content:

```bash
sudo stat -c '%U:%G %a %n' \
  /var/lib/agent-review/cursor-auth \
  /var/lib/agent-review/cursor-auth/cursor \
  /var/lib/agent-review/cursor-auth/cursor/auth.json \
  /var/lib/agent-review/cursor-auth/cursor/cli-config.json
sudo find /var/lib/agent-review/cursor-auth/cursor -mindepth 1 -maxdepth 1 \
  ! -name auth.json ! -name cli-config.json -print
```

Expected directory modes are `700`, file modes are `600`, owner is the service account, and `find` prints nothing. State explicitly that operators must stop the service before manually cleaning or replacing authentication material and must never print either JSON file.

- [ ] **Step 3: Run plan self-review**

Run:

```bash
rg -n "T[B]D|T[O]DO|implement l[a]ter|fill i[n]|appropriate e[rror]|similar t[o]|possibl[y]|mayb[e]" docs/superpowers/plans/2026-07-24-cursor-auth-session-isolation.md
```

Expected: no matches. Compare every design requirement with Tasks 1–4 and correct any gap before verification.

- [ ] **Step 4: Run full checks**

Run:

```bash
npm test
npm run check
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Request independent review**

Ask a fresh reviewer to inspect the diff for path traversal, symbolic-link handling, TOCTOU exposure, destructive cleanup scope, atomicity, mutex correctness, abort behavior, secret leakage, and status/real-call parity. Apply validated findings and rerun focused plus full tests.

- [ ] **Step 6: Commit without push**

Stage only the implementation, tests, and documentation from this plan:

```bash
git add src/cursor-auth-session.js src/runtime-environment.js src/runtime-status.js src/runtimes.js \
  test/cursor-auth-session.test.js test/runtime-skill-retry.test.js test/api.test.js \
  README.md docs/ARCHITECTURE.md docs/PRODUCTION_OPERATIONS.md \
  docs/superpowers/plans/2026-07-24-cursor-auth-session-isolation.md
git commit -m "fix: isolate Cursor persistent authentication state"
```

Expected: commit succeeds on `codex/runtime-cli-install`; do not push.
