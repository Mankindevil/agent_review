import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class EvaluationStore {
  constructor(file = path.resolve('data/evaluations.json')) {
    this.file = file;
    this.items = new Map();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const values = JSON.parse(await readFile(this.file, 'utf8'));
      values.forEach((item) => this.items.set(item.id, item));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('无法读取历史评测：', error.message);
    }
  }

  list() { return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { return this.items.get(id); }

  async set(item) {
    this.items.set(item.id, item);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.list(), null, 2));
    });
    await this.writeQueue;
    return item;
  }
}
