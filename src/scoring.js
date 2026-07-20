import { average, clamp, round, stableNumber } from './utils.js';

const COMPLEX_SIGNALS = [
  /多步|multi[- ]?step|workflow|编排|orchestrat/i,
  /审批|human.in.the.loop|确认|澄清|clarif/i,
  /外部系统|api|database|数据库|检索|browser|工具/i,
  /文件|document|pdf|合同|附件|artifact/i,
  /制度|跨文档|multiple documents|交叉核对|cross[- ]?check/i,
  /证据|风险|冲突|审查|verify|validation|合规/i,
  /状态|记忆|memory|异步|async|long.running/i,
  /规划|plan|分支|重试|retry|监控|monitor/i
];
const SIMPLE_SIGNALS = [/整理文件|重命名|摘要|翻译|改写|分类|format|summari[sz]e|translate|rename/i];

export function scoreComplexity(card, useCases = []) {
  const text = [card.description, ...(card.skills || []).flatMap((skill) => [skill.name, skill.description, ...(skill.tags || []), ...(skill.examples || [])]), ...useCases.map((item) => item.prompt)].join(' ');
  const complexHits = COMPLEX_SIGNALS.filter((signal) => signal.test(text)).length;
  const simpleHits = SIMPLE_SIGNALS.filter((signal) => signal.test(text)).length;
  const skills = card.skills?.length || 0;
  const capabilityBonus = (card.capabilities?.streaming ? 5 : 0) + (card.capabilities?.pushNotifications ? 6 : 0) + (card.capabilities?.extensions?.length ? 4 : 0);
  const dimensions = {
    stepDepth: clamp(18 + complexHits * 10 - simpleHits * 5),
    toolDependency: clamp(12 + complexHits * 9 + skills * 3),
    stateAndBranching: clamp(10 + complexHits * 8 + capabilityBonus),
    uncertainty: clamp(22 + (useCases.length ? 8 : 0) + complexHits * 5),
    repeatValue: clamp(26 + skills * 7 + useCases.length * 4 + complexHits * 4)
  };
  const score = round(average(Object.values(dimensions)));
  const verdict = score < 36 ? '模型直出更划算' : score < 60 ? 'Agent 价值存疑' : '值得 Agent 化';
  const reason = score < 36
    ? '任务大多是单轮变换，固定流程带来的维护成本高于稳定性收益。'
    : score < 60
      ? '存在一些工具或多步信号，但还需证明流程复用率与失败恢复价值。'
      : '任务包含多步决策、外部依赖或状态管理，Agent 编排能提供稳定收益。';
  return { score, verdict, reason, dimensions };
}

export function mockProfessionalReview(reviewer, card, complexity) {
  const seed = `${reviewer.id}:${card.name}:${card.description}`;
  const base = stableNumber(seed, 66, 88) + (complexity.score >= 60 ? 2 : -2);
  const dimensions = {
    domainDepth: clamp(base + stableNumber(`${seed}:depth`, -7, 6)),
    workflowQuality: clamp(base + stableNumber(`${seed}:workflow`, -8, 7)),
    failureHandling: clamp(base + stableNumber(`${seed}:failure`, -13, 3)),
    outputContract: clamp(base + stableNumber(`${seed}:contract`, -8, 6)),
    evaluability: clamp(base + stableNumber(`${seed}:eval`, -9, 6))
  };
  const score = round(average(Object.values(dimensions)));
  const strongest = Object.entries(dimensions).sort((a, b) => b[1] - a[1])[0][0];
  const weakest = Object.entries(dimensions).sort((a, b) => a[1] - b[1])[0][0];
  return {
    reviewer: reviewer.name,
    model: reviewer.model,
    score,
    dimensions,
    comment: `能力边界写得清楚，${labelDimension(strongest)}是亮点；${labelDimension(weakest)}仍缺少可验证的约束与异常样例。`,
    risk: 'Agent Card 描述无法单独证明真实执行质量，必须结合现场对测。',
    mode: 'demo'
  };
}

export function judgeOutput(prompt, output, identity) {
  const content = String(output || '');
  const lengthFit = clamp(45 + Math.min(content.length, 900) / 30);
  const structure = /\n|[-*]\s|\d+[.)]/.test(content) ? 82 : 62;
  const evidence = /因为|依据|evidence|source|文件|步骤|结果/i.test(content) ? 83 : 60;
  const instruction = content.length > 25 ? 76 : 42;
  const score = round(clamp(average([lengthFit, structure, evidence, instruction]) + stableNumber(`${identity}:${prompt}`, -5, 5)));
  return { score, dimensions: { taskCompletion: instruction, reasoningEvidence: evidence, structure, usefulness: round(lengthFit) } };
}

export function buildRoast(submittedAverage, claudeAverage, doubaoAverage, professionalAverage, complexity) {
  const deltaClaude = round(submittedAverage - claudeAverage, 1);
  const deltaDoubao = round(submittedAverage - doubaoAverage, 1);
  let tier;
  if (complexity.score < 36) {
    tier = { code: 'FLOP', label: '拉', tone: 'danger', stamp: '拉' };
  } else if (deltaClaude >= 3) {
    tier = { code: 'HARD', label: '夯', tone: 'excellent', stamp: '夯' };
  } else if (deltaClaude >= 0) {
    tier = { code: 'ELITE', label: '人上人', tone: 'great', stamp: '人上人' };
  } else if (deltaDoubao < 0) {
    tier = { code: 'FLOP', label: '拉', tone: 'danger', stamp: '拉' };
  } else {
    tier = { code: 'NPC', label: 'NPC', tone: 'neutral', stamp: 'NPC' };
  }
  const headline = tier.code === 'HARD'
    ? '不是套壳：它在同题对打里真把 Claude 复刻版压住了。'
    : tier.code === 'ELITE'
      ? '能和 Claude 正面对线，这个 Agent 已经挤出路人局。'
    : tier.code === 'FLOP'
      ? complexity.score < 36
        ? '这活一个好提示词就能干，硬上 Agent 属于给订书机装自动驾驶。'
        : '流程画得挺热闹，结果连豆包基线都没守住。'
      : '能跑，但还没跑出基线包围圈：标准 NPC 表现。';
  return { tier, headline, deltaClaude, deltaDoubao, professionalAverage: round(professionalAverage, 1) };
}

function labelDimension(key) {
  return ({ domainDepth: '领域深度', workflowQuality: '流程设计', failureHandling: '异常处理', outputContract: '输出契约', evaluability: '可评测性' })[key] || key;
}
