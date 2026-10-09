#!/usr/bin/env node
// scope-partition.mjs — FIX-24: machine-verifiable static scope-partition checker.
//
// Reads work claims (live room board or a local JSON fixture), collects the
// `files` scopes of all concurrently active claims, and reports overlapping
// file scopes — the n^2 duplicate-collision surface this fix targets.
//
// Usage:
//   node scripts/scope-partition.mjs [<fixture.json>] [--json]
//   node scripts/scope-partition.mjs --room muse-room --base https://room.trydemigod.com
//
// Exit codes:
//   0 — scopes are disjoint and every active claim declares files (clean partition)
//   1 — no overlap, but at least one active claim has missing/empty `files`
//       ("unpartitionable — warn loudly", not a silent pass)
//   2 — overlapping scopes found (human-readable overlap report)
//   3 — the claims could not be loaded at all (bad fixture, board unreachable)
//
// Claim scope semantics (docs/WORK-CLAIMS.md, docs/ROOM-COORDINATION.md):
//   - a `files` entry is a path string or { path, block? } / { path, region? }
//   - a directory scope covers everything under it (prefix overlap)
//   - the same path with the same label (or no label) conflicts
//   - the same path with two *different* labels does NOT conflict
//   - claims in state `done` / `unclaimed` are closed and ignored
//   - a `blocked` claim still holds its file lease (active)

const DEFAULT_ROOM = "muse-room";
const DEFAULT_BASE = "https://room.trydemigod.com";
const CLOSED_STATES = new Set(["done", "unclaimed"]);

function usage(exit = 0) {
  const msg = `Usage:
  node scripts/scope-partition.mjs [<fixture.json>] [--json]
  node scripts/scope-partition.mjs --room <roomId> [--base <url>] [--json]

Checks the file scopes of all active work claims for overlap.
Exit 0 = disjoint partition. 1 = unpartitionable claim(s) but no overlap.
2 = overlap found. 3 = claims could not be loaded.`;
  (exit === 0 ? process.stdout : process.stderr).write(msg + "\n");
  process.exit(exit);
}

function parseArgs(argv) {
  const opts = { room: DEFAULT_ROOM, base: DEFAULT_BASE, json: false, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--room") opts.room = argv[++i] ?? usage(2);
    else if (a === "--base") opts.base = argv[++i] ?? usage(2);
    else if (a === "-h" || a === "--help") usage(0);
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag: ${a}\n`);
      usage(2);
    } else opts.fixture = a;
  }
  return opts;
}

async function loadClaims(opts) {
  if (opts.fixture) {
    const { readFile } = await import("node:fs/promises");
    let raw;
    try {
      raw = await readFile(opts.fixture, "utf8");
    } catch (err) {
      return { error: `cannot read fixture ${opts.fixture}: ${err.message}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { error: `fixture ${opts.fixture} is not valid JSON: ${err.message}` };
    }
    const claims = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.claims)
        ? parsed.claims
        : Array.isArray(parsed.items)
          ? parsed.items
          : null;
    if (!claims) return { error: `fixture ${opts.fixture}: expected an array or {claims:[...]}` };
    return { claims, source: opts.fixture };
  }
  const url = `${opts.base.replace(/\/+$/, "")}/api/rooms/${encodeURIComponent(opts.room)}/work-claims?limit=200`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    return { error: `board unreachable (${url}): ${err.message}` };
  }
  if (!res.ok) return { error: `board returned HTTP ${res.status} (${url})` };
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { error: `board returned non-JSON: ${err.message}` };
  }
  if (body && typeof body === "object" && body.error) {
    const msg = body.error.message ?? body.error.code ?? JSON.stringify(body.error);
    return { error: `board returned an error payload: ${msg}` };
  }
  const claims = Array.isArray(body) ? body : (body.claims ?? body.items ?? []);
  return { claims, source: url };
}

function activeClaims(claims) {
  return claims.filter((c) => c && !CLOSED_STATES.has(String(c.state ?? "").toLowerCase()));
}

// Normalize one `files` entry to { path, label } | null.
function normalizeEntry(entry) {
  if (typeof entry === "string") return scope(entry, null);
  if (entry && typeof entry === "object" && typeof entry.path === "string") {
    const label = entry.block ?? entry.region ?? null;
    return scope(entry.path, label == null ? null : String(label));
  }
  return null;
}

