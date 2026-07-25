import { RUBRIC_V1, isExecutableCriterion } from './rubric.js';
import { hashCanonical, normalizeAgentExamples } from './submission.js';

const CLAIM_PATTERNS = Object.freeze([
  ['internal-model', /\b(?:llm|model|gpt|claude|deepseek|doubao)\b/iu],
  ['internal-tooling', /\b(?:tool|browser|search|api|database|python|planner|workflow)\b/iu],
  ['memory', /\b(?:memory|cache|ttl)\b/iu],
  ['subagents', /\b(?:sub[- ]?agents?|multi[- ]?agents?|agent team)\b/iu],
  ['prompt-reasoning', /\b(?:prompt|chain of thought|reasoning|planner)\b/iu],
  ['cost-operations', /\b(?:tokens?|cost|cache|retries|retry)\b/iu]
]);

const DOMAIN_PATTERNS = Object.freeze([
  ['quantitative-backtest', /\b(?:backtest|factor series|return series)\b/iu],
  ['portfolio-risk', /\b(?:portfolio|holdings?|concentration|exposure)\b/iu],
  ['document-retrieval', /\b(?:retriev|find|search).*(?:document|filing|clause)|\bcovenant\b/iu],
  ['plain-formatting', /\b(?:format|markdown table|convert).*(?:table|list)|\bmarkdown table\b/iu],
  ['qualitative-research', /\b(?:qualitative|research memo|thesis|strategic risk|management notes)\b/iu]
]);

const CHECK_QUESTIONS = Object.freeze({
  'scenarioValue.agentNecessity': 'Does the observed workflow justify an Agent rather than a single trivial transform?',
  'scenarioValue.researchDecisionValue': 'Does the result help a real research or investment decision within the supplied task?',
  'scenarioValue.utilityReuse': 'Is the observable workflow reusable and practically useful for similar inputs?',
  'scenarioValue.productNovelty': 'Does the public interaction demonstrate a novel product or collaboration effect?',
  'professionalism.taskCompletion': 'Does the delivered result complete the requested task and deliverables?',
  'professionalism.methodAssumptions': 'Are methods, assumptions, and input boundaries explained for this task?',
  'professionalism.evidenceReasoning': 'Are conclusions traceable to supplied inputs and observable evidence?',
  'professionalism.riskUncertainty': 'Are uncertainty, limitations, and material risks stated without inventing facts?',
  'professionalism.artifactUsability': 'Is the delivered artifact structured and usable by its intended reader?',
  'agentCapability.testSuccess': 'Did the Agent satisfy the required executable criteria?',
  'agentCapability.robustness': 'Is observable behavior robust across allowed equivalent and boundary inputs?',
  'agentCapability.contextContinuity': 'Does the Agent retain and correctly update context across the supplied turns?',
  'agentCapability.a2aCompliance': 'Does the Agent follow the observable A2A lifecycle and output contract?',
  'agentCapability.efficiency': 'Does the Agent complete the task within the locked timing policy?',
  'agentCapability.claimErrorHandling': 'Does observable behavior support declared capabilities and recover from protocol errors?'
});

export function compileAgentExamples(agentCard, rawExamples, {
  rubricVersion = RUBRIC_V1.version
} = {}) {
  if (rubricVersion !== RUBRIC_V1.version) {
    throw new TypeError(`unsupported rubricVersion: ${rubricVersion}`);
  }
  if (!isPlainObject(agentCard)) throw new TypeError('agentCard must be an object');

  const examples = normalizeAgentExamples(rawExamples);
  const contracts = examples.map(compileExample);
  const rubricChecks = contracts.flatMap((contract) =>
    buildChecks(contract, rubricVersion)
  );
  const checksByExample = new Map();
  for (const check of rubricChecks) {
    const exampleId = check.sourceRefs[0].slice('example:'.length);
    const current = checksByExample.get(exampleId) || [];
    current.push(check.checkId);
    checksByExample.set(exampleId, current);
  }

  const result = {
    compilationVersion: 'example-compilation/v1',
    rubricVersion,
    sourceHashes: {
      agentCard: hashCanonical(agentCard),
      agentExamples: hashCanonical(examples)
    },
    allowedDomains: [...new Set(contracts.map((contract) => contract.domain))].sort(),
    declaredCapabilities: declaredCapabilities(agentCard),
    contracts: contracts.map((contract) => ({
      ...contract,
      rubricCheckIds: checksByExample.get(contract.exampleId) || []
    })),
    rubricChecks,
    objectiveApplicability: {
      testSuccess: contracts.some((contract) => contract.executableCriteria.length > 0),
      robustness: true,
      contextContinuity: contracts.some((contract) => contract.turnCount > 1),
      a2aCompliance: true,
      efficiency: true,
      claimErrorHandling: true
    },
    unverifiableClaims: collectUnverifiableClaims(agentCard)
  };
  return deepFreeze(result);
}

