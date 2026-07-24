import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  opendir,
  readFile,
  lstat,
  rename,
  rmdir,
  unlink
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeTraceValue } from './run-trace.js';

export const TASK_STATES = new Set([
  'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'
]);

const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED'
]);
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_CLEANUP_ENTRY_LIMIT = 64;
const OWNER_FILE_PATTERN = /^owner-([0-9a-f-]+)\.json$/i;
const CANDIDATE_PATTERN =
  /^state\.json\.lock\.candidate-(\d+)-([0-9a-f-]+)$/i;
const TEMP_PATTERN = /^state\.json\.(\d+)\.([0-9a-f-]+)\.tmp$/i;

function clone(value) {
  return structuredClone(value);
}

function storeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError('task must be an object');
  }
  if (typeof task.id !== 'string' || !task.id) throw new TypeError('task.id is required');
  if (task.status !== undefined && (
    !task.status || typeof task.status !== 'object' || Array.isArray(task.status)
  )) {
    throw new TypeError('task.status must be an object');
  }
  const directState = task.state;
  const statusState = task.status?.state;
  if (directState !== undefined && statusState !== undefined && directState !== statusState) {
    throw storeError(
      `task state aliases disagree: ${directState} != ${statusState}`,
      'TASK_STATE_ALIAS_MISMATCH'
    );
  }
  const state = statusState ?? directState;
  if (!TASK_STATES.has(state)) throw new RangeError(`invalid task state: ${state}`);
  return {
    ...task,
    state,
    status: { ...(task.status || {}), state }
  };
}

export class MarketTaskStore {
  constructor(options) {
    const stateDir = typeof options === 'string' ? options : options?.stateDir;
    if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required');
    this.stateDir = path.resolve(stateDir);
    this.stateFile = path.join(this.stateDir, 'state.json');
    this.lockPath = path.join(this.stateDir, 'state.json.lock');
    this.lockTimeoutMs = positiveInteger(
      typeof options === 'object' ? options.lockTimeoutMs : undefined,
      DEFAULT_LOCK_TIMEOUT_MS,
      'lockTimeoutMs'
    );
    this.lockStaleMs = positiveInteger(
      typeof options === 'object' ? options.lockStaleMs : undefined,
      DEFAULT_LOCK_STALE_MS,
      'lockStaleMs'
    );
    this.lockRetryMs = positiveInteger(
      typeof options === 'object' ? options.lockRetryMs : undefined,
      DEFAULT_LOCK_RETRY_MS,
      'lockRetryMs'
    );
    this.cleanupEntryLimit = positiveInteger(
      typeof options === 'object' ? options.cleanupEntryLimit : undefined,
      DEFAULT_CLEANUP_ENTRY_LIMIT,
      'cleanupEntryLimit'
    );
    this.lockHooks = typeof options === 'object' && options.lockHooks
      ? options.lockHooks
      : {};
    if (!this.lockHooks || typeof this.lockHooks !== 'object') {
      throw new TypeError('lockHooks must be an object');
    }
    this.state = { schemaVersion: '1.0', tasks: [] };
    this.loaded = false;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await this.writeQueue;
    await this.#loadFromDisk(true);
    return this.state.tasks.map(clone);
  }

