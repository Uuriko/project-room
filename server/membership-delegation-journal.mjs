// Append-only, per-room hash-chain for owner membership delegation decisions.
// Hashes detect damaged/reordered rows and disagreement with the live grants;
// without an external anchor they cannot authenticate a privileged database rewrite.
import { createHash } from "node:crypto";

export const membershipDelegationJournalSchema = `
  CREATE TABLE IF NOT EXISTS membership_delegation_journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('baseline_active','baseline_revoked','grant','revoke','revoke_effective')),
    actor_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    prior_active INTEGER NOT NULL CHECK(prior_active IN (0,1)),
    next_active INTEGER NOT NULL CHECK(next_active IN (0,1)),
    prior_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS membership_delegation_journal_room ON membership_delegation_journal(room_id, sequence);
  CREATE TABLE IF NOT EXISTS membership_delegation_pending (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, identity_id TEXT NOT NULL,
    prior_active INTEGER NOT NULL, next_active INTEGER NOT NULL, recorded_at INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS membership_delegation_pending_insert AFTER INSERT ON membership_delegation_grants
    BEGIN INSERT INTO membership_delegation_pending(room_id,identity_id,prior_active,next_active,recorded_at)
      VALUES(NEW.room_id,NEW.identity_id,0,NEW.revoked_at IS NULL,NEW.granted_at); END;
  CREATE TRIGGER IF NOT EXISTS membership_delegation_pending_update AFTER UPDATE OF revoked_at ON membership_delegation_grants
    WHEN (OLD.revoked_at IS NULL) <> (NEW.revoked_at IS NULL)
    BEGIN INSERT INTO membership_delegation_pending(room_id,identity_id,prior_active,next_active,recorded_at)
      VALUES(NEW.room_id,NEW.identity_id,OLD.revoked_at IS NULL,NEW.revoked_at IS NULL,
        CASE WHEN NEW.revoked_at IS NULL THEN NEW.granted_at ELSE NEW.revoked_at END); END;
  CREATE TRIGGER IF NOT EXISTS membership_delegation_pending_delete BEFORE DELETE ON membership_delegation_grants
    BEGIN SELECT RAISE(ABORT,'Membership delegation grant deletion requires operator reconciliation'); END;
`;
const ZERO = "0".repeat(64);
const rowHash = row => createHash("sha256").update(JSON.stringify([
  row.prior_hash, row.sequence, row.room_id, row.identity_id, row.action, row.actor_id,
  row.recorded_at, row.prior_active, row.next_active
])).digest("hex");
const invalid = () => { throw new Error("Membership delegation journal requires operator reconciliation"); };

