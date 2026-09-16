import test from 'node:test';
import assert from 'node:assert/strict';
import { liveAudit, LIVE_ORIGIN, ROOM_DOOR } from '../scripts/live-audit.mjs';
import { GOOGLE_START_PATH, GOOGLE_CALLBACK_PATH, GOOGLE_SCOPES } from '../server/google-oauth.mjs';

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const liveDoor = `<a class="open" href="${LIVE_ORIGIN}">Join</a>`;
const stagingDoor = '<a class="open" href="https://project-room-staging.getdasha.workers.dev">Join</a>';
const liveHome = '<html><a id="skip-link" href="#auth-title">Skip</a><button>Continue with Google</button><button>Copy agent setup</button><noscript>JavaScript is required to open Project Room.</noscript></html>';

function header(init, name) {
  const headers = init?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || null;
}

function fetchRoutes(routes, doorHtml = liveDoor) {
  return async (url, init = {}) => {
    const href = String(url);
    if (href === ROOM_DOOR) return new Response(doorHtml, { status: 200 });
    if (href === `${ROOM_DOOR}/llms.txt` || href === `${ROOM_DOOR}/skill.md` || href === `${ROOM_DOOR}/AGENTS.md`) {
      return new Response(`origin ${LIVE_ORIGIN}\n`, { status: 200 });
    }
    const path = new URL(href).pathname;
    if ((init.method || 'GET') === 'POST' && path === '/mcp' && !Object.hasOwn(routes, 'POST /mcp')) {
      const originHdr = header(init, 'Origin');
      if (originHdr && originHdr !== LIVE_ORIGIN) return json(403, { error: { code: 'origin_denied' } });
      return json(200, { jsonrpc: '2.0' });
    }
    if ((path === '/llms.txt' || path === '/skill.md' || path === '/AGENTS.md' || path === '/llms-full.txt') && !Object.hasOwn(routes, path)) {
      return new Response(`origin ${LIVE_ORIGIN}\n`, { status: 200 });
    }
    if (path === '/agent.json' && !Object.hasOwn(routes, path)) return json(200, { name: 'Project Room' });
    if (path === '/' && !Object.hasOwn(routes, path)) return new Response(liveHome, { status: 200 });
    return routes[path] || new Response('missing', { status: 404 });
  };
}

test('liveAudit origin and Google start contract are the production Room host', () => {
  assert.equal(LIVE_ORIGIN, 'https://room.trydemigod.com');
  assert.equal(ROOM_DOOR, 'https://www.trydemigod.com/room');
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
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(item => item.code).sort(), ['google_scope', 'identity_unpublished', 'no_gmail_mailbox', 'ship']);
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
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test('liveAudit fails closed when the Demigod door Join still points at staging', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes, stagingDoor) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'door_not_staging'));
  assert.ok(result.failures.some(item => item.code === 'door_live_origin'));
});

test('liveAudit fails closed when /agent.json is missing', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 }),
    '/agent.json': new Response('missing', { status: 404 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'agent_json'));
});

test('liveAudit fails closed when Copy agent setup precedes Continue with Google', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/': new Response('<html><button>Copy agent setup</button><button>Continue with Google</button><noscript>JavaScript is required to open Project Room.</noscript></html>', { status: 200 }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'home_google_before_agent'));
});

test('liveAudit fails closed when MCP accepts a foreign Origin', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 }),
    'POST /mcp': true
  };
  const result = await liveAudit({
    fetchImpl: async (url, init) => {
      if ((init?.method || 'GET') === 'POST' && new URL(String(url)).pathname === '/mcp') {
        return json(200, { jsonrpc: '2.0', result: {} });
      }
      return fetchRoutes(routes)(url, init);
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'mcp_origin_denied'));
});

test('liveAudit fails closed when /privacy 403s Google Origin', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const base = fetchRoutes(routes);
  const result = await liveAudit({
    fetchImpl: async (url, init) => {
      if (new URL(String(url)).pathname === '/privacy' && header(init, 'Origin') === 'https://accounts.google.com') {
        return new Response('denied', { status: 403 });
      }
      return base(url, init);
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'privacy_google_origin'));
});

test('liveAudit fails closed when fetch throws or times out', async () => {
  const result = await liveAudit({
    timeoutMs: 20,
    fetchImpl: async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'fetch_unreachable'));
  assert.ok(result.failures.some(item => item.code === 'ship'));
});