  async create(task) {
    return this.#enqueue(async () => {
      const lock = await this.#acquireLock();
      try {
        await this.#loadFromDisk(true);
        const now = new Date().toISOString();
        const record = normalizeTask(sanitizeTraceValue({
          ...clone(task),
          createdAt: task.createdAt || now,
          lastModified: task.lastModified || now
        }));
        if (this.state.tasks.some((item) => item.id === record.id)) {
          throw storeError(`task already exists: ${record.id}`, 'TASK_EXISTS');
        }
        const nextState = {
          ...this.state,
          tasks: [...this.state.tasks, record]
        };
        await this.#persist(nextState);
        this.state = nextState;
        return clone(record);
      } finally {
        await lock.release();
      }
    });
  }

  async get(id) {
    await this.writeQueue;
    await this.#loadFromDisk(true);
    const task = this.state.tasks.find((item) => item.id === id);
    return task ? clone(task) : null;
  }

  async list({ owner, ownerScope } = {}) {
    await this.writeQueue;
    await this.#loadFromDisk(true);
    const safeOwner = owner === undefined ? undefined : sanitizeTraceValue(owner);
    const safeOwnerScope = ownerScope === undefined
      ? undefined
      : sanitizeTraceValue(ownerScope);
    return this.state.tasks
      .filter((task) =>
        (safeOwner === undefined || task.owner === safeOwner)
        && (safeOwnerScope === undefined || task.ownerScope === safeOwnerScope)
      )
      .map(clone);
  }

  async update(id, updater) {
    if (typeof updater !== 'function') throw new TypeError('updater must be a function');
    return this.#enqueue(async () => {
      const lock = await this.#acquireLock();
      try {
        await this.#loadFromDisk(true);
        const index = this.state.tasks.findIndex((item) => item.id === id);
        if (index < 0) throw storeError(`task not found: ${id}`, 'TASK_NOT_FOUND');
        const current = clone(this.state.tasks[index]);
        const draft = clone(current);
        const changed = await updater(draft);
        const candidate = normalizeTask(sanitizeTraceValue(changed === undefined ? draft : changed));
        if (candidate.id !== id) throw storeError('task id cannot change', 'TASK_ID_IMMUTABLE');
        const previousState = current.state;
        const nextState = candidate.state;
        if (TERMINAL_STATES.has(previousState) && nextState !== previousState) {
          throw storeError(
            `invalid task transition: ${previousState} -> ${nextState}`,
            'INVALID_TASK_TRANSITION'
          );
        }
        candidate.createdAt = current.createdAt;
        candidate.lastModified = new Date().toISOString();
        const tasks = [...this.state.tasks];
        tasks[index] = candidate;
        const stagedState = { ...this.state, tasks };
        await this.#persist(stagedState);
        this.state = stagedState;
        return clone(candidate);
      } finally {
        await lock.release();
      }
    });
  }

  async findByMessageId(owner, messageId) {
    await this.writeQueue;
    await this.#loadFromDisk(true);
    const safeOwner = sanitizeTraceValue(owner);
    const task = this.state.tasks.find(
      (item) => item.owner === safeOwner && item.messageId === messageId
    );
    return task ? clone(task) : null;
  }

  #enqueue(operation) {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  async #loadFromDisk(force = false) {
    if (this.loaded && !force) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        let parsed;
        try {
          parsed = JSON.parse(await readFile(this.stateFile, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          parsed = { schemaVersion: '1.0', tasks: [] };
        }
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
          throw storeError('invalid market task state file', 'INVALID_STATE_FILE');
        }
        const tasks = parsed.tasks.map((task) => normalizeTask(sanitizeTraceValue(task)));
        this.state = {
          schemaVersion: String(parsed.schemaVersion || '1.0'),
          tasks
        };
        this.loaded = true;
      })().finally(() => {
        this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  async #acquireLock() {
    await mkdir(this.stateDir, { recursive: true });
    await this.#cleanupStaleCandidates();
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      const token = randomUUID();
      const ownerName = `owner-${token}.json`;
      const candidatePath = path.join(
        this.stateDir,
        `state.json.lock.candidate-${process.pid}-${token}`
      );
      const candidateOwnerPath = path.join(candidatePath, ownerName);
      const ownerPath = path.join(this.lockPath, ownerName);
      let ownerHandle;
      let published = false;
      let publicationAttempted = false;
      try {
        await mkdir(candidatePath);
        await this.lockHooks.afterCandidateCreated?.({
          candidatePath,
          lockPath: this.lockPath
        });
        ownerHandle = await open(candidateOwnerPath, 'wx', 0o600);
        await ownerHandle.writeFile(`${JSON.stringify({
          schemaVersion: '1.0',
          pid: process.pid,
          hostname: os.hostname(),
          token,
          acquiredAt: new Date().toISOString()
        })}\n`, 'utf8');
        await ownerHandle.sync();
        await ownerHandle.close();
        ownerHandle = null;
        await this.#syncDirectory(candidatePath);
        await this.lockHooks.afterOwnerSynced?.({
          candidatePath,
          lockPath: this.lockPath
        });
        try {
          await lstat(this.lockPath);
          const conflict = storeError('market task state lock exists', 'STORE_LOCK_EXISTS');
          throw conflict;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        publicationAttempted = true;
        await rename(candidatePath, this.lockPath);
        published = true;
        await this.#syncDirectory(this.stateDir);
        await this.#cleanupStaleTemps().catch(() => undefined);
        return {
          release: () => this.#releaseOwnedLock(ownerPath)
        };
      } catch (error) {
        await ownerHandle?.close().catch(() => undefined);
        if (published) {
          await this.#releaseOwnedLock(ownerPath);
          throw error;
        }
        await this.#removeOwnCandidate(candidatePath, candidateOwnerPath);
        const canonicalExists = await lstat(this.lockPath)
          .then(() => true, (cause) => {
            if (cause?.code === 'ENOENT') return false;
            throw cause;
          });
        const publicationConflict = publicationAttempted
          && ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error?.code);
        if (
          !canonicalExists
          && error?.code !== 'STORE_LOCK_EXISTS'
          && !publicationConflict
        ) {
          throw error;
        }
      }
      await this.#recoverStaleLock();
      await this.#cleanupStaleCandidates();
      if (Date.now() >= deadline) {
        throw storeError('timed out acquiring market task state lock', 'STORE_LOCK_TIMEOUT');
      }
      await wait(Math.min(this.lockRetryMs, Math.max(1, deadline - Date.now())));
    }
  }

  async #recoverStaleLock() {
    let lockStat;
    let files;
    try {
      [lockStat, files] = await Promise.all([
        lstat(this.lockPath),
        this.#boundedDirectoryEntries(this.lockPath, 2)
      ]);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      return false;
    }
    if (!lockStat.isDirectory() || Date.now() - lockStat.mtimeMs < this.lockStaleMs) {
      return false;
    }
    if (files.length === 0) {
      try {
        await rmdir(this.lockPath);
        return true;
      } catch {
        return false;
      }
    }
    const owners = files.filter((name) => OWNER_FILE_PATTERN.test(name));
    if (files.length !== 1 || owners.length !== 1) return false;
    const ownerPath = path.join(this.lockPath, owners[0]);
    let owner;
    try {
      owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    } catch {
      return false;
    }
    const acquiredAt = Date.parse(owner?.acquiredAt);
    if (
      owner?.hostname !== os.hostname()
      || !Number.isSafeInteger(owner?.pid)
      || !Number.isFinite(acquiredAt)
      || Date.now() - acquiredAt < this.lockStaleMs
      || !processIsDead(owner.pid)
    ) {
      return false;
    }
    const expectedName = `owner-${owner.token}.json`;
    if (expectedName !== owners[0]) return false;
    try {
      await unlink(ownerPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
    await rmdir(this.lockPath).catch(() => undefined);
    return true;
  }

  async #releaseOwnedLock(ownerPath) {
    let removed = false;
    try {
      await unlink(ownerPath);
      removed = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (removed) {
      await rmdir(this.lockPath).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
      });
    }
  }

  async #removeOwnCandidate(candidatePath, ownerPath) {
    await unlink(ownerPath).catch(() => undefined);
    await rmdir(candidatePath).catch(() => undefined);
  }

  async #boundedDirectoryEntries(directory, limit = this.cleanupEntryLimit) {
    const entries = [];
    let handle;
    try {
      handle = await opendir(directory);
      for await (const entry of handle) {
        entries.push(entry.name);
        if (entries.length >= limit) break;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return entries;
  }

  async #cleanupStaleCandidates() {
    let entries;
    try {
      entries = await this.#boundedDirectoryEntries(this.stateDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const match = name.match(CANDIDATE_PATTERN);
      if (!match) continue;
      const candidatePath = path.join(this.stateDir, name);
      let candidateStat;
      try {
        candidateStat = await lstat(candidatePath);
      } catch {
        continue;
      }
      const pid = Number(match[1]);
      const token = match[2];
      if (
        !candidateStat.isDirectory()
        || Date.now() - candidateStat.mtimeMs < this.lockStaleMs
        || !Number.isSafeInteger(pid)
        || !processIsDead(pid)
      ) {
        continue;
      }
      let files;
      try {
        files = await this.#boundedDirectoryEntries(candidatePath, 2);
      } catch {
        continue;
      }
      if (files.length === 0) {
        await rmdir(candidatePath).catch(() => undefined);
        continue;
      }
      const ownerName = `owner-${token}.json`;
      if (files.length === 1 && files[0] === ownerName) {
        await unlink(path.join(candidatePath, ownerName)).catch(() => undefined);
        await rmdir(candidatePath).catch(() => undefined);
      }
    }
  }

  async #cleanupStaleTemps() {
    const entries = await this.#boundedDirectoryEntries(this.stateDir);
    for (const name of entries) {
      const match = name.match(TEMP_PATTERN);
      if (!match) continue;
      const file = path.join(this.stateDir, name);
      let fileStat;
      try {
        fileStat = await lstat(file);
      } catch {
        continue;
      }
      const pid = Number(match[1]);
      if (
        fileStat.isFile()
        && Date.now() - fileStat.mtimeMs >= this.lockStaleMs
        && Number.isSafeInteger(pid)
        && processIsDead(pid)
      ) {
        await unlink(file).catch(() => undefined);
      }
    }
  }

  async #syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #persist(state) {
    await mkdir(this.stateDir, { recursive: true });
    const tempFile = path.join(
      this.stateDir,
      `state.json.${process.pid}.${randomUUID()}.tmp`
    );
    let handle;
    try {
      handle = await open(tempFile, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempFile, this.stateFile);
      await this.#syncDirectory(this.stateDir);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(tempFile).catch(() => undefined);
      throw error;
    }
  }
}
