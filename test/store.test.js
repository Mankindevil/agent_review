import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EvaluationStore } from '../src/store.js';

test('persists set and delete operations as valid reloadable JSON', async () => {
  const file = path.join(tmpdir(), `agent-roast-store-${process.pid}.json`);
  await rm(file, { force: true });
  await rm(`${file}.tmp`, { force: true });
  try {
    const store = new EvaluationStore(file);
    await store.set({ id: 'eval_one', createdAt: '2026-07-20T00:00:00.000Z' });
    await store.set({ id: 'eval_two', createdAt: '2026-07-20T00:00:01.000Z' });
    await store.delete('eval_one');

    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      schemaVersion: '1.0',
      items: [{ id: 'eval_two', createdAt: '2026-07-20T00:00:01.000Z' }]
    });
    const reloaded = new EvaluationStore(file);
    await reloaded.load();
    assert.equal(reloaded.get('eval_one'), undefined);
    assert.equal(reloaded.get('eval_two').id, 'eval_two');
  } finally {
    await rm(file, { force: true });
    await rm(`${file}.tmp`, { force: true });
  }
});

test('loads legacy bare arrays and current versioned store wrappers', async () => {
  const legacyFile = path.join(tmpdir(), `agent-roast-store-legacy-${process.pid}.json`);
  const currentFile = path.join(tmpdir(), `agent-roast-store-current-${process.pid}.json`);
  try {
    await writeFile(legacyFile, JSON.stringify([{ id: 'legacy', createdAt: '2026-07-20T00:00:00.000Z' }]));
    await writeFile(currentFile, JSON.stringify({
      schemaVersion: '1.0',
      items: [{ id: 'current', schemaVersion: 2, createdAt: '2026-07-20T00:00:00.000Z', revision: 0 }]
    }));

    const legacy = new EvaluationStore(legacyFile);
    const current = new EvaluationStore(currentFile);
    await legacy.load();
    await current.load();

    assert.deepEqual(legacy.get('legacy'), {
      id: 'legacy',
      createdAt: '2026-07-20T00:00:00.000Z',
      schemaVersion: 1
    });
    assert.equal(current.get('current').schemaVersion, 2);
  } finally {
    await rm(legacyFile, { force: true });
    await rm(currentFile, { force: true });
  }
});

