import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptFile), '..');
const MINIMAL_PACKAGE = Object.freeze({
  name: 'agent-card-check-standalone',
  private: true,
  type: 'module',
  engines: { node: '>=20' }
});

export const APP_FILES = Object.freeze([
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
]);

const APP_FILE_SET = new Set(APP_FILES);

export async function buildAgentCheckBundles(options = {}) {
  const outputRoot = path.resolve(
    options.outputRoot || path.join(projectRoot, 'dist', 'agent-check')
  );
  assertSafeOutputRoot(outputRoot);
  await rm(outputRoot, { recursive: true, force: true });

  const windowsDir = path.join(outputRoot, 'windows', 'app');
  const macDir = path.join(outputRoot, 'mac', 'app');
  await Promise.all([
    buildAppBundle(windowsDir),
    buildAppBundle(macDir)
  ]);
  await Promise.all([
    verifyAppBundle(windowsDir),
    verifyAppBundle(macDir)
  ]);
  await copyPlatformAssets(outputRoot);

  let windowsZip = null;
  let macZip = null;
  let archiveSha256 = null;
  if (!options.appOnly) {
    const runtimeLock = options.runtimeLock || await loadRuntimeLock();
    const runtimeProvider = options.runtimeProvider || defaultRuntimeProvider;
    const runtimeCache = path.resolve(
      options.runtimeCache || path.join(projectRoot, '.cache', 'agent-check-runtimes')
    );
    const runtimeJobs = [
      {
        target: 'windows-x64',
        destination: path.join(outputRoot, 'windows', 'runtime', 'node.exe')
      },
      {
        target: 'mac-arm64',
        destination: path.join(outputRoot, 'mac', 'runtime', 'arm64', 'bin', 'node')
      },
      {
        target: 'mac-x64',
        destination: path.join(outputRoot, 'mac', 'runtime', 'x64', 'bin', 'node')
      }
    ];
    for (const job of runtimeJobs) {
      await mkdir(path.dirname(job.destination), { recursive: true });
      await runtimeProvider({
        ...job,
        descriptor: runtimeLock.archives[job.target],
        baseUrl: runtimeLock.baseUrl,
        cacheDir: runtimeCache,
        offline: options.offline === true
      });
      if (job.target.startsWith('mac-')) await chmod(job.destination, 0o755);
    }

    const archiveWriter = options.archiveWriter || defaultArchiveWriter;
    windowsZip = path.join(outputRoot, 'agent-check-windows.zip');
    macZip = path.join(outputRoot, 'agent-check-mac.zip');
    await archiveWriter({
      sourceDir: path.join(outputRoot, 'windows'),
      destination: windowsZip
    });
    await archiveWriter({
      sourceDir: path.join(outputRoot, 'mac'),
      destination: macZip
    });
    archiveSha256 = {
      windows: await sha256File(windowsZip),
      mac: await sha256File(macZip)
    };
  }

  return {
    outputRoot,
    windowsDir,
    macDir,
    windowsZip,
    macZip,
    archiveSha256
  };
}

export async function verifyAppBundle(appRoot) {
  const resolvedRoot = path.resolve(appRoot);
  const files = await listRegularFiles(resolvedRoot);
  const sortedExpected = [...APP_FILES].sort();
  if (
    files.length !== sortedExpected.length ||
    files.some((file, index) => file !== sortedExpected[index])
  ) {
    const unexpected = files.filter((file) => !APP_FILE_SET.has(file));
    const missing = sortedExpected.filter((file) => !files.includes(file));
    throw new Error(
      `Standalone app contains unexpected or missing files: ` +
      `unexpected=${unexpected.join(',') || '-'} missing=${missing.join(',') || '-'}`
    );
  }
  await verifyRelativeImportGraph(resolvedRoot);
  return files;
}

export async function verifyFileSha256(file, expected) {
  const actual = await sha256File(file);
  if (actual !== String(expected).toLowerCase()) {
    throw new Error(`SHA-256 校验失败：${path.basename(file)}`);
  }
  return actual;
}

async function sha256File(file) {
  const content = await readFile(file);
  return createHash('sha256').update(content).digest('hex');
}

