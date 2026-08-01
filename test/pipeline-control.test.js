import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EvaluationPipeline } from '../src/pipeline.js';
import { runBlackBoxFoundation } from '../src/black-box-pipeline.js';
import { EvaluationStore } from '../src/store.js';

const V2_EXAMPLES = [{
  id: 'example-one',
  name: 'Example one',
  turns: [{
    input: { parts: [{ type: 'text', text: 'ping' }] },
    acceptanceCriteria: []
  }]
}];

function v2Input(overrides = {}) {
  return {
    schemaVersion: 2,
    agentCard: evaluation('v2-template').agentCard,
    agentExamples: V2_EXAMPLES,
    ...overrides
  };
}

function v2Options(overrides = {}) {
  const calls = {
    puts: [],
    deletes: [],
    runs: []
  };
  const credentialVault = {
    put: (id, authorization) => calls.puts.push([id, authorization]),
    get: () => undefined,
    delete: (id) => {
      calls.deletes.push(id);
      return true;
    }
  };
  return {
    calls,
    options: {
      blackBoxEnabled: true,
      credentialVault,
      resumeMacKey: Buffer.alloc(32, 9),
      runBlackBox: async (item, services) => {
        calls.runs.push([item.id, services.signal]);
      },
      now: (() => {
        let index = 0;
        return () =>
          `2026-07-24T10:00:${String(index++).padStart(2, '0')}.000Z`;
      })(),
      ...overrides
    }
  };
}

function evaluation(id, status = 'running') {
  return {
    id, status, mode: 'demo', progress: 52, stage: 'Runtime 现场复刻', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), logs: [],
    agentCard: { name: 'Test Agent', description: 'test', supportedInterfaces: [{ url: 'https://example.com/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }], skills: [{ id: 'test', name: 'Test', description: 'test' }] },
    cases: [{ name: 'case', prompt: 'test prompt' }], validation: { valid: true, interfaces: [{ url: 'https://example.com/a2a', binding: 'HTTP+JSON', version: '1.0' }] }
  };
}

function pipelineMemoryVault() {
  const records = new Map();
  return {
    async put(record) {
      records.set(record.evidenceId, record);
      return record;
    },
    async get(evidenceId, recordHash) {
      const record = records.get(evidenceId);
      assert.equal(record?.recordHash, recordHash);
      return record;
    }
  };
}

function pipelineSuccessfulRun(options, selectedInterface) {
  return {
    runId: options.runId,
    testId: options.testId,
    turnIndex: options.turnIndex,
    repeatIndex: options.repeatIndex,
    protocol: {
      binding: selectedInterface.binding,
      version: selectedInterface.version,
      endpointHash: createHash('sha256')
        .update(selectedInterface.url)
        .digest('hex'),
      validated: true
    },
    request: {
      requestId: `request-${options.runId}`,
      messageId: `message-${options.runId}`,
      body: {},
      bodyHash: 'c'.repeat(64)
    },
    response: {
      httpStatus: 200,
      mediaType: 'application/json',
      byteLength: 10,
      rawObjects: [{
        messageId: 'response',
        role: 'ROLE_AGENT',
        parts: [{ text: 'done' }]
      }],
      rawHash: 'd'.repeat(64),
      normalized: {
        responseKind: 'message',
        terminal: true,
        terminalState: null,
        contextId: `ctx-${options.repeatIndex}`,
        taskId: null,
        statusSequence: [],
        parts: [{ text: 'done' }],
        artifacts: []
      },
      currentOutput: { text: 'done', data: null, artifacts: [] },
      snapshots: []
    },
    timing: {
      startedAt: 1,
      headersAt: 2,
      firstByteAt: 2,
      firstEventAt: null,
      endedAt: 3,
      firstByteMs: 1,
      firstEventMs: null,
      durationMs: 2
    },
    outcome: { status: 'succeeded', lifecycle: 'completed' },
    error: null
  };
}

function pipelineMonotonicIso() {
  let index = 0;
  const start = Date.parse('2026-07-24T10:00:00.000Z');
  return () => new Date(start + index++ * 1000).toISOString();
}

async function waitFor(store, id, predicate, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const item = store.get(id);
    if (predicate(item)) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.get(id);
}

function deferredValue() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const V1_PIPELINE_SECRET_ENV = 'V1_PIPELINE_TEST_API_KEY';
const originalV1PipelineSecret = process.env[V1_PIPELINE_SECRET_ENV];
process.env[V1_PIPELINE_SECRET_ENV] = 'test-only-secret';
test.after(() => {
  if (originalV1PipelineSecret === undefined) delete process.env[V1_PIPELINE_SECRET_ENV];
  else process.env[V1_PIPELINE_SECRET_ENV] = originalV1PipelineSecret;
});

function liveV1Reviewer(overrides = {}) {
  return {
    id: 'deepseek',
    name: 'DeepSeek 评审',
    model: 'DeepSeek Live',
    kind: 'openai-compatible',
    baseUrl: 'https://reviewer.example.test/v1',
    apiKeyEnv: V1_PIPELINE_SECRET_ENV,
    ...overrides
  };
}

function successfulV1ScoringResult({ entries, config, evaluationMode }) {
  return {
    status: 'scored',
    entries: entries.map((entry) => entry.mode === 'failed'
      ? { ...entry, judgeReviews: [] }
      : {
          ...entry,
          scoreStatus: 'scored',
          score: 80,
          dimensions: {
            taskConstraint: 80,
            professionalQuality: 80,
            evidenceRisk: entry.dataVerification?.status === 'verified' ? 96 : 80,
            artifactUsability: 80
          },
          judgeReviews: [{
            reviewerId: 'deepseek',
            reviewerName: 'DeepSeek 评审',
            model: 'DeepSeek Live',
            mode: evaluationMode,
            status: 'scored',
            rationale: 'Test fixture review.',
            uncertainties: []
          }]
        }),
    judging: {
      version: 'v1-model-arena/v1',
      status: 'scored',
      mode: config.mode,
      reviewerId: config.reviewerId,
      requiredSeats: 1,
      successfulSeats: 1,
      seats: [{
        reviewerId: 'deepseek',
        reviewerName: 'DeepSeek 评审',
        model: 'DeepSeek Live',
        mode: evaluationMode,
        status: 'scored'
      }]
    }
  };
}

function completedV1Evaluation(id, caseNames = ['case']) {
  const cases = caseNames.map((name, index) => ({
    name,
    prompt: `test prompt ${index + 1}`
  }));
  const competitorNames = {
    submitted: 'Test Agent',
    'claude-code': 'Claude Code',
    cursor: 'Cursor Agent',
    doubao: 'Doubao Agent'
  };
  const dimensions = {
    taskConstraint: 75,
    professionalQuality: 75,
    evidenceRisk: 75,
    artifactUsability: 75
  };
  return {
    ...evaluation(id, 'completed'),
    cases,
    completedAt: '2026-07-30T00:00:00.000Z',
    seed: 42,
    temperature: 0,
    scoringConfig: {
      version: 'v1-model-arena/v1',
      mode: 'single',
      reviewerId: 'deepseek'
    },
    complexity: { score: 70 },
    professional: {
      score: 80,
      mode: 'demo',
      reviews: [{ reviewerId: 'gpt', reviewer: 'OpenAI', model: 'GPT', score: 80, mode: 'demo' }]
    },
    builds: ['claude-code', 'cursor', 'doubao'].map((runtimeId) => ({
      runtimeId,
      runtime: competitorNames[runtimeId],
      model: `${competitorNames[runtimeId]} Model`,
      mode: 'demo',
      baselineInput: 'description-only',
      skill: {
        name: `${runtimeId}-skill`,
        description: 'test',
        instructions: ['Run the test task.'],
        tools: []
      }
    })),
    benchmark: cases.map((testCase, caseIndex) => ({
      case: testCase,
      dataEvidence: { status: 'not-configured', source: 'pandaai', fetchedAt: null, queries: [] },
      entries: ['submitted', 'claude-code', 'cursor', 'doubao'].map((competitorId) => ({
        id: competitorId,
        name: competitorNames[competitorId],
        output: `${competitorId} output for ${testCase.name}`,
        mode: 'demo',
        judgeSeed: caseIndex + 1,
        dataVerification: { status: 'not-configured', score: null, checks: [] },
        scoreStatus: 'scored',
        score: 75,
        dimensions,
        judgeReviews: []
      })),
      judging: {
        version: 'v1-model-arena/v1',
        status: 'scored',
        mode: 'single',
        reviewerId: 'deepseek',
        requiredSeats: 1,
        successfulSeats: 1,
        seats: []
      }
    })),
    averages: {
      submitted: 75,
      'claude-code': 75,
      cursor: 75,
      doubao: 75
    },
    roast: buildTestRoast(),
    coverage: { agent: 'demo', models: 'demo', runtimes: 'demo' },
    overallMode: 'demo'
  };
}

function buildTestRoast() {
  return {
    tier: { code: 'ELITE', label: '人上人', tone: 'great', stamp: '人上人' },
    headline: 'existing verdict',
    deltaClaude: 0,
    deltaDoubao: 0,
    professionalAverage: 80
  };
}

test('cancels an active evaluation and aborts its controller', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-cancel-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const item = evaluation('eval_cancel');
  const controller = new AbortController();
  await store.set(item);
  pipeline.activeRuns.set(item.id, controller);

  const cancelled = await pipeline.cancel(item.id);
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stage, '评测已停止');
  assert.match(cancelled.logs.at(-1).detail, /保留/);
});

test('rejects V2 cancel and retry before they can enter the legacy mutation path', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v2-guard-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const item = {
    schemaVersion: 2,
    id: 'eval_v2_guard',
    revision: 0,
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    execution: { status: 'running', stage: 'qualification', progress: 10 },
    rawEvidence: { secret: 'pipeline-v2-secret' },
    logs: []
  };
  await store.set(item);

  await assert.rejects(
    () => pipeline.cancel(item.id),
    (error) => error.statusCode === 409 && /V2/i.test(error.message)
  );
  await assert.rejects(
    () => pipeline.retry(item.id, { type: 'review', key: 'gpt' }),
    (error) => error.statusCode === 409 && /V2/i.test(error.message)
  );
  assert.equal(Object.hasOwn(store.get(item.id), 'status'), false);
  assert.equal(store.get(item.id).execution.status, 'running');
  assert.equal(store.get(item.id).rawEvidence.secret, 'pipeline-v2-secret');
});

