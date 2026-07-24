import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEvidenceRecord } from '../src/evidence.js';
import { EvidenceVault } from '../src/evidence-vault.js';

function fixtureRecord(evidenceId = 'ev_vault') {
  return createEvidenceRecord({
    evidenceId,
    runId: 'run_vault',
    grade: 'B',
    kind: 'protocol-object',
    testId: 'test_vault',
    turnIndex: 1,
    repeatIndex: 2,
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: { raw: 'plaintext-sentinel', nested: { value: 42 } }
  });
}

test('stores authenticated AES-256-GCM envelopes append-only and round-trips immutable evidence', async () => {
  const root = path.join(tmpdir(), `agent-review-vault-${process.pid}-${Date.now()}`);
  const key = randomBytes(32).toString('base64');
  const vault = new EvidenceVault({ root, evaluationId: 'eval_vault', key });
  const record = fixtureRecord();
  try {
    await vault.put(record);
    const file = path.join(root, 'eval_vault', 'ev_vault.json.enc');
    const rawEnvelope = await readFile(file, 'utf8');
    const envelope = JSON.parse(rawEnvelope);

    assert.equal(envelope.version, 1);
    assert.equal(envelope.algorithm, 'aes-256-gcm');
    assert.equal(envelope.payloadHash, record.payloadHash);
    assert.equal(rawEnvelope.includes('plaintext-sentinel'), false);
    assert.deepEqual(await vault.get(record.evidenceId), record);
    await assert.rejects(() => vault.put(record), (error) => error.code === 'EEXIST');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('round-trips evidence records whose optional coordinates are absent', async () => {
  const root = path.join(tmpdir(), `agent-review-vault-optional-${process.pid}-${Date.now()}`);
  const vault = new EvidenceVault({
    root,
    evaluationId: 'eval_optional',
    key: randomBytes(32).toString('base64')
  });
  const record = createEvidenceRecord({
    evidenceId: 'ev_optional',
    grade: 'C',
    payload: { claim: 'declared' }
  });
  try {
    await vault.put(record);
    assert.deepEqual(await vault.get(record.evidenceId), record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid keys and traversal-shaped evaluation or evidence IDs', async () => {
  const root = path.join(tmpdir(), `agent-review-vault-path-${process.pid}-${Date.now()}`);
  const key = randomBytes(32).toString('base64');
  assert.throws(() => new EvidenceVault({ root, evaluationId: 'eval', key: randomBytes(31).toString('base64') }), /32-byte/i);
  assert.throws(() => new EvidenceVault({ root, evaluationId: '../escape', key }), /evaluationId/i);

  const vault = new EvidenceVault({ root, evaluationId: 'eval_safe', key });
  await assert.rejects(() => vault.put({ ...fixtureRecord(), evidenceId: '../escape' }), /evidenceId/i);
  await assert.rejects(() => vault.get('..\\escape'), /evidenceId/i);
  await rm(root, { recursive: true, force: true });
});

test('rejects ciphertext, tag, payload-hash, and AAD tampering', async () => {
  const root = path.join(tmpdir(), `agent-review-vault-tamper-${process.pid}-${Date.now()}`);
  const key = randomBytes(32).toString('base64');
  const vault = new EvidenceVault({ root, evaluationId: 'eval_original', key });
  const record = fixtureRecord('ev_tamper');
  const file = path.join(root, 'eval_original', 'ev_tamper.json.enc');
  try {
    await vault.put(record);
    const original = JSON.parse(await readFile(file, 'utf8'));

    for (const field of ['ciphertext', 'tag']) {
      const tampered = { ...original };
      const bytes = Buffer.from(tampered[field], 'base64');
      bytes[0] ^= 1;
      tampered[field] = bytes.toString('base64');
      await writeFile(file, JSON.stringify(tampered));
      await assert.rejects(() => vault.get(record.evidenceId), /authentic|integrity|tamper/i);
    }

    await writeFile(file, JSON.stringify({ ...original, payloadHash: '0'.repeat(64) }));
    await assert.rejects(() => vault.get(record.evidenceId), /payload hash/i);

    const copiedDirectory = path.join(root, 'eval_copied');
    await mkdir(copiedDirectory, { recursive: true });
    await writeFile(path.join(copiedDirectory, 'ev_tamper.json.enc'), JSON.stringify(original));
    const copiedVault = new EvidenceVault({ root, evaluationId: 'eval_copied', key });
    await assert.rejects(() => copiedVault.get(record.evidenceId), /authentic|integrity|tamper/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
