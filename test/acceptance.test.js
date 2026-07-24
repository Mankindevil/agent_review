import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAcceptance } from '../src/acceptance.js';

const output = (overrides = {}) => ({
  text: '',
  data: null,
  artifacts: [],
  ...overrides
});

const criterion = (type, overrides = {}) => ({
  id: `${type}-check`,
  type,
  required: true,
  description: `${type} acceptance`,
  ...overrides
});

test('model criteria remain non-executable and cannot turn terminal-only output into success', () => {
  const result = evaluateAcceptance(
    [criterion('model', { id: 'quality' })],
    output({ text: 'done' })
  );

  assert.equal(result.requiredExecutable, 0);
  assert.equal(result.passedRequiredExecutable, 0);
  assert.equal(result.semanticSuccess, null);
  assert.deepEqual(result.checks[0], {
    id: 'quality',
    type: 'model',
    required: true,
    status: 'not-executable'
  });
});

test('only required executable checks determine semantic success', () => {
  const base = [
    criterion('exact', { id: 'required-exact', expected: 'done' }),
    criterion('contains', {
      id: 'advisory-token',
      expected: ['missing'],
      required: false
    }),
    criterion('model', { id: 'required-model' })
  ];

  const passing = evaluateAcceptance(base, output({ text: 'done' }));
  assert.equal(passing.requiredExecutable, 1);
  assert.equal(passing.passedRequiredExecutable, 1);
  assert.equal(passing.semanticSuccess, true);
  assert.equal(passing.checks[1].status, 'failed');

  const failing = evaluateAcceptance([
    ...base,
    criterion('contains', { id: 'required-token', expected: ['missing'] })
  ], output({ text: 'done' }));
  assert.equal(failing.requiredExecutable, 2);
  assert.equal(failing.passedRequiredExecutable, 1);
  assert.equal(failing.semanticSuccess, false);
});

test('contains uses NFC, defaults to case-sensitive, and requires every token', () => {
  const unicode = evaluateAcceptance(
    [criterion('contains', { expected: ['Caf\u00e9'] })],
    output({ text: 'Cafe\u0301' })
  );
  assert.equal(unicode.checks[0].status, 'passed');

  const defaultCase = evaluateAcceptance(
    [criterion('contains', { expected: ['RISK'] })],
    output({ text: 'risk' })
  );
  assert.equal(defaultCase.checks[0].status, 'failed');

  const insensitive = evaluateAcceptance(
    [criterion('contains', { expected: ['RISK'], caseSensitive: false })],
    output({ text: 'risk' })
  );
  assert.equal(insensitive.checks[0].status, 'passed');

  const allTokens = evaluateAcceptance(
    [criterion('contains', { expected: ['risk', 'limit'] })],
    output({ text: 'risk only' })
  );
  assert.equal(allTokens.checks[0].status, 'failed');
});

test('exact normalizes line endings and trailing horizontal whitespace only', () => {
  const normalized = evaluateAcceptance(
    [criterion('exact', { expected: 'a\nb' })],
    output({ text: 'a  \r\nb\t' })
  );
  assert.equal(normalized.checks[0].status, 'passed');

  const leading = evaluateAcceptance(
    [criterion('exact', { expected: 'a\nb' })],
    output({ text: ' a\nb' })
  );
  assert.equal(leading.checks[0].status, 'failed');
});

test('json-schema validates direct structured data without parsing prose', () => {
  const schema = {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } }
  };

  const direct = evaluateAcceptance(
    [criterion('json-schema', { schema })],
    output({ data: { ok: true } })
  );
  assert.equal(direct.checks[0].status, 'passed');

  const prose = evaluateAcceptance(
    [criterion('json-schema', { schema })],
    output({ text: '{"ok":true}' })
  );
  assert.equal(prose.checks[0].status, 'failed');
});

