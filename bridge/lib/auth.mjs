/**
 * bridge/lib/auth.mjs — bearer-per-tenant auth, HMAC-derived.
 *
 * Token for tenant T on host H:
 *   base64url( HMAC-SHA256( master_H, "herdr-bridge-v1:" + tenantId ) )
 *
 * The bridge re-derives the token for every configured tenant and compares
 * with constant-time equality. The tenant identity is resolved FROM the
 * verified token — caller-supplied tenant fields are never trusted.
 * The `X-Bridge-Key-Id` header names which master generation is in use so the
 * bridge can hold current+previous during rotation without trial-decrypting.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { bridgeError } from './errors.mjs';

export const TOKEN_LABEL = 'herdr-bridge-v1:';
export const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateTenantId(id) {
  if (typeof id !== 'string' || !TENANT_ID_RE.test(id)) {
    throw bridgeError('input', `invalid tenant id`);
  }
  return id;
}

export function deriveToken(masterSecret, tenantId) {
  return createHmac('sha256', masterSecret)
    .update(TOKEN_LABEL + tenantId, 'utf8')
    .digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Resolve the tenant from a presented bearer token.
 * @param {object} opts
 * @param {string[]} opts.tenantIds - configured tenant ids
 * @param {string} opts.masterSecret - current generation master
 * @param {string} [opts.masterSecretPrev] - previous generation (rotation window)
 * @param {string} opts.keyId - current generation id (BRIDGE_KEY_ID)
 * @param {string} [opts.keyIdPrev] - previous generation id
 * @param {string} opts.presentedKeyId - X-Bridge-Key-Id header value
 * @param {string} opts.token - presented bearer token
 * @returns {string} tenantId
 * @throws BridgeError(auth_denied)
 */
export function resolveTenant({ tenantIds, masterSecret, masterSecretPrev, keyId, keyIdPrev, presentedKeyId, token }) {
  if (!masterSecret) throw bridgeError('server_misconfigured', 'BRIDGE_MASTER_SECRET is not set');
  if (!presentedKeyId) throw bridgeError('auth_denied', 'missing X-Bridge-Key-Id');
  let secret;
  if (presentedKeyId === keyId) secret = masterSecret;
  else if (masterSecretPrev && keyIdPrev && presentedKeyId === keyIdPrev) secret = masterSecretPrev;
  else throw bridgeError('auth_denied', 'unknown bridge key id');
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
    throw bridgeError('auth_denied', 'malformed bearer token');
  }
  for (const tenantId of tenantIds) {
    if (safeEqual(deriveToken(secret, tenantId), token)) return tenantId;
  }
  throw bridgeError('auth_denied', 'bearer token did not match any tenant');
}
