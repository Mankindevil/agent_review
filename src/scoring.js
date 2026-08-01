import { average, clamp, round, stableNumber } from './utils.js';
import { CARD_REVIEW_DIMENSIONS, normalizeV1CardReview } from './v1-card-review.js';
import { publicModelFields } from './model-catalog.js';

const COMPLEX_SIGNALS = [
  /行情|财务|指数|行业|交易日历|data skill|数据查询|数据库|api/i,
  /时点|截止日|样本期|滚动窗口|交易日|频率|复权|point.in.time|as.of/i,
  /因子|ic|rank.?ic|分组回测|中性化|标准化|winsori[sz]|factor/i,
  /回测|基准|手续费|滑点|换手|撮合|停牌|涨跌停|backtest/i,
  /组合|持仓|风险暴露|归因|再平衡|回撤|压力测试|portfolio|drawdown/i,
  /多步|multi[- ]?step|workflow|编排|orchestrat|多智能体|agent 协同/i,
  /证据|来源|图表|研究报告|可解释|假设|局限|evidence|source/i,
  /合规|权限|授权数据|投资建议|人工确认|human.in.the.loop|审计|reproduc/i
];
const SIMPLE_SIGNALS = [/查股价|查行情|公司简介|新闻摘要|整理文件|重命名|摘要|翻译|改写|format|summari[sz]e|translate|rename/i];

export function scoreComplexity(card, useCases = []) {
  const text = [card.description, ...(card.skills || []).flatMap((skill) => [skill.name, skill.description, ...(skill.tags || []), ...(skill.examples || [])]), ...useCases.map((item) => item.prompt)].join(' ');
  const complexHits = COMPLEX_SIGNALS.filter((signal) => signal.test(text)).length;
  const simpleHits = SIMPLE_SIGNALS.filter((signal) => signal.test(text)).length;
  const skills = card.skills?.length || 0;
  const capabilityBonus = (card.capabilities?.streaming ? 5 : 0) + (card.capabilities?.pushNotifications ? 6 : 0) + (card.capabilities?.extensions?.length ? 4 : 0);
  const dimensions = {
    researchDepth: clamp(18 + complexHits * 10 - simpleHits * 5),
    dataDependency: clamp(12 + complexHits * 9 + skills * 3),
    temporalState: clamp(10 + complexHits * 8 + capabilityBonus),
    decisionUncertainty: clamp(22 + (useCases.length ? 8 : 0) + complexHits * 5),
    workflowReuse: clamp(26 + skills * 7 + useCases.length * 4 + complexHits * 4)
  };
  const score = round(average(Object.values(dimensions)));
  const verdict = score < 36 ? '模型直出更划算' : score < 60 ? 'Agent 价值存疑' : '值得 Agent 化';
  const reason = score < 36
    ? '任务更像单次行情查询或文本变换，固定投研流程的维护成本高于稳定性收益。'
    : score < 60
      ? '存在数据或多步研究信号，但还需证明时点管理、回测复用与失败恢复价值。'
      : '任务包含数据时点、研究编排、回测或组合风险约束，固定 Agent 工作流有明确价值。';
  return { score, verdict, reason, dimensions };
}

export function mockProfessionalReview(reviewer, card, complexity, evaluationSeed) {
  const seed = `${evaluationSeed ?? 'default'}:${reviewer.id}:${card.name}:${card.description}`;
  const base = stableNumber(seed, 66, 88) + (complexity.score >= 60 ? 2 : -2);
  const dimensions = {
    positioningClarity: clamp(base + stableNumber(`${seed}:positioning`, -7, 6)),
    skillDesign: clamp(base + stableNumber(`${seed}:skills`, -8, 7)),
    protocolCoherence: clamp(base + stableNumber(`${seed}:protocol`, -13, 3)),
    ioExampleQuality: clamp(base + stableNumber(`${seed}:io`, -8, 6)),
    boundaryRiskDisclosure: clamp(base + stableNumber(`${seed}:boundaries`, -9, 6))
  };
  const score = round(average(CARD_REVIEW_DIMENSIONS.map((key) => dimensions[key])));
  const strongest = Object.entries(dimensions).sort((a, b) => b[1] - a[1])[0][0];
  const weakest = Object.entries(dimensions).sort((a, b) => a[1] - b[1])[0][0];
  return {
    reviewer: reviewer.name,
    ...publicModelFields(reviewer.model),
    ...normalizeV1CardReview({
      score,
      dimensions,
      comment: `Agent Card 的${labelDimension(strongest)}是亮点；${labelDimension(weakest)}仍缺少可验证的约束与异常样例。`,
      risk: '仅凭 Agent Card 无法证明真实执行或工具调用成功，必须结合现场对测。'
    }),
    mode: 'demo',
    seed: evaluationSeed
  };
}

