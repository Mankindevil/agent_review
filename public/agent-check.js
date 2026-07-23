const MAX_CARD_BYTES = 1024 * 1024;

const form = document.querySelector('#diagnostics-form');
const platformKey = document.querySelector('#platform-key');
const cardFile = document.querySelector('#agent-card-file');
const cardJson = document.querySelector('#agent-card-json');
const dropZone = document.querySelector('#card-drop-zone');
const cardSummary = document.querySelector('#card-summary');
const authMethod = document.querySelector('#auth-method');
const authFields = document.querySelector('#auth-fields');
const authTargetOrigin = document.querySelector('#auth-target-origin');
const agentToken = document.querySelector('#agent-token');
const confirmAuthTarget = document.querySelector('#confirm-auth-target');
const diagnosticPrompt = document.querySelector('#diagnostic-prompt');
const timeoutSelect = document.querySelector('#timeout-ms');
const attestationDeepseek = document.querySelector('#attestation-deepseek');
const attestationAuthorized = document.querySelector('#attestation-authorized');
const runStreaming = document.querySelector('#run-streaming');
const confirmStreaming = document.querySelector('#confirm-streaming');
const streamWarning = document.querySelector('#stream-warning');
const submitButton = document.querySelector('#run-diagnostics');
const formError = document.querySelector('#form-error');
const overallState = document.querySelector('#overall-state');
const technicalReadiness = document.querySelector('#technical-readiness');

const checkElements = {
  'card-input': document.querySelector('#check-card-input'),
  'card-validation': document.querySelector('#check-card-validation'),
  call: document.querySelector('#check-call'),
  stream: document.querySelector('#check-stream')
};

let parsedAgentCard = null;
let selectedTargetOrigin = '';

window.addEventListener('pageshow', clearSensitiveState);
window.addEventListener('pagehide', clearSensitiveState);

cardFile.addEventListener('change', async () => {
  const [file] = cardFile.files || [];
  if (file) await loadCardFile(file);
});

cardJson.addEventListener('input', () => {
  applyCardText(cardJson.value);
});

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('drag-active');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag-active');
  });
}
dropZone.addEventListener('drop', async (event) => {
  const [file] = event.dataTransfer?.files || [];
  if (file) await loadCardFile(file);
});
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    cardFile.click();
  }
});

