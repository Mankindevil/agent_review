/**
 * Released-only Replica detail helpers for the public result page.
 * Thin metadata is attached at finalize; Skill bodies and full outputs
 * are loaded on demand via dedicated routes.
 */

export async function buildReleasedReplicaPublicDetail(
  evaluation,
  validReplicaIds,
  scoreCells,
  services = {}
) {
  const skills = await loadSkillMetadata(evaluation, validReplicaIds, services);
  const cases = buildCaseMetadata(evaluation, validReplicaIds, scoreCells);
  return { skills, cases };
}

export function assertReplicaDetailReleased(evaluation) {
  const released = evaluation?.resultV2?.replica?.status === 'released' &&
    typeof evaluation?.governance?.replicaReleasedAt === 'string' &&
    evaluation?.resultV2?.absolute?.status === 'locked';
  if (!released) {
    const error = new Error('Replica detail is only available after dual-track release');
    error.statusCode = 409;
    throw error;
  }
}

export async function loadReplicaSkillBundle(evaluation, runtimeId, services = {}) {
  assertReplicaDetailReleased(evaluation);
  const id = requiredText(runtimeId, 'runtimeId');
  if (!validReplicaIdsFor(evaluation).includes(id)) {
    const error = new Error('Replica runtime is not a released valid baseline');
    error.statusCode = 404;
    throw error;
  }
  const artifact = await loadRuntimeArtifact(evaluation, id, services);
  const skill = artifact?.skill || {};
  const skillName = String(skill.name || 'replica-skill').trim() || 'replica-skill';
  const files = Array.isArray(artifact?.files) && artifact.files.length
    ? artifact.files.map((file) => ({
      path: String(file.path || 'file'),
      language: guessLanguage(file.path, file.mediaType),
      content: typeof file.content === 'string'
        ? file.content
        : typeof file.text === 'string'
          ? file.text
          : JSON.stringify(file.content ?? '', null, 2)
    }))
    : [{
      path: 'SKILL.md',
      language: 'markdown',
      content: skillMarkdown(skill)
    }];
  return {
    runtimeId: id,
    skillName,
    root: slug(skillName),
    source: 'replica-vault',
    inputPolicy: 'description-only',
    legacyBaseline: false,
    files
  };
}

export async function loadReplicaCaseOutputs(
  evaluation,
  testId,
  repeatIndex,
  services = {}
) {
  assertReplicaDetailReleased(evaluation);
  const tid = requiredText(testId, 'testId');
  const repeat = requiredRepeatIndex(repeatIndex);
  const validReplicaIds = validReplicaIdsFor(evaluation);
  const evidenceVault = requireVault(evaluation, services);
  const submitted = submittedOutputFor(evaluation, tid, repeat);
  const sources = [
    {
      sourceId: 'submitted',
      score: scoreFor(evaluation, tid, repeat, 'submitted'),
      output: submitted
    }
  ];
  for (const runtimeId of validReplicaIds) {
    sources.push({
      sourceId: `replica:${runtimeId}`,
      score: scoreFor(evaluation, tid, repeat, `replica:${runtimeId}`),
      output: await replicaOutputFor(evaluation, runtimeId, tid, repeat, evidenceVault)
    });
  }
  return { testId: tid, repeatIndex: repeat, sources };
}

async function loadSkillMetadata(evaluation, validReplicaIds, services) {
  const skills = [];
  for (const runtimeId of validReplicaIds) {
    try {
      const artifact = await loadRuntimeArtifact(evaluation, runtimeId, services);
      skills.push({
        runtimeId,
        runtimeName: runtimeId,
        skillName: String(artifact?.skill?.name || 'replica-skill').trim() || 'replica-skill',
        validity: 'valid'
      });
    } catch {
      skills.push({
        runtimeId,
        runtimeName: runtimeId,
        skillName: 'replica-skill',
        validity: 'valid'
      });
    }
  }
  return skills;
}

function buildCaseMetadata(evaluation, validReplicaIds, scoreCells) {
  const tests = Array.isArray(evaluation?.testPlan?.tests) ? evaluation.testPlan.tests : [];
  const byId = new Map(tests.map((test) => [test.testId, test]));
  return (Array.isArray(scoreCells) ? scoreCells : []).map((cell) => {
    const test = byId.get(cell.testId);
    const prompt = promptFromTest(test);
    const scores = { submitted: cell.scores?.submitted };
    for (const runtimeId of validReplicaIds) {
      const key = `replica:${runtimeId}`;
      if (Number.isFinite(cell.scores?.[key])) scores[key] = cell.scores[key];
    }
    return {
      testId: cell.testId,
      repeatIndex: cell.repeatIndex,
      title: caseTitle(test, cell),
      prompt,
      scores
    };
  });
}

