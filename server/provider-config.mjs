import { createClerkVerifier } from './clerk-verifier.mjs';

// Explicit opt-in. Partial/mismatched settings must fail startup, never silently
// downgrade a configured account login to a different authentication mode.
export function providerConfig(env, origin) {
  const issuer = env.ROOM_CLERK_ISSUER;
  const publishableKey = env.ROOM_CLERK_PUBLISHABLE_KEY;
  const publicKey = env.ROOM_CLERK_PUBLIC_KEY;
  if ([issuer, publishableKey, publicKey].every(value => value === undefined)) return null;
  const invalid = () => { throw new Error('Invalid Room authentication configuration'); };
  if ([issuer, publishableKey, publicKey].some(value => typeof value !== 'string' || !value)) invalid();
  let issuerUrl, appUrl;
  try { issuerUrl = new URL(issuer); appUrl = new URL(origin); } catch { invalid(); }
  if (issuerUrl.origin !== issuer || issuerUrl.protocol !== 'https:' || appUrl.origin !== origin
    || !['http:', 'https:'].includes(appUrl.protocol)) invalid();
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname);
  if (!loopback && appUrl.protocol !== 'https:') invalid();
  const match = /^pk_(live|test)_([A-Za-z0-9+/]+={0,2})$/.exec(publishableKey);
  if (!match || (match[1] === 'test' && !loopback)) invalid();
  const decoded = Buffer.from(match[2], 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')
    || decoded.toString('utf8') !== `${issuerUrl.host}$`) invalid();
  const config = { issuer, publishableKey, publicKey, authorizedParties: [origin] };
  // Validate pinned key strength before opening a socket or accepting requests.
  createClerkVerifier(config);
  return config;
}

export function publicProviderConfig(config, google = null) {
  if (google?.clientId) {
    return { provider: 'google', authorizationPath: '/api/auth/google/start' };
  }
  return config?.publishableKey
    ? { provider: 'clerk', issuer: config.issuer, publishableKey: config.publishableKey }
    : { provider: null };
}
