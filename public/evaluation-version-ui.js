const UNRESOLVED_MODE_MESSAGE = '无法从服务确认评测模式，请稍后刷新重试。';
const V2_UNAVAILABLE_MESSAGE = 'V2 证据评测当前未启用，请切换到 V1 经典评测。';

export function evaluationVersionUiState({ healthResolved, selectedVersion, v2Available }) {
  if (!healthResolved || !['v1', 'v2'].includes(selectedVersion)) {
    return {
      selectedVersion,
      usable: false,
      label: '无法确认评测模式',
      message: UNRESOLVED_MODE_MESSAGE
    };
  }
  const isV2 = selectedVersion === 'v2';
  const usable = !isV2 || v2Available === true;
  return {
    selectedVersion,
    usable,
    label: isV2 ? '启动 A2A 证据评测' : '送进研究终审台',
    message: usable ? '' : V2_UNAVAILABLE_MESSAGE
  };
}

export function selectedSubmissionVersion(state) {
  const versionState = evaluationVersionUiState(state);
  return versionState.usable ? versionState.selectedVersion : null;
}

export function restoreLandingStartButton(button, state) {
  const versionState = evaluationVersionUiState(state);
  if (!button) return versionState;
  button.disabled = !versionState.usable;
  const label = button.querySelector('span');
  if (label) label.textContent = versionState.label;
  return versionState;
}

export function homepageHistoryUrl(pathname, search = '') {
  return `${pathname}${search}`;
}

export function buildEvaluationCreateRequest(version, {
  agentCard,
  agentExamples,
  mode,
  scoringConfig,
  seed,
  agentAuthorization,
  skipHumanReview
}) {
  if (version === 'v1') {
    return {
      agentCard,
      agentExamples,
      mode,
      scoringConfig,
      ...(seed !== undefined ? { seed } : {}),
      ...(agentAuthorization ? { agentAuthorization } : {})
    };
  }
  if (version === 'v2') {
    return {
      schemaVersion: 2,
      agentCard,
      agentExamples,
      ...(agentAuthorization ? { agentAuthorization } : {}),
      skipHumanReview
    };
  }
  throw new Error('评测版本不可用。');
}
