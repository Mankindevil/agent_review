import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReplicaAdapter,
  normalizeReplicaResult,
  validateReplicaArtifact
} from '../src/replica-adapter.js';
import { REPLICA_BUILD_BUDGET_V1, REPLICA_RUN_BUDGET_V1 } from '../src/replica-budgets.js';

const PACKAGE = { manifest: { contentHash: 'a'.repeat(64) } };
const ARTIFACT = {
  artifactId: 'artifact-1',
  runtimeId: 'cursor',
  skill: { name: 'portfolio-review', description: 'Review a portfolio.', instructions: ['Read the supplied input.'] },
  files: [{
    path: 'SKILL.md', mediaType: 'text/markdown',
    content: '# Portfolio review\n\n## Instructions\n\nRead the supplied input.\n',
    byteLength: 62, sha256: 'c0fb2d2c4b185ac942a4277af7366196e4c987cd8f30ab954001b751f2701f5c'
  }],
  manifest: {
    packageHash: 'a'.repeat(64), budgetVersion: 'replica-budget/v1',
    budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' }
  },
  buildEvidence: { source: 'test', budgetUsage: { tokens: 7 } }
};

test('locks immutable V1 replica budgets with the shared no-network workspace policy', () => {
  assert.deepEqual(REPLICA_BUILD_BUDGET_V1, {
    wallClockMs: 300_000, maxTokens: 16_000, maxOutputBytes: 2 * 1024 * 1024,
    toolAllowlist: ['workspace-read', 'workspace-write'], network: 'none'
  });
  assert.deepEqual(REPLICA_RUN_BUDGET_V1, {
    maxTokens: 8_000, maxOutputBytes: 2 * 1024 * 1024,
    toolAllowlist: ['workspace-read', 'workspace-write'], network: 'none'
  });
  assert.equal(Object.isFrozen(REPLICA_BUILD_BUDGET_V1), true);
  assert.equal(Object.isFrozen(REPLICA_RUN_BUDGET_V1), true);
  assert.equal(Object.isFrozen(REPLICA_BUILD_BUDGET_V1.toolAllowlist), true);
  assert.equal(Object.isFrozen(REPLICA_RUN_BUDGET_V1.toolAllowlist), true);
});

test('remote adapter keeps replica actions separate and normalizes the build and run contracts', async () => {
  const requests = [];
  const adapter = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent', model: 'Auto' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter' },
    health: async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } }),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (body.action === 'build_replica') return new Response(JSON.stringify(ARTIFACT));
      if (body.action === 'run_replica') return new Response(JSON.stringify({
        status: 'completed', messageParts: [{ type: 'text', text: 'Review complete.' }],
        artifacts: [], durationMs: 12, budgetUsage: { tokens: 7, outputBytes: 16 }, evidence: { source: 'remote' }
      }));
      throw new Error('unexpected action');
    }
  });

  assert.deepEqual(await adapter.health(), {
    ready: true,
    budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' }
  });
  const build = await adapter.build(PACKAGE, REPLICA_BUILD_BUDGET_V1, { seed: 17, temperature: 0 });
  const run = await adapter.run(build, { parts: [{ type: 'text', text: 'Review holdings.' }] }, { id: 'example-1', history: [] }, REPLICA_RUN_BUDGET_V1, { seed: 18, temperature: 0 });

  assert.equal(build.runtimeId, 'cursor');
  assert.equal(build.manifest.packageHash, PACKAGE.manifest.contentHash);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.messageParts, [{ type: 'text', text: 'Review complete.' }]);
  assert.deepEqual(requests.map((request) => request.action), ['build_replica', 'run_replica']);
  assert.deepEqual(requests[0], { action: 'build_replica', replicaPackage: PACKAGE, buildBudget: REPLICA_BUILD_BUDGET_V1, seed: 17, temperature: 0 });
  assert.equal(requests[1].action, 'run_replica');
  assert.equal(requests[1].replicaArtifact.artifactId, build.artifactId);
  assert.deepEqual(requests[1].testInput, { parts: [{ type: 'text', text: 'Review holdings.' }] });
  assert.notEqual(requests[1].contextHandle.id, 'example-1');
  assert.deepEqual(requests[1].contextHandle.history, []);
  assert.deepEqual(requests[1].runBudget, REPLICA_RUN_BUDGET_V1);
});

