// R-04 (WAVE-3200 cohort 02): admission/invite paths required the TOTAL
// member census, so joining a current-format room with >100 total member
// records (but <=100 active) was refused with 409
// current_room_context_unavailable ("Room authority requires bounded
// membership") even though the room had free active seats.
//
// Fixture shape follows tests/current-identity-link.test.mjs: the room is
// built once from initialRoom() + member.added / member.access_changed
// events and initialized as normalized-current-v1, so total and active
// counts are exact. The standing auto-approve rule row is inserted
// directly (fixture arrangement): setAutoApprove's own admin gate is a
// separate surface (store.roomAuthority) and is not the path under test;
// the path under test is request() -> tryAutoApprove() admission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { AccessRequests, accessRequestSchema } from '../server/access-requests.mjs';
import { createRateLimiter } from '../server/identity-ratelimit.mjs';
import { currentInviteContext, currentRoomAuthority } from '../server/current-room-repository.mjs';

// total includes the owner. inactive members are member-1..member-<inactive>.
function bigRoom(t, { total = 120, inactive = 30 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'w3200-r04-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const events = initialRoom('commons');
  for (let i = 1; i < total; i++) {
    events.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
      data: { memberId: 'member-' + i, displayName: 'Member ' + i, kind: 'agent', permissions: [] } }));
  }
  for (let i = 1; i <= inactive; i++) {
    events.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.access_changed',
      data: { memberId: 'member-' + i, expectedMemberRevision: 0, active: false, permissions: [] } }));
  }
  store.initialize(events, { representation: 'normalized-current-v1' });
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const ownerToken = store.issueAccessKey('commons', 'owner');
  store.db.prepare('INSERT INTO room_access_auto_approve(room_id, permissions, updated_at, updated_by) VALUES(?,?,?,?)')
    .run('commons', JSON.stringify(['accept_work']), store.now(), 'owner');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const counts = () => {
    const head = JSON.parse(store.db.prepare("SELECT counts_json FROM current_room_head WHERE room_id='commons'").get().counts_json);
    const active = store.db.prepare("SELECT count(*) n FROM current_room_records WHERE room_id='commons' AND domain='members' AND COALESCE(json_extract(payload,'$.active'),1)<>0").get().n;
    return { total: head.members, active };
  };
  const memberRecord = id => {
    const row = store.db.prepare("SELECT payload FROM current_room_records WHERE room_id='commons' AND domain='members' AND record_key=?").get(id);
    return row ? JSON.parse(row.payload) : null;
  };
  return { store, requests, ownerToken, counts, memberRecord };
}

const newcomer = (store, name) => store.identities.create(name);
const ask = (requests, identity, displayName, requestId) => requests.request('commons', {
  identityId: identity.identityId, displayName, requestedPermissions: ['accept_work'], requestId,
}, identity.secret);

test('R-04 falsifier: auto-approve admits into a 120-total / 90-active current room', t => {
  const f = bigRoom(t);
  assert.deepEqual(f.counts(), { total: 120, active: 90 });
  const identity = newcomer(f.store, 'Newcomer One');
  const approved = ask(f.requests, identity, 'Newcomer One', 'ar_r04_main');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.memberId, identity.identityId);
  const record = f.memberRecord(identity.identityId);
  assert.ok(record && record.active !== false, 'new member record is present and active');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_links WHERE room_id=? AND identity_id=?')
    .get('commons', identity.identityId).n, 1);
  // Total count moves by exactly one (the new record); nothing else is
  // added, removed, or resurrected by the admission.
  assert.deepEqual(f.counts(), { total: 121, active: 91 });
  const gone = f.memberRecord('member-5');
  assert.ok(gone && gone.active === false && gone.revision === 1, 'deactivated record survives admission untouched');
});

test('adversarial (1) capacity race, serialised path: at 99 active the first admission takes seat 100 and the second pends', t => {
  // Admission runs inside store.transaction (request() body) on the
  // single-writer store, and the capacity check re-reads the active count
  // at the admission head immediately before member.added is applied, so
  // concurrent requests serialise exactly like these two sequential ones:
  // the second observes active=100 and cannot pass the cap.
  const f = bigRoom(t, { total: 120, inactive: 21 }); // 99 active
  assert.deepEqual(f.counts(), { total: 120, active: 99 });
  const first = newcomer(f.store, 'Race First');
  assert.equal(ask(f.requests, first, 'Race First', 'ar_r04_race1').status, 'approved');
  assert.deepEqual(f.counts(), { total: 121, active: 100 });
  const second = newcomer(f.store, 'Race Second');
  const pended = ask(f.requests, second, 'Race Second', 'ar_r04_race2');
  assert.equal(pended.status, 'pending');
  assert.match(pended.pendingNote, /pilot capacity/);
  assert.equal(f.memberRecord(second.identityId), null, 'no second seat was created past the cap');
  assert.deepEqual(f.counts(), { total: 121, active: 100 });
});