test('structured checks use the final current-turn candidate in locked order', () => {
  const schema = {
    type: 'object',
    required: ['ok'],
    properties: { ok: { const: true } }
  };
  const directWins = evaluateAcceptance(
    [criterion('json-schema', { schema })],
    output({
      data: { ok: false },
      artifacts: [{ parts: [{ data: { ok: true } }] }]
    })
  );
  assert.equal(directWins.checks[0].status, 'failed');

  const firstArtifactWins = evaluateAcceptance(
    [criterion('json-schema', { schema })],
    output({
      artifacts: [
        { parts: [{ text: 'ignore' }] },
        { parts: [{ data: { ok: true } }, { data: { ok: false } }] },
        { parts: [{ data: { ok: false } }] }
      ]
    })
  );
  assert.equal(firstArtifactWins.checks[0].status, 'passed');

  const noCherryPicking = evaluateAcceptance(
    [criterion('json-schema', { schema })],
    output({
      artifacts: [
        { parts: [{ data: { ok: false } }] },
        { parts: [{ data: { ok: true } }] }
      ]
    })
  );
  assert.equal(noCherryPicking.checks[0].status, 'failed');

  const falsyDirect = evaluateAcceptance(
    [criterion('json-schema', { schema: { const: false } })],
    output({
      data: false,
      artifacts: [{ parts: [{ data: true }] }]
    })
  );
  assert.equal(falsyDirect.checks[0].status, 'passed');

  const nativeV03Wins = evaluateAcceptance(
    [criterion('json-schema', { schema })],
    output({
      artifacts: [
        { parts: [{ kind: 'text', data: { ok: true } }] },
        { parts: [{ kind: 'data', data: { ok: false } }] },
        { parts: [{ data: { ok: true } }] }
      ]
    })
  );
  assert.equal(nativeV03Wins.checks[0].status, 'failed');

  const selectedNullStopsSearch = evaluateAcceptance(
    [criterion('json-schema', { schema: { type: 'object' } })],
    output({
      artifacts: [
        { parts: [{ data: null }] },
        { parts: [{ data: {} }] }
      ]
    })
  );
  assert.equal(selectedNullStopsSearch.checks[0].status, 'failed');
});

test('json-schema rejects remote references and does not mutate inputs', () => {
  const schema = {
    $defs: { flag: { type: 'boolean' } },
    type: 'object',
    properties: { ok: { $ref: '#/$defs/flag' } },
    required: ['ok'],
    additionalProperties: false
  };
  const data = { ok: true, extra: 'preserve' };
  const originalSchema = structuredClone(schema);
  const originalData = structuredClone(data);

  const result = evaluateAcceptance(
    [criterion('json-schema', { schema })],
    output({ data })
  );
  assert.equal(result.checks[0].status, 'failed');
  assert.deepEqual(schema, originalSchema);
  assert.deepEqual(data, originalData);

  for (const reference of [
    'https://example.com/schema.json',
    'file:///tmp/schema.json',
    'other.json',
    '/schema'
  ]) {
    assert.throws(
      () => evaluateAcceptance(
        [criterion('json-schema', { schema: { $ref: reference } })],
        output({ data: {} })
      ),
      /\$ref|schema|external|fragment/i
    );
  }
});

test('json-schema rejects async schemas and isolates duplicate schema identifiers between calls', () => {
  assert.throws(
    () => evaluateAcceptance(
      [criterion('json-schema', { schema: { $async: true, type: 'object' } })],
      output({ data: {} })
    ),
    /\$async|async|schema/i
  );

  const first = evaluateAcceptance(
    [criterion('json-schema', {
      schema: { $id: 'urn:task-5:duplicate', const: 1 }
    })],
    output({ data: 1 })
  );
  const second = evaluateAcceptance(
    [criterion('json-schema', {
      schema: { $id: 'urn:task-5:duplicate', const: 2 }
    })],
    output({ data: 2 })
  );
  assert.equal(first.checks[0].status, 'passed');
  assert.equal(second.checks[0].status, 'passed');
});

