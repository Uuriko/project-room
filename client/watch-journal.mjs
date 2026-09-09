import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, realpathSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validId } from "../src/events.js";
import { validateRequestNotice } from "./request-notices.mjs";

export class WatchError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const MAX_ATTENTION = 1000;
export const attentionCapacity = version => version === 3 ? 1001 : MAX_ATTENTION;
export const attentionFilter = version => version === 3 ? "own-context-v3" : version === 2 ? "own-context-v2" : "own-attention-v1";
const STATE_ID = 0x50525731, OWNER_ID = 0x50524c31;
const schemas = {
  owner: ["CREATE TABLE ownership (id INTEGER PRIMARY KEY)"],
  state: [
    "CREATE TABLE checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)",
    "CREATE TABLE attention (work_id TEXT PRIMARY KEY, signature TEXT NOT NULL, notice TEXT NOT NULL, pending INTEGER NOT NULL CHECK(pending IN (0,1)))",
    "CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT NOT NULL, stop_requested INTEGER NOT NULL CHECK(stop_requested IN (0,1)), health TEXT NOT NULL)"
  ]
};
const normalize = sql => sql.replace(/\s+/g, " ").trim();
const busy = error => error.errcode === 5 || error.errcode === 6;
function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new WatchError("private_state_required");
}
function openDatabase(path, kind, create, version = 1) {
  let fresh = false;
  if (create) {
    try { closeSync(openSync(path, "wx", 0o600)); fresh = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  privatePath(path);
  // SQLite's sidecars must not resolve outside the dedicated private directory.
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { privatePath(path + suffix); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const db = new DatabaseSync(path, { timeout: kind === "owner" ? 0 : 1000 });
  try {
    const id = kind === "owner" ? OWNER_ID : STATE_ID;
    if (fresh) {
      db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${id}; PRAGMA user_version=${version}; ${schemas[kind].join(";")}; COMMIT;`);
    }
    const catalog = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => normalize(row.sql)).sort();
    if (db.prepare("PRAGMA application_id").get().application_id !== id
        || !(version === null ? [1, 2, 3] : [version]).includes(db.prepare("PRAGMA user_version").get().user_version)
        || JSON.stringify(catalog) !== JSON.stringify(schemas[kind].map(normalize).sort())
        || db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new WatchError("state_schema_mismatch");
    db.exec("PRAGMA synchronous=FULL;");
    if (db.prepare("PRAGMA max_page_count=4096").get().max_page_count > 4096) throw new WatchError("attention_capacity");
    if (kind === "state") validateRecords(db, db.prepare("PRAGMA user_version").get().user_version);
    return db;
  } catch (error) { db.close(); throw error; }
}

function validateContextNotice(notice, signature, key, binding) {
  const charter = notice.charter;
  if (!charter || !Number.isSafeInteger(charter.revision) || charter.revision < 0 || charter.revision > notice.evaluatedThrough
      || (charter.revision === 0 ? charter.eventId !== null : !validId(charter.eventId))) throw new Error();
  if (notice.subject === "instructions") {
    if (key !== JSON.stringify(["instructions"]) || charter.revision === 0
        || JSON.stringify(signature) !== JSON.stringify(["instructions", charter.revision, charter.eventId])
        || notice.workItemId !== undefined || notice.next !== undefined
        || JSON.stringify(notice.nextRead) !== JSON.stringify({ tool: "room_list_work", arguments: {} })) throw new Error();
  } else if (notice.subject === "work") {
    if (!validId(notice.workItemId) || key !== JSON.stringify(["work", notice.workItemId])
        || signature.length !== 8 || signature[0] !== "work" || signature[1] !== notice.next?.action
        || signature[2] !== binding.memberId || signature[3] !== notice.next?.completionEventId
        || signature[4] !== notice.next?.evidenceVersion || notice.next?.memberId !== binding.memberId
        || notice.next?.workItemId !== notice.workItemId || notice.next?.needsAttention !== true
        || !Number.isSafeInteger(notice.next.workRevision) || notice.next.workRevision < 0
        || JSON.stringify(notice.nextRead) !== JSON.stringify({ tool: "room_read_work", arguments: { workItemId: notice.workItemId, includeSource: false } })) throw new Error();
  } else throw new Error();
}
function validateRecords(db, version) {
  db.exec("BEGIN");
  try {
    const row = db.prepare("SELECT body FROM checkpoint WHERE id=1").get();
    const rows = db.prepare("SELECT * FROM attention LIMIT ?").all(attentionCapacity(version) + 1);
    if (rows.length > attentionCapacity(version) || (!row && rows.length)) throw new Error();
    if (row) {
      const state = JSON.parse(row.body), b = state?.binding;
      if (Buffer.byteLength(row.body) > 8192 || !b || b.version !== version || b.filter !== attentionFilter(version)
          || typeof b.origin !== "string" || new URL(b.origin).origin !== b.origin
          || ![b.roomId, b.memberId, b.createdEventId].every(validId)
          || (b.accountId !== null && !validId(b.accountId))
          || (b.accountId === null ? b.authEpoch !== null : !Number.isSafeInteger(b.authEpoch) || b.authEpoch < 0)
          || !Number.isSafeInteger(state.sequence) || state.sequence < 1 || !validId(state.eventId)
          || typeof state.lastCheckedAt !== "string" || !Number.isFinite(Date.parse(state.lastCheckedAt))) throw new Error();
      const ids = new Set();
      for (const attention of rows) {
        const notice = JSON.parse(attention.notice), signature = JSON.parse(attention.signature);
        if (Buffer.byteLength(attention.notice) > 8192 || Buffer.byteLength(attention.signature) > 4096
            || !Array.isArray(signature)
            || notice?.schemaVersion !== version || notice.type !== "attention" || !validId(notice.id)
            || notice.roomId !== b.roomId || notice.memberId !== b.memberId
            || !["initial", "changed"].includes(notice.reason) || notice.notifyOnly !== true
            || typeof notice.title !== "string" || !Number.isSafeInteger(notice.evaluatedThrough)
            || notice.evaluatedThrough < 1 || notice.evaluatedThrough > state.sequence
            || typeof notice.observedAt !== "string" || !Number.isFinite(Date.parse(notice.observedAt))) throw new Error();
        if (version >= 2) {
          if (ids.has(notice.id)) throw new Error();
          ids.add(notice.id);
          if (version === 3 && notice.subject === "request") validateRequestNotice(notice, signature, attention.work_id, b);
          else validateContextNotice(notice, signature, attention.work_id, b);
        }
        else if (signature.length !== 7 || !validId(attention.work_id) || notice.workItemId !== attention.work_id
            || notice.next?.memberId !== b.memberId || notice.next?.needsAttention !== true) throw new Error();
      }
    }
    const control = db.prepare("SELECT * FROM control WHERE id=1").get();
    if ((row && !control) || (control && (!validId(control.run_id) || !["starting", "watching", "retrying", "stopped"].includes(control.health)))) throw new Error();
    db.exec("COMMIT");
  } catch { db.exec("ROLLBACK"); throw new WatchError("state_schema_mismatch"); }
}

// Two databases intentionally: lifetime stdout ownership must not block short
// checkpoint commits or a second process's stop request. Never unlink either file.
export class WatchJournal {
  #owner; #db; #held = false; #runId; #version;
  constructor(directory, { acquire = true, version = acquire ? 1 : null, create = acquire } = {}) {
    if ((acquire && ![1, 2, 3].includes(version)) || (!acquire && version !== null && ![1, 2, 3].includes(version))) throw new WatchError("state_schema_mismatch");
    if (typeof directory !== "string" || !directory.trim()) throw new WatchError("private_state_required");
    const path = resolve(directory);
    if (create) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    privatePath(path, true);
    const canonical = realpathSync(path);
    try {
      this.#owner = openDatabase(join(canonical, "ownership.sqlite"), "owner", create);
      if (acquire) {
        try { this.#owner.exec("BEGIN IMMEDIATE"); this.#held = true; }
        catch (error) { if (busy(error)) throw new WatchError("already_watching"); throw error; }
      }
      this.#db = openDatabase(join(canonical, "watch.sqlite"), "state", create, version);
      this.#version = this.#db.prepare("PRAGMA user_version").get().user_version;
      if (acquire) {
        this.#runId = randomUUID();
        this.#transaction(() => this.#db.prepare("INSERT INTO control VALUES (1,?,0,'starting') ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,stop_requested=0,health='starting'").run(this.#runId));
      }
    } catch (error) { this.close(); throw error; }
  }
  #transaction(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.#db.exec("COMMIT"); return value; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #requireHolder() { if (!this.#held) throw new WatchError("watcher_not_owner"); }
  state() { const row = this.#db.prepare("SELECT body FROM checkpoint WHERE id=1").get(); return row ? JSON.parse(row.body) : null; }
  reconcile(binding, checkpoint, notices, now) {
    this.#requireHolder();
    if (binding.version !== this.#version) throw new WatchError("state_schema_mismatch");
    if (notices.size > attentionCapacity(this.#version)) throw new WatchError("attention_capacity");
    this.#transaction(() => {
      const previous = this.state();
      if (previous && JSON.stringify(previous.binding) !== JSON.stringify(binding)) throw new WatchError("identity_changed");
      if (previous && (checkpoint.sequence < previous.sequence || (checkpoint.sequence === previous.sequence && checkpoint.eventId !== previous.eventId))) throw new WatchError("history_changed");
      const existing = new Map(this.#db.prepare("SELECT * FROM attention").all().map(row => [row.work_id, row]));
      for (const id of existing.keys()) if (!notices.has(id)) this.#db.prepare("DELETE FROM attention WHERE work_id=?").run(id);
      for (const [id, { signature, payload }] of notices) {
        if (existing.get(id)?.signature === signature) continue;
        const notice = JSON.stringify({ schemaVersion: this.#version, type: "attention", id: randomUUID(), reason: previous ? "changed" : "initial", observedAt: new Date(now).toISOString(), evaluatedThrough: checkpoint.sequence, ...payload });
        if (Buffer.byteLength(notice) > 8192 || Buffer.byteLength(signature) > 4096) throw new WatchError("attention_capacity");
        this.#db.prepare("INSERT INTO attention VALUES (?,?,?,1) ON CONFLICT(work_id) DO UPDATE SET signature=excluded.signature,notice=excluded.notice,pending=1").run(id, signature, notice);
      }
      const body = JSON.stringify({ binding, ...checkpoint, lastCheckedAt: new Date(now).toISOString() });
      this.#db.prepare("INSERT INTO checkpoint VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(body);
    });
  }
  pending(limit = 20) {
    this.#requireHolder();
    return this.#db.prepare("SELECT notice FROM attention WHERE pending=1 ORDER BY work_id LIMIT ?").all(limit).map(row => JSON.parse(row.notice));
  }
  ack(id) {
    this.#requireHolder();
    if (this.#version !== 1) throw new WatchError("explicit_ack_required");
    this.#transaction(() => this.#db.prepare("UPDATE attention SET pending=0 WHERE pending=1 AND json_extract(notice,'$.id')=?").run(id));
  }
  acknowledge(id) {
    this.#requireHolder();
    if (![2, 3].includes(this.#version) || !validId(id)) throw new WatchError("invalid_notice");
    return this.#transaction(() => {
      const rows = this.#db.prepare("SELECT work_id,pending FROM attention WHERE json_extract(notice,'$.id')=? LIMIT 2").all(id);
      if (rows.length > 1) throw new WatchError("state_schema_mismatch");
      const row = rows[0]; if (!row) return "no_longer_current";
      if (!row.pending) return "already_acknowledged";
      this.#db.prepare("UPDATE attention SET pending=0 WHERE work_id=?").run(row.work_id);
      return "acknowledged";
    });
  }
  health(value) {
    this.#requireHolder();
    this.#transaction(() => this.#db.prepare("UPDATE control SET health=? WHERE id=1 AND run_id=?").run(value, this.#runId));
  }
  shouldStop() {
    this.#requireHolder();
    const row = this.#db.prepare("SELECT run_id,stop_requested FROM control WHERE id=1").get();
    return row?.run_id !== this.#runId || row.stop_requested === 1;
  }
  #isHeld() {
    if (this.#held) return true;
    try { this.#owner.exec("BEGIN IMMEDIATE; ROLLBACK;"); return false; }
    catch (error) { if (busy(error)) return true; throw error; }
  }
  status() {
    const held = this.#isHeld(), control = this.#db.prepare("SELECT * FROM control WHERE id=1").get(), state = this.state();
    return { schemaVersion: this.#version, state: held ? control?.stop_requested ? "stop_requested" : "held" : "stopped",
      health: held ? control?.health ?? "unknown" : "not_running", lastCheckedAt: state?.lastCheckedAt ?? null,
      evaluatedThrough: state?.sequence ?? null, pending: this.#db.prepare("SELECT count(*) AS n FROM attention WHERE pending=1").get().n };
  }
  requestStop() {
    const status = this.status();
    if (status.state === "stopped") return status;
    const run = this.#db.prepare("SELECT run_id FROM control WHERE id=1").get();
    if (run) this.#transaction(() => this.#db.prepare("UPDATE control SET stop_requested=1 WHERE id=1 AND run_id=?").run(run.run_id));
    return { ...status, state: "stop_requested" };
  }
  close() {
    this.#db?.close(); this.#db = undefined;
    this.#owner?.close(); this.#owner = undefined; this.#held = false;
  }
}
