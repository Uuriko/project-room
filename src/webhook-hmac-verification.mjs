/**
 * webhook-hmac-verification.mjs — Pure HMAC-SHA256 verifier for inbound webhooks.
 *
 * Verifies that an inbound webhook request really came from the expected sender
 * by recomputing HMAC-SHA256 over the raw request body and comparing it, in
 * constant time, against the signature presented in the request headers.
 *
 * Pure crypto: NO network, NO DOM. Signing secrets arrive ONLY through the
 * injected `secretProvider` — they are never hardcoded, never logged, and
 * never included in any error message or detail object.
 *
 * Dependency injection (all via the `deps` parameter of
 * createWebhookHmacVerifier):
 *   - clock:            () => number  (ms epoch; default: Date.now)
 *   - secretProvider:   (secretId: string) => string | null | undefined
 *                       Resolve the HMAC secret for a secretId. Return
 *                       null/undefined (or throw) for an unknown id. REQUIRED.
 *   - signatureHeader:  string        (default: 'x-room-signature')
 *   - timestampHeader:  string        (default: 'x-room-timestamp')
 *   - secretIdHeader:   string        (default: 'x-room-secret-id')
 *   - maxSkewMs:        number        (timestamp skew window; default: 5 min)
 *   - seenStore:        { has(hash) => boolean, add(hash, expiresAt) }
 *                       Replay guard. Default: in-memory store pruned on read.
 *
 * Verification of verify({ rawBody, headers, secretId? }):
 *   1. Extract the signature header (HV_MISSING_HEADER).
 *   2. Parse 'sha256=<hex>' (HV_MALFORMED_SIGNATURE).
 *   3. Resolve the secret via secretProvider(secretId) (HV_UNKNOWN_SECRET).
 *   4. If the timestamp header is present, check it against the skew window
 *      (HV_MALFORMED_TIMESTAMP, HV_STALE_TIMESTAMP, HV_FUTURE_TIMESTAMP).
 *   5. Constant-time compare HMAC-SHA256(rawBody, secret) with the presented
 *      signature (HV_BAD_SIGNATURE).
 *   6. Replay guard: a signature seen within the skew window is rejected
 *      (HV_REPLAY), otherwise it is recorded.
 *
 * Success returns { ok: true, secretId, timestamp } (timestamp is null when no
 * timestamp header was presented). Every failure throws an Error with a `code`
 * property. Failures are never silent.
 *
 * Error contract:
 *   HV_MISSING_HEADER      — signature header absent
 *   HV_MALFORMED_SIGNATURE — signature header not in 'sha256=<hex>' form
 *   HV_MISSING_BODY        — rawBody missing or not a string/Buffer
 *   HV_UNKNOWN_SECRET      — secretProvider returned no secret for the id
 *   HV_MALFORMED_TIMESTAMP — timestamp header not a number
 *   HV_STALE_TIMESTAMP     — timestamp older than clock() - maxSkewMs
 *   HV_FUTURE_TIMESTAMP    — timestamp newer than clock() + maxSkewMs
 *   HV_BAD_SIGNATURE       — HMAC does not match (constant-time compare)
 *   HV_REPLAY              — this exact signature was already verified recently
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const DEFAULT_SIGNATURE_HEADER = 'x-room-signature';
export const DEFAULT_TIMESTAMP_HEADER = 'x-room-timestamp';
export const DEFAULT_SECRET_ID_HEADER = 'x-room-secret-id';
export const DEFAULT_SECRET_ID = 'default';
export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;

/** Throw a coded verifier error. Secrets are never included in message/detail. */
function hmacError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Normalize a headers object to lowercase keys for case-insensitive lookup. */
function normalizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers)) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

/** Parse a signature header of the form 'sha256=<hex>'. Returns the hex part. */
function parseSignatureHeader(value, headerName) {
  if (value === undefined || value === null || value === '') {
    throw hmacError(
      'HV_MISSING_HEADER',
      `Missing signature header '${headerName}'`,
      { header: headerName },
    );
  }
  const text = String(value);
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(text.trim());
  if (!match) {
    throw hmacError(
      'HV_MALFORMED_SIGNATURE',
      `Malformed signature header '${headerName}': expected 'sha256=<hex>'`,
      { header: headerName },
    );
  }
  return match[1].toLowerCase();
}

/** Parse the optional timestamp header. Accepts epoch ms or epoch seconds. */
function parseTimestampHeader(value, headerName) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw hmacError(
      'HV_MALFORMED_TIMESTAMP',
      `Malformed timestamp header '${headerName}': not a number`,
      { header: headerName },
    );
  }
  // Heuristic: values below 1e12 are epoch seconds; at/above are epoch ms.
  return num < 1e12 ? num * 1000 : num;
}

/**
 * Constant-time comparison of two hex strings. Length mismatches fail too,
 * but run through timingSafeEqual on a dummy pair so the failure path is not
 * observably cheaper than the success path.
 */
