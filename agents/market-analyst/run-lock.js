import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DEFAULT_STALE_MS = 30 * 60 * 1_000;
const OWNER_FILE = /^owner-[a-f0-9-]+\.json$/i;

function lockError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function acquisitionTimes(lockPath, info) {
  const files = info.isDirectory()
    ? (await readdir(lockPath)).filter((name) => OWNER_FILE.test(name)).slice(0, 10)
    : [null];
  const times = [];
  for (const file of files) {
    try {
      const metadata = JSON.parse(await readFile(file ? path.join(lockPath, file) : lockPath, 'utf8'));
      const acquiredAt = Date.parse(
        metadata.acquiredAt || metadata.startedAt || metadata.createdAt || ''
      );
      if (Number.isFinite(acquiredAt)) times.push(acquiredAt);
    } catch {
      // A partially written owner record is governed by the lock path mtime.
    }
  }
  return times;
}

async function lockIsStale(lockPath, staleMs) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > staleMs) return true;
    const times = await acquisitionTimes(lockPath, info);
    return times.length > 0 && Math.max(...times) < Date.now() - staleMs;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function acquireRunLock({ stateDir, reportDate, staleMs = DEFAULT_STALE_MS }) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new TypeError('reportDate must be YYYY-MM-DD');
  }
  if (!Number.isSafeInteger(staleMs) || staleMs < 1) {
    throw new RangeError('staleMs must be a positive integer');
  }

  const lockDirectory = path.resolve(stateDir, 'locks');
  const lockPath = path.join(lockDirectory, `${reportDate}.lock`);
  const token = randomUUID();
  const ownerPath = path.join(lockPath, `owner-${token}.json`);
  await mkdir(lockDirectory, { recursive: true });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(lockPath);
      let handle;
      try {
        handle = await open(ownerPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({
          schemaVersion: '1.0',
          reportDate,
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString()
        }), 'utf8');
        await handle.sync();
      } catch (error) {
        await unlink(ownerPath).catch(() => undefined);
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            await unlink(ownerPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          try {
            await rmdir(lockPath);
          } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
          }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await lockIsStale(lockPath, staleMs))) {
        throw lockError(`report date is already running: ${reportDate}`, 'RUN_LOCKED');
      }
      const stalePath = path.join(
        lockDirectory,
        `${reportDate}.lock.stale-${process.pid}-${randomUUID()}`
      );
      try {
        await rename(lockPath, stalePath);
        await rm(stalePath, { recursive: true, force: true });
      } catch (recoveryError) {
        if (recoveryError.code !== 'ENOENT') {
          throw lockError(`report date is already running: ${reportDate}`, 'RUN_LOCKED');
        }
      }
    }
  }
  throw lockError(`could not acquire report lock: ${reportDate}`, 'RUN_LOCKED');
}
