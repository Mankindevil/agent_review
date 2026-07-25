import {
  generateHiddenVariants,
  reviewHiddenVariantScopes
} from './hidden-tests.js';
import { runModelPanel } from './judge-panel.js';
import { absolutePanelPrompt } from './prompts.js';
import {
  configuredReviewPanel,
  requestJson
} from './providers.js';
import { readA2AExecutionTuning } from './execution-tuning.js';

export function createPhase2Services({
  env = process.env,
  requestJsonFn = requestJson
} = {}) {
  const panel = configuredReviewPanel(env);
  const generator = panel.primary[0];
  const scopeReviewer = panel.primary[1];
  const demo = panel.mode === 'demo';
  const tuning = readA2AExecutionTuning(env);
  return Object.freeze({
    enabled: true,
    generatorIdentity: generator.identityKey,
    scopeReviewerIdentity: scopeReviewer.identityKey,
    multiTurnEnabled: tuning.multiTurnEnabled,
    repeatCount: tuning.repeatCount,
    requiredHiddenVariants: tuning.requiredHiddenVariants,
    seed: Number.isSafeInteger(Number(env.EVALUATION_SEED))
      ? Number(env.EVALUATION_SEED)
      : null,
    async generateHidden(compilation, { attempt = 0 } = {}) {
      if (demo) {
        return {
          generatorIdentity: generator.identityKey,
          candidates: deterministicCandidates(
            compilation,
            attempt,
            tuning.requiredHiddenVariants
          )
        };
      }
      return generateHiddenVariants(compilation, {
        generator,
        requiredVariants: tuning.requiredHiddenVariants,
        requestJson: (reviewer, system, prompt) =>
          requestJsonFn(reviewer, system, prompt, undefined, {
            seed: deriveAttemptSeed(env, attempt, 11),
            temperature: 0,
            maxTokens: Number(env.MODEL_REVIEW_MAX_TOKENS || 6000)
          })
      });
    },
    async reviewScopes(compilation, candidates, { attempt = 0 } = {}) {
      if (demo) {
        return {
          generatorIdentity: generator.identityKey,
          scopeReviewerIdentity: scopeReviewer.identityKey,
          decisions: candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            checks: {
              sameDomain: true,
              declaredOrDemonstratedCapabilityOnly: true,
              noExternalTruthDependency: true,
              difficultyFromAllowedTransformation: true,
              sameInputForAgentAndReplica: true
            },
            approved: true,
            reasons: []
          }))
        };
      }
      return reviewHiddenVariantScopes(compilation, candidates, {
        generator,
        scopeReviewer,
        requestJson: (reviewer, system, prompt) =>
          requestJsonFn(reviewer, system, prompt, undefined, {
            seed: deriveAttemptSeed(env, attempt, 29),
            temperature: 0,
            maxTokens: Number(env.MODEL_REVIEW_MAX_TOKENS || 6000)
          })
      });
    },
    async runPanel({ contract, evidencePackage }) {
      let invocationIndex = 0;
      return runModelPanel({
        panel,
        contract,
        evidencePackage,
        invoke: async (reviewer, packet) => {
          const index = invocationIndex++;
          if (demo) return deterministicPanelAnswer(
            packet.contract,
            reviewer,
            index
          );
          const prompt = absolutePanelPrompt(
            packet.contract.checks,
            packet.evidencePackage,
            {
              disputedSubcriterionIds: packet.disputedSubcriterionIds || [],
              rubricVersion: 'a2a-black-box-v1'
            }
          );
          return requestJsonFn(
            reviewer,
            'Independent A2A black-box evaluation. JSON only.',
            prompt,
            undefined,
            {
              seed: deriveAttemptSeed(env, index, 47),
              temperature: 0,
              maxTokens: Number(env.MODEL_REVIEW_MAX_TOKENS || 6000)
            }
          );
        }
      });
    }
  });
}