authMethod.addEventListener('change', syncAuthMode);
runStreaming.addEventListener('change', syncStreamingMode);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.textContent = '';

  if (!parsedAgentCard) {
    showFormError('请先上传或粘贴一张合法的 Agent Card JSON。', cardJson);
    return;
  }
  if (authMethod.value === 'bearer' && !agentToken.value) {
    showFormError('Bearer 鉴权必须填写 Agent Token。', agentToken);
    return;
  }
  if (authMethod.value === 'bearer' && !confirmAuthTarget.checked) {
    showFormError('请确认 Agent Token 的目标 origin。', confirmAuthTarget);
    return;
  }
  if (!attestationDeepseek.checked || !attestationAuthorized.checked) {
    showFormError('请确认两项参评声明。', attestationDeepseek);
    return;
  }
  if (runStreaming.checked && !confirmStreaming.checked) {
    showFormError('请确认流式检查会再次真实执行 Prompt。', confirmStreaming);
    return;
  }

  setRunning();
  try {
    const response = await fetch('/api/agent-diagnostics', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${platformKey.value}`
      },
      body: JSON.stringify({
        agentCard: parsedAgentCard,
        authMethod: authMethod.value,
        agentAuthorization: authMethod.value === 'bearer' ? agentToken.value : '',
        confirmAuthorizationTarget:
          authMethod.value === 'bearer' && confirmAuthTarget.checked,
        prompt: diagnosticPrompt.value,
        timeoutMs: Number(timeoutSelect.value),
        runStreaming: runStreaming.checked,
        confirmStreamingSideEffects: confirmStreaming.checked,
        attestations: {
          deepseekV4Pro: attestationDeepseek.checked,
          authorizedDataOnly: attestationAuthorized.checked
        }
      })
    });
    const payload = await response.json().catch(() => ({
      error: '服务端没有返回合法 JSON。'
    }));
    if (!response.ok) {
      throw new Error(payload.error || `预检 API 返回 HTTP ${response.status}`);
    }
    renderReport(payload);
  } catch (error) {
    formError.textContent = error.message || '技术预检请求失败。';
    overallState.dataset.state = 'failed';
    overallState.textContent = '请求失败';
  } finally {
    submitButton.disabled = false;
    submitButton.classList.remove('busy');
  }
});

clearSensitiveState();

async function loadCardFile(file) {
  formError.textContent = '';
  if (file.size > MAX_CARD_BYTES) {
    setCardError('文件超过 1 MiB，请缩小 Agent Card 后重试。');
    cardFile.value = '';
    return;
  }
  try {
    const text = await file.text();
    cardJson.value = text;
    applyCardText(text, file.name);
  } catch {
    setCardError('无法读取该文件，请确认它是 UTF-8 JSON。');
  }
}

function applyCardText(text, sourceName = '') {
  parsedAgentCard = null;
  selectedTargetOrigin = '';
  confirmAuthTarget.checked = false;
  authTargetOrigin.textContent = '等待有效 Card';

  const raw = String(text || '');
  if (!raw.trim()) {
    setCardEmpty();
    return;
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_CARD_BYTES) {
    setCardError('Agent Card JSON 超过 1 MiB。');
    return;
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    setCardError(`JSON 语法错误：${error.message}`);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    setCardError('一次只测试一张 Agent Card；JSON 根节点必须是对象。');
    return;
  }

  parsedAgentCard = value;
  const target = selectCardInterface(value);
  if (target) {
    try {
      selectedTargetOrigin = new URL(target.url).origin;
    } catch {
      selectedTargetOrigin = '';
    }
  }
  authTargetOrigin.textContent = selectedTargetOrigin || '接口地址待服务端校验';
  renderCardSummary(value, target, raw, sourceName);
}

function renderCardSummary(agentCard, target, raw, sourceName) {
  cardSummary.dataset.state = target ? 'valid' : 'warning';
  const heading = document.createElement('div');
  heading.className = 'card-summary-head';

  const mark = document.createElement('span');
  mark.className = 'summary-mark';
  mark.textContent = target ? '✓' : '!';

  const title = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = String(agentCard.name || '未命名 Agent');
  const description = document.createElement('p');
  description.textContent = truncate(
    agentCard.description || 'Card 未提供 description。',
    180
  );
  title.append(name, description);
  heading.append(mark, title);

  const details = document.createElement('dl');
  appendSummaryDetail(details, '来源', sourceName || '粘贴内容');
  appendSummaryDetail(
    details,
    '协议',
    target?.version || agentCard.protocolVersion || '待校验'
  );
  appendSummaryDetail(details, 'Binding', target?.binding || '没有受支持接口');
  appendSummaryDetail(details, '目标', target?.url || '—');
  appendSummaryDetail(details, 'Tenant', target?.tenant || '未声明');
  appendSummaryDetail(
    details,
    'Skills',
    Array.isArray(agentCard.skills) ? agentCard.skills.length : 0
  );
  appendSummaryDetail(
    details,
    'Streaming',
    agentCard.capabilities?.streaming === true ? '已声明' : '未声明'
  );
  appendSummaryDetail(details, '大小', `${new TextEncoder().encode(raw).byteLength} B`);
  cardSummary.replaceChildren(heading, details);
}

function appendSummaryDetail(list, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = String(value);
  list.append(term, description);
}

function selectCardInterface(agentCard) {
  const bindings = {
    JSONRPC: 'JSONRPC',
    'JSON-RPC': 'JSONRPC',
    HTTP_JSON: 'HTTP+JSON',
    'HTTP+JSON': 'HTTP+JSON'
  };
  if (Array.isArray(agentCard.supportedInterfaces)) {
    for (const item of agentCard.supportedInterfaces) {
      const binding = bindings[item?.protocolBinding] || item?.protocolBinding || '';
      const version = item?.protocolVersion || agentCard.protocolVersion || '';
      if (
        typeof item?.url === 'string' &&
        ['JSONRPC', 'HTTP+JSON'].includes(binding) &&
        (/^1\./.test(version) || /^0\.3(?:\.|$)/.test(version))
      ) {
        return {
          url: item.url,
          binding,
          version,
          tenant: typeof item.tenant === 'string' ? item.tenant : ''
        };
      }
    }
  }
  if (typeof agentCard.url === 'string' && agentCard.url) {
    return {
      url: agentCard.url,
      binding: bindings[agentCard.preferredTransport] || 'JSONRPC',
      version: agentCard.protocolVersion || '0.3',
      tenant: ''
    };
  }
  return null;
}

function setCardEmpty() {
  cardSummary.dataset.state = 'empty';
  const mark = document.createElement('span');
  mark.className = 'summary-mark';
  mark.textContent = '∅';
  const message = document.createElement('p');
  message.textContent =
    '等待一张 Agent Card。服务地址将从 Card 声明中读取，不能另行覆盖。';
  cardSummary.replaceChildren(mark, message);
}

function setCardError(message) {
  parsedAgentCard = null;
  selectedTargetOrigin = '';
  authTargetOrigin.textContent = '等待有效 Card';
  confirmAuthTarget.checked = false;
  cardSummary.dataset.state = 'invalid';
  const mark = document.createElement('span');
  mark.className = 'summary-mark';
  mark.textContent = '×';
  const text = document.createElement('p');
  text.textContent = message;
  cardSummary.replaceChildren(mark, text);
}

function syncAuthMode() {
  const bearer = authMethod.value === 'bearer';
  authFields.dataset.active = String(bearer);
  agentToken.disabled = !bearer;
  confirmAuthTarget.disabled = !bearer;
  if (!bearer) {
    agentToken.value = '';
    confirmAuthTarget.checked = false;
  }
}

function syncStreamingMode() {
  const enabled = runStreaming.checked;
  confirmStreaming.disabled = !enabled;
  streamWarning.classList.toggle('active', enabled);
  if (!enabled) confirmStreaming.checked = false;
}

function setRunning() {
  submitButton.disabled = true;
  submitButton.classList.add('busy');
  overallState.dataset.state = 'running';
  overallState.textContent = '预检进行中';
  resetReadiness('正在等待 Agent 返回技术证据。');
  for (const [id, element] of Object.entries(checkElements)) {
    const skipped = id === 'stream' && !runStreaming.checked;
    element.dataset.status = skipped ? 'skipped' : 'running';
    element.querySelector('.check-status').textContent =
      skipped ? '未启用' : '检查中';
    element.querySelector('.check-summary').textContent =
      skipped ? '本次未请求流式检查。' : '正在执行…';
    element.querySelector('.check-duration').textContent = '—';
    element.querySelector('.check-details').replaceChildren();
  }
}

function renderReport(report) {
  overallState.dataset.state = report.technicalReadinessOk ? 'passed' : 'failed';
  overallState.textContent = report.technicalReadinessOk
    ? `技术门槛通过 · ${report.durationMs} ms`
    : `技术门槛未通过 · ${report.durationMs} ms`;
  renderReadiness(report.technicalReadiness);

  for (const check of report.checks || []) {
    const element = checkElements[check.id];
    if (!element) continue;
    element.dataset.status = check.status;
    element.querySelector('.check-status').textContent = statusLabel(check.status);
    element.querySelector('.check-summary').textContent =
      check.summary || '没有摘要。';
    element.querySelector('.check-duration').textContent =
      `${check.durationMs || 0} ms`;
    element.querySelector('.check-details').replaceChildren(buildDetails(check));
  }
}

function renderReadiness(readiness) {
  const checks = readiness?.checks || [];
  if (!checks.length) {
    resetReadiness('服务端没有返回技术门槛明细。');
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const check of checks) {
    const item = document.createElement('article');
    item.className = 'readiness-item';
    item.dataset.status = check.status;

    const header = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = readinessLabel(check.id);
    const status = document.createElement('span');
    status.textContent = statusLabel(check.status);
    header.append(name, status);

    const summary = document.createElement('p');
    summary.textContent = check.summary || '没有摘要。';
    item.append(header, summary);
    fragment.append(item);
  }
  technicalReadiness.replaceChildren(fragment);
}

function resetReadiness(message) {
  const empty = document.createElement('p');
  empty.className = 'readiness-empty';
  empty.textContent = message;
  technicalReadiness.replaceChildren(empty);
}

function buildDetails(check) {
  const fragment = document.createDocumentFragment();
  const entries = Object.entries(check.details || {});
  if (entries.length) {
    const list = document.createElement('dl');
    for (const [key, value] of entries) {
      const term = document.createElement('dt');
      term.textContent = detailLabel(key);
      const description = document.createElement('dd');
      description.textContent =
        typeof value === 'string' ? value : JSON.stringify(value);
      list.append(term, description);
    }
    fragment.append(list);
  }
  if (check.suggestion) {
    const suggestion = document.createElement('p');
    suggestion.className = 'suggestion';
    suggestion.textContent = `建议：${check.suggestion}`;
    fragment.append(suggestion);
  }
  return fragment;
}

function showFormError(message, target) {
  formError.textContent = message;
  target?.focus();
}

function statusLabel(status) {
  return {
    passed: '通过',
    failed: '失败',
    skipped: '跳过',
    blocked: '阻断',
    declared: '已声明',
    running: '检查中'
  }[status] || '等待';
}

function readinessLabel(id) {
  return {
    'agent-card': 'Agent Card',
    'a2a-call': '自然语言 A2A 调用',
    'response-time': '响应时限',
    'competition-attestations': '参评声明'
  }[id] || id;
}

function detailLabel(key) {
  return {
    name: 'Agent 名称',
    sizeBytes: 'Card 大小',
    version: '协议版本',
    binding: '接口绑定',
    targetOrigin: '调用目标',
    streaming: '流式能力',
    tenant: 'Tenant',
    skillsCount: 'Skills 数量',
    timeoutMs: '响应上限',
    durationMs: '实际耗时',
    preview: '响应预览',
    eventCount: '事件数量',
    category: '错误分类'
  }[key] || key;
}

function clearSensitiveState() {
  form.reset();
  platformKey.value = '';
  agentToken.value = '';
  cardFile.value = '';
  cardJson.value = '';
  parsedAgentCard = null;
  selectedTargetOrigin = '';
  confirmAuthTarget.checked = false;
  formError.textContent = '';
  authTargetOrigin.textContent = '等待有效 Card';
  overallState.dataset.state = 'idle';
  overallState.textContent = '等待输入';
  setCardEmpty();
  syncAuthMode();
  syncStreamingMode();
  resetReadiness('完成实测后，这里会汇总 Card、A2A 调用、响应时限与参评声明。');
  for (const [id, element] of Object.entries(checkElements)) {
    element.dataset.status = 'idle';
    element.querySelector('.check-status').textContent =
      id === 'stream' ? '默认关闭' : '等待';
    element.querySelector('.check-duration').textContent = '—';
    element.querySelector('.check-details').replaceChildren();
  }
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
