const V2_STOPPABLE_STATUSES = new Set([
  'queued',
  'running',
  'retrying',
  'credentials-required',
  'interrupted'
]);
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]);

export function evaluationActionOptions(method) {
  return { method };
}

export function canStopEvaluation(item) {
  if (!item || item.archivedAt) return false;
  if (item.schemaVersion === 2) {
    return V2_STOPPABLE_STATUSES.has(item.execution?.status);
  }
  return !TERMINAL_STATUSES.has(item.status);
}

export function canDeleteEvaluation(item) {
  if (item?.schemaVersion === 2) {
    return TERMINAL_STATUSES.has(item.execution?.status);
  }
  return TERMINAL_STATUSES.has(item.status);
}

export function restoreV2StartButton(button) {
  if (!button) return;
  button.disabled = false;
  const label = button.querySelector('span');
  if (label) label.textContent = '启动 A2A 证据评测';
}
