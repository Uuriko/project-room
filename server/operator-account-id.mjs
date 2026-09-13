import { createHash } from 'node:crypto';

// Identity is issuer+sub, never email. Same digest loginWithProvider persists.
export function providerAccountId(issuer, sub) {
  if (typeof issuer !== 'string' || issuer.length > 256) throw new Error('issuer required');
  let origin;
  try { origin = new URL(issuer); } catch { throw new Error('issuer must be an https origin'); }
  if (origin.origin !== issuer || origin.protocol !== 'https:') throw new Error('issuer must be an https origin');
  if (typeof sub !== 'string' || !/^user_[A-Za-z0-9]{1,100}$/.test(sub)) throw new Error('sub must be a Clerk user_ id');
  return `idp-${createHash('sha256').update(JSON.stringify([issuer, sub])).digest('hex')}`;
}
