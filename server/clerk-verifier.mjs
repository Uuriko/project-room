import { createPublicKey, verify } from 'node:crypto';
import { ServiceError } from './store.mjs';

// A pinned public key avoids trusting token-supplied key URLs or issuer discovery.
// Key rotation is explicit configuration, not a fallback to an untrusted key.
export function createClerkVerifier({ issuer, publicKey, authorizedParties, now = Date.now }) {
  if (new URL(issuer).origin !== issuer || !issuer.startsWith('https://') || !Array.isArray(authorizedParties)
    || !authorizedParties.length || authorizedParties.some(origin => new URL(origin).origin !== origin)) throw new Error('invalid_clerk_configuration');
  const key = createPublicKey(publicKey), origins = new Set(authorizedParties);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('invalid_clerk_public_key');
  return async token => {
    try {
      if (typeof token !== 'string' || token.length > 16384) throw Error();
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw Error();
      const decode = part => {
        const bytes = Buffer.from(part, 'base64url');
        if (bytes.toString('base64url') !== part) throw Error();
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      };
      const header = decode(parts[0]);
      if (header?.alg !== 'RS256' || header.typ !== 'JWT' || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined) throw Error();
      if (!verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw Error();
      const claims = decode(parts[1]), seconds = Math.floor(now() / 1000);
      if (claims?.iss !== issuer || !origins.has(claims.azp) || claims.sts === 'pending'
        || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.nbf) || !Number.isSafeInteger(claims.iat)
        || claims.exp <= seconds || claims.nbf > seconds || claims.iat > seconds || claims.exp <= claims.iat
        || claims.exp - claims.iat > 3600 || typeof claims.sub !== 'string' || !/^user_[A-Za-z0-9]{1,100}$/.test(claims.sub)
        || typeof claims.sid !== 'string' || !/^sess_[A-Za-z0-9]{1,100}$/.test(claims.sid)) throw Error();
      return claims;
    } catch { throw new ServiceError(401, 'invalid_provider_token', 'Sign-in could not be verified'); }
  };
}