test('routes numeric V2 only when enabled and keeps V2 retry disabled in both modes', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-route-${process.pid}.json`
  ));
  const disabled = new EvaluationPipeline(store, new EventEmitter());
  await assert.rejects(
    disabled.create(v2Input()),
    (error) => error.statusCode === 409 && /V2|black-box/i.test(error.message)
  );

  const { options } = v2Options();
  const enabled = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await enabled.create(v2Input());
  await new Promise(setImmediate);
  await assert.rejects(
    enabled.retry(created.id, {}),
    (error) => error.statusCode === 409 && /V2/i.test(error.message)
  );
});

test('rejects closed V2 intake and invalid Cards before store, token, credential, or worker side effects', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-intake-${process.pid}.json`
  ));
  let setCalls = 0;
  const originalSet = store.set.bind(store);
  store.set = async (...args) => {
    setCalls += 1;
    return originalSet(...args);
  };
  let participantCalls = 0;
  const { calls, options } = v2Options({
    createParticipantAccess: () => {
      participantCalls += 1;
      return { token: 'A'.repeat(43), hash: 'a'.repeat(64) };
    }
  });
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);

  await assert.rejects(
    pipeline.create(v2Input({ cases: [{ prompt: 'legacy' }] })),
    (error) => error.statusCode === 400 && /agentExamples|cases/i.test(error.message)
  );
  await assert.rejects(
    pipeline.create(v2Input({ agentCard: { name: 'invalid' } })),
    (error) => error.statusCode === 422 && /Agent Card/i.test(error.message)
  );
  for (const suffix of [
    '?token=sentinel-connection-secret',
    '#sentinel-connection-secret'
  ]) {
    for (const credentialCard of [
      (() => {
        const value = structuredClone(v2Input().agentCard);
        value.supportedInterfaces[0].url += suffix;
        return value;
      })(),
      (() => {
        const value = structuredClone(v2Input().agentCard);
        value.supportedInterfaces.push({
          url: `https://secondary.agent.example/a2a${suffix}`,
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0'
        });
        return value;
      })(),
      (() => {
        const value = structuredClone(v2Input().agentCard);
        value.supportedInterfaces.push({
          url: `https://secondary.agent.example/a2a${suffix}`,
          protocolBinding: 'CUSTOM',
          protocolVersion: '1.0'
        });
        return value;
      })(),
      {
        ...structuredClone(v2Input().agentCard),
        url: `https://legacy.agent.example/a2a${suffix}`
      }
    ]) {
      await assert.rejects(
        pipeline.create(v2Input({ agentCard: credentialCard })),
        (error) =>
          error.statusCode === 400 &&
          /agentAuthorization|query|fragment|endpoint/iu.test(error.message) &&
          !error.message.includes('sentinel-connection-secret')
      );
    }
  }
  assert.equal(setCalls, 0);
  assert.equal(participantCalls, 0);
  assert.deepEqual(calls.puts, []);
  assert.deepEqual(calls.runs, []);
  assert.deepEqual(store.list(), []);
});

test('cancels active V2 evaluations without bearer and replays idempotently', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-cancel-owner-${process.pid}.json`
  ));
  const emitted = [];
  const events = new EventEmitter();
  const originalEmit = events.emit.bind(events);
  events.emit = (name, value) => {
    if (name.startsWith('eval_')) emitted.push(structuredClone(value));
    return originalEmit(name, value);
  };
  let observedSignal;
  const { calls, options } = v2Options({
    runBlackBox: async (_item, services) => {
      observedSignal = services.signal;
      await new Promise((resolve, reject) => {
        services.signal.addEventListener('abort', () => {
          reject(services.signal.reason);
        }, { once: true });
      });
    }
  });
  const pipeline = new EvaluationPipeline(store, events, options);
  const created = await pipeline.create(v2Input({
    agentAuthorization: 'owned-agent-secret'
  }));
  await new Promise(setImmediate);
  const id = created.id;
  const before = store.get(id);
  const sideEffectsBefore = {
    revision: before.revision,
    audit: before.auditEvents.length,
    emitted: emitted.length,
    deletes: calls.deletes.length
  };

  const cancelled = await pipeline.cancel(id);
  assert.equal(cancelled.execution.status, 'cancelled');
  assert.equal(observedSignal.aborted, true);
  await new Promise(setImmediate);
  const afterCancel = {
    revision: cancelled.revision,
    audit: cancelled.auditEvents.length,
    emitted: emitted.length,
    deletes: calls.deletes.length
  };
  const replayed = await pipeline.cancel(id);
  assert.equal(replayed.revision, afterCancel.revision);
  assert.equal(store.get(id).auditEvents.length, afterCancel.audit);
  assert.equal(emitted.length, afterCancel.emitted);
  assert.equal(calls.deletes.length, afterCancel.deletes);
  assert.equal(afterCancel.revision, sideEffectsBefore.revision + 1);
});

test('hard-deletes terminal V2 records through the store', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-delete-${process.pid}.json`
  ));
  const { options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input());
  await new Promise(setImmediate);
  await pipeline.cancel(created.id);
  while (pipeline.activeRuns.has(created.id)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await store.delete(created.id);
  assert.equal(store.get(created.id), undefined);
});

test('creates non-idempotent V2 records with one store set and no participant access metadata', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-create-${process.pid}.json`
  ));
  const emitted = [];
  const events = new EventEmitter();
  events.on('newListener', () => {});
  const originalEmit = events.emit.bind(events);
  events.emit = (name, value) => {
    if (name.startsWith('eval_')) emitted.push(structuredClone(value));
    return originalEmit(name, value);
  };
  let setCalls = 0;
  const originalSet = store.set.bind(store);
  store.set = async (...args) => {
    setCalls += 1;
    return originalSet(...args);
  };
  const { calls, options } = v2Options();
  const pipeline = new EvaluationPipeline(store, events, options);
  const input = v2Input({ agentAuthorization: 'agent-create-secret' });
  const first = await pipeline.create(input);
  const second = await pipeline.create(input);
  await new Promise(setImmediate);

  assert.notEqual(first.id, second.id);
  assert.equal(first.participantAccess, undefined);
  assert.equal(second.participantAccess, undefined);
  assert.equal(setCalls, 2);
  assert.equal(calls.runs.length, 2);
  assert.equal(calls.puts.length, 2);
  for (const created of [first, second]) {
    assert.equal(created.schemaVersion, 2);
    assert.equal(created.execution.status, 'queued');
    assert.equal(created.runtimeState.runIndex.length, 3);
    assert.deepEqual(created.submission.config, {
      rubricVersion: 'a2a-black-box-v1',
      hiddenTestPackageVersion: 'black-box-test-plan/v1',
      modelConfigVersion: 'panel-v1',
      runtimeConfigVersion: 'phase2-black-box-runtime/v1'
    });
    const stored = JSON.stringify(store.get(created.id));
    assert.equal(stored.includes('participantAccess'), false);
    assert.equal(stored.includes('agent-create-secret'), false);
  }
});

test('authenticates and reserves resume once, replays exactly, and rejects changed bodies without side effects', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-resume-${process.pid}.json`
  ));
  const { calls, options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input({
    agentAuthorization: 'agent-initial-secret'
  }));
  await new Promise(setImmediate);
  const before = store.get(created.id);
  await store.mutate(before.id, before.revision, (record) => ({
    ...record,
    execution: {
      status: 'credentials-required',
      stage: 'paused',
      progress: 10,
      interruptedAt: '2026-07-24T10:00:10.000Z'
    }
  }));
  const putsBefore = calls.puts.length;
  const runsBefore = calls.runs.length;
  const request = {
    idempotencyKey: 'resume-key-00001',
    body: { agentAuthorization: 'agent-resume-secret' }
  };
  const accepted = await pipeline.resume(created.id, request);
  await new Promise(setImmediate);
  const replayed = await pipeline.resume(created.id, request);

  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(replayed, accepted);
  assert.equal(calls.puts.length, putsBefore + 1);
  assert.equal(calls.runs.length, runsBefore + 1);
  const stored = store.get(created.id);
  assert.equal(stored.resumeReceipts.length, 1);
  assert.equal(stored.execution.status, 'queued');
  assert.equal(
    JSON.stringify(stored).includes('resume-key-00001'),
    false
  );
  assert.equal(
    JSON.stringify(stored).includes('agent-resume-secret'),
    false
  );

  await assert.rejects(
    pipeline.resume(created.id, {
      ...request,
      body: { agentAuthorization: 'different-agent-secret' }
    }),
    (error) => error.statusCode === 409
  );
  assert.equal(calls.puts.length, putsBefore + 1);
  assert.equal(calls.runs.length, runsBefore + 1);
});