test('serializes concurrent mutations and rejects stale revisions with HTTP 409 semantics', async () => {
  const file = path.join(tmpdir(), `agent-roast-store-mutate-${process.pid}.json`);
  await rm(file, { force: true });
  await rm(`${file}.tmp`, { force: true });
  try {
    const store = new EvaluationStore(file);
    await store.set({
      id: 'eval_v2',
      schemaVersion: 2,
      createdAt: '2026-07-20T00:00:00.000Z',
      revision: 0,
      counter: 0
    });

    const updates = await Promise.all(
      Array.from({ length: 10 }, () => store.mutate('eval_v2', undefined, async (current) => {
        await new Promise((resolve) => setImmediate(resolve));
        current.counter += 1;
        return current;
      }))
    );
    assert.equal(store.get('eval_v2').counter, 10);
    assert.equal(store.get('eval_v2').revision, 10);
    assert.deepEqual(updates.map((item) => item.revision), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    await assert.rejects(
      () => store.mutate('eval_v2', 9, (current) => current),
      (error) => error.statusCode === 409 && /revision conflict/i.test(error.message)
    );
    const guarded = await store.mutate('eval_v2', 10, (current) => {
      current.revision = 500;
      current.counter += 1;
      return current;
    });
    assert.equal(guarded.revision, 11);
    assert.equal(await store.mutate('missing', 0, (current) => current), null);
  } finally {
    await rm(file, { force: true });
    await rm(`${file}.tmp`, { force: true });
  }
});

test('allows only one concurrent compare-and-swap mutation for the same revision', async () => {
  const file = path.join(tmpdir(), `agent-roast-store-cas-${process.pid}.json`);
  await rm(file, { force: true });
  try {
    const store = new EvaluationStore(file);
    await store.set({
      id: 'eval_cas',
      schemaVersion: 2,
      createdAt: '2026-07-20T00:00:00.000Z',
      revision: 0,
      winner: null
    });
    const results = await Promise.allSettled([
      store.mutate('eval_cas', 0, (current) => ({ ...current, winner: 'first' })),
      store.mutate('eval_cas', 0, (current) => ({ ...current, winner: 'second' }))
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejection = results.find((result) => result.status === 'rejected');
    assert.equal(rejection.reason.statusCode, 409);
    assert.equal(store.get('eval_cas').revision, 1);
  } finally {
    await rm(file, { force: true });
    await rm(`${file}.tmp`, { force: true });
  }
});

test('does not share V2 references across set, get, list, mutate, or returned values', async () => {
  const file = path.join(tmpdir(), `agent-roast-store-alias-${process.pid}.json`);
  await rm(file, { force: true });
  try {
    const store = new EvaluationStore(file);
    const input = {
      id: 'eval_alias',
      schemaVersion: 2,
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      revision: 0,
      nested: { value: 1 }
    };
    const setResult = await store.set(input);
    input.nested.value = 100;
    setResult.nested.value = 101;
    assert.equal(store.get(input.id).nested.value, 1);

    const fromGet = store.get(input.id);
    const fromList = store.list().find((item) => item.id === input.id);
    fromGet.nested.value = 200;
    fromList.nested.value = 201;
    assert.equal(store.get(input.id).nested.value, 1);

    let updaterAlias;
    const mutateResult = await store.mutate(input.id, 0, (current) => {
      updaterAlias = current;
      current.nested.value = 2;
      return current;
    });
    updaterAlias.nested.value = 300;
    updaterAlias.revision = 300;
    mutateResult.nested.value = 301;
    mutateResult.revision = 301;
    assert.equal(store.get(input.id).nested.value, 2);
    assert.equal(store.get(input.id).revision, 1);

    await assert.rejects(
      () => store.set({ ...input, revision: 999 }),
      (error) => error.statusCode === 409 && /mutate|revision|overwrite/i.test(error.message)
    );
    assert.equal(store.get(input.id).revision, 1);
  } finally {
    await rm(file, { force: true });
    await rm(`${file}.tmp`, { force: true });
  }
});

test('publishes set, delete, and mutate only after persistence and recovers its queue after failure', async () => {
  const root = path.join(tmpdir(), `agent-roast-store-rollback-${process.pid}`);
  const blockedTarget = path.join(root, 'blocked-target');
  const goodFile = path.join(root, 'good.json');
  await rm(root, { recursive: true, force: true });
  await mkdir(blockedTarget, { recursive: true });
  try {
    const store = new EvaluationStore(blockedTarget);
    const legacy = { id: 'legacy_rollback', createdAt: '2026-07-20T00:00:00.000Z' };
    await assert.rejects(() => store.set(legacy));
    assert.equal(store.get(legacy.id), undefined);

    store.file = goodFile;
    await store.set(legacy);
    assert.equal(store.get(legacy.id), legacy);

    store.file = blockedTarget;
    await assert.rejects(() => store.delete(legacy.id));
    assert.equal(store.get(legacy.id), legacy);

    store.file = goodFile;
    await store.delete(legacy.id);
    assert.equal(store.get(legacy.id), undefined);

    const v2 = {
      id: 'eval_rollback',
      schemaVersion: 2,
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      revision: 0,
      nested: { value: 1 }
    };
    await store.set(v2);
    store.file = blockedTarget;
    await assert.rejects(() => store.mutate(v2.id, 0, (current) => {
      current.nested.value = 2;
      return current;
    }));
    assert.equal(store.get(v2.id).nested.value, 1);
    assert.equal(store.get(v2.id).revision, 0);

    store.file = goodFile;
    const recovered = await store.mutate(v2.id, 0, (current) => {
      current.nested.value = 3;
      return current;
    });
    assert.equal(recovered.nested.value, 3);
    assert.equal(recovered.revision, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
