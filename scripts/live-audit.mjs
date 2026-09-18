// live-audit.mjs — production deploy guardrails for room.trydemigod.com.
//
// Fixture-vs-live gap (read before adding a guard): this module is
// unit-tested with an injected fetchImpl (tests/live-audit.test.js), so a
// guard can pass against fixtures while the route it guards never existed.
// That is exactly what happened with /api/open, /api/auth-config and
// /privacy: they were asserted against fixture JSON, but server/http.mjs
// serves no such API paths and its `assets` static map has no such page,
// so every deploy check cried wolf on ship/persistence/auth_provider/
// privacy_status. Rules for this file:
//   1. Every guarded path MUST exist in server/http.mjs (or the assets map).
//   2. Retired paths stay in PHANTOM_ROUTES below as honest-404 assertions:
//      the audit fails if a phantom ever starts serving, which forces the
//      guard to be rewritten against the real route — never against a fixture.
import { pathToFileURL } from 'node:url';
import { GOOGLE_CALLBACK_PATH, GOOGLE_START_PATH, GOOGLE_SCOPES } from '../server/google-oauth.mjs';

export const LIVE_ORIGIN = 'https://room.trydemigod.com';

// Paths the audit used to guard that never existed in server/http.mjs.
// Asserted as honest 404s: a deployed route appearing at one of these
// paths is route-surface drift and must fail the deploy check loudly.
// (Auth-surface coverage lives on the real GOOGLE_START_PATH 302 checks
// below; nothing here touches login/auth code.)
export const PHANTOM_ROUTES = ['/api/open', '/api/auth-config', '/privacy'];

export async function liveAudit({ origin = LIVE_ORIGIN, fetchImpl = fetch } = {}) {
  const failures = [];
  const note = (ok, code, detail) => { if (!ok) failures.push({ code, detail }); };
  const get = async path => {
    const res = await fetchImpl(origin + path, { redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { res, text, json };
  };

  const version = await get('/api/version');
  note(version.json?.mode === 'cloudflare-production', 'version_mode', version.json?.mode);
  note(typeof version.json?.sourceRevision === 'string' && version.json.sourceRevision.length === 40, 'version_sha', version.json?.sourceRevision);

  for (const path of PHANTOM_ROUTES) {
    const phantom = await get(path);
    note(phantom.res.status === 404, 'phantom_route', `${path} -> ${phantom.res.status}`);
  }

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

  const ready = await get('/api/ready');
  note(ready.res.status === 200 && ready.json?.status === 'ready', 'ready', ready.res.status);

  const home = await get('/');
  note(home.res.status === 200, 'home', home.res.status);
  note(!/clerk\.browser\.js|@clerk\/clerk-js/.test(home.text), 'home_no_clerk_sdk', 'clerk sdk');

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
