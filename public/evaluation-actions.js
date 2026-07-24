const V2_STOPPABLE_STATUSES = new Set([
  'queued',
  'running',
  'retrying',
  'credentials-required',
  'interrupted'
]);
const ARCHIVEABLE_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]);
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
]);

export function resolveParticipantToken(
  evaluationId,
  participantTokens,
  manualValue = ''
) {
  const remembered = participantTokens.get(evaluationId);
  if (remembered) return remembered;
  const supplied = String(manualValue).trim();
  if (!supplied) {
    throw new Error('Participant access token is required for this action');
  }
  participantTokens.set(evaluationId, supplied);
  return supplied;
}

export function participantActionOptions(method, participantToken) {
  if (!participantToken) {
    throw new Error('Participant access token is required for this action');
  }
  return {
    method,
    headers: {
      authorization: `Bearer ${participantToken}`
    }
  };
}

export function canStopEvaluation(item) {
  if (!item || item.archivedAt) return false;
  if (item.schemaVersion === 2) {
    return V2_STOPPABLE_STATUSES.has(item.execution?.status);
  }
  return !TERMINAL_STATUSES.has(item.status);
}

export function canArchiveEvaluation(item) {
  return Boolean(
    item?.schemaVersion === 2 &&
    !item.archivedAt &&
    ARCHIVEABLE_STATUSES.has(item.execution?.status)
  );
}

export function restoreV2StartButton(button) {
  if (!button) return;
  button.disabled = false;
  const label = button.querySelector('span');
  if (label) label.textContent = '启动 A2A 证据评测';
}
