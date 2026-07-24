const rubric = {
  version: 'a2a-black-box-v1',
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
  },
  seatWeights: {
    scenarioValue: { model: 0.4, human: 0.6 },
    professionalism: { model: 0.4, human: 0.6 },
    agentCapability: { objective: 0.5, model: 0.2, human: 0.3 }
  }
};

export const RUBRIC_V1 = deepFreeze(rubric);

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
