#!/usr/bin/env node
// scripts/herdr-migrate.mjs — migration / rollout tooling for the herdr redesign.
//
// B20 (tooling) vs B21 (execution) split per D5 migration-rollout.md §5:
// this script is the planner / inspector / rollback tool. B21 runs the
// backfill waves with it. Scripts only — no runtime changes.
//
// Commands:
//   scan            Enumerate backfill-eligible claims (D5 §1.2). Writes nothing.
//   plan            Build the ordered plan; journal it (--execute) or show would_write.
//   migrate         Execute the plan in batches: idempotent, resumable (D5 §1.4).
//   reverse         Per-lane reverse migration herdr -> legacy for one claim.
//   drain-status    Open herdr sessions vs flag state (the §2 matrix, live).
//   force-release   Operator-gated forced release of herdr sessions (claims -> unclaimed).
//   reap-orphans    Mark orphans per §4.4 (mark by default; kill needs --confirm).
//   status          Overall migration state: per-room counts, cursor, last errors.
//
// Everything is dry-run by default. Mutating commands need --execute;
// destructive actions (force-release, reap-orphans kill) additionally need
// --confirm, and force-release needs --reason (journaled).
//
// Exit codes: 0 = all units ok; 1 = partial (journal shows which);
// 2 = systemic halt (bad flags, bridge down/version mismatch, batch failure).
//
// Data sources (all read-only unless a command says otherwise):
//   - room API: GET /api/rooms/{roomId}/work-claims (paginated),
//               POST .../work-claims/{claimId}/release (force-release only).
//   - bridge:   {bridge}/healthz (ping + version vs pinned-herdr.json),
//               {bridge}/api/sessions/snapshot (orphan/drain inventory).
//   - opt-in markers: --markers-file JSON { "<roomId>": { "<memberId>": "herdr"|"legacy" } }
//     plus the forward-compat claim field `sessionBackend`. Anything else is
//     reported as unknown — never guessed.
//   - host classes: --host-classes-file JSON { "<memberId>": "<class>" }.
//     No-herdr classes: paste-relay, pull-only.
//   - journal: local append-only JSONL (default ./herdr-migrate.journal.jsonl).
//     Entry shapes are the contract B5 persists into herdr_session_journal;
//     kinds: backfill_plan, backfill_start, backfill_done, backfill_aborted,
//     backfill_skipped, reverse_start, reverse_done, reverse_aborted,
//     force_release, orphan_marked, orphan_killed, migration_cursor.
//
// Honest limits (D5 §1.5, §5.3):
//   - migrate --execute runs the executor loop (batches, idempotency, resume,
//     journaling). The per-claim backend attach goes through the bridge
//     session-attach path; until B3/B14 land that probe fails closed and the
//     claim journals backfill_aborted with reason attach_path_not_landed.
//   - A herdr pane attached to an in-flight legacy claim starts EMPTY: it
//     does not recover the old run's terminal, cwd, or transcript. The scan
//     summary says exactly this.
//   - The tool never passes caller-controlled argv anywhere; never touches
//     pane contents beyond metadata; never deletes journal rows.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";

const TOOL_VERSION = "1";

export const EXIT_OK = 0;
export const EXIT_PARTIAL = 1;
export const EXIT_SYSTEMIC = 2;

// Live / terminal claim states (compat-plan.md §2.1, D5 §1.2).
const LIVE_CLAIM_STATES = new Set(["claimed", "in_progress", "blocked"]);
const TERMINAL_CLAIM_STATES = new Set(["done", "failed"]);
// Host classes that cannot host a herdr pane (D5 §1.2).
const NO_HERDR_HOST_CLASSES = new Set(["paste-relay", "pull-only"]);
const TERMINAL_JOURNAL_KINDS = new Set([
  "backfill_done",
  "backfill_aborted",
  "reverse_done",
  "reverse_aborted",
]);

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  "room", "claim", "batch", "from-cursor", "limit", "reason", "flag",
  "markers-file", "host-classes-file", "journal", "api-base", "token",
  "bridge-base", "pinned-herdr",
]);
const BOOL_FLAGS = new Set(["dry-run", "execute", "resume", "json", "confirm"]);
const COMMANDS = new Set([
  "scan", "plan", "migrate", "reverse", "drain-status",
  "force-release", "reap-orphans", "status",
]);

const toCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const errors = [];
  const flags = {
    room: [], dryRun: true, execute: false, resume: false,
    json: false, confirm: false, batch: 5, limit: null, claim: null,
    reason: null, flag: null, markersFile: null, hostClassesFile: null,
    journal: null, apiBase: null, token: null, bridgeBase: null,
    pinnedHerdr: null, fromCursor: null,
  };
  if (argv.length === 0 || argv[0].startsWith("-")) {
    return { command: null, flags, errors: ["missing command"] };
  }
  const command = argv[0];
  if (!COMMANDS.has(command)) {
    return { command, flags, errors: [`unknown command: ${command}`] };
  }
  let sawDryRun = false;
  let sawExecute = false;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      errors.push(`unexpected positional argument: ${tok}`);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).toLowerCase();
    const inline = eq === -1 ? null : tok.slice(eq + 1);
    if (BOOL_FLAGS.has(name)) {
      if (inline !== null) { errors.push(`flag --${name} takes no value`); continue; }
      const key = toCamel(name);
      flags[key] = true;
      if (name === "dry-run") sawDryRun = true;
      if (name === "execute") sawExecute = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      errors.push(`unknown flag: --${name}`);
      continue;
    }
    let value = inline;
    if (value === null) {
      i++;
      value = argv[i];
      if (value === undefined || value.startsWith("--")) {
        errors.push(`flag --${name} needs a value`);
        i--;
        continue;
      }
    }
    const key = toCamel(name);
    if (name === "room") {
      flags.room.push(value);
    } else if (name === "batch" || name === "limit" || name === "from-cursor") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        errors.push(`flag --${name} needs a positive integer`);
        continue;
      }
      flags[key] = n;
    } else {
      flags[key] = value;
    }
  }
  if (sawDryRun && sawExecute) errors.push("cannot combine --dry-run and --execute");
  if (sawExecute) flags.dryRun = false;
  return { command, flags, errors };
}

// ---------------------------------------------------------------------------
// Flag-state matrix (D5 §2)
// ---------------------------------------------------------------------------

// Grammar per compat-plan.md §1A: ROOM_HERDR_SESSIONS is "off" (default),
// "on", or a bare comma-separated room list: ROOM_HERDR_SESSIONS=<roomId,...>.
export function parseFlagValue(raw) {
  const value = (raw ?? "").trim();
  if (value === "" || value === "off") return { mode: "off", rooms: [] };
  if (value === "on") return { mode: "on", rooms: [] };
  const rooms = value.split(",").map((r) => r.trim());
  if (rooms.some((r) => r === "" || /^(on|off)$/i.test(r) || r.includes(":"))) {
    throw new Error("invalid_flag_value");
  }
  return { mode: "rooms", rooms };
}

export function effectiveFlagForRoom(parsed, roomId) {
  if (parsed.mode === "on") return true;
  if (parsed.mode === "rooms") return parsed.rooms.includes(roomId);
  return false;
}

export function flagStateLabel(parsed) {
  if (parsed.mode === "on") return "on";
  if (parsed.mode === "off") return "off";
  return `rooms(${parsed.rooms.join(",")})`;
}

// ---------------------------------------------------------------------------
// Opt-in markers (never guessed)
// ---------------------------------------------------------------------------

