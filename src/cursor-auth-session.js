import { constants } from 'node:fs';
import {
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
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const IS_LINUX = process.platform === 'linux';
const CAN_OPEN_DIRECTORY = process.platform !== 'win32';
const AUTH_SESSION_ERRORS = Symbol('cursorAuthSessionErrors');
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
    let boundary;
    let temporary;
    let result;
    const errors = [];

    try {
      boundary = await ensurePersistentBoundary(authRoot);
      await prunePersistentCursorState(boundary);
      temporary = await createTemporaryBoundary(workspace);
      await snapshotAllowedFiles(boundary, temporary);
      result = await runAndWriteBack(run, temporary, boundary);
    } catch (error) {
      appendSessionErrors(errors, error);
    }

    if (temporary) {
      try {
        await cleanupTemporaryBoundary(temporary);
      } catch (error) {
        appendSessionErrors(errors, error);
      }
    }
    if (boundary) {
      try {
        await closePersistentBoundary(boundary);
      } catch (error) {
        appendSessionErrors(errors, error);
      }
    }

    throwSessionErrors(errors, 'Cursor auth session lifecycle failed');
    return result;
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
  waiter.signal?.removeEventListener('abort', waiter.onAbort);
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
  let authDirectory;
  let cursorDirectory;
  try {
    await ensureDirectoryExists(authRoot, 'CURSOR_AUTH_CONFIG_HOME');
    authDirectory = await openDirectoryAnchor(
      authRoot,
      authRoot,
      'CURSOR_AUTH_CONFIG_HOME'
    );

    const cursorAccessPath = directoryChild(authDirectory, CURSOR_DIRECTORY);
    const cursorVisiblePath = path.join(authRoot, CURSOR_DIRECTORY);
    await ensureDirectoryExists(cursorAccessPath, 'persistent cursor directory');
    cursorDirectory = await openDirectoryAnchor(
      cursorAccessPath,
      cursorVisiblePath,
      'persistent cursor directory'
    );

    if (
      path.dirname(cursorDirectory.realDirectory) !== authDirectory.realDirectory
      || path.basename(cursorDirectory.realDirectory) !== CURSOR_DIRECTORY
    ) {
      throw new Error(
        'persistent cursor directory must be the direct cursor child of the auth root'
      );
    }

    return {
      authRoot,
      authDirectory,
      cursorDirectory
    };
  } catch (error) {
    await closeAnchors([cursorDirectory, authDirectory], error);
  }
}

async function createTemporaryBoundary(workspace) {
  const temporaryXdg = await mkdtemp(path.join(workspace, '.cursor-xdg-'));
  let rootDirectory;
  let cursorDirectory;
  try {
    rootDirectory = await openDirectoryAnchor(
      temporaryXdg,
      temporaryXdg,
      'temporary XDG directory'
    );
    const cursorAccessPath = directoryChild(rootDirectory, CURSOR_DIRECTORY);
    const cursorVisiblePath = path.join(temporaryXdg, CURSOR_DIRECTORY);
    await mkdir(cursorAccessPath, { mode: DIRECTORY_MODE });
    cursorDirectory = await openDirectoryAnchor(
      cursorAccessPath,
      cursorVisiblePath,
      'temporary cursor directory'
    );

    if (
      path.dirname(cursorDirectory.realDirectory) !== rootDirectory.realDirectory
      || path.basename(cursorDirectory.realDirectory) !== CURSOR_DIRECTORY
    ) {
      throw new Error(
        'temporary cursor directory must be the direct cursor child of the temporary XDG directory'
      );
    }

    return {
      temporaryXdg,
      rootDirectory,
      cursorDirectory
    };
  } catch (error) {
    const errors = [];
    appendSessionErrors(errors, error);
    for (const anchor of [cursorDirectory, rootDirectory]) {
      try {
        await closeDirectoryAnchor(anchor);
      } catch (closeError) {
        appendSessionErrors(errors, closeError);
      }
    }
    try {
      await rm(temporaryXdg, { recursive: true, force: true });
    } catch (cleanupError) {
      appendSessionErrors(errors, cleanupError);
    }
    throwSessionErrors(errors, 'Temporary Cursor boundary creation failed');
  }
}

async function ensureDirectoryExists(directory, label) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    info = await lstat(directory);
  }
  validateDirectoryInfo(info, label);
}

