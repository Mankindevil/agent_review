import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerAddress } from '../src/server-address.js';

test('uses an explicit production host and numeric port', () => {
  assert.deepEqual(
    resolveServerAddress({ HOST: ' 127.0.0.1 ', PORT: '4173' }),
    { host: '127.0.0.1', port: 4173 }
  );
});

test('preserves the current all-interface default when HOST is absent', () => {
  assert.deepEqual(resolveServerAddress({}), { host: undefined, port: 4173 });
});

test('rejects invalid ports before starting the server', () => {
  assert.throws(() => resolveServerAddress({ PORT: '70000' }), /PORT/);
});
