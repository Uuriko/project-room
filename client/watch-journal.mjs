import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, realpathSync, openSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validId } from "../src/events.js";

export class WatchError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const MAX_ATTENTION = 1000;
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
function openDatabase(path, kind, create) {
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
      db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${id}; PRAGMA user_version=1; ${schemas[kind].join(";")}; COMMIT;`);
    }
    const catalog = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => normalize(row.sql)).sort();
    if (db.prepare("PRAGMA application_id").get().application_id !== id
        || db.prepare("PRAGMA user_version").get().user_version !== 1
        || JSON.stringify(catalog) !== JSON.stringify(schemas[kind].map(normalize).sort())
        || db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new WatchError("state_schema_mismatch");
    db.exec("PRAGMA synchronous=FULL;");
    if (db.prepare("PRAGMA max_page_count=4096").get().max_page_count > 4096) throw new WatchError("attention_capacity");
    if (kind === "state") validateRecords(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

function validateRecords(db) {
  db.exec("BEGIN");
  try {
    const row = db.prepare("SELECT body FROM checkpoint WHERE id=1").get();
    const rows = db.prepare("SELECT * FROM attention LIMIT ?").all(MAX_ATTENTION + 1);
    if (rows.length > MAX_ATTENTION || (!row && rows.length)) throw new Error();
    if (row) {
      const state = JSON.parse(row.body), b = state?.binding;
      if (Buffer.byteLength(row.body) > 8192 || !b || b.version !== 1 || b.filter !== "own-attention-v1"
          || typeof b.origin !== "string" || new URL(b.origin).origin !== b.origin
          || ![b.roomId, b.memberId, b.createdEventId].every(validId)
          || (b.accountId !== null && !validId(b.accountId))
          || (b.accountId === null ? b.authEpoch !== null : !Number.isSafeInteger(b.authEpoch) || b.authEpoch < 0)
          || !Number.isSafeInteger(state.sequence) || state.sequence < 1 || !validId(state.eventId)
          || typeof state.lastCheckedAt !== "string" || !Number.isFinite(Date.parse(state.lastCheckedAt))) throw new Error();
      for (const attention of rows) {
        const notice = JSON.parse(attention.notice), signature = JSON.parse(attention.signature);
        if (Buffer.byteLength(attention.notice) > 8192 || Buffer.byteLength(attention.signature) > 4096
            || !Array.isArray(signature) || signature.length !== 7 || !validId(attention.work_id)
            || notice?.schemaVersion !== 1 || notice.type !== "attention" || !validId(notice.id)
            || notice.workItemId !== attention.work_id || notice.roomId !== b.roomId || notice.memberId !== b.memberId
            || !["initial", "changed"].includes(notice.reason) || notice.notifyOnly !== true
            || typeof notice.title !== "string" || !Number.isSafeInteger(notice.evaluatedThrough)
            || notice.evaluatedThrough < 1 || notice.evaluatedThrough > state.sequence
            || typeof notice.observedAt !== "string" || !Number.isFinite(Date.parse(notice.observedAt))
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
  #owner; #db; #held = false; #runId;
  constructor(directory, { acquire = true } = {}) {
    if (typeof directory !== "string" || !directory.trim()) throw new WatchError("private_state_required");
    const path = resolve(directory);
    if (acquire) {
      try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    privatePath(path, true);
    const canonical = realpathSync(path);
    try {
      this.#owner = openDatabase(join(canonical, "ownership.sqlite"), "owner", acquire);
      if (acquire) {
        try { this.#owner.exec("BEGIN IMMEDIATE"); this.#held = true; }
        catch (error) { if (busy(error)) throw new WatchError("already_watching"); throw error; }
      }
      this.#db = openDatabase(join(canonical, "watch.sqlite"), "state", acquire);
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
    if (notices.size > MAX_ATTENTION) throw new WatchError("attention_capacity");
    this.#transaction(() => {
      const previous = this.state();
      if (previous && JSON.stringify(previous.binding) !== JSON.stringify(binding)) throw new WatchError("identity_changed");
      if (previous && (checkpoint.sequence < previous.sequence || (checkpoint.sequence === previous.sequence && checkpoint.eventId !== previous.eventId))) throw new WatchError("history_changed");
      const existing = new Map(this.#db.prepare("SELECT * FROM attention").all().map(row => [row.work_id, row]));
      for (const id of existing.keys()) if (!notices.has(id)) this.#db.prepare("DELETE FROM attention WHERE work_id=?").run(id);
      for (const [id, { signature, payload }] of notices) {
        if (existing.get(id)?.signature === signature) continue;
        const notice = JSON.stringify({ schemaVersion: 1, type: "attention", id: randomUUID(), reason: previous ? "changed" : "initial", observedAt: new Date(now).toISOString(), evaluatedThrough: checkpoint.sequence, ...payload });
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
    this.#transaction(() => this.#db.prepare("UPDATE attention SET pending=0 WHERE pending=1 AND json_extract(notice,'$.id')=?").run(id));
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
    return { schemaVersion: 1, state: held ? control?.stop_requested ? "stop_requested" : "held" : "stopped",
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
