import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
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
    await assert.rejects(() => vault.get(record.evidenceId), /expected payload hash/i);
    assert.deepEqual(await vault.get(record.evidenceId, record.payloadHash), record);
    if (process.platform !== 'win32') {
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(root, 'eval_vault'))).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    await assert.rejects(() => vault.put(record), (error) => error.code === 'EEXIST');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('round-trips evidence records whose optional turn and repeat coordinates are absent', async () => {
  const root = path.join(tmpdir(), `agent-review-vault-optional-${process.pid}-${Date.now()}`);
  const vault = new EvidenceVault({
    root,
    evaluationId: 'eval_optional',
    key: randomBytes(32).toString('base64')
  });
  const record = createEvidenceRecord({
    evidenceId: 'ev_optional',
    runId: 'run_optional',
    testId: 'test_optional',
    grade: 'C',
    kind: 'agent-claim',
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: { claim: 'declared' }
  });
  try {
    await vault.put(record);
    assert.deepEqual(await vault.get(record.evidenceId, record.payloadHash), record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid record poisoning before an append-only ID is occupied', async () => {
  const root = path.join(tmpdir(), `agent-review-vault-poison-${process.pid}-${Date.now()}`);
  const vault = new EvidenceVault({
    root,
    evaluationId: 'eval_poison',
    key: randomBytes(32).toString('base64')
  });
  const correct = createEvidenceRecord({
    evidenceId: 'ev_poison',
    runId: 'run_poison',
    testId: 'test_poison',
    grade: 'D',
    kind: 'reviewer-inference',
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: { conclusion: 'inference' }
  });
  const poisoned = {
    ...correct,
    grade: 'A'
  };
  try {
    await assert.rejects(() => vault.put(poisoned), /grade.*kind|kind.*grade/i);
    await vault.put(correct);
    assert.deepEqual(await vault.get(correct.evidenceId, correct.payloadHash), correct);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('round-trips prototype-named payload keys without changing their JSON meaning', async () => {
  const root = path.join(tmpdir(), `agent-review-vault-prototype-${process.pid}-${Date.now()}`);
  const vault = new EvidenceVault({
    root,
    evaluationId: 'eval_prototype',
    key: randomBytes(32).toString('base64')
  });
  const record = createEvidenceRecord({
    evidenceId: 'ev_prototype',
    runId: 'run_prototype',
    testId: 'test_prototype',
    grade: 'B',
    kind: 'protocol-object',
    capturedAt: '2026-07-24T10:00:00.000Z',
    payload: JSON.parse('{"__proto__":{"value":"preserved"},"constructor":{"value":"also-preserved"}}')
  });
  try {
    await vault.put(record);
    const restored = await vault.get(record.evidenceId, record.payloadHash);
    assert.deepEqual(restored, record);
    assert.equal(Object.hasOwn(restored.payload, '__proto__'), true);
    assert.equal(restored.payload.__proto__.value, 'preserved');
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
      await assert.rejects(
        () => vault.get(record.evidenceId, record.payloadHash),
        /authentic|integrity|tamper|commitment/i
      );
    }

    await writeFile(file, JSON.stringify({ ...original, payloadHash: '0'.repeat(64) }));
    await assert.rejects(() => vault.get(record.evidenceId, record.payloadHash), /payload hash|commitment/i);

    const copiedDirectory = path.join(root, 'eval_copied');
    await mkdir(copiedDirectory, { recursive: true });
    await writeFile(path.join(copiedDirectory, 'ev_tamper.json.enc'), JSON.stringify(original));
    const copiedVault = new EvidenceVault({ root, evaluationId: 'eval_copied', key });
    await assert.rejects(
      () => copiedVault.get(record.evidenceId, record.payloadHash),
      /authentic|integrity|tamper/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a valid same-identity envelope that does not match the independent manifest hash', async () => {
  const rootOne = path.join(tmpdir(), `agent-review-vault-commit-one-${process.pid}-${Date.now()}`);
  const rootTwo = path.join(tmpdir(), `agent-review-vault-commit-two-${process.pid}-${Date.now()}`);
  const key = randomBytes(32).toString('base64');
  const firstVault = new EvidenceVault({ root: rootOne, evaluationId: 'eval_same', key });
  const secondVault = new EvidenceVault({ root: rootTwo, evaluationId: 'eval_same', key });
  const common = {
    evidenceId: 'ev_same',
    runId: 'run_same',
    testId: 'test_same',
    grade: 'B',
    kind: 'protocol-response',
    capturedAt: '2026-07-24T10:00:00.000Z'
  };
  const original = createEvidenceRecord({ ...common, payload: { version: 'original' } });
  const replacement = createEvidenceRecord({ ...common, payload: { version: 'replacement' } });
  try {
    await firstVault.put(original);
    await secondVault.put(replacement);
    await copyFile(
      path.join(rootTwo, 'eval_same', 'ev_same.json.enc'),
      path.join(rootOne, 'eval_same', 'ev_same.json.enc')
    );

    await assert.rejects(
      () => firstVault.get(original.evidenceId, original.payloadHash),
      /expected payload hash|commitment/i
    );
  } finally {
    await rm(rootOne, { recursive: true, force: true });
    await rm(rootTwo, { recursive: true, force: true });
  }
});

test('rejects symlinked vault roots and evaluation directories when the OS supports them', async (t) => {
  const container = path.join(tmpdir(), `agent-review-vault-links-${process.pid}-${Date.now()}`);
  const actualRoot = path.join(container, 'actual-root');
  const linkedRoot = path.join(container, 'linked-root');
  const outside = path.join(container, 'outside');
  const key = randomBytes(32).toString('base64');
  const record = fixtureRecord('ev_link');
  await mkdir(actualRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    try {
      await symlink(actualRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.skip(`symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const linkedRootVault = new EvidenceVault({
      root: linkedRoot,
      evaluationId: 'eval_linked_root',
      key
    });
    await assert.rejects(() => linkedRootVault.put(record), /symlink|reparse|real path/i);

    const evaluationLink = path.join(actualRoot, 'eval_linked_directory');
    await symlink(outside, evaluationLink, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedDirectoryVault = new EvidenceVault({
      root: actualRoot,
      evaluationId: 'eval_linked_directory',
      key
    });
    await assert.rejects(() => linkedDirectoryVault.put(record), /symlink|reparse|real path/i);
    await assert.rejects(() => stat(path.join(outside, 'ev_link.json.enc')), (error) => error.code === 'ENOENT');
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});
