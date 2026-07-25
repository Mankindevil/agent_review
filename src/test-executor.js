import { evaluateAcceptance as evaluateAcceptanceDefault } from './acceptance.js';
import { hashCanonical } from './submission.js';
import { inputForTurn } from './test-plan.js';

export async function executeTestPlan(testPlan, options = {}) {
  if (!Array.isArray(testPlan?.tests)) throw new TypeError('testPlan.tests is required');
  const executeTurn = requiredFunction(options.executeTurn, 'executeTurn');
  const evaluateAcceptance = options.evaluateAcceptance || evaluateAcceptanceDefault;
  const persistTurn = options.persistTurn || (async () => {});
  const createId = options.createId || (() => crypto.randomUUID());
  const existing = indexExisting(options.existingRunIndex || []);
  const testRuns = [];
  const reusedCells = [];

  for (const test of testPlan.tests) {
    for (let repeatIndex = 0; repeatIndex < test.repeatCount; repeatIndex += 1) {
      const cellIdentity = identityFor(testPlan, test, repeatIndex, options);
      const cellKey = hashCanonical(cellIdentity);
      const prior = existing.get(cellKey);
      if (prior) {
        testRuns.push(structuredClone(prior.testRun));
        reusedCells.push(cellIdentity);
        continue;
      }
      const testRun = await executeCell(test, repeatIndex, {
        ...options,
        executeTurn,
        evaluateAcceptance,
        persistTurn,
        createId,
        cellIdentity
      });
      testRuns.push(testRun);
    }
  }
  return {
    status: testRuns.some((run) => run.status === 'attribution-pending')
      ? 'attribution-pending'
      : 'completed',
    testRuns,
    reusedCells
  };
}

export function buildObjectiveInputFromExecution(testPlan, execution) {
  if (!Array.isArray(testPlan?.tests) || !Array.isArray(execution?.testRuns)) {
    throw new TypeError('test plan and execution results are required');
  }
  const runsByTest = new Map();
  for (const testRun of execution.testRuns) {
    const current = runsByTest.get(testRun.testId) || [];
    current.push(testRun);
    runsByTest.set(testRun.testId, current);
  }
  const contextChecks = [];
  const a2aChecks = [];
  const errorHandlingChecks = [];
  const plannedTests = testPlan.tests
    .filter((test) => test.variantType !== 'protocol-recovery')
    .map((test) => {
      const requiredExecutable = (test.criteria || []).filter(
        (criterion) => criterion.required !== false && criterion.type !== 'model'
      ).length;
      const cellRuns = (runsByTest.get(test.testId) || []).map((testRun) => {
        const selectedRuns = testRun.runs || [];
        const last = selectedRuns.at(-1);
        const attribution = testRun.status === 'attribution-pending'
          ? 'pending'
          : testRun.status === 'platform-invalid'
            ? 'platform'
            : 'agent';
        const acceptance = normalizeCellAcceptance(
          test,
          last?.acceptance,
          attribution
        );
        const evidenceIds = stableSafeIds(
          selectedRuns.flatMap((run) => run.evidenceIds || [])
        );
        for (const run of selectedRuns) {
          a2aChecks.push({
            id: safeId(`a2a_${test.testId}_${testRun.repeatIndex}_${run.turnIndex}`),
            status: run.protocol?.validated === true
              ? 'passed'
              : attribution === 'agent'
                ? 'failed'
                : 'unavailable',
            weight: 1,
            evidenceIds: stableSafeIds(run.evidenceIds || [])
          });
        }
        if (test.contextPolicy === 'reuse-within-example') {
          contextChecks.push({
            id: safeId(`context_${test.testId}_${testRun.repeatIndex}`),
            kind: 'retention',
            status: testRun.contextCheck?.status || 'unavailable',
            weight: 1,
            evidenceIds
          });
        }
        return {
          runId: safeId(last?.runId || `cell_${test.testId}_${testRun.repeatIndex}`),
          repeatIndex: testRun.repeatIndex,
          attribution,
          terminalSuccess: attribution === 'agent' &&
            selectedRuns.length === test.turns.length &&
            selectedRuns.every((run) => run.outcome?.status === 'succeeded'),
          acceptance,
          schemaFingerprint: null,
          timing: {
            durationMs: attribution === 'agent'
              ? selectedRuns.reduce((sum, run) => sum + (run.timing?.durationMs || 0), 0)
              : null,
            firstEventMs: null,
            timedOut: selectedRuns.some((run) => run.error?.category === 'timeout')
          },
          evidenceIds
        };
      });
      return {
        testId: safeId(test.testId),
        weight: test.weight ?? 1,
        repeatCount: test.repeatCount,
        requiredExecutable,
        requiresState: test.contextPolicy === 'reuse-within-example',
        timingPolicy: {
          targetMs: test.timing.targetMs,
          timeoutMs: test.timing.timeoutMs,
          streaming: false
        },
        runs: cellRuns
      };
    });

  for (const probe of testPlan.tests.filter(
    (test) => test.variantType === 'protocol-recovery'
  )) {
    for (const testRun of runsByTest.get(probe.testId) || []) {
      errorHandlingChecks.push({
        id: safeId(`error_${probe.testId}_${testRun.repeatIndex}`),
        status: testRun.status === 'scored-agent' ? 'passed' : 'unavailable',
        weight: 1,
        evidenceIds: stableSafeIds(
          (testRun.runs || []).flatMap((run) => run.evidenceIds || [])
        )
      });
    }
  }
  return {
    plannedTests,
    contextChecks,
    a2aChecks,
    claimChecks: [],
    errorHandlingChecks
  };
}

