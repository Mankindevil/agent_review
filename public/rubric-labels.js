export const LEAF_LABELS_ZH = Object.freeze({
  'scenarioValue.agentNecessity': 'Agent 必要性',
  'scenarioValue.researchDecisionValue': '投研决策价值',
  'scenarioValue.utilityReuse': '效用与复用',
  'scenarioValue.productNovelty': '产品新颖性',
  'professionalism.taskCompletion': '任务完成度',
  'professionalism.methodAssumptions': '方法与假设',
  'professionalism.evidenceReasoning': '证据推理',
  'professionalism.riskUncertainty': '风险与不确定性',
  'professionalism.artifactUsability': '产物可用性',
  'agentCapability.testSuccess': '测试成功率',
  'agentCapability.robustness': '稳健性',
  'agentCapability.contextContinuity': '上下文连续性',
  'agentCapability.a2aCompliance': 'A2A 合规',
  'agentCapability.efficiency': '效率',
  'agentCapability.claimErrorHandling': '声明与错误恢复'
});

export const DIMENSION_LABELS_ZH = Object.freeze({
  scenarioValue: '任务价值',
  professionalism: '专业度',
  agentCapability: 'Agent 能力'
});

export function labelLeaf(subcriterionId) {
  if (typeof subcriterionId !== 'string' || !subcriterionId) return '未知叶子';
  return LEAF_LABELS_ZH[subcriterionId] || subcriterionId;
}

export function labelDimension(dimensionId) {
  if (typeof dimensionId !== 'string' || !dimensionId) return '维度';
  return DIMENSION_LABELS_ZH[dimensionId] || dimensionId;
}

export function dimensionOfLeaf(subcriterionId) {
  if (typeof subcriterionId !== 'string') return null;
  const dot = subcriterionId.indexOf('.');
  return dot === -1 ? null : subcriterionId.slice(0, dot);
}