test('replays an accepted resume receipt after archive but rejects a new key without side effects', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-archived-resume-replay-${process.pid}.json`
  ));
  const { calls, options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input());
  await new Promise(setImmediate);
  let current = store.get(created.id);
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    execution: {
      status: 'interrupted',
      stage: 'recovery',
      progress: record.execution.progress,
      interruptedAt: '2026-07-24T10:00:10.000Z'
    }
  }));
  const request = {
    idempotencyKey: 'archived-replay-key-00001',
    body: {}
  };
  const accepted = await pipeline.resume(current.id, request);
  await new Promise(setImmediate);
  current = store.get(current.id);
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    archivedAt: '2026-07-24T11:00:00.000Z'
  }));
  const before = {
    revision: current.revision,
    puts: calls.puts.length,
    deletes: calls.deletes.length,
    runs: calls.runs.length
  };

  const replayed = await pipeline.resume(current.id, request);
  assert.deepEqual(replayed, accepted);
  await assert.rejects(
    () => pipeline.resume(current.id, {
      ...request,
      idempotencyKey: 'archived-replay-key-00002'
    }),
    (error) => error.statusCode === 409 && /archived/iu.test(error.message)
  );

  assert.equal(store.get(current.id).revision, before.revision);
  assert.equal(calls.puts.length, before.puts);
  assert.equal(calls.deletes.length, before.deletes);
  assert.equal(calls.runs.length, before.runs);
});

test('rejects explicit non-object resume bodies without reserving or dispatching', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-resume-body-${process.pid}.json`
  ));
  const { calls, options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input());
  await new Promise(setImmediate);
  let current = store.get(created.id);
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    execution: {
      status: 'interrupted',
      stage: 'recovery',
      progress: record.execution.progress,
      interruptedAt: '2026-07-24T10:00:10.000Z'
    }
  }));
  const before = {
    revision: current.revision,
    receipts: current.resumeReceipts.length,
    puts: calls.puts.length,
    runs: calls.runs.length
  };

  for (const [index, body] of [null, [], 0, 'invalid'].entries()) {
    await assert.rejects(
      () => pipeline.resume(current.id, {
        idempotencyKey: `resume-body-key-0000${index}`,
        body
      }),
      (error) => error.statusCode === 400
    );
  }

  const after = store.get(current.id);
  assert.equal(after.revision, before.revision);
  assert.equal(after.resumeReceipts.length, before.receipts);
  assert.equal(calls.puts.length, before.puts);
  assert.equal(calls.runs.length, before.runs);
});

test('rejects resume of an archived interrupted V2 record without side effects', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-archived-resume-${process.pid}.json`
  ));
  const { calls, options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input());
  await new Promise(setImmediate);
  let current = store.get(created.id);
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    archivedAt: '2026-07-24T11:00:00.000Z',
    execution: {
      status: 'interrupted',
      stage: 'recovery',
      progress: record.execution.progress,
      interruptedAt: '2026-07-24T10:59:00.000Z'
    }
  }));
  const before = {
    revision: current.revision,
    receipts: current.resumeReceipts.length,
    puts: calls.puts.length,
    deletes: calls.deletes.length,
    runs: calls.runs.length
  };

  await assert.rejects(
    () => pipeline.resume(current.id, {
      idempotencyKey: 'archived-resume-key-00001',
      body: {}
    }),
    (error) => error.statusCode === 409 && /archived/iu.test(error.message)
  );

  const after = store.get(current.id);
  assert.equal(after.revision, before.revision);
  assert.equal(after.resumeReceipts.length, before.receipts);
  assert.equal(calls.puts.length, before.puts);
  assert.equal(calls.deletes.length, before.deletes);
  assert.equal(calls.runs.length, before.runs);

  const archivedCancel = await pipeline.cancel(current.id);
  assert.equal(archivedCancel.execution.status, 'interrupted');
  assert.equal(archivedCancel.revision, before.revision);
  assert.equal(store.get(current.id).revision, before.revision);
});

test('records a distinct audit event for each accepted resume request', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-resume-audit-${process.pid}.json`
  ));
  const { options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input());
  await new Promise(setImmediate);
  let current = store.get(created.id);
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    execution: { status: 'interrupted', stage: 'recovery', progress: 0 }
  }));
  await pipeline.resume(current.id, {
    idempotencyKey: 'resume-audit-key-00001',
    body: {}
  });
  await new Promise(setImmediate);
  current = store.get(current.id);
  await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    execution: { status: 'interrupted', stage: 'recovery', progress: 0 }
  }));
  await pipeline.resume(current.id, {
    idempotencyKey: 'resume-audit-key-00002',
    body: {}
  });

  const accepted = store.get(current.id).auditEvents.filter(
    (event) => event.type === 'resume-accepted'
  );
  assert.equal(accepted.length, 2);
  assert.notEqual(accepted[0].id, accepted[1].id);
});

test('concurrent identical resumes reserve one durable receipt and dispatch only once', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-resume-race-${process.pid}.json`
  ));
  const { calls, options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input({
    agentAuthorization: 'agent-initial-secret'
  }));
  await new Promise(setImmediate);
  const before = store.get(created.id);
  await store.mutate(before.id, before.revision, (record) => ({
    ...record,
    execution: {
      status: 'credentials-required',
      stage: 'paused',
      progress: 10,
      interruptedAt: '2026-07-24T10:00:10.000Z'
    }
  }));
  const putsBefore = calls.puts.length;
  const runsBefore = calls.runs.length;
  const request = {
    idempotencyKey: 'resume-race-key-00001',
    body: { agentAuthorization: 'agent-resume-secret' }
  };

  const results = await Promise.all([
    pipeline.resume(created.id, request),
    pipeline.resume(created.id, request)
  ]);
  await new Promise(setImmediate);

  assert.deepEqual(results[1], results[0]);
  assert.equal(store.get(created.id).resumeReceipts.length, 1);
  assert.equal(calls.puts.length, putsBefore + 1);
  assert.equal(calls.runs.length, runsBefore + 1);
});

test('recovers enabled nested V2 state once while disabled recovery leaves it untouched', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-recovery-${process.pid}.json`
  ));
  const { options } = v2Options();
  const creator = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await creator.create(v2Input({
    agentAuthorization: 'agent-recovery-secret'
  }));
  await new Promise(setImmediate);
  let current = store.get(created.id);
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    execution: {
      status: 'running',
      stage: 'public-examples',
      progress: 40
    }
  }));
  const disabled = new EvaluationPipeline(store, new EventEmitter());
  await disabled.recoverInterrupted();
  assert.equal(store.get(current.id).revision, current.revision);

  const enabled = new EvaluationPipeline(store, new EventEmitter(), options);
  await enabled.recoverInterrupted();
  const recovered = store.get(current.id);
  assert.equal(recovered.execution.status, 'credentials-required');
  assert.equal(
    recovered.auditEvents.filter(
      (event) => event.type === 'credentials-required'
    ).length,
    1
  );
  assert.equal(
    recovered.auditEvents.filter(
      (event) => event.type === 'execution-interrupted'
    ).length,
    0
  );
  const revision = recovered.revision;
  await enabled.recoverInterrupted();
  assert.equal(store.get(current.id).revision, revision);
});

test('recovery maps public V2 interruption to one execution-interrupted audit', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-public-recovery-${process.pid}.json`
  ));
  const { options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input());
  await new Promise(setImmediate);
  let current = store.get(created.id);
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    execution: {
      status: 'running',
      stage: 'public-examples',
      progress: 40
    }
  }));

  await pipeline.recoverInterrupted();
  const recovered = store.get(current.id);
  assert.equal(recovered.execution.status, 'interrupted');
  assert.equal(
    recovered.auditEvents.filter(
      (event) => event.type === 'execution-interrupted'
    ).length,
    1
  );
  assert.equal(
    recovered.auditEvents.filter(
      (event) => event.type === 'credentials-required'
    ).length,
    0
  );
  const revision = recovered.revision;
  await pipeline.recoverInterrupted();
  assert.equal(store.get(current.id).revision, revision);
});

test('dispatched crash recovery closes pending checks and completes objective scoring at lower coverage', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-dispatched-recovery-${process.pid}.json`
  ));
  const examples = [{
    ...V2_EXAMPLES[0],
    turns: [{
      ...V2_EXAMPLES[0].turns[0],
      acceptanceCriteria: [{
        id: 'must-complete',
        type: 'contains',
        expected: ['done'],
        description: 'Must complete',
        required: true
      }]
    }]
  }];
  const { options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input({ agentExamples: examples }));
  await new Promise(setImmediate);
  let current = store.get(created.id);
  const crashedCell = current.runtimeState.runIndex[0];
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    qualification: {
      status: 'eligible',
      reason: 'version-valid-a2a-response',
      attemptRunIds: ['run_qualification_before_crash'],
      selectedInterface: {
        binding: record.submission.selectedInterface.binding,
        version: record.submission.selectedInterface.version,
        endpointHash: createHash('sha256')
          .update(record.submission.selectedInterface.url)
          .digest('hex')
      },
      completedAt: '2026-07-24T10:00:00.000Z'
    },
    execution: {
      status: 'running',
      stage: 'public-examples',
      progress: 40
    },
    runtimeState: {
      ...record.runtimeState,
      runIndex: record.runtimeState.runIndex.map((cell) =>
        cell.cellId === crashedCell.cellId
          ? {
              ...cell,
              status: 'running',
              attempts: [{
                attemptIndex: 0,
                kind: 'planned',
                sampleRunId: 'sample_crashed',
                attribution: null,
                terminalSuccess: null,
                acceptance: null,
                schemaFingerprint: null,
                timing: null,
                evidenceIds: [],
                turns: cell.turns.map((turn) => ({
                  ...turn,
                  status: 'dispatched',
                  sentContextId: null,
                  sentTaskId: null,
                  contextId: null,
                  continuationTaskId: null,
                  outcome: null,
                  timing: null,
                  acceptance: null,
                  attribution: null,
                  protocolObservation: null,
                  evidenceIds: []
                }))
              }]
            }
          : cell
      )
    }
  }));

  await pipeline.recoverInterrupted();
  const recovered = store.get(current.id);
  const recoveredCell = recovered.runtimeState.runIndex[0];
  assert.equal(recoveredCell.status, 'attribution-pending');
  assert.equal(recoveredCell.attempts[0].turns[0].status, 'unavailable');
  assert.equal(recoveredCell.attempts[0].turns[0].evidenceIds.length, 0);
  assert.equal(recoveredCell.attempts[0].acceptance.checks.length, 1);
  assert.equal(recoveredCell.attempts[0].acceptance.checks[0].status, 'failed');

  const vault = pipelineMemoryVault();
  await runBlackBoxFoundation(recovered, {
    store,
    events: new EventEmitter(),
    credentialVault: { get: () => undefined, delete: () => true },
    evidenceVaultFactory: () => vault,
    executeTurn: async (turn) => pipelineSuccessfulRun(
      turn,
      recovered.submission.selectedInterface
    ),
    now: pipelineMonotonicIso(),
    clock: () => 0,
    sleep: async () => {},
    createId: (() => {
      let index = 0;
      return (prefix = 'id') =>
        `${prefix}_${String(index += 1).padStart(4, '0')}`;
    })()
  });

  const completed = store.get(current.id);
  assert.equal(completed.execution.status, 'completed');
  assert.equal(
    completed.runtimeState.runIndex[0].status,
    'attribution-pending'
  );
  assert.equal(completed.objectiveCapability.coverage < 1, true);
  assert.notEqual(completed.objectiveCapability.score, null);
});

