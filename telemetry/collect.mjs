#!/usr/bin/env node
// telemetry-bus room collector: extracts FINDING posts from muse-room event JSON and appends
// new findings to telemetry/findings.jsonl.
//
// Usage:
//   node telemetry/collect.mjs --events <path-to-events-json>   # offline fixture / file mode
//   node telemetry/collect.mjs --live [--after <seq>]            # room.trydemigod.com muse-room events
//
// File mode expects JSON shaped like: { events: [ { sequence, event: { type, data: { body } } } ] }
// Prints: "collected N new, skipped M dupes, rejected K invalid"
//
// NOTE: --live reads from the production room API. Do not run --live except when the
// telemetry-bus lead explicitly approves wiring up the live feed.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOM_BASE = 'https://room.trydemigod.com';
const ID_RE = /^[a-z0-9-]+$/;
const CATEGORIES = ['correctness', 'performance', 'security', 'dx', 'protocol', 'onboarding', 'other'];
const CONFIDENCES = ['high', 'medium', 'low'];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      console.error(`telemetry/collect: unexpected positional argument: ${a}`);
      process.exit(1);
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function loadExistingIds(path) {
  const ids = new Set();
  if (!existsSync(path)) return ids;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (typeof r.id === 'string') ids.add(r.id);
    } catch {
      /* skip corrupt lines */
    }
  }
  return ids;
}

function validateRecord(r) {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return 'not an object';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'id missing or invalid';
  if (typeof r.guild !== 'string' || !r.guild) return 'guild missing';
  if (typeof r.claim !== 'string' || r.claim.length < 10) return 'claim missing or <10 chars';
  if (typeof r.evidence !== 'string' || r.evidence.length < 10) return 'evidence missing or <10 chars';
  if (typeof r.numbers !== 'object' || r.numbers === null || Array.isArray(r.numbers)) return 'numbers must be an object';
  if (typeof r.timestamp !== 'string' || Number.isNaN(Date.parse(r.timestamp))) return 'timestamp missing or not ISO8601';
  if (r.category !== undefined && !CATEGORIES.includes(r.category)) return 'category invalid';
  if (r.confidence !== undefined && !CONFIDENCES.includes(r.confidence)) return 'confidence invalid';
  if (r.roomSeq !== undefined && !Number.isInteger(r.roomSeq)) return 'roomSeq must be int';
  return null;
}

// Room-native format: first line literally "FINDING", then one fenced ```json block
// containing exactly one finding record.
function extractFinding(body) {
  if (typeof body !== 'string') return { status: 'not-finding' };
  if (!body.startsWith('FINDING\n') && body.trimStart() !== 'FINDING' && !body.startsWith('FINDING\r')) {
    return { status: 'not-finding' };
  }
  const fence = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fence) return { status: 'rejected', reason: 'no fenced json block' };
  let record;
  try {
    record = JSON.parse(fence[1]);
  } catch (e) {
    return { status: 'rejected', reason: 'broken JSON in fenced block' };
  }
  const err = validateRecord(record);
  if (err) return { status: 'rejected', reason: err };
  return { status: 'ok', record };
}

function resolveBearer() {
  if (process.env.ROOM_BEARER) return process.env.ROOM_BEARER;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const p = join(home, '.config', 'jill-room', 'identity.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j.token || j.bearer || j.access_token || null;
  } catch {
    return null;
  }
}

async function fetchLive(after) {
  const bearer = resolveBearer();
  if (!bearer) {
    console.error('telemetry/collect --live: no Bearer found (set ROOM_BEARER or ~/.config/jill-room/identity.json)');
    process.exit(1);
  }
  const url = `${ROOM_BASE}/api/rooms/muse-room/events?limit=100&after=${after ?? 0}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!res.ok) {
    console.error(`telemetry/collect --live: GET ${url} -> HTTP ${res.status}`);
    process.exit(1);
  }
  return res.json();
}

function watermarkPath() {
  return join(process.cwd(), 'telemetry', 'collect-watermark.json');
}

function loadWatermark() {
  const p = watermarkPath();
  if (!existsSync(p)) return 0;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Number.isInteger(j.after) ? j.after : 0;
  } catch {
    return 0;
  }
}

function saveWatermark(after) {
  const p = watermarkPath();
  mkdirSync(join(process.cwd(), 'telemetry'), { recursive: true });
  writeFileSync(p, JSON.stringify({ after }) + '\n');
}

async function main() {
  const a = args(process.argv.slice(2));
  const jsonl = join(process.cwd(), 'telemetry', 'findings.jsonl');
  const existing = loadExistingIds(jsonl);

  let events;
  if (a.live) {
    console.error('telemetry/collect --live: fetching live room events (read-only). Live wiring is the lead\'s call.');
    const afterArg = a.after === true || a.after === undefined ? loadWatermark() : Number(a.after);
    const data = await fetchLive(afterArg);
    events = data.events ?? data.items ?? [];
  } else {
    if (!a.events) {
      console.error('telemetry/collect: need --events <path> or --live');
      process.exit(1);
    }
    const raw = readFileSync(a.events, 'utf8');
    const data = JSON.parse(raw);
    events = data.events ?? data.items ?? [];
    if (!Array.isArray(events)) {
      console.error('telemetry/collect: events JSON has no events[] array');
      process.exit(1);
    }
  }

  let collected = 0, dupes = 0, rejected = 0, maxSeq = null;
  for (const ev of events) {
    const seq = ev.sequence ?? ev.seq ?? null;
    if (typeof seq === 'number' && (maxSeq === null || seq > maxSeq)) maxSeq = seq;
    const body = ev?.event?.data?.body ?? ev?.body ?? null;
    const r = extractFinding(body);
    if (r.status === 'not-finding') continue;
    if (r.status === 'rejected') {
      rejected++;
      continue;
    }
    if (existing.has(r.record.id)) {
      dupes++;
      continue;
    }
    appendFileSync(jsonl, JSON.stringify(r.record) + '\n');
    existing.add(r.record.id);
    collected++;
  }

  if (a.live && maxSeq !== null) saveWatermark(maxSeq);
  console.log(`collected ${collected} new, skipped ${dupes} dupes, rejected ${rejected} invalid`);
}

main().catch((e) => {
  console.error(`telemetry/collect: ${e.message}`);
  process.exit(1);
});
