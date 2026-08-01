import test from 'node:test';
import assert from 'node:assert/strict';
import * as uiHelpers from '../public/a2a-ui-helpers.js';
import {
  evaluationModeFromHealth,
  nextAvailableEditorId,
  recordActionCopy,
  recordActionFailure,
  requestedEvaluationVersion,
  resolveEvaluationVersion
} from '../public/a2a-ui-helpers.js';

test('distinguishes enabled probe failures from disabled runtimes', () => {
  assert.equal(typeof uiHelpers.runtimeStatusLabel, 'function');
  const installed = { installed: true, authenticated: true, enabled: true, runtimeReady: false };
  assert.equal(uiHelpers.runtimeStatusLabel({ ...installed, runtimeReady: true }), 'READY');
  assert.equal(uiHelpers.runtimeStatusLabel({ installed: false, authenticated: false, enabled: false, runtimeReady: false }), '缺失');
  assert.equal(uiHelpers.runtimeStatusLabel({ ...installed, authenticated: false }), '未登录');
  assert.equal(uiHelpers.runtimeStatusLabel({ ...installed, enabled: false }), '未启用');
  assert.equal(uiHelpers.runtimeStatusLabel(installed), '调用失败');
  assert.equal(uiHelpers.runtimeStatusLabel({ ...installed, installed: false }), '调用失败');
});

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

test('parses only one explicit V1 or V2 query value', () => {
  assert.equal(requestedEvaluationVersion('?version=v1'), 'v1');
  assert.equal(requestedEvaluationVersion('?version=v2'), 'v2');
  assert.equal(requestedEvaluationVersion(''), null);
  assert.equal(requestedEvaluationVersion('?version=v3'), null);
  assert.equal(requestedEvaluationVersion('?version=v1&version=v2'), null);
});

test('separates selected evaluation version from V2 availability', () => {
  assert.deepEqual(resolveEvaluationVersion('v1', true), {
    selectedVersion: 'v1',
    usable: true
  });
  assert.deepEqual(resolveEvaluationVersion('v2', true), {
    selectedVersion: 'v2',
    usable: true
  });
  assert.deepEqual(resolveEvaluationVersion('v2', false), {
    selectedVersion: 'v2',
    usable: false
  });
  assert.deepEqual(resolveEvaluationVersion(null, true), {
    selectedVersion: 'v2',
    usable: true
  });
  assert.deepEqual(resolveEvaluationVersion(null, false), {
    selectedVersion: 'v1',
    usable: true
  });
});