test('same-process resume closes a dispatched unknown turn instead of selecting or rerunning it', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-dispatched-resume-${process.pid}.json`
  ));
  const vault = pipelineMemoryVault();
  let executeCalls = 0;
  const { options } = v2Options({
    runBlackBox: runBlackBoxFoundation,
    blackBoxServices: {
      evidenceVaultFactory: () => vault,
      executeTurn: async (turn) => {
        executeCalls += 1;
        if (executeCalls === 2) {
          throw new Error('worker crashed after formal dispatch');
        }
        return pipelineSuccessfulRun(turn, {
          binding: 'HTTP+JSON',
          version: '1.0',
          url: 'https://example.com/a2a'
        });
      },
      sleep: async () => {},
      clock: () => 0,
      createId: (() => {
        let index = 0;
        return (prefix = 'id') =>
          `${prefix}_${String(index += 1).padStart(4, '0')}`;
      })()
    }
  });
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input());
  const interrupted = await waitFor(
    store,
    created.id,
    (item) => item.execution.status === 'interrupted'
  );
  const unknownCell = interrupted.runtimeState.runIndex[0];
  const unknownRunId = unknownCell.attempts[0].turns[0].runId;
  assert.equal(unknownCell.attempts[0].turns[0].status, 'dispatched');

  await pipeline.resume(created.id, {
    idempotencyKey: 'resume-dispatched-unknown-0001',
    body: {}
  });
  const completed = await waitFor(
    store,
    created.id,
    (item) => item.execution.status === 'completed'
  );

  const recoveredCell = completed.runtimeState.runIndex[0];
  assert.equal(recoveredCell.status, 'attribution-pending');
  assert.equal(recoveredCell.selectedAttemptIndex, null);
  assert.equal(recoveredCell.attempts[0].turns[0].status, 'unavailable');
  assert.equal(
    completed.runtimeState.runIndex
      .flatMap((cell) => cell.attempts)
      .flatMap((attempt) => attempt.turns)
      .filter((turn) => turn.runId === unknownRunId)
      .length,
    1
  );
  assert.equal(executeCalls, 4);
});

test('enabled V2 cancel commits before abort/delete/emit and is revision-idempotent', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-cancel-enabled-${process.pid}.json`
  ));
  let releaseRun;
  const running = new Promise((resolve) => { releaseRun = resolve; });
  const operations = [];
  const { calls, options } = v2Options({
    runBlackBox: async (_item, services) => {
      operations.push('worker-start');
      await new Promise((resolve, reject) => {
        services.signal.addEventListener('abort', () => {
          operations.push('abort');
          reject(services.signal.reason);
        }, { once: true });
        running.then(resolve);
      });
    }
  });
  const originalDelete = options.credentialVault.delete;
  options.credentialVault.delete = (id) => {
    operations.push('credential-delete');
    return originalDelete(id);
  };
  const events = new EventEmitter();
  events.on('newListener', () => {});
  const originalEmit = events.emit.bind(events);
  events.emit = (name, value) => {
    if (value?.schemaVersion === 2) {
      operations.push(`emit-${value.execution.status}`);
    }
    return originalEmit(name, value);
  };
  const pipeline = new EvaluationPipeline(store, events, options);
  const created = await pipeline.create(v2Input({
    agentAuthorization: 'agent-cancel-secret'
  }));
  await new Promise(setImmediate);
  operations.length = 0;

  const cancelled = await pipeline.cancel(created.id);
  const revision = cancelled.revision;
  assert.equal(cancelled.execution.status, 'cancelled');
  assert.equal(cancelled.auditEvents.at(-1).type, 'cancelled');
  assert.ok(operations.indexOf('abort') < operations.indexOf('credential-delete'));
  assert.ok(
    operations.indexOf('credential-delete') <
      operations.indexOf('emit-cancelled')
  );
  const again = await pipeline.cancel(created.id);
  assert.equal(again.revision, revision);
  assert.equal(calls.puts.length, 1);
  releaseRun();
});

test('V2 cancel retries a stale worker revision and still aborts and clears credentials', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-cancel-worker-race-${process.pid}.json`
  ));
  const operations = [];
  const { calls, options } = v2Options({
    runBlackBox: async (_item, services) => {
      await new Promise((resolve, reject) => {
        services.signal.addEventListener('abort', () => {
          operations.push('abort');
          reject(services.signal.reason);
        }, { once: true });
      });
    }
  });
  const pipeline = new EvaluationPipeline(
    store,
    new EventEmitter(),
    options
  );
  const created = await pipeline.create(v2Input({
    agentAuthorization: 'agent-cancel-race-secret'
  }));
  await new Promise(setImmediate);

  const mutate = store.mutate.bind(store);
  let injectedWorkerCommits = 0;
  store.mutate = async (id, expectedRevision, updater) => {
    if (injectedWorkerCommits < 17) {
      injectedWorkerCommits += 1;
      await mutate(id, expectedRevision, (record) => ({
        ...record,
        execution: {
          ...record.execution,
          progress: record.execution.progress + 1
        }
      }));
    }
    return mutate(id, expectedRevision, updater);
  };

  const cancelled = await pipeline.cancel(created.id);

  assert.equal(injectedWorkerCommits, 17);
  assert.equal(cancelled.execution.status, 'cancelled');
  assert.equal(
    cancelled.auditEvents.filter((event) => event.type === 'cancelled').length,
    1
  );
  assert.deepEqual(operations, ['abort']);
  assert.equal(
    calls.deletes.filter((id) => id === created.id).length >= 1,
    true
  );
});

test('concurrent V2 cancels commit one transition and both return the current record', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-cancel-race-${process.pid}.json`
  ));
  let releaseRun;
  const running = new Promise((resolve) => { releaseRun = resolve; });
  const { options } = v2Options({
    runBlackBox: async (_item, services) => {
      await new Promise((resolve, reject) => {
        services.signal.addEventListener(
          'abort',
          () => reject(services.signal.reason),
          { once: true }
        );
        running.then(resolve);
      });
    }
  });
  const events = new EventEmitter();
  const emitted = [];
  events.on('newListener', () => {});
  const originalEmit = events.emit.bind(events);
  events.emit = (name, value) => {
    if (value?.execution?.status === 'cancelled') emitted.push(value.revision);
    return originalEmit(name, value);
  };
  const pipeline = new EvaluationPipeline(store, events, options);
  const created = await pipeline.create(v2Input());
  await new Promise(setImmediate);
  const revisionBefore = store.get(created.id).revision;

  const results = await Promise.all([
    pipeline.cancel(created.id),
    pipeline.cancel(created.id)
  ]);

  assert.equal(results[0].execution.status, 'cancelled');
  assert.equal(results[1].execution.status, 'cancelled');
  assert.equal(results[0].revision, revisionBefore + 1);
  assert.equal(results[1].revision, revisionBefore + 1);
  assert.equal(store.get(created.id).revision, revisionBefore + 1);
  assert.deepEqual(emitted, [revisionBefore + 1]);
  releaseRun();
});

test('V2 cancel closes a dispatched turn, attempt, and cell without pending attribution', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v2-cancel-dispatched-${process.pid}.json`
  ));
  const { options } = v2Options();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), options);
  const created = await pipeline.create(v2Input());
  await new Promise(setImmediate);
  let current = store.get(created.id);
  current = await store.mutate(current.id, current.revision, (record) => ({
    ...record,
    execution: { status: 'running', stage: 'public-examples', progress: 20 },
    runtimeState: {
      ...record.runtimeState,
      runIndex: record.runtimeState.runIndex.map((cell, index) =>
        index === 0
          ? {
              ...cell,
              status: 'running',
              attempts: [{
                attemptIndex: 0,
                kind: 'planned',
                sampleRunId: 'sample_cancelled',
                attribution: null,
                terminalSuccess: null,
                acceptance: null,
                schemaFingerprint: null,
                timing: null,
                evidenceIds: [],
                turns: cell.turns.map((turn) => ({
                  ...turn,
                  status: 'dispatched',
                  attribution: null
                }))
              }]
            }
          : cell
      )
    }
  }));

  const cancelled = await pipeline.cancel(current.id);
  const cell = cancelled.runtimeState.runIndex[0];
  const attempt = cell.attempts[0];
  assert.equal(cell.status, 'cancelled');
  assert.equal(attempt.attribution, 'cancelled');
  assert.equal(attempt.terminalSuccess, false);
  assert.equal(attempt.turns[0].status, 'cancelled');
  assert.equal(attempt.turns[0].attribution, 'cancelled');
  assert.deepEqual(attempt.turns[0].outcome, {
    status: 'cancelled',
    lifecycle: 'cancelled'
  });
});

test('marks persisted running evaluations as interrupted after a restart', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-recover-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  await store.set(evaluation('eval_stale', 'running'));
  await store.set(evaluation('eval_done', 'completed'));

  await pipeline.recoverInterrupted();
  assert.equal(store.get('eval_stale').status, 'interrupted');
  assert.match(store.get('eval_stale').error, /进程.*重启/);
  assert.equal(store.get('eval_done').status, 'completed');
});

test('normalizes and persists the selected V1 scoring configuration', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-scoring-config-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({
    agentCard: evaluation('template').agentCard,
    cases: [{ name: 'case', prompt: 'test prompt' }],
    mode: 'demo',
    scoringConfig: { mode: 'single', reviewerId: 'deepseek' }
  });

  assert.deepEqual(created.scoringConfig, {
    version: 'v1-model-arena/v2',
    mode: 'single',
    reviewerId: 'deepseek'
  });
  assert.equal((await waitFor(store, created.id, (value) => value.status === 'completed')).status, 'completed');
});

test('rejects an uncredentialed custom live V1 reviewer before storing or starting work', async () => {
  const missingSecretEnv = 'V1_PIPELINE_MISSING_API_KEY';
  delete process.env[missingSecretEnv];
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v1-invalid-reviewer-${process.pid}.json`
  ));
  let setCalls = 0;
  const originalSet = store.set.bind(store);
  store.set = async (...args) => {
    setCalls += 1;
    return originalSet(...args);
  };
  let runCalls = 0;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    v1Reviewers: [liveV1Reviewer({ apiKeyEnv: missingSecretEnv })]
  });
  pipeline.run = async () => {
    runCalls += 1;
  };

  await assert.rejects(
    () => pipeline.create({
      agentCard: evaluation('template').agentCard,
      cases: [{ name: 'case', prompt: 'test prompt' }],
      mode: 'live',
      scoringConfig: { mode: 'single', reviewerId: 'deepseek' }
    }),
    (error) => error.statusCode === 503 && /deepseek/u.test(error.message)
  );
  await new Promise(setImmediate);

  assert.equal(setCalls, 0);
  assert.equal(runCalls, 0);
  assert.equal(store.list().length, 0);
});

