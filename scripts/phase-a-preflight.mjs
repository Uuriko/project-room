import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openJoinContract } from '../server/open-contract.mjs';
import { assertProductionReady } from '../server/production-gates.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Local Phase A: candidate freeze without Cloudflare. No secrets, no deploy.
export function phaseAPreflight({ env = {}, wranglerPath = join(root, 'cloudflare/wrangler.production.jsonc') } = {}) {
  const ship = openJoinContract().ship;
  if (ship !== false) throw new Error('Public MCP join must stay ship:false');
  if (openJoinContract().persistence !== 'none') throw new Error('Public MCP persistence must stay none');
  const wrangler = readFileSync(wranglerPath, 'utf8');
  if (/sk_live|BEGIN PRIVATE KEY|BEGIN RSA PRIVATE KEY|pk_live_|ROOM_CLERK/.test(wrangler)) {
    throw new Error('wrangler.production.jsonc must not contain identity-provider secrets');
  }
  if (!/ROOM_PRODUCTION": "1"/.test(wrangler)) throw new Error('wrangler.production.jsonc must set ROOM_PRODUCTION=1');
  if (!/room\.trydemigod\.com/.test(wrangler)) throw new Error('wrangler.production.jsonc must name room.trydemigod.com');
  if (/a5f2dca/i.test(wrangler)) throw new Error('wrangler.production.jsonc must not bind live object a5f2dca');
  const off = assertProductionReady(env, 'https://room.trydemigod.com', { ship: false });
  if (off.production !== false) throw new Error('Unset ROOM_PRODUCTION must not force production mode');
  return { ok: true, ship: false, persistence: 'none', origin: 'https://room.trydemigod.com' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(phaseAPreflight()));
}
