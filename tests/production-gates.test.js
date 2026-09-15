import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertProductionReady, cloudflareServiceMode, isNamedOperatorId, accountsMatchOperator } from '../server/production-gates.mjs';

const origin = 'https://room.example.com';
const operator = 'idp-' + 'ab'.repeat(32);

test('ROOM_PRODUCTION unset does not force production', () => {
  const g = assertProductionReady({}, origin, { ship: false });
  assert.equal(g.production, false);
  assert.equal(g.providerAuth, null);
});

test('ROOM_PRODUCTION=1 requires a named local operator and ship:false', () => {
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1' }, origin, { ship: false }));
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ROOM_OPERATOR_ACCOUNT_ID: 'potter@trydemigod.com' }, origin, { ship: false }));
  assert.throws(() => assertProductionReady({ ROOM_PRODUCTION: '1', ROOM_OPERATOR_ACCOUNT_ID: 'c6a94a' }, origin, { ship: true }));
  const local = assertProductionReady({ ROOM_PRODUCTION: '1', ROOM_OPERATOR_ACCOUNT_ID: 'c6a94a' }, origin, { ship: false });
  assert.equal(local.production, true);
  assert.equal(local.operatorAccountId, 'c6a94a');
  assert.equal(local.providerAuth, null);
  const hashed = assertProductionReady({ ROOM_PRODUCTION: '1', ROOM_OPERATOR_ACCOUNT_ID: operator }, origin, { ship: false });
  assert.equal(hashed.production, true);
  assert.equal(cloudflareServiceMode(local.production), 'cloudflare-production');
  assert.equal(cloudflareServiceMode(false), 'cloudflare-staging');
});

test('named operator matches local account id or member suffix', () => {
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
  assert.match(src, /providerAuth: null/);
  assert.match(src, /googleAuth: googleConfig\(env, env\.ROOM_ORIGIN\)/);
  assert.doesNotMatch(src, /providerConfig/);
});
