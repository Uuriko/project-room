import { pathToFileURL } from 'node:url';
import { GOOGLE_CALLBACK_PATH, GOOGLE_START_PATH, GOOGLE_SCOPES } from '../server/google-oauth.mjs';
import { connectionIdentityLine } from '../src/client.js';

export const LIVE_ORIGIN = 'https://room.trydemigod.com';
export const ROOM_DOOR = 'https://www.trydemigod.com/room';

export async function liveAudit({ origin = LIVE_ORIGIN, door = ROOM_DOOR, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const failures = [];
  const note = (ok, code, detail) => { if (!ok) failures.push({ code, detail }); };
  const timedFetch = async (url, init = {}) => {
    try {
      return await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    } catch {
      note(false, 'fetch_unreachable', String(url));
      return new Response('unreachable', { status: 599 });
    }
  };
  const get = async path => {
    const res = await timedFetch(origin + path, { redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { res, text, json };
  };

  const version = await get('/api/version');
  note(version.json?.mode === 'cloudflare-production', 'version_mode', version.json?.mode);
  note(typeof version.json?.sourceRevision === 'string' && version.json.sourceRevision.length === 40, 'version_sha', version.json?.sourceRevision);

  const open = await get('/api/open');
  note(open.json?.ship === false, 'ship', open.json?.ship);
  note(open.json?.persistence === 'none', 'persistence', open.json?.persistence);

  const auth = await get('/api/auth-config');
  note(auth.json?.provider === 'google', 'auth_provider', auth.json?.provider);
  note(auth.json?.authorizationPath === GOOGLE_START_PATH, 'auth_path', auth.json?.authorizationPath);
  note(!auth.json?.publishableKey, 'no_browser_sdk_key', auth.json?.publishableKey);
  const identity = connectionIdentityLine(version.json || {}, open.json || {}, auth.json || {});
  note(identity.includes('unpublished walk-in'), 'identity_unpublished', identity);
  note(identity.includes('Google sign-in'), 'identity_google', identity);

  const start = await get(GOOGLE_START_PATH);
  const location = start.res.headers.get('location') || '';
  let startUrl;
  try { startUrl = new URL(location); } catch { startUrl = null; }
  note(start.res.status === 302, 'google_start_status', start.res.status);
  note(startUrl?.origin === 'https://accounts.google.com' && startUrl.pathname === '/o/oauth2/v2/auth', 'google_start_host', location.slice(0, 120));
  note(Boolean(startUrl?.searchParams.get('client_id')?.endsWith('.apps.googleusercontent.com')), 'google_client_id', 'missing');
  note(startUrl?.searchParams.get('redirect_uri') === origin + GOOGLE_CALLBACK_PATH, 'google_redirect', startUrl?.searchParams.get('redirect_uri'));
  note(startUrl?.searchParams.get('scope') === GOOGLE_SCOPES, 'google_scope', startUrl?.searchParams.get('scope'));
  note(startUrl?.searchParams.get('code_challenge_method') === 'S256', 'google_pkce', startUrl?.searchParams.get('code_challenge_method'));
  note(!location.includes('gmail.readonly'), 'no_gmail_mailbox', 'gmail.readonly present');

  const privacy = await get('/privacy');
  note(privacy.res.status === 200, 'privacy_status', privacy.res.status);
  note(/Email is not the account key/.test(privacy.text), 'privacy_copy', 'missing account-key sentence');
  note(!/gmail\.readonly/.test(privacy.text), 'privacy_no_mailbox_scope', 'gmail.readonly');
  const privacyGoogle = await timedFetch(origin + '/privacy', {
    redirect: 'manual',
    headers: { Origin: 'https://accounts.google.com' }
  });
  note(privacyGoogle.status === 200, 'privacy_google_origin', privacyGoogle.status);

  const ready = await get('/api/ready');
  note(ready.res.status === 200 && ready.json?.status === 'ready', 'ready', ready.res.status);

  const home = await get('/');
  note(home.res.status === 200, 'home', home.res.status);
  note(!/clerk\.browser\.js|@clerk\/clerk-js/.test(home.text), 'home_no_clerk_sdk', 'clerk sdk');
  const googleAt = home.text.indexOf('Continue with Google');
  const agentAt = home.text.indexOf('Copy agent setup');
  note(googleAt >= 0 && (agentAt === -1 || agentAt > googleAt), 'home_google_before_agent', 'Copy agent setup precedes Google');
  note(home.text.includes('JavaScript is required to open Project Room'), 'home_noscript', 'missing noscript');
  note(/id="skip-link"[^>]*href="#auth-title"|href="#auth-title"[^>]*id="skip-link"/.test(home.text), 'home_skip_auth_title', 'skip-link missing #auth-title');
  note(!/id="connection-explanation">Connecting to room service/.test(home.text), 'home_details_not_connecting', 'Details duplicates Connecting');

  const app = await get('/src/app.js');
  note(app.res.status === 200, 'app_js', app.res.status);
  const browserImports = [...app.text.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)].map(match => {
    const relative = match[1].startsWith('./') ? match[1].slice(2) : match[1];
    return '/src/' + relative.replace(/^\.\.\//, '');
  });
  for (const path of browserImports) {
    const asset = await get(path);
    note(asset.res.status === 200, 'app_import', `${path} ${asset.res.status}`);
  }

  const originPacket = await get('/llms.txt');
  note(originPacket.res.status === 200, 'origin_llms_status', originPacket.res.status);
  note(originPacket.text.includes(`origin ${origin}`), 'origin_llms_origin', originPacket.text.slice(0, 120));
  note(!/project-room-staging/.test(originPacket.text), 'origin_llms_not_staging', 'staging origin in /llms.txt');
  const originSkill = await get('/skill.md');
  note(originSkill.res.status === 200, 'origin_skill_status', originSkill.res.status);
  note(originSkill.text.includes(`origin ${origin}`), 'origin_skill_origin', originSkill.text.slice(0, 120));
  note(!/project-room-staging/.test(originSkill.text), 'origin_skill_not_staging', 'staging origin in /skill.md');
  const originAgents = await get('/AGENTS.md');
  note(originAgents.res.status === 200, 'origin_agents_status', originAgents.res.status);
  note(originAgents.text.includes(`origin ${origin}`), 'origin_agents_origin', originAgents.text.slice(0, 120));
  note(!/project-room-staging/.test(originAgents.text), 'origin_agents_not_staging', 'staging origin in /AGENTS.md');

  const card = await get('/agent.json');
  note(card.res.status === 200, 'agent_json', card.res.status);
  note(card.json?.name === 'Project Room', 'agent_json_name', card.json?.name);

  const doorRes = await timedFetch(door, { redirect: 'manual' });
  const doorHtml = await doorRes.text();
  note(doorRes.status === 200, 'door_status', doorRes.status);
  note(doorHtml.includes(origin), 'door_live_origin', origin);
  note(!/project-room-staging/.test(doorHtml), 'door_not_staging', 'staging Join href');
  const llmsUrl = String(door).replace(/\/$/, '') + '/llms.txt';
  const llmsRes = await timedFetch(llmsUrl, { redirect: 'manual' });
  const llmsText = await llmsRes.text();
  note(llmsRes.status === 200, 'door_llms_status', llmsRes.status);
  note(llmsText.includes(`origin ${origin}`), 'door_llms_origin', llmsText.slice(0, 120));
  note(!/project-room-staging/.test(llmsText), 'door_llms_not_staging', 'staging origin in llms.txt');
  const skillUrl = String(door).replace(/\/$/, '') + '/skill.md';
  const skillRes = await timedFetch(skillUrl, { redirect: 'manual' });
  const skillText = await skillRes.text();
  note(skillRes.status === 200, 'door_skill_status', skillRes.status);
  note(skillText.includes(`origin ${origin}`), 'door_skill_origin', skillText.slice(0, 120));
  note(!/project-room-staging/.test(skillText), 'door_skill_not_staging', 'staging origin in skill.md');
  const agentsUrl = String(door).replace(/\/$/, '') + '/AGENTS.md';
  const agentsRes = await timedFetch(agentsUrl, { redirect: 'manual' });
  const agentsText = await agentsRes.text();
  note(agentsRes.status === 200, 'door_agents_status', agentsRes.status);
  note(agentsText.includes(`origin ${origin}`), 'door_agents_origin', agentsText.slice(0, 120));
  note(!/project-room-staging/.test(agentsText), 'door_agents_not_staging', 'staging origin in AGENTS.md');

  const mcpDeny = await timedFetch(origin + '/mcp', {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-audit', version: '0' } } })
  });
  note(mcpDeny.status === 403, 'mcp_origin_denied', mcpDeny.status);

  return {
    ok: failures.length === 0,
    origin,
    sourceRevision: version.json?.sourceRevision ?? null,
    failures
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await liveAudit();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}