test('scores each V1 benchmark case once after every candidate output is present', async () => {
  const envNames = [
    'MODEL_REVIEWERS_JSON',
    'RUNTIME_ADAPTERS_JSON',
    'ENABLE_LOCAL_CLAUDE_CODE',
    'ENABLE_LOCAL_CURSOR_AGENT',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'ARK_BASE_URL',
    'ARK_API_KEY'
  ];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const scoringCalls = [];
  try {
    process.env.MODEL_REVIEWERS_JSON = JSON.stringify([
      { id: 'mock', name: 'Mock', model: 'Mock', kind: 'mock' }
    ]);
    process.env.RUNTIME_ADAPTERS_JSON = '{}';
    process.env.ENABLE_LOCAL_CLAUDE_CODE = 'false';
    process.env.ENABLE_LOCAL_CURSOR_AGENT = 'false';
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ARK_BASE_URL;
    delete process.env.ARK_API_KEY;
    const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-case-scoring-${process.pid}.json`));
    const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
      v1Reviewers: [liveV1Reviewer()],
      scoreV1Case: async (input) => {
        scoringCalls.push(structuredClone(input));
        assert.equal(input.entries.length, 4);
        const failed = input.entries.find((entry) => entry.id === 'submitted');
        assert.equal(failed.scoreStatus, 'execution-failed');
        assert.equal(failed.score, 0);
        assert.equal(failed.dimensions, null);
        for (const entry of input.entries.filter((candidate) => candidate.id !== 'submitted')) {
          assert.equal(entry.scoreStatus, 'pending');
          assert.equal(entry.score, null);
          assert.equal(entry.dimensions, null);
        }
        return {
          status: 'scored',
          judging: {
            version: 'v1-model-arena/v1',
            status: 'scored',
            mode: 'single',
            reviewerId: 'deepseek',
            requiredSeats: 1,
            successfulSeats: 1,
            seats: [{
              reviewerId: 'deepseek',
              reviewerName: 'DeepSeek 评审',
              model: 'DeepSeek Live',
              mode: 'live',
              status: 'scored'
            }]
          },
          entries: input.entries.map((entry) => entry.mode === 'failed'
            ? { ...entry, judgeReviews: [] }
            : {
                ...entry,
                scoreStatus: 'scored',
                score: 77,
                dimensions: {
                  taskConstraint: 77,
                  professionalQuality: 77,
                  evidenceRisk: 77,
                  artifactUsability: 77
                },
                judgeReviews: [{
                  reviewerId: 'deepseek',
                  reviewerName: 'DeepSeek 评审',
                  model: 'DeepSeek Live',
                  mode: 'live',
                  status: 'scored',
                  rationale: 'Complete.',
                  uncertainties: []
                }]
              })
        };
      }
    });
    pipeline.runSubmittedAgent = async () => {
      throw new Error('submitted execution failed');
    };

    const created = await pipeline.create({
      mode: 'live',
      scoringConfig: { mode: 'single', reviewerId: 'deepseek' },
      agentCard: evaluation('template').agentCard,
      cases: [
        { name: 'case one', prompt: 'first prompt' },
        { name: 'case two', prompt: 'second prompt' }
      ]
    });
    const result = await waitFor(store, created.id, (value) => value.status === 'completed');

    assert.equal(result.status, 'completed');
    assert.equal(scoringCalls.length, 2);
    assert.deepEqual(scoringCalls.map((call) => call.testCase.name), ['case one', 'case two']);
    assert.equal(result.benchmark.every((roundItem) => roundItem.judging.successfulSeats === 1), true);
    assert.equal(result.benchmark.every((roundItem) =>
      roundItem.entries.filter((entry) => entry.id !== 'submitted').every((entry) =>
        entry.scoreStatus === 'scored' &&
        entry.score === 77 &&
        entry.judgeReviews[0].reviewerId === 'deepseek'
      )
    ), true);
  } finally {
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});

test('persists failed V1 model judging and stops before producing a verdict', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-scoring-failure-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async ({ entries, config }) => ({
      status: 'failed',
      entries: entries.map((entry) => ({
        ...entry,
        scoreStatus: entry.mode === 'failed' ? 'execution-failed' : 'model-failed',
        score: entry.mode === 'failed' ? 0 : null,
        dimensions: null,
        judgeReviews: []
      })),
      judging: {
        version: 'v1-model-arena/v1',
        status: 'failed',
        mode: config.mode,
        reviewerId: config.reviewerId,
        requiredSeats: 1,
        successfulSeats: 0,
        seats: [{
          reviewerId: config.reviewerId,
          reviewerName: 'DeepSeek 评审',
          model: 'DeepSeek',
          mode: 'demo',
          status: 'failed',
          failure: 'judge unavailable'
        }]
      }
    })
  });
  const failures = [];
  const fail = pipeline.fail.bind(pipeline);
  pipeline.fail = async (evaluationId, error) => {
    failures.push(error);
    return fail(evaluationId, error);
  };

  const created = await pipeline.create({
    mode: 'demo',
    agentCard: evaluation('template').agentCard,
    cases: [{ name: 'case', prompt: 'test prompt' }]
  });
  const result = await waitFor(store, created.id, (value) => value.status === 'failed');

  assert.equal(result.status, 'failed');
  assert.equal(failures[0].statusCode, 502);
  assert.equal(result.benchmark[0].entries.length, 4);
  assert.equal(result.benchmark[0].judging.status, 'failed');
  assert.equal(Object.hasOwn(result, 'averages'), false);
  assert.equal(Object.hasOwn(result, 'roast'), false);
});

test('preserves an initial V1 cancellation when scoring resolves after abort', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v1-initial-score-cancel-${process.pid}.json`
  ));
  const scoringStarted = deferredValue();
  const scoringResult = deferredValue();
  let scoringInput;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async (input) => {
      scoringInput = structuredClone(input);
      scoringStarted.resolve();
      return scoringResult.promise;
    }
  });
  const created = await pipeline.create({
    mode: 'demo',
    agentCard: evaluation('template').agentCard,
    cases: [{ name: 'case', prompt: 'test prompt' }]
  });
  await scoringStarted.promise;

  await pipeline.cancel(created.id);
  scoringResult.resolve(successfulV1ScoringResult(scoringInput));
  for (let attempt = 0; attempt < 40 && pipeline.activeRuns.has(created.id); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const cancelled = store.get(created.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stage, '评测已停止');
  assert.equal(Object.hasOwn(cancelled.benchmark[0], 'judging'), false);
  assert.equal(Object.hasOwn(cancelled, 'averages'), false);
  assert.equal(Object.hasOwn(cancelled, 'roast'), false);
  assert.equal(Object.hasOwn(cancelled, 'completedAt'), false);
});

test('persists each completed reviewer, runtime and benchmark entry incrementally', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-incremental-${process.pid}.json`));
  const snapshots = [];
  const originalSet = store.set.bind(store);
  store.set = async (item) => {
    snapshots.push(structuredClone(item));
    return originalSet(item);
  };
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({ mode: 'demo', seed: 424242, agentCard: evaluation('template').agentCard, cases: [{ name: 'case', prompt: 'test prompt' }] });
  for (let attempt = 0; attempt < 80 && store.get(created.id).status !== 'completed'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(snapshots.some((item) => item.professional?.reviews?.length === 1));
  assert.ok(snapshots.some((item) => item.builds?.length === 1));
  assert.ok(snapshots.some((item) => item.benchmark?.[0]?.entries?.length === 1));
  assert.ok(snapshots.some((item) => item.activeWork?.type === 'review'));
  assert.ok(snapshots.some((item) => item.activeWork?.type === 'build'));
  assert.ok(snapshots.some((item) => item.activeWork?.type === 'benchmark'));
  assert.equal(store.get(created.id).status, 'completed');
  assert.equal(created.schemaVersion, 1);
  assert.equal(store.get(created.id).schemaVersion, 1);
  assert.equal(store.get(created.id).activeWork, null);
  assert.equal(store.get(created.id).seed, 424242);
  assert.equal(store.get(created.id).temperature, 0);
  assert.equal(store.get(created.id).reviewPlan.length, 4);
  assert.equal(store.get(created.id).runtimePlan.length, 3);
  assert.equal(store.get(created.id).professional.version, 'v1-card-review/v2');
  assert.deepEqual(Object.keys(store.get(created.id).reviewPlan[0]).sort(), ['id', 'model', 'name']);
  assert.equal(store.get(created.id).professional.reviews.every((review) => Number.isInteger(review.seed)), true);
  assert.equal(store.get(created.id).builds.every((build) => Number.isInteger(build.seed)), true);
});

test('fresh V1 runs classify empty, whitespace and non-string Runtime outputs as failed', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-visible-output-${process.pid}.json`));
  const outputs = ['', ' \n\t ', { text: 'not a final string' }];
  let invocation = 0;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    runSkillFn: async () => outputs[invocation++],
    scoreV1Case: async (input) => successfulV1ScoringResult(input)
  });
  const created = await pipeline.create({
    mode: 'demo',
    agentCard: evaluation('template').agentCard,
    cases: [{ name: 'case', prompt: 'test prompt' }]
  });
  const completed = await waitFor(store, created.id, (value) => value.status === 'completed');
  const runtimes = completed.benchmark[0].entries.filter((entry) => entry.id !== 'submitted');

  assert.equal(runtimes.length, 3);
  for (const entry of runtimes) {
    assert.equal(entry.execution.status, 'failed');
    assert.equal(entry.mode, 'failed');
    assert.equal(entry.scoreStatus, 'execution-failed');
    assert.equal(entry.score, 0);
    assert.equal(entry.dimensions, null);
    assert.match(entry.output, /未返回可见最终输出/);
  }
});

