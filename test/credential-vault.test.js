import test from 'node:test';
import assert from 'node:assert/strict';
import { EphemeralCredentialVault } from '../src/credential-vault.js';

test('isolates credentials by evaluation and deletes them idempotently', () => {
  const vault = new EphemeralCredentialVault();
  vault.put('eval_one', 'token-one');
  vault.put('eval_two', 'Bearer token-two');
  assert.equal(vault.get('eval_one'), 'token-one');
  assert.equal(vault.get('eval_two'), 'Bearer token-two');
  assert.equal(vault.delete('eval_one'), true);
  assert.equal(vault.delete('eval_one'), false);
  assert.equal(vault.get('eval_one'), undefined);
  assert.equal(vault.get('eval_two'), 'Bearer token-two');
});

test('replaces credentials without exposing a serialization surface', () => {
  const zeroized = [];
  const vault = new EphemeralCredentialVault({
    onZeroized: (event) => zeroized.push(structuredClone(event))
  });
  vault.put('eval_one', 'first-token');
  const firstRead = vault.get('eval_one');
  vault.put('eval_one', 'second-token');
  assert.deepEqual(zeroized, [{
    evaluationId: 'eval_one',
    reason: 'replaced',
    byteLength: Buffer.byteLength('first-token')
  }]);
  assert.doesNotMatch(JSON.stringify(zeroized), /first-token|second-token/u);
  assert.equal(firstRead, 'first-token');
  assert.equal(vault.get('eval_one'), 'second-token');
  vault.delete('eval_one');
  assert.deepEqual(zeroized[1], {
    evaluationId: 'eval_one',
    reason: 'deleted',
    byteLength: Buffer.byteLength('second-token')
  });
  assert.equal(vault.get('eval_one'), undefined);
  assert.deepEqual(Object.keys(vault), []);
  assert.equal(JSON.stringify(vault), '{}');
});

test('uses the executor authorization boundary and rejects unsafe values generically', () => {
  const vault = new EphemeralCredentialVault();
  for (const [id, authorization] of [
    ['../escape', 'valid-token'],
    ['eval_one', ''],
    ['eval_one', ' padded-token '],
    ['eval_one', 'bad token']
  ]) {
    assert.throws(() => vault.put(id, authorization), /evaluation|authorization|credential/i);
  }
  assert.throws(() => vault.put('eval_one', undefined), /authorization|credential/i);
});
