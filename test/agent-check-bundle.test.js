import test from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  APP_FILES,
  acquireRuntimeArchive,
  buildAgentCheckBundles,
  verifyAppBundle,
  verifyFileSha256,
  writeBundleZip
} from '../scripts/build-agent-check-bundles.js';

const EXPECTED_APP_FILES = [
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
];

async function withTempDir(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-check-bundle-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function readZipCentralEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset <= buffer.length - 46) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.set(name, {
      creatorSystem: buffer.readUInt16LE(offset + 4) >>> 8,
      mode: buffer.readUInt32LE(offset + 38) >>> 16
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('builds application trees from an exact standalone allowlist', async () => {
  await withTempDir(async (outputRoot) => {
    const result = await buildAgentCheckBundles({ outputRoot, appOnly: true });

    assert.deepEqual([...APP_FILES].sort(), EXPECTED_APP_FILES.sort());
    assert.deepEqual(await verifyAppBundle(result.windowsDir), EXPECTED_APP_FILES.sort());
    assert.deepEqual(await verifyAppBundle(result.macDir), EXPECTED_APP_FILES.sort());

    const bundledPackage = JSON.parse(await readFile(
      path.join(result.windowsDir, 'package.json'),
      'utf8'
    ));
    assert.deepEqual(bundledPackage, {
      name: 'agent-card-check-standalone',
      private: true,
      type: 'module',
      engines: { node: '>=20' }
    });

    for (const forbidden of [
      'server.js',
      'public/index.html',
      'public/app.js',
      'public/styles.css',
      'src/pipeline.js',
      'src/scoring.js',
      'src/store.js',
      'src/runtimes.js',
      'src/providers.js',
      'src/panda-data.js',
      'agents',
      'data',
      'deploy',
      '.env'
    ]) {
      assert.equal((await verifyAppBundle(result.windowsDir)).includes(forbidden), false);
    }
  });
});

test('rejects unexpected files instead of relying on an exclusion copy', async () => {
  await withTempDir(async (outputRoot) => {
    const result = await buildAgentCheckBundles({ outputRoot, appOnly: true });
    await writeFile(path.join(result.windowsDir, 'server.js'), 'main platform');

    await assert.rejects(
      verifyAppBundle(result.windowsDir),
      /unexpected|不允许|server\.js/i
    );
  });
});

test('rejects a standalone entry point that imports a main-platform module', async () => {
  await withTempDir(async (outputRoot) => {
    const result = await buildAgentCheckBundles({ outputRoot, appOnly: true });
    await appendFile(
      path.join(result.windowsDir, 'diagnostics-server.js'),
      "\nimport './src/pipeline.js';\n"
    );

    await assert.rejects(
      verifyAppBundle(result.windowsDir),
      /pipeline|import|依赖/i
    );
  });
});

test('verifies runtime bytes against an independently known SHA-256', async () => {
  await withTempDir(async (root) => {
    const archive = path.join(root, 'runtime.bin');
    await writeFile(archive, 'abc');

    await assert.doesNotReject(() => verifyFileSha256(
      archive,
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    ));
    await assert.rejects(
      verifyFileSha256(archive, '0'.repeat(64)),
      /SHA-256|校验/i
    );
  });
});

test('downloads runtime archives atomically and reuses only verified cache bytes', async () => {
  await withTempDir(async (cacheDir) => {
    const descriptor = {
      file: 'node-fixture.zip',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    };
    let fetches = 0;
    const archive = await acquireRuntimeArchive({
      baseUrl: 'https://nodejs.example/v1',
      cacheDir,
      descriptor,
      fetchImpl: async (url) => {
        fetches += 1;
        assert.equal(url, 'https://nodejs.example/v1/node-fixture.zip');
        return new Response('abc', { status: 200 });
      }
    });
    assert.equal(await readFile(archive, 'utf8'), 'abc');
    assert.equal(fetches, 1);

    const reused = await acquireRuntimeArchive({
      baseUrl: 'https://nodejs.example/v1',
      cacheDir,
      descriptor,
      offline: true,
      fetchImpl: async () => {
        throw new Error('verified cache should avoid network');
      }
    });
    assert.equal(reused, archive);

    await writeFile(archive, 'tampered');
    await assert.rejects(
      acquireRuntimeArchive({
        baseUrl: 'https://nodejs.example/v1',
        cacheDir,
        descriptor,
        offline: true
      }),
      /offline|缓存|SHA-256/i
    );
  });
});

test('assembles both platform runtime layouts through injected build boundaries', async () => {
  await withTempDir(async (outputRoot) => {
    const runtimeTargets = [];
    const result = await buildAgentCheckBundles({
      outputRoot,
      async runtimeProvider({ target, destination }) {
        runtimeTargets.push(target);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, `runtime:${target}`);
      },
      async archiveWriter({ sourceDir, destination }) {
        await writeFile(destination, `archive:${path.basename(sourceDir)}`);
      }
    });

    assert.deepEqual(runtimeTargets.sort(), [
      'mac-arm64',
      'mac-x64',
      'windows-x64'
    ]);
    assert.equal(
      await readFile(path.join(outputRoot, 'windows/runtime/node.exe'), 'utf8'),
      'runtime:windows-x64'
    );
    assert.equal(
      await readFile(path.join(outputRoot, 'mac/runtime/arm64/bin/node'), 'utf8'),
      'runtime:mac-arm64'
    );
    assert.equal(
      await readFile(path.join(outputRoot, 'mac/runtime/x64/bin/node'), 'utf8'),
      'runtime:mac-x64'
    );

    const windowsScriptBytes = await readFile(
      path.join(outputRoot, 'windows/start.bat')
    );
    const windowsScript = windowsScriptBytes.toString('utf8');
    assert.match(windowsScript, /\r\n/u);
    assert.doesNotMatch(windowsScript, /(?<!\r)\n/u);
    assert.equal(windowsScriptBytes.every((byte) => byte < 0x80), true);
    assert.match(windowsScript, /runtime\\node\.exe/i);
    assert.match(windowsScript, /ENV_FILE=.*config\.env/i);
    assert.match(windowsScript, /api\/health/i);
    assert.match(windowsScript, /localhost:4173\/agent-check/i);
    assert.doesNotMatch(windowsScript, /http:\/\/127\.0\.0\.1:4173/i);

    const macScript = await readFile(
      path.join(outputRoot, 'mac/start.command'),
      'utf8'
    );
    assert.match(macScript, /uname -m/);
    assert.match(macScript, /runtime\/arm64\/bin\/node/);
    assert.match(macScript, /runtime\/x64\/bin\/node/);
    assert.match(macScript, /ENV_FILE=.*config\.env/);
    assert.match(macScript, /api\/health/);
    assert.match(macScript, /localhost:4173\/agent-check/);
    assert.doesNotMatch(macScript, /http:\/\/127\.0\.0\.1:4173/);

    const config = await readFile(
      path.join(outputRoot, 'windows/config.env'),
      'utf8'
    );
    assert.match(config, /^HOST=localhost$/m);
    assert.match(config, /^PORT=4173$/m);
    assert.match(config, /^AGENT_DIAGNOSTICS_RATE_LIMIT=30$/m);
    assert.match(config, /^AGENT_DIAGNOSTICS_CONCURRENCY=4$/m);
    assert.match(config, /^ALLOW_PRIVATE_DIAGNOSTICS_URLS=true$/m);
    assert.doesNotMatch(config, /ALLOW_PRIVATE_AGENT_URLS/);

    for (const platform of ['windows', 'mac']) {
      const guide = await readFile(
        path.join(outputRoot, platform, '使用说明.md'),
        'utf8'
      );
      assert.match(guide, /无需安装 Docker/);
      assert.match(guide, /无需安装 Node\.js/);
      assert.match(guide, /http:\/\/localhost:4173\/agent-check/);
      assert.match(guide, /Ctrl\+C/);
      assert.match(guide, /Token/);
      assert.match(guide, /端口/);
    }

    await access(result.windowsZip);
    await access(result.macZip);
    assert.deepEqual(result.archiveSha256, {
      windows: '441a017d46f2f71cd84855496017c1cbe7858cd7d987f6c974b10138083dffa5',
      mac: '5b0ec45f4063673035f3cf600dc856bee9bcfdc44d3fce6a9eb05f4b395d21da'
    });
  });
});

test('writes macOS launchers and bundled Node runtimes as executable ZIP entries', async () => {
  await withTempDir(async (root) => {
    const sourceDir = path.join(root, 'mac');
    const destination = path.join(root, 'agent-check-mac.zip');
    const fixtureFiles = {
      'start.command': '#!/bin/sh\n',
      'runtime/arm64/bin/node': 'arm64',
      'runtime/x64/bin/node': 'x64',
      'config.env': 'PORT=4173\n',
      '使用说明.md': '# 使用说明\n'
    };
    for (const [relativePath, content] of Object.entries(fixtureFiles)) {
      const target = path.join(sourceDir, ...relativePath.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    await writeBundleZip({ sourceDir, destination });
    const entries = readZipCentralEntries(await readFile(destination));

    for (const relativePath of [
      'start.command',
      'runtime/arm64/bin/node',
      'runtime/x64/bin/node'
    ]) {
      assert.equal(entries.get(relativePath)?.creatorSystem, 3);
      assert.equal(entries.get(relativePath)?.mode & 0o111, 0o111);
    }
    assert.equal(entries.get('config.env')?.mode & 0o111, 0);
    assert.ok(entries.has('使用说明.md'));
  });
});

test('exposes an organizer build command and keeps generated runtimes out of git', async () => {
  const projectPackage = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8'
  ));
  assert.equal(
    projectPackage.scripts['bundle:agent-check'],
    'node scripts/build-agent-check-bundles.js'
  );

  const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^\/dist\/agent-check\/$/m);
  assert.match(gitignore, /^\/\.cache\/agent-check-runtimes\/$/m);

  const guide = await readFile(
    new URL('../docs/AGENT_CHECK_LOCAL_BUNDLE.md', import.meta.url),
    'utf8'
  );
  assert.match(guide, /npm run bundle:agent-check/);
  assert.match(guide, /--offline/);
  assert.match(guide, /agent-check-windows\.zip/);
  assert.match(guide, /agent-check-mac\.zip/);
  assert.match(guide, /不包含主测评平台/);
});
