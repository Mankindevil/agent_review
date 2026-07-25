import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReplicaDetailReleased,
  buildReleasedReplicaPublicDetail
} from '../src/replica-public-detail.js';

test('refuses replica detail before dual-track release', () => {
  assert.throws(
    () => assertReplicaDetailReleased({
      resultV2: { replica: { status: 'sealed' }, absolute: { status: 'locked' } },
      governance: {}
    }),
    (error) => error.statusCode === 409
  );
});

test('builds thin case metadata from score cells and test plan', async () => {
  const detail = await buildReleasedReplicaPublicDetail(
    {
      id: 'ev_1',
      testPlan: {
        tests: [{
          testId: 't1',
          variantType: 'original',
          turns: [{ input: { parts: [{ type: 'text', text: 'hello prompt' }] } }]
        }]
      },
      replicaCheckpoint: { builds: {} },
      replicaArena: { runtimeSummaries: [] }
    },
    ['claude-code'],
    [{
      testId: 't1',
      repeatIndex: 0,
      scores: { submitted: 70, 'replica:claude-code': 65 }
    }],
    {
      evidenceVaultFactory: () => ({
        get: async () => {
          throw new Error('should not load vault for case metadata');
        }
      })
    }
  );

  assert.equal(detail.cases.length, 1);
  assert.equal(detail.cases[0].prompt, 'hello prompt');
  assert.equal(detail.cases[0].scores.submitted, 70);
  assert.equal(detail.cases[0].scores['replica:claude-code'], 65);
  assert.equal(detail.skills[0].runtimeId, 'claude-code');
});
