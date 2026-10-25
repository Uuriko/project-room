// Test-only Worker entry. The production worker does not register these routes.
import worker, { ProjectRoom } from "../../../cloudflare/room.mjs";
import { initialRoom } from "../../../server/bootstrap.mjs";
import { PILOT_LIMITS } from "../../../server/store.mjs";
import { sqliteValueLimit } from "../../../server/storage-limits.mjs";
import { ServiceError } from "../../../server/service-error.mjs";
import { STORE_SCHEMA_VERSION } from "../../../server/writer-fence.mjs";
import { LOAD_BUDGET, roomStorageLimitBytes } from "./budget.mjs";

const ROOM = LOAD_BUDGET.roomId;
const MAX_BODY = 65536;

function projectionBytes(store) {
  const row = store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id=?").get(ROOM);
  return Number(row?.n ?? 0);
}

function pragmaNumber(row) {
  if (!row || typeof row !== "object") return null;
  for (const value of Object.values(row)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function dbBytes(store) {
  // Durable Object SQLite refuses PRAGMA page_count (SQLITE_AUTH). The file
  // size is not readable here; the room ceiling the seed fills is the projection.
  try {
    const count = pragmaNumber(store.db.prepare("PRAGMA page_count").get());
    const bytes = pragmaNumber(store.db.prepare("PRAGMA page_size").get());
    if (count !== null && bytes !== null) return count * bytes;
  } catch { /* omit the file size */ }
  return null;
}

function fail(status, code, message, extra = {}) {
  return Response.json({ error: code, message: String(message).slice(0, 300), ...extra }, { status });
}

export class LoadTestRoom extends ProjectRoom {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__load/")) return super.fetch(request);
    try {
      if (url.pathname === "/__load/seed" && request.method === "POST") return this.#seed();
      if (url.pathname === "/__load/permit" && request.method === "GET") return this.#permit();
      if (url.pathname === "/__load/stick-permit" && request.method === "POST") return this.#stick();
      return fail(404, "not_found", "Unknown load fixture route");
    } catch (error) {
      return fail(500, error?.code ?? "load_fixture_failed", error?.message ?? error);
    }
  }

  #permit() {
    const version = this.store.db.prepare("SELECT version FROM room_writer_permit WHERE singleton=1").get()?.version ?? null;
    return Response.json({ version, schemaVersion: STORE_SCHEMA_VERSION });
  }

  // Commit the permit at the writer version outside a room transaction, the
  // shape left behind on 2026-10-24 (permit value == schema version, no write
  // in flight). The next cold start is what the outage hit.
  #stick() {
    const version = STORE_SCHEMA_VERSION;
    this.store.db.storage.sql.exec(`UPDATE room_writer_permit SET version=${version} WHERE singleton=1`);
    const row = this.store.db.storage.sql.exec("SELECT version FROM room_writer_permit WHERE singleton=1").one();
    return Response.json({ version: row.version, schemaVersion: version });
  }

  #command(key, type, data) {
    try {
      this.store.command(key, ROOM, { id: crypto.randomUUID(), type, data });
      return null;
    } catch (error) {
      if (error instanceof ServiceError) return { status: error.status, code: error.code, message: error.message };
      throw error;
    }
  }

  #seed() {
    const store = this.store;
    if (store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(ROOM)) return fail(409, "already_seeded", "Load room already exists");
    store.initialize(initialRoom(ROOM));
    const ownerKey = store.issueAccessKey(ROOM, "owner");
    const actors = [{ memberId: "owner", kind: "human", key: ownerKey }];
    for (let i = 1; i <= LOAD_BUDGET.people; i += 1) {
      const memberId = `person-${i}`;
      const added = this.#command(ownerKey, "member.added", {
        memberId, displayName: `Person${i} Harness`, kind: "human", permissions: []
      });
      if (added) return fail(500, "member_seed_failed", added.message, { status: added.status, code: added.code, memberId });
      actors.push({ memberId, kind: "human", key: store.issueAccessKey(ROOM, memberId) });
    }
    for (let i = 1; i <= LOAD_BUDGET.agents; i += 1) {
      const memberId = `agent-${i}`;
      const added = this.#command(ownerKey, "member.added", {
        memberId, displayName: `Agent${i} Harness`, kind: "agent", permissions: [], accountableHumanId: "owner"
      });
      if (added) return fail(500, "member_seed_failed", added.message, { status: added.status, code: added.code, memberId });
      actors.push({ memberId, kind: "agent", key: store.issueAccessKey(ROOM, memberId) });
    }

    const probed = sqliteValueLimit(store.db);
    const valueLimitBytes = Number.isSafeInteger(probed?.valueLimitBytes) ? probed.valueLimitBytes : null;
    const storageLimitBytes = roomStorageLimitBytes(PILOT_LIMITS.projectionBytes, valueLimitBytes);
    const target = Math.floor(storageLimitBytes * LOAD_BUDGET.fillRatio);
    const ceiling = Math.floor(storageLimitBytes * LOAD_BUDGET.fillRatioMax);

    const before = projectionBytes(store);
    const first = this.#command(ownerKey, "message.posted", { messageId: "load-cal-a", body: "c".repeat(1024) });
    if (first) return fail(500, "calibration_failed", first.message, { status: first.status, code: first.code });
    const mid = projectionBytes(store);
    const second = this.#command(ownerKey, "message.posted", { messageId: "load-cal-b", body: "c".repeat(2048) });
    if (second) return fail(500, "calibration_failed", second.message, { status: second.status, code: second.code });
    const after = projectionBytes(store);
    const perChar = (after - mid) / 1024;
    const fixed = (mid - before) - perChar * 1024;
    if (!Number.isFinite(perChar) || perChar < 0.5 || perChar > 8 || !Number.isFinite(fixed)) {
      return fail(500, "calibration_failed", "projection growth was not linear", { perChar, fixed, before, mid, after });
    }

    const spent = new Map(actors.map(actor => [actor.memberId, actor.memberId === "owner" ? 2 : 0]));
    let posts = 2;
    let guard = 0;
    while (projectionBytes(store) < target && guard < 120) {
      guard += 1;
      const have = projectionBytes(store);
      let len = Math.round((target - have - fixed) / perChar);
      if (!Number.isFinite(len) || len < 32) break;
      const capped = Math.floor((ceiling - have - fixed) / perChar);
      if (!Number.isFinite(capped) || capped < 32) break;
      len = Math.max(32, Math.min(MAX_BODY, len, capped));
      const author = actors.find(actor => (spent.get(actor.memberId) ?? 0) < 28) ?? actors[0];
      const posted = this.#command(author.key, "message.posted", { messageId: `load-fill-${posts}`, body: "b".repeat(len) });
      if (posted) {
        if (posted.status !== 409 && posted.status !== 413 && posted.status !== 429) {
          return fail(500, "fill_failed", posted.message, { status: posted.status, code: posted.code, posts, bytes: have });
        }
        if (posted.status === 429) {
          spent.set(author.memberId, 30);
          continue;
        }
        len = Math.max(32, Math.floor(len / 2));
        const author2 = actors.find(actor => (spent.get(actor.memberId) ?? 0) < 28) ?? author;
        const retry = this.#command(author2.key, "message.posted", { messageId: `load-fill-${posts}`, body: "b".repeat(len) });
        if (retry) break;
        spent.set(author2.memberId, (spent.get(author2.memberId) ?? 0) + 1);
      } else {
        spent.set(author.memberId, (spent.get(author.memberId) ?? 0) + 1);
      }
      posts += 1;
    }

    const bytes = projectionBytes(store);
    const permit = this.store.db.prepare("SELECT version FROM room_writer_permit WHERE singleton=1").get()?.version ?? null;
    return Response.json({
      roomId: ROOM,
      ownerKey,
      actors: actors.map(({ memberId, kind, key }) => ({ memberId, kind, key })),
      projectionBytes: bytes,
      storageLimitBytes,
      valueLimitBytes,
      fillRatio: bytes / storageLimitBytes,
      perChar,
      posts,
      permitVersion: permit,
      schemaVersion: STORE_SCHEMA_VERSION,
      dbBytes: dbBytes(store)
    });
  }
}

export default worker;