async function openDirectoryAnchor(openPath, visiblePath, label) {
  const initialInfo = await lstat(openPath);
  validateDirectoryInfo(initialInfo, label);

  if (CAN_OPEN_DIRECTORY) {
    let handle;
    try {
      const flags = constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0);
      handle = await open(openPath, flags);
      const openedInfo = await handle.stat();
      validateDirectoryInfo(openedInfo, label);
      if (!sameIdentity(fileIdentity(initialInfo), fileIdentity(openedInfo))) {
        throw new Error(`${label} changed while it was being verified`);
      }
      await handle.chmod(DIRECTORY_MODE);
      const accessPath = IS_LINUX
        ? `/proc/self/fd/${handle.fd}`
        : await realpath(openPath);
      return {
        accessPath,
        handle,
        identity: fileIdentity(openedInfo),
        label,
        realDirectory: await realpath(accessPath),
        visiblePath
      };
    } catch (error) {
      await handle?.close();
      throw error;
    }
  }

  const finalInfo = await lstat(openPath);
  validateDirectoryInfo(finalInfo, label);
  if (!sameIdentity(fileIdentity(initialInfo), fileIdentity(finalInfo))) {
    throw new Error(`${label} changed while it was being verified`);
  }
  const realDirectory = await realpath(openPath);
  return {
    accessPath: realDirectory,
    handle: null,
    identity: fileIdentity(finalInfo),
    label,
    realDirectory,
    visiblePath
  };
}

function validateDirectoryInfo(info, label) {
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
}