test('artifact validation rejects unsafe paths, unsafe content, bad hashes, and soft enforcement before execution', () => {
  assert.doesNotThrow(() => validateReplicaArtifact(structuredClone(ARTIFACT), REPLICA_BUILD_BUDGET_V1));
  for (const [label, mutate] of [
    ['absolute path', (artifact) => { artifact.files[0].path = 'C:/escape/SKILL.md'; }],
    ['traversal path', (artifact) => { artifact.files[0].path = '../SKILL.md'; }],
    ['executable', (artifact) => { artifact.files[0].path = 'run.sh'; }],
    ['endpoint string', (artifact) => { artifact.files[0].content += '\nhttps://agent.example/a2a'; }],
    ['missing Skill instructions', (artifact) => { artifact.skill.instructions = []; }],
    ['missing Skill file', (artifact) => { artifact.files[0].path = 'notes.md'; }],
    ['soft enforcement', (artifact) => { artifact.manifest.budgetEnforcement.network = 'soft'; }],
    ['hash mismatch', (artifact) => { artifact.manifest.packageHash = 'c'.repeat(64); }]
  ]) {
    const unsafe = structuredClone(ARTIFACT);
    mutate(unsafe);
    assert.throws(() => validateReplicaArtifact(unsafe, REPLICA_BUILD_BUDGET_V1, { packageHash: 'a'.repeat(64) }), /path|executable|endpoint|instructions|enforcement|hash/i, label);
  }
});

test('artifact validation rejects unknown structures, executable markers, empty Skill files, and secrets in build evidence', () => {
  for (const [label, mutate] of [
    ['unknown file field', (artifact) => { artifact.files[0].unknown = true; }],
    ['executable field', (artifact) => { artifact.files[0].executable = true; }],
    ['windows path', (artifact) => { artifact.files[0].path = 'folder\\SKILL.md'; }],
    ['empty Skill file', (artifact) => { artifact.files[0].content = ''; artifact.files[0].byteLength = 0; artifact.files[0].sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; }],
    ['build secret', (artifact) => { artifact.buildEvidence = { authorization: 'Bearer secret' }; }],
    ['unknown manifest field', (artifact) => { artifact.manifest.extra = true; }]
  ]) {
    const unsafe = structuredClone(ARTIFACT);
    mutate(unsafe);
    assert.throws(() => validateReplicaArtifact(unsafe, REPLICA_BUILD_BUDGET_V1), /unknown|executable|path|Skill|endpoint|authentication|manifest/i, label);
  }
});

test('normalizes malformed run values to invalid output and preserves only standard result fields', () => {
  assert.deepEqual(normalizeReplicaResult('plain response', { durationMs: 3 }), {
    status: 'completed', messageParts: [{ type: 'text', text: 'plain response' }], artifacts: [], durationMs: 3,
    error: null, budgetUsage: {}, evidence: {}
  });
  assert.deepEqual(normalizeReplicaResult({ status: 'completed', messageParts: [] }), {
    status: 'invalid-output', messageParts: [], artifacts: [], durationMs: 0,
    error: { code: 'INVALID_REPLICA_OUTPUT', message: 'Replica result did not contain visible output.' }, budgetUsage: {}, evidence: {}
  });
});