test('structured candidate discovery requires own data descriptors and never invokes accessors', () => {
  const inheritedOutput = Object.create({ data: { ok: true } });
  Object.assign(inheritedOutput, { text: '', artifacts: [] });
  const inherited = evaluateAcceptance(
    [criterion('json-schema', {
      schema: { type: 'object', required: ['ok'] }
    })],
    inheritedOutput
  );
  assert.equal(inherited.checks[0].status, 'failed');

  let outputReads = 0;
  const accessorOutput = { text: '', artifacts: [] };
  Object.defineProperty(accessorOutput, 'data', {
    enumerable: true,
    get() {
      outputReads += 1;
      return { ok: true };
    }
  });
  const accessor = evaluateAcceptance(
    [criterion('json-schema', { schema: { type: 'object' } })],
    accessorOutput
  );
  assert.equal(accessor.checks[0].status, 'failed');
  assert.equal(outputReads, 0);

  let partReads = 0;
  const accessorPart = { kind: 'data' };
  Object.defineProperty(accessorPart, 'data', {
    enumerable: true,
    get() {
      partReads += 1;
      return { ok: true };
    }
  });
  const partAccessor = evaluateAcceptance(
    [criterion('json-schema', { schema: { type: 'object' } })],
    output({ artifacts: [{ parts: [accessorPart] }] })
  );
  assert.equal(partAccessor.checks[0].status, 'failed');
  assert.equal(partReads, 0);

  let kindReads = 0;
  const kindAccessorPart = { data: { ok: true } };
  Object.defineProperty(kindAccessorPart, 'kind', {
    enumerable: true,
    get() {
      kindReads += 1;
      return 'data';
    }
  });
  const kindAccessor = evaluateAcceptance(
    [criterion('json-schema', { schema: { type: 'object' } })],
    output({ artifacts: [{ parts: [kindAccessorPart] }] })
  );
  assert.equal(kindAccessor.checks[0].status, 'failed');
  assert.equal(kindReads, 0);
});

test('structured candidate containers require own data descriptors without invoking getters', () => {
  const schemaCriterion = criterion('json-schema', {
    schema: {
      type: 'object',
      required: ['ok'],
      properties: { ok: { const: true } }
    }
  });

  let artifactReads = 0;
  const artifactAccessorOutput = { text: '', data: null };
  Object.defineProperty(artifactAccessorOutput, 'artifacts', {
    enumerable: true,
    get() {
      artifactReads += 1;
      return [{ parts: [{ data: { ok: true } }] }];
    }
  });
  assert.equal(
    evaluateAcceptance([schemaCriterion], artifactAccessorOutput).checks[0].status,
    'failed'
  );
  assert.equal(artifactReads, 0);

  let partReads = 0;
  const artifactWithAccessor = {};
  Object.defineProperty(artifactWithAccessor, 'parts', {
    enumerable: true,
    get() {
      partReads += 1;
      return [{ data: { ok: true } }];
    }
  });
  assert.equal(
    evaluateAcceptance(
      [schemaCriterion],
      output({ artifacts: [artifactWithAccessor] })
    ).checks[0].status,
    'failed'
  );
  assert.equal(partReads, 0);
});

test('structured candidate containers reject inherited artifacts and parts', () => {
  const schemaCriterion = criterion('json-schema', {
    schema: {
      type: 'object',
      required: ['ok'],
      properties: { ok: { const: true } }
    }
  });
  const inheritedArtifacts = Object.create({
    artifacts: [{ parts: [{ data: { ok: true } }] }]
  });
  Object.assign(inheritedArtifacts, { text: '', data: null });
  assert.equal(
    evaluateAcceptance([schemaCriterion], inheritedArtifacts).checks[0].status,
    'failed'
  );

  const inheritedParts = Object.create({
    parts: [{ data: { ok: true } }]
  });
  assert.equal(
    evaluateAcceptance(
      [schemaCriterion],
      output({ artifacts: [inheritedParts] })
    ).checks[0].status,
    'failed'
  );
});

test('structured candidates reject executable nested accessors before Ajv sees them', () => {
  let reads = 0;
  const candidate = {};
  Object.defineProperty(candidate, 'ok', {
    enumerable: true,
    get() {
      reads += 1;
      return true;
    }
  });
  const result = evaluateAcceptance(
    [criterion('json-schema', {
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { const: true } }
      }
    })],
    output({ data: candidate })
  );

  assert.equal(result.checks[0].status, 'failed');
  assert.equal(reads, 0);
});

