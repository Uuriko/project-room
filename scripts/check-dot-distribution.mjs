import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHECKLIST = Object.freeze({
  version: '2026-11-01',
  source: 'https://developers.openai.com/plugins/deploy/submission',
  purpose: 'Offline mobile-oriented release preparation; not JSON Schema validation or host approval',
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const publicHttps = (value, allowQuery = true) => {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase().replace(/\.+$/, '');
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && (allowQuery || (!u.search && u.href === value))
      && h.includes('.') && !h.endsWith('.invalid') && !h.endsWith('.example')
      && !h.endsWith('.test') && !h.endsWith('.localhost') && !h.endsWith('.local')
      && h !== 'example.com' && !h.endsWith('.example.com')
      && !/^\d+\.\d+\.\d+\.\d+$/.test(h) && !h.includes(':');
  } catch { return false; }
};
const humanGates = Object.freeze([
  'Publisher identity, project permission, legal accuracy, and country availability approved by owner',
  'Domain verified and actual saved OAuth client/resource/callback confirmed in host',
  'Dedicated reviewer sample access provisioned with separate authorization; credentials never packaged',
  'Authenticated tools and Events scanned; required host checks resolved',
  'Review approved and publication explicitly authorized; verified directory route obtained',
  'Fresh friend Android installation, consent, tool use, disconnect and any promised wake qualified',
]);

export function auditDistribution({ plugin, mcp, assetExists = () => false, localHooks = false }) {
  const structuralErrors = [], releaseGaps = [];
  const gap = code => releaseGaps.push(code);
  if (!object(plugin) || !nonempty(plugin.name) || !nonempty(plugin.version) || !nonempty(plugin.description))
    structuralErrors.push('plugin_identity_shape');
  if (!object(mcp?.mcpServers) || Object.keys(mcp.mcpServers).length !== 1)
    structuralErrors.push('single_mcp_server_required_for_this_checklist');
  const ext = plugin?.extensions?.['com.openai'];
  if (localHooks || plugin?.hooks || ext?.hooks) gap('local_hooks_not_mobile_candidate');
  for (const server of Object.values(object(mcp?.mcpServers) ? mcp.mcpServers : {})) {
    if (!object(server)) { structuralErrors.push('server_shape'); continue; }
    if (server.command || server.args || server.env || server.type !== 'streamable-http') gap('local_or_unsupported_transport');
    if (!publicHttps(server.url, false)) gap('public_https_mcp_url_required');
    if (server.headers !== undefined && (!object(server.headers) || Object.keys(server.headers).length)) gap('server_headers_forbidden_in_public_submission');
    const auth = server.extensions?.['com.openai']?.auth;
    if (auth?.type !== 'oauth' || auth?.client?.mode !== 'provided'
      || !nonempty(auth?.client?.clientId) || auth?.client?.tokenEndpointAuthMethod !== 'none') gap('expected_public_client_oauth_shape');
    if (auth?.clientSecret !== undefined || auth?.client?.clientSecret !== undefined) gap('packaged_client_secret');
    if (!publicHttps(auth?.resource, false) || auth?.resource !== server.url) gap('resource_must_equal_mcp_url');
    if (!Array.isArray(auth?.baseScopes) || !['rooms:read','chat:read','chat:write','work:read','work:write'].every(s => auth.baseScopes.includes(s))) gap('native_workflow_scopes_missing');
  }
  const ui = ext?.interface;
  for (const [key, max] of Object.entries({ displayName:30, shortDescription:30, longDescription:4000, developerName:80, category:120 }))
    if (!nonempty(ui?.[key]) || ui[key].length > max) gap(`listing_${key}_missing_or_invalid`);
  for (const key of ['websiteURL','supportURL','privacyPolicyURL','termsOfServiceURL'])
    if (!publicHttps(ui?.[key])) gap(`listing_${key}_requires_public_https`);
  if (!nonempty(ui?.logo) || !assetExists(ui.logo)) gap('primary_icon_missing_or_outside_package');
  const cases = ext?.review?.test_cases;
  const positive = Array.isArray(cases?.positive) ? cases.positive : [];
  const negative = Array.isArray(cases?.negative) ? cases.negative : [];
  if (positive.length < 5 || positive.some(c => !['description','prompt','tools_triggered','expected_behavior'].every(k => nonempty(c?.[k])))) gap('five_complete_positive_review_cases_required');
  if (negative.length < 3 || negative.some(c => !nonempty(c?.description) || !nonempty(c?.prompt))) gap('three_negative_review_cases_required');
  if (!publicHttps(ext?.review?.demo_recording_url)) gap('review_video_url_required');
  if (!nonempty(ext?.publication?.release_notes)) gap('release_notes_required');
  return { checklist: CHECKLIST, structure: structuralErrors.length ? 'failed' : 'basic_shape_passed_not_schema_validated',
    structuralErrors, releaseGaps: [...new Set(releaseGaps)],
    offlinePreparation: structuralErrors.length || releaseGaps.length ? 'not_ready' : 'passed_pending_human_and_host_gates',
    installability: 'not_established_by_offline_check', humanGates };
}

export function inspectPackage(directory, override) {
  const root = realpathSync(directory);
  const assetExists = path => {
    if (!nonempty(path) || !path.startsWith('./') || isAbsolute(path)) return false;
    try {
      const actual = realpathSync(resolve(root, path));
      const rel = relative(root, actual);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && statSync(actual).isFile();
    } catch { return false; }
  };
  return auditDistribution({ plugin: JSON.parse(readFileSync(resolve(root, 'plugin.json'), 'utf8')),
    mcp: JSON.parse(readFileSync(override ? resolve(override) : resolve(root, 'mcp.json'), 'utf8')),
    assetExists, localHooks: existsSync(resolve(root, 'hooks/hooks.json')) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2] || process.argv.length > 4) throw new Error('usage');
    const result = inspectPackage(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.offlinePreparation === 'not_ready' ? 1 : 0;
  } catch {
    console.error('Cannot inspect package. Usage: node scripts/check-dot-distribution.mjs PACKAGE_DIRECTORY [MCP_JSON_OVERRIDE]. Check paths and JSON; no input contents are printed.');
    process.exitCode = 2;
  }
}
