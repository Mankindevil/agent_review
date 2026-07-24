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

function taskState(task) {
  return task?.status?.state ?? task?.state;
}

function storeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new TypeError('task must be an object');
  }
  if (typeof task.id !== 'string' || !task.id) throw new TypeError('task.id is required');
  const state = taskState(task);
  if (!TASK_STATES.has(state)) throw new RangeError(`invalid task state: ${state}`);
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
      const record = sanitizeTraceValue({
        ...clone(task),
        createdAt: task.createdAt || now,
        lastModified: task.lastModified || now
      });
      validateTask(record);
      if (this.state.tasks.some((item) => item.id === record.id)) {
        throw storeError(`task already exists: ${record.id}`, 'TASK_EXISTS');
      }
      this.state.tasks.push(record);
      await this.#persist();
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
      const candidate = sanitizeTraceValue(changed === undefined ? draft : changed);
      validateTask(candidate);
      if (candidate.id !== id) throw storeError('task id cannot change', 'TASK_ID_IMMUTABLE');
      const previousState = taskState(current);
      const nextState = taskState(candidate);
      if (TERMINAL_STATES.has(previousState) && nextState !== previousState) {
        throw storeError(
          `invalid task transition: ${previousState} -> ${nextState}`,
          'INVALID_TASK_TRANSITION'
        );
      }
      candidate.createdAt = current.createdAt;
      candidate.lastModified = new Date().toISOString();
      this.state.tasks[index] = candidate;
      await this.#persist();
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
        for (const task of parsed.tasks) validateTask(task);
        this.state = {
          schemaVersion: String(parsed.schemaVersion || '1.0'),
          tasks: parsed.tasks.map((task) => sanitizeTraceValue(task))
        };
        this.loaded = true;
      })().finally(() => {
        this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  async #persist() {
    await mkdir(this.stateDir, { recursive: true });
    const handle = await open(this.tempFile, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.tempFile, this.stateFile);
  }
}