function compileExample(example) {
  const goal = firstText(example) || example.name;
  const domain = classifyDomain(example, goal);
  const executableCriteria = [];
  const modelCriteria = [];
  const expectedDeliverables = [];

  example.turns.forEach((turn, turnIndex) => {
    if (turn.expectedDeliverable) {
      expectedDeliverables.push({
        turnIndex,
        text: turn.expectedDeliverable,
        sourceRef: `example:${example.id}:turn:${turnIndex}:deliverable`
      });
    }
    turn.acceptanceCriteria.forEach((criterion) => {
      const normalized = {
        criterionId: criterion.id,
        turnIndex,
        type: criterion.type,
        description: criterion.description,
        required: criterion.required,
        sourceRef: `example:${example.id}:turn:${turnIndex}:criterion:${criterion.id}`
      };
      (isExecutableCriterion(criterion) ? executableCriteria : modelCriteria)
        .push(normalized);
    });
  });

  return {
    exampleId: example.id,
    domain,
    goal,
    sourceTurns: structuredClone(example.turns),
    inputSummary: example.turns.map((turn, turnIndex) => ({
      turnIndex,
      partTypes: turn.input.parts.map((part) => part.type)
    })),
    contextPolicy: example.turns.length > 1 ? 'reuse-within-example' : 'fresh',
    turnCount: example.turns.length,
    constraints: example.constraints ? [...example.constraints] : [],
    expectedDeliverables,
    executableCriteria,
    modelCriteria,
    externalTruthVerified: false,
    sourceRefs: [`example:${example.id}`]
  };
}

function buildChecks(contract) {
  const sourceRef = `example:${contract.exampleId}`;
  return Object.entries(RUBRIC_V1.dimensions).flatMap(([dimensionId, subcriteria]) =>
    Object.keys(subcriteria).map((subcriterion) => {
      const subcriterionId = `${dimensionId}.${subcriterion}`;
      const applicable = subcriterionId !== 'agentCapability.contextContinuity'
        || contract.turnCount > 1;
      return {
        checkId: `${contract.exampleId}:${dimensionId}:${subcriterion}`,
        dimensionId,
        subcriterionId,
        question: `${CHECK_QUESTIONS[subcriterionId]} Task: ${contract.goal}`,
        applicable,
        sourceRefs: [sourceRef],
        allowedEvidenceGrades: ['A', 'B', 'C', 'D']
      };
    })
  );
}

function firstText(example) {
  for (const turn of example.turns) {
    const part = turn.input.parts.find((candidate) => candidate.type === 'text');
    if (part) return part.text;
  }
  return null;
}

function classifyDomain(example, goal) {
  const text = [
    example.id,
    example.name,
    goal,
    ...example.turns.flatMap((turn) => [
      turn.expectedDeliverable || '',
      ...turn.acceptanceCriteria.map((criterion) => criterion.description)
    ])
  ].join(' ');
  for (const [domain, pattern] of DOMAIN_PATTERNS) {
    if (pattern.test(text)) return domain;
  }
  return 'general-agent-task';
}

function declaredCapabilities(agentCard) {
  const capabilities = [];
  for (const [name, value] of Object.entries(agentCard.capabilities || {})) {
    if (value === true) capabilities.push(`a2a:${name}`);
  }
  for (const skill of agentCard.skills || []) {
    if (typeof skill?.id === 'string' && skill.id.trim()) {
      capabilities.push(`skill:${skill.id}`);
    }
  }
  return [...new Set(capabilities)].sort();
}

function collectUnverifiableClaims(agentCard) {
  const claims = [];
  for (const entry of stringLeaves(agentCard)) {
    for (const [kind, pattern] of CLAIM_PATTERNS) {
      if (!pattern.test(entry.text)) continue;
      claims.push({
        claimId: `claim:${kind}:${claims.length}`,
        kind,
        evidenceGrade: 'C',
        text: entry.text,
        sourceRef: `agent-card:${entry.path}`
      });
    }
  }
  return claims;
}

function stringLeaves(value, path = '') {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringLeaves(item, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    stringLeaves(child, path ? `${path}.${key}` : key)
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
