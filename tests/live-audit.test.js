import test from 'node:test';
import assert from 'node:assert/strict';
import { liveAudit, LIVE_ORIGIN } from '../scripts/live-audit.mjs';
import { GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH, GOOGLE_SCOPES } from '../server/google-oauth.mjs';

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

test('liveAudit origin and Google start contract are the production Room host', () => {
  assert.equal(LIVE_ORIGIN, 'https://room.trydemigod.com');
  assert.equal(GOOGLE_START_PATH, '/api/auth/google/start');
});

test('liveAudit fails closed on ship:true or a mailbox Gmail scope', async () => {
  const routes = {
    '/api/version': json(200, { status: 'ok', mode: 'cloudflare-production', sourceRevision: 'a'.repeat(40) }),
    '/api/open': json(200, { ship: true, persistence: 'none' }),
    '/api/auth-config': json(200, { provider: 'google', authorizationPath: GOOGLE_START_PATH }),
    [GOOGLE_START_PATH]: new Response('', { status: 302, headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?client_id=1-abc.apps.googleusercontent.com&redirect_uri=${encodeURIComponent(LIVE_ORIGIN + GOOGLE_CALLBACK_PATH)}&scope=${encodeURIComponent(GOOGLE_SCOPES + ' https://www.googleapis.com/auth/gmail.readonly')}&code_challenge_method=S256` } }),
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/': new Response('<html></html>', { status: 200 })
  };
  const result = await liveAudit({
    fetchImpl: async url => routes[new URL(url).pathname] || new Response('missing', { status: 404 })
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(item => item.code).sort(), ['google_scope', 'no_gmail_mailbox', 'ship']);
});

test('liveAudit passes a correct unpublished Google host', async () => {
  const location = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: '380132515029-abc.apps.googleusercontent.com',
    redirect_uri: LIVE_ORIGIN + GOOGLE_CALLBACK_PATH,
    scope: GOOGLE_SCOPES,
    code_challenge_method: 'S256'
  }).toString();
  const routes = {
    '/api/version': json(200, { status: 'ok', mode: 'cloudflare-production', sourceRevision: 'b'.repeat(40) }),
    '/api/open': json(200, { ship: false, persistence: 'none' }),
    '/api/auth-config': json(200, { provider: 'google', authorizationPath: GOOGLE_START_PATH }),
    [GOOGLE_START_PATH]: new Response('', { status: 302, headers: { Location: location } }),
    '/privacy': new Response('Email is not the account key. Sign-in does not read your Gmail inbox.', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/': new Response('<html>Project Room</html>', { status: 200 })
  };
  const result = await liveAudit({
    fetchImpl: async url => routes[new URL(url).pathname] || new Response('missing', { status: 404 })
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});
