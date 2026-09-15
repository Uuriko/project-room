import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { googleConfig, GOOGLE_CALLBACK_PATH, GOOGLE_SCOPES, GOOGLE_START_PATH } from '../server/google-oauth.mjs';

export const ROOM_ORIGIN = 'https://room.trydemigod.com';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const productionConfig = join(root, 'cloudflare/wrangler.production.jsonc');

export function googleLoginHandoff() {
  return Object.freeze({
    origin: ROOM_ORIGIN,
    javascriptOrigin: ROOM_ORIGIN,
    redirectUri: ROOM_ORIGIN + GOOGLE_CALLBACK_PATH,
    startPath: GOOGLE_START_PATH,
    scopes: Object.freeze(GOOGLE_SCOPES.split(' ')),
    appName: 'Project Room',
    userSupportEmail: 'potter@trydemigod.com',
    console: Object.freeze({
      overview: 'https://console.cloud.google.com/auth/overview',
      branding: 'https://console.cloud.google.com/auth/branding',
      audience: 'https://console.cloud.google.com/auth/audience',
      clients: 'https://console.cloud.google.com/auth/clients',
      createClient: 'https://console.cloud.google.com/auth/clients/create'
    })
  });
}

export function parseGoogleLoginSecrets(env = {}) {
  const config = googleConfig({
    ROOM_GOOGLE_CLIENT_ID: env.ROOM_GOOGLE_CLIENT_ID,
    ROOM_GOOGLE_CLIENT_SECRET: env.ROOM_GOOGLE_CLIENT_SECRET
  }, ROOM_ORIGIN);
  if (!config) throw new Error('Set ROOM_GOOGLE_CLIENT_ID and ROOM_GOOGLE_CLIENT_SECRET');
  return config;
}

export function formatGoogleLoginHandoff(handoff = googleLoginHandoff()) {
  return [
    'Human steps (Google Cloud). Agent cannot create the OAuth client.',
    `1. Open ${handoff.console.overview} and pick the trydemigod project (create one if needed).`,
    `2. Branding (${handoff.console.branding}): app name "${handoff.appName}", support email ${handoff.userSupportEmail}.`,
    `3. Audience (${handoff.console.audience}): External, add your Gmail as a test user if the app is in Testing.`,
    `4. Create client (${handoff.console.createClient}): application type Web application, name "${handoff.appName}".`,
    `5. Authorized JavaScript origins: ${handoff.javascriptOrigin}`,
    `6. Authorized redirect URIs: ${handoff.redirectUri}`,
    `7. Scopes already requested by Room: ${handoff.scopes.join(', ')} (openid / email / profile only; not Gmail mailbox).`,
    '8. Paste Client ID and Client secret to the agent, or:',
    '   ROOM_GOOGLE_CLIENT_ID=... ROOM_GOOGLE_CLIENT_SECRET=... node scripts/google-login-activate.mjs --apply',
    `Live start path after secrets: ${handoff.origin}${handoff.startPath}`
  ].join('\n');
}

function putSecret(name, value) {
  execFileSync('wrangler', ['secret', 'put', name, '--name', 'project-room', '--config', productionConfig], {
    input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  });
}

export function applyGoogleLoginSecrets(env = process.env, put = putSecret) {
  const config = parseGoogleLoginSecrets(env);
  put('ROOM_GOOGLE_CLIENT_ID', config.clientId);
  put('ROOM_GOOGLE_CLIENT_SECRET', config.clientSecret);
  return { applied: true, provider: 'google', authorizationPath: GOOGLE_START_PATH };
}

function printHandoff() {
  const handoff = googleLoginHandoff();
  process.stdout.write(formatGoogleLoginHandoff(handoff) + '\n');
  return handoff;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--apply')) {
    const result = applyGoogleLoginSecrets();
    process.stdout.write(JSON.stringify({ applied: result.applied, provider: result.provider, authorizationPath: result.authorizationPath }) + '\n');
  } else {
    const handoff = printHandoff();
    if (args.has('--copy')) {
      execFileSync('pbcopy', { input: handoff.redirectUri, encoding: 'utf8' });
    }
    if (args.has('--open')) {
      for (const url of [handoff.console.overview, handoff.console.createClient]) {
        execFileSync('open', [url]);
      }
    }
  }
}
