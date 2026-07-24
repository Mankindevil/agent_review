import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeEvidenceRecord } from './evidence.js';

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
    this.key = decodeEvidenceEncryptionKey(key);
    this.directory = path.resolve(this.root, evaluationId);
    assertContained(this.root, this.directory);
  }

  async put(record) {
    const canonicalRecord = canonicalizeEvidenceRecord(record);
    assertSafeId(canonicalRecord.evidenceId, 'evidenceId');
    await this.prepareDirectory();

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(canonicalRecord.evidenceId, canonicalRecord.recordHash));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(canonicalRecord), 'utf8'),
      cipher.final()
    ]);
    const envelope = {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: encrypted.toString('base64'),
      payloadHash: canonicalRecord.payloadHash,
      recordHash: canonicalRecord.recordHash
    };

    const file = this.fileFor(canonicalRecord.evidenceId);
    await writeFile(file, JSON.stringify(envelope), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    if (process.platform !== 'win32') await chmod(file, 0o600);
    return canonicalRecord;
  }

  async get(evidenceId, expectedRecordHash) {
    assertSafeId(evidenceId, 'evidenceId');
    assertExpectedRecordHash(expectedRecordHash);
    await this.assertSecureDirectory();
    const file = this.fileFor(evidenceId);
    await assertRegularFile(file);
    let envelope;
    try {
      envelope = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw new Error('evidence envelope integrity check failed', { cause: error });
    }
    validateEnvelope(envelope);
    if (envelope.recordHash !== expectedRecordHash) {
      throw new Error('evidence does not match expected record hash commitment');
    }

    let record;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, decodeBase64(envelope.iv, 'iv', 12));
      decipher.setAAD(this.aad(evidenceId, expectedRecordHash));
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
    if (record?.recordHash !== expectedRecordHash) {
      throw new Error('evidence record hash commitment mismatch');
    }
    const reconstructed = canonicalizeEvidenceRecord(record);
    if (
      record.payloadHash !== reconstructed.payloadHash ||
      envelope.payloadHash !== reconstructed.payloadHash ||
      record.recordHash !== reconstructed.recordHash ||
      envelope.recordHash !== reconstructed.recordHash ||
      expectedRecordHash !== reconstructed.recordHash
    ) {
      throw new Error('evidence record commitment mismatch');
    }
    return reconstructed;
  }

  aad(evidenceId, recordHash) {
    return Buffer.from(`${this.evaluationId}:${evidenceId}:${recordHash}`, 'utf8');
  }

  fileFor(evidenceId) {
    const target = path.resolve(this.directory, `${evidenceId}.json.enc`);
    assertContained(this.directory, target);
    return target;
  }

  async prepareDirectory() {
    await assertNoLinkedPathComponents(this.root, 'configured evidence root');
    await rejectSymlinkIfPresent(this.root, 'evidence root');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertNoLinkedPathComponents(this.root, 'configured evidence root');
    await assertSecureDirectoryPath(this.root, 'evidence root');
    if (process.platform !== 'win32') await chmod(this.root, 0o700);

    await assertNoLinkedPathComponents(this.directory, 'evaluation evidence directory');
    await rejectSymlinkIfPresent(this.directory, 'evaluation evidence directory');
    try {
      await mkdir(this.directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await assertNoLinkedPathComponents(this.directory, 'evaluation evidence directory');
    await this.assertSecureDirectory();
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
  }

  async assertSecureDirectory() {
    await assertNoLinkedPathComponents(this.root, 'configured evidence root');
    await assertNoLinkedPathComponents(this.directory, 'evaluation evidence directory');
    await assertSecureDirectoryPath(this.root, 'evidence root');
    await assertSecureDirectoryPath(this.directory, 'evaluation evidence directory');
    const [rootPath, directoryPath] = await Promise.all([
      realpath(this.root),
      realpath(this.directory)
    ]);
    assertContained(rootPath, directoryPath);
  }
}

export function decodeEvidenceEncryptionKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) {
      throw new TypeError('EVIDENCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return Buffer.from(value);
  }
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
  if (!/^[a-f0-9]{64}$/u.test(envelope.recordHash || '')) {
    throw new Error('evidence record hash mismatch');
  }
}

function assertExpectedRecordHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError('expected record hash is required');
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
  const normalizedParent = normalizePathForComparison(parent);
  const normalizedTarget = normalizePathForComparison(target);
  if (
    normalizedTarget === normalizedParent ||
    normalizedTarget.startsWith(`${normalizedParent}${path.sep}`)
  ) return;
  throw new TypeError('evidence path escapes the configured root');
}

async function rejectSymlinkIfPresent(target, label) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new TypeError(`${label} must not be a symlink or reparse point`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function assertNoLinkedPathComponents(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  let unverifiedAncestor = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (unverifiedAncestor) {
          throw new TypeError(`${label} ancestor cannot be securely inspected`);
        }
        return;
      }
      if (['EACCES', 'EPERM'].includes(error.code)) {
        unverifiedAncestor = true;
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new TypeError(`${label} ancestor must not be a symlink, junction, or reparse point`);
    }
    const canonical = await realpath(current);
    if (normalizePathForComparison(canonical) !== normalizePathForComparison(current)) {
      throw new TypeError(`${label} ancestor must use its canonical real path`);
    }
    unverifiedAncestor = false;
  }
  if (unverifiedAncestor) throw new TypeError(`${label} ancestor cannot be securely inspected`);
}

async function assertSecureDirectoryPath(target, label) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new TypeError(`${label} must not be a symlink or reparse point`);
  if (!info.isDirectory()) throw new TypeError(`${label} must be a directory`);
}

async function assertRegularFile(target) {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    throw new TypeError('evidence file must not be a symlink or reparse point');
  }
  if (!info.isFile()) throw new TypeError('evidence path must be a regular file');
}

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