test('adversarial (2) name uniqueness: an ACTIVE member name is refused; a name held only by a DEACTIVATED record is not', t => {
  const f = bigRoom(t); // member-1..30 deactivated, member-31..119 active
  // Collision with an active member (member-40): refused at filing, the
  // same 422 display_name_unavailable the guard throws on main.
  const clash = newcomer(f.store, 'Clash Identity');
  assert.throws(() => ask(f.requests, clash, 'Member 40', 'ar_r04_clash'),
    e => e.status === 422 && e.code === 'display_name_unavailable');
  assert.equal(f.memberRecord(clash.identityId), null);
  // Collision only with a deactivated record (member-5): pre-cure
  // behaviour (small-room main) is that inactive names do not block, and
  // that must be preserved post-cure — the request files and auto-approves.
  const reuse = newcomer(f.store, 'Reuse Identity');
  const approved = ask(f.requests, reuse, 'Member 5', 'ar_r04_reuse');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.memberId, reuse.identityId);
  // The deactivated member-5 record itself is untouched by the name reuse.
  const gone = f.memberRecord('member-5');
  assert.ok(gone && gone.active === false && gone.revision === 1);
});

test('adversarial (3) deactivated member: reactivation is not double-counted and member.added cannot resurrect a second seat', t => {
  const f = bigRoom(t);
  const before = f.counts();
  // member.added reusing a deactivated member's id is refused by the
  // reducer ("Member already exists") instead of silently replacing the
  // record; the total count proves no duplicate seat appeared.
  assert.throws(() => f.store.command(f.ownerToken, 'commons', { id: randomUUID(), type: 'member.added',
    data: { memberId: 'member-5', displayName: 'Impostor Five', kind: 'agent', permissions: [] } }),
    e => /Member already exists/.test(e.message));
  assert.deepEqual(f.counts(), before);
  assert.equal(f.memberRecord('member-5').active, false);
  // Reactivation through member.access_changed flips the same record:
  // active +1, total unchanged (no double count).
  const member = f.memberRecord('member-5');
  f.store.command(f.ownerToken, 'commons', { id: randomUUID(), type: 'member.access_changed',
    data: { memberId: 'member-5', expectedMemberRevision: member.revision, active: true, permissions: [] } });
  assert.equal(f.memberRecord('member-5').active, true);
  assert.deepEqual(f.counts(), { total: before.total, active: before.active + 1 });
});

test('adversarial (4) exactly 100 active refuses the 101st with the same shape as on main', t => {
  // A 100-total / 100-active room behaves identically before and after the
  // cure (this scenario passes on unmodified main): the admission pends
  // with the pilot-capacity note, and a direct member.added command is
  // refused 409 pilot_limit.
  const f = bigRoom(t, { total: 100, inactive: 0 });
  assert.deepEqual(f.counts(), { total: 100, active: 100 });
  const identity = newcomer(f.store, 'One Too Many');
  const pended = ask(f.requests, identity, 'One Too Many', 'ar_r04_full');
  assert.equal(pended.status, 'pending');
  assert.match(pended.pendingNote, /pilot capacity/);
  assert.equal(f.memberRecord(identity.identityId), null);
  assert.throws(() => f.store.command(f.ownerToken, 'commons', { id: randomUUID(), type: 'member.added',
    data: { memberId: 'extra-member', displayName: 'Extra Member', kind: 'agent', permissions: [] } }),
    e => e.status === 409 && e.code === 'pilot_limit');
});

test('adversarial (5) helper contract: active-only authority, addressed adds, and the >100 ACTIVE refusal matches the census refusal byte-for-byte', async t => {
  const { currentActiveMemberAuthority } = await import('../server/current-room-repository.mjs');
  assert.equal(typeof currentActiveMemberAuthority, 'function', 'design helper currentActiveMemberAuthority exists');
  const f = bigRoom(t);
  const authority = currentActiveMemberAuthority(f.store.db, 'commons');
  assert.equal(authority.ownerId, 'owner');
  assert.equal(Object.keys(authority.members).length, 90);
  assert.ok(Object.values(authority.members).every(m => m.active !== false));
  assert.equal(authority.members['member-5'], undefined, 'deactivated records are not in the active authority');
  // census:'active' invite context carries the active roster, and an
  // explicitly named deactivated member is still loaded addressed.
  const context = currentInviteContext(f.store, 'commons', { memberIds: ['member-5'], census: 'active' });
  assert.equal(Object.keys(context.room.state.members).length, 91);
  assert.equal(context.room.state.members['member-5'].active, false);
  // >100 ACTIVE: the helper refuses with the identical status/code/message
  // the total census refuses with in the same room.
  const over = bigRoom(t, { total: 101, inactive: 0 });
  const shape = e => ({ status: e.status, code: e.code, message: e.message });
  let censusError, activeError;
  try { currentRoomAuthority(over.store.db, 'commons'); } catch (e) { censusError = e; }
  try { currentActiveMemberAuthority(over.store.db, 'commons'); } catch (e) { activeError = e; }
  assert.ok(censusError && activeError);
  assert.deepEqual(shape(activeError), shape(censusError));
  assert.deepEqual(shape(activeError), { status: 409, code: 'current_room_context_unavailable', message: 'Room authority requires bounded membership' });
});