test('local adapter creates isolated reusable contexts, denies network attempts, and cleans up a failed context', async () => {
  const workspaces = [];
  const removed = [];
  const seenContexts = [];
  const adapter = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'local-cli' },
    health: async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } }),
    sandbox: { assertNetworkDenied() { const error = new Error('network denied'); error.code = 'NETWORK_DENIED'; throw error; } },
    createWorkspace: async () => { const workspace = `workspace-${workspaces.length + 1}`; workspaces.push(workspace); return workspace; },
    removeWorkspace: async (workspace) => { removed.push(workspace); },
    localRun: async ({ contextHandle, policy }) => {
      seenContexts.push(contextHandle.workspace);
      assert.throws(() => policy.assertNetworkDenied(), (error) => error.code === 'NETWORK_DENIED');
      return { status: 'completed', messageParts: [{ type: 'text', text: 'ok' }], artifacts: [], durationMs: 1, budgetUsage: { tokens: 1 }, evidence: {} };
    }
  });
  const firstExample = { id: 'example-1' };
  const secondExample = { id: 'example-2' };
  await adapter.run(ARTIFACT, { parts: [{ type: 'text', text: 'one' }] }, firstExample, REPLICA_RUN_BUDGET_V1);
  await adapter.run(ARTIFACT, { parts: [{ type: 'text', text: 'two' }] }, firstExample, REPLICA_RUN_BUDGET_V1);
  await adapter.run(ARTIFACT, { parts: [{ type: 'text', text: 'three' }] }, secondExample, REPLICA_RUN_BUDGET_V1);
  assert.deepEqual(seenContexts, ['workspace-1', 'workspace-1', 'workspace-2']);
  await adapter.disposeContext(firstExample);
  await adapter.disposeContext(secondExample);
  assert.deepEqual(removed, ['workspace-1', 'workspace-2']);

  const failed = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'local-cli' }, createWorkspace: async () => 'workspace-failed',
    health: async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } }),
    sandbox: { assertNetworkDenied() { const error = new Error('network denied'); error.code = 'NETWORK_DENIED'; throw error; } },
    removeWorkspace: async (workspace) => { removed.push(workspace); },
    localRun: async () => { throw new Error('Skill failed'); }
  });
  await assert.rejects(() => failed.run(ARTIFACT, { parts: [{ type: 'text', text: 'fail' }] }, { id: 'example-3' }, REPLICA_RUN_BUDGET_V1), /Skill failed/);
  assert.equal(removed.includes('workspace-failed'), true);
});

test('remote contexts are generated internally, reused only per logical handle, and pre-execution failures dispose them', async () => {
  const contexts = [];
  let ready = false;
  const adapter = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter' },
    health: async () => ready
      ? { ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } }
      : { ready: false, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } },
    disposeContext: async (context) => { contexts.push({ disposed: context.id }); },
    fetch: async (_url, options) => new Response(JSON.stringify(options && JSON.parse(options.body).action === 'run_replica'
      ? { status: 'completed', messageParts: [{ type: 'text', text: 'ok' }], artifacts: [], durationMs: 1, budgetUsage: { tokens: 1 }, evidence: {} }
      : ARTIFACT))
  });
  const first = { id: 'caller-collision', workspace: 'caller-owned' };
  await assert.rejects(() => adapter.run(ARTIFACT, { parts: [{ type: 'text', text: 'x' }] }, first, REPLICA_RUN_BUDGET_V1), (error) => error.code === 'REPLICA_ENFORCEMENT_UNPROVEN');
  assert.equal(contexts.length, 1);
  ready = true;
  const seen = [];
  const second = { id: 'caller-collision' };
  const third = { id: 'caller-collision' };
  const isolated = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter' },
    health: async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } }),
    fetch: async (_url, options) => { seen.push(JSON.parse(options.body).contextHandle.id); return new Response(JSON.stringify({ status: 'completed', messageParts: [{ type: 'text', text: 'ok' }], artifacts: [], durationMs: 1, budgetUsage: { tokens: 1 }, evidence: {} })); }
  });
  await isolated.run(ARTIFACT, { parts: [{ type: 'text', text: 'x' }] }, second, REPLICA_RUN_BUDGET_V1);
  await isolated.run(ARTIFACT, { parts: [{ type: 'text', text: 'y' }] }, second, REPLICA_RUN_BUDGET_V1);
  await isolated.run(ARTIFACT, { parts: [{ type: 'text', text: 'z' }] }, third, REPLICA_RUN_BUDGET_V1);
  assert.equal(seen[0], seen[1]);
  assert.notEqual(seen[0], seen[2]);
  assert.notEqual(seen[0], 'caller-collision');
});

test('fails closed when standard build or run token usage is missing and inherited environment credentials are not accepted', async () => {
  const hardHealth = async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } });
  const missingBuildUsage = structuredClone(ARTIFACT);
  delete missingBuildUsage.buildEvidence.budgetUsage;
  const build = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter' }, health: hardHealth,
    fetch: async () => new Response(JSON.stringify(missingBuildUsage))
  });
  await assert.rejects(() => build.build(PACKAGE, REPLICA_BUILD_BUDGET_V1), (error) => error.code === 'REPLICA_TOKEN_USAGE_UNPROVEN');
  const inherited = Object.create({ REPLICA_ADAPTER_KEY: 'inherited' });
  const credentialed = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter', apiKeyEnv: 'REPLICA_ADAPTER_KEY' }, env: inherited, health: hardHealth,
    fetch: async () => new Response(JSON.stringify(ARTIFACT))
  });
  assert.deepEqual(await credentialed.health(), { ready: false, code: 'ADAPTER_TRANSPORT_FAILED', budgetEnforcement: { wallClock: 'unproven', tokens: 'unproven', outputBytes: 'unproven', network: 'unproven' }, evidence: {} });
});

