#!/usr/bin/env node
/*
 * lane-claim.mjs — WAVE-500 standing-claim tooling prototype (coord-cost, worker 8/17).
 *
 * Companion to the standing-claims protocol proposal (worker 7; doc not present at
 * build time — see docs/LANE-CLAIM-CLI.md "Assumptions"). Conforms to the protocol
 * lane's namespace convention `w500-<guild>-<slice>` (wave500-design/claim-granularity.md)
 * and to the board claim states in docs/WORK-CLAIMS-READ.md.
 *
 * ALL subcommands are DRY-RUN by default: they validate inputs and print the exact
 * API payload(s) and room message(s) they would send. Pass --live to perform the
 * real HTTP sends. Never pass --live from an unattended/verification run.
 *
 * Usage:
 *   node scripts/lane-claim.mjs create --wave <id> --lane <name> --manifest <tasks.json> [--room <roomId>] [--base <url>]
 *   node scripts/lane-claim.mjs heartbeat --lane-claim <id> [--room <roomId>] [--base <url>]
 *   node scripts/lane-claim.mjs complete-task --lane-claim <id> --task <taskId> --receipt <receipt.json> [--room <roomId>] [--base <url>]
 *   node scripts/lane-claim.mjs release --lane-claim <id> [--room <roomId>] [--base <url>]
 *
 * Global flags: --live, --help, --json (dry-run: print the envelope as raw JSON only)
 *
 * Exit codes: 0 = ok (dry-run or live success); 2 = input/validation error; 1 = runtime error.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const VERSION = 1;
const DEFAULT_BASE = 'https://room.trydemigod.com';
const DEFAULT_ROOM = 'muse-room';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > 0) { args[tok.slice(2, eq)] = tok.slice(eq + 1); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { args[tok.slice(2)] = argv[++i]; }
      else { args[tok.slice(2)] = true; }
    } else { args._.push(tok); }
  }
  return args;
}

function fail(msg) { process.stderr.write(`lane-claim: error: ${msg}\n`); process.exit(2); }
function need(args, name, sub) {
  if (args[name] === undefined || args[name] === true || args[name] === '')
    fail(`${sub}: missing required --${name}`);
  return String(args[name]);
}

function readJson(path, what) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { process.stderr.write(`lane-claim: error: cannot read ${what} ${path}: ${e.message}\n`); process.exit(1); }
  try { return JSON.parse(raw); }
  catch (e) { fail(`${what} ${path} is not valid JSON: ${e.message}`); }
}

// Normalize a manifest file path for overlap comparison.
function normFile(p) {
  if (typeof p !== 'string') fail(`file entry must be a string, got ${JSON.stringify(p)}`);
  let s = p.trim().replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!s) fail('file entry must not be empty');
  if (s.startsWith('/')) fail(`absolute path not allowed in manifest: ${p}`);
  if (s.split('/').includes('..')) fail(`.. segments not allowed in manifest: ${p}`);
  return s;
}

// Overlap test: same path, or one is a directory-prefix of the other.
function pathsOverlap(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

// Validate manifest: array of {id, title, files?}; unique ids; non-overlapping file sets.
function validateManifest(manifest) {
  if (!Array.isArray(manifest)) fail('manifest must be a JSON array of task objects');
  if (manifest.length === 0) fail('manifest must contain at least one task');
  const seen = new Map(); // taskId -> index
  const fileOwners = [];  // {file, taskId}
  const tasks = manifest.map((t, i) => {
    if (typeof t !== 'object' || t === null) fail(`manifest[${i}] must be an object`);
    if (typeof t.id !== 'string' || !t.id.trim()) fail(`manifest[${i}]: id must be a non-empty string`);
    const id = t.id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail(`manifest[${i}]: id "${id}" has illegal characters`);
    if (seen.has(id)) fail(`duplicate task id "${id}" (manifest[${seen.get(id)}] and manifest[${i}])`);
    seen.set(id, i);
    if (typeof t.title !== 'string' || !t.title.trim()) fail(`manifest[${i}] (${id}): title must be a non-empty string`);
    const files = t.files === undefined ? [] : t.files;
    if (!Array.isArray(files)) fail(`manifest[${i}] (${id}): files must be an array of paths`);
    const normed = [];
    for (const f of files) {
      const n = normFile(f);
      if (normed.includes(n)) fail(`manifest[${i}] (${id}): duplicate file entry "${f}"`);
      for (const o of fileOwners) {
        if (pathsOverlap(n, o.file))
          fail(`file overlap: task "${id}" file "${n}" overlaps task "${o.taskId}" file "${o.file}"`);
      }
      fileOwners.push({ file: n, taskId: id });
      normed.push(n);
    }
    return { id, title: t.title.trim(), files: normed };
  });
  return tasks;
}

// Validate receipt: JSON object with v1 fields workerId, status, summary (non-empty strings).
function validateReceipt(receipt) {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt))
    fail('receipt must be a JSON object');
  for (const f of ['workerId', 'status', 'summary']) {
    if (typeof receipt[f] !== 'string' || !receipt[f].trim())
      fail(`receipt missing v1 field "${f}" (required: workerId, status, summary as non-empty strings)`);
  }
  return receipt;
}

function idempotencyKey(parts) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}
const nowIso = () => new Date().toISOString();

function apiUrl(base, room, path) { return `${base.replace(/\/$/, '')}/api/rooms/${room}${path}`; }

// Envelope: one versioned object carrying the room message and the API call(s)
// under a single idempotency key, so a retried command is dedup-able on either surface.
function envelope(kind, idemKey, roomMessage, apiCalls) {
  return { envelope: 'lane-claim/v1', kind, idempotencyKey: idemKey, roomMessage, apiCalls };
}

function roomFence(kind, lines) {
  return '```' + kind + '\n' + lines.join('\n') + '\n```';
}

function cmdCreate(args) {
  const wave = need(args, 'wave', 'create');
  const lane = need(args, 'lane', 'create');
  const manifestPath = need(args, 'manifest', 'create');
  const room = String(args.room || DEFAULT_ROOM);
  const base = String(args.base || DEFAULT_BASE);
  const tasks = validateManifest(readJson(manifestPath, 'manifest'));
  const laneClaimId = `w500-${wave}-${lane}`;
  const key = idempotencyKey(['lane-claim', VERSION, laneClaimId, tasks]);
  const allFiles = [...new Set(tasks.flatMap(t => t.files))];
  const taskLines = tasks.map(t => `  - ${t.id}: ${t.title}${t.files.length ? `  [${t.files.join(', ')}]` : ''}`);

  const roomMessage =
    `[jill][lane-claim] ${laneClaimId} — ${tasks.length} task(s) claimed under wave ${wave} (lane ${lane}).\n\n` +
    roomFence('room-claim', [
      `claim-id:    ${laneClaimId}`,
      `type:        lane-claim/v${VERSION}`,
      `wave:        ${wave}`,
      `lane:        ${lane}`,
      `namespace:   ${laneClaimId}`,
      `idempotency: ${key}`,
      `tasks:`,
      ...taskLines,
      `files:       ${allFiles.join(', ') || '(none)'}`,
    ]);

  const apiBody = {
    id: laneClaimId, type: 'lane-claim', version: VERSION,
    wave, lane, namespace: laneClaimId, idempotencyKey: key,
    state: 'claimed',
    tasks: tasks.map(t => ({ id: t.id, title: t.title, files: t.files, state: 'claimed' })),
    files: allFiles,
    lease: { ttlSeconds: 3600 },
  };

  return envelope('create', key, roomMessage, [
    { method: 'POST', url: apiUrl(base, room, '/work-claims'), body: apiBody },
  ]);
}

function cmdHeartbeat(args) {
  const id = need(args, 'lane-claim', 'heartbeat');
  const room = String(args.room || DEFAULT_ROOM);
  const base = String(args.base || DEFAULT_BASE);
  const key = idempotencyKey(['lane-claim-heartbeat', VERSION, id, nowIso().slice(0, 16)]);
  const roomMessage =
    `[jill][lane-claim-heartbeat] ${id} — still active (lease renewed, no task changes).`;

  return envelope('heartbeat', key, roomMessage, [
    { method: 'POST', url: apiUrl(base, room, `/work-claims/${id}/heartbeat`),
      body: { type: 'lane-claim-heartbeat', version: VERSION, laneClaimId: id, at: nowIso(), idempotencyKey: key } },
  ]);
}

function cmdCompleteTask(args) {
  const id = need(args, 'lane-claim', 'complete-task');
  const taskId = need(args, 'task', 'complete-task');
  const receiptPath = need(args, 'receipt', 'complete-task');
  const room = String(args.room || DEFAULT_ROOM);
  const base = String(args.base || DEFAULT_BASE);
  const receipt = validateReceipt(readJson(receiptPath, 'receipt'));
  const key = idempotencyKey(['lane-claim-complete', VERSION, id, taskId, receipt]);

  const roomMessage =
    `[jill][done] ${taskId} — ${receipt.summary.trim()} (worker ${receipt.workerId.trim()}).\n\n` +
    roomFence('room-done', [
      `claim-id:    ${id}`,
      `task-id:    ${taskId}`,
      `worker:     ${receipt.workerId.trim()}`,
      `status:     ${receipt.status.trim()}`,
      `summary:    ${receipt.summary.trim()}`,
      `idempotency: ${key}`,
    ]);

  return envelope('complete-task', key, roomMessage, [
    { method: 'PATCH', url: apiUrl(base, room, `/work-claims/${id}/tasks/${encodeURIComponent(taskId)}`),
      body: { state: 'done', idempotencyKey: key, receipt } },
  ]);
}

function cmdRelease(args) {
  const id = need(args, 'lane-claim', 'release');
  const room = String(args.room || DEFAULT_ROOM);
  const base = String(args.base || DEFAULT_BASE);
  const key = idempotencyKey(['lane-claim-release', VERSION, id]);

  const roomMessage =
    `[jill][lane-claim-release] ${id} — remaining unclaimed tasks returned to the ready pool.\n\n` +
    roomFence('room-claim', [
      `claim-id:    ${id}`,
      `type:        lane-claim/v${VERSION}`,
      `action:      release`,
      `idempotency: ${key}`,
    ]);

  return envelope('release', key, roomMessage, [
    { method: 'POST', url: apiUrl(base, room, `/work-claims/${id}/release`),
      body: { laneClaimId: id, releaseRemaining: true, idempotencyKey: key } },
  ]);
}

async function sendLive(env) {
  for (const call of env.apiCalls) {
    const res = await fetch(call.url, {
      method: call.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call.body),
    });
    const text = await res.text();
    process.stdout.write(`[LIVE] ${call.method} ${call.url} -> ${res.status}\n${text.slice(0, 2000)}\n`);
    if (!res.ok) { process.stderr.write(`lane-claim: live send failed (${res.status})\n`); process.exit(1); }
  }
  process.stdout.write(`[LIVE] room message (post to room):\n${env.roomMessage}\n`);
}

function printDryRun(env, asJson) {
  if (asJson) { process.stdout.write(JSON.stringify(env, null, 2) + '\n'); return; }
  process.stdout.write('--- DRY RUN (no sends performed; pass --live to send) ---\n\n');
  process.stdout.write('API calls it would make:\n');
  for (const call of env.apiCalls) {
    process.stdout.write(`  ${call.method} ${call.url}\n  body:\n`);
    process.stdout.write(JSON.stringify(call.body, null, 2).split('\n').map(l => '    ' + l).join('\n') + '\n');
  }
  process.stdout.write('\nRoom message it would post:\n');
  process.stdout.write(env.roomMessage.split('\n').map(l => '  ' + l).join('\n') + '\n');
  process.stdout.write(`\nidempotencyKey: ${env.idempotencyKey}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    process.stdout.write(readFileSync(new URL(import.meta.url), 'utf8').match(/ \* Usage:([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim() + '\n');
    process.exit(0);
  }
  const sub = args._[0];
  const live = args.live === true || args.live === 'true' || args.live === '';
  let env;
  if (sub === 'create') env = cmdCreate(args);
  else if (sub === 'heartbeat') env = cmdHeartbeat(args);
  else if (sub === 'complete-task') env = cmdCompleteTask(args);
  else if (sub === 'release') env = cmdRelease(args);
  else fail(`unknown subcommand "${sub}" (create|heartbeat|complete-task|release)`);
  if (live) await sendLive(env);
  else printDryRun(env, args.json === true);
}

main().catch(e => { process.stderr.write(`lane-claim: error: ${e.message}\n`); process.exit(1); });
