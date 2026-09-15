import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  googleLoginHandoff, formatGoogleLoginHandoff, parseGoogleLoginSecrets, applyGoogleLoginSecrets, ROOM_ORIGIN
} from '../scripts/google-login-activate.mjs';
import { GOOGLE_CALLBACK_PATH, GOOGLE_START_PATH } from '../server/google-oauth.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const clientId = '1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';

test('handoff pins the live origin, redirect, and OpenID scopes without mailbox access', () => {
  const handoff = googleLoginHandoff();
  assert.equal(handoff.origin, ROOM_ORIGIN);
  assert.equal(handoff.redirectUri, `${ROOM_ORIGIN}${GOOGLE_CALLBACK_PATH}`);
  assert.deepEqual(handoff.scopes, ['openid', 'email', 'profile']);
  assert.equal(handoff.scopes.includes('https://www.googleapis.com/auth/gmail.readonly'), false);
  const text = formatGoogleLoginHandoff(handoff);
  assert.match(text, /Authorized redirect URIs: https:\/\/room\.trydemigod\.com\/api\/auth\/google\/callback/);
  assert.match(text, /Authorized JavaScript origins: https:\/\/room\.trydemigod\.com/);
  assert.doesNotMatch(text, /GOCSPX|BEGIN |sk_live|pk_live/);
});

test('parseGoogleLoginSecrets refuses missing, partial, or HTTP configuration', () => {
  assert.throws(() => parseGoogleLoginSecrets({}), /Set ROOM_GOOGLE/);
  assert.throws(() => parseGoogleLoginSecrets({ ROOM_GOOGLE_CLIENT_ID: clientId }));
  const config = parseGoogleLoginSecrets({ ROOM_GOOGLE_CLIENT_ID: clientId, ROOM_GOOGLE_CLIENT_SECRET: 'GOCSPX-secret' });
  assert.equal(config.redirectUri, `${ROOM_ORIGIN}${GOOGLE_CALLBACK_PATH}`);
  assert.equal(config.issuer, 'https://accounts.google.com');
});

test('apply puts both Worker secrets and never returns the secret material', () => {
  const puts = [];
  const result = applyGoogleLoginSecrets({
    ROOM_GOOGLE_CLIENT_ID: clientId, ROOM_GOOGLE_CLIENT_SECRET: 'GOCSPX-secret'
  }, (name, value) => { puts.push({ name, value }); });
  assert.deepEqual(puts.map(item => item.name), ['ROOM_GOOGLE_CLIENT_ID', 'ROOM_GOOGLE_CLIENT_SECRET']);
  assert.equal(puts[0].value, clientId);
  assert.equal(result.provider, 'google');
  assert.equal(result.authorizationPath, GOOGLE_START_PATH);
  assert.equal(JSON.stringify(result).includes('GOCSPX'), false);
});

test('CLI prints the handoff and does not apply without --apply', () => {
  const out = spawnSync(process.execPath, [join(root, '../scripts/google-login-activate.mjs')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Authorized redirect URIs/);
  assert.doesNotMatch(out.stdout, /"applied": true/);
});
