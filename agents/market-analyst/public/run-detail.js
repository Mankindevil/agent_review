const form = document.querySelector('#access-form');
const tokenInput = document.querySelector('#access-token');
const statusNode = document.querySelector('#status');
const detailNode = document.querySelector('#detail');

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_DETAIL_ROWS = 200;

function resolveRunId() {
  const pathValue = location.pathname.match(/\/runs\/([^/]+)/)?.[1];
  if (pathValue) {
    try {
      return decodeURIComponent(pathValue);
    } catch {
      return '';
    }
  }
  return new URLSearchParams(location.search).get('runId') || '';
}

const runId = resolveRunId();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const redacted = text.replace(
    /\b([a-z0-9._%+-])([a-z0-9._%+-]*)@([a-z0-9.-]+\.[a-z]{2,})\b/gi,
    (_match, first, _rest, domain) => `${first}***@${domain}`
  );
  return redacted.length > 4_000
    ? `${redacted.slice(0, 4_000)}…[TRUNCATED]`
    : redacted;
}

function card(title, headers, rows) {
  const section = element('section', undefined, 'card');
  section.append(element('h2', title));
  if (!rows.length) {
    section.append(element('p', '无记录', 'empty'));
    return section;
  }
  const wrap = element('div', undefined, 'table-wrap');
  const table = element('table');
  const head = element('thead');
  const headerRow = element('tr');
  for (const header of headers) headerRow.append(element('th', header));
  head.append(headerRow);
  const body = element('tbody');
  for (const row of rows) {
    const tr = element('tr');
    for (const item of row) tr.append(element('td', valueText(item)));
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  section.append(wrap);
  return section;
}

function detailCollection(items) {
  const values = Array.isArray(items) ? items : [];
  const sentinel = values.at(-1);
  if (sentinel?._truncated === true) {
    const omitted = Number.isSafeInteger(sentinel.detail?.omitted)
      && sentinel.detail.omitted >= 0
      ? sentinel.detail.omitted
      : 1;
    return {
      values: values.slice(0, -1),
      total: Math.max(0, values.length - 1 + omitted),
      truncated: true
    };
  }
  return { values, total: values.length, truncated: false };
}

function mergeDetailCollections(...items) {
  const collections = items.map(detailCollection);
  return {
    values: collections.flatMap((collection) => collection.values),
    total: collections.reduce((sum, collection) => sum + collection.total, 0),
    truncated: collections.some((collection) => collection.truncated)
  };
}

function detailRows(items, section, width, project) {
  const collection = Array.isArray(items) ? detailCollection(items) : items;
  const values = collection?.values || [];
  const shown = values.slice(0, MAX_DETAIL_ROWS);
  const rows = shown.map(project);
  if (collection?.truncated || collection?.total > MAX_DETAIL_ROWS) {
    rows.push([
      `TRUNCATED:detail:${section}`,
      `shown=${shown.length}; total=${collection.total}; omitted=${collection.total - shown.length}`,
      ...Array(Math.max(0, width - 2)).fill('—')
    ]);
  }
  return rows;
}

function errorCard(title, error) {
  const section = element('section', undefined, 'card error-card');
  section.append(
    element('h2', `${title}加载失败`),
    element('p', valueText(error?.message || error), 'error')
  );
  return section;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateArrayFields(value, fields, kind) {
  for (const field of fields) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new TypeError(`${kind}.${field} 必须是数组`);
    }
    if (Array.isArray(value[field]) && value[field].some((item) => !isObject(item))) {
      throw new TypeError(`${kind}.${field} 数组成员必须是对象`);
    }
  }
}

function validateArtifactShape(kind, value) {
  if (kind === 'report') {
    if (
      typeof value !== 'string'
      && (!isObject(value)
        || !['markdown', 'text', 'html'].some((field) => typeof value[field] === 'string'))
    ) {
      throw new TypeError('report 响应结构无效');
    }
    return value;
  }
  if (!isObject(value)) throw new TypeError(`${kind} 响应必须是对象`);
  if (kind === 'run') validateArrayFields(value, ['artifacts'], kind);
  if (kind === 'evidence') {
    validateArrayFields(value, ['artifacts', 'conclusions'], kind);
  }
  if (kind === 'trace') {
    validateArrayFields(value, ['steps', 'workerEvents', 'modelUsage', 'emailAttempts'], kind);
    if (
      value.conclusionLineage !== undefined
      && !Array.isArray(value.conclusionLineage)
      && !isObject(value.conclusionLineage)
    ) {
      throw new TypeError('trace.conclusionLineage 必须是数组或对象');
    }
    if (
      Array.isArray(value.conclusionLineage)
      && value.conclusionLineage.some((item) => !isObject(item))
    ) {
      throw new TypeError('trace.conclusionLineage 数组成员必须是对象');
    }
  }
  return value;
}

async function readBoundedBody(response, path) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
    throw new RangeError(`${path} 响应超过 ${MAX_ARTIFACT_BYTES} 字节上限`);
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_ARTIFACT_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Preserve the size-limit error even if cancellation itself fails.
          }
          throw new RangeError(`${path} 响应超过 ${MAX_ARTIFACT_BYTES} 字节上限`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_ARTIFACT_BYTES) {
    throw new RangeError(`${path} 响应超过 ${MAX_ARTIFACT_BYTES} 字节上限`);
  }
  return new TextDecoder().decode(buffer);
}

