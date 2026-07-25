import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplicaPackage, assertReplicaPackageSafe } from '../src/replica-package.js';

const CARD = {
  name: 'Portfolio Risk Agent',
  description: 'Reviews portfolio concentration risk.',
  version: '1.0.0',
  capabilities: { streaming: true, pushNotifications: false, internal: 'do-not-copy' },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{
    id: 'portfolio-risk', name: 'Portfolio risk', description: 'Reviews holdings.',
    tags: ['finance'], examples: ['Review a portfolio.'], secretPrompt: 'do-not-copy'
  }],
  supportedInterfaces: [{ url: 'https://agent.example/a2a' }],
  provider: { url: 'https://provider.example/agent' },
  documentationUrl: 'https://docs.example/agent',
  securitySchemes: { bearer: { token: 'secret' } },
  metadata: { internal: true },
  extensions: { output: 'do-not-copy' },
  unrelatedReferenceUrl: 'https://files.example/public-reference'
};

const EXAMPLES = [{
  id: 'portfolio-risk',
  name: 'Portfolio concentration review',
  turns: [{
    input: { parts: [{ type: 'text', text: 'Review this portfolio.' }] },
    expectedDeliverable: 'Concentration risks and adjustment options.',
    acceptanceCriteria: [{
      id: 'risk-language', type: 'contains', expected: ['concentration'],
      description: 'Names concentration risk.', required: true
    }],
    hiddenVariant: { prompt: 'do-not-copy' },
    executionEvidence: { output: 'do-not-copy' }
  }],
  constraints: ['Do not invent holdings.'],
  testPlanId: 'hidden-plan',
  submittedOutput: 'do-not-copy'
}];

function options(overrides = {}) {
  return { rubricVersion: 'arena-rubric/v1', generatedAt: '2026-07-25T00:00:00.000Z', ...overrides };
}

test('packages only harmless Card semantics and normalized public whole-Agent examples', () => {
  const replica = createReplicaPackage(structuredClone(CARD), structuredClone(EXAMPLES), options());

  assert.deepEqual(replica.agent, {
    name: 'Portfolio Risk Agent',
    description: 'Reviews portfolio concentration risk.',
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
      id: 'portfolio-risk', name: 'Portfolio risk', description: 'Reviews holdings.',
      tags: ['finance'], examples: ['Review a portfolio.']
    }]
  });
  assert.deepEqual(replica.agentExamples, [{
    id: 'portfolio-risk', name: 'Portfolio concentration review',
    turns: [{
      input: { parts: [{ type: 'text', text: 'Review this portfolio.' }] },
      expectedDeliverable: 'Concentration risks and adjustment options.',
      acceptanceCriteria: [{
        id: 'risk-language', type: 'contains', expected: ['concentration'],
        description: 'Names concentration risk.', required: true
      }]
    }],
    constraints: ['Do not invent holdings.']
  }]);
  assert.deepEqual(replica.manifest.exclusions, [
    'agent-endpoints', 'credentials', 'documentation-urls', 'submitted-outputs',
    'hidden-tests', 'reviews', 'other-replicas'
  ]);
  assert.match(replica.manifest.sourceHashes.agentCard, /^[a-f0-9]{64}$/u);
  assert.match(replica.manifest.sourceHashes.agentExamples, /^[a-f0-9]{64}$/u);
  assert.match(replica.manifest.contentHash, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(replica), /agent\.example|provider\.example|docs\.example|secret|hidden-plan|do-not-copy/u);
});

test('preserves only safe public-example URL Parts and rejects endpoint, provider, and docs hosts', () => {
  const safeExamples = structuredClone(EXAMPLES);
  safeExamples[0].turns[0].input.parts.push({ type: 'url', url: 'https://files.example/input.csv' });
  const replica = createReplicaPackage(structuredClone(CARD), safeExamples, options());
  assert.equal(replica.agentExamples[0].turns[0].input.parts[1].url, 'https://files.example/input.csv');

  for (const url of [
    'https://agent.example/input.csv',
    'https://provider.example/input.csv',
    'https://docs.example/input.csv'
  ]) {
    const unsafe = structuredClone(EXAMPLES);
    unsafe[0].turns[0].input.parts.push({ type: 'url', url });
    assert.throws(() => createReplicaPackage(structuredClone(CARD), unsafe, options()), /host|URL|endpoint|provider|documentation/i);
  }
});

