import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canArchiveEvaluation,
  canStopEvaluation,
  participantActionOptions,
  resolveParticipantToken,
  restoreV2StartButton
} from '../public/evaluation-actions.js';

test('resolves participant ownership from memory before a manual token', () => {
  const tokens = new Map([['eval_memory', 'memory-token']]);

  assert.equal(
    resolveParticipantToken('eval_memory', tokens, ' manual-token '),
    'memory-token'
  );
  assert.equal(tokens.get('eval_memory'), 'memory-token');
});

test('keeps a manually supplied participant token only in the provided memory map', () => {
  const tokens = new Map();

  assert.equal(
    resolveParticipantToken('eval_manual', tokens, ' manual-token '),
    'manual-token'
  );
  assert.equal(tokens.get('eval_manual'), 'manual-token');
  assert.throws(
    () => resolveParticipantToken('eval_missing', tokens, '   '),
    /participant access token/i
  );
});

test('builds an authenticated participant action without persisting the token', () => {
  assert.deepEqual(
    participantActionOptions('DELETE', 'participant-token'),
    {
      method: 'DELETE',
      headers: { authorization: 'Bearer participant-token' }
    }
  );
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

test('allows V2 archive only for unarchived archiveable terminal states', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(canArchiveEvaluation({
      schemaVersion: 2,
      execution: { status }
    }), true);
  }
  assert.equal(canArchiveEvaluation({
    schemaVersion: 2,
    execution: { status: 'running' }
  }), false);
  assert.equal(canArchiveEvaluation({
    schemaVersion: 2,
    archivedAt: '2026-07-25T00:00:00.000Z',
    execution: { status: 'completed' }
  }), false);
  assert.equal(canArchiveEvaluation({ status: 'completed' }), false);
});

test('restores the V2 create control after the one-time token receipt', () => {
  const label = { textContent: '评测已创建 · 先保存 token' };
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
