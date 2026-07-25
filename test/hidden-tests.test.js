import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAgentExamples } from '../src/example-compiler.js';
import {
  generateHiddenVariants,
  reviewerIdentityKey,
  reviewHiddenVariantScopes
} from '../src/hidden-tests.js';

const card = {
  name: 'Risk Agent',
  description: 'Reviews supplied portfolios.',
  supportedInterfaces: [{
    url: 'https://agent.example/a2a',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }],
  skills: [{ id: 'risk', name: 'Risk', description: 'Portfolio risk.' }]
};

const examples = [{
  id: 'risk',
  name: 'Risk',
  turns: [{
    input: {
      parts: [
        { type: 'text', text: 'Review supplied holdings.' },
        { type: 'url', url: 'https://files.example/holdings.csv' }
      ]
    },
    acceptanceCriteria: [{
      id: 'risk-word',
      type: 'contains',
      description: 'Names risk.',
      expected: ['risk']
    }]
  }]
}];

const compilation = compileAgentExamples(card, examples);
const generator = {
  kind: 'openai-compatible',
  baseUrl: 'https://models.example/v1',
  model: 'generator-v1'
};
const scopeReviewer = {
  kind: 'anthropic',
  baseUrl: 'https://scope.example/v1',
  model: 'scope-v1'
};

function candidate(variantType, overrides = {}) {
  return {
    candidateId: `risk-${variantType}`,
    sourceExampleId: 'risk',
    variantType,
    changeSummary: `${variantType} transformation`,
    turns: variantType === 'multi-turn'
      ? [{
          input: {
            parts: [
              { type: 'text', text: 'Review supplied holdings.' },
              { type: 'url', url: 'https://files.example/holdings.csv' }
            ]
          }
        }, {
          input: {
            parts: [{ type: 'text', text: 'Now explain the largest risk.' }]
          }
        }]
      : [{
          input: {
            parts: [
              { type: 'text', text: `Review supplied holdings: ${variantType}.` },
              { type: 'url', url: 'https://files.example/holdings.csv' }
            ]
          }
        }],
    inheritedCriteriaIds: ['risk-word'],
    proposedCriteria: [],
    timingClass: variantType === 'multi-turn' ? 'multiTurn' : 'singleTurn',
    ...overrides
  };
}

test('normalizes exactly one candidate for every required hidden variant slot', async () => {
  const result = await generateHiddenVariants(compilation, {
    generator,
    requestJson: async () => ({
      candidates: ['equivalent', 'boundary', 'multi-turn'].map(candidate)
    })
  });

  assert.deepEqual(
    result.candidates.map((item) => item.variantType),
    ['equivalent', 'boundary', 'multi-turn']
  );
  assert.equal(Object.isFrozen(result), true);
});

test('rejects generated inputs that expand URLs, domains, or expected truth', async () => {
  const attempts = [
    candidate('equivalent', {
      turns: [{
        input: { parts: [{ type: 'url', url: 'https://other.example/new.csv' }] }
      }]
    }),
    candidate('equivalent', { sourceExampleId: 'new-domain' }),
    candidate('equivalent', {
      proposedCriteria: [{
        id: 'external-price',
        type: 'exact',
        expected: 'the current market price'
      }]
    })
  ];

  for (const invalid of attempts) {
    await assert.rejects(
      generateHiddenVariants(compilation, {
        generator,
        requestJson: async () => ({
          candidates: [
            invalid,
            candidate('boundary'),
            candidate('multi-turn')
          ]
        })
      }),
      /scope|source|URL|external|candidate/iu
    );
  }
});

test('rejects fake multi-turn variants and timing classes that disagree with the variant', async () => {
  const invalidCases = [
    candidate('multi-turn', {
      turns: [{ input: { parts: [{ type: 'text', text: 'Only one turn.' }] } }]
    }),
    candidate('multi-turn', { timingClass: 'singleTurn' }),
    candidate('boundary', { timingClass: 'multiTurn' })
  ];

  for (const invalid of invalidCases) {
    await assert.rejects(
      generateHiddenVariants(compilation, {
        generator,
        requestJson: async () => ({
          candidates: [
            candidate('equivalent'),
            candidate('boundary'),
            candidate('multi-turn'),
            invalid
          ].filter((item, index, all) =>
            all.findLastIndex((candidateItem) =>
              candidateItem.variantType === item.variantType
            ) === index
          )
        })
      }),
      /multi-turn|timingClass/iu
    );
  }
});

test('rejects hidden inputs and proposed checks outside the frozen submission schema', async () => {
  const invalidCases = [
    candidate('equivalent', {
      turns: [{
        input: { parts: [{ type: 'shell', command: 'whoami' }] }
      }]
    }),
    candidate('equivalent', {
      turns: Array.from({ length: 21 }, (_, index) => ({
        input: { parts: [{ type: 'text', text: `turn ${index}` }] }
      }))
    }),
    candidate('equivalent', {
      proposedCriteria: [{
        id: 'generated-executable',
        type: 'json-schema',
        description: 'Generated executable answer key.',
        schema: {
          type: 'array',
          items: { $ref: '#' }
        }
      }]
    })
  ];

  for (const invalid of invalidCases) {
    await assert.rejects(
      generateHiddenVariants(compilation, {
        generator,
        requestJson: async () => ({
          candidates: [
            invalid,
            candidate('boundary'),
            candidate('multi-turn')
          ]
        })
      }),
      /part type|turns exceeds|proposed criteria|criterion/iu
    );
  }
});

test('requires a distinct scope-review model identity and all five checks for approval', async () => {
  await assert.rejects(
    reviewHiddenVariantScopes(compilation, [candidate('boundary')], {
      generator,
      scopeReviewer: { ...generator },
      requestJson: async () => ({ decisions: [] })
    }),
    /distinct|identity/iu
  );

  const reviewed = await reviewHiddenVariantScopes(
    compilation,
    [candidate('boundary')],
    {
      generator,
      scopeReviewer,
      requestJson: async () => ({
        decisions: [{
          candidateId: 'risk-boundary',
          checks: {
            sameDomain: true,
            declaredOrDemonstratedCapabilityOnly: true,
            noExternalTruthDependency: true,
            difficultyFromAllowedTransformation: true,
            sameInputForAgentAndReplica: false
          },
          approved: true,
          reasons: ['Input parity was not established.']
        }]
      })
    }
  );

  assert.equal(reviewed.decisions[0].approved, false);
  assert.deepEqual(reviewed.decisions[0].reasons, [
    'Input parity was not established.'
  ]);
});

test('identity keys bind provider kind, base URL host, and model', () => {
  assert.equal(
    reviewerIdentityKey(generator),
    'openai-compatible:models.example:generator-v1'
  );
  assert.notEqual(
    reviewerIdentityKey(generator),
    reviewerIdentityKey(scopeReviewer)
  );
});
