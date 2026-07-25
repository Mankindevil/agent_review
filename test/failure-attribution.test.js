import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeFailure } from '../src/failure-attribution.js';

test('control probe failure attributes a failure to the platform', () => {
  const result = attributeFailure({
    scheduler: { ok: false, evidenceId: 'ev_scheduler' },
    evidenceStore: { ok: true, evidenceId: 'ev_store' },
    organizerEndpoint: { ok: true, evidenceId: 'ev_organizer' },
    independentWorker: { ok: true, evidenceId: 'ev_worker' },
    unrelatedAgentHealth: { ok: true, evidenceId: 'ev_other' }
  });
  assert.deepEqual(result, {
    attribution: 'platform',
    reasons: ['scheduler control probe failed'],
    evidenceIds: ['ev_scheduler', 'ev_store', 'ev_organizer', 'ev_worker', 'ev_other']
  });
});

test('unrelated agent failures attribute the incident to platform', () => {
  const result = attributeFailure({
    scheduler: { ok: true },
    evidenceStore: { ok: true },
    organizerEndpoint: { ok: true },
    independentWorker: { ok: false },
    unrelatedAgentHealth: { ok: false }
  });
  assert.equal(result.attribution, 'platform');
  assert.match(result.reasons.join(' '), /unrelated/i);
});

test('only repeated target failure with passing controls attributes to agent', () => {
  const result = attributeFailure({
    scheduler: { ok: true },
    evidenceStore: { ok: true },
    organizerEndpoint: { ok: true },
    independentWorker: { ok: false, targetFailed: true, attempts: 2 },
    unrelatedAgentHealth: { ok: true },
    targetFailures: 2
  });
  assert.equal(result.attribution, 'agent');
});

test('ambiguous or replica failures remain non-authorizing', () => {
  assert.equal(attributeFailure({
    scheduler: { ok: true },
    evidenceStore: { ok: true },
    organizerEndpoint: { ok: true },
    independentWorker: { ok: false, targetFailed: true, attempts: 1 },
    unrelatedAgentHealth: { ok: true }
  }).attribution, 'pending');

  assert.equal(attributeFailure({
    scheduler: { ok: true },
    evidenceStore: { ok: true },
    organizerEndpoint: { ok: true },
    independentWorker: { ok: false, targetFailed: true, attempts: 3 },
    unrelatedAgentHealth: { ok: true },
    targetFailures: 3,
    subject: 'replica'
  }).attribution, 'replica');
});
