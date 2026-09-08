// Read-only offline audit. It neither repairs data nor proves post-capture authority.
import { createHash } from "node:crypto";
import { EVENT_TYPES, validId } from "../src/events.js";
import { terminalWork } from "../src/workflow.js";
import { applicationTables, STORE_SCHEMA_VERSION } from "./writer-fence.mjs";

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const requireState = condition => { if (!condition) throw new Error("Recovery data requires operator reconciliation"); };
const integer = value => Number.isSafeInteger(value);

export function auditRecovery(store) {
  return store.readTransaction(() => {
    requireState(store.storagePlatform.version(store.db) === STORE_SCHEMA_VERSION);
    store.storagePlatform.verifyWriterFence(store.db);
    requireState(store.db.prepare("PRAGMA quick_check").get().quick_check === "ok");
    requireState(store.db.prepare("PRAGMA foreign_key_check").all().length === 0);
    const platform = store.db.storage ? "durable-object" : "node-sqlite";
    const runtimeTables = platform === "durable-object" ? ["room_runtime_version", "room_writer_permit"] : [];
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(row => row.name).filter(name => !name.startsWith("sqlite_") && !(platform === "durable-object" && name.startsWith("_cf_")));
    requireState(canonical(tables) === canonical([...applicationTables, ...runtimeTables].sort()));
    const rooms = new Map();
    let eventCount = 0, checkpointCount = 0, checkpointEvents = 0;
    for (const row of store.db.prepare("SELECT id,sequence FROM rooms ORDER BY id").all()) {
      const actual = store.room(row.id), rebuilt = store.rebuildProjection(row.id);
      requireState(canonical(actual) === canonical(rebuilt));
      requireState(actual.state.room?.id === row.id);
      const checkpoint = store.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id=?").get(row.id);
      if (checkpoint) {
        requireState(integer(checkpoint.sequence) && checkpoint.sequence >= 0 && checkpoint.sequence <= row.sequence
          && JSON.parse(checkpoint.projection).room?.id === row.id);
        checkpointCount++; checkpointEvents += checkpoint.sequence;
      }
      requireState(integer(row.sequence) && row.sequence >= 0);
      const history = store.db.prepare("SELECT sequence,id,body FROM events WHERE room_id=? ORDER BY sequence").all(row.id);
      requireState(history.length === row.sequence);
      history.forEach((entry, index) => {
        const event = JSON.parse(entry.body);
        requireState(entry.sequence === index + 1 && event.id === entry.id && event.roomId === row.id);
        requireState([event.id, event.idempotencyKey, event.actorId, event.roomId].every(validId)
          && Object.values(EVENT_TYPES).includes(event.type) && typeof event.at === "string" && Number.isFinite(Date.parse(event.at))
          && event.data && typeof event.data === "object" && !Array.isArray(event.data));
      });
      eventCount += history.length;
      rooms.set(row.id, actual.state);
    }
    const invitations = store.verifyInvitationAudit();
    store.shareLinks.verify(); store.reminders.verifySchema(); store.agentConnections.verify();
    const reminders = store.db.prepare("SELECT * FROM private_reminders").all();
    const receipts = store.db.prepare("SELECT * FROM private_reminder_commands").all();
    const byWork = new Map();
    for (const row of receipts) {
      const receipt = JSON.parse(row.response);
      requireState(receipt && Object.keys(receipt).sort().join(" ") === "dueAt requestId revision state workItemId"
        && validId(row.member_id) && validId(row.request_id) && receipt.requestId === row.request_id
        && validId(receipt.workItemId) && integer(receipt.revision) && receipt.revision > 0
        && integer(receipt.dueAt) && ["active", "cancelled"].includes(receipt.state));
      const request = { requestId: receipt.requestId, workItemId: receipt.workItemId,
        expectedRevision: receipt.revision - 1, action: receipt.state === "active" ? "schedule" : "cancel",
        ...(receipt.state === "active" ? { dueAt: receipt.dueAt } : {}) };
      requireState(row.fingerprint === digest(request));
      const key = canonical([row.room_id, row.member_id, receipt.workItemId]);
      const history = byWork.get(key) ?? [];
      requireState(!history.some(item => item.revision === receipt.revision));
      history.push(receipt); byWork.set(key, history);
    }
    for (const history of byWork.values()) {
      history.sort((a, b) => a.revision - b.revision);
      requireState(history[0].revision === 1 && history[0].state === "active");
      for (let i = 1; i < history.length; i++) {
        const prior = history[i - 1], next = history[i], step = next.revision - prior.revision;
        requireState(step === 1 || (step === 2 && prior.state === "active" && next.state === "active"));
        if (next.state === "cancelled") requireState(prior.state === "active" && step === 1 && prior.dueAt === next.dueAt);
      }
    }
    for (const row of reminders) {
      const state = rooms.get(row.room_id), member = state?.members[row.member_id], work = state?.workItems[row.work_item_id];
      const key = canonical([row.room_id, row.member_id, row.work_item_id]);
      const history = byWork.get(key), latest = history?.reduce((a, b) => a.revision > b.revision ? a : b);
      requireState(member && work && integer(row.revision) && row.revision > 0 && integer(row.due_at)
        && integer(row.basis_work_revision) && row.basis_work_revision >= 0 && row.basis_work_revision <= work.revision
        && integer(row.created_at) && integer(row.updated_at) && latest
        && latest.dueAt === row.due_at && ["active", "cancelled", "resolved"].includes(row.state));
      if (row.state === "resolved") requireState(latest.state === "active" && row.revision === latest.revision + 1);
      else requireState(latest.revision === row.revision && latest.state === row.state);
      const account = store.accountForMember(row.room_id, row.member_id);
      if (member.kind === "human") requireState(account);
      if (row.state === "active") requireState(member.active && !terminalWork(work) && (member.kind !== "human" || account.active));
      byWork.delete(key);
    }
    requireState(byWork.size === 0);
    const contents = applicationTables.map(table => {
      const rows = store.db.prepare(`SELECT * FROM ${table}`).all().map(canonical).sort();
      return { table, rows: rows.length, sha256: digest(rows) };
    });
    return { contractVersion: 1, schemaVersion: STORE_SCHEMA_VERSION, platform,
      checks: { sqlite: true, foreignKeys: true, writerFence: true, projectionReplay: true, invitationAudit: true, shareLinks: true, reminders: true, agentConnections: true },
      rooms: rooms.size, events: eventCount, legacyCheckpoints: checkpointCount,
      replay: { basis: "retained checkpoint plus strict tail, or full history without a checkpoint", checkpointEvents, replayedEvents: eventCount - checkpointEvents },
      invitations: invitations.invitations, reminders: reminders.length, reminderReceipts: receipts.length,
      tables: contents, dataSha256: digest(contents),
      authorityFreshness: "capture-only; later revocations, writes and external effects require reconciliation" };
  });
}