test('fails closed for signed URL queries without a locked snapshot and never packages their query credential', () => {
  const signed = structuredClone(EXAMPLES);
  signed[0].turns[0].input.parts.push({ type: 'url', url: 'https://files.example/input.csv?X-Amz-Signature=abc&X-Amz-Credential=key' });
  assert.throws(() => createReplicaPackage(structuredClone(CARD), signed, options()), /signed|query|snapshot/i);

  assert.throws(() => createReplicaPackage(structuredClone(CARD), signed, options({
    platformSnapshotReferences: {
      'https://files.example/input.csv?X-Amz-Signature=abc&X-Amz-Credential=key': 'snapshot_123'
    }
  })), /snapshot|reference|shape/i);
  assert.throws(() => createReplicaPackage(structuredClone(CARD), signed, options({
    platformSnapshotReferences: {
      'https://files.example/input.csv?X-Amz-Signature=abc&X-Amz-Credential=key': {
        reference: 'snapshot_123', mediaType: 'text/csv', byteLength: 128
      }
    }
  })), /sha256/i);

  const replica = createReplicaPackage(structuredClone(CARD), signed, options({
    platformSnapshotReferences: {
      'https://files.example/input.csv?X-Amz-Signature=abc&X-Amz-Credential=key': {
        reference: 'snapshot_123',
        mediaType: 'text/csv',
        byteLength: 128,
        sha256: 'a'.repeat(64)
      }
    }
  }));
  assert.deepEqual(replica.agentExamples[0].turns[0].input.parts[1], {
    type: 'url',
    snapshot: {
      reference: 'snapshot_123',
      mediaType: 'text/csv',
      byteLength: 128,
      sha256: 'a'.repeat(64)
    }
  });
  assert.doesNotMatch(JSON.stringify(replica), /X-Amz-(?:Signature|Credential)|\?X-Amz/u);
});

test('scans allowed URL paths, nested Part data, raw Part bytes, and common forbidden key variants', () => {
  const signedQuery = structuredClone(EXAMPLES);
  signedQuery[0].turns[0].input.parts.push({ type: 'url', url: 'https://files.example/input.csv?sig=eyJhbGciOiJIUzI1NiJ9.payload.signature' });
  assert.throws(() => createReplicaPackage(structuredClone(CARD), signedQuery, options()), /signed|JWT|secret|query/i);

  const queryValue = structuredClone(EXAMPLES);
  queryValue[0].turns[0].input.parts.push({ type: 'url', url: 'https://files.example/input.csv?file=Bearer%20secret' });
  assert.throws(() => createReplicaPackage(structuredClone(CARD), queryValue, options()), /authorization|secret|credential/i);

  const cookiePath = structuredClone(EXAMPLES);
  cookiePath[0].turns[0].input.parts.push({ type: 'url', url: 'https://files.example/Cookie=secret/input.csv' });
  assert.throws(() => createReplicaPackage(structuredClone(CARD), cookiePath, options()), /cookie|secret|authorization/i);

  const dataLeak = structuredClone(EXAMPLES);
  dataLeak[0].turns[0].input.parts.push({ type: 'data', data: { nested: { api_key: 'leak' } } });
  assert.throws(() => createReplicaPackage(structuredClone(CARD), dataLeak, options()), /forbidden|api.key/i);

  const rawLeak = structuredClone(EXAMPLES);
  rawLeak[0].turns[0].input.parts.push({ type: 'raw', raw: 'QmVhcmVyIHN1cGVyLXNlY3JldA==', mediaType: 'text/plain' });
  assert.throws(() => createReplicaPackage(structuredClone(CARD), rawLeak, options()), /authorization|secret|credential/i);

  const rawJsonLeak = structuredClone(EXAMPLES);
  rawJsonLeak[0].turns[0].input.parts.push({
    type: 'raw',
    raw: Buffer.from(JSON.stringify({ nested: { api_key: 'opaque-credential' } })).toString('base64'),
    mediaType: 'application/json'
  });
  assert.throws(() => createReplicaPackage(structuredClone(CARD), rawJsonLeak, options()), /forbidden|api.key/i);

  for (const field of ['executionEvidence', 'execution_output', 'model-output', 'submittedOutput', 'captured_output', 'otherReplica', 'replica_artifact', 'hidden-test', 'testPlanId', 'reviewScores']) {
    const relatedLeak = structuredClone(EXAMPLES);
    relatedLeak[0].turns[0].input.parts.push({ type: 'data', data: { [field]: 'opaque' } });
    assert.throws(() => createReplicaPackage(structuredClone(CARD), relatedLeak, options()), /forbidden/i, field);
  }
});

test('uses a locked snapshot for secret-looking query values and rejects endpoint URLs embedded in ordinary text', () => {
  const secretValue = structuredClone(EXAMPLES);
  const secretUrl = 'https://files.example/input.csv?file=Bearer%20secret';
  secretValue[0].turns[0].input.parts.push({ type: 'url', url: secretUrl });
  const replica = createReplicaPackage(structuredClone(CARD), secretValue, options({
    platformSnapshotReferences: {
      [secretUrl]: { reference: 'snapshot_query_value', mediaType: 'text/csv', byteLength: 128, sha256: 'b'.repeat(64) }
    }
  }));
  assert.equal(replica.agentExamples[0].turns[0].input.parts[1].snapshot.reference, 'snapshot_query_value');

  const embeddedEndpoint = structuredClone(EXAMPLES);
  embeddedEndpoint[0].turns[0].expectedDeliverable = 'Use https://agent.example/another-path only as a historical reference.';
  assert.throws(() => createReplicaPackage(structuredClone(CARD), embeddedEndpoint, options()), /host|endpoint|prohibited/i);
});