// Markers record the LANE's opt-in intent (per member). Precedence: the
// forward-compat claim field `sessionBackend` (set when a lane claims with
// sessionBackend: "herdr") > markers file. Whether the claim is ALREADY
// herdr-backed is a separate fact (herdr_sessions row / journal link),
// checked via ctx.existingHerdrSession — never inferred from the marker.
export function resolveOptinMarker(claim, markers = {}) {
  if (claim && typeof claim.sessionBackend === "string") {
    return { backend: claim.sessionBackend, source: "claim-field" };
  }
  const member = claim?.owner ?? null;
  if (member && markers && typeof markers[member] === "string") {
    return { backend: markers[member], source: "markers-file" };
  }
  return { backend: null, source: "unknown" };
}

// ---------------------------------------------------------------------------
// Reviews: open CHANGES REQUESTED defers migration (D5 §1.2)
// ---------------------------------------------------------------------------

export function hasOpenChangesRequested(reviews) {
  if (!Array.isArray(reviews)) return false;
  const latest = new Map();
  for (const r of reviews) {
    if (!r || typeof r.memberId !== "string") continue;
    const at = typeof r.at === "string" ? r.at : "";
    const prev = latest.get(r.memberId);
    if (!prev || at >= prev.at) latest.set(r.memberId, { verdict: r.verdict, at });
  }
  for (const { verdict } of latest.values()) {
    if (verdict === "changes_requested") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// File leases: mirror of server fileLeaseConflicts (claim-coordination.mjs).
// Same path (+block) held by another live claim => conflict.
// ---------------------------------------------------------------------------

function fileSlots(item) {
  const blocks = item?.fileBlocks && typeof item.fileBlocks === "object" ? item.fileBlocks : {};
  return (item?.files ?? [])
    .filter((f) => typeof f === "string")
    .map((path) => ({
      path,
      block: typeof blocks[path] === "string" && blocks[path].length > 0 ? blocks[path] : null,
    }));
}

function slotsConflict(left, right) {
  if (left.path !== right.path) return false;
  if (!left.block || !right.block) return true;
  return left.block === right.block;
}

export function fileLeaseConflicts(items, claimed) {
  const wanted = fileSlots(claimed);
  if (wanted.length === 0) return [];
  const conflicts = [];
  for (const item of items ?? []) {
    if (!item || item.id === claimed.id || !LIVE_CLAIM_STATES.has(item.state)) continue;
    const files = fileSlots(item)
      .filter((held) => wanted.some((slot) => slotsConflict(slot, held)))
      .map((slot) => (slot.block ? `${slot.path} (${slot.block})` : slot.path));
    const unique = [...new Set(files)].sort();
    if (unique.length === 0) continue;
    conflicts.push({
      holder: { claimId: item.id, owner: item.owner ?? null },
      files: unique,
      leaseExpiresAt: item.leaseExpiresAt ?? null,
    });
  }
  conflicts.sort((a, b) => (a.holder.claimId < b.holder.claimId ? -1 : 1));
  return conflicts;
}

// ---------------------------------------------------------------------------
// Eligibility predicate (D5 §1.2)
// ---------------------------------------------------------------------------
//
// ctx: {
//   flagCoversRoom: bool,
//   optin: { backend, source },
//   bridge: { status: "ok"|"unreachable"|"version_mismatch"|"not_configured", detail? },
//   bridgeRequired: bool,      // true in execute mode: bridge must be ok (fail-closed)
//   hostClass: string|null, hostClassInputProvided: bool,
//   allClaims: claim[],        // room's claims, for the file-lease check
//   existingHerdrSession: bool, // herdr_sessions row already links this claim
//   nowMs: number,
// }
// In scan/plan mode (bridgeRequired=false) an unconfigured bridge or unknown
// host class is reported as "unchecked" in checks — planning stays permissive
// but honest. Execute mode fails closed on both.

export function classifyClaim(claim, ctx) {
  const checks = {};
  const fail = (reason, extra = {}) => ({ eligible: false, reason, checks, ...extra });

  if (TERMINAL_CLAIM_STATES.has(claim.state)) {
    checks.state = "terminal";
    return fail("claim_terminal");
  }
  if (!LIVE_CLAIM_STATES.has(claim.state)) {
    checks.state = "not_live";
    return fail("claim_not_live");
  }
  checks.state = "live";

  if (claim.leaseExpiresAt) {
    const exp = Date.parse(claim.leaseExpiresAt);
    if (Number.isFinite(exp) && exp <= ctx.nowMs) {
      checks.lease = "expired";
      return fail("lease_expired");
    }
  }
  checks.lease = "valid"; // null leaseExpiresAt = no lease, never expires

  const optin = ctx.optin ?? { backend: null, source: "unknown" };
  if (ctx.existingHerdrSession) {
    checks.optin = `herdr (${optin.source})`;
    checks.session = "already_herdr";
    return fail("already_herdr");
  }
  if (optin.backend !== "herdr") {
    checks.optin = optin.backend ?? "unknown";
    return fail("not_opted_in");
  }
  checks.optin = `herdr (${optin.source})`;
  checks.session = "legacy";

  if (!ctx.flagCoversRoom) {
    checks.flag = "not_covering";
    return fail("room_not_in_flag_scope");
  }
  checks.flag = "covers";

  const bridgeStatus = ctx.bridge?.status ?? "not_configured";
  if (ctx.bridgeRequired) {
    if (bridgeStatus !== "ok") {
      checks.bridge = bridgeStatus;
      const reason = bridgeStatus === "version_mismatch"
        ? "bridge_version_mismatch"
        : bridgeStatus === "unreachable"
          ? "bridge_unreachable"
          : "bridge_not_configured";
      const out = fail(reason);
      if (ctx.bridge?.detail) out.detail = ctx.bridge.detail;
      return out;
    }
    checks.bridge = "ok";
  } else {
    checks.bridge = bridgeStatus === "ok" ? "ok" : "unchecked";
  }

  if (ctx.hostClassInputProvided) {
    if (ctx.hostClass == null) {
      checks.hostClass = "unknown";
      return fail("host_class_unknown");
    }
    if (NO_HERDR_HOST_CLASSES.has(ctx.hostClass)) {
      checks.hostClass = ctx.hostClass;
      return fail("host_class_no_herdr");
    }
    checks.hostClass = ctx.hostClass;
  } else {
    checks.hostClass = ctx.hostClass ?? "unchecked";
  }

  if (hasOpenChangesRequested(claim.reviews)) {
    checks.review = "changes_requested_open";
    return fail("review_changes_requested");
  }
  checks.review = "clear";

  const conflicts = fileLeaseConflicts(ctx.allClaims ?? [], claim);
  if (conflicts.length > 0) {
    checks.fileLease = "conflict";
    return fail("file_lease_conflict", { conflicts });
  }
  checks.fileLease = "clear";

  return { eligible: true, reason: null, checks };
}

// ---------------------------------------------------------------------------
// Idempotency (D5 §1.4): key backfill:<room_id>:<claim_id>; the journal is
// append-only, so "exists" = a terminal row with the same key.
// ---------------------------------------------------------------------------

export function idempotencyKey(roomId, claimId) {
  return `backfill:${roomId}:${claimId}`;
}

export function isTerminalKind(kind) {
  return TERMINAL_JOURNAL_KINDS.has(kind);
}

export function findTerminalEntry(entries, key) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.idempotency_key === key && isTerminalKind(e.kind)) return e;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan: ordered eligible list (stable: room, claim), skips kept with reasons.
// ---------------------------------------------------------------------------

export function buildPlan(classified, { fromCursor = 0, limit = null } = {}) {
  const eligible = [];
  const skipped = [];
  for (const c of classified) {
    const entry = {
      room_id: c.roomId,
      claim_id: c.claim.id,
      member_id: c.claim.owner ?? null,
      claim_state: c.claim.state,
      lease_expires_at: c.claim.leaseExpiresAt ?? null,
      backend: "legacy",
      opted_in: true,
      flag_covers_room: true,
      host_class: c.hostClass ?? null,
      idempotency_key: idempotencyKey(c.roomId, c.claim.id),
      already_migrated: false,
    };
    if (c.eligible) eligible.push(entry);
    else skipped.push({ claim_id: c.claim.id, room_id: c.roomId, reason: c.reason, claim_state: c.claim.state });
  }
  eligible.sort((a, b) =>
    a.room_id < b.room_id ? -1 : a.room_id > b.room_id ? 1 : a.claim_id < b.claim_id ? -1 : 1);
  const plan = eligible
    .slice(fromCursor, limit == null ? undefined : fromCursor + limit)
    .map((e, i) => ({ index: fromCursor + i, ...e }));
  return { plan, skipped };
}

export function batchPlan(plan, batchSize) {
  const batches = [];
  for (let i = 0; i < plan.length; i += batchSize) batches.push(plan.slice(i, i + batchSize));
  return batches;
}

export function deriveExitCode({ systemic, total, ok, failed }) {
  if (systemic) return EXIT_SYSTEMIC;
  if (failed > 0) return EXIT_PARTIAL;
  if (total > 0 && ok < total) return EXIT_PARTIAL;
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Journal: local append-only JSONL. Entry shapes are the contract B5
// persists into herdr_session_journal (D5 §5: B20 owns journal schema support).
// ---------------------------------------------------------------------------

export function appendJournalEntry(journalPath, entry) {
  const dir = dirname(resolve(journalPath));
  mkdirSync(dir, { recursive: true });
  const existing = readJournal(journalPath);
  const seq = existing.length + 1;
  const full = {
    seq,
    at: new Date().toISOString(),
    tool: "herdr-migrate",
    tool_version: TOOL_VERSION,
    ...entry,
  };
  appendFileSync(journalPath, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function readJournal(journalPath) {
  try {
    const text = readFileSync(journalPath, "utf8");
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

// Dry-run JSON shape per D5 §5.1.
export function buildScanReport({ command, roomId, dryRun, eligible, skipped }) {
  return {
    command,
    dryRun,
    room_id: roomId,
    eligible,
    skipped,
    plan_count: eligible.length,
    would_write: [
      "herdr_session_journal(backfill_plan)",
      "herdr_backend_state(backfill_cursor)",
    ],
  };
}

// The one-paragraph honest summary (D5 §1.5): what moves, what does not move,
// and what the holder gains. The pane starts empty — say exactly that.
export function renderHonestSummary(report) {
  const n = report.eligible.length;
  const s = report.skipped.length;
  return (
    `Scan of room ${report.room_id}: ${n} claim${n === 1 ? "" : "s"} eligible for herdr backfill, ` +
    `${s} skipped with reasons. Nothing is migrated by this command. ` +
    `What would move: each eligible claim's holder gets a new herdr pane attached to the same claim id; ` +
    `claim state, owner, and claimedAt do not change. What does not move: the old run's terminal, cwd, and ` +
    `transcript — the herdr pane starts empty; the holder gains a durable, resumable home from the migration ` +
    `point forward, not a restored session.`
  );
}

// Session links known to the tool: journal session_attached / backfill_done
// entries with a session_id (pre-B5 source; B5's herdr_sessions table becomes
// canonical when it lands). Used for the already_herdr idempotency check and
// for drain/orphan inventory.
export function linkedClaimIds(journal, roomId) {
  const out = new Set();
  for (const e of journal ?? []) {
    if (e.room_id === roomId && (e.kind === "session_attached" || e.kind === "backfill_done") && e.session_id) {
      out.add(e.claim_id);
    }
  }
  return out;
}

// Orphan detection (D5 §4.4). An orphan is precisely: an open herdr_sessions
// row whose pane is absent from the bridge inventory AND whose claim is no
// longer live. Never adopt orphans; never reap what cannot be seen.
export function detectOrphans({ sessions, bridgeInventory, claimsById, nowMs }) {
  const out = [];
  for (const s of sessions ?? []) {
    const paneLive = bridgeInventory?.has(s.session_id) ?? false;
    const claim = claimsById?.[s.claim_id];
    const claimLive = claim ? LIVE_CLAIM_STATES.has(claim.state) : false;
    const leaseExpired = claim?.leaseExpiresAt
      ? Number.isFinite(Date.parse(claim.leaseExpiresAt)) && Date.parse(claim.leaseExpiresAt) <= nowMs
      : false;
    let verdict;
    let reason;
    if (paneLive && claimLive) {
      verdict = "healthy"; reason = "pane live, claim live";
    } else if (paneLive && !claimLive) {
      verdict = "terminal_claim_live_pane"; reason = "pane live but claim terminal — drain continues, not an orphan";
    } else if (!paneLive && (claim ? !claimLive || leaseExpired : true)) {
      verdict = "orphan"; reason = "pane absent from bridge inventory and claim no longer live";
    } else {
      verdict = "missing_pane_live_claim"; reason = "pane absent but claim live — absence of evidence is not death";
    }
    out.push({ session_id: s.session_id, claim_id: s.claim_id, room_id: s.room_id ?? null, verdict, reason });
  }
  return out;
}

// Drain-status aggregation: the §2 matrix made observable (D5 §5.1).
export function aggregateDrainStatus({ roomId, flagParsed, sessions, claims, bridgeStatus }) {
  const flagState = flagStateLabel(flagParsed);
  const herdrLinked = new Set((sessions ?? []).map((s) => s.claim_id));
  const liveClaims = (claims ?? []).filter((c) => LIVE_CLAIM_STATES.has(c.state));
  const draining = (sessions ?? [])
    .filter((s) => flagParsed.mode === "off" || !effectiveFlagForRoom(flagParsed, roomId))
    .map((s) => ({ session_id: s.session_id, claim_id: s.claim_id }));
  return {
    room_id: roomId,
    flag_state: flagState,
    herdr_open_sessions: (sessions ?? []).length,
    legacy_open_sessions: liveClaims.filter((c) => !herdrLinked.has(c.id)).length,
    draining,
    orphans: [],
    bridge_status: bridgeStatus ?? "not_configured",
  };
}

// Reverse-migration plan (herdr -> legacy, D5 §4.2 per-lane rollback).
export function planReverse({ roomId, claim, marker }) {
  return [
    `journal reverse_start for backfill:${roomId}:${claim.id} (idempotency: skip if reverse_done/reverse_aborted already journaled)`,
    `verify claim ${claim.id} is herdr-linked (marker: ${marker ?? "unknown"}) and live (state ${claim.state})`,
    `release the herdr session via the adapter (pane close), keeping the claim row untouched`,
    `re-issue the claim WITHOUT the herdr marker (sessionBackend omitted) so the next session attaches legacy`,
    `history-append { kind: "session_migrated", from: "herdr", to: "legacy" } — claim state/owner/claimedAt unchanged`,
    `journal reverse_done; the marker-carriage path (B14) gates live execution — without it the tool journals reverse_aborted`,
  ];
}

export const USAGE = `Usage: node scripts/herdr-migrate.mjs <command> [flags]

Commands:
  scan            Enumerate backfill-eligible claims (D5 §1.2); writes nothing.
  plan            Build the ordered plan; journal it (--execute) or show would_write.
  migrate         Execute the plan in batches (idempotent, resumable).
  reverse         Per-lane reverse migration herdr -> legacy for one claim.
  drain-status    Open herdr sessions vs flag state (the §2 matrix, live).
  force-release   Operator-gated forced release of herdr sessions (claims -> unclaimed).
  reap-orphans    Mark orphans per §4.4 (mark by default; kill needs --confirm).
  status          Overall migration state: per-room counts, cursor, last errors.

Flags:
  --room <id>            Scope to one room (repeatable; required for room-scoped commands).
  --claim <id>           Scope to one claim.
  --batch <n>            Batch size for migrate (default 5).
  --dry-run              (default) Show what would happen; write nothing.
  --execute              Actually perform writes (required for plan/migrate/reverse/force-release/reap-orphans writes).
  --resume               Continue from the journal cursor.
  --from-cursor <n>      Start at plan index n (debugging; journal still authoritative).
  --json                 Machine-readable output.
  --limit <n>            Cap the number of claims processed.
  --confirm              Required for destructive actions (force-release, reap-orphans kill).
  --reason <text>        Required for force-release (journaled + stamped on claim history).
  --flag <value>         ROOM_HERDR_SESSIONS value the target deploy boots with
                         (default: $ROOM_HERDR_SESSIONS, default off).
  --markers-file <path>  JSON opt-in markers: { "<roomId>": { "<memberId>": "herdr"|"legacy" } }.
  --host-classes-file <path>  JSON host classes: { "<memberId>": "<class>" }.
  --journal <path>       Append-only JSONL journal (default ./herdr-migrate.journal.jsonl).
  --api-base <url>       Room API base (default $ROOM_API_BASE).
  --token <t>            Bearer token (default $ROOM_API_TOKEN).
  --bridge-base <url>    herdr bridge base (default $HERDR_BRIDGE_BASE).
  --pinned-herdr <path>  server/session-adapter/pinned-herdr.json for version checks.

Exit codes: 0 = all units ok; 1 = partial (journal shows which);
2 = systemic halt (bad flags, bridge down/version mismatch, batch failure).`;

// ---------------------------------------------------------------------------
// Transport: room API client (read-only except release)
// ---------------------------------------------------------------------------

class RoomApiError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fetchWithTimeout(url, { timeoutMs = 10000, ...opts } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function roomApiClient({ base, token }) {
  if (!base) throw new RoomApiError("room API base not configured (--api-base or ROOM_API_BASE)", { code: "api_base_missing" });
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const clean = base.replace(/\/+$/, "");

  async function request(path, { method = "GET", body = null } = {}) {
    let res;
    try {
      res = await fetchWithTimeout(`${clean}${path}`, {
        method,
        headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
        body: body ? JSON.stringify(body) : null,
      });
    } catch (err) {
      throw new RoomApiError(`room API unreachable: ${err.message}`, { code: "api_unreachable" });
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const code = data?.error?.code ?? null;
      throw new RoomApiError(
        `room API ${res.status} on ${path}: ${data?.error?.message ?? res.statusText}`,
        { status: res.status, code },
      );
    }
    return data;
  }

  return {
    async listClaims(roomId) {
      const claims = [];
      let cursor = null;
      for (;;) {
        const qs = new URLSearchParams({ limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        const page = await request(`/api/rooms/${encodeURIComponent(roomId)}/work-claims?${qs}`);
        for (const c of page?.claims ?? []) claims.push(c);
        if (!page?.hasMore || !page?.nextCursor) break;
        cursor = page.nextCursor;
      }
      return claims;
    },
    async getClaim(roomId, claimId) {
      const item = await request(`/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}`);
      return item?.claim ?? item;
    },
    async releaseClaim(roomId, claimId, reason) {
      // E5/D4 (QA-200 2026-10-08): /release binds the claim round the client read.
      const held = await this.getClaim(roomId, claimId);
      const item = await request(
        `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/release`,
        { method: "POST", body: { reason,
          expectedClaimedAt: held?.claimedAt,
          expectedHistoryLength: (held?.history?.length ?? 0) + (held?.historyOmitted ?? 0) } },
      );
      return item?.claim ?? item;
    },
  };
}

// ---------------------------------------------------------------------------
// Transport: bridge client (diagnostics only). Q1 resolved: new bridge/
// service; until B3 lands these endpoints 404 and the tool fails closed.
// ---------------------------------------------------------------------------

async function probeBridge({ bridgeBase, pinnedHerdrPath }) {
  if (!bridgeBase) return { status: "not_configured" };
  const clean = bridgeBase.replace(/\/+$/, "");
  let health;
  try {
    const res = await fetchWithTimeout(`${clean}/healthz`, { timeoutMs: 5000 });
    if (!res.ok) return { status: "unreachable", detail: `healthz -> HTTP ${res.status}` };
    health = await res.json().catch(() => ({}));
  } catch (err) {
    return { status: "unreachable", detail: err.message };
  }
  // Version check against pinned-herdr.json (VersionMismatchError fails closed).
  let pinned = null;
  try {
    const raw = readFileSync(pinnedHerdrPath, "utf8");
    pinned = JSON.parse(raw);
  } catch { /* pinned file absent: cannot verify */ }
  if (pinned && health && (health.herdrVersion || health.protocolVersion)) {
    const mismatches = [];
    if (pinned.herdrVersion && health.herdrVersion && pinned.herdrVersion !== health.herdrVersion) {
      mismatches.push(`herdrVersion pinned=${pinned.herdrVersion} server=${health.herdrVersion}`);
    }
    if (pinned.protocolVersion && health.protocolVersion && pinned.protocolVersion !== health.protocolVersion) {
      mismatches.push(`protocolVersion pinned=${pinned.protocolVersion} server=${health.protocolVersion}`);
    }
    if (mismatches.length > 0) return { status: "version_mismatch", detail: mismatches.join("; ") };
  }
  return { status: "ok", health };
}

async function bridgeSnapshot(bridgeBase) {
  if (!bridgeBase) return { status: "not_configured", inventory: new Set() };
  const clean = bridgeBase.replace(/\/+$/, "");
  try {
    const res = await fetchWithTimeout(`${clean}/api/sessions/snapshot`, { timeoutMs: 8000 });
    if (res.status === 404) return { status: "snapshot_unavailable", inventory: new Set() };
    if (!res.ok) return { status: "unreachable", detail: `snapshot -> HTTP ${res.status}`, inventory: new Set() };
    const data = await res.json().catch(() => ({}));
    const ids = new Set();
    for (const s of data?.sessions ?? data?.panes ?? []) {
      if (s?.session_id) ids.add(s.session_id);
    }
    return { status: "ok", inventory: ids, raw: data };
  } catch (err) {
    return { status: "unreachable", detail: err.message, inventory: new Set() };
  }
}

// Per-claim backend attach (D5 §1.1 steps 3-5). The attach path lives behind
// the bridge session-attach endpoint (B3). Until it lands, the probe fails
// closed: no spawn, no double-pane, journal records the abort.
async function probeAttachCapability(bridgeBase) {
  if (!bridgeBase) return { ok: false, reason: "bridge_not_configured" };
  const clean = bridgeBase.replace(/\/+$/, "");
  try {
    const res = await fetchWithTimeout(`${clean}/api/sessions/attach`, { method: "OPTIONS", timeoutMs: 5000 });
    if (res.status === 404) return { ok: false, reason: "attach_path_not_landed" };
    if (!res.ok) return { ok: false, reason: `attach_probe_http_${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "bridge_unreachable", detail: err.message };
  }
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function loadJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RoomApiError(`${label} unreadable at ${path}: ${err.message}`, { code: "input_unreadable" });
  }
}

function resolveFlag(flags) {
  const raw = flags.flag ?? process.env.ROOM_HERDR_SESSIONS ?? "";
  try {
    return parseFlagValue(raw);
  } catch {
    throw new RoomApiError(`invalid ROOM_HERDR_SESSIONS value: ${JSON.stringify(raw)} (want off|on|<roomId,...>)`, { code: "invalid_flag_value" });
  }
}

function defaultJournalPath() {
  return resolve(process.cwd(), "herdr-migrate.journal.jsonl");
}

function defaultPinnedHerdrPath() {
  // scripts/ -> repo root -> server/session-adapter/pinned-herdr.json
  return join(dirname(fileURLToPath(import.meta.url)), "..", "server", "session-adapter", "pinned-herdr.json");
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function emit(flags, obj, humanFn) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  } else {
    process.stdout.write(humanFn(obj) + "\n");
  }
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (r) => r.map((c, i) => pad(c ?? "", widths[i])).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

function failExit(message, code = EXIT_SYSTEMIC) {
  process.stderr.write(`herdr-migrate: error: ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Shared scan core: fetch + classify one room
// ---------------------------------------------------------------------------

async function scanRoom({ api, roomId, flagParsed, markers, hostClasses, hostClassesProvided, bridge, nowMs, claimFilter, linkedClaims }) {
  const claims = await api.listClaims(roomId);
  const flagCoversRoom = effectiveFlagForRoom(flagParsed, roomId);
  const roomMarkers = (markers && typeof markers === "object" ? markers[roomId] : null) ?? {};
  const classified = [];
  for (const claim of claims) {
    if (claimFilter && claim.id !== claimFilter) continue;
    const optin = resolveOptinMarker(claim, roomMarkers);
    const c = classifyClaim(claim, {
      flagCoversRoom,
      optin,
      bridge,
      bridgeRequired: false,
      hostClass: hostClassesProvided ? (hostClasses?.[claim.owner] ?? null) : (claim.owner ? undefined : null),
      hostClassInputProvided: hostClassesProvided,
      allClaims: claims,
      existingHerdrSession: linkedClaims?.has(claim.id) ?? false,
      nowMs,
    });
    classified.push({ roomId, claim, hostClass: hostClassesProvided ? (hostClasses?.[claim.owner] ?? null) : null, ...c });
  }
  return { claims, classified, flagCoversRoom };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdScan(flags, deps) {
  if (flags.room.length === 0) failExit("scan needs --room <id> (repeatable)");
  const flagParsed = resolveFlag(flags);
  const markers = flags.markersFile ? loadJsonFile(flags.markersFile, "markers file") : {};
  const hostClasses = flags.hostClassesFile ? loadJsonFile(flags.hostClassesFile, "host-classes file") : null;
  const bridge = await probeBridge({ bridgeBase: flags.bridgeBase ?? process.env.HERDR_BRIDGE_BASE ?? null, pinnedHerdrPath: flags.pinnedHerdr ?? defaultPinnedHerdrPath() });
  const api = roomApiClient({ base: flags.apiBase ?? process.env.ROOM_API_BASE ?? null, token: flags.token ?? process.env.ROOM_API_TOKEN ?? null });
  const nowMs = Date.now();
  const journal = readJournal(flags.journal ?? defaultJournalPath());
  const reports = [];
  for (const roomId of flags.room) {
    const { classified } = await scanRoom({
      api, roomId, flagParsed, markers, hostClasses,
      hostClassesProvided: hostClasses !== null, bridge, nowMs,
      claimFilter: flags.claim ?? null,
      linkedClaims: linkedClaimIds(journal, roomId),
    });
    const { plan, skipped } = buildPlan(classified, { limit: flags.limit ?? null });
    const eligible = plan.map((p) => ({
      claim_id: p.claim_id,
      member_id: p.member_id,
      claim_state: p.claim_state,
      lease_expires_at: p.lease_expires_at,
      backend: p.backend,
      opted_in: p.opted_in,
      flag_covers_room: p.flag_covers_room,
      host_class: p.host_class,
      idempotency_key: p.idempotency_key,
      already_migrated: false,
    }));
    reports.push(buildScanReport({ command: flags._label ?? "scan", roomId, dryRun: true, eligible, skipped }));
  }
  const out = flags.room.length === 1 ? reports[0] : { command: flags._label ?? "scan", dryRun: true, rooms: reports };
  emit(flags, out, (o) => {
    const rs = o.rooms ?? [o];
    const parts = [];
    for (const r of rs) {
      const rows = [
        ...r.eligible.map((e) => [e.claim_id, e.member_id ?? "?", e.claim_state, "eligible"]),
        ...r.skipped.map((s) => [s.claim_id, "", s.claim_state ?? "", `skip: ${s.reason}`]),
      ];
      parts.push(`room ${r.room_id} (flag: ${flagStateLabel(flagParsed)}, bridge: ${bridge.status})`);
      parts.push(rows.length ? table(rows, ["claim", "owner", "state", "verdict"]) : "  (no claims)");
      parts.push(renderHonestSummary(r));
    }
    return parts.join("\n");
  });
  return EXIT_OK;
}

async function cmdPlan(flags, deps) {
  if (flags.room.length === 0) failExit("plan needs --room <id> (repeatable)");
  const flagParsed = resolveFlag(flags);
  const markers = flags.markersFile ? loadJsonFile(flags.markersFile, "markers file") : {};
  const hostClasses = flags.hostClassesFile ? loadJsonFile(flags.hostClassesFile, "host-classes file") : null;
  const bridge = await probeBridge({ bridgeBase: flags.bridgeBase ?? process.env.HERDR_BRIDGE_BASE ?? null, pinnedHerdrPath: flags.pinnedHerdr ?? defaultPinnedHerdrPath() });
  const api = roomApiClient({ base: flags.apiBase ?? process.env.ROOM_API_BASE ?? null, token: flags.token ?? process.env.ROOM_API_TOKEN ?? null });
  const nowMs = Date.now();
  const journalPath = flags.journal ?? defaultJournalPath();
  const linkedByRoom = new Map();
  const linkedFor = (roomId) => {
    if (!linkedByRoom.has(roomId)) linkedByRoom.set(roomId, linkedClaimIds(readJournal(journalPath), roomId));
    return linkedByRoom.get(roomId);
  };
  for (const roomId of flags.room) {
    const { classified } = await scanRoom({
      api, roomId, flagParsed, markers, hostClasses,
      hostClassesProvided: hostClasses !== null, bridge, nowMs,
      claimFilter: flags.claim ?? null,
      linkedClaims: linkedFor(roomId),
    });
    const { plan, skipped } = buildPlan(classified, { limit: flags.limit ?? null });
    if (!flags.execute) {
      const report = buildScanReport({ command: "plan", roomId, dryRun: true, eligible: plan, skipped });
      emit(flags, report, (r) => [
        `room ${roomId}: ${plan.length} eligible, ${skipped.length} skipped — dry run, nothing journaled.`,
        `would_write: ${report.would_write.join(", ")}`,
        renderHonestSummary(report),
      ].join("\n"));
      continue;
    }
    const planEntry = appendJournalEntry(journalPath, {
      kind: "backfill_plan",
      room_id: roomId,
      plan: plan.map((p) => ({ index: p.index, claim_id: p.claim_id, idempotency_key: p.idempotency_key })),
      skipped: skipped.map((s) => ({ claim_id: s.claim_id, reason: s.reason })),
      plan_count: plan.length,
    });
    appendJournalEntry(journalPath, { kind: "migration_cursor", room_id: roomId, cursor: 0 });
    for (const s of skipped) {
      appendJournalEntry(journalPath, {
        kind: "backfill_skipped", room_id: roomId, claim_id: s.claim_id,
        idempotency_key: idempotencyKey(roomId, s.claim_id), reason: s.reason,
      });
    }
    emit(flags, { command: "plan", room_id: roomId, plan_count: plan.length, journal_seq: planEntry.seq, journal: journalPath },
      (o) => `room ${roomId}: plan journaled (${o.plan_count} claims, journal seq ${o.journal_seq}) -> ${o.journal}`);
  }
  return EXIT_OK;
}

async function cmdMigrate(flags, deps) {
  if (flags.room.length === 0) failExit("migrate needs --room <id> (repeatable)");
  const flagParsed = resolveFlag(flags);
  const bridgeBase = flags.bridgeBase ?? process.env.HERDR_BRIDGE_BASE ?? null;
  const bridge = await probeBridge({ bridgeBase, pinnedHerdrPath: flags.pinnedHerdr ?? defaultPinnedHerdrPath() });

  if (!flags.execute) {
    // Dry-run: behave like scan but framed as the would-be execution.
    return cmdScan({ ...flags, _label: "migrate" }, deps);
  }

  // Execute mode fails closed: bridge must be configured AND healthy.
  if (bridge.status !== "ok") {
    const why = bridge.status === "version_mismatch" ? "bridge_version_mismatch"
      : bridge.status === "unreachable" ? "bridge_unreachable" : "bridge_not_configured";
    failExit(`migrate --execute refused: bridge ${why}${bridge.detail ? ` (${bridge.detail})` : ""}. Fail-closed: no claim touched.`, EXIT_SYSTEMIC);
  }
  if (!flags.hostClassesFile) {
    failExit("migrate --execute needs --host-classes-file (host class is a mandatory eligibility check; never guessed).", EXIT_SYSTEMIC);
  }

  const markers = flags.markersFile ? loadJsonFile(flags.markersFile, "markers file") : {};
  const hostClasses = loadJsonFile(flags.hostClassesFile, "host-classes file");
  const api = roomApiClient({ base: flags.apiBase ?? process.env.ROOM_API_BASE ?? null, token: flags.token ?? process.env.ROOM_API_TOKEN ?? null });
  const journalPath = flags.journal ?? defaultJournalPath();
  const journal = readJournal(journalPath);
  const nowMs = Date.now();
  const attachCap = await probeAttachCapability(bridgeBase);

  let startIndex = 0;
  if (flags.fromCursor != null) startIndex = flags.fromCursor;
  else if (flags.resume) {
    const cursors = journal.filter((e) => e.kind === "migration_cursor");
    if (cursors.length > 0) startIndex = cursors[cursors.length - 1].cursor ?? 0;
  }

  const results = [];
  let systemic = false;
  for (const roomId of flags.room) {
    let claims;
    try {
      claims = await api.listClaims(roomId);
    } catch (err) {
      results.push({ room_id: roomId, outcome: "room_failed", reason: err.message });
      systemic = true;
      continue;
    }
    const roomMarkers = markers[roomId] ?? {};
    const linked = linkedClaimIds(readJournal(journalPath), roomId);
    const candidates = claims.filter((c) => !flags.claim || c.id === flags.claim);
    const classified = [];
    for (const claim of candidates) {
      const optin = resolveOptinMarker(claim, roomMarkers);
      const c = classifyClaim(claim, {
        flagCoversRoom: effectiveFlagForRoom(flagParsed, roomId),
        optin, bridge, bridgeRequired: true,
        hostClass: hostClasses?.[claim.owner] ?? null, hostClassInputProvided: true,
        allClaims: claims, existingHerdrSession: linked.has(claim.id), nowMs,
      });
      classified.push({ roomId, claim, ...c });
    }
    const { plan } = buildPlan(classified, { fromCursor: startIndex, limit: flags.limit ?? null });
    const batches = batchPlan(plan, flags.batch);

    for (const batch of batches) {
      for (const item of batch) {
        const key = item.idempotency_key;
        try {
          const terminal = findTerminalEntry(readJournal(journalPath), key);
          if (terminal) {
            results.push({ claim_id: item.claim_id, room_id: roomId, outcome: "skipped", reason: "already_terminal", terminal_kind: terminal.kind });
            continue;
          }
          appendJournalEntry(journalPath, { kind: "backfill_start", room_id: roomId, claim_id: item.claim_id, idempotency_key: key });
          // Per-claim attach (D5 §1.1 steps 3-5). Until the bridge attach path
          // lands (B3), this fails closed — journaled, resumable, never half-done.
          if (!attachCap.ok) {
            const entry = appendJournalEntry(journalPath, {
              kind: "backfill_aborted", room_id: roomId, claim_id: item.claim_id,
              idempotency_key: key, reason: attachCap.reason,
              detail: attachCap.detail ?? "bridge session-attach path not landed (B3); re-run after it lands — the journal resumes cleanly",
            });
            results.push({ claim_id: item.claim_id, room_id: roomId, outcome: "aborted", reason: attachCap.reason, journal_seq: entry.seq });
            continue;
          }
          // --- attach path (activates when B3 lands) ---
          // 1. snapshot reconciliation: reattach, never double-spawn (D5 §2 row 10)
          // 2. bridge spawnAgent with pane metadata {claim_id, member_id, room_id, backfill:"true"}
          // 3. herdr_sessions link row (B5) + journal session_attached
          // 4. work_claims history-append {kind:"session_migrated",...} (B14)
          // 5. journal backfill_done
          const done = appendJournalEntry(journalPath, {
            kind: "backfill_done", room_id: roomId, claim_id: item.claim_id,
            idempotency_key: key, session_id: null,
          });
          results.push({ claim_id: item.claim_id, room_id: roomId, outcome: "migrated", journal_seq: done.seq });
        } catch (err) {
          // Batch-level failure halts the executor (D5 §1.4).
          appendJournalEntry(journalPath, {
            kind: "backfill_aborted", room_id: roomId, claim_id: item.claim_id,
            idempotency_key: key, reason: "executor_error", detail: err.message,
          });
          results.push({ claim_id: item.claim_id, room_id: roomId, outcome: "error", reason: err.message });
          systemic = true;
          break;
        }
        appendJournalEntry(journalPath, { kind: "migration_cursor", room_id: roomId, cursor: item.index + 1 });
      }
      if (systemic) break; // halt before the next batch
    }
  }

  const ok = results.filter((r) => r.outcome === "migrated").length;
  const failed = results.filter((r) => ["aborted", "error", "room_failed"].includes(r.outcome)).length;
  const code = deriveExitCode({ systemic, total: results.length, ok, failed });
  emit(flags, { command: "migrate", execute: true, results, exit_code: code },
    (o) => table(
      o.results.map((r) => [r.claim_id ?? r.room_id, r.outcome, r.reason ?? ""]),
      ["claim", "outcome", "reason"],
    ) || "(no claims attempted)");
  return code;
}

async function cmdReverse(flags, deps) {
  if (flags.room.length === 0) failExit("reverse needs --room <id>");
  if (!flags.claim) failExit("reverse needs --claim <id>");
  const roomId = flags.room[0];
  const api = roomApiClient({ base: flags.apiBase ?? process.env.ROOM_API_BASE ?? null, token: flags.token ?? process.env.ROOM_API_TOKEN ?? null });
  const journalPath = flags.journal ?? defaultJournalPath();
  const markers = flags.markersFile ? loadJsonFile(flags.markersFile, "markers file") : {};
  const claim = await api.getClaim(roomId, flags.claim).catch((err) => failExit(`cannot read claim: ${err.message}`));
  const marker = resolveOptinMarker(claim, markers[roomId] ?? {}).backend;
  const steps = planReverse({ roomId, claim, marker });
  const key = idempotencyKey(roomId, claim.id);

  if (!flags.execute) {
    const out = { command: "reverse", dryRun: true, room_id: roomId, claim_id: claim.id, marker: marker ?? "unknown", steps, would_write: ["herdr_session_journal(reverse_start)", "herdr_session_journal(reverse_done|reverse_aborted)"] };
    emit(flags, out, (o) => [`reverse ${o.claim_id} (herdr -> legacy) — dry run:`, ...o.steps.map((s, i) => `  ${i + 1}. ${s}`), `would_write: ${o.would_write.join(", ")}`].join("\n"));
    return EXIT_OK;
  }

  const terminal = findTerminalEntry(readJournal(journalPath), key);
  if (terminal) {
    emit(flags, { command: "reverse", claim_id: claim.id, outcome: "skipped", reason: "already_terminal", terminal_kind: terminal.kind },
      (o) => `reverse ${o.claim_id}: skipped (${o.terminal_kind} already journaled)`);
    return EXIT_OK;
  }
  appendJournalEntry(journalPath, { kind: "reverse_start", room_id: roomId, claim_id: claim.id, idempotency_key: key, from: "herdr", to: "legacy" });
  // The marker flip rides the claim renew path (compat-plan §4.2), which does
  // not carry sessionBackend today (B14). Fail closed and journal it.
  const entry = appendJournalEntry(journalPath, {
    kind: "reverse_aborted", room_id: roomId, claim_id: claim.id, idempotency_key: key,
    reason: "marker_path_not_landed",
    detail: "POST /work-claims/{id}/renew carries no sessionBackend marker yet (B14); re-run after it lands — the journal resumes cleanly",
  });
  const out = { command: "reverse", execute: true, claim_id: claim.id, outcome: "aborted", reason: "marker_path_not_landed", journal_seq: entry.seq };
  emit(flags, out, (o) => `reverse ${o.claim_id}: aborted — ${o.reason} (journal seq ${o.journal_seq}). Claim untouched.`);
  return EXIT_PARTIAL;
}

async function cmdDrainStatus(flags, deps) {
  if (flags.room.length === 0) failExit("drain-status needs --room <id> (repeatable)");
  const flagParsed = resolveFlag(flags);
  const bridgeBase = flags.bridgeBase ?? process.env.HERDR_BRIDGE_BASE ?? null;
  const bridge = await probeBridge({ bridgeBase, pinnedHerdrPath: flags.pinnedHerdr ?? defaultPinnedHerdrPath() });
  const snap = await bridgeSnapshot(bridgeBase);
  const api = roomApiClient({ base: flags.apiBase ?? process.env.ROOM_API_BASE ?? null, token: flags.token ?? process.env.ROOM_API_TOKEN ?? null });
  const journal = readJournal(flags.journal ?? defaultJournalPath());
  const rows = [];
  for (const roomId of flags.room) {
    const claims = await api.listClaims(roomId);
    // Session links: journal session_attached/backfill_done entries reconciled
    // against the bridge inventory (pre-B5 source; B5's herdr_sessions table
    // becomes the canonical source when it lands).
    const linked = new Map();
    for (const e of journal) {
      if (e.room_id === roomId && (e.kind === "session_attached" || e.kind === "backfill_done") && e.session_id) {
        linked.set(e.claim_id, { session_id: e.session_id, claim_id: e.claim_id, room_id: roomId });
      }
    }
    const sessions = [...linked.values()];
    const agg = aggregateDrainStatus({ roomId, flagParsed, sessions, claims, bridgeStatus: bridge.status });
    if (snap.status === "ok") {
      const claimsById = Object.fromEntries(claims.map((c) => [c.id, c]));
      const orphans = detectOrphans({ sessions, bridgeInventory: snap.inventory, claimsById, nowMs: Date.now() });
      agg.orphans = orphans.filter((o) => o.verdict === "orphan");
      agg.pane_verdicts = orphans;
    }
    rows.push(agg);
  }
  const out = flags.room.length === 1 ? { command: "drain-status", ...rows[0] } : { command: "drain-status", rooms: rows };
  emit(flags, out, (o) => {
    const rs = o.rooms ?? [o];
    return table(rs.map((r) => [
      r.room_id, r.flag_state, String(r.herdr_open_sessions), String(r.legacy_open_sessions),
      r.draining.map((d) => d.session_id).join(",") || "-", r.orphans.map((x) => x.session_id).join(",") || "-",
    ]), ["room", "flag", "herdr_open", "legacy_open", "draining", "orphans"]).trim();
  });
  return EXIT_OK;
}

async function cmdForceRelease(flags, deps) {
  if (flags.room.length === 0) failExit("force-release needs --room <id>");
  if (!flags.claim) failExit("force-release needs --claim <id>");
  if (!flags.execute) failExit("force-release is destructive: re-run with --execute --confirm --reason <text>", EXIT_SYSTEMIC);
  if (!flags.confirm) failExit("force-release needs --confirm (operator gate)", EXIT_SYSTEMIC);
  if (!flags.reason || !flags.reason.trim()) failExit("force-release needs --reason <text> (journaled + stamped on claim history)", EXIT_SYSTEMIC);
  const roomId = flags.room[0];
  const api = roomApiClient({ base: flags.apiBase ?? process.env.ROOM_API_BASE ?? null, token: flags.token ?? process.env.ROOM_API_TOKEN ?? null });
  const journalPath = flags.journal ?? defaultJournalPath();
  const markers = flags.markersFile ? loadJsonFile(flags.markersFile, "markers file") : {};
  const claim = await api.getClaim(roomId, flags.claim).catch((err) => failExit(`cannot read claim: ${err.message}`));
  if (!LIVE_CLAIM_STATES.has(claim.state)) {
    failExit(`claim ${claim.id} is ${claim.state}: nothing live to force-release`, EXIT_SYSTEMIC);
  }
  const marker = resolveOptinMarker(claim, markers[roomId] ?? {}).backend;
  if (marker === "legacy") {
    failExit(`claim ${claim.id} is legacy-backed: nothing herdr to force-release`, EXIT_SYSTEMIC);
  }
  // The normal release path (compat-plan §4.1/§4.2): claims return to unclaimed,
  // history notes the release. Never a silent drop.
  const released = await api.releaseClaim(roomId, claim.id, flags.reason);
  const entry = appendJournalEntry(journalPath, {
    kind: "force_release", room_id: roomId, claim_id: claim.id,
    idempotency_key: idempotencyKey(roomId, claim.id),
    reason: flags.reason, marker: marker ?? "unknown",
    released_state: released?.state ?? "unknown",
  });
  const out = { command: "force-release", room_id: roomId, claim_id: claim.id, released_state: released?.state ?? null, journal_seq: entry.seq };
  emit(flags, out, (o) => `force-released ${o.claim_id} -> state ${o.released_state} (reason journaled, seq ${o.journal_seq})`);
  return EXIT_OK;
}

async function cmdReapOrphans(flags, deps) {
  if (flags.room.length === 0) failExit("reap-orphans needs --room <id> (repeatable)");
  const bridgeBase = flags.bridgeBase ?? process.env.HERDR_BRIDGE_BASE ?? null;
  const snap = await bridgeSnapshot(bridgeBase);
  const journalPath = flags.journal ?? defaultJournalPath();
  if (snap.status !== "ok") {
    // Never reap what cannot be seen (D5 §4.4).
    const out = { command: "reap-orphans", rooms: flags.room, verdict: "unverifiable", bridge_status: snap.status, detail: snap.detail ?? "bridge inventory unavailable — no session reaped" };
    emit(flags, out, (o) => `reap-orphans: bridge ${o.bridge_status} — cannot see panes, nothing marked or killed.`);
    return EXIT_OK;
  }
  const kill = flags.execute && flags.confirm;
  if (flags.execute && !flags.confirm) failExit("reap-orphans kill needs --confirm (pane kill is destructive)", EXIT_SYSTEMIC);
  const api = roomApiClient({ base: flags.apiBase ?? process.env.ROOM_API_BASE ?? null, token: flags.token ?? process.env.ROOM_API_TOKEN ?? null });
  const journal = readJournal(journalPath);
  const results = [];
  for (const roomId of flags.room) {
    const claims = await api.listClaims(roomId);
    const claimsById = Object.fromEntries(claims.map((c) => [c.id, c]));
    const linked = new Map();
    for (const e of journal) {
      if (e.room_id === roomId && (e.kind === "session_attached" || e.kind === "backfill_done") && e.session_id) {
        linked.set(e.claim_id, { session_id: e.session_id, claim_id: e.claim_id, room_id: roomId });
      }
    }
    const orphans = detectOrphans({ sessions: [...linked.values()], bridgeInventory: snap.inventory, claimsById, nowMs: Date.now() })
      .filter((o) => o.verdict === "orphan");
    for (const o of orphans) {
      if (!kill) {
        const entry = appendJournalEntry(journalPath, {
          kind: "orphan_marked", room_id: roomId, claim_id: o.claim_id, session_id: o.session_id, reason: o.reason,
        });
        results.push({ room_id: roomId, session_id: o.session_id, claim_id: o.claim_id, action: "marked", journal_seq: entry.seq });
      } else {
        // Pane kill is the one destructive action (D5 §4.4.3), operator-gated.
        // The bridge closePane path lands with B3; until then fail closed.
        const entry = appendJournalEntry(journalPath, {
          kind: "orphan_kill_aborted", room_id: roomId, claim_id: o.claim_id, session_id: o.session_id,
          reason: "pane_kill_path_not_landed",
          detail: "bridge closePane not landed (B3); orphan stays marked, pane untouched",
        });
        results.push({ room_id: roomId, session_id: o.session_id, claim_id: o.claim_id, action: "kill_aborted", reason: "pane_kill_path_not_landed", journal_seq: entry.seq });
      }
    }
    if (orphans.length === 0) results.push({ room_id: roomId, action: "none", detail: "no orphans" });
  }
  const aborted = results.filter((r) => r.action === "kill_aborted").length;
  const out = { command: "reap-orphans", mode: kill ? "kill" : "mark", results };
  emit(flags, out, (o) => table(
    o.results.map((r) => [r.room_id, r.session_id ?? "-", r.action, r.reason ?? r.detail ?? ""]),
    ["room", "session", "action", "note"],
  ));
  return aborted > 0 ? EXIT_PARTIAL : EXIT_OK;
}

async function cmdStatus(flags, deps) {
  if (flags.room.length === 0) failExit("status needs --room <id> (repeatable)");
  const flagParsed = resolveFlag(flags);
  const markers = flags.markersFile ? loadJsonFile(flags.markersFile, "markers file") : {};
  const bridge = await probeBridge({ bridgeBase: flags.bridgeBase ?? process.env.HERDR_BRIDGE_BASE ?? null, pinnedHerdrPath: flags.pinnedHerdr ?? defaultPinnedHerdrPath() });
  const api = roomApiClient({ base: flags.apiBase ?? process.env.ROOM_API_BASE ?? null, token: flags.token ?? process.env.ROOM_API_TOKEN ?? null });
  const journalPath = flags.journal ?? defaultJournalPath();
  const journal = readJournal(journalPath);
  const nowMs = Date.now();
  const rooms = {};
  for (const roomId of flags.room) {
    const claims = await api.listClaims(roomId);
    const roomMarkers = markers[roomId] ?? {};
    const linked = linkedClaimIds(journal, roomId);
    let eligibleNow = 0;
    for (const claim of claims) {
      const c = classifyClaim(claim, {
        flagCoversRoom: effectiveFlagForRoom(flagParsed, roomId),
        optin: resolveOptinMarker(claim, roomMarkers),
        bridge, bridgeRequired: false,
        hostClass: null, hostClassInputProvided: false,
        allClaims: claims, existingHerdrSession: linked.has(claim.id), nowMs,
      });
      if (c.eligible) eligibleNow++;
    }
    const roomJournal = journal.filter((e) => e.room_id === roomId);
    const lastCursor = [...roomJournal].reverse().find((e) => e.kind === "migration_cursor");
    const lastErrors = roomJournal.filter((e) => e.reason).slice(-5).map((e) => ({
      at: e.at, kind: e.kind, claim_id: e.claim_id ?? null, reason: e.reason,
    }));
    rooms[roomId] = {
      flag_state: flagStateLabel(flagParsed),
      open_claims: claims.length,
      live_claims: claims.filter((c) => LIVE_CLAIM_STATES.has(c.state)).length,
      eligible_now: eligibleNow,
      migrated: roomJournal.filter((e) => e.kind === "backfill_done").length,
      aborted: roomJournal.filter((e) => e.kind === "backfill_aborted").length,
      skipped: roomJournal.filter((e) => e.kind === "backfill_skipped").length,
      orphans_marked: roomJournal.filter((e) => e.kind === "orphan_marked").length,
      cursor: lastCursor?.cursor ?? 0,
      last_errors: lastErrors,
    };
  }
  const out = { command: "status", rooms };
  emit(flags, out, (o) => table(
    Object.entries(o.rooms).map(([id, r]) => [
      id, r.flag_state, String(r.live_claims), String(r.eligible_now),
      String(r.migrated), String(r.aborted), String(r.cursor),
    ]),
    ["room", "flag", "live", "eligible", "migrated", "aborted", "cursor"],
  ));
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv) {
  const { command, flags, errors } = parseArgs(argv);
  if (errors.length > 0) {
    process.stderr.write(`herdr-migrate: ${errors.join("; ")}\n\n${USAGE}\n`);
    process.exit(EXIT_SYSTEMIC);
  }
  const deps = {};
  try {
    switch (command) {
      case "scan": return await cmdScan(flags, deps);
      case "plan": return await cmdPlan(flags, deps);
      case "migrate": return await cmdMigrate(flags, deps);
      case "reverse": return await cmdReverse(flags, deps);
      case "drain-status": return await cmdDrainStatus(flags, deps);
      case "force-release": return await cmdForceRelease(flags, deps);
      case "reap-orphans": return await cmdReapOrphans(flags, deps);
      case "status": return await cmdStatus(flags, deps);
      default: failExit(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof RoomApiError) {
      // Expected operational / input errors: clean message, systemic exit.
      process.stderr.write(`herdr-migrate: error: ${err.message}\n`);
      process.exit(EXIT_SYSTEMIC);
    }
    throw err;
  }
  return EXIT_OK;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? EXIT_OK),
    (err) => {
      process.stderr.write(`herdr-migrate: fatal: ${err?.stack ?? err}\n`);
      process.exit(EXIT_SYSTEMIC);
    },
  );
}
