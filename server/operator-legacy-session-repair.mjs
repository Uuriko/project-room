// Explicit existing-operator mode. Source, serving truth and derived artifacts
// are one admitted unit; never an ordinary replay or command fallback.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyEvent, emptyRoomState, messageChannelId } from '../src/events.js';
import { ensureWorkControlDefaults } from '../src/work-item-session.js';
import { HISTORICAL_REPAIR_KIND, HISTORICAL_REPAIR_ACTION, HISTORICAL_PROOF_MODE, validateHistoricalRepairInput, historicalRepairFingerprint, historicalRepairReceiptId, appendHistoricalReplayLookup, HISTORICAL_REPLAY_CONTRACT_VERSION, HISTORICAL_REPLAY_KIND, PRE749_ADAPTER_VERSION, pre749PrefixDigest, decodeHistoricalEventRows } from './historical-replay-contract.mjs';
import { replayPre749Sessions } from './legacy-session-replay.mjs';
import { ServiceError } from './service-error.mjs';
import { appendOperatorAction } from './operator-actions.mjs';
import { hydrateProjection } from './projection-at-rest.mjs';
import { projectionDigest, servingProofDrift, messageProofMatches, messageProofHash, assertMessageWrite, MESSAGE_PROOF_SELECT, MESSAGE_PROOF_FIELDS } from './write-integrity.mjs';
import { legacyContentHashDrift } from './legacy-content-hash.mjs';
import { messageRowParityFields, affectedMessageIds, reconcileLegacySessionBackfill, messageRowForWrite } from './messages-store.mjs';
const PROOF_MODE = HISTORICAL_PROOF_MODE;
const KIND = HISTORICAL_REPAIR_KIND, ACTION = HISTORICAL_REPAIR_ACTION, LIMIT = 64, BYTES = 256 * 1024;
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const fail = (code, status = 409) => {
  throw new ServiceError(status, code, 'Historical session repair refused; inspect fresh plan and independent serving proofs');
};
// Only fixed, code-owned operator diagnostics; no persisted values or errors.
const projectionUnavailable = repairCheck => {
  const error = new ServiceError(409, 'repair_projection_unavailable', 'Historical session repair refused; inspect fresh plan and independent serving proofs');
  error.detail = { repairCheck };
  throw error;
};
const parse = text => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) fail('repair_not_exact_legacy');
    throw error;
  }
};
const compact = state => ({ ...state, eventLog: [], seenEvents: { }, seenIdempotencyKeys: { } });
const object = text => {
  const value = parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('repair_not_exact_legacy');
  return value;
};
// Existing reader defaults are permitted only as additions to a clone.
// Any replacement/removal of an independently protected value refuses.
function currentReadView(state) {
  const view = structuredClone(state);
  ensureWorkControlDefaults(view);
  for (const message of view.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) fail('repair_not_exact_legacy');
    if (!Object.hasOwn(message, 'channelId')) message.channelId = messageChannelId(message);
  }
  const pending = [[state, view]];
  while (pending.length) {
    const [before, after] = pending.pop();
    if (before && typeof before === 'object') {
      if (!after || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)
        || (Array.isArray(before) && before.length !== after.length)) fail('repair_not_exact_legacy');
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) fail('repair_not_exact_legacy');
        pending.push([before[key], after[key]]);
      }
    } else if (!isDeepStrictEqual(before, after)) fail('repair_not_exact_legacy');
  }
  return view;
}
function completeRowMatches(db, row, message, context) {
  if (!message) return false;
  const expected = messageRowForWrite(message, context);
  return MESSAGE_PROOF_FIELDS.every(field => ['record_json', 'reducer_extras_json'].includes(field)
    ? isDeepStrictEqual(parse(row[field]), parse(expected[field]))
      && (row[field] === null || !db.prepare('SELECT 1 FROM json_tree(?) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1 LIMIT 1').get(row[field]))
    : row[field] === expected[field]);
}
const schema = {
  rooms: ['id', 'sequence', 'projection', 'archived_at'],
  events: ['room_id', 'sequence', 'id', 'body'],
  messages: ['room_id', ...MESSAGE_PROOF_SELECT.split(','), 'entity_hash'],
  work_entities: ['room_id', 'work_id', 'revision', 'digest', 'body'],
  projection_bodies: ['room_id', 'sha', 'body'],
  integrity_room_state: ['room_id', 'sequence', 'projection_bytes', 'projection_hash', 'metadata_hash'],
  messages_backfill_cursor: ['room_id', 'applied_seq', 'applied_event_id', 'state_seq', 'replay_event_id', 'parity_at_seq', 'sweep_after'],
  messages_backfill_blocks: ['room_id', 'sequence', 'event_id', 'error', 'head_seq', 'blocked_at', 'last_diagnosed_at', 'reason', 'component', 'attempts', 'skipped', 'anchor_seq'],
  message_replay_snapshots: ['room_id', 'state_json'],
  messages_backfill_state: ['room_id', 'part', 'json']
};