test('classifies credential key variants and raw YAML or HTTP headers without rejecting public scores', () => {
  for (const field of ['xApiKey', 'x_api_key', 'x-api-key', 'refreshToken', 'awsSecretAccessKey', 'accessToken', 'id_token', 'apiKey', 'secret_key', 'access-key', 'modelScore', 'review_score', 'judge-score', 'absoluteScore', 'replica_score', 'scoringEvidence']) {
    const credential = structuredClone(EXAMPLES);
    credential[0].turns[0].input.parts.push({ type: 'data', data: { [field]: 'opaque' } });
    assert.throws(() => createReplicaPackage(structuredClone(CARD), credential, options()), /forbidden/i, field);
  }

  for (const rawText of ['api_key: opaque-credential', 'X-API-Key: opaque-credential', 'executionEvidence: captured']) {
    const credential = structuredClone(EXAMPLES);
    credential[0].turns[0].input.parts.push({
      type: 'raw', raw: Buffer.from(rawText).toString('base64'), mediaType: 'text/plain'
    });
    assert.throws(() => createReplicaPackage(structuredClone(CARD), credential, options()), /forbidden/i, rawText);
  }

  const publicScore = structuredClone(EXAMPLES);
  publicScore[0].turns[0].input.parts.push({ type: 'data', data: { score: 88, tokenCount: 12, key: 'public-label' } });
  assert.doesNotThrow(() => createReplicaPackage(structuredClone(CARD), publicScore, options()));
});

test('uses the package version contract and generates generatedAt when omitted', () => {
  const replica = createReplicaPackage(structuredClone(CARD), structuredClone(EXAMPLES), {
    rubricVersion: 'arena-rubric/v1', packageVersion: 'replica-package/v1'
  });
  assert.match(replica.manifest.generatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(replica.manifest.packageVersion, 'replica-package/v1');
  assert.throws(() => createReplicaPackage(structuredClone(CARD), structuredClone(EXAMPLES), options({ packageVersion: 'replica-package/v2' })), /packageVersion/i);
});

test('detects content tampering, prohibited secrets, forbidden fields, and URL values outside public URL Parts', () => {
  const replica = createReplicaPackage(structuredClone(CARD), structuredClone(EXAMPLES), options());

  const tampered = structuredClone(replica);
  tampered.agent.name = 'Tampered';
  assert.throws(() => assertReplicaPackageSafe(tampered), /source hash/i);

  const sourceHashTampered = structuredClone(replica);
  sourceHashTampered.manifest.sourceHashes.agentCard = '0'.repeat(64);
  assert.throws(() => assertReplicaPackageSafe(sourceHashTampered), /source hash/i);

  const contentHashTampered = structuredClone(replica);
  contentHashTampered.manifest.contentHash = '0'.repeat(64);
  assert.throws(() => assertReplicaPackageSafe(contentHashTampered), /content hash/i);

  const secret = structuredClone(replica);
  secret.agent.description = 'Bearer super-secret-token';
  assert.throws(() => assertReplicaPackageSafe(secret), /authorization|secret|credential/i);

  const prohibited = structuredClone(replica);
  prohibited.agent.description = 'BANNED_SENTINEL must never cross the boundary';
  assert.throws(() => assertReplicaPackageSafe(prohibited, new Set(['BANNED_SENTINEL'])), /prohibited/i);

  const forbidden = structuredClone(replica);
  forbidden.agent.endpoint = 'https://agent.example/a2a';
  assert.throws(() => assertReplicaPackageSafe(forbidden), /forbidden|endpoint/i);

  const unexpectedUrl = structuredClone(replica);
  unexpectedUrl.agent.description = 'https://files.example/not-allowed';
  assert.throws(() => assertReplicaPackageSafe(unexpectedUrl), /URL|path/i);

  const endpointUrl = structuredClone(replica);
  endpointUrl.agentExamples[0].turns[0].input.parts[0] = { type: 'url', url: 'https://agent.example/input.csv' };
  assert.throws(() => assertReplicaPackageSafe(endpointUrl, ['https://agent.example/a2a']), /host|endpoint|prohibited/i);
});

test('does not mutate inputs and returns deeply frozen package data', () => {
  const card = structuredClone(CARD);
  const examples = structuredClone(EXAMPLES);
  const cardBefore = structuredClone(card);
  const examplesBefore = structuredClone(examples);
  const replica = createReplicaPackage(card, examples, options());

  assert.deepEqual(card, cardBefore);
  assert.deepEqual(examples, examplesBefore);
  assert.equal(Object.isFrozen(replica), true);
  assert.equal(Object.isFrozen(replica.agent.skills[0]), true);
  assert.equal(Object.isFrozen(replica.agentExamples[0].turns[0].input.parts[0]), true);
  assert.throws(() => { replica.agent.name = 'Mutated'; }, TypeError);
  const revalidated = assertReplicaPackageSafe(replica);
  assert.deepEqual(revalidated, replica);
  assert.equal(Object.isFrozen(revalidated), true);
});
