// herdr backfill executor (lane B21).
//
// Attaches herdr sessions to existing opted-in in-flight claims. This is the
// *execution* half of the Phase B migration: B20's planner (`plan` / `scan`)
// enumerates and orders the units of work; this script executes them against
// the room's claim source and the herdr bridge.
//
// Contract (migration-rollout.md §1, compat-plan.md §1B):
//   - IDEMPOTENT: idempotency key `backfill:<room_id>:<claim_id>`; a
//     backfill_done journal row is forever-terminal, so a completed claim is
//     never processed again. Two panes are never spawned for one claim.
//     backfill_aborted is terminal only for the run that wrote it — a later
//     run re-drives the claim after the operator fixes the cause.
//   - RESUMABLE: the append-only `herdr_session_journal` is the source of
//     truth per claim; a cursor in `herdr_backend_state` (key
//     `backfill_cursor`) lets --resume skip ahead.
//   - --dry-run is the default and writes nothing. --confirm executes.
//   - Eligibility: claim state is in_progress AND the lane opted in
//     (herdr_lane_optin) AND ROOM_HERDR_SESSIONS covers the room.
//   - The claim's public state NEVER changes: state / owner / claimedAt are
//     asserted byte-identical around the history-append. The append records
//     { kind: "session_migrated", from: "legacy", to: "herdr", ... }.
//   - Fail-closed: bridge unreachable or protocol-version mismatch halts the
//     executor before any claim is touched (exit 2). A per-claim failure
//     journals backfill_aborted and stops the run (exit 1).
//
// Tables are created idempotently (CREATE TABLE IF NOT EXISTS) so this lane
// and B5's table lane can land in either order; the DDL here is the minimal
// subset this executor needs, per compat-plan §4 (additive, unfenced).
// Writer-fence registration of the four herdr_* tables is B5's lane.
import { DatabaseSync } from "node:sqlite";

export const BACKFILL_PROTOCOL = "herdr-backfill/1";
const TERMINAL_KINDS = new Set(["backfill_done", "backfill_aborted"]);
const NO_HERDR_HOST_CLASSES = new Set(["paste-relay", "pull-only"]);

export const idempotencyKey = (roomId, claimId) => `backfill:${roomId}:${claimId}`;

