import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hiddenScopeReviewPrompt,
  hiddenVariantGenerationPrompt
} from '../src/prompts.js';

const compilation = {
  compilationVersion: 'example-compilation/v1',
  allowedDomains: ['portfolio-risk'],
  contracts: [{
    exampleId: 'portfolio-risk',
    goal: 'Analyze supplied holdings for concentration.',
    sourceTurns: [{
      input: { parts: [{ type: 'text', text: 'Analyze supplied holdings.' }] }
    }]
  }]
};

test('hidden generation prompt freezes scope and requests JSON-only allowed transformations', () => {
  const prompt = hiddenVariantGenerationPrompt(compilation);

  assert.match(prompt, /single JSON object/iu);
  assert.match(prompt, /equivalent/iu);
  assert.match(prompt, /boundary/iu);
  assert.match(prompt, /multi-turn/iu);
  assert.match(prompt, /no browsing|must not browse/iu);
  assert.match(prompt, /new domain/iu);
  assert.match(prompt, /external (?:facts|truth|answer)/iu);
  assert.match(prompt, /"allowedDomains":\["portfolio-risk"\]/u);
});

test('scope prompt exposes candidate changes but not generator rationale', () => {
  const prompt = hiddenScopeReviewPrompt(compilation, [{
    candidateId: 'candidate-1',
    sourceExampleId: 'portfolio-risk',
    variantType: 'boundary',
    changeSummary: 'Use an empty holdings list.',
    generatorRationale: 'Secret chain of thought.',
    turns: [{ input: { parts: [{ type: 'data', data: { holdings: [] } }] } }],
    inheritedCriteriaIds: [],
    proposedCriteria: [],
    timingClass: 'singleTurn'
  }]);

  assert.match(prompt, /Use an empty holdings list/u);
  assert.doesNotMatch(prompt, /Secret chain of thought/u);
  assert.match(prompt, /sameDomain/u);
  assert.match(prompt, /noExternalTruthDependency/u);
  assert.match(prompt, /single JSON object/iu);
});
