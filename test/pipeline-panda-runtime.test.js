import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EvaluationPipeline } from '../src/pipeline.js';
import { EvaluationStore } from '../src/store.js';

test('V1 pipeline supplies the Panda interface and credential-free query gateway to every Runtime build and run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pipeline-panda-runtime-'));
  const buildCalls = [];
  const runCalls = [];
  const query = async () => ({ provider: 'pandaai', data: [] });
  const pipeline = new EvaluationPipeline(
    new EvaluationStore(path.join(root, 'evaluations.json')),
    new EventEmitter(),
    {
      monotonicNow: (() => {
        let current = 0;
        return () => {
          const value = current;
          current += 12_345;
          return value;
        };
      })(),
      pandaRuntimeEnabled: true,
      pandaAllowedMethods: ['get_factor'],
      pandaInterfaceLoader: async () => '# 接口文档.md\n## get_factor',
      dataQuery: query,
      buildSkillFn: async (runtime, description, mode, options) => {
        options.onContextUsage({ scope: 'skill-build', runtimeId: runtime.id, status: 'ready' });
        buildCalls.push({ runtime, description, mode, options });
        return {
          runtime: runtime.name,
          runtimeId: runtime.id,
          model: runtime.model,
          mode: 'demo',
          baselineInput: 'description+panda-interface',
          skill: {
            name: `${runtime.id}-factor`,
            description,
            instructions: ['查询后计算'],
            tools: ['panda_data']
          }
        };
      },
      runSkillFn: async (build, testCase, mode, options) => {
        options.onContextUsage({ scope: 'runtime-query', runtimeId: build.runtimeId, status: 'ready' });
        runCalls.push({ build, testCase, mode, options });
        return 'Panda Data 复现结果';
      },
      scoreV1Case: async ({ entries, config }) => ({
        status: 'scored',
        entries: entries.map((entry) => ({
          ...entry,
          score: 80,
          scoreStatus: 'scored',
          dimensions: {
            taskConstraint: 80,
            professionalQuality: 80,
            evidenceRisk: 80,
            artifactUsability: 80
          },
          judgeReviews: []
        })),
        judging: {
          version: 'v1-model-arena/v1',
          status: 'scored',
          mode: config.mode,
          reviewerId: config.reviewerId,
          requiredSeats: 1,
          successfulSeats: 1,
          seats: []
        }
      })
    }
  );

  try {
    const created = await pipeline.create({
      mode: 'demo',
      agentCard: {
        name: 'Factor Agent',
        description: '使用金融数据检验因子。',
        version: '1.0.0',
        supportedInterfaces: [{
          url: 'https://agent.example.test/a2a',
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0'
        }],
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/markdown'],
        skills: [{
          id: 'factor',
          name: '因子研究',
          description: '计算 Rank IC',
          tags: ['factor'],
          examples: ['检验现金流因子']
        }]
      },
      cases: [{ name: '因子检验', prompt: '检验现金流因子并报告 Rank IC。' }]
    });
    const completed = await waitFor(
      pipeline.store,
      created.id,
      (item) => item?.status === 'completed' || item?.status === 'failed'
    );

    assert.equal(completed.status, 'completed');
    assert.equal(buildCalls.length, 3);
    assert.equal(runCalls.length, 3);
    for (const call of [...buildCalls, ...runCalls]) {
      assert.equal(call.options.pandaData.enabled, true);
      assert.deepEqual(call.options.pandaData.allowedMethods, ['get_factor']);
      assert.equal(call.options.pandaData.interfaceReference, '# 接口文档.md\n## get_factor');
      assert.equal(call.options.pandaData.query, query);
    }
    const expectedExecution = {
      status: 'succeeded',
      durationMs: 12_345,
      timingScope: 'end-to-end-wall-clock',
      includesNetwork: true,
      toolObservation: 'unavailable',
      contextUsage: []
    };
    const submitted = completed.benchmark[0].entries.find((entry) => entry.id === 'submitted');
    assert.deepEqual(submitted.execution, expectedExecution);
    for (const runtimeId of ['claude-code', 'cursor', 'doubao']) {
      const entry = completed.benchmark[0].entries.find((candidate) => candidate.id === runtimeId);
      assert.deepEqual(entry.execution, {
        ...expectedExecution,
        contextUsage: [{ scope: 'runtime-query', runtimeId, status: 'ready' }]
      });
    }
    assert.equal(completed.builds.every((build) =>
      Array.isArray(build.contextUsage) &&
      build.contextUsage[0]?.scope === 'skill-build'
    ), true);
    const completionLogs = completed.logs.filter((log) =>
      log.phase === 'benchmark' &&
      ['A2A', 'RUNTIME'].includes(log.source) &&
      Number.isFinite(log.durationMs)
    );
    assert.equal(completionLogs.length, 4);
    assert.equal(completionLogs.every((log) => log.durationMs === 12_345), true);
  } finally {
    await pipeline.store.writeQueue.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(store, id, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const item = store.get(id);
    if (predicate(item)) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.get(id);
}
