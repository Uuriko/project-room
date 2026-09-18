// Thread assignment journal (lane C, inbox-agent-collab). Who owns a thread
// right now — an agent or a human — so parallel collaborators never work the
// same thread blind. assign/release/claim with a full event journal per
// thread; additive alongside server/inbox-handoff.mjs (which hands a thread
// *to* a named agent with context; this module owns the durable
// agent-or-human assignment state and releases).
//
// Pure, in-memory, dependency-free, deterministic; frozen outputs. Identity
// and validation raise AssignError (coded, never silent). Clock and id
// generator are injected so fixtures control time and ids.
// Clock is injected so fixtures control time.
export class AssignError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "AssignError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new AssignError(code, message, detail); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const assigneeKinds = Object.freeze(["agent", "human"]);
export const assignmentStatuses = Object.freeze(["assigned", "released"]);

export const identityOf = (value, field = "identity") => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "assign_invalid", `${field} must be an object`);
  check(Object.keys(value).every(k => ["kind", "id", "label"].includes(k)), "assign_invalid",
    `${field} carries only kind/id/label`);
  check(value.kind === "agent" || value.kind === "human", "assign_invalid", `${field}.kind must be "agent" or "human"`);
  check(typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.id), "assign_invalid",
    `${field}.id must be a 1..128 character identity`);
  const label = value.label === undefined || value.label === null ? null : value.label;
  check(label === null || (typeof label === "string" && label.isWellFormed() && label.length >= 1 && label.length <= 256),
    "assign_invalid", `${field}.label must be 1..256 well-formed characters`);
  return Object.freeze({ kind: value.kind, id: value.id, label });
};
export const threadIdOf = (value, field = "threadId") => {
  check(typeof value === "string" && value.isWellFormed() && value.length >= 1 && value.length <= 1024,
    "assign_invalid", `${field} must be 1..1024 well-formed characters`);
  return value;
};
const isoOf = ms => new Date(ms).toISOString();

const freezeRecord = record => Object.freeze({
  ...record,
  assignee: Object.freeze({ ...record.assignee }),
  assignedBy: Object.freeze({ ...record.assignedBy }),
  history: Object.freeze(record.history.map(event => Object.freeze({ ...event, by: Object.freeze({ ...event.by }) }))),
});

export function createAssignmentJournal({ clock = () => Date.now() } = {}) {
  const records = new Map(); // threadId -> assignment record

  const event = (record, name, by, reason = null) =>
    freezeRecord({ ...record, history: [...record.history, { event: name, at: isoOf(clock()), by,
      ...(reason ? { reason } : {}) }] });

  // Assign a thread to an agent or human. Re-assigning to the same identity
  // is idempotent (duplicate: true); assigning to a *different* identity
  // while assigned throws assign_conflict unless a human forces it with
  // { force: true } — a takeover is always explicit, never silent.
  function assign(threadId, assignee, { by, force = false } = {}) {
    const tid = threadIdOf(threadId);
    const who = identityOf(assignee, "assignee");
    const actor = identityOf(by, "by");
    const now = isoOf(clock());
    const current = records.get(tid);
    if (current && current.status === "assigned") {
      if (current.assignee.kind === who.kind && current.assignee.id === who.id)
        return Object.freeze({ record: current, duplicate: true });
      if (!force)
        fail("assign_conflict", `Thread is already assigned to ${current.assignee.id}; release it or force the takeover.`,
          { currentAssignee: current.assignee });
      check(actor.kind === "human", "assign_forbidden", "Only a human can force a takeover.");
      const taken = freezeRecord({ threadId: tid, assignee: who, assignedBy: actor, assignedAt: now,
        status: "assigned", history: current.history });
      const rec = event(taken, "reassigned", actor, `takeover from ${current.assignee.id}`);
      records.set(tid, rec);
      return Object.freeze({ record: rec, duplicate: false, takeover: true });
    }
    const rec = event(freezeRecord({ threadId: tid, assignee: who, assignedBy: actor, assignedAt: now,
      status: "assigned", history: [] }), "assigned", actor);
    records.set(tid, rec);
    return Object.freeze({ record: rec, duplicate: false });
  }

  // Release a thread: the record stays for the journal, the thread becomes
  // claimable again. Releasing a released/unknown thread is a no-op-safe
  // 404 — it reports assign_not_assigned instead of inventing state.
  function release(threadId, { by, reason = null } = {}) {
    const tid = threadIdOf(threadId);
    const actor = identityOf(by, "by");
    if (reason !== null && reason !== undefined)
      check(typeof reason === "string" && reason.isWellFormed() && reason.length >= 1 && reason.length <= 500,
        "assign_invalid", "reason must be 1..500 well-formed characters");
    const current = records.get(tid);
    if (!current || current.status !== "assigned") fail("assign_not_assigned", "Thread has no live assignment to release.");
    const rec = event(freezeRecord({ ...current, status: "released" }), "released", actor, reason);
    records.set(tid, rec);
    return rec;
  }

  // Claim a thread for yourself: only when it is unassigned or released.
  // Claiming someone else's live assignment is assign_conflict — ask for a
  // forced takeover through assign() instead.
  function claim(threadId, identity) {
    const tid = threadIdOf(threadId);
    const who = identityOf(identity, "identity");
    const current = records.get(tid);
    if (current && current.status === "assigned")
      fail("assign_conflict", `Thread is already assigned to ${current.assignee.id}; it cannot be claimed.`,
        { currentAssignee: current.assignee });
    const now = isoOf(clock());
    const rec = event(freezeRecord({ threadId: tid, assignee: who, assignedBy: who, assignedAt: now,
      status: "assigned", history: current?.history ?? [] }), "claimed", who);
    records.set(tid, rec);
    return rec;
  }

  function get(threadId) {
    const tid = threadIdOf(threadId);
    return records.get(tid) ?? null;
  }

  function list({ status = null, assigneeId = null } = {}) {
    if (status !== null && status !== undefined)
      check(assignmentStatuses.includes(status), "assign_invalid", `status must be one of ${assignmentStatuses.join(",")}`);
    let rows = [...records.values()];
    if (status) rows = rows.filter(r => r.status === status);
    if (assigneeId) rows = rows.filter(r => r.assignee.id === assigneeId);
    return Object.freeze(rows);
  }

  function journal(threadId) {
    const rec = get(threadId);
    return rec ? rec.history : Object.freeze([]);
  }

  return Object.freeze({ assign, release, claim, get, list, journal });
}