// Compatibility-only mock path for retries of historical, versionless records.
export function mockLegacyProfessionalReview(reviewer, card, complexity, evaluationSeed) {
  const seed = `${evaluationSeed ?? 'default'}:${reviewer.id}:${card.name}:${card.description}`;
  const base = stableNumber(seed, 66, 88) + (complexity.score >= 60 ? 2 : -2);
  const dimensions = {
    researchRigor: clamp(base + stableNumber(`${seed}:research`, -7, 6)),
    dataDiscipline: clamp(base + stableNumber(`${seed}:data`, -8, 7)),
    backtestIntegrity: clamp(base + stableNumber(`${seed}:backtest`, -13, 3)),
    riskCompliance: clamp(base + stableNumber(`${seed}:risk`, -8, 6)),
    reproducibility: clamp(base + stableNumber(`${seed}:reproducibility`, -9, 6))
  };
  const score = round(average(Object.values(dimensions)));
  const strongest = Object.entries(dimensions).sort((a, b) => b[1] - a[1])[0][0];
  const weakest = Object.entries(dimensions).sort((a, b) => a[1] - b[1])[0][0];
  return {
    reviewer: reviewer.name,
    ...publicModelFields(reviewer.model),
    score,
    dimensions,
    comment: `能力边界写得清楚，${legacyLabelDimension(strongest)}是亮点；${legacyLabelDimension(weakest)}仍缺少可验证的约束与异常样例。`,
    risk: 'Agent Card 描述无法单独证明真实执行质量，必须结合现场对测。',
    mode: 'demo',
    seed: evaluationSeed
  };
}

// Legacy compatibility scorer only. No new V1 pipeline path may invoke this helper.
export function judgeOutput(prompt, output, identity, dataVerification) {
  const content = String(output || '');
  const taskCompletion = content.length > 80 ? 80 : content.length > 25 ? 66 : 38;
  const baseDataEvidence = /数据来源|来源[:：]|截至|as.?of|样本(?:期|区间)|起止日期|频率|口径|复权|交易日/i.test(content) ? 86 : 48;
  const dataEvidence = verifiedDataScore(baseDataEvidence, dataVerification);
  const methodRigor = /\bIC\b|Rank.?IC|分组回测|基准|年化|最大回撤|夏普|换手|手续费|滑点|因子暴露|风险归因|置信区间/i.test(content) ? 86 : 50;
  const riskDisclosure = /风险提示|假设|局限|不构成.{0,8}投资建议|未来收益|回撤|压力测试|授权数据/i.test(content) ? 88 : 44;
  const score = round(clamp(average([taskCompletion, dataEvidence, methodRigor, riskDisclosure]) + stableNumber(`${identity}:${prompt}`, -4, 4)));
  return { score, dimensions: { taskCompletion, dataEvidence, methodRigor, riskDisclosure } };
}

function verifiedDataScore(baseScore, verification) {
  if (!verification || !Number.isFinite(verification.score)) return baseScore;
  if (verification.status === 'verified') return Math.max(baseScore, 96);
  if (verification.status === 'partial') return round(average([baseScore, verification.score]));
  if (verification.status === 'contradicted') return Math.min(baseScore, round(20 + verification.score * 0.3));
  if (verification.status === 'missing') return Math.min(baseScore, 35);
  return baseScore;
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
    ? '不是研报生成器套壳：它在同题研究里真把 Claude 复刻版压住了。'
    : tier.code === 'ELITE'
      ? '研究链路经得住同题对线，这个 Agent 已经挤出路人局。'
      : tier.code === 'FLOP'
      ? complexity.score < 36
        ? '查一次数据就收工，硬上 Agent 属于给行情快照配基金经理。'
        : '回测图画得挺热闹，结果连豆包研究基线都没守住。'
      : '能跑，但研究证据还没跑出基线包围圈：标准 NPC 表现。';
  return { tier, headline, deltaClaude, deltaDoubao, professionalAverage: round(professionalAverage, 1) };
}

function labelDimension(key) {
  return ({ positioningClarity: '定位清晰度', skillDesign: 'Skills 设计', protocolCoherence: '协议一致性', ioExampleQuality: '输入输出示例质量', boundaryRiskDisclosure: '能力边界与风险披露' })[key] || key;
}

function legacyLabelDimension(key) {
  return ({ researchRigor: '研究严谨性', dataDiscipline: '数据纪律', backtestIntegrity: '回测可信度', riskCompliance: '风险合规', reproducibility: '可复现性' })[key] || key;
}
