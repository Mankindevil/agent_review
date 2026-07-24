import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readdir,
  rename,
  rm
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cursorAuthConfigHome } from './runtime-environment.js';

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

function lockKey(authRoot) {
  const normalized = path.resolve(authRoot);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function withAuthRootLock(key, signal, action) {
  const release = await acquireAuthRootLock(key, signal);
  try {
    return await action();
  } finally {
    release();
  }
}

function acquireAuthRootLock(key, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  let lock = authLocks.get(key);
  if (!lock) {
    lock = { active: false, queue: [] };
    authLocks.set(key, lock);
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      granted: false,
      onAbort: null,
      reject,
      resolve,
      signal
    };

    waiter.onAbort = () => {
      if (waiter.granted) return;
      const index = lock.queue.indexOf(waiter);
      if (index !== -1) lock.queue.splice(index, 1);
      signal.removeEventListener('abort', waiter.onAbort);
      reject(abortReason(signal));
      if (!lock.active && lock.queue.length === 0) authLocks.delete(key);
    };

    if (!lock.active) {
      grantLock(key, lock, waiter);
      return;
    }

    lock.queue.push(waiter);
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    if (signal?.aborted) waiter.onAbort();
  });
}

function grantLock(key, lock, waiter) {
  lock.active = true;
  waiter.granted = true;
  waiter.onAbort && waiter.signal?.removeEventListener('abort', waiter.onAbort);
  let released = false;
  waiter.resolve(() => {
    if (released) return;
    released = true;
    const next = lock.queue.shift();
    if (next) {
      next.signal?.removeEventListener('abort', next.onAbort);
      grantLock(key, lock, next);
      return;
    }
    lock.active = false;
    authLocks.delete(key);
  });
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

async function ensurePersistentBoundary(authRoot) {
  const realAuthRoot = await ensurePrivateDirectory(authRoot, 'CURSOR_AUTH_CONFIG_HOME');
  const cursorDirectory = path.join(authRoot, CURSOR_DIRECTORY);
  const realCursorDirectory = await ensurePrivateDirectory(
    cursorDirectory,
    'persistent cursor directory'
  );

  if (
    path.dirname(realCursorDirectory) !== realAuthRoot
    || path.basename(realCursorDirectory) !== CURSOR_DIRECTORY
  ) {
    throw new Error('persistent cursor directory must be the direct cursor child of the auth root');
  }

  return {
    authRoot,
    cursorDirectory,
    realAuthRoot,
    realCursorDirectory
  };
}

async function ensurePrivateDirectory(directory, label) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    info = await lstat(directory);
  }

  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  await chmod(directory, 0o700);
  return realpath(directory);
}

async function revalidateBoundary(boundary) {
  const current = await ensurePersistentBoundary(boundary.authRoot);
  if (
    current.realAuthRoot !== boundary.realAuthRoot
    || current.realCursorDirectory !== boundary.realCursorDirectory
  ) {
    throw new Error('persistent cursor boundary changed during the auth session');
  }
  return current;
}

async function prunePersistentCursorState(boundary) {
  const entries = await readdir(boundary.cursorDirectory);

  for (const name of entries) {
    if (ALLOWED_FILES.has(name)) {
      await readValidatedJsonFile(path.join(boundary.cursorDirectory, name), {
        label: `persistent ${name}`
      });
    }
  }

  for (const name of entries) {
    if (!ALLOWED_FILES.has(name)) await removeVerifiedChild(boundary, name);
  }
}

async function removeVerifiedChild(boundary, childName) {
  const child = path.resolve(boundary.realCursorDirectory, childName);
  if (path.dirname(child) !== boundary.realCursorDirectory) {
    throw new Error('refusing to clean a path outside the persistent cursor directory');
  }
  await rm(child, { recursive: true, force: true });
}

async function snapshotAllowedFiles(cursorDirectory, temporaryXdg) {
  const temporaryCursor = path.join(temporaryXdg, CURSOR_DIRECTORY);
  await mkdir(temporaryCursor, { mode: 0o700 });

  for (const name of ALLOWED_FILES) {
    const bytes = await readValidatedJsonFile(path.join(cursorDirectory, name), {
      allowMissing: true,
      label: `persistent ${name}`
    });
    if (bytes === null) continue;
    const destination = path.join(temporaryCursor, name);
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(destination, 0o600);
  }
}

async function runAndWriteBack(run, temporaryXdg, boundary) {
  let result;
  let runtimeError;
  try {
    result = await run(temporaryXdg);
  } catch (error) {
    runtimeError = error;
  }

  let writebackError;
  try {
    await writeBackAllowedFiles(temporaryXdg, boundary);
  } catch (error) {
    writebackError = error;
  }

  if (runtimeError && writebackError) {
    throw new AggregateError(
      [runtimeError, writebackError],
      'Cursor runtime and credential writeback both failed'
    );
  }
  if (runtimeError) throw runtimeError;
  if (writebackError) throw writebackError;
  return result;
}

async function writeBackAllowedFiles(temporaryXdg, boundary) {
  const temporaryCursor = path.join(temporaryXdg, CURSOR_DIRECTORY);
  const updates = new Map();

  for (const name of ALLOWED_FILES) {
    const bytes = await readValidatedJsonFile(path.join(temporaryCursor, name), {
      allowMissing: true,
      label: `temporary ${name}`
    });
    if (bytes !== null) updates.set(name, bytes);
  }

  let current = await revalidateBoundary(boundary);
  for (const name of ALLOWED_FILES) {
    await readValidatedJsonFile(path.join(current.cursorDirectory, name), {
      allowMissing: true,
      label: `persistent ${name}`
    });
  }

  for (const [name, bytes] of updates) {
    await atomicWriteAllowedFile(current, name, bytes);
  }

  current = await revalidateBoundary(boundary);
  await prunePersistentCursorState(current);
}

async function atomicWriteAllowedFile(boundary, name, bytes) {
  const temporaryName = `.${name}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = path.resolve(boundary.realCursorDirectory, temporaryName);
  const destination = path.resolve(boundary.realCursorDirectory, name);
  if (
    path.dirname(temporaryPath) !== boundary.realCursorDirectory
    || path.dirname(destination) !== boundary.realCursorDirectory
    || !ALLOWED_FILES.has(path.basename(destination))
  ) {
    throw new Error('refusing to write outside the persistent cursor directory');
  }

  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, destination);
  } finally {
    await handle?.close();
    await removeVerifiedChild(boundary, temporaryName);
  }
}

async function readValidatedJsonFile(file, { allowMissing = false, label }) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }

  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  if (info.size > MAX_AUTH_FILE_BYTES) {
    throw new Error(`${label} must not exceed 1_048_576 bytes`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(file, constants.O_RDONLY | noFollow);
  let bytes;
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) throw new Error(`${label} must be a regular file`);
    if (openedInfo.size > MAX_AUTH_FILE_BYTES) {
      throw new Error(`${label} must not exceed 1_048_576 bytes`);
    }
    bytes = await handle.readFile();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }

  if (bytes.length > MAX_AUTH_FILE_BYTES) {
    throw new Error(`${label} must not exceed 1_048_576 bytes`);
  }

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} must contain a valid JSON object`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a valid JSON object`);
  }

  return bytes;
}
