import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReplicaRuntimesReady,
  createPhase3Services,
  skillToReplicaArtifact
} from '../src/phase3-services.js';
import { REPLICA_BUILD_BUDGET_V1 } from '../src/replica-budgets.js';
import { validateReplicaArtifact } from '../src/replica-adapter.js';

const PACKAGE_HASH = 'a'.repeat(64);

test('createPhase3Services is disabled when no runtime config resolves', () => {
  const services = createPhase3Services({
    env: {},
    resolveConfig: () => null
  });
  assert.equal(services.enabled, false);
  assert.deepEqual(services.runtimes, []);
});

test('createPhase3Services builds a bridge adapter that seals a valid artifact', async () => {
  const services = createPhase3Services({
    env: { ENABLE_LOCAL_CLAUDE_CODE: 'true' },
    resolveConfig: (id) => (id === 'claude-code' ? { kind: 'local-cli', command: 'claude' } : null),
    buildSkillFn: async () => ({
      skill: {
        name: 'baseline',
        description: 'Temporary replica skill',
        instructions: ['Read the input.', 'Answer carefully.'],
        tools: []
      }
    }),
    runSkillFn: async () => 'replica reply'
  });

  assert.equal(services.enabled, true);
  assert.deepEqual(services.runtimes, [{ id: 'claude-code' }]);
  const adapter = services.createAdapter({ id: 'claude-code' });
  assert.deepEqual(await adapter.health(), {
    ready: true,
    budgetEnforcement: {
      wallClock: 'hard',
      tokens: 'hard',
      outputBytes: 'hard',
      network: 'hard'
    }
  });

  const artifact = await adapter.build({
    agent: { description: 'A market research agent.' },
    manifest: { contentHash: PACKAGE_HASH }
  }, REPLICA_BUILD_BUDGET_V1, { seed: 1, temperature: 0 });
  assert.equal(artifact.runtimeId, 'claude-code');
  assert.equal(artifact.manifest.packageHash, PACKAGE_HASH);
  validateReplicaArtifact(artifact, REPLICA_BUILD_BUDGET_V1, { packageHash: PACKAGE_HASH });

  const result = await adapter.run(
    artifact,
    { parts: [{ type: 'text', text: 'ping' }] },
    { history: [] },
    { maxTokens: 1000 },
    { seed: 2 }
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.messageParts[0].text, 'replica reply');
  assert.ok(result.budgetUsage.tokens >= 1);
});

test('skillToReplicaArtifact produces a contract-valid SKILL.md package', () => {
  const artifact = skillToReplicaArtifact({
    name: 'demo',
    description: 'Demo skill',
    instructions: ['Step one'],
    tools: ['workspace-read']
  }, 'cursor', PACKAGE_HASH);
  assert.doesNotThrow(() =>
    validateReplicaArtifact(artifact, REPLICA_BUILD_BUDGET_V1, { packageHash: PACKAGE_HASH })
  );
});

test('assertReplicaRuntimesReady rejects when no runtime is ready', async () => {
  await assert.rejects(
    () => assertReplicaRuntimesReady({
      getRuntimeStatusFn: async () => [{
        id: 'claude-code',
        name: 'Claude Code',
        enabled: true,
        installed: false,
        authenticated: false,
        runtimeReady: false,
        note: '未安装'
      }]
    }),
    (error) => error.statusCode === 503
      && error.responseBody?.code === 'REPLICA_RUNTIME_NOT_READY'
      && error.responseBody.runtimes[0].id === 'claude-code'
  );
});

test('assertReplicaRuntimesReady accepts when at least one runtime is ready', async () => {
  const status = await assertReplicaRuntimesReady({
    minReady: 1,
    getRuntimeStatusFn: async () => [
      { id: 'claude-code', runtimeReady: false },
      { id: 'doubao', runtimeReady: true, name: 'Doubao Agent' }
    ]
  });
  assert.equal(status.filter((item) => item.runtimeReady).length, 1);
});