test('structured candidates accept only inert plain JSON values', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const withSymbol = { ok: true };
  withSymbol[Symbol('hidden')] = true;
  const withHidden = { ok: true };
  Object.defineProperty(withHidden, 'hidden', {
    value: true,
    enumerable: false
  });
  class Candidate {
    constructor() {
      this.ok = true;
    }
  }

  for (const candidate of [
    cyclic,
    withSymbol,
    withHidden,
    new Candidate(),
    new Date('2026-07-25T00:00:00.000Z'),
    { ok: Number.NaN }
  ]) {
    const result = evaluateAcceptance(
      [criterion('json-schema', { schema: { type: 'object' } })],
      output({ data: candidate })
    );
    assert.equal(result.checks[0].status, 'failed');
  }
});

test('Ajv options neither coerce, default, nor remove candidate properties', () => {
  const fixtures = [
    {
      data: { n: '2' },
      schema: {
        type: 'object',
        properties: { n: { type: 'integer' } },
        required: ['n']
      }
    },
    {
      data: {},
      schema: {
        type: 'object',
        properties: { x: { type: 'integer', default: 7 } },
        required: ['x']
      }
    },
    {
      data: { ok: true, extra: 1 },
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        additionalProperties: false
      }
    }
  ];

  for (const fixture of fixtures) {
    const before = structuredClone(fixture);
    Object.freeze(fixture.schema);
    Object.freeze(fixture.data);
    const result = evaluateAcceptance(
      [criterion('json-schema', { schema: fixture.schema })],
      output({ data: fixture.data })
    );
    assert.equal(result.checks[0].status, 'failed');
    assert.deepEqual(fixture, before);
  }
});

test('numeric uses finite numbers, own dot paths, array segments, and zero default tolerance', () => {
  const withinTolerance = evaluateAcceptance(
    [criterion('numeric', {
      path: 'metrics.0.count',
      expected: 10,
      tolerance: 2
    })],
    output({ data: { metrics: [{ count: 12 }] } })
  );
  assert.equal(withinTolerance.checks[0].status, 'passed');

  const outsideTolerance = evaluateAcceptance(
    [criterion('numeric', {
      path: 'metrics.count',
      expected: 10,
      tolerance: 2
    })],
    output({ data: { metrics: { count: 12.0001 } } })
  );
  assert.equal(outsideTolerance.checks[0].status, 'failed');

  for (const [actual, expectedStatus] of [
    [10, 'passed'],
    [10.0001, 'failed'],
    ['10', 'failed'],
    [Number.POSITIVE_INFINITY, 'failed']
  ]) {
    const result = evaluateAcceptance(
      [criterion('numeric', { path: 'value', expected: 10 })],
      output({ data: { value: actual } })
    );
    assert.equal(result.checks[0].status, expectedStatus);
  }

  const inherited = Object.create({ metrics: { count: 10 } });
  const inheritedResult = evaluateAcceptance(
    [criterion('numeric', { path: 'metrics.count', expected: 10 })],
    output({ data: inherited })
  );
  assert.equal(inheritedResult.checks[0].status, 'failed');

  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 10;
    }
  });
  const accessorResult = evaluateAcceptance(
    [criterion('numeric', { path: 'value', expected: 10 })],
    output({ data: accessor })
  );
  assert.equal(accessorResult.checks[0].status, 'failed');
  assert.equal(getterReads, 0);

  for (const path of [
    'items.01.value',
    'items.-1.value',
    'items.length',
    'items.9007199254740992.value',
    'items..value',
    '.items',
    'items.'
  ]) {
    const result = evaluateAcceptance(
      [criterion('numeric', { path, expected: 4 })],
      output({ data: { items: [{ value: 4 }] } })
    );
    assert.equal(result.checks[0].status, 'failed', path);
  }
});
