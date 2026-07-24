import { validateAgentAuthorization } from './a2a-executor.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export class EphemeralCredentialVault {
  #credentials = new Map();
  #onZeroized;

  constructor(options = {}) {
    if (
      options.onZeroized !== undefined &&
      typeof options.onZeroized !== 'function'
    ) {
      throw new TypeError('credential zeroization observer must be a function');
    }
    this.#onZeroized = options.onZeroized;
  }

  put(evaluationId, authorization) {
    assertEvaluationId(evaluationId);
    if (authorization === undefined || authorization === null) {
      throw new TypeError('Agent authorization is required');
    }
    validateAgentAuthorization(authorization);
    const previous = this.#credentials.get(evaluationId);
    if (previous) this.#destroy(evaluationId, previous, 'replaced');
    const stored = Buffer.from(authorization, 'utf8');
    this.#credentials.set(evaluationId, stored);
  }

  get(evaluationId) {
    assertEvaluationId(evaluationId);
    const stored = this.#credentials.get(evaluationId);
    return stored ? Buffer.from(stored).toString('utf8') : undefined;
  }

  delete(evaluationId) {
    assertEvaluationId(evaluationId);
    const stored = this.#credentials.get(evaluationId);
    if (!stored) return false;
    this.#destroy(evaluationId, stored, 'deleted');
    this.#credentials.delete(evaluationId);
    return true;
  }

  #destroy(evaluationId, stored, reason) {
    const byteLength = stored.length;
    stored.fill(0);
    if (!this.#onZeroized) return;
    const event = Object.freeze({ evaluationId, reason, byteLength });
    try {
      this.#onZeroized(event);
    } catch {
      // Observation must never interfere with credential destruction.
    }
  }
}

function assertEvaluationId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError('evaluation identifier is invalid');
  }
}
