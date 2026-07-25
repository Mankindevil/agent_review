import { intervalCrossesThreshold } from './statistics.js';

const RUBRIC_VERSION = 'a2a-black-box-v1';

export function classifyDualTrackRating(input = {}) {
  if (input.eligibilityStatus !== 'eligible') {
    return rating('ineligible', 'INELIGIBLE', '未通过参评资格', ['参评资格未通过'], null);
  }
  const replicaAdvantage = input.replicaAdvantage;
  if (replicaAdvantage?.status !== 'ready') {
    return rating('pending-replica', 'PENDING_REPLICA', '待复刻', ['没有有效复刻基线'], null);
  }

  const absoluteTotal = finite(input.absoluteTotal, 'absoluteTotal');
  const scenarioScore = finite(input.scenarioScore, 'scenarioScore');
  const objectiveCoverage = finite(input.objectiveCoverage, 'objectiveCoverage');
  const conservativeDelta = finite(replicaAdvantage.conservativeDelta, 'replicaAdvantage.conservativeDelta');
  const interval = replicaAdvantage.interval;
  const criteria = [
    {
      code: 'HARD',
      label: '夯',
      matches: absoluteTotal >= 80 && scenarioScore >= 60 && objectiveCoverage >= 0.70 && conservativeDelta >= 5,
      thresholds: [5],
      reasons: ['三维总分、场景价值、客观能力覆盖率与保守复刻优势均达到夯标准']
    },
    {
      code: 'ELITE',
      label: '人上人',
      matches: absoluteTotal >= 70 && scenarioScore >= 50 && conservativeDelta >= -2,
      thresholds: [-2, 5],
      reasons: ['三维总分、场景价值与保守复刻优势达到人上人标准']
    },
    {
      code: 'NPC',
      label: 'NPC',
      matches: absoluteTotal >= 55 && scenarioScore >= 36 && conservativeDelta >= -10,
      thresholds: [-10, -2],
      reasons: ['三维总分、场景价值与保守复刻优势达到 NPC 标准']
    },
    {
      code: 'FLOP',
      label: '拉',
      matches: true,
      thresholds: [-10],
      reasons: ['未达到更高评级的保守门槛']
    }
  ];
  const awarded = criteria.find((criterion) => criterion.matches);
  const differenceStable = interval
    ? !awarded.thresholds.some((threshold) => intervalCrossesThreshold(interval, threshold))
    : null;
  return rating('final', awarded.code, awarded.label, awarded.reasons, differenceStable);
}

function rating(status, code, label, reasons, differenceStable) {
  return {
    status,
    code,
    label,
    reasons,
    rubricVersion: RUBRIC_VERSION,
    differenceStable
  };
}

function finite(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  return value;
}
