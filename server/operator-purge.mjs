// Confirm-then-delete for rooms, identities, and accounts. Planning and find
// are read-only apart from the operator audit row. Execute recounts, refuses
// with 409 plan_changed when the counts moved, and deletes inside one writer
// transaction. The integrity snapshot is rewritten in that same transaction.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";
import { executeAccountDeletion, planAccountDeletion } from "./account-deletion.mjs";
import { PURGE_TABLES } from "./purge-registry.mjs";
import { appendOperatorAction } from "./operator-actions.mjs";

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TARGETS = 20;
const MAX_ROWS = 200_000;
const FIND_LIMIT = 50;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const LATE = Object.freeze(["commands", "cursors", "projection_checkpoints", "events"]);
const BUILTIN_PROTECTED = Object.freeze(["invite-only-pilot"]);

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const q = name => {
  if (!IDENT.test(name)) fail(500, "invalid_purge_registry", "Purge registry names a column this store will not query");
  return name;
};

export function protectedRoomIds(env = globalThis.process?.env ?? {}) {
  const extra = typeof env.ROOM_OPERATOR_PROTECTED_ROOMS === "string"
    ? env.ROOM_OPERATOR_PROTECTED_ROOMS.split(",").map(part => part.trim()).filter(Boolean)
    : [];
  return new Set([...BUILTIN_PROTECTED, ...extra]);
}

function where(entry, kind) {
  const parts = [];
  let params = 0;
  for (const column of entry.match?.[kind] ?? []) {
    parts.push(`${q(column)}=?`);
    params += 1;
  }
  const via = entry.via?.[kind];
  if (via) {
    parts.push(`${q(via.childKey)} IN (SELECT ${q(via.parentKey)} FROM ${q(via.parent)} WHERE ${q(via.scope)}=?)`);
    params += 1;
  }
  if (!parts.length) return null;
  return { sql: parts.join(" OR "), params };
}

function purgeTable(db, entry) {
  const table = q(entry.table);
  if (!entry.optional) return table;
  // Only the explicitly retired registry entries may be absent. Query main
  // both here and below so a temp table cannot stand in for retained data.
  return db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table)
    ? `main.${table}` : null;
}