function caseTitle(test, cell) {
  if (test?.variantType) return `${test.variantType} · ${cell.testId}`;
  return cell.testId;
}

function promptFromTest(test) {
  const parts = test?.turns?.[0]?.input?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .slice(0, 2000);
}

async function loadRuntimeArtifact(evaluation, runtimeId, services) {
  const commitment = evaluation?.replicaCheckpoint?.builds?.[runtimeId]?.artifactCommitment;
  if (!commitment?.evidenceId || !commitment?.recordHash) {
    const summary = (evaluation?.replicaArena?.runtimeSummaries || [])
      .find((item) => item?.runtimeId === runtimeId);
    const evidenceId = summary?.artifactEvidenceIds?.[0];
    if (!evidenceId) throw new Error('Replica artifact commitment missing');
    const vault = requireVault(evaluation, services);
    const record = await vault.get(evidenceId);
    return record?.payload?.artifact || null;
  }
  const vault = requireVault(evaluation, services);
  const record = await vault.get(commitment.evidenceId, commitment.recordHash);
  return record?.payload?.artifact || null;
}

function submittedOutputFor(evaluation, testId, repeatIndex) {
  const testRun = (evaluation?.phase2Execution?.testRuns || []).find(
    (item) => item?.testId === testId && item?.repeatIndex === repeatIndex
  );
  const output = testRun?.runs?.at(-1)?.response?.currentOutput;
  return normalizeOutput(output, 'submitted');
}

async function replicaOutputFor(evaluation, runtimeId, testId, repeatIndex, evidenceVault) {
  const turns = Object.values(evaluation?.replicaCheckpoint?.turns || {});
  let latest = null;
  for (const turn of turns) {
    if (turn?.runtimeId !== runtimeId || turn?.testId !== testId || turn?.repeatIndex !== repeatIndex) {
      continue;
    }
    if (!latest || turn.turnIndex > latest.turnIndex) latest = turn;
  }
  if (!latest?.resultCommitment?.evidenceId) {
    return { messageParts: [{ type: 'text', text: '（无复刻输出）' }] };
  }
  const record = await evidenceVault.get(
    latest.resultCommitment.evidenceId,
    latest.resultCommitment.recordHash
  );
  return normalizeOutput(record?.payload?.result, 'replica');
}

function normalizeOutput(value, field) {
  if (!value || typeof value !== 'object') {
    return { messageParts: [{ type: 'text', text: `（${field} 输出不可用）` }] };
  }
  if (Array.isArray(value.messageParts)) {
    return {
      messageParts: structuredClone(value.messageParts),
      ...(Array.isArray(value.artifacts) ? { artifacts: structuredClone(value.artifacts) } : {})
    };
  }
  if (typeof value.text === 'string') {
    return { messageParts: [{ type: 'text', text: value.text }] };
  }
  return { messageParts: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function scoreFor(evaluation, testId, repeatIndex, sourceId) {
  const cases = evaluation?.resultV2?.replica?.cases || [];
  const cell = cases.find((item) => item.testId === testId && item.repeatIndex === repeatIndex);
  const score = cell?.scores?.[sourceId];
  return Number.isFinite(score) ? score : null;
}

function validReplicaIdsFor(evaluation) {
  return (evaluation?.resultV2?.replica?.runtimes || [])
    .filter((item) => item?.valid && typeof item.runtimeId === 'string')
    .map((item) => item.runtimeId);
}

function requireVault(evaluation, services) {
  const evidenceVault = services.evidenceVault ||
    services.evidenceVaultFactory?.(evaluation.id);
  if (!evidenceVault || typeof evidenceVault.get !== 'function') {
    const error = new Error('Replica detail requires an evidence vault');
    error.statusCode = 503;
    throw error;
  }
  return evidenceVault;
}

function skillMarkdown(skill) {
  const instructions = Array.isArray(skill.instructions)
    ? skill.instructions.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  const tools = Array.isArray(skill.tools)
    ? skill.tools.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  return `# ${skill.name || 'replica-skill'}\n\n${skill.description || ''}\n\n## Instructions\n\n${instructions}\n\n## Tools\n\n${tools}\n`;
}

function slug(value) {
  return String(value || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'skill';
}

function guessLanguage(path, mediaType) {
  if (typeof mediaType === 'string' && mediaType.includes('json')) return 'json';
  if (typeof mediaType === 'string' && mediaType.includes('markdown')) return 'markdown';
  if (String(path || '').endsWith('.json')) return 'json';
  if (String(path || '').endsWith('.md')) return 'markdown';
  return 'text';
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${field} is required`);
  return value;
}

function requiredRepeatIndex(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError('repeatIndex must be a non-negative integer');
  }
  return number;
}
