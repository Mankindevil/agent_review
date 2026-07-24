import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEvidenceRecord, hashEvidencePayload } from './evidence.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export class EvidenceVault {
  constructor({
    root = path.resolve('data/evidence'),
    evaluationId,
    key = process.env.EVIDENCE_ENCRYPTION_KEY
  } = {}) {
    assertSafeId(evaluationId, 'evaluationId');
    this.root = path.resolve(root);
    this.evaluationId = evaluationId;
    this.key = decodeKey(key);
    this.directory = path.resolve(this.root, evaluationId);
    assertContained(this.root, this.directory);
  }

  async put(record) {
    assertSafeId(record?.evidenceId, 'evidenceId');
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('record must be an evidence object');
    }
    const calculatedHash = hashEvidencePayload(record.payload);
    if (record.payloadHash !== calculatedHash) throw new Error('evidence payload hash mismatch');

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(record.evidenceId));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(record), 'utf8'),
      cipher.final()
    ]);
    const envelope = {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: encrypted.toString('base64'),
      payloadHash: record.payloadHash
    };

    await mkdir(this.directory, { recursive: true });
    await writeFile(this.fileFor(record.evidenceId), JSON.stringify(envelope), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    return record;
  }

  async get(evidenceId) {
    assertSafeId(evidenceId, 'evidenceId');
    let envelope;
    try {
      envelope = JSON.parse(await readFile(this.fileFor(evidenceId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw new Error('evidence envelope integrity check failed', { cause: error });
    }
    validateEnvelope(envelope);

    let record;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, decodeBase64(envelope.iv, 'iv', 12));
      decipher.setAAD(this.aad(evidenceId));
      decipher.setAuthTag(decodeBase64(envelope.tag, 'tag', 16));
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64(envelope.ciphertext, 'ciphertext')),
        decipher.final()
      ]);
      record = JSON.parse(plaintext.toString('utf8'));
    } catch (error) {
      throw new Error('evidence authenticity or integrity check failed', { cause: error });
    }

    if (record?.evidenceId !== evidenceId) throw new Error('evidence identity integrity check failed');
    if (record?.evidenceVersion !== '1.0') throw new Error('evidence version integrity check failed');
    const reconstructed = createEvidenceRecord(record);
    if (record.payloadHash !== reconstructed.payloadHash || envelope.payloadHash !== reconstructed.payloadHash) {
      throw new Error('evidence payload hash mismatch');
    }
    return reconstructed;
  }

  aad(evidenceId) {
    return Buffer.from(`${this.evaluationId}:${evidenceId}`, 'utf8');
  }

  fileFor(evidenceId) {
    const target = path.resolve(this.directory, `${evidenceId}.json.enc`);
    assertContained(this.directory, target);
    return target;
  }
}

function decodeKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new TypeError('EVIDENCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new TypeError('EVIDENCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  return decoded;
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('evidence envelope integrity check failed');
  }
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('evidence envelope integrity check failed');
  }
  if (!/^[a-f0-9]{64}$/u.test(envelope.payloadHash || '')) {
    throw new Error('evidence payload hash mismatch');
  }
}

function decodeBase64(value, field, expectedLength) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`invalid evidence ${field}`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error(`invalid evidence ${field}`);
  }
  return decoded;
}

function assertSafeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a safe path segment`);
  }
}

function assertContained(parent, target) {
  if (target === parent || target.startsWith(`${parent}${path.sep}`)) return;
  throw new TypeError('evidence path escapes the configured root');
}
