#!/usr/bin/env node
// Generate a rollback-prod compatibility receipt in the exact format
// scripts/manual-rollback.mjs (qualification()) admits:
//
//   { format: 1,
//     current: { prod: {versionId, sourceRevision}, entry: {versionId, sourceRevision} },
//     targets: { prod: {versionId, sourceRevision}, entry: {versionId, sourceRevision} | null },
//     checks:  { oldCodeNewData: {result:"passed", evidence:<url>},
//                retainedRuntime: {...}, workerBindings: {...} } }
//
// manual-rollback.mjs reads the receipt via `git show HEAD:<path>`, requires
// format===1, requires current/targets to match the Cloudflare-observed
// allocations exactly (both fields, both workers), and requires every check
// evidence URL to be https://github.com/.../actions/runs/<digits>[/attempts/<n>]
// or https://github.com/.../blob/<40-hex-commit>/<path>. Equal schema numbers
// alone are NOT qualification (see the manual-rollback.mjs header).
//
// FREEZE-TIME REGENERATION (the pair this generator was built for):
//   pair current = frozen head d7f723ada0ea808589dd0d123913055e40551c2e
//   pair target  = production ee97df6132c37f8a41cc8925a00792b6bbd26e1d
// At freeze time the current (frozen-head) Worker version ids DO NOT EXIST
// until that head's deploy-prod run creates them; the target ids are the
// pre-deploy snapshot recorded by that same run (artifact pre-deploy-<sha>,
// also printed in the deploy job log). So regenerate AFTER the freeze deploy:
//
//   node scripts/make-rollback-receipt.mjs \
//     --current-revision <frozen-head-sha> \
//     --current-prod-id <new prod version uuid from the freeze deploy-prod run> \
//     --current-entry-id <new entry version uuid from the freeze deploy-prod run> \
//     --target-revision <previous prod sha> \
//     --target-prod-id <prod uuid from that run's pre-deploy-<sha> artifact> \
//     --target-entry-id <entry uuid from that run's pre-deploy-<sha> artifact> \
//     --evidence <https://github.com/Uuriko/project-room/blob/<commit-sha>/docs/deploy/rollback-compatibility/evidence-<...>.md> \
//     --out docs/deploy/rollback-compatibility/<current-short>-to-<target-short>.json
//
// The generator refuses to write a receipt with any missing/invalid field:
// a receipt with invented or placeholder version ids would fail
// manual-rollback.mjs preflight anyway, and worse, would look qualified.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{40}$/;
const fail = msg => { console.error(`make-rollback-receipt: ${msg}`); process.exit(1); };

const currentRevision = opt('current-revision');
const targetRevision = opt('target-revision');
const currentProdId = opt('current-prod-id');
const currentEntryId = opt('current-entry-id');
const targetProdId = opt('target-prod-id');
const targetEntryId = opt('target-entry-id'); // optional: omit -> targets.entry = null (entry kept as-is)
const evidence = opt('evidence');
const out = opt('out');

if (!sha.test(currentRevision ?? '')) fail('--current-revision must be a full 40-hex SHA');
if (!sha.test(targetRevision ?? '')) fail('--target-revision must be a full 40-hex SHA');
for (const [name, v] of [['--current-prod-id', currentProdId], ['--current-entry-id', currentEntryId], ['--target-prod-id', targetProdId]])
  if (!uuid.test(v ?? '')) fail(`${name} must be a full version UUID (from the deploy-prod run / its pre-deploy artifact; never invent one)`);
if (targetEntryId !== undefined && !uuid.test(targetEntryId)) fail('--target-entry-id must be a full version UUID when given');
let link;
try { link = new URL(evidence); } catch { fail('--evidence must be a URL'); }
if (!link || link.protocol !== 'https:' || link.username || link.password || link.hash || link.search ||
    link.hostname !== 'github.com' ||
    !/\/(?:actions\/runs\/\d+(?:\/attempts\/\d+)?|blob\/[0-9a-f]{40}\/[^?#]+)$/.test(link.pathname))
  fail('--evidence must match manual-rollback.mjs: https://github.com/.../actions/runs/<id>[/attempts/<n>] or /blob/<40-hex>/<path>');
if (!out || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.json$/.test(out) || out.split('/').some(p => ['.', '..', ''].includes(p)))
  fail('--out must be a repo-relative .json path (the COMPATIBILITY_FILE path rules)');

const check = () => ({ result: 'passed', evidence });
const receipt = {
  format: 1,
  current: {
    prod: { versionId: currentProdId, sourceRevision: currentRevision },
    entry: { versionId: currentEntryId, sourceRevision: currentRevision },
  },
  targets: {
    prod: { versionId: targetProdId, sourceRevision: targetRevision },
    entry: targetEntryId ? { versionId: targetEntryId, sourceRevision: targetRevision } : null,
  },
  checks: { oldCodeNewData: check(), retainedRuntime: check(), workerBindings: check() },
};
writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
console.log(`wrote ${out}: current ${currentRevision} -> target ${targetRevision}`);
console.log('Commit it on main before dispatching rollback-prod with --compatibility_file ' + out + ' (the receipt is read from HEAD).');