test('liveAudit fails closed when skip-link does not target #auth-title', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/': new Response('<html><a id="skip-link" href="#access-key">Skip</a><button>Continue with Google</button><noscript>JavaScript is required to open Project Room.</noscript></html>', { status: 200 }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'home_skip_auth_title'));
});

test('liveAudit fails closed when connectionIdentityLine would not say Google sign-in', async () => {
  const location = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: '380132515029-abc.apps.googleusercontent.com',
    redirect_uri: LIVE_ORIGIN + GOOGLE_CALLBACK_PATH,
    scope: GOOGLE_SCOPES,
    code_challenge_method: 'S256'
  }).toString();
  const routes = {
    '/api/version': json(200, { status: 'ok', mode: 'cloudflare-production', sourceRevision: 'b'.repeat(40) }),
    '/api/open': json(200, { ship: false, persistence: 'none' }),
    '/api/auth-config': json(200, { provider: null }),
    [GOOGLE_START_PATH]: new Response('', { status: 302, headers: { Location: location } }),
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'identity_google'));
  assert.ok(result.failures.some(item => item.code === 'auth_provider'));
});

test('liveAudit fails closed when Details repeats Connecting on first paint', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/': new Response('<html><a id="skip-link" href="#auth-title">Skip</a><button>Continue with Google</button><noscript>JavaScript is required to open Project Room.</noscript><p id="connection-status">Connecting to room service…</p><p id="connection-explanation">Connecting to room service…</p></html>', { status: 200 }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'home_details_not_connecting'));
});

test('liveAudit fails closed when door llms.txt still names staging', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const base = fetchRoutes(routes);
  const result = await liveAudit({
    fetchImpl: async (url, init) => {
      if (String(url) === `${ROOM_DOOR}/llms.txt`) {
        return new Response('origin https://project-room-staging.getdasha.workers.dev\n', { status: 200 });
      }
      return base(url, init);
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'door_llms_not_staging'));
  assert.ok(result.failures.some(item => item.code === 'door_llms_origin'));
});

test('liveAudit fails closed when door skill.md still names staging', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const base = fetchRoutes(routes);
  const result = await liveAudit({
    fetchImpl: async (url, init) => {
      if (String(url) === `${ROOM_DOOR}/skill.md`) {
        return new Response('origin https://project-room-staging.getdasha.workers.dev\n', { status: 200 });
      }
      return base(url, init);
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'door_skill_not_staging'));
  assert.ok(result.failures.some(item => item.code === 'door_skill_origin'));
});

test('liveAudit fails closed when door AGENTS.md still names staging', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 })
  };
  const base = fetchRoutes(routes);
  const result = await liveAudit({
    fetchImpl: async (url, init) => {
      if (String(url) === `${ROOM_DOOR}/AGENTS.md`) {
        return new Response('origin https://project-room-staging.getdasha.workers.dev\n', { status: 200 });
      }
      return base(url, init);
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'door_agents_not_staging'));
  assert.ok(result.failures.some(item => item.code === 'door_agents_origin'));
});

test('liveAudit fails closed when origin /llms.txt still names staging', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 }),
    '/llms.txt': new Response('origin https://project-room-staging.getdasha.workers.dev\n', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'origin_llms_not_staging'));
  assert.ok(result.failures.some(item => item.code === 'origin_llms_origin'));
});

test('liveAudit fails closed when origin /skill.md still names staging', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 }),
    '/skill.md': new Response('origin https://project-room-staging.getdasha.workers.dev\n', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'origin_skill_not_staging'));
  assert.ok(result.failures.some(item => item.code === 'origin_skill_origin'));
});

test('liveAudit fails closed when origin /AGENTS.md still names staging', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 }),
    '/AGENTS.md': new Response('origin https://project-room-staging.getdasha.workers.dev\n', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'origin_agents_not_staging'));
  assert.ok(result.failures.some(item => item.code === 'origin_agents_origin'));
});

test('liveAudit fails closed when origin /llms-full.txt still names staging', async () => {
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
    '/privacy': new Response('Email is not the account key', { status: 200 }),
    '/api/ready': json(200, { status: 'ready' }),
    '/src/app.js': new Response('export {}', { status: 200 }),
    '/llms-full.txt': new Response('origin https://project-room-staging.getdasha.workers.dev\n', { status: 200 })
  };
  const result = await liveAudit({ fetchImpl: fetchRoutes(routes) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(item => item.code === 'origin_full_not_staging'));
  assert.ok(result.failures.some(item => item.code === 'origin_full_origin'));
});
