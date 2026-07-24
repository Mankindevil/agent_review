import { mkdir, open, readFile, rename } from 'node:fs/promises';
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

function clone(value) {
  return structuredClone(value);
}

function storeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
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
    this.tempFile = path.join(this.stateDir, 'state.json.tmp');
    this.state = { schemaVersion: '1.0', tasks: [] };
    this.loaded = false;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await this.writeQueue;
    await this.#loadFromDisk(true);
    return this.list();
  }

  async create(task) {
    return this.#enqueue(async () => {
      await this.#loadFromDisk();
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
    });
  }

  async get(id) {
    await this.writeQueue;
    await this.#loadFromDisk();
    const task = this.state.tasks.find((item) => item.id === id);
    return task ? clone(task) : null;
  }

  async list({ owner } = {}) {
    await this.writeQueue;
    await this.#loadFromDisk();
    const safeOwner = owner === undefined ? undefined : sanitizeTraceValue(owner);
    return this.state.tasks
      .filter((task) => safeOwner === undefined || task.owner === safeOwner)
      .map(clone);
  }

  async update(id, updater) {
    if (typeof updater !== 'function') throw new TypeError('updater must be a function');
    return this.#enqueue(async () => {
      await this.#loadFromDisk();
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
    });
  }

  async findByMessageId(owner, messageId) {
    await this.writeQueue;
    await this.#loadFromDisk();
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

  async #persist(state) {
    await mkdir(this.stateDir, { recursive: true });
    const handle = await open(this.tempFile, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.tempFile, this.stateFile);
  }
}
