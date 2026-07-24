import {
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

const DEFAULT_STALE_MS = 30 * 60 * 1_000;
const OWNER_FILE = /^owner-[a-f0-9-]+\.json$/i;

function lockError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

async function inspectOwner(lockPath, staleMs) {
  try {
    const info = await stat(lockPath);
    if (!info.isDirectory()) return { recoverable: false };
    const files = (await readdir(lockPath)).filter((name) => OWNER_FILE.test(name));
    if (files.length !== 1) return { recoverable: false };
    const file = files[0];
    try {
      const metadata = JSON.parse(await readFile(path.join(lockPath, file), 'utf8'));
      const acquiredAt = Date.parse(
        metadata.acquiredAt || metadata.startedAt || metadata.createdAt || ''
      );
      const lastActivity = Math.max(info.mtimeMs, Number.isFinite(acquiredAt) ? acquiredAt : 0);
      if (Date.now() - lastActivity <= staleMs) return { recoverable: false };
      if (metadata.hostname !== hostname()) return { recoverable: false };
      if (!Number.isSafeInteger(metadata.pid) || metadata.pid < 1) return { recoverable: false };
      try {
        process.kill(metadata.pid, 0);
        return { recoverable: false };
      } catch (error) {
        if (error.code !== 'ESRCH') return { recoverable: false };
      }
      return { recoverable: true, ownerFile: file };
    } catch {
      return { recoverable: false };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { retry: true };
    throw error;
  }
}

async function removeDeadOwner(lockPath, ownerFile) {
  try {
    await unlink(path.join(lockPath, ownerFile));
  } catch (error) {
    if (error.code === 'ENOENT') return 'retry';
    throw error;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rmdir(lockPath);
      return 'removed';
    } catch (error) {
      if (error.code === 'ENOENT') return 'retry';
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      const remaining = await readdir(lockPath).catch((cause) => {
        if (cause.code === 'ENOENT') return null;
        throw cause;
      });
      if (remaining === null) return 'retry';
      if (remaining.length > 0) return 'locked';
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return 'locked';
}

export async function acquireRunLock({ stateDir, reportDate, staleMs = DEFAULT_STALE_MS }) {
  if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required');
  if (!isRealDate(reportDate)) {
    throw new TypeError('reportDate must be a real calendar date in YYYY-MM-DD form');
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
          hostname: hostname(),
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
      const owner = await inspectOwner(lockPath, staleMs);
      if (owner.retry) continue;
      if (!owner.recoverable) {
        throw lockError(`report date is already running: ${reportDate}`, 'RUN_LOCKED');
      }
      const removal = await removeDeadOwner(lockPath, owner.ownerFile);
      if (removal === 'retry' || removal === 'removed') continue;
      throw lockError(`report date is already running: ${reportDate}`, 'RUN_LOCKED');
    }
  }
  throw lockError(`could not acquire report lock: ${reportDate}`, 'RUN_LOCKED');
}
