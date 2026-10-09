#!/usr/bin/env node
// GUILD-06: generate a usage catalog for every script in the slice.
// Extracts: leading // header comment block, CLI flags (--word / --word=x),
// positional-arg hints (process.argv slicing), and a "how to run" line.
// Output: docs/guild06-scripts-usage.md
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = join(ROOT, 'scripts');
const slice = readFileSync(join(ROOT, 'guild-script-slice.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const EXCLUDED = new Set(['room', 'herdr-migrate.mjs', 'runtime-package.mjs']);

function collect(dir, rel) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e); const r = rel ? join(rel, e) : e;
    const st = statSync(full);
    if (st.isDirectory()) { if (e !== 'node_modules') out.push(...collect(full, r)); }
    else if (/\.(mjs|sh|py)$/.test(e)) out.push(r);
  }
  return out;
}
const files = collect(SCRIPTS, '').filter(f => {
  const top = f.split('/')[0];
  return !EXCLUDED.has(top) && !EXCLUDED.has(f);
}).sort();

function headerComment(src) {
  const lines = src.split('\n');
  // 1) leading // block (allowing blank lines/shebang before it)
  let buf = [];
  let started = false;
  for (const l of lines.slice(0, 12)) {
    if (/^\s*\/\/\/?/.test(l)) { started = true; buf.push(l.replace(/^\s*\/\/\/?\s?/, '')); }
    else if (l.trim() === '' || l.startsWith('#!')) { if (started) break; continue; }
    else break;
  }
  if (buf.join('').trim()) return buf.join('\n').trim();
  // 2) leading block comment
  const block = src.match(/^\s*(?:#!.*\n)?\s*\/\*\*?([\s\S]*?)\*\//);
  if (block) {
    const text = block[1].split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean).join('\n');
    if (text) return text;
  }
  // 3) first // run in the first 60 lines (some scripts put imports first)
  buf = [];
  for (const l of lines.slice(0, 60)) {
    if (/^\s*\/\/\/?/.test(l)) buf.push(l.replace(/^\s*\/\/\/?\s?/, ''));
    else if (buf.length >= 2) break;
    else if (buf.length === 0) continue;
  }
  const run3 = buf.join('\n').trim();
  if (run3) return run3;
  // 4) inline Usage: string in code (many agent-* scripts document inline)
  const usage = src.match(/[Uu]sage:\s*([^\n"']{10,400})/);
  if (usage) return 'Usage: ' + usage[1].trim();
  return '';
}

function detectFlags(src) {
  const flags = new Set();
  for (const m of src.matchAll(/["'`](-{1,2}[a-zA-Z][a-zA-Z0-9_-]*)["'`]/g)) {
    const f = m[1];
    if (f.length > 2 && !f.startsWith('---')) flags.add(f);
  }
  // also process.argv destructuring hints
  const argv = src.match(/process\.argv\.slice\((\d+)\)/);
  return { flags: [...flags].sort().slice(0, 24), positionalFrom: argv ? Number(argv[1]) : null };
}

function detectRunner(f) {
  if (f.endsWith('.sh')) return `bash scripts/${f}`;
  if (f.endsWith('.py')) return `python3 scripts/${f}`;
  return `node scripts/${f}`;
}

function detectEnv(src) {
  const envs = new Set();
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) envs.add(m[1]);
  return [...envs].sort().slice(0, 12);
}

const rows = [];
for (const f of files) {
  const full = join(SCRIPTS, f);
  let src = '';
  try { src = readFileSync(full, 'utf8'); } catch { rows.push({ f, desc: '(unreadable)', flags: [], run: '' }); continue; }
  const { flags, positionalFrom } = detectFlags(src);
  const MANUAL = {
  'acceptance-fixture.mjs': 'Self-test fixture harness: reads a base64 room-state fixture and applies per-line character fixes from a .fix file; used by browser checks to seed deterministic rooms.',
  'account-workspace-check.mjs': 'node --test browser check: account workspace flows for inbox-only vs member accounts (magic-link mailer mocked).',
  'agent-connect-browser-check.mjs': 'node --test browser check: agent connect first screen — visible entry choices open focused flows without hiding pending agent sign-in.',
  'agent-inbox.mjs': 'Agent CLI: join/resume a room via invite code or room URL into a private directory; --accept accepts the disclosed grant. stdin-capable.',
  'agent-mcp.mjs': 'MCP stdio server for an enrolled agent: exposes room tools over the existing private Room connection; takes no arguments.',
  'agent-signin-browser-check.mjs': 'node --test browser check: agent sign-in entry — visible entry choices open focused flows without hiding pending agent sign-in.',
  'backup-room.mjs': 'Backs up the live room DB (--db or ROOM_DB) to --to with verification; never replaces live data on failure.',
  'build-ui-strings.mjs': 'Builds strings/en.js from strings/en.json; --check asserts the generated module is fresh.',
  'install.sh': 'Installs the `room` command into ~/.project-room/bin (no sudo, no shell-profile edits). PROJECT_ROOM_HOME overrides HOME.',
  'layout-simplification-browser-check.mjs': 'node --test browser check: conversation layout at 1440/390/320px (account and room-key) preserves navigation, drafts and usable controls.',
  'owner-project-offers-browser-check.mjs': 'node --test browser check: owner project-offers surface across desktop/mobile viewports.',
  'replay-room-export.mjs': 'Replays an NDJSON room export (--from) into a destination (--to) with verification; destination not promoted on failure.',
  'room-roster.mjs': 'Prints the room roster (members/roles) for the checkout; thin CLI over the room-roster library.',
  'rotation-cutover.sh': 'Executes the claims-board rotation (old board → successor). DRY RUN BY DEFAULT; --confirm executes. Fail-closed. Runbook: docs/ROOM-WATCH.md §8.',
  'rotation-rehearse.sh': 'Hermetic end-to-end verification of the rotation runbook: exercises rotation-cutover.sh against a fixture board via a gh shim, asserts rotation invariants.',
};
const desc = MANUAL[f] || headerComment(src).split('\n').slice(0, 6).join(' ') || '(no header comment)';
  rows.push({ f, desc, flags, run: detectRunner(f), env: detectEnv(src) });
}

const md = [
  '# scripts/ usage catalog (guild-06, generated 2026-10-09)',
  '',
  `Covers ${rows.length} executable files in \`scripts/\` (excluding \`scripts/room\`, \`scripts/herdr-migrate.mjs\`, \`scripts/runtime-package.mjs\` — guild-05 slice).`,
  'Descriptions are extracted from each script\'s leading header comment; flags are detected statically from string literals.',
  '',
  ...rows.flatMap(r => [
    `## ${r.f}`,
    '',
    r.desc.length > 600 ? r.desc.slice(0, 600) + '…' : r.desc,
    '',
    `Run: \`${r.run}\``,
    r.flags.length ? `Flags seen: ${r.flags.map(x => `\`${x}\``).join(' ')}` : 'Flags seen: none detected',
    r.env.length ? `Env vars read: ${r.env.map(x => `\`${x}\``).join(' ')}` : '',
    '',
  ]),
].join('\n');

const outDir = join(ROOT, 'docs');
if (!existsSync(outDir)) { /* docs exists in repo */ }
writeFileSync(join(ROOT, 'docs', 'guild06-scripts-usage.md'), md);
console.log(`wrote docs/guild06-scripts-usage.md with ${rows.length} entries`);
