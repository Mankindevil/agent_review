import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANONYMOUS_ARENA_SYSTEM_PROMPT,
  absolutePanelPrompt,
  arenaComparisonPrompt,
  hiddenScopeReviewPrompt,
  hiddenVariantGenerationPrompt,
  humorRewritePrompt,
  replicaBuildPrompt,
  replicaRunPrompt
} from '../src/prompts.js';

const compilation = {
  compilationVersion: 'example-compilation/v1',
  allowedDomains: ['portfolio-risk'],
  contracts: [{
    exampleId: 'portfolio-risk',
    goal: 'Analyze supplied holdings for concentration.',
    turnCount: 1,
    executableCriteria: [{ criterionId: 'risk-word', type: 'contains' }],
    modelCriteria: [],
    sourceTurns: [{
      input: { parts: [{ type: 'text', text: 'Analyze supplied holdings.' }] }
    }]
  }]
};

test('hidden generation prompt freezes scope and requests JSON-only allowed transformations', () => {
  const prompt = hiddenVariantGenerationPrompt(compilation);

  assert.match(prompt, /ONE JSON object|single JSON object/iu);
  assert.match(prompt, /equivalent/iu);
  assert.match(prompt, /boundary/iu);
  assert.match(prompt, /multi-turn/iu);
  assert.match(prompt, /must not browse|Forbidden: browse/iu);
  assert.match(prompt, /new domain/iu);
  assert.match(prompt, /external (?:facts|truth|answer)/iu);
  assert.match(prompt, /ALLOWED_SLOTS/u);
  assert.match(prompt, /allowedInheritedCriteriaIds/u);
  assert.match(prompt, /"risk-word"/u);
  assert.match(prompt, /Do NOT invent criterion ids/u);
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
  assert.match(prompt, /ONE JSON object|single JSON object/iu);
  assert.match(prompt, /ALLOWED_CANDIDATE_IDS/u);
  assert.match(prompt, /"candidate-1"/u);
});

test('absolute panel prompt includes only evidence-safe fields and forbids outside fact checking', () => {
  const prompt = absolutePanelPrompt(
    [{ checkId: 'risk', subcriterionId: 'professionalism.evidenceReasoning' }],
    {
      submission: { redactedCard: { name: 'Agent' }, redactedExamples: [] },
      testCatalog: [],
      evidenceManifest: [{ evidenceId: 'ev_a' }],
      redactedEvidence: [{ evidenceId: 'ev_a', text: 'result' }],
      objectiveCapability: { score: 80 },
      replicaArena: { secret: true },
      runtimeBuild: { secret: true }
    },
    { disputedSubcriterionIds: [] }
  );

  assert.match(prompt, /No browsing|must not browse|no browsing/iu);
  assert.match(prompt, /outside fact|external fact|outside facts/iu);
  assert.match(prompt, /"evidenceId":"ev_a"/u);
  assert.match(prompt, /REQUIRED_SUBCRITERION_IDS/u);
  assert.match(prompt, /ALLOWED_EVIDENCE_IDS/u);
  assert.match(prompt, /professionalism\.evidenceReasoning/u);
  assert.doesNotMatch(prompt, /replicaArena|runtimeBuild/u);
});

test('humor rewrite prompt contains only locked findings and forbids score changes', () => {
  const prompt = humorRewritePrompt([{
    subcriterionId: 'scenarioValue.agentNecessity',
    sourceFindings: [{
      findingId: 'finding_1',
      text: 'Captured evidence lacks a reusable workflow.'
    }],
    repairSuggestion: 'Document the workflow.'
  }]);

  assert.match(prompt, /finding_1/u);
  assert.match(prompt, /rewrite \(not extend\)|rewrite.*not extend|不得.*扩展/iu);
  assert.match(prompt, /score|分数/iu);
  assert.match(prompt, /"items"/u);
  assert.match(prompt, /ALLOWED_FINDING_IDS/u);
  assert.doesNotMatch(prompt, /raw evidence|Replica output|model score|human score|total/iu);
});

test('arena prompt compares anonymous results only and requires one strict JSON result', () => {
  const prompt = arenaComparisonPrompt({
    task: {
      input: { parts: [{ type: 'text', text: 'Review supplied positions.' }] },
      constraints: ['Use only supplied positions.'],
      expectedDeliverable: 'Risk review.'
    },
    candidates: [{ candidateId: 'candidate-abc12345', output: { messageParts: [{ type: 'text', text: 'Result.' }] } }]
  });

  assert.match(ANONYMOUS_ARENA_SYSTEM_PROMPT, /Compare only shared task result quality|compare.*task result quality/iu);
  assert.match(ANONYMOUS_ARENA_SYSTEM_PROMPT, /protocol.*latency.*identity/iu);
  assert.match(ANONYMOUS_ARENA_SYSTEM_PROMPT, /do not browse|Do not browse/iu);
  assert.match(ANONYMOUS_ARENA_SYSTEM_PROMPT, /ONE JSON object|JSON object only|one JSON object/iu);
  assert.match(prompt, /candidate-abc12345/u);
  assert.match(prompt, /ALLOWED_CANDIDATE_IDS/u);
  assert.match(prompt, /taskConstraint/u);
  assert.match(prompt, /artifactUsability/u);
});

