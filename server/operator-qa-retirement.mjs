// Explicitly authorized QA-room retirement. No room data or global identity is deleted.
import { createHash } from 'node:crypto';
import { ServiceError } from './service-error.mjs';
import { appendOperatorAction } from './operator-actions.mjs';
const ROOM = 'qa-onb-10302113';
const fail = (status, code) => { throw new ServiceError(status, code, 'QA retirement refused; inspect the plan and retry'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function inventory(store) {
  const db = store.db, room = store.room(ROOM), groups = [];
  const add = (name, table, where, params, update, values = []) => {
    if (!exists(db, table)) return;
    const rows = db.prepare(`SELECT rowid AS retirement_rowid,* FROM ${table} WHERE ${where} ORDER BY rowid`).all(...params);
    groups.push({ name, table, rows, update, values });
  };
  const at = store.now(), owner = room.state.room.ownerId;
  add('legacyCredentials', 'credentials', 'room_id=? AND revoked=0', [ROOM], 'revoked=1');
  const keys = exists(db, 'agent_api_keys') ? db.prepare('SELECT key_id,identity_id,scopes_json FROM agent_api_keys WHERE revoked=0 ORDER BY key_id').all() : [];
  let preservedBroadKeys = 0;
  const scopedKeys = keys.filter(key => {
    const scopes = JSON.parse(key.scopes_json), rooms = scopes.filter(scope => scope.startsWith('mcp:room:'));
    if (rooms.length === 1 && rooms[0] === `mcp:room:${ROOM}`) return true;
    if (rooms.includes(`mcp:room:${ROOM}`) || rooms.length === 0) preservedBroadKeys++;
    return false;
  });
  for (const prefix of ['oauth_provider', 'oauth_invite']) {
    add(`${prefix}Codes`, `${prefix}_codes`, "json_extract(binding_json,'$.roomId')=? AND used=0", [ROOM], 'used=1');
    for (const type of ['access', 'refresh']) add(`${prefix}${type}`, `${prefix}_${type}_tokens`, "json_extract(binding_json,'$.roomId')=? AND revoked=0", [ROOM], 'revoked=1');
  }
  add('nativeGrants', 'oauth_invite_grants', 'room_id=? AND revoked_at IS NULL', [ROOM], 'revoked_at=?', [at]);
  if (exists(db, 'oauth_invite_grants')) add('nativePending', 'oauth_invite_pending', 'grant_id IN (SELECT id FROM oauth_invite_grants WHERE room_id=?) AND expires_at>?', [ROOM, at], 'expires_at=?', [at]);
  add('agentInvitations', 'agent_invite_codes', 'room_id=? AND revoked_at IS NULL', [ROOM], 'revoked_at=?', [at]);
  add('shareLinks', 'share_links', 'room_id=? AND revoked_at IS NULL', [ROOM], 'revoked_at=?,revoked_by_member_id=?', [at, owner]);
  add('guestInvitations', 'guest_invites', "room_id=? AND status='active'", [ROOM], "status='revoked',revoked_at=?,revoked_by_member_id=?", [at, owner]);
  add('membershipInvitations', 'membership_invitations', "room_id=? AND status='pending'", [ROOM], "status='revoked',revision=revision+1,revoked_at=?,revoked_by_member_id=?,revoke_reason='Operator QA retirement'", [at, owner]);
  add('pairings', 'pairs', "room_id=? AND status IN ('pending','approved')", [ROOM], "status='denied'");
  add('connections', 'agent_connections', "room_id=? AND status='issued'", [ROOM], "status='disconnected',updated_at=?", [at]);
  add('nativeSubscriptions', 'mcp_event_subscriptions', "json_extract(principal,'$.roomId')=? AND state!='inactive'", [ROOM], "state='inactive',generation=?,document='{}'", [`retired-${at}`]);
  if (exists(db, 'mcp_event_subscriptions')) add('nativeOutbox', 'mcp_event_outbox', "subscription_id IN (SELECT id FROM mcp_event_subscriptions WHERE json_extract(principal,'$.roomId')=?) AND state IN ('pending','leased')", [ROOM], "state='dead',lease=NULL,lease_until=NULL");
  const counts = Object.fromEntries(groups.map(group => [group.name, group.rows.length]));
  counts.roomScopedApiKeys = scopedKeys.length;
  return { room, groups, scopedKeys, counts, preservedBroadKeys,
    planHash: digest([room.sequence, Boolean(room.state.room.archivedAt), groups.map(g => [g.name, g.rows]), scopedKeys]) };
}

export function retireQaRoom(store, input, execute = false) {
  if (!input || input.roomId !== ROOM || Object.keys(input).some(key => !['roomId','reason','requestId','planHash'].includes(key))) fail(422, 'invalid_retirement');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 280) fail(422, 'reason_required');
  if (execute && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,57}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.planHash ?? ''))) fail(422, 'plan_required');
  const run = () => store.transaction(() => {
    if (execute) {
      const prior = store.db.prepare("SELECT counts_json,plan_hash,reason FROM operator_actions WHERE action='qa_room_retired' AND target_id=? AND request_id=?").get(ROOM, input.requestId);
      if (prior) {
        if (prior.plan_hash !== input.planHash || prior.reason !== input.reason) fail(409, 'idempotency_conflict');
        return { ...JSON.parse(prior.counts_json), duplicate: true };
      }
    }
    const plan = inventory(store);
    const publicPlan = { roomId: ROOM, head: plan.room.sequence, planHash: plan.planHash, counts: plan.counts,
      preservedBroadKeys: plan.preservedBroadKeys, globalIdentitiesPreserved: true, archived: Boolean(plan.room.state.room.archivedAt) };
    if (!execute) {
      appendOperatorAction(store, { action: 'qa_room_retirement_plan', targetKind: 'room', targetId: ROOM, reason: input.reason, planHash: plan.planHash, counts: plan.counts, result: 'planned' });
      return publicPlan;
    }
    if (input.planHash !== plan.planHash) fail(409, 'plan_changed');
    for (const key of plan.scopedKeys) store.agentPlugin.revokeApiKey({ identityId: key.identity_id, keyId: key.key_id });
    for (const group of plan.groups) {
      const statement = store.db.prepare(`UPDATE ${group.table} SET ${group.update} WHERE rowid=?`);
      for (const row of group.rows) statement.run(...group.values, row.retirement_rowid);
    }
    if (!plan.room.state.room.archivedAt) store.archiveQaRoomAsOperator(ROOM, `retire-${input.requestId}`, input.reason);
    const result = { ...publicPlan, archived: true, duplicate: false };
    appendOperatorAction(store, { action: 'qa_room_retired', targetKind: 'room', targetId: ROOM, reason: input.reason, planHash: plan.planHash, counts: result, result: 'retired', requestId: input.requestId });
    return result;
  });
  // The outer cache snapshot must cover archive/audit failure as well as SQL rollback.
  return execute ? store.agentPlugin.mutate(run) : run();
}
