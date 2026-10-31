// Explicit, bounded repair of already-diagnosed legacy indexed message shapes.
// Never replays events or rewrites projections, bodies, indexes, or checkpoints.
import { createHash } from 'node:crypto';
import { ServiceError } from './service-error.mjs';
import { appendOperatorAction } from './operator-actions.mjs';
import { operatorParityDiagnostics } from './operator-parity-diagnostics.mjs';
import { hydrateProjection } from './projection-at-rest.mjs';
import { messageRecordParityDetail } from './messages-store.mjs';
import { upgradeLegacyMessages } from './legacy-message-shape.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, status = 409) => { throw new ServiceError(status, code, 'Legacy message repair refused; inspect fresh diagnostics and plan'); };
const ACTION = 'legacy_messages_repaired';

function validate(input, execute) {
  if (!input || Object.keys(input).some(key => !['rooms','reason','planHash','requestId'].includes(key))
    || !Array.isArray(input.rooms) || input.rooms.length < 1 || input.rooms.length > 3
    || input.rooms.some(room => !room || Object.keys(room).some(key => !['roomId','expectedHead'].includes(key))
      || typeof room.roomId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(room.roomId) || !Number.isSafeInteger(room.expectedHead) || room.expectedHead < 0)
    || new Set(input.rooms.map(room => room.roomId)).size !== input.rooms.length
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 280) fail('invalid_legacy_repair', 422);
  if (execute && (typeof input.planHash !== 'string' || typeof input.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(input.planHash) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId ?? ''))) fail('repair_plan_required', 422);
  return [...input.rooms].sort((a, b) => a.roomId.localeCompare(b.roomId));
}

function inventory(store, rooms) {
  const started = performance.now();
  const budget = () => { if (performance.now() - started >= 150) fail('repair_bound_exceeded'); };
  const diagnostic = operatorParityDiagnostics(store), changes = [], evidence = [], counts = [];
  for (const target of rooms) {
    budget();
    const detail = diagnostic.rooms.find(room => room.roomId === target.roomId);
    if (!detail || !detail.complete || !detail.exactLegacyShapeOnly) fail('repair_not_exact_legacy');
    if (detail.head !== target.expectedHead) fail('repair_head_changed');
    const projection = store.db.prepare('SELECT projection FROM rooms WHERE id=?').get(target.roomId).projection;
    const workSize = store.db.prepare('SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes FROM (SELECT length(CAST(body AS BLOB)) AS nbytes FROM work_entities WHERE room_id=? LIMIT 2001)').get(target.roomId);
    if (workSize.n > 2000 || workSize.bytes > 4 * 1024 * 1024) fail('repair_bound_exceeded');
    let hydrated;
    try { hydrated = hydrateProjection(store.db, target.roomId, JSON.parse(projection), { verifyBodyHashes: true }); }
    catch { fail('repair_projection_unavailable'); }
    if (hydrated.missing.length) fail('repair_not_exact_legacy');
    const messages = new Map(hydrated.state.messages.map(message => [message.id, message]));
    const rows = store.db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY message_id LIMIT 2001').all(target.roomId);
    if (rows.length > 2000) fail('repair_bound_exceeded');
    let records = 0, reactionsRemoved = 0, receiptIdsAdded = 0;
    for (const row of rows) {
      budget();
      const expected = messages.get(row.message_id);
      if (!expected || !messageRecordParityDetail(row, expected).keys.length) continue;
      const state = { messages: [JSON.parse(row.record_json)] };
      const updated = upgradeLegacyMessages(state, new Map([[row.message_id, expected.receiptId]]));
      const recordJson = JSON.stringify(state.messages[0]);
      // Full canonical record equality, not counters or a permissive field filter.
      if (messageRecordParityDetail({ ...row, record_json: recordJson }, expected).keys.length
        || (!updated.reactionsRemoved && !updated.receiptIdsAdded)) fail('repair_not_exact_legacy');
      changes.push({ roomId: target.roomId, messageId: row.message_id, recordJson, clearReactions: updated.reactionsRemoved > 0 });
      records++; reactionsRemoved += updated.reactionsRemoved; receiptIdsAdded += updated.receiptIdsAdded;
    }
    if (!records) fail('repair_not_exact_legacy');
    const failure = store.db.prepare("SELECT * FROM integrity_failures WHERE step='messages_parity' AND record_id=?").get(target.roomId);
    evidence.push({ target, projection, rows, failure });
    counts.push({ roomId: target.roomId, head: target.expectedHead, records, reactionsRemoved, receiptIdsAdded });
  }
  budget();
  return { changes, counts, planHash: hash(evidence) };
}

export function repairLegacyMessages(store, input, execute = false) {
  const rooms = validate(input, execute);
  const requestFingerprint = hash({ rooms, reason: input.reason, planHash: input.planHash ?? null });
  let wrote = false;
  try { return store.transaction(() => {
    if (execute) {
      const prior = store.db.prepare('SELECT counts_json FROM operator_actions WHERE action=? AND request_id=?').get(ACTION, input.requestId);
      if (prior) {
        const saved = JSON.parse(prior.counts_json);
        if (saved.requestFingerprint !== requestFingerprint) fail('idempotency_conflict');
        return { ...saved, duplicate: true };
      }
    }
    const plan = inventory(store, rooms);
    const result = { rooms: plan.counts, planHash: plan.planHash };
    if (!execute) {
      appendOperatorAction(store, { action: 'legacy_messages_repair_plan', targetKind: 'rooms', targetId: hash(rooms), reason: input.reason,
        planHash: plan.planHash, counts: result, result: 'planned' });
      return result;
    }
    if (input.planHash !== plan.planHash) fail('repair_plan_changed');
    const update = store.db.prepare('UPDATE messages SET record_json=?,reactions_json=CASE WHEN ? THEN NULL ELSE reactions_json END WHERE room_id=? AND message_id=?');
    wrote = true;
    for (const change of plan.changes) update.run(change.recordJson, change.clearReactions ? 1 : 0, change.roomId, change.messageId);
    for (const target of rooms) {
      try {
        const verified = store.checkMessagesParity({ roomId: target.roomId });
        if (!verified.ok || verified.checked !== 1) fail('repair_verification_failed');
      } catch { fail('repair_verification_failed'); }
      store.reportMessagesParity({ roomId: target.roomId, error: null });
    }
    const completed = { ...result, requestFingerprint, verified: rooms.length, duplicate: false };
    appendOperatorAction(store, { action: ACTION, targetKind: 'rooms', targetId: hash(rooms), reason: input.reason,
      planHash: plan.planHash, counts: completed, result: 'verified', requestId: input.requestId });
    return completed;
  }); } catch (error) {
    // A rolled-back canonical check must not resurrect an old certificate for
    // records already proven divergent. Keep content and failure records intact.
    if (wrote) store.transaction(() => {
      const invalidate = store.db.prepare('UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id=?');
      for (const target of rooms) invalidate.run(target.roomId);
    });
    throw error;
  }
}
