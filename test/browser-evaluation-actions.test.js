import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canDeleteEvaluation,
  canStopEvaluation,
  evaluationActionOptions,
  restoreV2StartButton
} from '../public/evaluation-actions.js';

test('builds a method-only action request', () => {
  assert.deepEqual(evaluationActionOptions('DELETE'), { method: 'DELETE' });
  assert.deepEqual(evaluationActionOptions('POST'), { method: 'POST' });
});

test('allows stopping only active unarchived evaluations', () => {
  assert.equal(canStopEvaluation({
    schemaVersion: 2,
    execution: { status: 'running' }
  }), true);
  assert.equal(canStopEvaluation({
    schemaVersion: 2,
    archivedAt: '2026-07-25T00:00:00.000Z',
    execution: { status: 'interrupted' }
  }), false);
  assert.equal(canStopEvaluation({
    schemaVersion: 2,
    execution: { status: 'cancelled' }
  }), false);
});

test('allows delete only for terminal states', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(canDeleteEvaluation({
      schemaVersion: 2,
      execution: { status }
    }), true);
  }
  assert.equal(canDeleteEvaluation({
    schemaVersion: 2,
    execution: { status: 'running' }
  }), false);
  assert.equal(canDeleteEvaluation({ status: 'completed' }), true);
});

test('restores the V2 create control after creation', () => {
  const label = { textContent: '正在建立证据链' };
  const button = {
    disabled: true,
    querySelector(selector) {
      return selector === 'span' ? label : null;
    }
  };

  restoreV2StartButton(button);

  assert.equal(button.disabled, false);
  assert.equal(label.textContent, '启动 A2A 证据评测');
});
