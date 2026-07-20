import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { EvaluationStore } from '../src/store.js';

test('persists set and delete operations as valid reloadable JSON', async () => {
  const file = `/tmp/agent-roast-store-${process.pid}.json`;
  await rm(file, { force: true });
  await rm(`${file}.tmp`, { force: true });
  try {
    const store = new EvaluationStore(file);
    await store.set({ id: 'eval_one', createdAt: '2026-07-20T00:00:00.000Z' });
    await store.set({ id: 'eval_two', createdAt: '2026-07-20T00:00:01.000Z' });
    await store.delete('eval_one');

    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map((item) => item.id), ['eval_two']);
    const reloaded = new EvaluationStore(file);
    await reloaded.load();
    assert.equal(reloaded.get('eval_one'), undefined);
    assert.equal(reloaded.get('eval_two').id, 'eval_two');
  } finally {
    await rm(file, { force: true });
    await rm(`${file}.tmp`, { force: true });
  }
});