function deterministicCandidates(
  compilation,
  attempt,
  requiredVariants = ['equivalent', 'boundary', 'multi-turn']
) {
  return compilation.contracts.flatMap((contract) => {
    const inheritedCriteriaIds = [
      ...contract.executableCriteria,
      ...contract.modelCriteria
    ].map((criterion) => criterion.criterionId);
    const baseTurns = structuredClone(contract.sourceTurns);
    const byType = {
      equivalent: candidate(
        contract,
        'equivalent',
        appendInstruction(
          baseTurns,
          'Use an equivalent wording and preserve the requested deliverable.'
        ),
        inheritedCriteriaIds,
        attempt
      ),
      boundary: candidate(
        contract,
        'boundary',
        appendInstruction(
          baseTurns,
          'Handle the smallest in-scope input without inventing missing facts.'
        ),
        inheritedCriteriaIds,
        attempt
      ),
      'multi-turn': candidate(
        contract,
        'multi-turn',
        [
          ...structuredClone(baseTurns),
          {
            input: {
              parts: [{
                type: 'text',
                text: 'Revise the prior result using the same supplied context and state what changed.'
              }]
            },
            acceptanceCriteria: []
          }
        ],
        inheritedCriteriaIds,
        attempt
      )
    };
    return requiredVariants.map((variantType) => byType[variantType]);
  });
}

function candidate(contract, variantType, turns, inheritedCriteriaIds, attempt) {
  return {
    candidateId: `${safeId(contract.exampleId)}_${variantType.replace('-', '_')}_${attempt}`,
    sourceExampleId: contract.exampleId,
    variantType,
    changeSummary: `${variantType} closed-scope transformation`,
    turns,
    inheritedCriteriaIds,
    proposedCriteria: [],
    timingClass: variantType === 'multi-turn' ? 'multiTurn' : 'singleTurn'
  };
}

function appendInstruction(turns, instruction) {
  const result = structuredClone(turns);
  const first = result[0];
  first.input.parts.push({ type: 'text', text: instruction });
  return result;
}

function demoFindingText(reviewer, subcriterionId, index, score) {
  const name = reviewer.name || reviewer.id || `seat-${index}`;
  const leaf = String(subcriterionId || 'leaf').split('.').pop();
  const tones = [
    `在「${leaf}」上能对上提交证据，但叙述偏稳、锋芒不够。`,
    `「${leaf}」有可复查引用，关键断言偶尔跨一步，分数按证据收着给。`,
    `「${leaf}」主结论成立，边界与反证交代偏薄。`,
    `「${leaf}」能跑通链路，和任务必要性的咬合还不够紧。`
  ];
  return `${name}（demo ${score}）：${tones[index % tones.length]}`;
}

function demoRepairSuggestion(subcriterionId, index) {
  const leaf = String(subcriterionId || 'leaf').split('.').pop();
  const fixes = [
    `把「${leaf}」的证据→结论映射写死到可复查 check。`,
    `收窄「${leaf}」结论范围，补一条反证或不确定性声明。`,
    `为「${leaf}」补齐边界用例对照，避免只报乐观路径。`,
    `在「${leaf}」里显式标出假设、限制与修复步骤。`
  ];
  return fixes[index % fixes.length];
}

function deterministicPanelAnswer(contract, reviewer, index) {
  const allowedEvidence = contract.evidenceIds || [];
  const primaryEvidence = allowedEvidence.slice(0, 2);
  const score = 70 + (index % 4) * 2;
  return {
    reviews: contract.subcriterionIds.map((subcriterionId) => ({
      subcriterionId,
      score,
      confidence: 0.72 + (index % 3) * 0.04,
      evidenceIds: primaryEvidence,
      checkEvidence: contract.checks
        .filter((check) => check.subcriterionId === subcriterionId)
        .map((check) => ({
          checkId: check.checkId,
          evidenceIds: primaryEvidence
        })),
      findings: [{
        text: demoFindingText(reviewer, subcriterionId, index, score),
        evidenceIds: primaryEvidence
      }],
      counterEvidence: [],
      uncertainties: [
        'External factual truth was not added to the supplied evidence.'
      ],
      repairSuggestion: demoRepairSuggestion(subcriterionId, index),
      conclusions: {
        taskCompleted: 'partial',
        criticalRisk: 'uncertain'
      }
    }))
  };
}

function deriveAttemptSeed(env, attempt, salt) {
  const base = Number(env.EVALUATION_SEED);
  if (!Number.isSafeInteger(base)) return undefined;
  return (base + attempt * 997 + salt) % 2_147_483_647;
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/gu, '_');
}