async function executeCell(test, repeatIndex, context) {
  const attempts = [];
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    const attempt = await executeAttempt(test, repeatIndex, attemptIndex, context);
    attempts.push(attempt);
    if (attempt.attribution !== 'platform') break;
  }
  const selected = attempts.findLast((attempt) => attempt.attribution !== 'platform');
  const status = !selected
    ? 'platform-invalid'
    : selected.attribution === 'unknown'
      ? 'attribution-pending'
      : 'scored-agent';
  return {
    testId: test.testId,
    repeatIndex,
    cellIdentity: context.cellIdentity,
    status,
    attempts,
    runs: selected?.runs || [],
    contextCheck: selected?.contextCheck || {
      status: 'unavailable',
      contextId: null
    }
  };
}

async function executeAttempt(test, repeatIndex, attemptIndex, context) {
  const runs = [];
  let returnedContextId;
  let contextStatus = 'unavailable';
  let attribution = 'agent';
  for (let turnIndex = 0; turnIndex < test.turns.length; turnIndex += 1) {
    const sentContextId = returnedContextId;
    const runId = context.createId('run');
    const run = await context.executeTurn({
      card: context.card,
      input: inputForTurn(test, turnIndex),
      ...(returnedContextId ? { contextId: returnedContextId } : {}),
      streaming: context.streaming === true,
      timeoutMs: test.timing.timeoutMs,
      authorization: context.authorization,
      signal: context.signal,
      runId,
      testId: test.testId,
      turnIndex,
      repeatIndex
    });
    const runAttribution = classifyAttribution(run);
    const acceptance = runAttribution === 'agent'
      ? context.evaluateAcceptance(
          test.criteria || [],
          run.response?.currentOutput || { text: '', data: null, artifacts: [] }
        )
      : null;
    const captured = { ...structuredClone(run), acceptance };
    runs.push(captured);
    await context.persistTurn({
      test,
      repeatIndex,
      attemptIndex,
      run: captured,
      cellIdentity: context.cellIdentity
    });

    if (turnIndex > 0) {
      const nextContextId = run.response?.normalized?.contextId;
      contextStatus = sentContextId && nextContextId === sentContextId
        ? 'passed'
        : 'failed';
    }
    returnedContextId = run.response?.normalized?.contextId || undefined;
    if (runAttribution !== 'agent') {
      attribution = runAttribution;
      break;
    }
    if (run.outcome?.status !== 'succeeded') break;
  }
  return {
    attemptIndex,
    attribution,
    runs,
    contextCheck: {
      status: test.turns.length > 1 ? contextStatus : 'unavailable',
      contextId: returnedContextId || null
    }
  };
}

function classifyAttribution(run) {
  const status = run?.outcome?.status;
  if (status === 'platform-error') return 'platform';
  if (status === 'unknown') return 'unknown';
  return 'agent';
}

function identityFor(testPlan, test, repeatIndex, options) {
  return {
    testId: test.testId,
    repeatIndex,
    inputHash: test.normalizedInputHash,
    timingPolicyHash: options.timingPolicyHash || hashCanonical(test.timing),
    seed: options.seed ?? null,
    protocolConfigHash: options.protocolConfigHash || null,
    rubricVersion: testPlan.rubricVersion
  };
}

function indexExisting(entries) {
  const result = new Map();
  for (const entry of entries) {
    if (!entry?.cellIdentity || !entry.testRun) continue;
    const key = hashCanonical(entry.cellIdentity);
    if (result.has(key)) throw new TypeError('duplicate existing planned cell');
    result.set(key, entry);
  }
  return result;
}

function requiredFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} is required`);
  return value;
}

function normalizeCellAcceptance(test, acceptance, attribution) {
  const executable = (test.criteria || []).filter(
    (criterion) => criterion.required !== false && criterion.type !== 'model'
  );
  if (attribution === 'agent' && acceptance) return structuredClone(acceptance);
  const checks = (test.criteria || []).map((criterion) => ({
    id: safeId(criterion.id),
    type: criterion.type,
    required: criterion.required !== false,
    status: criterion.type === 'model' ? 'not-executable' : 'failed'
  }));
  return {
    requiredExecutable: executable.length,
    passedRequiredExecutable: 0,
    semanticSuccess: executable.length === 0 ? null : false,
    checks
  };
}

function safeId(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9_-]/gu, '_');
  const prefixed = /^[A-Za-z0-9]/u.test(normalized) ? normalized : `id_${normalized}`;
  return prefixed.slice(0, 128);
}

function stableSafeIds(values) {
  return [...new Set(values.map(safeId))];
}
