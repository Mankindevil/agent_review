import {
  loadSealedArenaMaterials,
  validReplicaIdsFor
} from './arena-release.js';

const DIMENSION_KEYS = ['scenarioValue', 'professionalism', 'agentCapability'];

export function buildAbsoluteReviewDossier(evaluation) {
  if (evaluation?.governance?.phase !== 'human_open') return undefined;

  const modelPanel = evaluation?.absoluteReview?.modelPanel;
  const primary = Array.isArray(modelPanel?.primary) ? modelPanel.primary : [];
  const anchorReviews = primary[0]?.reviews;
  if (modelPanel?.status !== 'model-locked' || !Array.isArray(anchorReviews) || anchorReviews.length === 0) {
    return undefined;
  }

  const dimensions = projectDimensions(modelPanel.dimensions);
  const leaves = anchorReviews.map((anchorReview) => ({
    subcriterionId: anchorReview.subcriterionId,
    seats: primary.map((seat, index) => {
      const review = (seat.reviews || []).find(
        (item) => item?.subcriterionId === anchorReview.subcriterionId
      );
      if (!review) return null;
      const seatEntry = {
        seatId: typeof seat.reviewRunId === 'string' ? seat.reviewRunId : `primary_${index}`,
        score: review.score
      };
      if (typeof seat.name === 'string' && seat.name) seatEntry.name = seat.name;
      if (Number.isFinite(review.confidence)) seatEntry.confidence = review.confidence;
      const finding = review.findings?.[0]?.text;
      if (typeof finding === 'string' && finding) seatEntry.finding = finding;
      return seatEntry;
    }).filter(Boolean)
  }));

  return { dimensions, leaves };
}

export async function buildReplicaReviewDossier(evaluation, { evidenceVault } = {}) {
  const governance = evaluation?.governance;
  const locked = typeof governance?.replicaHumanLockedAt === 'string';
  if (locked || governance?.replicaHumanPhase !== 'replica_human_open') {
    return undefined;
  }

  try {
    const validReplicaIds = validReplicaIdsFor(evaluation.replicaArena);
    const materials = await loadSealedArenaMaterials(
      evaluation,
      validReplicaIds,
      { evidenceVault }
    );
    const cases = buildReplicaCases(materials, validReplicaIds);
    return { cases };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function flattenOutputText(output) {
  if (!output || typeof output !== 'object') return '';
  if (Array.isArray(output.messageParts)) {
    return output.messageParts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  if (typeof output.text === 'string') return output.text;
  return '';
}

export function truncateText(text, limit = 4000) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

function projectDimensions(dimensions) {
  const projected = {};
  for (const key of DIMENSION_KEYS) {
    const score = dimensions?.[key]?.score;
    if (Number.isFinite(score)) projected[key] = { score };
  }
  return projected;
}

function buildReplicaCases({ testPlan, submittedOutputs, replicas }, validReplicaIds) {
  const tests = Array.isArray(testPlan?.tests) ? testPlan.tests : [];
  const submittedByTest = groupOutputsByTest(submittedOutputs);
  const replicaByTest = new Map(
    validReplicaIds.map((runtimeId) => [
      runtimeId,
      groupOutputsByTest(
        (replicas.find((replica) => replica.runtimeId === runtimeId)?.outputs) || []
      )
    ])
  );

  return tests.map((test) => {
    const testId = test.testId;
    const sources = [
      projectSource('submitted', '提交 Agent', pickOutput(submittedByTest.get(testId)))
    ];
    for (const runtimeId of validReplicaIds) {
      sources.push(projectSource(
        `replica:${runtimeId}`,
        undefined,
        pickOutput(replicaByTest.get(runtimeId)?.get(testId))
      ));
    }
    const entry = {
      testId,
      prompt: promptFromTest(test),
      sources
    };
    const title = caseTitle(test);
    if (title) entry.title = title;
    return entry;
  });
}

function projectSource(sourceId, label, output) {
  const flattened = flattenOutputText(output);
  const { text, truncated } = truncateText(flattened);
  const source = { sourceId, text, truncated };
  if (typeof label === 'string' && label) source.label = label;
  return source;
}

function groupOutputsByTest(outputs) {
  const grouped = new Map();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    if (typeof output?.testId !== 'string') continue;
    if (!grouped.has(output.testId)) grouped.set(output.testId, []);
    grouped.get(output.testId).push(output);
  }
  return grouped;
}

function pickOutput(outputsForTest) {
  if (!Array.isArray(outputsForTest) || outputsForTest.length === 0) return null;
  return outputsForTest.find((output) => output.repeatIndex === 0) || outputsForTest[0];
}

function promptFromTest(test) {
  const partSources = [
    test?.input?.parts,
    test?.turns?.[0]?.input?.parts
  ];
  for (const parts of partSources) {
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
    if (text) return text;
  }
  if (typeof test?.prompt === 'string') return test.prompt;
  return '';
}

function caseTitle(test) {
  if (typeof test?.title === 'string' && test.title.trim()) return test.title.trim();
  if (typeof test?.variantType === 'string' && test?.testId) {
    return `${test.variantType} · ${test.testId}`;
  }
  return undefined;
}