export function ensureHerdrTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS herdr_session_journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    room_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    session_id TEXT,
    idempotency_key TEXT NOT NULL,
    detail TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_herdr_session_journal_idem
    ON herdr_session_journal (idempotency_key, kind)`);
  db.exec(`CREATE TABLE IF NOT EXISTS herdr_sessions (
    session_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    backend TEXT NOT NULL DEFAULT 'herdr',
    attached_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS herdr_backend_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS herdr_lane_optin (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    session_backend TEXT NOT NULL,
    set_by TEXT,
    set_at TEXT NOT NULL,
    PRIMARY KEY (room_id, member_id)
  )`);
  // Self-verify the columns this executor depends on (compat-plan §4 precedent).
  const cols = name =>
    new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(r => r.name));
  const need = {
    herdr_session_journal: ["seq", "at", "kind", "room_id", "claim_id", "session_id", "idempotency_key", "detail"],
    herdr_sessions: ["session_id", "room_id", "member_id", "claim_id", "backend", "attached_at", "status"],
    herdr_backend_state: ["key", "value", "updated_at"],
    herdr_lane_optin: ["room_id", "member_id", "session_backend", "set_by", "set_at"],
  };
  for (const [table, required] of Object.entries(need)) {
    const have = cols(table);
    const missing = required.filter(c => !have.has(c));
    if (missing.length > 0) {
      throw new Error(`herdr_backfill: table ${table} is missing columns: ${missing.join(", ")}`);
    }
  }
}

const nowIso = now => new Date(now()).toISOString();

function journal(db, now, row) {
  db.prepare(`INSERT INTO herdr_session_journal
    (at, kind, room_id, claim_id, session_id, idempotency_key, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(nowIso(now), row.kind, row.roomId, row.claimId, row.sessionId ?? null,
      idempotencyKey(row.roomId, row.claimId), JSON.stringify(row.detail ?? {}));
}

function journalDone(db, roomId, claimId) {
  return !!db.prepare(`SELECT 1 FROM herdr_session_journal
    WHERE idempotency_key = ? AND kind = 'backfill_done' LIMIT 1`)
    .get(idempotencyKey(roomId, claimId));
}

function openSession(db, roomId, claimId) {
  return db.prepare(`SELECT * FROM herdr_sessions
    WHERE room_id = ? AND claim_id = ? AND status = 'open' ORDER BY attached_at DESC LIMIT 1`)
    .get(roomId, claimId) ?? null;
}

function isLeaseExpired(claim, now) {
  if (!claim.leaseExpiresAt) return false;
  const exp = Date.parse(claim.leaseExpiresAt);
  return Number.isFinite(exp) && exp <= now();
}

// Eligibility predicate. Pure: reads the claim, the opt-in store, the flag,
// the journal and the sessions table — writes nothing.
export function checkEligibility(ctx, roomId, claim) {
  const { db, now, isOptedIn, flagCoversRoom, hostClassFor } = ctx;
  const base = {
    roomId, claimId: claim.id, memberId: claim.owner ?? null,
    claimState: claim.state, leaseExpiresAt: claim.leaseExpiresAt ?? null,
    idempotencyKey: idempotencyKey(roomId, claim.id),
  };
  if (claim.state === "done" || claim.state === "failed") {
    return { ...base, eligible: false, reason: "claim_terminal" };
  }
  if (claim.state !== "in_progress") {
    return { ...base, eligible: false, reason: "not_in_progress" };
  }
  if (isLeaseExpired(claim, now)) {
    return { ...base, eligible: false, reason: "lease_expired" };
  }
  if (!flagCoversRoom(roomId)) {
    return { ...base, eligible: false, reason: "room_not_in_flag_scope" };
  }
  if (!isOptedIn(roomId, claim.owner)) {
    return { ...base, eligible: false, reason: "not_opted_in" };
  }
  // backfill_done is forever-terminal: the claim has exactly one herdr pane.
  // backfill_aborted is retryable on a later run (resumability); a dangling
  // backfill_start without a terminal row is crash-recovered in executeOne.
  if (journalDone(db, roomId, claim.id) || openSession(db, roomId, claim.id)) {
    return { ...base, eligible: false, reason: "already_migrated" };
  }
  const hostClass = hostClassFor ? hostClassFor(claim.owner) : "agent";
  if (NO_HERDR_HOST_CLASSES.has(hostClass)) {
    return { ...base, eligible: false, reason: "host_class_no_herdr", hostClass };
  }
  return { ...base, eligible: true, hostClass };
}

function setCursor(db, now, value) {
  db.prepare(`INSERT INTO herdr_backend_state (key, value, updated_at)
    VALUES ('backfill_cursor', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(JSON.stringify(value), nowIso(now));
}

export function getCursor(db) {
  const row = db.prepare(`SELECT value FROM herdr_backend_state WHERE key = 'backfill_cursor'`).get();
  return row ? JSON.parse(row.value) : null;
}

export function createBackfillExecutor(opts) {
  const ctx = {
    db: opts.db,
    now: opts.now ?? (() => Date.now()),
    listClaims: opts.listClaims,
    getClaim: opts.getClaim,
    recordHistory: opts.recordHistory,
    isOptedIn: opts.isOptedIn,
    flagCoversRoom: opts.flagCoversRoom,
    agentKindFor: opts.agentKindFor ?? (() => "default"),
    hostClassFor: opts.hostClassFor ?? (() => "agent"),
    bridge: opts.bridge ?? null,
    pinnedProtocolVersion: opts.pinnedProtocolVersion ?? 22,
    batchSize: opts.batchSize ?? 5,
  };
  if (!ctx.db || !ctx.listClaims || !ctx.getClaim || !ctx.recordHistory || !ctx.isOptedIn || !ctx.flagCoversRoom) {
    throw new Error("herdr_backfill: missing required bindings (db, listClaims, getClaim, recordHistory, isOptedIn, flagCoversRoom)");
  }
  ensureHerdrTables(ctx.db);

  // Read the ordered plan. B20's planner owns writing backfill_plan rows;
  // this executor consumes them. A caller-supplied plan array overrides.
  function loadPlan(roomIds, planOverride) {
    if (planOverride) return planOverride;
    const planned = ctx.db.prepare(`SELECT room_id, claim_id, detail FROM herdr_session_journal
      WHERE kind = 'backfill_plan' ORDER BY seq`).all();
    if (planned.length > 0) {
      return planned
        .filter(p => roomIds.includes(p.room_id))
        .map(p => ({ roomId: p.room_id, claimId: p.claim_id, ...(JSON.parse(p.detail || "{}")) }));
    }
    // Fallback: enumerate live claims directly (planner not yet run).
    const out = [];
    for (const roomId of roomIds) {
      for (const claim of ctx.listClaims(roomId)) {
        out.push({ roomId, claimId: claim.id });
      }
    }
    return out;
  }

  function enumerate(roomIds) {
    const out = [];
    for (const roomId of roomIds) {
      for (const claim of ctx.listClaims(roomId)) {
        out.push(checkEligibility(ctx, roomId, claim));
      }
    }
    return out;
  }

  // Bridge health is checked at execute time (fail-closed), not at enumerate
  // time: a dry-run review of eligibility must not require the bridge.
  function assertBridgeHealthy() {
    if (!ctx.bridge) {
      return { ok: false, reason: "bridge_not_wired", detail: "no bridge transport bound (B3/B4 pending)" };
    }
    let pong;
    try {
      pong = ctx.bridge.ping();
    } catch (err) {
      return { ok: false, reason: "bridge_unreachable", detail: String(err && err.message || err) };
    }
    if (!pong || pong.protocolVersion !== ctx.pinnedProtocolVersion) {
      return {
        ok: false, reason: "bridge_version_mismatch",
        detail: `pinned=${ctx.pinnedProtocolVersion}, server=${pong && pong.protocolVersion}`,
      };
    }
    return { ok: true };
  }

  function executeOne(planItem) {
    const { db, now } = ctx;
    const { roomId, claimId } = planItem;
    // Idempotency: backfill_done is forever-terminal — never respawn a pane
    // for a completed claim. backfill_aborted is terminal only for the run
    // that wrote it; a later run re-drives the claim (the operator fixes the
    // cause and resumes), which is what makes the backfill resumable.
    if (journalDone(db, roomId, claimId)) {
      return { claimId, outcome: "skipped", reason: "already_migrated" };
    }
    const claim = ctx.getClaim(roomId, claimId);
    if (!claim) {
      journal(db, now, { kind: "backfill_skipped", roomId, claimId, detail: { reason: "claim_gone" } });
      return { claimId, outcome: "skipped", reason: "claim_gone" };
    }
    const elig = checkEligibility(ctx, roomId, claim);
    if (!elig.eligible) {
      journal(db, now, { kind: "backfill_skipped", roomId, claimId, detail: { reason: elig.reason } });
      return { claimId, outcome: "skipped", reason: elig.reason };
    }
    // Crash recovery: an intent row without a terminal row means the last run
    // died mid-claim. If the pane is alive and linked, complete the linkage;
    // otherwise clean up the half-spawn and respawn below.
    let sessionId = null;
    const started = db.prepare(`SELECT seq FROM herdr_session_journal
      WHERE idempotency_key = ? AND kind = 'backfill_start' ORDER BY seq DESC LIMIT 1`)
      .get(idempotencyKey(roomId, claimId));
    const existing = openSession(db, roomId, claimId);
    if (existing && ctx.bridge.paneAlive(existing.session_id)) {
      sessionId = existing.session_id; // complete the linkage, no new pane
    } else if (existing) {
      db.prepare(`UPDATE herdr_sessions SET status = 'closed' WHERE session_id = ?`)
        .run(existing.session_id);
      journal(db, now, { kind: "backfill_start", roomId, claimId, sessionId: existing.session_id,
        detail: { note: "half-spawned pane dead; respawning" } });
    }
    if (!sessionId) {
      if (!started || existing) {
        journal(db, now, { kind: "backfill_start", roomId, claimId,
          detail: { memberId: claim.owner, claimState: claim.state } });
      }
      // Adapter-constructed spawn: the bridge owns argv construction from the
      // allowlisted agent kind (risk-review fencing). Never caller argv.
      let spawn;
      try {
        spawn = ctx.bridge.spawnAgent({
          agentKind: ctx.agentKindFor(claim.owner),
          resumeSessionRef: planItem.resumeSessionRef ?? null,
          metadata: { room_id: roomId, claim_id: claimId, member_id: claim.owner, backfill: "true" },
        });
      } catch (err) {
        journal(db, now, { kind: "backfill_aborted", roomId, claimId,
          detail: { reason: "spawn_failed", error: String(err && err.message || err) } });
        return { claimId, outcome: "aborted", reason: "spawn_failed" };
      }
      sessionId = spawn.sessionId;
      // Guard against a concurrent attach winning the race: one open session
      // per claim, enforced here (code-level; journal is the authority).
      const winner = openSession(db, roomId, claimId);
      if (winner && winner.session_id !== sessionId) {
        journal(db, now, { kind: "backfill_aborted", roomId, claimId, sessionId,
          detail: { reason: "concurrent_attach_won", winner: winner.session_id } });
        return { claimId, outcome: "aborted", reason: "concurrent_attach_won" };
      }
      db.prepare(`INSERT OR IGNORE INTO herdr_sessions
        (session_id, room_id, member_id, claim_id, backend, attached_at, status)
        VALUES (?, ?, ?, ?, 'herdr', ?, 'open')`)
        .run(sessionId, roomId, claim.owner, claimId, nowIso(now));
    }
    // History-append, with the compat-plan invariant enforced: the claim's
    // public state (state / owner / claimedAt) must be byte-identical after.
    const fenced = { state: claim.state, owner: claim.owner, claimedAt: claim.claimedAt };
    ctx.recordHistory(roomId, claimId, {
      kind: "session_migrated", from: "legacy", to: "herdr",
      at: nowIso(now), sessionId, agentId: "herdr-backfill",
      action: "session_migrated",
      note: "herdr session attached to in-flight claim; the pane starts empty — " +
        "durable from the migration point forward, no terminal/cwd/transcript recovery",
    });
    const after = ctx.getClaim(roomId, claimId);
    for (const k of ["state", "owner", "claimedAt"]) {
      if (after[k] !== fenced[k]) {
        journal(db, now, { kind: "backfill_aborted", roomId, claimId, sessionId,
          detail: { reason: "claim_mutated", field: k } });
        throw new Error(`herdr_backfill: claim ${claimId} ${k} changed during history-append — aborting`);
      }
    }
    journal(db, now, { kind: "backfill_done", roomId, claimId, sessionId,
      detail: { memberId: claim.owner } });
    return { claimId, outcome: "migrated", sessionId };
  }

  function execute(roomIds, runOpts = {}) {
    const { confirm = false, batch = ctx.batchSize, limit = Infinity,
      resume = false, fromCursor = null, plan = null, json = false } = runOpts;
    const fullPlan = loadPlan(roomIds, plan);
    if (!confirm) {
      // Dry-run: enumerate eligibility, write nothing.
      return { dryRun: true, exitCode: 0, plan: enumerate(roomIds), wrote: [] };
    }
    const bridge = assertBridgeHealthy();
    if (!bridge.ok) {
      return { dryRun: false, exitCode: 2, halted: true, outcomes: ["halted"],
        haltReason: bridge.reason, haltDetail: bridge.detail, results: [] };
    }
    let startIndex = 0;
    if (fromCursor !== null && fromCursor !== undefined) startIndex = Math.max(0, fromCursor);
    else if (resume) {
      const cur = getCursor(ctx.db);
      if (cur && typeof cur.index === "number") startIndex = cur.index + 1;
    }
    const results = [];
    let processed = 0;
    for (let i = 0; i < fullPlan.length && processed < limit; i++) {
      const item = fullPlan[i];
      if (i < startIndex) {
        // Behind the resume cursor: the journal is still authoritative.
        // Only backfill_done is a true skip; backfill_aborted (or a dangling
        // backfill_start from a crashed run) is re-driven below.
        const done = ctx.db.prepare(`SELECT 1 FROM herdr_session_journal
          WHERE idempotency_key = ? AND kind = 'backfill_done' LIMIT 1`)
          .get(idempotencyKey(item.roomId, item.claimId));
        if (done) {
          results.push({ claimId: item.claimId, outcome: "skipped", reason: "already_migrated" });
          continue;
        }
      }
      const r = executeOne(item);
      results.push(r);
      processed++;
      setCursor(ctx.db, ctx.now, { lastClaimId: item.claimId, index: i, roomIds, at: nowIso(ctx.now) });
      if (r.outcome === "aborted") break; // stop the run; journal shows where
      if (processed % batch === 0) {
        // Batch boundary: re-assert bridge health so a systemic failure hits
        // one batch before pausing, not the whole plan.
        const recheck = assertBridgeHealthy();
        if (!recheck.ok) {
          return { dryRun: false, exitCode: 2, halted: true, outcomes: results.map(x => x.outcome),
            haltReason: recheck.reason, haltDetail: recheck.detail, results };
        }
      }
    }
    const outcomes = results.map(r => r.outcome);
    const exitCode = outcomes.includes("aborted") ? 1 : 0;
    return {
      dryRun: false, exitCode, halted: false, outcomes, results,
      skips: results.filter(r => r.outcome === "skipped"),
      migrated: results.filter(r => r.outcome === "migrated"),
    };
  }

  return { enumerate, execute, checkEligibility: (roomId, claim) => checkEligibility(ctx, roomId, claim),
    loadPlan, getCursor: () => getCursor(ctx.db) };
}

// --- CLI -----------------------------------------------------------------
// Thin operator wrapper. Runtime bindings (claim source, history sink, bridge
// transport) are injected by the caller; the CLI reads them from explicit
// files/flags so nothing is silently coupled to a live room.
//
//   node scripts/herdr-backfill.mjs --db <sqlite> --claims <claims.json>
//     [--plan <plan.json>] [--room <id> ...] [--batch 5] [--limit n]
//     [--resume] [--from-cursor n] [--json] [--confirm]
//
// --claims: JSON snapshot of live claims, { "<roomId>": [ claimItem, ... ] }.
//   This is the same shape B20's scan emits; operators review it before --confirm.
// --plan: JSON array of { roomId, claimId, resumeSessionRef? }. Without it,
//   backfill_plan rows in the db are used; without those, claims are
//   enumerated directly (planner not yet run).
// History-append outbox: the executor's recordHistory writes to <db>.history.jsonl
//   (one JSON object per line); the room runtime applies it to the claim
//   registry. The executor asserts state/owner/claimedAt are unchanged.
// Bridge: not yet wired (B3/B4 pending). --confirm without a bridge transport
//   fails closed with exit 2. Dry-run never needs the bridge.
import { fileURLToPath } from "node:url";
import { readFileSync, appendFileSync, existsSync } from "node:fs";

function parseArgs(argv) {
  const out = { room: [], batch: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--db") out.db = val();
    else if (a === "--claims") out.claims = val();
    else if (a === "--plan") out.plan = val();
    else if (a === "--room") out.room.push(val());
    else if (a === "--batch") out.batch = Math.max(1, parseInt(val(), 10) || 5);
    else if (a === "--limit") out.limit = Math.max(1, parseInt(val(), 10) || 1);
    else if (a === "--resume") out.resume = true;
    else if (a === "--from-cursor") out.fromCursor = parseInt(val(), 10) || 0;
    else if (a === "--flag") out.flag = val();
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--json") out.json = true;
    else if (a === "--pinned-protocol") out.pinnedProtocol = parseInt(val(), 10);
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

// ROOM_HERDR_SESSIONS: "on" | "off" | "<roomId>,<roomId>,..." (compat-plan §1A).
function flagCoversRoom(flag) {
  const f = (flag ?? process.env.ROOM_HERDR_SESSIONS ?? "off").trim();
  if (f === "on") return () => true;
  if (f === "" || f === "off") return () => false;
  const rooms = new Set(f.split(",").map(s => s.trim()).filter(Boolean));
  return roomId => rooms.has(roomId);
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.db) throw new Error("missing required --db <sqlite path>");
  if (!args.claims) throw new Error("missing required --claims <claims.json snapshot>");
  const claimsSnap = JSON.parse(readFileSync(args.claims, "utf8"));
  const rooms = args.room.length > 0 ? args.room : Object.keys(claimsSnap);
  const db = new DatabaseSync(args.db);
  const historyOut = `${args.db}.history.jsonl`;
  const store = new Map();
  for (const [roomId, items] of Object.entries(claimsSnap)) {
    for (const item of items) store.set(`${roomId}\u0000${item.id}`, { ...item });
  }
  const ex = createBackfillExecutor({
    db,
    listClaims: roomId => (claimsSnap[roomId] ?? []).map(c => store.get(`${roomId}\u0000${c.id}`)),
    getClaim: (roomId, claimId) => store.get(`${roomId}\u0000${claimId}`) ?? null,
    recordHistory: (roomId, claimId, entry) => {
      const item = store.get(`${roomId}\u0000${claimId}`);
      appendFileSync(historyOut, JSON.stringify({ roomId, claimId, entry }) + "\n");
      return item;
    },
    isOptedIn: (roomId, memberId) => {
      const row = db.prepare(`SELECT 1 FROM herdr_lane_optin
        WHERE room_id = ? AND member_id = ? AND session_backend = 'herdr'`).get(roomId, memberId);
      return !!row;
    },
    flagCoversRoom: flagCoversRoom(args.flag),
    bridge: null, // B3/B4 pending: no bridge transport is wired yet
    pinnedProtocolVersion: args.pinnedProtocol ?? 22,
  });
  const plan = args.plan && existsSync(args.plan)
    ? JSON.parse(readFileSync(args.plan, "utf8")) : null;
  const res = ex.execute(rooms, {
    confirm: args.confirm === true, batch: args.batch, limit: args.limit,
    resume: args.resume, fromCursor: args.fromCursor, plan,
  });
  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
  } else if (res.dryRun) {
    const elig = res.plan.filter(p => p.eligible);
    const skip = res.plan.filter(p => !p.eligible);
    console.log(`backfill dry-run: ${elig.length} eligible, ${skip.length} skipped (writes: none)`);
    for (const p of elig) console.log(`  ELIGIBLE ${p.roomId}/${p.claimId} owner=${p.memberId} state=${p.claimState}`);
    for (const p of skip) console.log(`  SKIP     ${p.roomId}/${p.claimId} reason=${p.reason} state=${p.claimState}`);
    console.log("The attached pane starts empty: durable from the migration point forward;");
    console.log("no terminal, cwd, or transcript is recovered (migration-rollout §1.5).");
  } else {
    console.log(`backfill: exit=${res.exitCode} migrated=${(res.migrated || []).length} ` +
      `skipped=${(res.skips || []).length}${res.halted ? ` HALTED(${res.haltReason})` : ""}`);
    for (const r of res.results || []) {
      console.log(`  ${r.outcome.toUpperCase()} ${r.claimId}${r.reason ? ` reason=${r.reason}` : ""}${r.sessionId ? ` session=${r.sessionId}` : ""}`);
    }
    if (res.exitCode === 2) console.log(`halt detail: ${res.haltDetail}`);
  }
  db.close();
  process.exit(res.exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`herdr-backfill: ${err.message}`);
    process.exit(2);
  }
}
