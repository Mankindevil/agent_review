import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileAgentExamples
} from '../src/example-compiler.js';
import { isExecutableCriterion } from '../src/rubric.js';

const card = {
  name: 'Portfolio Risk Agent',
  description: 'Uses an internal browser tool and planner to review portfolio concentration.',
  supportedInterfaces: [{
    url: 'https://agent.example/a2a',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }],
  capabilities: { streaming: true },
  skills: [{
    id: 'portfolio-risk',
    name: 'Portfolio risk',
    description: 'Reviews holdings and concentration.'
  }]
};

const portfolioExample = {
  id: 'portfolio-risk',
  name: 'Portfolio concentration review',
  turns: [{
    input: {
      parts: [
        { type: 'text', text: 'Analyze this portfolio for industry concentration.' },
        { type: 'data', data: { holdings: [{ symbol: 'A', weight: 0.6 }] } }
      ]
    },
    expectedDeliverable: 'Industry exposure, concentration risks, and adjustment options.',
    acceptanceCriteria: [
      {
        id: 'risk-language',
        type: 'contains',
        description: 'Names concentration risk.',
        expected: ['concentration', 'risk']
      },
      {
        id: 'reasoning-quality',
        type: 'model',
        description: 'Explains how the holdings support the conclusion.'
      }
    ]
  }],
  constraints: ['Do not invent missing holdings.']
};

function example({
  id,
  name,
  prompt,
  deliverable,
  criteria = []
}) {
  return {
    id,
    name,
    turns: [{
      input: { parts: [{ type: 'text', text: prompt }] },
      expectedDeliverable: deliverable,
      acceptanceCriteria: criteria
    }]
  };
}

test('compiles a closed deterministic contract without treating internal claims as observed capability', () => {
  const compilation = compileAgentExamples(card, [portfolioExample], {
    rubricVersion: 'a2a-black-box-v1'
  });

  assert.equal(compilation.compilationVersion, 'example-compilation/v1');
  assert.deepEqual(compilation.allowedDomains, ['portfolio-risk']);
  assert.equal(
    compilation.contracts[0].goal,
    'Analyze this portfolio for industry concentration.'
  );
  assert.equal(compilation.contracts[0].externalTruthVerified, false);
  assert.equal(compilation.objectiveApplicability.testSuccess, true);
  assert.equal(compilation.objectiveApplicability.contextContinuity, false);
  assert.ok(compilation.rubricChecks.some(
    (check) => check.subcriterionId === 'professionalism.evidenceReasoning'
  ));
  assert.ok(compilation.unverifiableClaims.some(
    (claim) => claim.kind === 'internal-tooling' && claim.evidenceGrade === 'C'
  ));
  assert.equal(compilation.unverifiableClaims.every(
    (claim) => !Object.hasOwn(claim, 'score')
  ), true);
  assert.match(compilation.sourceHashes.agentCard, /^[a-f0-9]{64}$/u);
  assert.match(compilation.sourceHashes.agentExamples, /^[a-f0-9]{64}$/u);
});

test('keeps executable and model criteria separate and maps every check to the fixed rubric', () => {
  const compilation = compileAgentExamples(card, [portfolioExample], {
    rubricVersion: 'a2a-black-box-v1'
  });
  const contract = compilation.contracts[0];

  assert.deepEqual(contract.executableCriteria.map((item) => item.criterionId), [
    'risk-language'
  ]);
  assert.deepEqual(contract.modelCriteria.map((item) => item.criterionId), [
    'reasoning-quality'
  ]);
  assert.equal(isExecutableCriterion({ type: 'contains' }), true);
  assert.equal(isExecutableCriterion({ type: 'model' }), false);

  const fixedIds = new Set([
    'scenarioValue.agentNecessity',
    'scenarioValue.researchDecisionValue',
    'scenarioValue.utilityReuse',
    'scenarioValue.productNovelty',
    'professionalism.taskCompletion',
    'professionalism.methodAssumptions',
    'professionalism.evidenceReasoning',
    'professionalism.riskUncertainty',
    'professionalism.artifactUsability',
    'agentCapability.testSuccess',
    'agentCapability.robustness',
    'agentCapability.contextContinuity',
    'agentCapability.a2aCompliance',
    'agentCapability.efficiency',
    'agentCapability.claimErrorHandling'
  ]);
  assert.equal(compilation.rubricChecks.every(
    (check) => fixedIds.has(check.subcriterionId)
  ), true);
});

test('does not force unrelated finance methods onto task-specific examples', () => {
  const fixtures = [
    example({
      id: 'qualitative-research',
      name: 'Qualitative thesis',
      prompt: 'Compare the strategic risks described in the supplied management notes.',
      deliverable: 'A cited qualitative research memo.'
    }),
    example({
      id: 'quantitative-backtest',
      name: 'Backtest',
      prompt: 'Backtest the supplied monthly factor series.',
      deliverable: 'Metrics, assumptions, and a return series.'
    }),
    example({
      id: 'document-retrieval',
      name: 'Document retrieval',
      prompt: 'Find the covenant clause in the supplied filing excerpt.',
      deliverable: 'The matching clause and its location.'
    }),
    example({
      id: 'plain-formatting',
      name: 'Plain formatting',
      prompt: 'Convert the supplied bullet list into a Markdown table.',
      deliverable: 'A Markdown table.'
    })
  ];

  const compilation = compileAgentExamples(card, fixtures, {
    rubricVersion: 'a2a-black-box-v1'
  });
  const byId = Object.fromEntries(
    compilation.contracts.map((contract) => [contract.exampleId, contract])
  );

  assert.deepEqual(compilation.allowedDomains, [
    'document-retrieval',
    'plain-formatting',
    'qualitative-research',
    'quantitative-backtest'
  ]);
  for (const id of ['qualitative-research', 'document-retrieval', 'plain-formatting']) {
    const questions = byId[id].rubricCheckIds
      .map((checkId) => compilation.rubricChecks.find((check) => check.checkId === checkId))
      .map((check) => check.question.toLowerCase())
      .join(' ');
    assert.doesNotMatch(questions, /backtest|information coefficient|\bic\b|trading cost/u);
  }
  assert.match(
    compilation.rubricChecks
      .filter((check) => check.sourceRefs.includes('example:quantitative-backtest'))
      .map((check) => check.question)
      .join(' '),
    /backtest/iu
  );
});

test('marks context continuity applicable only when an example actually has multiple turns', () => {
  const multiTurn = structuredClone(portfolioExample);
  multiTurn.turns.push({
    input: { parts: [{ type: 'text', text: 'Revise the answer using a lower risk budget.' }] },
    acceptanceCriteria: []
  });

  const compilation = compileAgentExamples(card, [multiTurn], {
    rubricVersion: 'a2a-black-box-v1'
  });

  assert.equal(compilation.objectiveApplicability.contextContinuity, true);
  assert.equal(
    compilation.rubricChecks.find(
      (check) => check.subcriterionId === 'agentCapability.contextContinuity'
    ).applicable,
    true
  );
});

test('rejects unsupported rubric versions instead of silently compiling a different contract', () => {
  assert.throws(
    () => compileAgentExamples(card, [portfolioExample], {
      rubricVersion: 'future-rubric'
    }),
    /rubricVersion/u
  );
});
