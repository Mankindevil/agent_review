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

test('keeps V2 archive copy separate from exact legacy delete copy', () => {
  assert.deepEqual(recordActionCopy(true), {
    idle: '归档',
    confirm: '再点一次确认归档',
    pending: '归档中',
    failed: '归档失败'
  });
  assert.deepEqual(recordActionCopy(false), {
    idle: '删除',
    confirm: '再点一次确认',
    pending: '删除中',
    failed: '删除失败'
  });
});

test('formats empty and upstream archive failures without delete wording or duplicate prefixes', () => {
  assert.equal(recordActionFailure(true), '归档失败');
  assert.equal(recordActionFailure(true, ''), '归档失败');
  assert.equal(recordActionFailure(true, '权限不足'), '归档失败：权限不足');
  assert.equal(recordActionFailure(true, '归档失败'), '归档失败');
  assert.equal(recordActionFailure(true, '归档失败：权限不足'), '归档失败：权限不足');
  assert.equal(recordActionFailure(false), '删除失败');
  assert.equal(recordActionFailure(false, '权限不足'), '权限不足');
});
