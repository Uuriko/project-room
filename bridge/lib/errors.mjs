/**
 * bridge/lib/errors.mjs — typed bridge errors.
 *
 * Every error carries a stable machine-readable `code`, an HTTP status, and a
 * `retryable` hint consumed by the socket client's retry policy. Messages never
 * include secrets or raw socket paths.
 */
export class BridgeError extends Error {
  constructor(code, message, { httpStatus = 500, retryable = false, details } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

const defs = {
  auth_denied: [401, 'bearer token or key id rejected'],
  server_misconfigured: [503, 'bridge is missing required configuration'],
  input: [422, 'request fields refused'],
  pane_not_found: [404, 'pane not found for this tenant'],
  handle_not_found: [404, 'occupant handle unknown or expired'],
  occupant_changed: [409, 'pane occupant changed since the handle was issued'],
  binding_mismatch: [409, 'self-report binding failed: HERDR_PANE_ID != target'],
  method_blocked: [403, 'socket method is never exposed'],
  method_unsupported: [422, 'unknown socket method'],
  idempotency_conflict: [409, 'idempotency key reused with different input'],
  timeout: [504, 'herdr socket call timed out', true],
  transport_error: [502, 'herdr socket transport failure', true],
  bridge_circuit_open: [503, 'tenant circuit breaker is open'],
  too_many_streams: [429, 'too many concurrent event streams for this tenant'],
  tenant_unavailable: [503, 'tenant herdr server is unreachable'],
};

export function bridgeError(code, message, extra = {}) {
  const [httpStatus, fallback, retryable = false] = defs[code] ?? [500, 'internal error'];
  return new BridgeError(code, message ?? fallback, { httpStatus, retryable, ...extra });
}

/** Map a herdr socket error payload to a bridge error. Socket-level denials
 *  (occupant pinning, binding) are never retried. */
export function fromSocketError(sockErr) {
  const code = sockErr?.code;
  if (code === 'occupant_changed') return bridgeError('occupant_changed');
  if (code === 'pane_not_found' || code === 'not_found') return bridgeError('pane_not_found');
  if (code === 'method_unsupported' || code === 'unknown_method') return bridgeError('method_unsupported');
  return bridgeError('transport_error', `herdr error: ${code ?? 'unknown'}`);
}
