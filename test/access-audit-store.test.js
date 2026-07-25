import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccessAuditStore } from '../src/access-audit-store.js';

test('appends hash-chained access events without evidence content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'access-audit-'));
  const store = new AccessAuditStore({ root, now: () => '2026-07-25T12:00:00.000Z' });

  const first = await store.append({
    principalId: 'judge-1',
    evaluationId: 'eval_1',
    evidenceId: 'ev_1',
    role: 'judge',
    content: 'must not be stored'
  });
  const second = await store.append({
    principalId: 'judge-1',
    evaluationId: 'eval_1',
    evidenceId: 'ev_2',
    role: 'judge'
  });

  assert.equal(first.previousEventHash, null);
  assert.equal(second.previousEventHash, first.eventHash);
  assert.match(first.eventHash, /^[a-f0-9]{64}$/u);
  const log = await readFile(path.join(root, '2026-07-25.ndjson'), 'utf8');
  assert.equal(log.includes('must not be stored'), false);
  assert.deepEqual(log.trim().split('\n').map(JSON.parse), [first, second]);
});

test('rejects malformed or secret-bearing audit events', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'access-audit-'));
  const store = new AccessAuditStore({ root });

  await assert.rejects(
    store.append({ principalId: 'judge-1', evaluationId: 'eval_1', role: 'judge' }),
    /evidenceId/u
  );
  await assert.rejects(
    store.append({
      principalId: 'judge-1',
      evaluationId: 'eval_1',
      evidenceId: 'ev_1',
      role: 'judge',
      payload: { secret: 'nope' }
    }),
    /unsupported|payload/u
  );
});