function scope(rawPath, label) {
  let p = String(rawPath).trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return null;
  return { path: p, label };
}

function entriesOf(claim) {
  const files = claim.files;
  if (!Array.isArray(files) || files.length === 0) return null; // unpartitionable
  const out = [];
  for (const e of files) {
    const n = normalizeEntry(e);
    if (n) out.push(n);
  }
  return out.length > 0 ? out : null;
}

// Two scopes overlap when their paths are equal or one covers the other by
// path prefix — unless they are the same path with two different labels.
function scopesOverlap(a, b) {
  if (a.label !== null && b.label !== null && a.label !== b.label && a.path === b.path) {
    return false; // two different labels on the same path do not conflict
  }
  if (a.path === b.path) return true;
  return b.path.startsWith(a.path + "/") || a.path.startsWith(b.path + "/");
}

function describeScope(s) {
  return s.label == null ? s.path : `${s.path} [${s.label}]`;
}

function check(claims) {
  const active = activeClaims(claims);
  const unpartitionable = [];
  const holders = []; // [{ id, scopes }]
  for (const c of active) {
    const id = String(c.id ?? c.claimId ?? "(unknown id)");
    const scopes = entriesOf(c);
    if (!scopes) unpartitionable.push({ id, state: c.state ?? "unknown" });
    else holders.push({ id, scopes });
  }
  const overlaps = [];
  for (let i = 0; i < holders.length; i++) {
    for (let j = i + 1; j < holders.length; j++) {
      const A = holders[i];
      const B = holders[j];
      const hits = [];
      for (const sa of A.scopes) {
        for (const sb of B.scopes) {
          if (scopesOverlap(sa, sb)) {
            hits.push(`${describeScope(sa)} ~ ${describeScope(sb)}`);
          }
        }
      }
      if (hits.length > 0) overlaps.push({ claims: [A.id, B.id], scopes: hits });
    }
  }
  return { active: active.length, unpartitionable, overlaps };
}

function humanReport(result, source) {
  const lines = [];
  lines.push(`scope-partition: ${result.active} active claim(s) from ${source}`);
  if (result.overlaps.length > 0) {
    lines.push(`\nOVERLAP — ${result.overlaps.length} colliding claim pair(s):`);
    for (const o of result.overlaps) {
      lines.push(`  - ${o.claims[0]}  <->  ${o.claims[1]}`);
      for (const s of o.scopes) lines.push(`      ${s}`);
    }
  } else {
    lines.push("no overlapping scopes.");
  }
  if (result.unpartitionable.length > 0) {
    lines.push(`\nUNPARTITIONABLE — ${result.unpartitionable.length} active claim(s) with missing/empty \`files\`:`);
    for (const u of result.unpartitionable) {
      lines.push(`  ! ${u.id} (state: ${u.state}) — declare file scopes at brief time; this claim cannot be verified disjoint`);
    }
    lines.push("Partition all file scopes at brief time, then re-run this check.");
  }
  return lines.join("\n");
}

const opts = parseArgs(process.argv.slice(2));
const loaded = await loadClaims(opts);
if (loaded.error) {
  if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: loaded.error }) + "\n");
  else process.stderr.write(`scope-partition: ERROR: ${loaded.error}\n`);
  process.exit(3);
}

const result = check(loaded.claims);
if (opts.json) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: result.overlaps.length === 0 && result.unpartitionable.length === 0,
        source: loaded.source,
        activeClaims: result.active,
        overlaps: result.overlaps,
        unpartitionable: result.unpartitionable,
      },
      null,
      2
    ) + "\n"
  );
} else {
  process.stdout.write(humanReport(result, loaded.source) + "\n");
  if (result.unpartitionable.length > 0 && result.overlaps.length === 0) {
    process.stderr.write(
      `scope-partition: WARNING: ${result.unpartitionable.length} unpartitionable claim(s) — overlap check is not exhaustive.\n`
    );
  }
}

if (result.overlaps.length > 0) process.exit(2);
if (result.unpartitionable.length > 0) process.exit(1);
process.exit(0);
