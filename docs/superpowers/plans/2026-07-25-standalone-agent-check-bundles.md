# Standalone Agent Check Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成不含主测评平台、无需预装 Docker/Node.js、可在 Windows x64 与 macOS Intel/Apple Silicon 一键启动的 Agent Card 自测台独立包。

**Architecture:** 新增只挂载诊断页面、健康检查、Card URL 解析和诊断 API 的 `diagnostics-server.js`。打包器从显式白名单复制应用文件，下载并校验固定版本 Node.js 运行时，生成 Windows/macOS 目录与 ZIP；产物验证器对文件清单、静态导入边界和禁止项进行失败关闭检查。

**Tech Stack:** Node.js ESM、Node.js built-in test runner、原生 HTTP/fetch/fs/crypto/child_process、系统 `tar`、Windows Batch、POSIX shell。

## Global Constraints

- 运行包不得要求预装 Docker 或 Node.js。
- Windows 仅支持 x64；macOS 同时支持 `arm64` 与 `x86_64`。
- 服务默认只监听部署机器的 `localhost:4173`。
- 运行包默认设置 `ALLOW_PRIVATE_DIAGNOSTICS_URLS=true`，但不得设置 `ALLOW_PRIVATE_AGENT_URLS`。
- 只允许 `/agent-check` 静态资源、`GET /api/health`、`POST /api/agent-cards/resolve` 与 `POST /api/agent-diagnostics`。
- 主站页面、评测 API、评分、流水线、Runtime、模型供应商、数据、部署配置、`.env`、密钥和历史记录不得进入产物。
- Node.js 运行时固定为 `v24.17.0`，每个下载文件必须通过 SHA-256 后才能解压。
- 所有生产逻辑必须遵循 RED → GREEN → REFACTOR；每个新增行为先观察测试因缺失功能而失败。

---

### Task 1: 独立诊断 HTTP 服务

**Files:**
- Create: `diagnostics-server.js`
- Create: `test/diagnostics-server.test.js`
- Reuse: `src/env.js`
- Reuse: `src/server-address.js`
- Reuse: `src/agent-diagnostics.js`
- Reuse: `src/diagnostics-guard.js`
- Reuse: `src/a2a.js`
- Reuse: `src/safe-http.js`

**Interfaces:**
- Produces: `createDiagnosticsServer(options?: { diagnosticsGuard?: DiagnosticsGuard, runDiagnostics?: Function, resolveCard?: Function }): http.Server`
- Produces: `startDiagnosticsServer(env?: NodeJS.ProcessEnv): Promise<http.Server>`
- HTTP: `GET /` → `302 Location: /agent-check`
- HTTP: `GET /agent-check[.html]` and three named assets → `200`
- HTTP: `GET /api/health` → `{ ok: true, mode: "agent-check-standalone", time: string }`
- HTTP: `POST /api/agent-cards/resolve` and `POST /api/agent-diagnostics`
- HTTP: every other `/api/*` and static path → `404`

- [ ] **Step 1: Write the failing route-isolation test**

Create `test/diagnostics-server.test.js` with a temporary listening server and assertions equivalent to:

```js
const server = createDiagnosticsServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

assert.equal((await fetch(`${origin}/` , { redirect: 'manual' })).status, 302);
assert.equal((await fetch(`${origin}/agent-check`)).status, 200);
assert.equal((await fetch(`${origin}/agent-check.js`)).status, 200);
assert.equal((await fetch(`${origin}/agent-check-helpers.js`)).status, 200);
assert.equal((await fetch(`${origin}/agent-check.css`)).status, 200);

const health = await fetch(`${origin}/api/health`);
assert.deepEqual((await health.json()).mode, 'agent-check-standalone');

assert.equal((await fetch(`${origin}/api/evaluations`)).status, 404);
assert.equal((await fetch(`${origin}/index.html`)).status, 404);
assert.equal((await fetch(`${origin}/app.js`)).status, 404);
```

Add injected handler tests proving the two POST routes are mounted without making remote network calls:

```js
const server = createDiagnosticsServer({
  runDiagnostics: async (input) => ({ received: input.prompt }),
  resolveCard: async (sourceType, url) => ({ sourceType, url }),
  diagnosticsGuard: { enter: () => () => {} }
});
```

Assert malformed JSON returns `400`, oversized bodies return `413`, handler errors preserve `statusCode`, and non-POST methods return `404`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/diagnostics-server.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `diagnostics-server.js`.

- [ ] **Step 3: Implement the minimal standalone server**

Create `diagnostics-server.js` with:

```js
import './src/env.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentCard } from './src/a2a.js';
import { runAgentDiagnostics } from './src/agent-diagnostics.js';
import { createDiagnosticsGuard } from './src/diagnostics-guard.js';
import { resolveServerAddress } from './src/server-address.js';
```