test('replica prompts contain only supplied public build material and current-turn context history', () => {
  const build = replicaBuildPrompt({ agent: { name: 'Public Agent' }, manifest: { contentHash: 'a'.repeat(64) } }, { maxTokens: 16_000, network: 'none' });
  assert.match(build, /Public Agent/u);
  assert.match(build, /only the supplied public material|supplied public material/iu);
  assert.match(build, /OUTPUT CONTRACT/u);
  assert.match(build, /network/iu);

  const run = replicaRunPrompt(
    { artifactId: 'artifact-1', skill: { name: 'Public Skill' }, futureTest: 'FUTURE_TEST_SENTINEL', submittedOutput: 'SUBMITTED_OUTPUT_SENTINEL', score: 99 },
    { parts: [{ type: 'text', text: 'CURRENT_TURN_ONLY' }] },
    [{
      input: { parts: [{ type: 'text', text: 'PRIOR_TURN_ONLY' }], futureTest: 'HISTORY_FUTURE_SENTINEL' },
      output: { messageParts: [{ type: 'text', text: 'prior reply' }], submittedOutput: 'HISTORY_OUTPUT_SENTINEL', score: 9 }
    }],
    { maxTokens: 8_000, network: 'none', score: 'BUDGET_SCORE_SENTINEL' }
  );
  assert.match(run, /CURRENT_TURN_ONLY|current turn/iu);
  assert.match(run, /PRIOR_TURN_ONLY|prior history/iu);
  assert.doesNotMatch(run, /FUTURE_TEST_SENTINEL|SUBMITTED_OUTPUT_SENTINEL|HISTORY_FUTURE_SENTINEL|HISTORY_OUTPUT_SENTINEL|"score":(?:99|9)/iu);
});

test('replica prompts project Part allowlists rather than serializing unknown nested input or history fields', () => {
  const prompt = replicaRunPrompt(
    { artifactId: 'a', runtimeId: 'r', skill: { name: 's' }, files: [] },
    { parts: [{ type: 'text', text: 'current', injected: 'CURRENT_INJECTION' }], criteriaAnswers: 'CRITERIA_SENTINEL', nested: { future: 'FUTURE_SENTINEL' } },
    [{ input: { parts: [{ type: 'text', text: 'prior', hidden: 'HISTORY_INJECTION' }], score: 100 }, output: { messageParts: [{ type: 'text', text: 'response', review: 'REVIEW_INJECTION' }] } }],
    { maxTokens: 8_000, network: 'none' }
  );
  assert.match(prompt, /current|prior|response/u);
  assert.doesNotMatch(prompt, /CURRENT_INJECTION|CRITERIA_SENTINEL|FUTURE_SENTINEL|HISTORY_INJECTION|REVIEW_INJECTION/u);
});

test('replica prompts preserve only the exact Task 1 snapshot URL-Part shape', () => {
  const snapshot = { reference: 'snapshot_123', mediaType: 'text/csv', byteLength: 128, sha256: 'a'.repeat(64) };
  const prompt = replicaRunPrompt({ artifactId: 'a', runtimeId: 'r', skill: { name: 's' }, files: [] }, {
    parts: [{ type: 'url', snapshot, injected: 'nope' }]
  }, [], { maxTokens: 8_000, network: 'none' });
  assert.match(prompt, /snapshot_123/u);
  assert.doesNotMatch(prompt, /injected/u);

  for (const snapshot of [
    { reference: 'snapshot_123', mediaType: 'not mime', byteLength: 1, sha256: 'a'.repeat(64) },
    { reference: 'snapshot_123', mediaType: 'text/csv', byteLength: 2 * 1024 * 1024 + 1, sha256: 'a'.repeat(64) }
  ]) {
    const invalid = replicaRunPrompt({ artifactId: 'a', runtimeId: 'r', skill: { name: 's' }, files: [] }, { parts: [{ type: 'url', snapshot }] }, [], { maxTokens: 8_000, network: 'none' });
    assert.doesNotMatch(invalid, /snapshot_123/u);
  }
});
