import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAgentExamples } from '../src/example-compiler.js';
import {
  TEST_TIMING_POLICY_V1,
  finalizeTestPlan,
  inputForTurn
} from '../src/test-plan.js';

const compilation = compileAgentExamples({
  name: 'Format Agent',
  description: 'Formats supplied text.',
  supportedInterfaces: [{
    url: 'https://agent.example/a2a',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }]
}, [{
  id: 'format',
  name: 'Format',
  turns: [{
    input: { parts: [{ type: 'text', text: 'Format A, B as a table.' }] },
    expectedDeliverable: 'A Markdown table.',
    acceptanceCriteria: [{
      id: 'table',
      type: 'contains',
      description: 'Produces a table.',
      expected: ['|']
    }]
  }]
}]);

const candidates = ['equivalent', 'boundary', 'multi-turn'].map((variantType) => ({
  candidateId: `format-${variantType}`,
  sourceExampleId: 'format',
  variantType,
  changeSummary: `${variantType} formatting input`,
  turns: variantType === 'multi-turn'
    ? [
        { input: { parts: [{ type: 'text', text: 'Format A, B.' }] } },
        { input: { parts: [{ type: 'text', text: 'Add column C.' }] } }
      ]
    : [{ input: { parts: [{ type: 'text', text: `Format A, B: ${variantType}.` }] } }],
  inheritedCriteriaIds: ['table'],
  proposedCriteria: [],
  timingClass: variantType === 'multi-turn' ? 'multiTurn' : 'singleTurn'
}));

const decisions = candidates.map((item) => ({
  candidateId: item.candidateId,
  checks: {
    sameDomain: true,
    declaredOrDemonstratedCapabilityOnly: true,
    noExternalTruthDependency: true,
    difficultyFromAllowedTransformation: true,
    sameInputForAgentAndReplica: true
  },
  approved: true,
  reasons: []
}));

test('locks a complete four-type matrix with three repeats and exact weights', () => {
  const plan = finalizeTestPlan(compilation, candidates, decisions, {
    generatedAt: '2026-07-25T00:00:00.000Z',
    generatorIdentity: 'provider:generator:model',
    scopeReviewerIdentity: 'provider:scope:model'
  });

  assert.equal(plan.status, 'ready');
  const scored = plan.tests.filter((item) => item.variantType !== 'protocol-recovery');
  assert.deepEqual(
    scored.map((item) => item.variantType),
    ['original', 'equivalent', 'boundary', 'multi-turn']
  );
  assert.equal(scored.every((item) => item.repeatCount === 3), true);
  assert.equal(plan.tests.every((item) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(item.testId)), true);
  assert.equal(scored.reduce((sum, item) => sum + item.weight, 0), 1);
  assert.equal(scored.every((item) => item.weight === 0.25), true);
  assert.equal(plan.tests.at(-1).variantType, 'protocol-recovery');
  assert.equal(plan.tests.at(-1).weight, 0);
  assert.deepEqual(plan.timingPolicy, TEST_TIMING_POLICY_V1);
});

test('retains rejected attempts in audit and fails closed when a slot is missing', () => {
  const rejected = structuredClone(decisions);
  rejected[1].checks.sameDomain = false;
  rejected[1].approved = true;
  rejected[1].reasons = ['Introduces a new task domain.'];

  const plan = finalizeTestPlan(compilation, candidates, rejected, {
    generatedAt: '2026-07-25T00:00:00.000Z',
    generatorIdentity: 'provider:generator:model',
    scopeReviewerIdentity: 'provider:scope:model'
  });

  assert.equal(plan.status, 'scope-incomplete');
  assert.equal(plan.scopeAudit.rejected.length, 1);
  assert.equal(plan.tests.some((item) => item.candidateId === 'format-boundary'), false);
});

test('fails closed when a direct caller supplies a fake multi-turn candidate', () => {
  const invalid = structuredClone(candidates);
  invalid[2].turns = [invalid[2].turns[0]];
  assert.throws(
    () => finalizeTestPlan(compilation, invalid, decisions, {
      generatedAt: '2026-07-25T00:00:00.000Z',
      generatorIdentity: 'provider:generator:model',
      scopeReviewerIdentity: 'provider:scope:model'
    }),
    /multi-turn|two turns/iu
  );
});

test('returns cloned byte-identical turn input for submitted Agent and later Replica use', () => {
  const plan = finalizeTestPlan(compilation, candidates, decisions, {
    generatedAt: '2026-07-25T00:00:00.000Z',
    generatorIdentity: 'provider:generator:model',
    scopeReviewerIdentity: 'provider:scope:model'
  });
  const equivalent = plan.tests.find((item) => item.variantType === 'equivalent');
  const first = inputForTurn(equivalent, 0);
  const second = inputForTurn(equivalent, 0);

  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  first.parts[0].text = 'mutated';
  assert.notDeepEqual(first, inputForTurn(equivalent, 0));
});