Use a fixed static map:

```js
const STATIC_FILES = new Map([
  ['/agent-check', 'agent-check.html'],
  ['/agent-check.html', 'agent-check.html'],
  ['/agent-check.js', 'agent-check.js'],
  ['/agent-check-helpers.js', 'agent-check-helpers.js'],
  ['/agent-check.css', 'agent-check.css']
]);
```

Implement a local bounded JSON reader with a `1.25 MiB` limit, `AbortController` propagation for diagnostics, `cache-control: no-store` on API responses, MIME types for HTML/JS/CSS, and a JSON error boundary:

```js
const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
json(response, status, { error: status === 500 ? '自测台内部错误' : error.message });
```

When `NODE_ENV !== 'test'`, call `startDiagnosticsServer()` and print the exact local URL. `startDiagnosticsServer` must call `resolveServerAddress(env)` and reject non-loopback `HOST` values so users cannot accidentally expose Bearer Tokens over LAN.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test test/diagnostics-server.test.js
```

Expected: all tests PASS and the process exits cleanly after servers are closed.

- [ ] **Step 5: Run existing diagnostics regression tests**

Run:

```powershell
node --test test/agent-diagnostics.test.js test/a2a.test.js test/safe-http.test.js test/server-address.test.js
```

Expected: all tests PASS.

### Task 2: 白名单打包器与运行时供应链校验

**Files:**
- Create: `packaging/agent-check/runtime-lock.json`
- Create: `scripts/build-agent-check-bundles.js`
- Create: `test/agent-check-bundle.test.js`

**Interfaces:**
- Produces: `APP_FILES: readonly string[]`
- Produces: `FORBIDDEN_PATHS: readonly string[]`
- Produces: `buildAgentCheckBundles(options): Promise<{ windowsDir, macDir, windowsZip, macZip }>`
- Produces: `verifyAppBundle(appRoot): Promise<string[]>`
- Consumes: runtime archives from `runtimeCache`, otherwise downloads from the locked official `nodejs.org` URL.

- [ ] **Step 1: Write the failing allowlist and boundary tests**

Create `test/agent-check-bundle.test.js`. Assert:

```js
assert.deepEqual(APP_FILES.sort(), [
  'diagnostics-server.js',
  'package.json',
  'public/agent-check.css',
  'public/agent-check-helpers.js',
  'public/agent-check.html',
  'public/agent-check.js',
  'src/a2a.js',
  'src/agent-diagnostics.js',
  'src/diagnostics-guard.js',
  'src/env.js',
  'src/safe-http.js',
  'src/server-address.js'
].sort());
```

Build an app-only fixture into a temporary directory and assert every recursive relative path is expected. Explicitly assert absence of:

```js
[
  'server.js', 'public/index.html', 'public/app.js', 'public/styles.css',
  'src/pipeline.js', 'src/scoring.js', 'src/store.js', 'src/runtimes.js',
  'src/providers.js', 'src/panda-data.js', 'agents', 'data', 'deploy', '.env'
]
```

Parse static relative imports recursively from `diagnostics-server.js` and assert the reached `src` files exactly match the allowlist. Add a mutation test that writes `public/index.html` into the fixture and expects `verifyAppBundle` to reject it.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/agent-check-bundle.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/build-agent-check-bundles.js`.

- [ ] **Step 3: Add the pinned runtime lock**

Create `packaging/agent-check/runtime-lock.json`:

```json
{
  "version": "v24.17.0",
  "baseUrl": "https://nodejs.org/download/release/v24.17.0",
  "archives": {
    "windows-x64": {
      "file": "node-v24.17.0-win-x64.zip",
      "sha256": "f2aa33b35b75aca5f3f7b85675a6f6423201053e9381911e64961f3bda2528ab"
    },
    "mac-arm64": {
      "file": "node-v24.17.0-darwin-arm64.tar.gz",
      "sha256": "4fc3266a3702eebc39cc37661cf4eeceeade307e242ab64e4d7ce7949197e11f"
    },
    "mac-x64": {
      "file": "node-v24.17.0-darwin-x64.tar.gz",
      "sha256": "80da552fe037290cb130e9dea590f5eeeb7aa450636f0c89ab41415511c1ec27"
    }
  }
}
```

- [ ] **Step 4: Implement app copying and fail-closed verification**

In `scripts/build-agent-check-bundles.js`:

- resolve all source and destination paths below explicit roots;
- copy only `APP_FILES`;
- write a minimal bundled `package.json` with `{ "private": true, "type": "module", "engines": { "node": ">=20" } }` instead of copying main-project scripts/dependencies;
- recursively list files with normalized `/` separators;
- reject symlinks, paths outside the bundle root, unexpected files, missing allowed files and forbidden basenames;
- walk relative `import` declarations and reject imports outside the copied graph.

The CLI must accept:

```text
--output <path>          default: dist/agent-check
--runtime-cache <path>   default: .cache/agent-check-runtimes
--offline                forbid downloads and require verified cached archives
--app-only               build/verify application trees without runtimes or ZIPs
```

- [ ] **Step 5: Implement verified runtime download and extraction**

For each runtime:

1. Reuse a cached archive only if its SHA-256 matches.
2. Otherwise, unless `--offline`, download to `<file>.partial`, hash it, rename only after a match.
3. On mismatch, delete the partial file and throw an error naming the archive but not arbitrary response content.
4. Extract with `tar -xf <archive> -C <temporary-dir>`.
5. Copy only `node.exe` or `bin/node` into the documented runtime destination.
6. Mark macOS binaries and `start.command` executable.

Allow tests to inject a runtime provider:

```js
await buildAgentCheckBundles({
  outputRoot,
  runtimeProvider: async ({ target, destination }) => {
    await copyFile(process.execPath, destination);
  },
  archiveWriter: async ({ sourceDir, destination }) => {
    await writeFile(destination, `fixture:${path.basename(sourceDir)}`);
  }
});
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```powershell
node --test test/agent-check-bundle.test.js
```

Expected: all tests PASS, including allowlist rejection and injected-runtime builds.

### Task 3: Windows/macOS 一键启动脚本与中文使用文档

**Files:**
- Create: `packaging/agent-check/config.env`
- Create: `packaging/agent-check/start.bat`
- Create: `packaging/agent-check/start.command`
- Create: `packaging/agent-check/使用说明-Windows.md`
- Create: `packaging/agent-check/使用说明-macOS.md`
- Modify: `test/agent-check-bundle.test.js`
- Modify: `scripts/build-agent-check-bundles.js`

**Interfaces:**
- Windows bundle receives `start.bat` and `使用说明.md`.
- macOS bundle receives `start.command` and `使用说明.md`.
- Both launchers set `ENV_FILE` to the sibling `config.env` and start `app/diagnostics-server.js` with the bundled runtime.

- [ ] **Step 1: Add failing launcher and documentation tests**

Extend `test/agent-check-bundle.test.js` to assert:

```js
assert.match(windowsScript, /runtime\\node\.exe/i);
assert.match(windowsScript, /ENV_FILE=.*config\.env/i);
assert.match(windowsScript, /localhost:4173\/agent-check/i);
assert.doesNotMatch(windowsScript, /\bnode\b app\\diagnostics-server\.js/i);

assert.match(macScript, /uname -m/);
assert.match(macScript, /runtime\/arm64\/bin\/node/);
assert.match(macScript, /runtime\/x64\/bin\/node/);
assert.match(macScript, /ENV_FILE=.*config\.env/);
assert.match(macScript, /localhost:4173\/agent-check/);
```

Assert `config.env` contains the five documented settings and excludes `ALLOW_PRIVATE_AGENT_URLS`. Assert both docs mention “无需安装 Docker”、 “无需安装 Node.js”、start/stop, port conflict, loopback meaning, Token warning and platform-specific security prompts.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/agent-check-bundle.test.js
```

Expected: FAIL because launcher/template files do not exist.

- [ ] **Step 3: Implement launchers**

`start.bat` must:

- derive `%~dp0`;
- verify `runtime\node.exe` and `app\diagnostics-server.js`;
- set `ENV_FILE=%~dp0config.env`;
- start the browser after a short health-check loop using PowerShell `Invoke-WebRequest`;
- run the server in the foreground and preserve its exit code;
- print Chinese guidance and `pause` on startup failure.

`start.command` must:

- derive its directory through `cd -- "$(dirname -- "$0")"`;
- map `arm64` to `runtime/arm64/bin/node` and `x86_64` to `runtime/x64/bin/node`;
- reject other architectures with a Chinese error;
- set `ENV_FILE`;
- start the server in the background, trap `EXIT INT TERM` to stop it, poll health with `curl`, open the browser with `open`, then `wait` on the server process.

- [ ] **Step 4: Write platform-specific Chinese docs and config**

Create `config.env`:

```dotenv
HOST=localhost
PORT=4173
AGENT_DIAGNOSTICS_RATE_LIMIT=30
AGENT_DIAGNOSTICS_CONCURRENCY=4
ALLOW_PRIVATE_DIAGNOSTICS_URLS=true
```

Write concise step-by-step Windows and macOS instructions covering all items in the design, including:

- Windows SmartScreen “更多信息 → 仍要运行” only when the ZIP came from the official organizer;
- macOS `xattr -dr com.apple.quarantine <解压后的目录>` and `chmod +x start.command` recovery commands;
- changing `PORT` requires opening the matching URL manually if it is not `4173`;
- `localhost` in an Agent Card points to the same contestant computer because the service is local;
- never expose `HOST` beyond loopback and never reuse production Bearer Tokens on an untrusted computer.

- [ ] **Step 5: Copy templates into platform bundles and verify GREEN**

Update the builder to copy common config plus the correct launcher/doc names, set macOS executable modes, and include them in bundle verification.

Run:

```powershell
node --test test/agent-check-bundle.test.js
```

Expected: all tests PASS.

### Task 4: 项目命令、真实打包与端到端验收

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `docs/AGENT_CHECK_LOCAL_BUNDLE.md`
- Modify: `README.md`
- Modify: `test/agent-check-bundle.test.js`

**Interfaces:**
- Produces npm command: `npm run bundle:agent-check`
- Produces organizer guide: `docs/AGENT_CHECK_LOCAL_BUNDLE.md`
- Produces ignored local artifacts under `dist/agent-check/` and `.cache/agent-check-runtimes/`

- [ ] **Step 1: Add failing integration assertions**

Extend tests to assert `package.json` contains:

```json
"bundle:agent-check": "node scripts/build-agent-check-bundles.js"
```

Assert `.gitignore` covers `/dist/agent-check/` and `/.cache/agent-check-runtimes/`. Assert the organizer guide documents online build, offline cached build, expected output filenames and the isolation verification command.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/agent-check-bundle.test.js
```

Expected: FAIL on the missing package script or organizer guide.

- [ ] **Step 3: Add the build command and organizer documentation**

Update `package.json`, `.gitignore`, `README.md`, and create `docs/AGENT_CHECK_LOCAL_BUNDLE.md` with:

```powershell
npm run bundle:agent-check
node scripts/build-agent-check-bundles.js --offline
node --test test/agent-check-bundle.test.js test/diagnostics-server.test.js
```

Document that only organizers run the build command; contestants use the generated folders/ZIPs and do not need Node.js.

- [ ] **Step 4: Run all focused and full regression checks**

Run:

```powershell
node --test test/diagnostics-server.test.js test/agent-check-bundle.test.js
npm run check
npm test
```

Expected: every command exits `0`, no test failures, no syntax errors.

- [ ] **Step 5: Build real Windows and macOS artifacts**

Run:

```powershell
npm run bundle:agent-check
```

Expected output:

```text
dist/agent-check/windows/
dist/agent-check/mac/
dist/agent-check/agent-check-windows.zip
dist/agent-check/agent-check-mac.zip
```

The builder must print the SHA-256 of both final ZIP files.

- [ ] **Step 6: Smoke-test the packaged application and audit contents**

Start the packaged Windows application binary directly on an ephemeral port by importing the exported factory under test mode:

```powershell
$env:NODE_ENV = 'test'
& 'dist/agent-check/windows/runtime/node.exe' --input-type=module --eval @'
const { createDiagnosticsServer } = await import('./dist/agent-check/windows/app/diagnostics-server.js');
const server = createDiagnosticsServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
console.log(`SMOKE_PORT=${server.address().port}`);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
'@
```

The automated smoke helper must discover the assigned port from stdout, then assert:

- `/agent-check` → `200`;
- `/api/health` → `200` with `mode=agent-check-standalone`;
- `/api/evaluations` → `404`;
- `/index.html` → `404`;
- process stops cleanly.

List both directories and ZIPs recursively and compare against the builder manifest. Search all text files for:

```text
/api/evaluations
EvaluationPipeline
EvaluationStore
REVIEW_MODEL_
PANDA_DATA_
```

Expected: no matches in the runtime app except the negative-route test is not packaged. Confirm neither ZIP contains `.env`, `data/`, `agents/`, `deploy/`, `server.js`, `public/index.html`, `public/app.js`, `src/pipeline.js`, `src/scoring.js`, `src/runtimes.js`, or `src/providers.js`.

- [ ] **Step 7: Review the final diff and commit**

Run:

```powershell
git diff --check
git status --short
```

Stage only files belonging to this feature and commit:

```powershell
git add -- diagnostics-server.js package.json .gitignore README.md docs/AGENT_CHECK_LOCAL_BUNDLE.md docs/superpowers/plans/2026-07-25-standalone-agent-check-bundles.md packaging/agent-check scripts/build-agent-check-bundles.js test/diagnostics-server.test.js test/agent-check-bundle.test.js
git commit -m "feat: package standalone agent check apps"
```
