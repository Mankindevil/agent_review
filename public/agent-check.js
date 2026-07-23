const form = document.querySelector('#diagnostics-form');
const platformKey = document.querySelector('#platform-key');
const agentToken = document.querySelector('#agent-token');
const runStreaming = document.querySelector('#run-streaming');
const confirmStreaming = document.querySelector('#confirm-streaming');
const streamWarning = document.querySelector('#stream-warning');
const submitButton = document.querySelector('#run-diagnostics');
const formError = document.querySelector('#form-error');
const overallState = document.querySelector('#overall-state');

const checkElements = {
  discovery: document.querySelector('#check-discovery'),
  'card-validation': document.querySelector('#check-card-validation'),
  call: document.querySelector('#check-call'),
  stream: document.querySelector('#check-stream')
};

clearSecrets();
window.addEventListener('pageshow', clearSecrets);
window.addEventListener('pagehide', clearSecrets);

runStreaming.addEventListener('change', () => {
  const enabled = runStreaming.checked;
  confirmStreaming.disabled = !enabled;
  streamWarning.classList.toggle('active', enabled);
  if (!enabled) confirmStreaming.checked = false;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.textContent = '';
  if (runStreaming.checked && !confirmStreaming.checked) {
    formError.textContent = '请确认流式检查会再次真实执行 Prompt。';
    confirmStreaming.focus();
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
        url: document.querySelector('#agent-url').value.trim(),
        sourceType: document.querySelector('#source-type').value,
        agentAuthorization: agentToken.value,
        allowCrossOriginAuthorization: document.querySelector('#allow-cross-origin').checked,
        prompt: document.querySelector('#diagnostic-prompt').value,
        timeoutMs: Number(document.querySelector('#timeout-ms').value),
        runStreaming: runStreaming.checked,
        confirmStreamingSideEffects: confirmStreaming.checked
      })
    });
    const payload = await response.json().catch(() => ({ error: '服务端没有返回合法 JSON。' }));
    if (!response.ok) throw new Error(payload.error || `诊断 API 返回 HTTP ${response.status}`);
    renderReport(payload);
  } catch (error) {
    formError.textContent = error.message || '诊断请求失败。';
    overallState.dataset.state = 'failed';
    overallState.textContent = '请求失败';
  } finally {
    submitButton.disabled = false;
    submitButton.classList.remove('busy');
  }
});

function setRunning() {
  submitButton.disabled = true;
  submitButton.classList.add('busy');
  overallState.dataset.state = 'running';
  overallState.textContent = '诊断进行中';
  for (const [id, element] of Object.entries(checkElements)) {
    element.dataset.status = id === 'stream' && !runStreaming.checked ? 'skipped' : 'running';
    element.querySelector('.check-status').textContent = id === 'stream' && !runStreaming.checked ? '未启用' : '检查中';
    element.querySelector('.check-duration').textContent = '—';
    element.querySelector('.check-details').replaceChildren();
  }
}

function renderReport(report) {
  overallState.dataset.state = report.ok ? 'passed' : 'failed';
  overallState.textContent = report.ok ? `普通调用可用 · ${report.durationMs} ms` : `诊断未通过 · ${report.durationMs} ms`;
  for (const check of report.checks || []) {
    const element = checkElements[check.id];
    if (!element) continue;
    element.dataset.status = check.status;
    element.querySelector('.check-status').textContent = statusLabel(check.status);
    element.querySelector('.check-summary').textContent = check.summary || '没有摘要。';
    element.querySelector('.check-duration').textContent = `${check.durationMs || 0} ms`;
    element.querySelector('.check-details').replaceChildren(buildDetails(check));
  }
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
      description.textContent = typeof value === 'string' ? value : JSON.stringify(value);
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

function statusLabel(status) {
  return {
    passed: '通过',
    failed: '失败',
    skipped: '跳过',
    blocked: '阻断',
    running: '检查中'
  }[status] || '等待';
}

function detailLabel(key) {
  return {
    resolvedUrl: 'Card 地址',
    contentType: '响应类型',
    version: '协议版本',
    binding: '接口绑定',
    targetOrigin: '调用目标',
    streaming: '流式能力',
    tenant: 'Tenant',
    preview: '响应预览',
    eventCount: '事件数量',
    category: '错误分类'
  }[key] || key;
}

function clearSecrets() {
  platformKey.value = '';
  agentToken.value = '';
}
