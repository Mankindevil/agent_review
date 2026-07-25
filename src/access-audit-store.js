import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EVENT_FIELDS = ['principalId', 'evaluationId', 'evidenceId', 'role', 'content'];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const ROLES = new Set(['participant', 'judge', 'admin']);

let accessAuditStoreSingleton = null;

export function getAccessAuditStore(env = process.env) {
  if (!accessAuditStoreSingleton) {
    accessAuditStoreSingleton = new AccessAuditStore({
      root: env.ACCESS_AUDIT_ROOT || path.resolve('data/access-audit')
    });
  }
  return accessAuditStoreSingleton;
}

export class AccessAuditStore {
  constructor({ root = path.resolve('data/access-audit'), now = () => new Date().toISOString() } = {}) {
    this.root = path.resolve(root);
    this.now = now;
    this.tails = new Map();
    this.writeChain = Promise.resolve();
  }

  async append(event) {
    const write = this.writeChain.then(() => this.appendNow(event));
    this.writeChain = write.catch(() => {});
    return write;
  }

  async appendNow(event) {
    const canonical = canonicalEvent(event, this.now());
    const file = this.fileFor(canonical.at);
    const previousEventHash = await this.previousHash(file);
    const stored = {
      ...canonical,
      previousEventHash,
      eventHash: sha256(JSON.stringify({ ...canonical, previousEventHash }))
    };
    await mkdir(this.root, { recursive: true });
    await writeFile(file, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', flag: 'a' });
    this.tails.set(file, stored.eventHash);
    return stored;
  }

  fileFor(at) {
    return path.join(this.root, `${at.slice(0, 10)}.ndjson`);
  }

  async previousHash(file) {
    if (this.tails.has(file)) return this.tails.get(file);
    try {
      const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      const last = JSON.parse(lines.at(-1));
      if (!/^[a-f0-9]{64}$/u.test(last.eventHash || '')) {
        throw new Error('access audit log hash chain is invalid');
      }
      this.tails.set(file, last.eventHash);
      return last.eventHash;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
}

function canonicalEvent(event, at) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('access audit event must be an object');
  }
  for (const key of Object.keys(event)) {
    if (!EVENT_FIELDS.includes(key)) throw new TypeError(`unsupported access audit field: ${key}`);
  }
  for (const field of EVENT_FIELDS.slice(0, 3)) {
    if (typeof event[field] !== 'string' || !SAFE_ID.test(event[field])) {
      throw new TypeError(`access audit ${field} is required`);
    }
  }
  if (!ROLES.has(event.role)) throw new TypeError('access audit role is invalid');
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('access audit time is invalid');
  }
  return {
    eventId: `access_${randomUUID()}`,
    type: 'evidence-viewed',
    principalId: event.principalId,
    evaluationId: event.evaluationId,
    evidenceId: event.evidenceId,
    role: event.role,
    at
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
