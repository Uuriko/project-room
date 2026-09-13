import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { providerConfig, publicProviderConfig } from '../server/provider-config.mjs';

const issuer = 'https://clerk.example.com', origin = 'https://room.example.com';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { ROOM_CLERK_ISSUER: issuer,
  ROOM_CLERK_PUBLISHABLE_KEY: 'pk_live_' + Buffer.from('clerk.example.com$').toString('base64'),
  ROOM_CLERK_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }) };

test('provider config is opt-in and exposes only public browser settings', () => {
  assert.equal(providerConfig({}, origin), null);
  const config = providerConfig(env, origin);
  assert.deepEqual(config.authorizedParties, [origin]);
  assert.deepEqual(publicProviderConfig(config), { provider: 'clerk', issuer, publishableKey: env.ROOM_CLERK_PUBLISHABLE_KEY });
  assert.deepEqual(publicProviderConfig(null), { provider: null });
  assert.equal(JSON.stringify(publicProviderConfig(config)).includes('PUBLIC KEY'), false);
});

test('partial, cross-issuer, insecure and test-production configuration fails startup', () => {
  for (const patch of [
    { ROOM_CLERK_ISSUER: undefined }, { ROOM_CLERK_PUBLIC_KEY: '' },
    { ROOM_CLERK_ISSUER: 'http://clerk.example.com' }, { ROOM_CLERK_ISSUER: issuer + '/' },
    { ROOM_CLERK_ISSUER: 'https://other.example.com' },
    { ROOM_CLERK_PUBLISHABLE_KEY: env.ROOM_CLERK_PUBLISHABLE_KEY.replace('pk_live', 'pk_test') },
    { ROOM_CLERK_PUBLISHABLE_KEY: 'sk_live_secret' }, { ROOM_CLERK_PUBLIC_KEY: 'bad-key' }
  ]) assert.throws(() => providerConfig({ ...env, ...patch }, origin));
  for (const badOrigin of ['http://room.example.com', origin + '/path', 'https://user:pass@room.example.com'])
    assert.throws(() => providerConfig(env, badOrigin));
  assert.ok(providerConfig({ ...env, ROOM_CLERK_PUBLISHABLE_KEY: env.ROOM_CLERK_PUBLISHABLE_KEY.replace('pk_live', 'pk_test') }, 'http://127.0.0.1:4173'));
});