test('retries an individual stage and recalculates the derived verdict', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-retry-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({ mode: 'demo', agentCard: evaluation('template').agentCard, cases: [{ name: 'case', prompt: 'test prompt' }] });
  let item = await waitFor(store, created.id, (value) => value.status === 'completed');
  assert.equal(item.status, 'completed');

  await pipeline.retry(created.id, { type: 'review', key: 'gpt' });
  assert.equal(store.get(created.id).status, 'retrying');
  assert.equal(store.get(created.id).activeWork.type, 'review');
  assert.equal(store.get(created.id).activeWork.retry, true);
  item = await waitFor(store, created.id, (value) => value.status === 'completed' && value.retryHistory?.length === 1);
  assert.equal(item.retryHistory[0].type, 'review');
  assert.equal(item.professional.reviews.find((review) => review.reviewerId === 'gpt').score > 0, true);
  assert.equal(item.professional.version, 'v1-card-review/v2');
  assert.equal(item.professional.reviews.filter((review) => review.reviewerId === 'gpt').length, 1);
  assert.ok(item.roast?.tier);
  assert.equal(item.activeWork, null);

  await pipeline.retry(created.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  item = await waitFor(store, created.id, (value) => value.status === 'completed' && value.retryHistory?.length === 2);
  assert.equal(item.retryHistory.at(-1).type, 'benchmark');
  assert.equal(item.benchmark[0].entries.filter((entry) => entry.id === 'submitted').length, 1, '重跑应替换而不是追加选手结果');

  await pipeline.retry(created.id, { type: 'build', key: 'claude-code' });
  item = await waitFor(store, created.id, (value) => value.status === 'completed' && value.retryHistory?.length === 3);
  assert.equal(item.retryHistory.at(-1).type, 'build');
  assert.equal(item.benchmark[0].entries.filter((entry) => entry.id === 'claude-code').length, 1);
  assert.ok(Number.isFinite(item.averages.submitted));

  const legacyReview = item.professional.reviews.find((review) => review.reviewerId === 'gpt');
  delete legacyReview.reviewerId;
  legacyReview.model = 'GPT-5 Legacy';
  await store.set(item);
  const oldBaseUrl = process.env.OPENAI_BASE_URL;
  const oldApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = 'https://gateway.example.test/v1';
  process.env.OPENAI_API_KEY = 'test-only';
  try {
    await pipeline.retry(created.id, { type: 'review', key: 'GPT-5 Legacy' });
    item = await waitFor(store, created.id, (value) => value.status === 'completed' && value.retryHistory?.length === 4);
    const updatedReview = item.professional.reviews.find((review) => review.reviewerId === 'gpt');
    assert.ok(updatedReview);
    assert.notEqual(updatedReview.model, 'GPT-5 Legacy', '历史模型显示名应映射到当前 reviewer 配置');
  } finally {
    if (oldBaseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = oldBaseUrl;
    if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldApiKey;
  }
});

test('rescoring a retried V1 competitor replaces the complete CASE score snapshot', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-case-${process.pid}.json`));
  const scoreCalls = [];
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async (input) => {
      scoreCalls.push(structuredClone(input));
      return successfulV1ScoringResult(input);
    }
  });
  const item = completedV1Evaluation('eval_v1_retry_case');
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  const updated = await waitFor(store, item.id, (value) =>
    value.status === 'completed' && value.retryHistory?.length === 1
  );

  assert.equal(scoreCalls.length, 1);
  assert.deepEqual(scoreCalls[0].entries.map((entry) => entry.id), [
    'submitted',
    'claude-code',
    'cursor',
    'doubao'
  ]);
  assert.equal(scoreCalls[0].entries.find((entry) => entry.id === 'submitted').score, null);
  assert.equal(updated.benchmark[0].judging.version, 'v1-model-arena/v1');
  assert.equal(updated.benchmark[0].entries.every((entry) => entry.score === 80), true);
});

test('V1 v2 benchmark retry replaces the execution snapshot before rescoring the complete CASE', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-v2-retry-execution-${process.pid}.json`));
  const scoreCalls = [];
  let monotonic = 0;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    monotonicNow: () => {
      const value = monotonic;
      monotonic += 12_345;
      return value;
    },
    scoreV1Case: async (input) => {
      scoreCalls.push(structuredClone(input));
      return successfulV1ScoringResult(input);
    }
  });
  const item = completedV1Evaluation('eval_v1_v2_retry_execution');
  item.scoringConfig = { version: 'v1-model-arena/v2', mode: 'single', reviewerId: 'deepseek' };
  item.benchmark[0].entries.forEach((entry) => {
    entry.execution = {
      status: 'succeeded',
      durationMs: 999,
      timingScope: 'end-to-end-wall-clock',
      includesNetwork: true,
      toolObservation: 'unavailable',
      contextUsage: []
    };
  });
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  const updated = await waitFor(store, item.id, (value) =>
    value.status === 'completed' && value.retryHistory?.length === 1
  );

  assert.equal(scoreCalls.length, 1);
  assert.deepEqual(
    scoreCalls[0].entries.find((entry) => entry.id === 'submitted').execution,
    {
      status: 'succeeded',
      durationMs: 12_345,
      timingScope: 'end-to-end-wall-clock',
      includesNetwork: true,
      toolObservation: 'unavailable',
      contextUsage: []
    }
  );
  assert.equal(updated.benchmark[0].entries.filter((entry) => entry.id === 'submitted').length, 1);
  assert.equal(updated.benchmark[0].entries.find((entry) => entry.id === 'submitted').score, 80);
});

test('V1 v2 records failed calls and build failures as zero-capability executions', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-v2-execution-failures-${process.pid}.json`));
  let monotonic = 0;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    monotonicNow: () => {
      const value = monotonic;
      monotonic += 12_345;
      return value;
    },
    buildSkillFn: async (runtime) => {
      if (runtime.id === 'cursor') throw new Error('skill build rejected');
      return {
        runtime: runtime.name,
        runtimeId: runtime.id,
        model: runtime.model,
        mode: 'demo',
        skill: { name: `${runtime.id}-skill`, description: 'test', instructions: ['run'], tools: [] }
      };
    },
    runSkillFn: async (build) => {
      if (build.runtimeId === 'claude-code') throw new Error('runtime call rejected');
      return `${build.runtimeId} output`;
    }
  });
  const created = await pipeline.create({
    mode: 'demo',
    agentCard: evaluation('template').agentCard,
    cases: [{ name: 'case', prompt: 'test prompt' }]
  });
  const completed = await waitFor(store, created.id, (value) =>
    value.status === 'completed' || value.status === 'failed'
  );

  assert.equal(completed.status, 'completed');
  const runtimeFailure = completed.benchmark[0].entries.find((entry) => entry.id === 'claude-code');
  const buildFailure = completed.benchmark[0].entries.find((entry) => entry.id === 'cursor');
  assert.deepEqual(runtimeFailure.execution, {
    status: 'failed',
    durationMs: 12_345,
    timingScope: 'end-to-end-wall-clock',
    includesNetwork: true,
    toolObservation: 'unavailable',
    contextUsage: []
  });
  assert.equal(runtimeFailure.score, 0);
  assert.equal(runtimeFailure.detail.capability.capabilityScore, 0);
  assert.deepEqual(buildFailure.execution, {
    status: 'failed',
    durationMs: 0,
    timingScope: 'end-to-end-wall-clock',
    includesNetwork: true,
    toolObservation: 'unavailable',
    contextUsage: [],
    failureStage: 'skill-build'
  });
  assert.equal(buildFailure.score, 0);
  assert.equal(buildFailure.detail.capability.capabilityScore, 0);
});

test('V1 rejects undefined, NaN, Infinity, and thrown monotonic clock starts instead of assigning zero-duration capability', async () => {
  const invalidClocks = [
    ['undefined', () => undefined],
    ['NaN', () => Number.NaN],
    ['Infinity', () => Number.POSITIVE_INFINITY],
    ['throws', () => { throw new Error('clock unavailable'); }]
  ];
  for (const [label, monotonicNow] of invalidClocks) {
    const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-v2-invalid-clock-${label}-${process.pid}.json`));
    const pipeline = new EvaluationPipeline(store, new EventEmitter(), { monotonicNow });
    const created = await pipeline.create({
      mode: 'demo',
      agentCard: evaluation('template').agentCard,
      cases: [{ name: 'case', prompt: 'test prompt' }]
    });
    const result = await waitFor(store, created.id, (value) => value.status === 'failed');
    assert.equal(result.status, 'failed');
    assert.match(result.error, /单调时钟/);
    assert.equal(result.benchmark?.[0]?.entries?.some((entry) => entry.execution?.durationMs === 0), false);
  }
});