export async function acquireRuntimeArchive(options) {
  const {
    baseUrl,
    cacheDir,
    descriptor,
    fetchImpl = fetch,
    offline = false
  } = options;
  if (!descriptor?.file || !/^[a-f0-9]{64}$/u.test(descriptor.sha256 || '')) {
    throw new Error('运行时锁定信息无效');
  }
  await mkdir(cacheDir, { recursive: true });
  const archive = safeJoin(cacheDir, descriptor.file);
  try {
    await verifyFileSha256(archive, descriptor.sha256);
    return archive;
  } catch (error) {
    if (offline) {
      throw new Error(`offline 模式缺少通过 SHA-256 校验的运行时缓存：${descriptor.file}`, {
        cause: error
      });
    }
  }

  const partial = `${archive}.partial`;
  await rm(partial, { force: true });
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/u, '')}/${descriptor.file}`);
    if (!response.ok) {
      throw new Error(`下载 Node.js 运行时失败：HTTP ${response.status}`);
    }
    await writeFile(partial, Buffer.from(await response.arrayBuffer()));
    await verifyFileSha256(partial, descriptor.sha256);
    await rm(archive, { force: true });
    await rename(partial, archive);
    return archive;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function buildAppBundle(destination) {
  for (const relativePath of APP_FILES) {
    const target = safeJoin(destination, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    if (relativePath === 'package.json') {
      await writeFile(target, `${JSON.stringify(MINIMAL_PACKAGE, null, 2)}\n`, 'utf8');
      continue;
    }
    await copyFile(safeJoin(projectRoot, relativePath), target);
  }
}

async function copyPlatformAssets(outputRoot) {
  const templateRoot = path.join(projectRoot, 'packaging', 'agent-check');
  const copies = [
    ['config.env', 'windows/config.env'],
    ['config.env', 'mac/config.env'],
    ['start.bat', 'windows/start.bat'],
    ['start.command', 'mac/start.command'],
    ['使用说明-Windows.md', 'windows/使用说明.md'],
    ['使用说明-macOS.md', 'mac/使用说明.md']
  ];
  for (const [source, destination] of copies) {
    const target = safeJoin(outputRoot, destination);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(safeJoin(templateRoot, source), target);
  }
  await chmod(path.join(outputRoot, 'mac', 'start.command'), 0o755);
}

async function loadRuntimeLock() {
  const file = path.join(projectRoot, 'packaging', 'agent-check', 'runtime-lock.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function defaultRuntimeProvider(options) {
  const archive = await acquireRuntimeArchive(options);
  const extractRoot = await mkdtemp(path.join(tmpdir(), 'agent-check-runtime-'));
  try {
    const extractedName = options.descriptor.file
      .replace(/\.tar\.gz$/u, '')
      .replace(/\.zip$/u, '');
    const member = options.target === 'windows-x64'
      ? `${extractedName}/node.exe`
      : `${extractedName}/bin/node`;
    runCommand('tar', ['-xf', archive, '-C', extractRoot, member]);
    const source = path.join(extractRoot, ...member.split('/'));
    await copyFile(source, options.destination);
  } finally {
    await rm(extractRoot, { recursive: true, force: true });
  }
}

async function defaultArchiveWriter({ sourceDir, destination }) {
  await rm(destination, { force: true });
  runCommand('tar', ['-a', '-cf', destination, '-C', sourceDir, '.']);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败：${result.stderr.trim() || `exit ${result.status}`}`);
  }
}

async function listRegularFiles(root) {
  const results = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error(`Standalone app 不允许符号链接：${relative}`);
      }
      if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile()) {
        results.push(relative);
      } else {
        throw new Error(`Standalone app 不允许特殊文件：${relative}`);
      }
    }
  }
  await visit(root);
  return results.sort();
}

async function verifyRelativeImportGraph(appRoot) {
  const visited = new Set();

  async function visit(relativePath) {
    if (visited.has(relativePath)) return;
    if (!APP_FILE_SET.has(relativePath)) {
      throw new Error(`Standalone import 依赖不在白名单：${relativePath}`);
    }
    visited.add(relativePath);
    if (!relativePath.endsWith('.js')) return;

    const source = await readFile(safeJoin(appRoot, relativePath), 'utf8');
    const importPattern = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu;
    for (const match of source.matchAll(importPattern)) {
      const resolved = path.posix.normalize(path.posix.join(
        path.posix.dirname(relativePath),
        match[1]
      ));
      if (resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
        throw new Error(`Standalone import 越过应用边界：${match[1]}`);
      }
      await visit(resolved);
    }
  }

  await visit('diagnostics-server.js');
}

function safeJoin(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`路径越过目标目录：${relativePath}`);
  }
  return target;
}

function assertSafeOutputRoot(outputRoot) {
  const parsed = path.parse(outputRoot);
  if (
    outputRoot === parsed.root ||
    outputRoot === projectRoot ||
    outputRoot.length <= parsed.root.length + 3
  ) {
    throw new Error(`拒绝清理不安全的输出目录：${outputRoot}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildAgentCheckBundles(options);
  console.log(`Standalone app trees ready: ${result.outputRoot}`);
  if (result.archiveSha256) {
    console.log(`agent-check-windows.zip SHA-256 ${result.archiveSha256.windows}`);
    console.log(`agent-check-mac.zip SHA-256 ${result.archiveSha256.mac}`);
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--app-only') {
      options.appOnly = true;
    } else if (value === '--offline') {
      options.offline = true;
    } else if (value === '--output') {
      options.outputRoot = args[++index];
      if (!options.outputRoot) throw new Error('--output 缺少路径');
    } else if (value === '--runtime-cache') {
      options.runtimeCache = args[++index];
      if (!options.runtimeCache) throw new Error('--runtime-cache 缺少路径');
    } else {
      throw new Error(`未知参数：${value}`);
    }
  }
  return options;
}