function fileIdentity(info) {
  return {
    dev: info.dev,
    ino: info.ino
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function revalidateDirectoryAnchor(anchor) {
  let visibleInfo;
  try {
    visibleInfo = await lstat(anchor.visiblePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${anchor.label} changed during the auth session`);
    }
    throw error;
  }
  validateDirectoryInfo(visibleInfo, anchor.label);
  if (!sameIdentity(anchor.identity, fileIdentity(visibleInfo))) {
    throw new Error(`${anchor.label} changed during the auth session`);
  }

  if (anchor.handle) {
    const openedInfo = await anchor.handle.stat();
    validateDirectoryInfo(openedInfo, anchor.label);
    if (!sameIdentity(anchor.identity, fileIdentity(openedInfo))) {
      throw new Error(`${anchor.label} changed during the auth session`);
    }
    await anchor.handle.chmod(DIRECTORY_MODE);
    return;
  }

  if (await realpath(anchor.visiblePath) !== anchor.realDirectory) {
    throw new Error(`${anchor.label} changed during the auth session`);
  }
}

async function revalidatePersistentBoundary(boundary) {
  await revalidateDirectoryAnchor(boundary.authDirectory);
  await revalidateDirectoryAnchor(boundary.cursorDirectory);
}

async function revalidateTemporaryBoundary(temporary) {
  await revalidateDirectoryAnchor(temporary.rootDirectory);
  await revalidateDirectoryAnchor(temporary.cursorDirectory);
}

function directoryChild(directory, childName) {
  if (
    typeof childName !== 'string'
    || !childName
    || path.basename(childName) !== childName
    || childName === '.'
    || childName === '..'
  ) {
    throw new Error('refusing to resolve a non-child directory entry');
  }
  const child = path.resolve(directory.accessPath, childName);
  if (path.dirname(child) !== directory.accessPath) {
    throw new Error(`refusing to access a path outside ${directory.label}`);
  }
  return child;
}

async function prunePersistentCursorState(boundary) {
  const entries = await readdir(boundary.cursorDirectory.accessPath);

  for (const name of entries) {
    if (ALLOWED_FILES.has(name)) {
      await readValidatedJsonFile(directoryChild(boundary.cursorDirectory, name), {
        label: `persistent ${name}`
      });
    }
  }

  for (const name of entries) {
    if (!ALLOWED_FILES.has(name)) {
      await removeDirectoryChild(boundary.cursorDirectory, name);
    }
  }
}

async function removeDirectoryChild(directory, childName) {
  await rm(directoryChild(directory, childName), { recursive: true, force: true });
}

async function snapshotAllowedFiles(boundary, temporary) {
  for (const name of ALLOWED_FILES) {
    const bytes = await readValidatedJsonFile(
      directoryChild(boundary.cursorDirectory, name),
      {
        allowMissing: true,
        label: `persistent ${name}`
      }
    );
    if (bytes === null) continue;
    await writeNewFile(directoryChild(temporary.cursorDirectory, name), bytes);
  }
}

async function writeNewFile(destination, bytes) {
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    FILE_MODE
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runAndWriteBack(run, temporary, boundary) {
  let result;
  const errors = [];
  try {
    result = await run(temporary.temporaryXdg);
  } catch (error) {
    appendSessionErrors(errors, error);
  }

  try {
    await writeBackAllowedFiles(temporary, boundary);
  } catch (error) {
    appendSessionErrors(errors, error);
  }

  throwSessionErrors(errors, 'Cursor runtime and credential writeback both failed');
  return result;
}

async function writeBackAllowedFiles(temporary, boundary) {
  await revalidateTemporaryBoundary(temporary);
  const updates = new Map();

  for (const name of ALLOWED_FILES) {
    const bytes = await readValidatedJsonFile(
      directoryChild(temporary.cursorDirectory, name),
      {
        allowMissing: true,
        label: `temporary ${name}`
      }
    );
    if (bytes !== null) updates.set(name, bytes);
  }

  await revalidatePersistentBoundary(boundary);
  for (const name of ALLOWED_FILES) {
    await readValidatedJsonFile(directoryChild(boundary.cursorDirectory, name), {
      allowMissing: true,
      label: `persistent ${name}`
    });
  }

  for (const [name, bytes] of updates) {
    await atomicWriteAllowedFile(boundary.cursorDirectory, name, bytes);
  }

  await revalidatePersistentBoundary(boundary);
  await prunePersistentCursorState(boundary);
}

async function atomicWriteAllowedFile(cursorDirectory, name, bytes) {
  const temporaryName = `.${name}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = directoryChild(cursorDirectory, temporaryName);
  const destination = directoryChild(cursorDirectory, name);
  if (!ALLOWED_FILES.has(name)) {
    throw new Error('refusing to write a nonallowlisted persistent file');
  }

  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      FILE_MODE
    );
    await handle.writeFile(bytes);
    await handle.chmod(FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, destination);
  } finally {
    await handle?.close();
    await removeDirectoryChild(cursorDirectory, temporaryName);
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
    bytes = await readBounded(handle);
    await handle.chmod(FILE_MODE);
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

async function readBounded(handle) {
  const capacity = MAX_AUTH_FILE_BYTES + 1;
  const buffer = Buffer.allocUnsafe(capacity);
  let total = 0;
  while (total < capacity) {
    const { bytesRead } = await handle.read(buffer, total, capacity - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

async function cleanupTemporaryBoundary(temporary) {
  const errors = [];

  try {
    await clearDirectory(temporary.cursorDirectory);
  } catch (error) {
    appendSessionErrors(errors, error);
  }
  try {
    await closeDirectoryAnchor(temporary.cursorDirectory);
  } catch (error) {
    appendSessionErrors(errors, error);
  }
  try {
    await clearDirectory(temporary.rootDirectory);
  } catch (error) {
    appendSessionErrors(errors, error);
  }
  try {
    await closeDirectoryAnchor(temporary.rootDirectory);
  } catch (error) {
    appendSessionErrors(errors, error);
  }
  try {
    await rm(temporary.temporaryXdg, { recursive: true, force: true });
  } catch (error) {
    appendSessionErrors(errors, error);
  }

  throwSessionErrors(errors, 'Temporary Cursor credential cleanup failed');
}

async function clearDirectory(directory) {
  const entries = await readdir(directory.accessPath);
  for (const name of entries) await removeDirectoryChild(directory, name);
}

async function closePersistentBoundary(boundary) {
  await closeAnchors(
    [boundary.cursorDirectory, boundary.authDirectory],
    null,
    'Persistent Cursor directory-handle cleanup failed'
  );
}

async function closeAnchors(anchors, originalError, message = 'Directory-handle cleanup failed') {
  const errors = [];
  if (originalError) appendSessionErrors(errors, originalError);
  for (const anchor of anchors) {
    try {
      await closeDirectoryAnchor(anchor);
    } catch (error) {
      appendSessionErrors(errors, error);
    }
  }
  throwSessionErrors(errors, message);
}

async function closeDirectoryAnchor(anchor) {
  if (!anchor?.handle) return;
  const handle = anchor.handle;
  anchor.handle = null;
  await handle.close();
}

function appendSessionErrors(errors, error) {
  if (error instanceof AggregateError && error[AUTH_SESSION_ERRORS]) {
    errors.push(...error.errors);
  } else {
    errors.push(error);
  }
}

function throwSessionErrors(errors, message) {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  const aggregate = new AggregateError(errors, message);
  aggregate[AUTH_SESSION_ERRORS] = true;
  throw aggregate;
}