async function fetchProtected(path, token, kind) {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  const text = await readBoundedBody(response, path);
  let value = text;
  if (type.includes('json')) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new TypeError(`${path} 返回无效 JSON`);
    }
  }
  return validateArtifactShape(kind, value);
}

function render({ run = {}, report = '', evidence = {}, trace = {} }, failures = []) {
  const rawTraceLineage = Array.isArray(trace?.conclusionLineage)
    ? trace.conclusionLineage
    : (trace?.conclusionLineage && typeof trace.conclusionLineage === 'object'
      ? [trace.conclusionLineage]
      : []);
  const lineageItems = mergeDetailCollections(evidence?.conclusions, rawTraceLineage);
  const lineage = new Map();
  for (const item of lineageItems.values.slice(0, MAX_DETAIL_ROWS)) {
    const id = item.conclusion_id || item.conclusionId;
    if (id) lineage.set(id, { ...(lineage.get(id) || {}), ...item });
  }
  detailNode.replaceChildren();
  detailNode.append(
    card('运行摘要', ['字段', '值'], [
      ['运行 ID', run?.id || evidence?.runId || runId],
      ['状态', run?.status?.state || run?.status || evidence?.status],
      ['报告日', evidence?.reportDate],
      ['开始时间', run?.startedAt || trace?.startedAt],
      ['结束时间', run?.endedAt || trace?.endedAt]
    ]),
    card('技能与工具调用', ['序号', '技能', '工具', '状态', '耗时(ms)'],
      detailRows(trace?.steps, 'steps', 5, (item) => [
        item.sequence, item.skillId, item.tool, item.status, item.durationMs
      ])),
    card('Panda 调用', ['序号', '方法', '耗时(ms)', '行数', '缓存', '重试', '状态'],
      detailRows(trace?.workerEvents, 'worker-events', 7, (item) => [
        item.sequence,
        item.method || item.detail?.method,
        item.durationMs ?? item.detail?.durationMs,
        item.rowCount ?? item.detail?.rowCount,
        item.cache ?? item.cacheStatus ?? item.detail?.cache,
        item.retries ?? item.retryCount ?? item.detail?.retries,
        item.status
      ])),
    card('模型用量', ['提供方', '模型', '输入', '输出', '推理', '缓存', '总计', '成本', '币种'],
      detailRows(trace?.modelUsage, 'model-usage', 9, (item) => [
        item.provider, item.model, item.inputTokens, item.outputTokens,
        item.reasoningTokens, item.cachedTokens, item.totalTokens, item.cost, item.currency
      ])),
    card('邮件尝试', ['状态', '时间', '收件方摘要', '错误'],
      detailRows(trace?.emailAttempts, 'email-attempts', 4, (item) => [
        item.status, item.attemptedAt || item.startedAt, item.recipients, item.error
      ])),
    card('产物', ['名称', 'SHA-256', '类型'],
      detailRows(
        mergeDetailCollections(run?.artifacts, evidence?.artifacts),
        'artifacts',
        3,
        (item) => [
        item.name, item.sha256 || item.hash, item.mediaType || item.type
        ]
      )),
    card('结论链路', ['结论 ID', '公式', '置信度', '来源', '指标/证据', '数据日/窗口', '限制'],
      detailRows({
        values: [...lineage.entries()],
        total: lineageItems.total,
        truncated: lineageItems.truncated
      }, 'lineage', 7, ([id, item]) => [
        id, item.formula, item.confidence,
        item.sourceIds || item.pandaCalls, item.metricIds || item.evidenceIds,
        item.dataDate || item.window || item.dataWindow, item.limitations
      ])),
    card('报告产物', ['格式', '内容'], [[
      typeof report === 'string' ? 'text' : 'structured',
      typeof report === 'string' ? report : report?.markdown || report?.text || report
    ]])
  );
  for (const failure of failures) {
    detailNode.append(errorCard(failure.title, failure.error));
  }
  detailNode.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!runId) {
    statusNode.textContent = 'URL 中缺少运行 ID。';
    return;
  }
  let token = tokenInput.value;
  tokenInput.value = '';
  statusNode.textContent = '正在加载受保护产物…';
  detailNode.hidden = true;
  try {
    const base = `/runs/${encodeURIComponent(runId)}`;
    const specs = [
      { kind: 'run', title: '运行摘要', path: base },
      { kind: 'report', title: '报告产物', path: `${base}/report` },
      { kind: 'evidence', title: '证据包', path: `${base}/evidence` },
      { kind: 'trace', title: '运行追踪', path: `${base}/trace` }
    ];
    const results = await Promise.allSettled(
      specs.map((item) => fetchProtected(item.path, token, item.kind))
    );
    const loaded = {};
    const failures = [];
    results.forEach((result, index) => {
      const spec = specs[index];
      if (result.status === 'fulfilled') loaded[spec.kind] = result.value;
      else failures.push({ title: spec.title, error: result.reason });
    });
    render(loaded, failures);
    statusNode.textContent = failures.length
      ? `部分加载完成，${failures.length} 项加载失败。`
      : '已加载。';
  } finally {
    token = '';
  }
});
