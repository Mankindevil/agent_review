import test from 'node:test';
import assert from 'node:assert/strict';
import { runAppealResultVersion } from '../src/appeal-recalculation.js';

function evaluation() {
  return {
    id: 'eval_recalculate',
    governance: { resultHash: 'a'.repeat(64) },
    resultV2: {
      absolute: { status: 'locked', resultHash: 'a'.repeat(64), total: 70 },
      replica: { status: 'released' },
      rating: { code: 'npc' },
      resultVersions: []
    }
  };
}

test('recalculation runs the complete ordered chain and appends a result version', async () => {
  const current = evaluation();
  const order = [];
  const services = Object.fromEntries([
    ['replaceOrCorrectEvidence', () => order.push('evidence')],
    ['reevaluateAcceptance', () => order.push('acceptance')],
    ['recomputeObjective', () => order.push('objective')],
    ['runModelReviews', () => order.push('model')],
    ['assignHumanReviews', () => order.push('human')],
    ['arbitrateHumanReviews', () => order.push('arbitration')],
    ['lockAbsolute', () => { order.push('absolute'); return { resultHash: 'c'.repeat(64), total: 80 }; }],
    ['rejudgeArena', () => { order.push('arena'); return { status: 'released' }; }],
    ['bootstrapReplica', () => { order.push('bootstrap'); return { delta: 3 }; }],
    ['calculateRating', () => { order.push('rating'); return { code: 'excellent' }; }],
    ['generateHumor', () => { order.push('humor'); return { line: 'new finding' }; }]
  ]);
  const appeal = { appealId: 'appeal_1', status: 'replacement-completed' };
  const original = structuredClone(current.resultV2.absolute);

  const version = await runAppealResultVersion(current, appeal, services);

  assert.deepEqual(order, [
    'evidence', 'acceptance', 'objective', 'model', 'human', 'arbitration',
    'absolute', 'arena', 'bootstrap', 'rating', 'humor'
  ]);
  assert.deepEqual(current.resultV2.absolute, original);
  assert.equal(current.resultV2.resultVersions.length, 1);
  assert.equal(version.version, 1);
  assert.equal(version.supersedesResultHash, original.resultHash);
  assert.equal(version.reason, 'appeal:appeal_1');
  assert.equal(version.resultHash, 'c'.repeat(64));
  assert.equal(appeal.status, 'arena-rejudged');
});

test('recalculation requires every stage and cannot overwrite a locked result', async () => {
  const current = evaluation();
  await assert.rejects(
    () => runAppealResultVersion(current, { appealId: 'appeal_2' }, {}),
    /replaceOrCorrectEvidence|service/i
  );
  assert.equal(current.resultV2.absolute.resultHash, 'a'.repeat(64));
});