function countEntry(db, entry, kind, id) {
  const clause = where(entry, kind);
  if (!clause) return 0;
  const table = purgeTable(db, entry);
  if (!table) return 0;
  return db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${clause.sql}`).get(...Array(clause.params).fill(id)).n;
}

function deleteEntry(db, entry, kind, id) {
  const clause = where(entry, kind);
  if (!clause) return 0;
  const table = purgeTable(db, entry);
  if (!table) return 0;
  return db.prepare(`DELETE FROM ${table} WHERE ${clause.sql}`).run(...Array(clause.params).fill(id)).changes;
}

export function countPurge(store, targets) {
  const totals = new Map(PURGE_TABLES.map(entry => [entry.table, {
    table: entry.table,
    action: entry.action,
    rows: 0,
    ...(entry.reason ? { reason: entry.reason } : {})
  }]));
  for (const target of targets) {
    for (const entry of PURGE_TABLES) {
      totals.get(entry.table).rows += countEntry(store.db, entry, target.kind, target.id);
    }
  }
  return [...totals.values()].sort((a, b) => a.table < b.table ? -1 : 1);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

export function hashPurgeCounts(counts) {
  return createHash("sha256").update(JSON.stringify(stable(counts))).digest("hex");
}

function activeHumanCount(store, roomId) {
  let room;
  try { room = store.room(roomId); }
  catch (error) {
    if (error?.code === "room_not_found") fail(404, "unknown_target", "No such room");
    throw error;
  }
  return Object.values(room.state.members ?? {}).filter(member => member && member.kind === "human" && member.active !== false).length;
}

function assertTargetExists(store, target) {
  if (target.kind === "room") {
    if (!store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(target.id)) fail(404, "unknown_target", "No such room");
    return;
  }
  if (target.kind === "identity") {
    if (!store.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=?").get(target.id)) fail(404, "unknown_target", "No such identity");
    return;
  }
  if (!store.db.prepare("SELECT 1 FROM accounts WHERE id=?").get(target.id)) fail(404, "unknown_target", "No such account");
}

function roomGuards(store, targets, allowActiveMembers) {
  const warnings = [];
  const protectedIds = protectedRoomIds();
  for (const target of targets) {
    if (target.kind !== "room") continue;
    if (protectedIds.has(target.id)) fail(403, "protected_room", "This room is protected and cannot be purged");
    const humans = activeHumanCount(store, target.id);
    if (humans > 1) {
      warnings.push({
        code: "active_members",
        id: target.id,
        count: humans,
        message: `Room ${target.id} has ${humans} active human members`
      });
      if (!allowActiveMembers) fail(409, "active_members", `Room ${target.id} has ${humans} active human members`);
    }
  }
  return warnings;
}

function parseTargets(body) {
  if (!body || Array.isArray(body) || !Array.isArray(body.targets)) fail(422, "invalid_purge", "Supply targets and a reason");
  if (body.targets.length < 1 || body.targets.length > MAX_TARGETS) fail(422, "purge_too_large", `One plan accepts 1 to ${MAX_TARGETS} targets`);
  const targets = body.targets.map(target => {
    if (!target || Array.isArray(target) || (target.kind !== "room" && target.kind !== "identity" && target.kind !== "account") || !validId(target.id)) {
      fail(422, "invalid_target", "Each target needs kind room, identity, or account and an id");
    }
    return { kind: target.kind, id: target.id };
  });
  const seen = new Set();
  for (const target of targets) {
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) fail(422, "invalid_target", "Each target is listed once");
    seen.add(key);
  }
  return targets;
}

function parseReason(body) {
  if (typeof body?.reason !== "string") fail(422, "invalid_purge", "Supply a reason");
  const reason = body.reason.trim();
  if (!reason || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) fail(422, "invalid_purge", "Reason must be 1 to 500 characters of plain text");
  return reason;
}

function prefix(value, label) {
  if (value == null) return null;
  if (typeof value !== "string") fail(422, "invalid_find", `${label} must be text`);
  const text = value.trim();
  if (!text || text.length > 80 || /[\u0000-\u001f\u007f%_\\]/.test(text)) fail(422, "invalid_find", `${label} must be 1 to 80 plain characters`);
  return text;
}

function createdBeforeMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  fail(422, "invalid_find", "createdBefore must be a time");
}

function likePrefix(text) {
  return `${text.replace(/[\\%_]/g, char => `\\${char}`)}%`;
}

function issueToken(secret, planId, planHash, exp) {
  const body = Buffer.from(JSON.stringify({ planId, planHash, exp })).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function readToken(secret, token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest();
  let presented;
  try { presented = Buffer.from(signature, "base64url"); }
  catch { return null; }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!claims || typeof claims.planId !== "string" || typeof claims.planHash !== "string" || typeof claims.exp !== "number") return null;
    return claims;
  } catch { return null; }
}

function liftDeleteGuards(db, tables) {
  const wanted = new Set(tables);
  const saved = [];
  for (const row of db.prepare("SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type='trigger'").all()) {
    if (!wanted.has(row.tbl) || typeof row.sql !== "string") continue;
    if (row.name.startsWith("writer_v") || !IDENT.test(row.name)) continue;
    if (!/\bBEFORE\s+DELETE\b/i.test(row.sql) || /\bWHEN\b/i.test(row.sql)) continue;
    saved.push(row);
  }
  for (const row of saved) db.exec(`DROP TRIGGER ${row.name}`);
  return saved;
}

function restoreGuards(db, saved) {
  for (const row of saved) db.exec(row.sql.endsWith(";") ? row.sql : `${row.sql};`);
}

function orderedEntries(kind, phase) {
  const applicable = PURGE_TABLES.filter(entry => entry.action === "delete" && where(entry, kind));
  if (phase === "via") return applicable.filter(entry => entry.via?.[kind]);
  if (phase === "late") return LATE.map(table => applicable.find(entry => entry.table === table && !entry.via?.[kind])).filter(Boolean);
  const late = new Set(LATE);
  return applicable.filter(entry => !entry.via?.[kind] && !late.has(entry.table));
}

function writeSnapshot(store) {
  const checksum = store.integrityChecksum();
  store.db.prepare(`INSERT INTO integrity_snapshot(id, checksum, verified_at) VALUES(1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET checksum=excluded.checksum, verified_at=excluded.verified_at`)
    .run(checksum.text, store.now());
}

function dropCaches(store, identityIds) {
  if (typeof store.agentPlugin?.load === "function") store.agentPlugin.load();
  for (const id of identityIds) {
    store.identities?.pendingHashUpgrades?.delete(id);
    store.identities?.pendingActivation?.delete(id);
  }
}

function audit(store, row) {
  appendOperatorAction(store, row);
}

export function createOperatorPurge(store) {
  const secret = randomBytes(32);
  const plans = new Map();

  function remember(plan) {
    const now = store.now();
    for (const [id, saved] of plans) if (saved.exp <= now || saved.used) plans.delete(id);
    if (plans.size >= 100) plans.delete(plans.keys().next().value);
    plans.set(plan.planId, plan);
  }

  return {
    find(body, requestId) {
      const base = { action: "find", requestId, targetKind: null, targetId: null };
      try {
        if (!body || Array.isArray(body)) fail(422, "invalid_find", "Supply a find filter");
        const roomTitlePrefix = prefix(body.roomTitlePrefix, "roomTitlePrefix");
        const identityNamePrefix = prefix(body.identityNamePrefix, "identityNamePrefix");
        const roomIdPrefix = prefix(body.roomIdPrefix, "roomIdPrefix");
        const createdBefore = createdBeforeMs(body.createdBefore);
        if (!roomTitlePrefix && !identityNamePrefix && !roomIdPrefix && createdBefore == null) {
          fail(422, "invalid_find", "Supply a room title, room id, or identity name prefix, or a createdBefore time");
        }
        const rooms = [];
        if (roomTitlePrefix || roomIdPrefix || (createdBefore != null && !identityNamePrefix)) {
          const clauses = [];
          const params = [];
          if (roomIdPrefix) { clauses.push("id LIKE ? ESCAPE '\\'"); params.push(likePrefix(roomIdPrefix)); }
          if (roomTitlePrefix) { clauses.push("json_extract(projection, '$.room.title') LIKE ? ESCAPE '\\'"); params.push(likePrefix(roomTitlePrefix)); }
          if (createdBefore != null) { clauses.push("json_extract(projection, '$.room.createdAt') < ?"); params.push(new Date(createdBefore).toISOString()); }
          const rows = store.db.prepare(`SELECT id, json_extract(projection, '$.room.title') AS title FROM rooms
            WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`).all(...params, FIND_LIMIT + 1);
          for (const row of rows.slice(0, FIND_LIMIT)) rooms.push({ id: row.id, title: typeof row.title === "string" ? row.title : row.id });
          if (rows.length > FIND_LIMIT) rooms.truncated = true;
        }
        const identities = [];
        if (identityNamePrefix || (createdBefore != null && !roomTitlePrefix && !roomIdPrefix)) {
          const clauses = [];
          const params = [];
          if (identityNamePrefix) { clauses.push("display_name LIKE ? ESCAPE '\\'"); params.push(likePrefix(identityNamePrefix)); }
          if (createdBefore != null) { clauses.push("created_at < ?"); params.push(createdBefore); }
          const rows = store.db.prepare(`SELECT identity_id AS id, display_name AS displayName FROM agent_identities
            WHERE ${clauses.join(" AND ")} ORDER BY identity_id LIMIT ?`).all(...params, FIND_LIMIT + 1);
          for (const row of rows.slice(0, FIND_LIMIT)) identities.push({ id: row.id, displayName: row.displayName });
          if (rows.length > FIND_LIMIT) identities.truncated = true;
        }
        const result = {
          rooms,
          identities,
          ...(rooms.truncated || identities.truncated ? { truncated: true } : {})
        };
        delete rooms.truncated;
        delete identities.truncated;
        audit(store, { ...base, result: "ok", counts: { rooms: rooms.length, identities: identities.length } });
        return result;
      } catch (error) {
        audit(store, { ...base, result: error.code || "error" });
        throw error;
      }
    },

    plan(body, requestId) {
      const base = { action: "plan", requestId };
      try {
        const reason = parseReason(body);
        const targets = parseTargets(body);
        if (body.allowActiveMembers != null && typeof body.allowActiveMembers !== "boolean") fail(422, "invalid_purge", "allowActiveMembers must be true or false");
        const allowActiveMembers = body.allowActiveMembers === true;
        for (const target of targets) assertTargetExists(store, target);
        const warnings = roomGuards(store, targets, allowActiveMembers);
        const counts = countPurge(store, targets);
        const totalRows = counts.reduce((sum, row) => sum + (row.action === "delete" ? row.rows : 0), 0);
        if (totalRows > MAX_ROWS) fail(422, "purge_too_large", `This plan covers ${totalRows} rows. Split it under ${MAX_ROWS}`);
        const planHash = hashPurgeCounts(counts);
        const planId = `plan_${randomBytes(9).toString("base64url")}`;
        const exp = store.now() + TOKEN_TTL_MS;
        const saved = { planId, planHash, exp, targets, reason, allowActiveMembers, counts, used: false };
        remember(saved);
        const response = {
          planId,
          planHash,
          confirmToken: issueToken(secret, planId, planHash, exp),
          expiresAt: exp,
          reason,
          warnings,
          counts,
          targets,
          totalRows
        };
        audit(store, {
          ...base,
          result: "ok",
          reason,
          planHash,
          targetKind: targets.length === 1 ? targets[0].kind : "batch",
          targetId: targets.length === 1 ? targets[0].id : null,
          counts: { targets, totalRows }
        });
        return response;
      } catch (error) {
        audit(store, { ...base, result: error.code || "error", reason: typeof body?.reason === "string" ? body.reason.slice(0, 500) : null });
        throw error;
      }
    },

    execute(body, requestId) {
      const base = { action: "execute", requestId };
      let committed = false;
      try {
        if (!body || Array.isArray(body) || typeof body.planId !== "string" || typeof body.confirmToken !== "string"
          || Object.keys(body).some(key => key !== "planId" && key !== "confirmToken")) {
          fail(422, "invalid_purge", "Supply the planId and confirmToken from the plan");
        }
        const saved = plans.get(body.planId);
        const claims = readToken(secret, body.confirmToken);
        if (!saved || !claims || claims.planId !== saved.planId || claims.planHash !== saved.planHash) {
          fail(401, "invalid_confirmation", "That confirmation is not valid. Request a fresh plan");
        }
        if (claims.exp <= store.now()) fail(401, "invalid_confirmation", "That confirmation expired. Request a fresh plan");
        if (saved.used) fail(409, "confirm_used", "That confirmation was already used");
        const value = store.transaction(() => {
          const counts = countPurge(store, saved.targets);
          const planHash = hashPurgeCounts(counts);
          if (planHash !== saved.planHash) fail(409, "plan_changed", "Rows changed after the plan was confirmed. Nothing was deleted");
          roomGuards(store, saved.targets, saved.allowActiveMembers);
          for (const target of saved.targets) assertTargetExists(store, target);
          store.db.exec("PRAGMA defer_foreign_keys=ON");
          const permit = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_work_claim_writer_permit'").get();
          if (permit) store.db.prepare("UPDATE public_work_claim_writer_permit SET enabled=1 WHERE singleton=1").run();
          const touched = new Set();
          for (const target of saved.targets) {
            for (const entry of PURGE_TABLES) if (entry.action === "delete" && where(entry, target.kind)) touched.add(entry.table);
          }
          const guards = liftDeleteGuards(store.db, [...touched]);
          try {
            for (const phase of ["via", "normal", "late"]) {
              for (const target of saved.targets) {
                for (const entry of orderedEntries(target.kind, phase)) deleteEntry(store.db, entry, target.kind, target.id);
              }
            }
            for (const target of saved.targets) {
              if (target.kind === "room") store.db.prepare("DELETE FROM rooms WHERE id=?").run(target.id);
              if (target.kind === "identity") {
                store.db.prepare("UPDATE agent_identities SET revoked_at=COALESCE(revoked_at, ?) WHERE identity_id=?").run(store.now(), target.id);
              }
            }
            for (const target of saved.targets) {
              if (target.kind !== "account") continue;
              const planned = planAccountDeletion(store, target.id);
              executeAccountDeletion(store, planned.plan);
            }
            writeSnapshot(store);
            audit(store, {
              ...base,
              result: "executed",
              reason: saved.reason,
              planHash: saved.planHash,
              targetKind: saved.targets.length === 1 ? saved.targets[0].kind : "batch",
              targetId: saved.targets.length === 1 ? saved.targets[0].id : null,
              counts: { targets: saved.targets, totalRows: saved.counts.reduce((sum, row) => sum + (row.action === "delete" ? row.rows : 0), 0) }
            });
          } finally {
            restoreGuards(store.db, guards);
            if (permit && store.db.isTransaction) store.db.prepare("UPDATE public_work_claim_writer_permit SET enabled=0 WHERE singleton=1").run();
          }
          return {
            planId: saved.planId,
            planHash: saved.planHash,
            result: "executed",
            targets: saved.targets,
            totalRows: saved.counts.reduce((sum, row) => sum + (row.action === "delete" ? row.rows : 0), 0)
          };
        });
        committed = true;
        saved.used = true;
        dropCaches(store, saved.targets.filter(target => target.kind === "identity").map(target => target.id));
        return value;
      } catch (error) {
        if (!committed) {
          audit(store, {
            ...base,
            result: error.code || "error",
            planHash: plans.get(body?.planId)?.planHash ?? null,
            reason: plans.get(body?.planId)?.reason ?? null,
            targetKind: plans.get(body?.planId)?.targets?.length === 1 ? plans.get(body.planId).targets[0].kind : null,
            targetId: plans.get(body?.planId)?.targets?.length === 1 ? plans.get(body.planId).targets[0].id : null
          });
        }
        throw error;
      }
    }
  };
}
