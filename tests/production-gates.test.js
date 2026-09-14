import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { assertProductionReady, cloudflareServiceMode, isNamedOperatorId, accountsMatchOperator } from '../server/production-gates.mjs';

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

test('ROOM_PRODUCTION=1 requires a named operator and ship:false; Clerk is optional', () => {
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1' }, origin, { ship: false }));
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ...clerk }, origin, { ship: false }));
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ROOM_OPERATOR_ACCOUNT_ID: 'potter@trydemigod.com' }, origin, { ship: false }));
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ...clerk, ROOM_OPERATOR_ACCOUNT_ID: operator }, origin, { ship: true }));
  const testKey = { ...clerk, ROOM_CLERK_PUBLISHABLE_KEY: 'pk_test_' + Buffer.from('clerk.example.com$').toString('base64') };
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ...testKey, ROOM_OPERATOR_ACCOUNT_ID: operator }, origin, { ship: false }));
  const g = assertProductionReady({ ROOM_PRODUCTION: '1', ...clerk, ROOM_OPERATOR_ACCOUNT_ID: operator }, origin, { ship: false });
  assert.equal(g.production, true);
  assert.equal(g.operatorAccountId, operator);
  assert.equal(g.providerAuth.issuer, issuer);
  const local = assertProductionReady({ ROOM_PRODUCTION: '1', ROOM_OPERATOR_ACCOUNT_ID: 'c6a94a' }, origin, { ship: false });
  assert.equal(local.production, true);
  assert.equal(local.operatorAccountId, 'c6a94a');
  assert.equal(local.providerAuth, null);
  assert.equal(cloudflareServiceMode(g.production), 'cloudflare-production');
  assert.equal(cloudflareServiceMode(false), 'cloudflare-staging');
});

test('named operator matches Clerk idp, local account id, or member suffix', () => {
  assert.equal(isNamedOperatorId(operator), true);
  assert.equal(isNamedOperatorId('c6a94a'), true);
  assert.equal(isNamedOperatorId('potter@trydemigod.com'), false);
  assert.equal(accountsMatchOperator('acct-local', 'member-xxc6a94a', 'c6a94a'), true);
  assert.equal(accountsMatchOperator('acct-local', 'member-xxc6a94a', 'acct-local'), true);
  assert.equal(accountsMatchOperator('acct-other', 'member-xxffffff', 'c6a94a'), false);
});

test('Cloudflare Worker wires serviceMode from productionGates.production', () => {
  const src = readFileSync(new URL('../cloudflare/room.mjs', import.meta.url), 'utf8');
  assert.match(src, /serviceMode: cloudflareServiceMode\(productionGates\.production\)/);
});
