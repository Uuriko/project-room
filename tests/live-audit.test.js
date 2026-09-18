import test from 'node:test';
import assert from 'node:assert/strict';
import { liveAudit, LIVE_ORIGIN, PHANTOM_ROUTES } from '../scripts/live-audit.mjs';
import { GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH, GOOGLE_SCOPES } from '../server/google-oauth.mjs';

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// Fixtures must mirror the real server surface (server/http.mjs): the
// phantom routes below return 404 because they do not exist, exactly like
// production. Inventing 200s for them here is what let the old audit pass
// against fixtures while crying wolf on every deploy (task #15).
const phantom404 = () => Object.fromEntries(PHANTOM_ROUTES.map(path => [path, json(404, { status: 404, code: 'not_found' })]));

test('liveAudit origin and Google start contract are the production Room host', () => {
  assert.equal(LIVE_ORIGIN, 'https://room.trydemigod.com');
  assert.equal(GOOGLE_START_PATH, '/api/auth/google/start');
});

test('phantom routes are the retired guard targets, never real API paths', () => {
  assert.deepEqual(PHANTOM_ROUTES, ['/api/open', '/api/auth-config', '/privacy']);
});

test('liveAudit fails closed on a phantom route that starts serving', async () => {
  const routes = {
    '/api/version': json(200, { status: 'ok', mode: 'cloudflare-production', sourceRevision: 'a'.repeat(40) }),
    // /api/open resurrecting with a body: route-surface drift must fail loudly.
    ...phantom404(),
    '/api/open': json(200, { ship: false, persistence: 'none' }),
    [GOOGLE_START_PATH]: new Response('', { status: 302, headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?client_id=1-abc.apps.googleusercontent.com&redirect_uri=${encodeURIComponent(LIVE_ORIGIN + GOOGLE_CALLBACK_PATH)}&scope=${encodeURIComponent(GOOGLE_SCOPES + ' https://www.googleapis.com/auth/gmail.readonly')}&code_challenge_method=S256` } }),
    '/api/ready': json(200, { status: 'ready' }),
    '/': new Response('<html></html>', { status: 200 })
  };
  const result = await liveAudit({
    fetchImpl: async url => routes[new URL(url).pathname] || new Response('missing', { status: 404 })
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(item => item.code).sort(), ['google_scope', 'no_gmail_mailbox', 'phantom_route']);
  assert.ok(result.failures.find(item => item.code === 'phantom_route').detail.includes('/api/open'));
});

test('liveAudit passes a correct unpublished Google host with honest 404s', async () => {
  const location = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: '380132515029-abc.apps.googleusercontent.com',
    redirect_uri: LIVE_ORIGIN + GOOGLE_CALLBACK_PATH,
    scope: GOOGLE_SCOPES,
    code_challenge_method: 'S256'
  }).toString();
  const routes = {
    '/api/version': json(200, { status: 'ok', mode: 'cloudflare-production', sourceRevision: 'b'.repeat(40) }),
    ...phantom404(),
    [GOOGLE_START_PATH]: new Response('', { status: 302, headers: { Location: location } }),
    '/api/ready': json(200, { status: 'ready' }),
    '/': new Response('<html>Project Room</html>', { status: 200 })
  };
  const result = await liveAudit({
    fetchImpl: async url => routes[new URL(url).pathname] || new Response('missing', { status: 404 })
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});