test('V1 v2 retry keeps the prior CASE when the end monotonic clock is unavailable', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-v2-retry-clock-${process.pid}.json`));
  let clockCalls = 0;
  let scoreCalls = 0;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    monotonicNow: () => {
      clockCalls += 1;
      if (clockCalls === 1) return 100;
      throw new Error('clock exhausted');
    },
    scoreV1Case: async (input) => {
      scoreCalls += 1;
      return successfulV1ScoringResult(input);
    }
  });
  const item = completedV1Evaluation('eval_v1_v2_retry_clock');
  item.scoringConfig = { version: 'v1-model-arena/v2', mode: 'single', reviewerId: 'deepseek' };
  item.benchmark[0].entries.forEach((entry) => {
    entry.execution = {
      status: 'succeeded',
      durationMs: 999,
      timingScope: 'end-to-end-wall-clock',
      includesNetwork: true,
      toolObservation: 'unavailable',
      contextUsage: []
    };
  });
  const previousRound = structuredClone(item.benchmark[0]);
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  const updated = await waitFor(store, item.id, (value) => value.retryHistory?.length === 1);

  assert.equal(scoreCalls, 0);
  assert.equal(updated.status, 'completed');
  assert.deepEqual(updated.benchmark[0], previousRound);
  assert.match(updated.retryHistory[0].result.error, /单调时钟/);
});

test('keeps the live V1 CASE and derived verdict unchanged while benchmark rescoring is pending', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-atomic-pending-${process.pid}.json`));
  const scoringStarted = deferredValue();
  const scoringResult = deferredValue();
  let scoringInput;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async (input) => {
      scoringInput = structuredClone(input);
      scoringStarted.resolve();
      return scoringResult.promise;
    }
  });
  const item = completedV1Evaluation('eval_v1_retry_atomic_pending');
  const previousRound = structuredClone(item.benchmark[0]);
  const previousAverages = structuredClone(item.averages);
  const previousRoast = structuredClone(item.roast);
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  await scoringStarted.promise;

  const pending = store.get(item.id);
  assert.deepEqual(pending.benchmark[0], previousRound);
  assert.deepEqual(pending.averages, previousAverages);
  assert.deepEqual(pending.roast, previousRoast);
  assert.equal(pending.completedAt, item.completedAt);

  scoringResult.resolve(successfulV1ScoringResult(scoringInput));
  const updated = await waitFor(store, item.id, (value) =>
    value.status === 'completed' && value.retryHistory?.length === 1
  );
  assert.equal(updated.benchmark[0].entries.every((entry) => entry.score === 80), true);
});

test('whitespace Runtime retry is classified failed before atomic CASE replacement', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-visible-output-${process.pid}.json`));
  const scoringStarted = deferredValue();
  const scoringResult = deferredValue();
  let scoringInput;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    runSkillFn: async () => ' \n\t ',
    scoreV1Case: async (input) => {
      scoringInput = structuredClone(input);
      scoringStarted.resolve();
      return scoringResult.promise;
    }
  });
  const item = completedV1Evaluation('eval_v1_retry_visible_output');
  item.scoringConfig = { version: 'v1-model-arena/v2', mode: 'single', reviewerId: 'deepseek' };
  item.benchmark[0].judging.version = 'v1-model-arena/v2';
  item.benchmark[0].entries.forEach((entry) => {
    entry.execution = {
      status: 'succeeded', durationMs: 999, timingScope: 'end-to-end-wall-clock',
      includesNetwork: true, toolObservation: 'unavailable', contextUsage: []
    };
  });
  const previousRound = structuredClone(item.benchmark[0]);
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'claude-code', caseIndex: 0 });
  await scoringStarted.promise;
  const candidate = scoringInput.entries.find((entry) => entry.id === 'claude-code');
  assert.equal(candidate.execution.status, 'failed');
  assert.equal(candidate.mode, 'failed');
  assert.equal(candidate.scoreStatus, 'execution-failed');
  assert.equal(candidate.score, 0);
  assert.match(candidate.output, /未返回可见最终输出/);
  assert.deepEqual(store.get(item.id).benchmark[0], previousRound);

  scoringResult.resolve(successfulV1ScoringResult(scoringInput));
  const updated = await waitFor(store, item.id, (value) => value.retryHistory?.length === 1);
  const persisted = updated.benchmark[0].entries.find((entry) => entry.id === 'claude-code');
  assert.equal(persisted.execution.status, 'failed');
  assert.equal(persisted.score, 0);
  assert.equal(persisted.scoreStatus, 'execution-failed');
});

test('retains the coherent V1 CASE and derived verdict when benchmark rescoring rejects', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-atomic-reject-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async () => {
      throw new Error('judge transport rejected');
    }
  });
  const item = completedV1Evaluation('eval_v1_retry_atomic_reject');
  const previousRound = structuredClone(item.benchmark[0]);
  const previousAverages = structuredClone(item.averages);
  const previousRoast = structuredClone(item.roast);
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  const updated = await waitFor(store, item.id, (value) =>
    value.status === 'completed' && value.retryHistory?.length === 1
  );

  assert.deepEqual(updated.benchmark[0], previousRound);
  assert.deepEqual(updated.averages, previousAverages);
  assert.deepEqual(updated.roast, previousRoast);
  assert.equal(updated.completedAt, item.completedAt);
  assert.match(updated.retryHistory[0].result.error, /judge transport rejected/);
});

test('retains the coherent V1 CASE when cancellation wins a pending benchmark rescore', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-atomic-cancel-${process.pid}.json`));
  const scoringStarted = deferredValue();
  const scoringResult = deferredValue();
  let scoringInput;
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async (input) => {
      scoringInput = structuredClone(input);
      scoringStarted.resolve();
      return scoringResult.promise;
    }
  });
  const item = completedV1Evaluation('eval_v1_retry_atomic_cancel');
  const previousRound = structuredClone(item.benchmark[0]);
  const previousAverages = structuredClone(item.averages);
  const previousRoast = structuredClone(item.roast);
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  await scoringStarted.promise;
  await pipeline.cancel(item.id);
  scoringResult.resolve(successfulV1ScoringResult(scoringInput));
  for (let attempt = 0; attempt < 20 && pipeline.activeRuns.has(item.id); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const cancelled = store.get(item.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.benchmark[0], previousRound);
  assert.deepEqual(cancelled.averages, previousAverages);
  assert.deepEqual(cancelled.roast, previousRoast);
  assert.equal(cancelled.completedAt, item.completedAt);
});

test('rescoring a rebuilt V1 runtime occurs once per affected CASE', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-build-${process.pid}.json`));
  const scoreCalls = [];
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async (input) => {
      scoreCalls.push(structuredClone(input));
      return successfulV1ScoringResult(input);
    }
  });
  const item = completedV1Evaluation('eval_v1_retry_build', ['case one', 'case two']);
  await store.set(item);

  await pipeline.retry(item.id, { type: 'build', key: 'claude-code' });
  const updated = await waitFor(store, item.id, (value) =>
    value.status === 'completed' && value.retryHistory?.length === 1
  );

  assert.equal(scoreCalls.length, 2);
  assert.deepEqual(scoreCalls.map((call) => call.testCase.name), ['case one', 'case two']);
  assert.equal(scoreCalls.every((call) =>
    call.entries.find((entry) => entry.id === 'claude-code').score === null
  ), true);
  assert.equal(updated.benchmark.every((roundItem) =>
    roundItem.judging.status === 'scored' &&
    roundItem.entries.every((entry) => Number.isFinite(entry.score))
  ), true);
});

test('keeps the live V1 CASE coherent during rejected build-retry rescoring', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-build-atomic-${process.pid}.json`));
  const scoringStarted = deferredValue();
  const scoringResult = deferredValue();
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async () => {
      scoringStarted.resolve();
      return scoringResult.promise;
    }
  });
  const item = completedV1Evaluation('eval_v1_retry_build_atomic');
  const previousRound = structuredClone(item.benchmark[0]);
  const previousAverages = structuredClone(item.averages);
  const previousRoast = structuredClone(item.roast);
  await store.set(item);

  await pipeline.retry(item.id, { type: 'build', key: 'claude-code' });
  await scoringStarted.promise;

  const pending = store.get(item.id);
  assert.deepEqual(pending.benchmark[0], previousRound);
  assert.deepEqual(pending.averages, previousAverages);
  assert.deepEqual(pending.roast, previousRoast);

  scoringResult.reject(new Error('build retry judge rejected'));
  const updated = await waitFor(store, item.id, (value) =>
    value.status === 'completed' && value.retryHistory?.length === 1
  );
  assert.deepEqual(updated.benchmark[0], previousRound);
  assert.deepEqual(updated.averages, previousAverages);
  assert.deepEqual(updated.roast, previousRoast);
  assert.equal(updated.completedAt, item.completedAt);
  assert.match(updated.retryHistory[0].result.error, /build retry judge rejected/);
});

test('does not retain a V1 verdict when retry scoring leaves partial scores', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-failed-score-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async ({ entries, config }) => ({
      status: 'failed',
      entries: entries.map((entry) => ({
        ...entry,
        scoreStatus: 'model-failed',
        score: null,
        dimensions: null,
        judgeReviews: []
      })),
      judging: {
        version: 'v1-model-arena/v1',
        status: 'failed',
        mode: config.mode,
        reviewerId: config.reviewerId,
        requiredSeats: 1,
        successfulSeats: 0,
        seats: []
      }
    })
  });
  const item = completedV1Evaluation('eval_v1_retry_failed_score');
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  const updated = await waitFor(store, item.id, (value) => value.retryHistory?.length === 1);

  assert.equal(updated.benchmark[0].judging.status, 'failed');
  assert.equal(updated.benchmark[0].entries.every((entry) => entry.score === null), true);
  assert.equal(updated.status, 'failed');
  assert.equal(Object.hasOwn(updated, 'averages'), false);
  assert.equal(Object.hasOwn(updated, 'roast'), false);
  assert.equal(Object.hasOwn(updated, 'completedAt'), false);
});

