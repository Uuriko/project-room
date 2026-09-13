import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createClerkVerifier } from '../server/clerk-verifier.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://instance.clerk.accounts.dev', origin = 'http://localhost:3000';
const claims = { iss: issuer, azp: origin, sub: 'user_alice', sid: 'sess_one', iat: 1000, nbf: 1000, exp: 1060 };
const token = (body = claims, header = { alg: 'RS256', typ: 'JWT' }, key = keys.privateKey) => {
  const input = [header, body].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
};
const verify = createClerkVerifier({ issuer, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), authorizedParties: [origin], now: () => 1030000 });
test('pinned Clerk verifier accepts valid RS256 session assertions', async () => {
  assert.deepEqual(await verify(token()), claims);
});
test('provider assertions reject wrong origin, issuer, timing, pending status and algorithm', async () => {
  for (const patch of [{ iss: 'https://other.example' }, { azp: 'https://other.example' }, { azp: null }, { exp: 1030 },
    { nbf: 1031 }, { iat: 1031 }, { exp: 5000 }, { sts: 'pending' }, { sub: 'owner' }, { sid: null }]) {
    await assert.rejects(verify(token({ ...claims, ...patch })), { code: 'invalid_provider_token' });
  }
  for (const patch of [{ alg: 'none' }, { alg: 'HS256' }, { jku: 'https://attacker.example' }, { crit: ['x'] }]) {
    await assert.rejects(verify(token(claims, { alg: 'RS256', typ: 'JWT', ...patch })), { code: 'invalid_provider_token' });
  }
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verify(token(claims, undefined, other.privateKey)), { code: 'invalid_provider_token' });
  await assert.rejects(verify('bad.token.value'), { code: 'invalid_provider_token' });
});
