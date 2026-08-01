export function evaluationModeFromHealth(payload) {
  if (typeof payload?.a2aBlackBoxV1Enabled !== 'boolean') {
    return { resolved: false, enabled: null };
  }
  return {
    resolved: true,
    enabled: payload.a2aBlackBoxV1Enabled
  };
}

export function requestedEvaluationVersion(search = '') {
  const values = new URLSearchParams(String(search)).getAll('version');
  if (values.length !== 1) return null;
  return values[0] === 'v1' || values[0] === 'v2' ? values[0] : null;
}

export function resolveEvaluationVersion(requestedVersion, v2Available) {
  const selectedVersion = requestedVersion || (v2Available ? 'v2' : 'v1');
  return {
    selectedVersion,
    usable: selectedVersion === 'v1' || v2Available
  };
}

export function runtimeStatusLabel(runtime) {
  if (runtime.runtimeReady) return 'READY';
  if (!runtime.installed && !runtime.authenticated) return '缺失';
  if (!runtime.authenticated) return '未登录';
  if (!runtime.enabled) return '未启用';
  return '调用失败';
}

export function nextAvailableEditorId(values, prefix) {
  const occupied = new Set(values);
  let ordinal = 1;
  while (occupied.has(`${prefix}-${ordinal}`)) ordinal += 1;
  return `${prefix}-${ordinal}`;
}

export function recordActionCopy(_isV2) {
  return {
    idle: '删除',
    confirm: '再点一次确认',
    pending: '删除中',
    failed: '删除失败'
  };
}

export function recordActionFailure(_isV2, upstreamMessage = '') {
  const copy = recordActionCopy();
  const upstream = String(upstreamMessage || '').trim();
  if (!upstream) return copy.failed;
  if (upstream === copy.failed || upstream.startsWith(`${copy.failed}：`)) {
    return upstream;
  }
  return `${copy.failed}：${upstream}`;
}
