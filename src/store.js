import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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

  list() {
    return sortedValues(this.items).map((item) =>
      item.schemaVersion === 2 ? structuredClone(item) : item
    );
  }

  get(id) {
    const item = this.items.get(id);
    return item?.schemaVersion === 2 ? structuredClone(item) : item;
  }

  async set(item) {
    return this.enqueueMutation(async () => {
      const existing = this.items.get(item.id);
      if (existing?.schemaVersion === 2 || (item.schemaVersion === 2 && existing)) {
        throw Object.assign(
          new Error('existing V2 evaluations must be updated with mutate'),
          { statusCode: 409 }
        );
      }
      const committed = item.schemaVersion === 2 ? structuredClone(item) : item;
      const nextItems = new Map(this.items);
      nextItems.set(item.id, committed);
      await this.persistUnlocked(nextItems);
      this.items = nextItems;
      return item.schemaVersion === 2 ? structuredClone(committed) : item;
    });
  }

  async delete(id) {
    return this.enqueueMutation(async () => {
      if (!this.items.has(id)) return false;
      const nextItems = new Map(this.items);
      nextItems.delete(id);
      await this.persistUnlocked(nextItems);
      this.items = nextItems;
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
      assertV2Identity(stored, next);
      next.revision = currentRevision + 1;
      next.updatedAt = new Date().toISOString();
      const committed = structuredClone(next);
      const nextItems = new Map(this.items);
      nextItems.set(id, committed);
      await this.persistUnlocked(nextItems);
      this.items = nextItems;
      return structuredClone(committed);
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

  async persistUnlocked(items = this.items) {
    const snapshot = JSON.stringify({
      schemaVersion: '1.0',
      items: sortedValues(items)
    }, null, 2);
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, snapshot);
    await rename(temporary, this.file);
  }
}

function assertV2Identity(stored, next) {
  if (stored.schemaVersion !== 2) return;
  if (
    next.schemaVersion !== 2 ||
    next.id !== stored.id ||
    next.createdAt !== stored.createdAt ||
    !isDeepStrictEqual(next.submission, stored.submission) ||
    !isDeepStrictEqual(next.participantAccess, stored.participantAccess)
  ) {
    throw new TypeError('V2 mutation must preserve schemaVersion and frozen record identity');
  }
}

function sortedValues(items) {
  return [...items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function readStoredItems(stored) {
  if (Array.isArray(stored)) return stored;
  if (stored?.schemaVersion === '1.0' && Array.isArray(stored.items)) return stored.items;
  throw new TypeError('Stored evaluations must be a bare array or schemaVersion 1.0 wrapper');
}
