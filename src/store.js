import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateStoredEvaluation } from './evaluation-model.js';

export class EvaluationStore {
  constructor(file = path.resolve('data/evaluations.json')) {
    this.file = file;
    this.items = new Map();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'));
      const values = migrateStoredEvaluation(readStoredItems(stored));
      this.items.clear();
      values.forEach((item) => this.items.set(item.id, item));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('无法读取历史评测：', error.message);
    }
  }

  list() { return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { return this.items.get(id); }

  async set(item) {
    return this.enqueueMutation(async () => {
      this.items.set(item.id, item);
      await this.persistUnlocked();
      return item;
    });
  }

  async delete(id) {
    return this.enqueueMutation(async () => {
      const deleted = this.items.delete(id);
      if (!deleted) return false;
      await this.persistUnlocked();
      return true;
    });
  }

  async mutate(id, expectedRevision, updater) {
    return this.enqueueMutation(async () => {
      const stored = this.items.get(id);
      const current = stored === undefined ? undefined : structuredClone(stored);
      if (!current) return null;
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw Object.assign(new Error('revision conflict'), { statusCode: 409 });
      }
      const currentRevision = current.revision || 0;
      const next = await updater(current);
      if (!next || typeof next !== 'object' || Array.isArray(next) || next.id !== id) {
        throw new TypeError('mutation updater must return the same evaluation record');
      }
      next.revision = currentRevision + 1;
      next.updatedAt = new Date().toISOString();
      this.items.set(id, next);
      await this.persistUnlocked();
      return structuredClone(next);
    });
  }

  async persist() {
    return this.enqueueMutation(() => this.persistUnlocked());
  }

  enqueueMutation(operation) {
    const queued = this.writeQueue.catch(() => undefined).then(operation);
    this.writeQueue = queued;
    return queued;
  }

  async persistUnlocked() {
    const snapshot = JSON.stringify({
      schemaVersion: '1.0',
      items: this.list()
    }, null, 2);
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, snapshot);
    await rename(temporary, this.file);
  }
}

function readStoredItems(stored) {
  if (Array.isArray(stored)) return stored;
  if (stored?.schemaVersion === '1.0' && Array.isArray(stored.items)) return stored.items;
  throw new TypeError('Stored evaluations must be a bare array or schemaVersion 1.0 wrapper');
}
