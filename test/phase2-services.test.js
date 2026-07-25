import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAgentExamples } from '../src/example-compiler.js';
import { createPhase2Services } from '../src/phase2-services.js';

const compilation = compileAgentExamples({
  name: 'Agent',
  description: 'Formats input.',
  supportedInterfaces: [{
    url: 'https://agent.example/a2a',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0'
  }]
}, [{
  id: 'format',
  name: 'Format',
  turns: [{
    input: { parts: [{ type: 'text', text: 'Format A and B.' }] },
    acceptanceCriteria: [{
      id: 'table',
      type: 'contains',
      description: 'Returns a table.',
      expected: ['|']
    }]
  }]
}]);

test('demo Phase 2 services deterministically generate, scope, and lock five model identities', async () => {
  const services = createPhase2Services({ env: {} });
  const generated = await services.generateHidden(compilation, { attempt: 0 });
  const scoped = await services.reviewScopes(compilation, generated.candidates);
  const applicable = compilation.rubricChecks.filter((item) => item.applicable);
  const contract = {
    subcriterionIds: [...new Set(applicable.map((item) => item.subcriterionId))],
    checks: applicable,
    evidenceIds: ['ev_a'],
    rubric: {
      dimensions: {
        scenarioValue: {
          agentNecessity: 30,
          researchDecisionValue: 30,
          utilityReuse: 25,
          productNovelty: 15
        },
        professionalism: {
          taskCompletion: 25,
          methodAssumptions: 25,
          evidenceReasoning: 25,
          riskUncertainty: 15,
          artifactUsability: 10
        },
        agentCapability: {
          testSuccess: 30,
          robustness: 20,
          contextContinuity: 15,
          a2aCompliance: 15,
          efficiency: 10,
          claimErrorHandling: 10
        }
      }
    }
  };
  const panel = await services.runPanel({
    contract,
    evidencePackage: {
      evidenceManifest: [{ evidenceId: 'ev_a' }],
      redactedEvidence: [{ evidenceId: 'ev_a', payload: 'result' }]
    }
  });

  assert.deepEqual(
    generated.candidates.map((item) => item.variantType),
    ['equivalent', 'boundary', 'multi-turn']
  );
  assert.equal(generated.candidates.at(-1).turns.length >= 2, true);
  assert.equal(scoped.decisions.every((item) => item.approved), true);
  assert.equal(panel.status, 'model-locked');
  assert.equal(panel.primary.length, 4);
  assert.equal(new Set(panel.primary.map((run) => run.reviewRunId)).size, 4);
  assert.notEqual(services.generatorIdentity, services.scopeReviewerIdentity);
});