function constantTimeHexEqual(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Default in-memory replay store: remembers signature hashes until expiry. */
function createMemorySeenStore(clock) {
  const seen = new Map(); // signatureHash -> expiresAt
  function prune(now) {
    for (const [hash, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(hash);
    }
  }
  return {
    has(signatureHash) {
      prune(clock());
      return seen.has(signatureHash);
    },
    add(signatureHash, expiresAt) {
      prune(clock());
      seen.set(signatureHash, expiresAt);
    },
  };
}

/**
 * Create a webhook HMAC verifier.
 * @param {object} deps
 * @param {() => number} [deps.clock]
 * @param {(secretId: string) => (string | null | undefined)} deps.secretProvider
 * @param {string} [deps.signatureHeader]
 * @param {string} [deps.timestampHeader]
 * @param {string} [deps.secretIdHeader]
 * @param {number} [deps.maxSkewMs]
 * @param {{ has(hash: string): boolean, add(hash: string, expiresAt: number): void }} [deps.seenStore]
 */
export function createWebhookHmacVerifier(deps = {}) {
  if (typeof deps.secretProvider !== 'function') {
    throw hmacError(
      'HV_UNKNOWN_SECRET',
      'secretProvider is required: pass deps.secretProvider(secretId) => secret',
      { detail: 'missing secretProvider' },
    );
  }
  const clock = deps.clock ?? (() => Date.now());
  const secretProvider = deps.secretProvider;
  const signatureHeader = deps.signatureHeader ?? DEFAULT_SIGNATURE_HEADER;
  const timestampHeader = deps.timestampHeader ?? DEFAULT_TIMESTAMP_HEADER;
  const secretIdHeader = deps.secretIdHeader ?? DEFAULT_SECRET_ID_HEADER;
  const maxSkewMs = deps.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  const seenStore = deps.seenStore ?? createMemorySeenStore(clock);

  /**
   * Verify one inbound webhook delivery.
   * @param {object} args
   * @param {string | Buffer} args.rawBody  The raw request body bytes.
   * @param {object} args.headers           Request headers (any case).
   * @param {string} [args.secretId]        Which secret to use (defaults to
   *                                        the secret-id header, then 'default').
   * @returns {{ ok: true, secretId: string, timestamp: number | null }}
   * @throws {Error} with a `code` property on any failure.
   */
  function verify({ rawBody, headers, secretId } = {}) {
    if (rawBody === undefined || rawBody === null || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) {
      throw hmacError(
        'HV_MISSING_BODY',
        'rawBody is required: must be the raw request body string or Buffer',
      );
    }

    const normalized = normalizeHeaders(headers);

    // 1+2. Extract and parse the signature header.
    const signatureHex = parseSignatureHeader(normalized[signatureHeader.toLowerCase()], signatureHeader);

    // 3. Resolve the signing secret. The secret value never leaves this scope.
    const resolvedId = secretId ?? normalized[secretIdHeader.toLowerCase()] ?? DEFAULT_SECRET_ID;
    let secret;
    try {
      secret = secretProvider(resolvedId);
    } catch {
      secret = undefined;
    }
    if (secret === undefined || secret === null || secret === '') {
      throw hmacError(
        'HV_UNKNOWN_SECRET',
        `Unknown webhook secret id '${resolvedId}'`,
        { secretId: resolvedId },
      );
    }

    // 4. Optional timestamp window check.
    let timestamp = null;
    const timestampValue = normalized[timestampHeader.toLowerCase()];
    if (timestampValue !== undefined && timestampValue !== null && timestampValue !== '') {
      timestamp = parseTimestampHeader(timestampValue, timestampHeader);
      const now = clock();
      if (timestamp < now - maxSkewMs) {
        throw hmacError(
          'HV_STALE_TIMESTAMP',
          `Webhook timestamp is stale (outside ${maxSkewMs}ms skew window)`,
          { maxSkewMs },
        );
      }
      if (timestamp > now + maxSkewMs) {
        throw hmacError(
          'HV_FUTURE_TIMESTAMP',
          `Webhook timestamp is in the future (outside ${maxSkewMs}ms skew window)`,
          { maxSkewMs },
        );
      }
    }

    // 5. Constant-time HMAC comparison.
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const expectedHex = createHmac('sha256', secret).update(body).digest('hex');
    if (!constantTimeHexEqual(expectedHex, signatureHex)) {
      throw hmacError(
        'HV_BAD_SIGNATURE',
        'Webhook signature does not match (HMAC-SHA256 mismatch)',
        { header: signatureHeader },
      );
    }

    // 6. Replay guard — only checked after the signature proves authentic.
    const signatureHash = createHash('sha256').update(signatureHex).digest('hex');
    if (seenStore.has(signatureHash)) {
      throw hmacError(
        'HV_REPLAY',
        'Webhook signature was already used (replay detected)',
        { header: signatureHeader },
      );
    }
    seenStore.add(signatureHash, clock() + maxSkewMs);

    return { ok: true, secretId: resolvedId, timestamp };
  }

  return Object.freeze({ verify });
}

export { createMemorySeenStore };