function inventory(store, input, target) {
  const db = store.db, roomId = target.roomId, anchor = roomId + '\0anchor', domains = { }, where = { };
  const adopt = input.messageProofMode === PROOF_MODE;
  let bytes = 1024;
  // Reserve the complete bounded request/control envelope in both phases.
  for (const [table, columns] of Object.entries(schema)) {
    const clause = table === 'rooms' ? 'id=?' : table === 'messages_backfill_state' ? 'room_id IN (?,?)' : 'room_id=?', args = table === 'messages_backfill_state' ? [roomId, anchor] : [roomId];
    where[table] = { clause, args };
    const size = db.prepare(`SELECT count(*) AS n,COALESCE(sum(bytes),0) AS bytes FROM (SELECT ${columns.map(c => `COALESCE(length(CAST(${c} AS BLOB)),0)`).join('+')} AS bytes FROM ${table} WHERE ${clause} LIMIT 65)`).get(...args);
    if (size.n > LIMIT 
      || (size.n > 1 && ['rooms', 'integrity_room_state', 'messages_backfill_cursor', 'messages_backfill_blocks', 'message_replay_snapshots'].includes(table))) fail('repair_bound_exceeded');
    bytes += size.bytes + size.n * columns.reduce((n, column) => n + Buffer.byteLength(column) + 32, 0);
    if (bytes > BYTES) fail('repair_bound_exceeded');
    domains[table] = size;
  }
  // All integer-affinity controls are admitted in SQL, before any payload or
  // raw scalar transfer. Non-STRICT SQLite can otherwise return MiB TEXT.
  const integer = (table, column, min, max, nullable = false) => {
    const { clause, args } = where[table];
    const invalid = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE (${clause}) AND NOT (${nullable ? `${column} IS NULL OR ` : ''}typeof(${column})='integer' AND ${column} BETWEEN ? AND ?)`).get(...args, min, max);
    if (invalid.n) fail('repair_bound_exceeded');
  };
  for (const [table, cols] of Object.entries({
    rooms: ['sequence'],
    events: ['sequence'],
    messages: ['seq'],
    integrity_room_state: ['sequence'],
    messages_backfill_cursor: ['applied_seq', 'state_seq'],
    messages_backfill_blocks: ['sequence', 'head_seq']
  })) for (const col of cols) integer(table, col, 0, LIMIT);
  integer('messages', 'pinned', 0, 1);
  integer('work_entities', 'revision', 0, Number.MAX_SAFE_INTEGER);
  integer('integrity_room_state', 'projection_bytes', 0, BYTES);
  integer('messages_backfill_cursor', 'parity_at_seq', 0, LIMIT, true);
  integer('messages_backfill_state', 'part', -2, LIMIT);
  for (const column of ['blocked_at', 'last_diagnosed_at', 'attempts']) integer('messages_backfill_blocks', column, 0, Number.MAX_SAFE_INTEGER);
  integer('messages_backfill_blocks', 'skipped', 0, 1);
  integer('messages_backfill_blocks', 'anchor_seq', -1, LIMIT);
  const numeric = {
    rooms: ['sequence'],
    events: ['sequence'],
    messages: ['seq', 'pinned'],
    work_entities: ['revision'],
    integrity_room_state: ['sequence', 'projection_bytes'],
    messages_backfill_cursor: ['applied_seq', 'state_seq', 'parity_at_seq'],
    messages_backfill_blocks: ['sequence', 'head_seq', 'blocked_at', 'last_diagnosed_at', 'attempts', 'skipped', 'anchor_seq'],
    messages_backfill_state: ['part']
  };
  for (const [table, columns] of Object.entries(schema)) for (const column of columns) {
    if ((numeric[table] ?? []).includes(column)) continue;
    const { clause, args } = where[table];
    if (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE (${clause}) AND typeof(${column}) NOT IN ('text','null')`).get(...args).n) fail('repair_bound_exceeded');
  }
  for (const [table, columns] of Object.entries({
    events: ['id'],
    integrity_room_state: ['projection_hash', 'metadata_hash'],
    messages_backfill_cursor: ['applied_event_id', 'replay_event_id', 'sweep_after'],
    messages_backfill_blocks: ['event_id', 'error', 'reason', 'component']
  })) for (const column of columns) {
    const { clause, args } = where[table];
    if (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE (${clause}) AND length(CAST(${column} AS BLOB))>256`).get(...args).n) fail('repair_bound_exceeded');
  }
  const data = { };
  for (const [table, columns] of Object.entries(schema)) {
    const { clause, args } = where[table];
    const order = table === 'events' ? 'sequence' : table === 'messages_backfill_state' ? 'room_id,part' : columns[0] === 'room_id'
    && columns.length > 1 ? columns[1] : columns[0];
    const selected = columns.map(column => table === 'events' && ['id', 'body'].includes(column) ? `CAST(${column} AS BLOB) AS ${column}` : column);
    data[table] = db.prepare(`SELECT ${selected.join(',')} FROM ${table} WHERE ${clause} ORDER BY ${order}`).all(...args);
  }
  const room = data.rooms[0], proof = data.integrity_room_state[0], block = data.messages_backfill_blocks[0], cursor = data.messages_backfill_cursor[0];
  if (!room || room.sequence !== target.expectedHead) fail('repair_head_changed');
  if (room.archived_at !== null) fail('repair_not_exact_legacy');
  const raw = object(room.projection);
  if (raw.room?.id !== roomId || !Array.isArray(raw.messages) || !raw.workItems
  || typeof raw.workItems !== 'object' || Array.isArray(raw.workItems)) fail('repair_not_exact_legacy');
  if (raw.messages.length > LIMIT || Object.keys(raw.workItems).length > LIMIT) fail('repair_bound_exceeded');
  if (Object.hasOwn(raw, 'messagesArchive') || Object.hasOwn(raw, 'messageAuthority')) fail('repair_not_exact_legacy');
  if (!proof?.metadata_hash) projectionUnavailable('metadata_proof_missing');
  if (!proof.projection_hash) projectionUnavailable('content_proof_missing');
  if (proof.sequence !== room.sequence) projectionUnavailable('proof_head_mismatch');
  if (proof.metadata_hash !== projectionDigest(room.projection)) projectionUnavailable('metadata_hash_mismatch');
  // Definition-aware content comparison (P1 B5): the stored baseline is
  // untagged and may have been computed under the v2 definition, so it
  // is judged under its own definition — accepted iff it matches the
  // live projection under v2 or v3. A direct comparison against the
  // current v3 composition alone would report content_hash_mismatch on
  // every clean untransitioned v2 room; a stored hash that matches
  // neither definition (garbage, or genuine drift) still mismatches.
  if (legacyContentHashDrift(db, roomId, room.sequence, room.projection, proof.projection_hash)) projectionUnavailable('content_hash_mismatch');
  if (servingProofDrift(db, roomId, room.projection)) projectionUnavailable('serving_proof_drift');
  const missingProofs = [];
  for (const row of data.messages) if (!messageProofMatches(row)) {
    if (row.entity_hash !== null) projectionUnavailable('message_proof_mismatch');
    if (!adopt) projectionUnavailable('message_proof_missing');
    missingProofs.push(row);
  }
  if (adopt && raw.messages.some(message => !message || typeof message !== 'object'
    || Array.isArray(message) || Object.hasOwn(message, '_entity'))) projectionUnavailable('message_reference_invalid');
  for (const row of data.projection_bodies) if (typeof row.body !== 'string'
  || hash(row.body) !== row.sha) projectionUnavailable('projection_body_proof_mismatch');
  const messageRows = new Map(data.messages.map(row => [row.message_id, row]));
  for (const ref of raw.messages) if (ref?._entity === 1 && (typeof ref.id !== 'string'
  || !messageRows.has(ref.id) || Object.keys(ref).some(key => key !== 'id'
  && key !== '_entity'))) projectionUnavailable('message_reference_invalid');
  for (const row of data.messages) {
    object(row.record_json);
    if (row.reducer_extras_json !== null) object(row.reducer_extras_json);
    if (row.reactions_json !== null) object(row.reactions_json);
  }
  // Strict complete work membership: referenced bodies are independently
  // anchored by the metadata proof; stale or missing side rows never heal.
  const references = Object.entries(raw.workItems ?? { }).filter(([, x]) => x?._workEntity === 1);
  if (references.length !== data.work_entities.length) projectionUnavailable('work_membership_mismatch');
  for (const [id, ref] of references) {
    const row = data.work_entities.find(x => x.work_id === id);
    if (!row || ref.id !== id || row.digest !== ref.digest || row.revision !== ref.revision
    || hash(row.body) !== row.digest) projectionUnavailable('work_reference_proof_mismatch');
    const value = object(row.body);
    if (value.id !== id || value.revision !== ref.revision) projectionUnavailable('work_body_identity_mismatch');
  }
  const hydrated = hydrateProjection(db, roomId, raw, { verifyBodyHashes: true });
  if (hydrated.missing.length) projectionUnavailable('hydration_body_missing');
  // Raw event bytes and decoded strings coexist within this bounded input
  // unit; BYTES is an admitted input budget, not a total heap ceiling.
  let events, prefixSha256;
  try {
    prefixSha256 = pre749PrefixDigest(roomId, data.events);
    events = decodeHistoricalEventRows(data.events);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    fail('repair_not_exact_legacy');
  }
  data.events = events;
  if (events.length !== room.sequence || events.some((r, i) => r.sequence !== i + 1)) fail('repair_not_exact_legacy');
  if (!cursor || cursor.applied_seq > room.sequence || cursor.state_seq > room.sequence
  || cursor.applied_event_id !== (cursor.applied_seq === 0 ? '' : events[cursor.applied_seq - 1]?.id)
  || cursor.replay_event_id !== (cursor.state_seq === 0 ? '' : events[cursor.state_seq - 1]?.id)
  || (cursor.parity_at_seq !== null && cursor.parity_at_seq !== cursor.applied_seq)) fail('repair_not_exact_legacy');
  const incoming = events.map(row => {
    const e = object(row.body);
    if (e.id !== row.id || e.roomId !== roomId) fail('repair_not_exact_legacy');
    return e;
  });
  let modern = emptyRoomState(), first = null;
  for (const [index, e] of incoming.entries()) {
    try {
      modern = applyEvent(modern, e);
    } catch (error) {
      if (error.constructor !== Error || error.code) throw error;
      first = { index, error };
      break;
    }
  }
  if (!first || incoming[first.index].type !== 'work.accepted' || first.error.message !== 'Invalid transition from working'
  || !block || block.sequence !== first.index + 1 || block.event_id !== events[first.index].id
  || block.error !== first.error.message || block.reason !== 'reducer_rejected'
  || block.component !== 'board' || block.skipped !== 1 || !cursor) fail('repair_not_exact_legacy');
  let legacy;
  try {
    legacy = replayPre749Sessions(incoming);
  } catch (error) {
    if (error.constructor !== Error || error.code) throw error;
    fail('repair_not_exact_legacy');
  }
  const expected = adopt ? currentReadView(compact(hydrated.state)) : compact(hydrated.state);
  if (!isDeepStrictEqual(legacy, expected)) fail('repair_not_exact_legacy');
  const messageIndex = new Map(legacy.messages.map(m => [m.id, m])), positions = new Map(), pins = new Set((legacy.pins ?? []).map(p => p.messageId));
  for (const row of events) {
    const e = incoming[row.sequence - 1];
    if (e.type === 'message.posted') for (const id of affectedMessageIds(e)) if (!positions.has(id)) positions.set(id, row.sequence);
  }
  if (messageIndex.size !== data.messages.length || (adopt && messageIndex.size !== legacy.messages.length)) fail('repair_not_exact_legacy');
  if (adopt) for (const row of data.messages) if (!completeRowMatches(db, row, messageIndex.get(row.message_id), {
    sequence: positions.get(row.message_id), pinned: pins.has(row.message_id), threadMessages: messageIndex
  })) fail('repair_not_exact_legacy');
  for (const row of data.messages) if (messageRowParityFields(row, messageIndex.get(row.message_id), {
    sequence: positions.get(row.message_id),
    pinned: pins.has(row.message_id),
    threadMessages: messageIndex
  }).length) fail('repair_not_exact_legacy');
  // Validate bounded staging formats rather than accepting an opaque corrupt
  // control blob. Neither staging nor its anchor is repair authority.
  for (const row of data.messages_backfill_state) if (typeof row.json !== 'string') fail('repair_not_exact_legacy');
  const snapshot = data.message_replay_snapshots[0];
  if (!snapshot || typeof snapshot.state_json !== 'string') fail('repair_not_exact_legacy');
  const stateParts = data.messages_backfill_state.filter(x => x.room_id === roomId);
  const decode = (text, parts) => {
    if (!text.startsWith('parts:')) {
      if (parts.length) fail('repair_not_exact_legacy');
      return parse(text);
    }
    const m = /^parts:([0-9]{1,2}):([a-f0-9]{64})$/.exec(text);
    if (!m || parts.length !== Number(m[1]) || parts.some((p, i) => p.part !== i)) fail('repair_not_exact_legacy');
    const joined = parts.map(p => p.json).join('');
    if (hash(joined) !== m[2]) fail('repair_not_exact_legacy');
    return parse(joined);
  };
  decode(snapshot.state_json, stateParts);
  const detached = data.messages_backfill_state.filter(x => x.room_id === anchor), header = detached.find(x => x.part === -1), parts = detached.filter(x => x.part >= 0);
  if (!header || !/^\d{1,2}$/.test(header.json) || parts.length !== Number(header.json)
  || parts.some((p, i) => p.part !== i) || block.anchor_seq < 0 || block.anchor_seq >= block.sequence) fail('repair_not_exact_legacy');
  parse(parts.map(p => p.json).join(''));
  const skipped = detached.find(x => x.part === -2);
  if (skipped) {
    const ids = parse(skipped.json);
    if (!Array.isArray(ids) || ids.length > LIMIT || ids.some(id => typeof id !== 'string'
    || Buffer.byteLength(id) > 256)) fail('repair_not_exact_legacy');
  }
  const json = JSON.stringify(legacy);
  const outputBytes = Buffer.byteLength(json) + missingProofs.length * 64;
  if (bytes + outputBytes + 4096 > BYTES) fail('repair_bound_exceeded');
  const sourceHash = createHash('sha256').update(KIND).update(JSON.stringify(target));
  if (adopt) sourceHash.update('\0' + PROOF_MODE);
  for (const [table, columns] of Object.entries(schema)) {
    sourceHash.update(table);
    for (const row of data[table])
      for (const column of columns) {
      const value = row[column], text = value === null ? '' : String(value);
      sourceHash.update(column + '\0' + typeof value + '\0' + Buffer.byteLength(text) + ':').update(text);
    }
  }
  return {
    json,
    head: room.sequence,
    eventId: events.at(-1).id,
    events: events.length,
    bytes,
    planHash: sourceHash.digest('hex'),
    snapshotHash: hash(json),
    priorCursorHash: hash(cursor),
    outputBytes,
    missingProofs: missingProofs.map(row => ({ messageId: row.message_id, hash: messageProofHash(row) })),
    replayContract: {
      version: HISTORICAL_REPLAY_CONTRACT_VERSION, kind: HISTORICAL_REPLAY_KIND, adapterVersion: PRE749_ADAPTER_VERSION,
      roomId, throughSequence: room.sequence, headEventId: events.at(-1).id,
      prefixSha256, snapshotHash: hash(json)
    }
  };
}
export function repairLegacySessionBackfill(store, input, execute = false) {
  const target = validateHistoricalRepairInput(input, execute);
  if (store.readOnly) fail('read_only');
  const fingerprint = historicalRepairFingerprint(input,target), receiptId = execute ? historicalRepairReceiptId(target.roomId,input.requestId) : null;
  return store.transaction(() => {
    if (execute) {
      const old = store.db.prepare("SELECT CASE WHEN typeof(counts_json)='text' AND length(CAST(counts_json AS BLOB))<=4096 THEN counts_json ELSE NULL END AS json FROM operator_actions WHERE id=? AND action=?").get(receiptId, ACTION);
      if (old) {
        if (old.json === null) fail('repair_bound_exceeded');
        const saved = parse(old.json);
        if (saved.requestFingerprint !== fingerprint) fail('idempotency_conflict');
        return { ...saved, duplicate: true };
      }
    }
    const plan = inventory(store, input, target), result = {
      repairKind: KIND,
      derivedOnly: input.messageProofMode !== PROOF_MODE,
      ...(input.messageProofMode === PROOF_MODE ? { messageProofMode: PROOF_MODE,
        messageProofsToAdopt: plan.missingProofs.length, servingContentChanged: false } : {}),
      rooms: [{ roomId: target.roomId, head: plan.head, events: plan.events }],
      planHash: plan.planHash,
      snapshotHash: plan.snapshotHash,
      priorCursorHash: plan.priorCursorHash,
      admission: {
        inputBytes: plan.bytes,
        outputBytes: plan.outputBytes,
        receiptReserveBytes: 4096,
        limitBytes: BYTES
      }
    };
    if (!execute) {
      appendOperatorAction(store, {
        action: 'legacy_session_backfill_plan',
        targetKind: 'room',
        targetId: target.roomId,
        reason: input.reason,
        planHash: plan.planHash,
        counts: result,
        result: 'planned'
      });
      return result;
    }
    if (input.planHash !== plan.planHash) fail('repair_plan_changed');
    for (const row of plan.missingProofs) {
      const changed = store.db.prepare('UPDATE messages SET entity_hash=? WHERE room_id=? AND message_id=? AND entity_hash IS NULL').run(row.hash, target.roomId, row.messageId);
      if (changed.changes !== 1) projectionUnavailable('message_proof_mismatch');
      assertMessageWrite(store.db, target.roomId, row.messageId);
    }
    const parity = reconcileLegacySessionBackfill(store, { roomId: target.roomId, sequence: plan.head, eventId: plan.eventId, json: plan.json });
    if (!parity.ok || parity.checked !== 1) fail('repair_verification_failed');
    const completed = { ...result, requestFingerprint: fingerprint, verified: 1, duplicate: false,
      ...(input.messageProofMode === PROOF_MODE ? { messageProofsAdopted: plan.missingProofs.length } : {}),
      replayContract: plan.replayContract };
    store.db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,reason,plan_hash,counts_json,result,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      receiptId, store.now(), ACTION, 'room', target.roomId, input.reason,
      plan.planHash, JSON.stringify(completed), 'verified', input.requestId
    );
    try { appendHistoricalReplayLookup(store.db,target.roomId,plan.head,receiptId,plan.replayContract,store.now()); }
    catch (error) { if (error instanceof ServiceError && error.code === 'projection_corrupt') fail('repair_not_exact_legacy'); throw error; }
    return completed;
  });
}
