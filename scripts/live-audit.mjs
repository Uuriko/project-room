import { pathToFileURL } from 'node:url';
import { GOOGLE_CALLBACK_PATH, GOOGLE_START_PATH, GOOGLE_SCOPES } from '../server/google-oauth.mjs';

export const LIVE_ORIGIN = 'https://room.trydemigod.com';

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

  const open = await get('/api/open');
  note(open.json?.ship === false, 'ship', open.json?.ship);
  note(open.json?.persistence === 'none', 'persistence', open.json?.persistence);

  const auth = await get('/api/auth-config');
  note(auth.json?.provider === 'google', 'auth_provider', auth.json?.provider);
  note(auth.json?.authorizationPath === GOOGLE_START_PATH, 'auth_path', auth.json?.authorizationPath);
  note(!auth.json?.publishableKey, 'no_browser_sdk_key', auth.json?.publishableKey);

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
