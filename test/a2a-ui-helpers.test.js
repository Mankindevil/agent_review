import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluationModeFromHealth,
  nextAvailableEditorId,
  recordActionCopy,
  recordActionFailure
} from '../public/a2a-ui-helpers.js';

test('requires an explicit boolean health capability before resolving evaluation mode', () => {
  assert.deepEqual(
    evaluationModeFromHealth({ a2aBlackBoxV1Enabled: true }),
    { resolved: true, enabled: true }
  );
  assert.deepEqual(
    evaluationModeFromHealth({ a2aBlackBoxV1Enabled: false }),
    { resolved: true, enabled: false }
  );
  for (const payload of [
    undefined,
    null,
    {},
    { a2aBlackBoxV1Enabled: 'false' },
    { a2aBlackBoxV1Enabled: 0 }
  ]) {
    assert.deepEqual(
      evaluationModeFromHealth(payload),
      { resolved: false, enabled: null }
    );
  }
});

test('allocates collision-free example and criterion IDs after arbitrary deletion', () => {
  assert.equal(
    nextAvailableEditorId(['example-2'], 'example'),
    'example-1'
  );
  assert.equal(
    nextAvailableEditorId(['example-1', 'example-3'], 'example'),
    'example-2'
  );
  assert.equal(
    nextAvailableEditorId(['criterion-1', 'criterion-2'], 'criterion'),
    'criterion-3'
  );
  assert.equal(
    nextAvailableEditorId(['custom', 'criterion-2'], 'criterion'),
    'criterion-1'
  );
});

test('uses the same delete copy for legacy and V2 history actions', () => {
  assert.deepEqual(recordActionCopy(true), recordActionCopy(false));
  assert.deepEqual(recordActionCopy(true), {
    idle: '删除',
    confirm: '再点一次确认',
    pending: '删除中',
    failed: '删除失败'
  });
});

test('formats empty and upstream delete failures without duplicate prefixes', () => {
  assert.equal(recordActionFailure(true), '删除失败');
  assert.equal(recordActionFailure(true, ''), '删除失败');
  assert.equal(recordActionFailure(true, '权限不足'), '删除失败：权限不足');
  assert.equal(recordActionFailure(true, '删除失败'), '删除失败');
  assert.equal(recordActionFailure(true, '删除失败：权限不足'), '删除失败：权限不足');
  assert.equal(recordActionFailure(false), '删除失败');
  assert.equal(recordActionFailure(false, '权限不足'), '删除失败：权限不足');
});