export class MembershipDelegationJournal {
  constructor(store) { this.store = store; this.db = store.db; }
  // Run under the same store transaction as the table write and any
  // member.access_changed event. A failed mutation leaves no audit assertion.
  append(roomId, identityId, action, actorId, at, priorActive, nextActive) {
    const previous = this.db.prepare("SELECT hash FROM membership_delegation_journal WHERE room_id=? ORDER BY sequence DESC LIMIT 1").get(roomId);
    const row = { room_id: roomId, identity_id: identityId, action, actor_id: actorId,
      recorded_at: at, prior_active: Number(priorActive), next_active: Number(nextActive), prior_hash: previous?.hash ?? ZERO };
    const inserted = this.db.prepare(`INSERT INTO membership_delegation_journal
      (room_id,identity_id,action,actor_id,recorded_at,prior_active,next_active,prior_hash,hash)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(roomId, identityId, action, actorId, at,
      row.prior_active, row.next_active, row.prior_hash, "pending");
    row.sequence = Number(inserted.lastInsertRowid);
    const hash = rowHash(row);
    this.db.prepare("UPDATE membership_delegation_journal SET hash=? WHERE sequence=?").run(hash, row.sequence);
    // The trigger also records new-writer changes; consume exactly the matching
    // transition in this transaction. Older writers leave it for redeploy.
    if (action !== "baseline_active" && action !== "baseline_revoked"
      && actorId !== "rollback_unattributed") {
      const pending = this.db.prepare("SELECT * FROM membership_delegation_pending ORDER BY sequence LIMIT 1").get();
      if (!pending || pending.room_id !== roomId || pending.identity_id !== identityId
        || pending.prior_active !== Number(priorActive) || pending.next_active !== Number(nextActive)) invalid();
      this.db.prepare("DELETE FROM membership_delegation_pending WHERE sequence=?").run(pending.sequence);
    }
    return { sequence: row.sequence, hash };
  }
  // Rows from before this feature have unknown decision provenance. Record only
  // their current state, never fabricate an owner decision or date.
  baseline() {
    const rows = this.db.prepare(`SELECT room_id,identity_id,revoked_at FROM membership_delegation_grants
      ORDER BY room_id,identity_id`).all();
    for (const row of rows) {
      const active = row.revoked_at === null;
      this.append(row.room_id, row.identity_id, active ? "baseline_active" : "baseline_revoked",
        "legacy_unattributed", this.store.now(), false, active);
    }
  }
  reconcileRollback() {
    // Only trigger-recorded transitions may be imported. The chain is checked
    // before import; its final state is then checked against the grant table.
    this.verify({ allowPending: true });
    const rows = this.db.prepare("SELECT * FROM membership_delegation_pending ORDER BY sequence").all();
    for (const row of rows) {
      const latest = this.db.prepare(`SELECT next_active FROM membership_delegation_journal
        WHERE room_id=? AND identity_id=? ORDER BY sequence DESC LIMIT 1`).get(row.room_id, row.identity_id);
      if (Number(latest?.next_active ?? 0) !== row.prior_active || row.prior_active === row.next_active
        || !Number.isSafeInteger(row.recorded_at) || row.recorded_at < 0) invalid();
      this.append(row.room_id, row.identity_id,
        row.next_active ? "baseline_active" : "baseline_revoked",
        "rollback_unattributed", row.recorded_at, !!row.prior_active, !!row.next_active);
      this.db.prepare("DELETE FROM membership_delegation_pending WHERE sequence=?").run(row.sequence);
    }
    this.verify();
    return rows.length;
  }
  verify({ allowAbsent = false, allowPending = false } = {}) {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='membership_delegation_journal'").get();
    if (!table) { if (allowAbsent) return { entries: 0, absent: true }; invalid(); }
    const columns = this.db.prepare("PRAGMA table_info(membership_delegation_journal)").all().map(row => row.name);
    if (columns.join(",") !== "sequence,room_id,identity_id,action,actor_id,recorded_at,prior_active,next_active,prior_hash,hash"
      || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='membership_delegation_journal_room'").get()) invalid();
    const state = new Map(), chain = new Map();
    const rows = this.db.prepare("SELECT * FROM membership_delegation_journal ORDER BY sequence").all();
    let lastSequence = 0;
    for (const row of rows) {
      const key = JSON.stringify([row.room_id, row.identity_id]);
      const prior = state.get(key) ?? false;
      const baseline = row.action === "baseline_active" || row.action === "baseline_revoked";
      const rollback = baseline && row.actor_id === "rollback_unattributed";
      const next = row.next_active === 1;
      if (!Number.isSafeInteger(row.sequence) || row.sequence !== lastSequence + 1 || !Number.isSafeInteger(row.recorded_at)
        || row.recorded_at < 0 || !/^[A-Za-z0-9_-]{1,64}$/.test(row.identity_id)
        || typeof row.room_id !== "string" || !row.room_id || typeof row.actor_id !== "string" || !row.actor_id
        || ![0, 1].includes(row.prior_active) || ![0, 1].includes(row.next_active)
        || !["baseline_active", "baseline_revoked", "grant", "revoke", "revoke_effective"].includes(row.action)
        || row.prior_hash !== (chain.get(row.room_id) ?? ZERO) || row.hash !== rowHash(row)
        || row.prior_active !== Number(prior) || state.has(key) && baseline && !rollback
        || baseline && (!rollback && row.actor_id !== "legacy_unattributed"
          || next !== (row.action === "baseline_active") || rollback && prior === next)
        || !baseline && (row.actor_id === "legacy_unattributed" || row.actor_id === "rollback_unattributed"
          || prior === next || next !== (row.action === "grant"))) invalid();
      lastSequence = row.sequence; chain.set(row.room_id, row.hash); state.set(key, next);
    }
    const grants = this.db.prepare("SELECT room_id,identity_id,revoked_at FROM membership_delegation_grants").all();
    const seq = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='membership_delegation_journal'").get()?.seq ?? 0;
    const pending = this.db.prepare("SELECT * FROM membership_delegation_pending ORDER BY sequence").all();
    if (seq !== lastSequence || (!allowPending && pending.length)) invalid();
    if (allowPending) {
      const projected = new Map(state);
      for (const row of pending) {
        const key = JSON.stringify([row.room_id, row.identity_id]);
        if (Number(projected.get(key) ?? false) !== row.prior_active || row.prior_active === row.next_active) invalid();
        projected.set(key, !!row.next_active);
      }
      state.clear(); for (const [key, value] of projected) state.set(key, value);
    }
    if (grants.length !== state.size) invalid();
    for (const row of grants) {
      const key = JSON.stringify([row.room_id, row.identity_id]);
      if (!state.has(key) || state.get(key) !== (row.revoked_at === null)) invalid();
    }
    return { entries: rows.length, absent: false };
  }
}