test('does not derive a V1 verdict when scored judging contains a null candidate score', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-null-score-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async (input) => {
      const scoring = successfulV1ScoringResult(input);
      const cursor = scoring.entries.find((entry) => entry.id === 'cursor');
      cursor.scoreStatus = 'model-failed';
      cursor.score = null;
      cursor.dimensions = null;
      return scoring;
    }
  });
  const item = completedV1Evaluation('eval_v1_retry_null_score');
  await store.set(item);

  await pipeline.retry(item.id, { type: 'benchmark', key: 'submitted', caseIndex: 0 });
  const updated = await waitFor(store, item.id, (value) => value.retryHistory?.length === 1);

  assert.equal(updated.benchmark[0].judging.status, 'scored');
  assert.equal(updated.benchmark[0].entries.find((entry) => entry.id === 'cursor').score, null);
  assert.equal(updated.status, 'failed');
  assert.equal(Object.hasOwn(updated, 'averages'), false);
  assert.equal(Object.hasOwn(updated, 'roast'), false);
  assert.equal(Object.hasOwn(updated, 'completedAt'), false);
});

test('marks a historical V1 retry failed when its model-era round judging fails', async () => {
  const store = new EvaluationStore(path.join(
    tmpdir(),
    `agent-roast-v1-retry-legacy-model-failure-${process.pid}.json`
  ));
  const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
    scoreV1Case: async ({ entries, config }) => ({
      status: 'failed',
      entries: entries.map((entry) => ({
        ...entry,
        scoreStatus: entry.mode === 'failed' ? 'execution-failed' : 'model-failed',
        score: entry.mode === 'failed' ? 0 : null,
        dimensions: null,
        judgeReviews: []
      })),
      judging: {
        version: 'v1-model-arena/v1',
        status: 'failed',
        mode: config.mode,
        reviewerId: config.reviewerId,
        requiredSeats: 1,
        successfulSeats: 0,
        seats: []
      }
    })
  });
  const item = completedV1Evaluation('eval_v1_retry_legacy_model_failure');
  delete item.scoringConfig;
  delete item.benchmark[0].judging;
  await store.set(item);

  await pipeline.retry(item.id, {
    type: 'benchmark',
    key: 'submitted',
    caseIndex: 0
  });
  const updated = await waitFor(store, item.id, (value) =>
    value.retryHistory?.length === 1
  );

  assert.equal(updated.benchmark[0].judging.status, 'failed');
  assert.equal(updated.status, 'failed');
  assert.equal(Object.hasOwn(updated, 'averages'), false);
  assert.equal(Object.hasOwn(updated, 'roast'), false);
  assert.equal(Object.hasOwn(updated, 'completedAt'), false);
});

test('retains entry-presence completeness for historical V1 retry records', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-v1-retry-legacy-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const item = completedV1Evaluation('eval_v1_retry_legacy');
  delete item.scoringConfig;
  delete item.benchmark[0].judging;
  item.benchmark[0].entries.forEach((entry) => {
    entry.score = null;
  });
  delete item.averages;
  delete item.roast;
  await store.set(item);

  await pipeline.retry(item.id, { type: 'review', key: 'gpt' });
  const updated = await waitFor(store, item.id, (value) =>
    value.status === 'completed' && value.retryHistory?.length === 1
  );

  assert.deepEqual(updated.averages, {
    submitted: 0,
    'claude-code': 0,
    cursor: 0,
    doubao: 0
  });
  assert.equal(Object.hasOwn(updated.professional, 'version'), false);
  assert.equal(updated.professional.reviews[0].version, undefined);
  assert.deepEqual(
    Object.keys(updated.professional.reviews[0].dimensions).sort(),
    ['backtestIntegrity', 'dataDiscipline', 'reproducibility', 'researchRigor', 'riskCompliance']
  );
  assert.ok(updated.roast?.tier);
});

test('produces identical demo scores for the same explicit seed', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-seed-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const input = { mode: 'demo', seed: 731, agentCard: evaluation('template').agentCard, cases: [{ name: 'case', prompt: 'same prompt' }] };
  const first = await pipeline.create(input);
  const firstResult = await waitFor(store, first.id, (value) => value.status === 'completed');
  const second = await pipeline.create(input);
  const secondResult = await waitFor(store, second.id, (value) => value.status === 'completed');
  assert.deepEqual(secondResult.professional.reviews.map((review) => review.score), firstResult.professional.reviews.map((review) => review.score));
  assert.deepEqual(secondResult.averages, firstResult.averages);
  assert.deepEqual(secondResult.roast, firstResult.roast);
});

test('marks a failed live Agent call as failed coverage', async () => {
  const envNames = ['ALLOW_PRIVATE_AGENT_URLS', 'MODEL_REVIEWERS_JSON', 'RUNTIME_ADAPTERS_JSON', 'ENABLE_LOCAL_CLAUDE_CODE', 'ENABLE_LOCAL_CURSOR_AGENT', 'ARK_BASE_URL', 'ARK_API_KEY'];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const failingAgent = createServer((_request, response) => { response.writeHead(503); response.end('offline'); });
  await new Promise((resolve) => failingAgent.listen(0, '127.0.0.1', resolve));
  try {
    process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
    process.env.MODEL_REVIEWERS_JSON = JSON.stringify([{ id: 'mock', name: 'Mock', model: 'Mock', kind: 'mock' }]);
    process.env.RUNTIME_ADAPTERS_JSON = '{}';
    process.env.ENABLE_LOCAL_CLAUDE_CODE = 'false';
    process.env.ENABLE_LOCAL_CURSOR_AGENT = 'false';
    delete process.env.ARK_BASE_URL;
    delete process.env.ARK_API_KEY;
    const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-coverage-${process.pid}.json`));
    const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
      v1Reviewers: [liveV1Reviewer()],
      scoreV1Case: async (input) => successfulV1ScoringResult(input)
    });
    const card = evaluation('template').agentCard;
    card.supportedInterfaces[0].url = `http://127.0.0.1:${failingAgent.address().port}/a2a`;
    const created = await pipeline.create({ mode: 'live', agentCard: card, cases: [{ name: 'failure', prompt: 'test prompt' }] });
    const result = await waitFor(store, created.id, (value) => value.status === 'completed');
    assert.equal(result.coverage.agent, 'failed');
    assert.equal(result.benchmark[0].entries.find((entry) => entry.id === 'submitted').mode, 'failed');
    assert.equal(result.overallMode, 'mixed');
  } finally {
    await new Promise((resolve) => failingAgent.close(resolve));
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});

test('uses one PandaAI snapshot to verify every benchmark output', async () => {
  const envNames = ['ALLOW_PRIVATE_AGENT_URLS', 'MODEL_REVIEWERS_JSON', 'RUNTIME_ADAPTERS_JSON', 'ENABLE_LOCAL_CLAUDE_CODE', 'ENABLE_LOCAL_CURSOR_AGENT', 'ARK_BASE_URL', 'ARK_API_KEY'];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const agent = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      message: {
        messageId: 'panda-evidence-reply',
        role: 'ROLE_AGENT',
        parts: [{ text: '数据来源：PandaAI。沪深 300 期末收盘为 11.30 点，风险提示：历史数据不代表未来收益。' }]
      }
    }));
  });
  await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve));
  let queryCalls = 0;
  try {
    process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
    process.env.MODEL_REVIEWERS_JSON = JSON.stringify([{ id: 'mock', name: 'Mock', model: 'Mock', kind: 'mock' }]);
    process.env.RUNTIME_ADAPTERS_JSON = '{}';
    process.env.ENABLE_LOCAL_CLAUDE_CODE = 'false';
    process.env.ENABLE_LOCAL_CURSOR_AGENT = 'false';
    delete process.env.ARK_BASE_URL;
    delete process.env.ARK_API_KEY;
    const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-data-evidence-${process.pid}.json`));
    const pipeline = new EvaluationPipeline(store, new EventEmitter(), {
      dataVerificationEnabled: true,
      dataQuery: async () => {
        queryCalls += 1;
        return { provider: 'pandaai', method: 'get_index_daily', rowCount: 1, truncated: false, data: [{ symbol: '000300.SH', date: '20250110', close: 11.3 }] };
      },
      v1Reviewers: [liveV1Reviewer()],
      scoreV1Case: async (input) => successfulV1ScoringResult(input)
    });
    const card = evaluation('template').agentCard;
    card.supportedInterfaces[0].url = `http://127.0.0.1:${agent.address().port}/a2a`;
    const created = await pipeline.create({
      mode: 'live', agentCard: card,
      cases: [{
        name: '数据锚点', prompt: '截至 2025-01-10，报告沪深 300 期末收盘。',
        dataQueries: [{
          method: 'get_index_daily', params: { symbol: ['000300.SH'], start_date: '20250101', end_date: '20250110', fields: [] },
          requiredFields: ['date', 'symbol', 'close'],
          facts: [{ label: '沪深 300 期末收盘', field: 'close', aliases: ['期末收盘'], tolerance: 0.01 }]
        }]
      }]
    });
    const result = await waitFor(store, created.id, (value) => value.status === 'completed');
    assert.equal(queryCalls, 1, '同一用例的所有选手必须复用同一份参考快照');
    assert.equal(result.benchmark[0].dataEvidence.status, 'ready');
    assert.equal(result.benchmark[0].entries.find((entry) => entry.id === 'submitted').dataVerification.status, 'verified');
    assert.equal(result.benchmark[0].entries.find((entry) => entry.id === 'submitted').dimensions.evidenceRisk, 96);
    assert.ok(result.logs.some((log) => log.source === 'DATA' && log.phase === 'evidence'));
  } finally {
    await new Promise((resolve) => agent.close(resolve));
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});

test('rejects an unknown retry step and a retry while work is active', async () => {
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-retry-invalid-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const active = evaluation('eval_active');
  const done = evaluation('eval_done_retry', 'completed');
  await store.set(active);
  await store.set(done);
  await assert.rejects(() => pipeline.retry(active.id, { type: 'review', key: 'gpt' }), (error) => error.statusCode === 409);
  await assert.rejects(() => pipeline.retry(done.id, { type: 'review', key: 'missing' }), (error) => error.statusCode === 400);
});
