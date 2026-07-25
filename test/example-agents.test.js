import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callA2AAgent, resolveAgentCard } from '../src/a2a.js';
import { executeA2AExample } from '../src/a2a-executor.js';
import { startExampleAgents, stopExampleAgents } from '../examples/agents/server.js';
import { EvidenceVault } from '../src/evidence-vault.js';
import { EvaluationPipeline } from '../src/pipeline.js';
import { EvaluationStore } from '../src/store.js';
import { EventEmitter } from 'node:events';

process.env.ALLOW_PRIVATE_AGENT_URLS = 'true';
let agents;

test.before(async () => { agents = await startExampleAgents({ ports: [0, 0, 0] }); });
test.after(async () => stopExampleAgents(agents));

test('discovers all examples from the well-known Agent Card path', async () => {
  for (const agent of agents) {
    const resolved = await resolveAgentCard('service-url', agent.origin);
    assert.equal(resolved.card.name, agent.name);
    assert.match(resolved.resolvedUrl, /\.well-known\/agent-card\.json$/);
  }
});

test('serves a human-readable status page at each example root', async () => {
  const response = await fetch(`${agents[0].origin}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /因子显微镜/);
  assert.match(html, /\.well-known\/agent-card\.json/);
});

test('calls the A2A 1.0 HTTP+JSON factor researcher', async () => {
  const card = (await resolveAgentCard('service-url', agents[0].origin)).card;
  const result = await callA2AAgent(card, '检验经营现金流收益率因子的 Rank IC 与五分组表现');
  assert.match(result.text, /Rank IC/);
  assert.match(result.text, /不构成投资建议/);
  assert.equal(result.run.outcome.status, 'succeeded');
});

test('returns and consumes a real context ID across turns without using message IDs', async () => {
  const card = (await resolveAgentCard('service-url', agents[0].origin)).card;
  const result = await executeA2AExample({
    card,
    example: {
      id: 'factor-follow-up',
      turns: [
        { input: { parts: [{ type: 'text', text: 'start research' }] } },
        { input: { parts: [{ type: 'text', text: 'continue research' }] } }
      ]
    },
    repeatIndex: 0,
    policy: { timeoutMs: 5_000 }
  });

  assert.equal(result.contextCheck.status, 'passed');
  assert.equal(result.runs[0].response.normalized.contextId, result.runs[1].response.normalized.contextId);
  assert.notEqual(
    result.runs[0].response.normalized.contextId,
    result.runs[0].response.normalized.messages[0].messageId
  );
});

test('calls the A2A 1.0 JSON-RPC strategy backtester with SendMessage', async () => {
  const card = (await resolveAgentCard('card-url', `${agents[1].origin}/.well-known/agent-card.json`)).card;
  const result = await callA2AAgent(card, '回测沪深 300 月度动量策略，计入手续费和滑点');
  assert.match(result.text, /沪深 300/);
  assert.match(result.text, /手续费/);
});

test('calls the A2A 0.3 JSON-RPC portfolio risk agent and extracts task artifacts', async () => {
  const card = (await resolveAgentCard('service-url', agents[2].origin)).card;
  const result = await callA2AAgent(card, '科技 42%，模拟板块下跌 10% 的冲击');
  assert.match(result.text, /组合风险快照/);
  assert.match(result.text, /-4\.2%/);
});

test('runs a complete live-mode platform evaluation against a real A2A agent', async () => {
  const card = (await resolveAgentCard('service-url', agents[1].origin)).card;
  const store = new EvaluationStore(path.join(tmpdir(), `agent-roast-live-${process.pid}.json`));
  const pipeline = new EvaluationPipeline(store, new EventEmitter());
  const created = await pipeline.create({
    mode: 'live', agentCard: card,
    cases: [{ name: '真实回测测试', prompt: '回测沪深 300 月度动量策略，计入手续费、滑点并报告最大回撤。' }]
  });
  let result;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    result = store.get(created.id);
    if (['completed', 'failed'].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(result.status, 'completed');
  const submitted = result.benchmark[0].entries.find((entry) => entry.id === 'submitted');
  assert.equal(submitted.mode, 'live');
  assert.match(submitted.output, /沪深 300/);
  assert.equal(result.builds.every((build) => build.mode === 'demo'), true, '未配置 runtime 时必须明确保留 demo 标签');
  assert.deepEqual(result.coverage, { agent: 'live', models: 'demo', runtimes: 'demo' });
  assert.equal(result.overallMode, 'mixed');
});

test('V2 fixture closes its API server even when worker settlement fails', async () => {
  let aborted = false;
  let closed = false;
  const fixture = {
    pipeline: {
      activeRuns: new Map([[
        'eval_fixture',
        { abort: () => { aborted = true; } }
      ]])
    },
    server: {
      listening: true,
      close(callback) {
        closed = true;
        callback();
      }
    }
  };

  await assert.rejects(
    shutdownApiFixture(fixture, async () => {
      throw new Error('worker settlement timed out');
    }),
    /worker settlement timed out/
  );
  assert.equal(aborted, true);
  assert.equal(closed, true);
});

test('runs the complete V2 black-box evidence pipeline against a real A2A agent', async () => {
  const privatePrompt = 'LIVE_V2_PRIVATE_PROMPT_SENTINEL';
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'agent-roast-v2-live-')
  );
  const evidenceRoot = path.join(temporaryRoot, 'evidence');
  const evidenceKey = Buffer.alloc(32, 17);
  let liveAgents;
  let apiModule;
  let sseAbort;
  const environment = captureEnvironment([
    'NODE_ENV',
    'DATA_FILE',
    'A2A_BLACK_BOX_V1_ENABLED',
    'EVIDENCE_ENCRYPTION_KEY',
    'EVIDENCE_ROOT'
  ]);

  try {
    liveAgents = await startExampleAgents({ ports: [0, 0, 0] });
    const card = (
      await resolveAgentCard('service-url', liveAgents[0].origin)
    ).card;
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATA_FILE: path.join(temporaryRoot, 'evaluations.json'),
      A2A_BLACK_BOX_V1_ENABLED: 'true',
      EVIDENCE_ENCRYPTION_KEY: evidenceKey.toString('base64'),
      EVIDENCE_ROOT: evidenceRoot
    });
    apiModule = await import('../server.js');
    await new Promise((resolve) =>
      apiModule.server.listen(0, '127.0.0.1', resolve)
    );
    const apiOrigin =
      `http://127.0.0.1:${apiModule.server.address().port}`;
    const createResponse = await fetch(`${apiOrigin}/api/evaluations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 2,
        agentCard: card,
        agentExamples: [
          {
            id: 'factor-multipart',
            name: 'Multipart factor workflow',
            turns: [
              {
                input: {
                  parts: [
                    {
                      type: 'text',
                      text: `${privatePrompt}: report Rank IC`
                    },
                    {
                      type: 'data',
                      data: {
                        universe: 'CSI300',
                        asOf: '2024-12-31'
                      }
                    }
                  ]
                },
                expectedDeliverable: 'A research note including Rank IC',
                acceptanceCriteria: [{
                  id: 'rank-ic',
                  type: 'contains',
                  expected: ['Rank IC'],
                  description: 'Includes Rank IC',
                  required: true
                }]
              },
              {
                input: {
                  parts: [{
                    type: 'text',
                    text: 'Continue the same research and summarize its risks'
                  }]
                }
              }
            ]
          },
          {
            id: 'model-only',
            name: 'Model-only qualitative review',
            turns: [{
              input: {
                parts: [{
                  type: 'text',
                  text: 'Provide a qualitative factor-research memo'
                }]
              },
              acceptanceCriteria: [{
                id: 'qualitative-review',
                type: 'model',
                description: 'Review the qualitative research quality',
                required: true
              }]
            }]
          }
        ]
      })
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 202);
    assert.equal(Object.hasOwn(created, 'participantAccessToken'), false);

    const completed = await waitForTerminalEvaluation(
      apiModule.evaluationStore,
      created.id
    );

    assert.equal(
      completed.execution.status,
      'completed',
      JSON.stringify({
        execution: completed.execution,
        testPlanStatus: completed.testPlan?.status,
        completedCells: completed.phase2Execution?.testRuns?.length,
        lastAudit: completed.auditEvents?.at(-1)
      })
    );
    assert.equal(completed.qualification.status, 'eligible');
    assert.equal(completed.testPlan.status, 'ready');
    assert.equal(completed.testPlan.tests.length, 9);
    assert.equal(completed.phase2Execution.testRuns.length, 27);
    assert.equal(completed.absoluteReview.status, 'model-locked');
    assert.equal(completed.governance.phase, 'human_open');
    await waitForNoActiveRuns(apiModule.pipeline);

    const cellsByExample = ['factor-multipart', 'model-only'].map(
      (sourceExampleId) => {
        const testIds = new Set(completed.testPlan.tests
          .filter((planned) => planned.sourceExampleId === sourceExampleId)
          .map((planned) => planned.testId));
        return completed.phase2Execution.testRuns.filter(
          (testRun) => testIds.has(testRun.testId)
        );
      }
    );
    for (const cells of cellsByExample) {
      assert.equal(cells.length, 12);
      assert.deepEqual(
        [...new Set(cells.map((cell) => cell.repeatIndex))],
        [0, 1, 2]
      );
      assert.equal(
        cells.every((cell) => cell.status === 'scored-agent'),
        true
      );
    }

    const allInitialContexts = [];
    for (const cell of completed.phase2Execution.testRuns) {
      const firstTurn = cell.runs[0];
      assert.ok(firstTurn.response.normalized.contextId);
      allInitialContexts.push(firstTurn.response.normalized.contextId);
    }
    assert.equal(new Set(allInitialContexts).size, 27);

    const multipartCells = cellsByExample[0].filter(
      (cell) => cell.runs.length > 1
    );
    assert.equal(multipartCells.length, 12);
    assert.equal(
      multipartCells.every((cell) => cell.contextCheck.status === 'passed'),
      true
    );

    for (const cell of cellsByExample[1]) {
      const acceptance = cell.runs.at(-1).acceptance;
      assert.equal(acceptance.semanticSuccess, null);
      assert.equal(acceptance.requiredExecutable, 0);
    }

    const selectedTurn =
      cellsByExample[0].find((cell) =>
        completed.testPlan.tests.find((testItem) =>
          testItem.testId === cell.testId
        )?.variantType === 'original'
      ).runs[0];
    const requestManifest = completed.evidenceManifest.items.find(
      (item) =>
        item.kind === 'protocol-request' &&
        item.runId === selectedTurn.runId
    );
    assert.ok(requestManifest);
    const evidenceVault = new EvidenceVault({
      root: evidenceRoot,
      evaluationId: completed.id,
      key: evidenceKey
    });
    const decrypted = await evidenceVault.get(
      requestManifest.evidenceId,
      requestManifest.recordHash
    );
    assert.equal(decrypted.recordHash, requestManifest.recordHash);
    assert.match(JSON.stringify(decrypted.payload), new RegExp(privatePrompt));

    const getResponse = await fetch(
      `${apiOrigin}/api/evaluations/${completed.id}`
    );
    const getProjection = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.ok(getProjection.appealTargets);
    assert.equal(
      JSON.stringify(getProjection).includes(privatePrompt),
      false
    );

    const deleteResponse = await fetch(
      `${apiOrigin}/api/evaluations/${completed.id}`,
      { method: 'DELETE' }
    );
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), {
      id: completed.id,
      deleted: true
    });
    const missing = await fetch(
      `${apiOrigin}/api/evaluations/${completed.id}`
    );
    assert.equal(missing.status, 404);
  } finally {
    sseAbort?.abort();
    try {
      if (apiModule) {
        await shutdownApiFixture(apiModule);
      }
    } finally {
      try {
        if (liveAgents) await stopExampleAgents(liveAgents);
      } finally {
        restoreEnvironment(environment);
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
});

async function readSseData(reader, state, controller, timeoutMs = 5_000) {
  const timeout = setTimeout(
    () => controller.abort(new Error('SSE fixture timed out')),
    timeoutMs
  );
  try {
    while (true) {
      const boundary = state.buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const event = state.buffer.slice(0, boundary);
        state.buffer = state.buffer.slice(boundary + 2);
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) return JSON.parse(data);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE fixture closed before a data event');
      state.buffer += Buffer.from(value).toString('utf8').replace(/\r\n/gu, '\n');
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForNoActiveRuns(pipeline, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (pipeline.activeRuns.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(pipeline.activeRuns.size, 0, 'V2 worker did not settle');
}

async function waitForTerminalEvaluation(store, evaluationId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let current = store.get(evaluationId);
  while (
    !['completed', 'cancelled', 'interrupted'].includes(
      current?.execution?.status
    ) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = store.get(evaluationId);
  }
  return current;
}

async function shutdownApiFixture(
  apiModule,
  waitForSettlement = waitForNoActiveRuns
) {
  try {
    for (const controller of apiModule.pipeline.activeRuns.values()) {
      controller.abort();
    }
    await waitForSettlement(apiModule.pipeline);
  } finally {
    if (apiModule.server.listening) {
      await new Promise((resolve, reject) =>
        apiModule.server.close((error) =>
          error ? reject(error) : resolve()
        )
      );
    }
  }
}

function captureEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
