import { createHash } from "node:crypto";
import { validId } from "../src/events.js";
import { terminalWork } from "../src/workflow.js";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
export const reminderLimits = Object.freeze({ active: 100, receipts: 5000, horizon: 365 * 86400000 });
export const reminderSchema = `
  CREATE TABLE private_reminders (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0), due_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','cancelled','resolved')),
    basis_work_revision INTEGER NOT NULL CHECK(basis_work_revision>=0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,member_id,work_item_id)
  );
  CREATE INDEX private_reminders_active_work ON private_reminders(room_id,work_item_id) WHERE state='active';
  CREATE TABLE private_reminder_commands (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY(room_id,member_id,request_id)
  );
  CREATE TRIGGER private_reminder_commands_no_update BEFORE UPDATE ON private_reminder_commands BEGIN SELECT RAISE(ABORT,'reminder receipts are immutable'); END;
  CREATE TRIGGER private_reminder_commands_no_delete BEFORE DELETE ON private_reminder_commands BEGIN SELECT RAISE(ABORT,'reminder receipts are retained'); END;
`;
const view = row => ({ workItemId: row.work_item_id, revision: row.revision, dueAt: row.due_at, state: row.state,
  basisWorkRevision: row.basis_work_revision, createdAt: row.created_at, updatedAt: row.updated_at });

export class Reminders {
  constructor(store) { this.store = store; this.db = store.db; }
  verifySchema() {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/\s+/g, " ");
    for (const sql of reminderSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)) {
      const name = /^CREATE (?:TABLE|INDEX|TRIGGER) ([a-z_]+)/.exec(sql.trim())[1];
      const actual = this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql;
      if (normalize(actual) !== normalize(sql)) throw new Error("Private reminder schema requires operator reconciliation");
    }
  }
  current(auth, roomId) {
    return {
      roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null, evaluatedAt: this.store.now(),
      reminders: this.db.prepare("SELECT * FROM private_reminders WHERE room_id=? AND member_id=? ORDER BY work_item_id").all(roomId, auth.member.id).map(view)
    };
  }
  list(token, roomId, binding = null) {
    return this.store.readTransaction(() => this.current(this.store.authenticate(token, roomId, binding), roomId));
  }
  mutate(token, roomId, request, binding = null) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const fields = ["requestId", "workItemId", "expectedRevision", "action", ...(request?.action === "schedule" ? ["dueAt"] : [])];
      if (!request || Array.isArray(request) || Object.keys(request).length !== fields.length || !fields.every(field => Object.hasOwn(request, field))
        || !validId(request.requestId) || !validId(request.workItemId) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
        || !["schedule", "cancel"].includes(request.action) || (request.action === "schedule" && !Number.isSafeInteger(request.dueAt))) fail(422, "invalid_reminder", "Supply one work item, reminder revision, action and request ID; scheduling also needs a UTC time.");
      const fingerprint = createHash("sha256").update(JSON.stringify(Object.fromEntries(fields.sort().map(field => [field, request[field]])))).digest("hex");
      const prior = this.db.prepare("SELECT fingerprint,response FROM private_reminder_commands WHERE room_id=? AND member_id=? AND request_id=?").get(roomId, auth.member.id, request.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Request ID already used for different reminder settings");
        return { ...this.current(auth, roomId), receipt: JSON.parse(prior.response), duplicate: true };
      }
      const work = this.store.room(roomId).state.workItems;
      if (!Object.hasOwn(work, request.workItemId)) fail(404, "work_not_found", "Work no longer exists");
      const row = this.db.prepare("SELECT * FROM private_reminders WHERE room_id=? AND member_id=? AND work_item_id=?").get(roomId, auth.member.id, request.workItemId);
      if ((row?.revision ?? 0) !== request.expectedRevision) fail(409, "stale_reminder", "Your reminder changed. Review its current time before saving.");
      const now = this.store.now();
      if (request.action === "schedule") {
        if (terminalWork(work[request.workItemId])) fail(409, "work_resolved", "This work is resolved; no reminder was scheduled.");
        if (request.dueAt <= now || request.dueAt > now + reminderLimits.horizon) fail(422, "invalid_reminder_time", "Choose a future time within one year.");
        const count = this.db.prepare("SELECT count(*) n FROM private_reminder_commands WHERE room_id=? AND member_id=?").get(roomId, auth.member.id).n;
        const active = this.db.prepare("SELECT count(*) n FROM private_reminders WHERE room_id=? AND member_id=? AND state='active'").get(roomId, auth.member.id).n;
        if (count >= reminderLimits.receipts || (row?.state !== "active" && active >= reminderLimits.active)) fail(409, "reminder_limit", "Reminder capacity reached. Existing reminders can still be cancelled.");
      } else if (row?.state !== "active") fail(409, "reminder_inactive", "There is no active reminder to cancel.");
      const receipt = { requestId: request.requestId, workItemId: request.workItemId, revision: (row?.revision ?? 0) + 1,
        state: request.action === "schedule" ? "active" : "cancelled", dueAt: request.dueAt ?? row.due_at };
      this.db.prepare(`INSERT INTO private_reminders VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id,member_id,work_item_id)
        DO UPDATE SET revision=excluded.revision,due_at=excluded.due_at,state=excluded.state,basis_work_revision=excluded.basis_work_revision,updated_at=excluded.updated_at`)
        .run(roomId, auth.member.id, request.workItemId, receipt.revision, receipt.dueAt, receipt.state, work[request.workItemId].revision, row?.created_at ?? now, now);
      this.db.prepare("INSERT INTO private_reminder_commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, request.requestId, fingerprint, JSON.stringify(receipt));
      return { ...this.current(auth, roomId), receipt, duplicate: false };
    });
  }
  resolveWork(roomId, work) {
    if (work && terminalWork(work)) this.db.prepare("UPDATE private_reminders SET state='resolved',revision=revision+1,updated_at=? WHERE room_id=? AND work_item_id=? AND state='active'").run(this.store.now(), roomId, work.id);
  }
  retireMember(roomId, memberId) {
    this.db.prepare("UPDATE private_reminders SET state='resolved',revision=revision+1,updated_at=? WHERE room_id=? AND member_id=? AND state='active'").run(this.store.now(), roomId, memberId);
  }
  retireAccount(accountId) {
    for (const row of this.db.prepare("SELECT room_id,member_id FROM member_accounts WHERE account_id=?").all(accountId)) this.retireMember(row.room_id, row.member_id);
  }
}
