import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { assertProductionReady, cloudflareServiceMode } from '../server/production-gates.mjs';

const issuer = 'https://clerk.example.com', origin = 'https://room.example.com';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const clerk = {
  ROOM_CLERK_ISSUER: issuer,
  ROOM_CLERK_PUBLISHABLE_KEY: 'pk_live_' + Buffer.from('clerk.example.com$').toString('base64'),
  ROOM_CLERK_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' })
};
const operator = 'idp-' + 'ab'.repeat(32);

test('ROOM_PRODUCTION unset still allows missing Clerk', () => {
  const g = assertProductionReady({}, origin, { ship: false });
  assert.equal(g.production, false);
  assert.equal(g.providerAuth, null);
});

test('ROOM_PRODUCTION=1 requires Clerk, operator idp, and ship:false', () => {
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1' }, origin, { ship: false }));
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ...clerk }, origin, { ship: false }));
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ...clerk, ROOM_OPERATOR_ACCOUNT_ID: 'email-john' }, origin, { ship: false }));
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ...clerk, ROOM_OPERATOR_ACCOUNT_ID: operator }, origin, { ship: true }));
  const testKey = { ...clerk, ROOM_CLERK_PUBLISHABLE_KEY: 'pk_test_' + Buffer.from('clerk.example.com$').toString('base64') };
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ...testKey, ROOM_OPERATOR_ACCOUNT_ID: operator }, origin, { ship: false }));
  const g = assertProductionReady({ ROOM_PRODUCTION: '1', ...clerk, ROOM_OPERATOR_ACCOUNT_ID: operator }, origin, { ship: false });
  assert.equal(g.production, true);
  assert.equal(g.operatorAccountId, operator);
  assert.equal(g.providerAuth.issuer, issuer);
  assert.equal(cloudflareServiceMode(g.production), 'cloudflare-production');
  assert.equal(cloudflareServiceMode(false), 'cloudflare-staging');
});

test('Cloudflare Worker wires serviceMode from productionGates.production', () => {
  const src = readFileSync(new URL('../cloudflare/room.mjs', import.meta.url), 'utf8');
  assert.match(src, /serviceMode: cloudflareServiceMode\(productionGates\.production\)/);
});
