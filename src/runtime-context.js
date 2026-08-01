export const RUNTIME_CONTEXT_MAX_BYTES = 1_500_000;
export const RUNTIME_CONTEXT_WARN_RATIO = 0.8;
export const PANDA_QUERY_MAX_BYTES = 240_000;
export const PANDA_EVIDENCE_MAX_BYTES = 600_000;

export class RuntimeContextBudgetError extends RangeError {
  constructor(usage) {
    super(`runtime context ${usage.scope} exceeds ${usage.maxInputBytes} bytes`);
    this.code = 'MODEL_CONTEXT_BUDGET_EXCEEDED';
    this.contextUsage = usage;
  }
}

export function inspectRuntimeContext(system, prompt, options = {}) {
  const normalizedSystem = typeof system === 'string' ? system : String(system ?? '');
  const normalizedPrompt = typeof prompt === 'string' ? prompt : String(prompt ?? '');
  const maxInputBytes = positiveInteger(options.maxInputBytes, RUNTIME_CONTEXT_MAX_BYTES);
  const warnRatio = validWarnRatio(options.warnRatio) ? options.warnRatio : RUNTIME_CONTEXT_WARN_RATIO;
  const systemBytes = Buffer.byteLength(normalizedSystem, 'utf8');
  const promptBytes = Buffer.byteLength(normalizedPrompt, 'utf8');
  const inputBytes = systemBytes + promptBytes;
  const usage = {
    scope: typeof options.scope === 'string' && options.scope.trim() ? options.scope : 'runtime',
    systemBytes,
    promptBytes,
    inputBytes,
    estimatedTokens: Math.ceil(inputBytes / 4),
    maxInputBytes,
    warnRatio,
    status: inputBytes > maxInputBytes
      ? 'exceeded'
      : inputBytes >= maxInputBytes * warnRatio ? 'warning' : 'ok'
  };
  if (typeof options.onUsage === 'function') options.onUsage(usage);
  if (usage.status === 'exceeded') throw new RuntimeContextBudgetError(usage);
  return { system: normalizedSystem, prompt: normalizedPrompt, usage };
}

export function compactPandaQueries(queries, options = {}) {
  const perQueryBytes = positiveInteger(options.perQueryBytes, PANDA_QUERY_MAX_BYTES);
  const totalBytes = positiveInteger(options.totalBytes, PANDA_EVIDENCE_MAX_BYTES);
  const compacted = [];

  for (const query of Array.isArray(queries) ? queries : []) {
    const source = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
    const sourceResult = source.result && typeof source.result === 'object' && !Array.isArray(source.result)
      ? source.result
      : { data: source.result };
    if (!Object.hasOwn(source, 'result')) {
      compacted.push(structuredClone(source));
      ensureAggregateBudget(compacted, totalBytes);
      continue;
    }

    const rows = Array.isArray(sourceResult.data) ? sourceResult.data : [];
    const originalRows = Number.isInteger(sourceResult.rowCount) && sourceResult.rowCount >= rows.length
      ? sourceResult.rowCount
      : rows.length;
    const { data: _data, originalRows: _originalRows, keptRows: _keptRows,
      droppedRows: _droppedRows, truncated: _truncated, ...metadata } = sourceResult;
    const candidateRows = [];
    const makeCandidate = () => ({
      ...source,
      result: {
        ...metadata,
        originalRows,
        keptRows: candidateRows.length,
        droppedRows: originalRows - candidateRows.length,
        truncated: sourceResult.truncated === true || candidateRows.length < originalRows,
        data: candidateRows
      }
    });

    let candidate = makeCandidate();
    ensureQueryBudget(candidate, perQueryBytes);
    ensureAggregateBudget([...compacted, candidate], totalBytes);
    for (const row of rows) {
      candidateRows.push(row);
      const withRow = makeCandidate();
      if (serializedBytes(withRow) > perQueryBytes ||
          serializedBytes([...compacted, withRow]) > totalBytes) {
        candidateRows.pop();
        break;
      }
      candidate = withRow;
    }
    compacted.push(candidate);
  }

  const usedBytes = serializedBytes(compacted);
  return {
    queries: compacted,
    budget: {
      perQueryBytes,
      totalBytes,
      usedBytes,
      queryBytes: compacted.map((query) => serializedBytes(query))
    }
  };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function validWarnRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function ensureQueryBudget(query, maxInputBytes) {
  const inputBytes = serializedBytes(query);
  if (inputBytes <= maxInputBytes) return;
  throw new RuntimeContextBudgetError({
    scope: 'panda-query',
    inputBytes,
    estimatedTokens: Math.ceil(inputBytes / 4),
    maxInputBytes,
    warnRatio: 1,
    status: 'exceeded'
  });
}

function ensureAggregateBudget(queries, maxInputBytes) {
  const inputBytes = serializedBytes(queries);
  if (inputBytes <= maxInputBytes) return;
  throw new RuntimeContextBudgetError({
    scope: 'panda-evidence',
    inputBytes,
    estimatedTokens: Math.ceil(inputBytes / 4),
    maxInputBytes,
    warnRatio: 1,
    status: 'exceeded'
  });
}
