import { createHash } from 'node:crypto';

const STAGES = [
  ['replaceOrCorrectEvidence', 'replacement-completed'],
  ['reevaluateAcceptance', 'evidence-recomputed'],
  ['recomputeObjective', 'evidence-recomputed'],
  ['runModelReviews', 'model-rereview'],
  ['assignHumanReviews', 'human-rereview'],
  ['arbitrateHumanReviews', 'human-rereview'],
  ['lockAbsolute', 'absolute-relocked'],
  ['rejudgeArena', 'arena-rejudged'],
  ['bootstrapReplica', 'arena-rejudged'],
  ['calculateRating', 'arena-rejudged'],
  ['generateHumor', 'arena-rejudged']
];

export async function runAppealResultVersion(evaluation, appeal, services) {
  if (!evaluation?.resultV2?.absolute?.resultHash) {
    throw new TypeError('a locked absolute result is required before appeal recalculation');
  }
  if (!appeal?.appealId) throw new TypeError('appeal ID is required');
  let context = { evaluation, appeal };
  const outputs = {};
  for (const [name, status] of STAGES) {
    if (typeof services?.[name] !== 'function') throw new TypeError(`${name} service is required`);
    const output = await services[name](context);
    outputs[name] = output;
    context = { ...context, [name]: output, outputs };
    appeal.status = status;
  }
  const absolute = outputs.lockAbsolute;
  if (!absolute?.resultHash) throw new TypeError('appeal absolute lock must return a resultHash');
  const version = {
    version: (evaluation.resultV2.resultVersions || []).length + 1,
    supersedesResultHash: evaluation.resultV2.absolute.resultHash,
    reason: `appeal:${appeal.appealId}`,
    absolute,
    replica: outputs.rejudgeArena,
    rating: outputs.calculateRating,
    humor: outputs.generateHumor,
    createdAt: new Date().toISOString(),
    resultHash: absolute.resultHash
  };
  if (!Array.isArray(evaluation.resultV2.resultVersions)) {
    evaluation.resultV2.resultVersions = [];
  }
  evaluation.resultV2.resultVersions.push(Object.freeze(structuredClone(version)));
  appendEvent(evaluation, appeal, 'result-version-appended', version);
  return version;
}

function appendEvent(evaluation, appeal, type, payload) {
  const event = {
    eventId: `appeal_result_${createHash('sha256').update(`${appeal.appealId}:${Date.now()}:${type}`).digest('hex').slice(0, 24)}`,
    appealId: appeal.appealId,
    type,
    at: new Date().toISOString(),
    payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  };
  if (!Array.isArray(appeal.events)) appeal.events = [];
  appeal.events.push(event);
  if (!Array.isArray(evaluation.appealEvents)) evaluation.appealEvents = [];
  evaluation.appealEvents.push(event);
}