test('validates build telemetry against the locked build budget, rejects nested telemetry tokens, and checks a trusted meter when supplied', async () => {
  const buildAtTwelveThousand = structuredClone(ARTIFACT);
  buildAtTwelveThousand.buildEvidence.budgetUsage.tokens = 12_000;
  assert.doesNotThrow(() => validateReplicaArtifact(buildAtTwelveThousand, REPLICA_RUN_BUDGET_V1));
  const nestedToken = structuredClone(ARTIFACT);
  nestedToken.buildEvidence.telemetry = { tokens: 1 };
  assert.throws(() => validateReplicaArtifact(nestedToken, REPLICA_BUILD_BUDGET_V1), /forbidden|credential|endpoint/i);

  const metered = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter' },
    health: async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } }),
    trustedUsageMeter: async () => 8,
    fetch: async () => new Response(JSON.stringify(ARTIFACT))
  });
  await assert.rejects(() => metered.build(PACKAGE, REPLICA_BUILD_BUDGET_V1), (error) => error.code === 'REPLICA_TOKEN_USAGE_CONFLICT');
});

test('build fails closed without fresh hard health proof and remote requests honor configured adapter credentials', async () => {
  const adapter = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter' },
    health: async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'soft', outputBytes: 'hard', network: 'hard' } }),
    fetch: async () => new Response(JSON.stringify(ARTIFACT))
  });
  await assert.rejects(() => adapter.build(PACKAGE, REPLICA_BUILD_BUDGET_V1), (error) => error.code === 'REPLICA_ENFORCEMENT_UNPROVEN');

  const requests = [];
  const credentialed = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter', apiKeyEnv: 'REPLICA_ADAPTER_KEY' },
    env: { REPLICA_ADAPTER_KEY: 'test-key' },
    health: async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } }),
    fetch: async (_url, options) => { requests.push(options.headers); return new Response(JSON.stringify(ARTIFACT)); }
  });
  await credentialed.build(PACKAGE, REPLICA_BUILD_BUDGET_V1);
  assert.equal(requests[0].authorization, 'Bearer test-key');
});

test('adapter enforces hard timeout, response byte, and reported token caps outside runtime claims', async () => {
  const hardHealth = async () => ({ ready: true, budgetEnforcement: { wallClock: 'hard', tokens: 'hard', outputBytes: 'hard', network: 'hard' } });
  let abortedSignal;
  const timeout = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter' }, health: hardHealth,
    fetch: async (_url, options) => { abortedSignal = options.signal; return new Promise(() => {}); }
  });
  await assert.rejects(() => timeout.build(PACKAGE, { ...REPLICA_BUILD_BUDGET_V1, wallClockMs: 5 }), (error) => error.code === 'REPLICA_WALL_CLOCK_EXCEEDED');
  assert.equal(abortedSignal?.aborted, true);

  const capped = createReplicaAdapter({ id: 'cursor', name: 'Cursor Agent' }, 'live', {
    config: { kind: 'remote-http', url: 'https://runtime.example/adapter' }, health: hardHealth,
    fetch: async () => new Response(JSON.stringify({ status: 'completed', messageParts: [{ type: 'text', text: 'too many bytes' }], artifacts: [], durationMs: 1, budgetUsage: { tokens: 9, outputBytes: 99 }, evidence: {} }))
  });
  await assert.rejects(() => capped.run(ARTIFACT, { parts: [{ type: 'text', text: 'run' }] }, { id: 'logical-context', workspace: 'untrusted' }, { ...REPLICA_RUN_BUDGET_V1, maxTokens: 8, maxOutputBytes: 8, wallClockMs: 100 }), (error) => error.code === 'REPLICA_OUTPUT_BYTES_EXCEEDED');
});
