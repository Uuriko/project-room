import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, linkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { backupRoom } from '../server/backup.mjs';
import { createRecoveryFixture } from '../scripts/recovery-fixture.mjs';
import { compareRecoveryCaptures } from '../scripts/compare-recovery.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-capture-comparison-'));
  const f = createRecoveryFixture(join(directory, 'source.sqlite'));
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { identityId } = f.store.identities.create("Comparison agent");
  f.store.identities.link(f.keys.owner, "commons", { identityId, permissions: ["steer"] });
  const capture = async () => (await backupRoom(f.filename, directory)).filename;
  return { ...f, directory, older: await capture(), capture };
}
const post = (f, body = 'Synthetic later message') => f.store.command(f.keys.owner, 'commons', {
  id: randomUUID(), type: 'message.posted', data: { body }
});
const delta = (report, table) => report.tables.find(row => row.table === table);
const compare = (older, reference) => {
  const before = [older, reference].map(path => readFileSync(path));
  const result = compareRecoveryCaptures(older, reference);
  assert.deepEqual([older, reference].map(path => readFileSync(path)), before, 'capture bytes remain unchanged');
  assert.equal(result.reopenAllowed, false); assert.equal(result.authorityFreshness, 'unproven');
  return result;
};

test('equal independently captured data is not permission to reopen; all 118 tables are compared', async t => {
  const f = await fixture(t), reference = await f.capture(), report = compare(f.older, reference);
  assert.equal(report.status, 'no_stored_differences'); assert.equal(report.tables.length, 123,
    "a table was added or removed: confirm the comparison covers it, then update this count"); // +3: agent_api_keys, agent_directory_cards, agent_webhook_subs (RC-2026-09-18-010); +5: collab_assignments, collab_notes, collab_draft_locks, collab_approvals, collab_routing_events (RC-2026-09-18-011); +2: agent_identity_verification, room_verification_policy (RC-2026-09-18-049); +1: oauth_pending_states (RC-2026-09-19); +2: dm_consents, room_public_settings (consent-bound DMs + public face, 2026-09-20); +1: room_directory_settings (opt-in public room directory #605); +2: mention_states, room_mention_settings (#658 mention lifecycle); +1: membership_delegation_grants (membership delegation #761); +7: bounty_journal, bounty_records, bounty_disputes, bounty_events, bounty_idempotency, bounty_watchers, bounty_sequences (credits-only bounty exchange #762); +1: agent_key_registry (agent public-key registry, integration-map slice #9); +1: inbox_handoff_rooms (room scope for collab-route handoffs); +4: bounty_rubric_versions, bounty_flakes, bounty_review_packets, bounty_sybil_flags (bounty slices 6+8+10: pinned rubrics, anti-flake ladder, sybil detector #792); +2: guest_invites, guest_members (GX guest-invite public handoff RC-2026-09-23-100); +3: activity_events, read_horizons, saved_messages (attention: activity feed, read horizons, saved messages); +1: thread_mutes (shared: attention thread mutes + server/thread-mutes.mjs); +1: bounty_reputation_packets (slice #4: probation-gate review packets); +1: referrals (referral attribution); +2: web_fetch_cache, web_fetch_log (room-side web fetch RC-2026-09-23-102); +3: agent_bonds, peer_dm_threads, peer_dm_messages (agent Bond and peer DMs); +1: jev_shadow_decisions (Jev shadow-gate journal); +1: agent_autonomy_tiers (graduated agent autonomy tiers #928, replaces slice 1/3 agent_operator_controls); +1: agent_skill_cards (evidence-backed skill cards RC-2026-09-24-202); +1: agent_push_configs (push wake path RC-2026-09-24-203); +1: identity_link_codes (identity-holder link codes RC-2026-09-24-210); +1: inbox_attachment_bytes (identity-scoped staged inbox attachment bytes); +1: web_research_log (knowledge router RC-2026-09-24-310); +1: land_queue (pull-request land queue); +1: web_fetch_cache_rooms (room-scoped fetch visibility, RC-2026-09-24-310 follow-up); +3: referral_invite_keys, referral_invites, referral_chain_members (signed agent-carried referral invites #1025); +2: guest_selfserve, guest_selfserve_idem (self-serve guest entry RC-2026-09-25-912)

  assert.equal(report.history.equalRooms, 2); assert.equal(report.history.olderHistoryIsPrefix, true);
  assert.equal(report.accessDifferences, false);
  assert.ok(report.tables.every(row => row.added + row.removed + row.changed === 0));
  const serialized = JSON.stringify(report);
  for (const value of [f.keys.owner, f.enrollmentToken, f.pending.token, f.command.data.body,
    f.nativeBody, 'recovery-target', 'Managed recovery agent', 'commons', f.older, reference]) {
    assert.equal(serialized.includes(value), false, 'report omits private row values and paths');
  }
});

test('private thread mute changes are included in capture comparison', async t => {
  const f = await fixture(t);
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.posted',
    data: { messageId: 'comparison-muted-thread', body: 'Synthetic discussion' } });
  const before = await f.capture();
  f.store.threadMutes.set(f.keys.owner, 'commons', { threadId: 'comparison-muted-thread', muted: true });
  const report = compare(before, await f.capture());
  assert.equal(report.status, 'differences_require_review');
  assert.equal(delta(report, 'thread_mutes').added, 1);
  assert.equal(report.history.laterEvents, 0, 'private preferences add no public room events');
  assert.equal(JSON.stringify(report).includes('comparison-muted-thread'), false);
});

test('content and retry changes are visible without inventing an access change', async t => {
  const f = await fixture(t); post(f);
  const report = compare(f.older, await f.capture());
  assert.equal(report.status, 'differences_require_review'); assert.equal(report.accessDifferences, false);
  assert.equal(report.history.extendedRooms, 1); assert.equal(report.history.laterEvents, 1);
  assert.equal(delta(report, 'commands').added, 1); assert.equal(delta(report, 'events').added, 1);
  assert.equal(delta(report, 'rooms').changed, 1);
});

test('credential and invitation revocations are found even without a new room event', async t => {
  const f = await fixture(t);
  f.store.revoke(f.validSession.token);
  f.store.revokeInvitation(f.owner.token, f.invitation.invitation.id, {
    expectedRevision: 0, reason: 'Synthetic cancellation', expectedSessionBinding: f.owner.session.sessionBinding
  });
  const report = compare(f.older, await f.capture());
  assert.equal(report.accessDifferences, true); assert.equal(report.history.equalRooms, 2);
  assert.equal(delta(report, 'credentials').changed, 1);
  assert.equal(delta(report, 'membership_invitations').changed, 1);
  assert.equal(delta(report, 'membership_invitation_journal').added, 1);
});

test('account changes and human session retirement are flagged', async t => {
  const f = await fixture(t);
  const id = f.store.accountForMember('commons', 'owner').id;
  f.store.changeAccountAccess(id, { expectedRevision: 0, active: false, reason: 'Synthetic suspension' });
  const report = compare(f.older, await f.capture());
  assert.equal(report.accessDifferences, true);
  assert.equal(delta(report, 'accounts').changed, 1);
  assert.equal(delta(report, 'account_access_events').added, 1);
  assert.ok(delta(report, 'account_credentials').changed > 0);
  assert.ok(delta(report, 'account_session_slots').changed > 0);
  assert.ok(delta(report, 'private_reminders').changed > 0);
});

test('membership authority changes are detected inside room projections', async t => {
  const f = await fixture(t);
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'member.access_changed',
    data: { memberId: 'agent', expectedMemberRevision: 0, active: false, permissions: [] } });
  const report = compare(f.older, await f.capture());
  assert.equal(report.memberships.changed, 1); assert.equal(report.accessDifferences, true);
  assert.equal(report.history.extendedRooms, 1);
});

test('managed-agent disconnection and its exact operation receipt are both flagged', async t => {
  const f = await fixture(t);
  f.store.agentConnections.apply(f.owner.token, 'commons', { action: 'disconnect', requestId: 'comparison-disconnect',
    memberId: 'managed-agent', expectedOwnerRevision: 0, expectedGeneration: 1, expectedMemberRevision: 0
  }, f.owner.session.sessionBinding);
  const report = compare(f.older, await f.capture());
  assert.equal(report.accessDifferences, true); assert.equal(report.memberships.changed, 1);
  assert.equal(delta(report, 'agent_connections').changed, 1);
  assert.equal(delta(report, 'agent_connection_operations').added, 1);
});

test('passing time does not turn equal stored captures into current authority', async t => {
  const f = await fixture(t); f.advance(40 * 86400000);
  const report = compare(f.older, await f.capture());
  assert.equal(report.status, 'no_stored_differences');
  assert.equal(report.reopenAllowed, false);
  assert.ok(report.requiredReview.some(item => item.includes('expiry')));
});

test('reversed or forked history requires review rather than timestamp-based merging', async t => {
  const f = await fixture(t); post(f, 'First branch'); const reference = await f.capture();
  const reversed = compare(reference, f.older);
  assert.equal(reversed.status, 'history_requires_review'); assert.equal(reversed.history.divergentRooms, 1);
  const branch = new RoomStore(f.older, { now: f.now });
  try { branch.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.posted', data: { body: 'Separate branch' } }); }
  finally { branch.close(); }
  const forked = compare(f.older, reference);
  assert.equal(forked.status, 'history_requires_review'); assert.equal(forked.history.olderHistoryIsPrefix, false);
  assert.equal(forked.history.laterEvents, 0);
});

test('missing rooms, newly added rooms and absent membership records are explicit', async t => {
  const f = await fixture(t);
  const { initialRoom } = await import('../server/bootstrap.mjs');
  f.store.initialize(initialRoom('third', 'third-owner'));
  const reference = await f.capture();
  const forward = compare(f.older, reference);
  assert.equal(forward.history.addedRooms, 1); assert.ok(forward.memberships.added > 0);
  const backward = compare(reference, f.older);
  assert.equal(backward.history.missingRooms, 1); assert.ok(backward.memberships.removed > 0);
  assert.equal(backward.status, 'history_requires_review');
});

test('CLI has explicit inputs, stable exit codes and private error output', async t => {
  const f = await fixture(t), reference = await f.capture();
  const run = args => spawnSync(process.execPath, ['scripts/compare-recovery.mjs', ...args], { encoding: 'utf8' });
  const equal = run(['--older', f.older, '--reference', reference]);
  assert.equal(equal.status, 0, equal.stderr); assert.equal(JSON.parse(equal.stdout).reopenAllowed, false);
  post(f); const later = await f.capture();
  assert.equal(run(['--older', f.older, '--reference', later]).status, 2);
  const alias = join(f.directory, 'alias.sqlite'); linkSync(f.older, alias);
  const before = readdirSync(f.directory);
  for (const args of [[], ['--older', f.older], ['--older', f.older, '--reference', alias],
    ['--older', f.older, '--reference', join(f.directory, 'missing.sqlite')],
    ['--older', f.older, '--reference', reference, '--apply']]) {
    const failure = run(args); assert.equal(failure.status, 1); assert.equal(failure.stdout, '');
    assert.equal(failure.stderr.includes(f.directory), false);
  }
  assert.deepEqual(readdirSync(f.directory), before, 'missing input does not create a database');
});

test('unsupported capture schema is rejected without migration in either input position', async t => {
  const f = await fixture(t), reference = await f.capture();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(reference);
  db.exec('PRAGMA user_version=7'); db.close();
  const before = [f.older, reference].map(path => readFileSync(path));
  assert.throws(() => compareRecoveryCaptures(f.older, reference), /schema/);
  assert.throws(() => compareRecoveryCaptures(reference, f.older), /schema/);
  assert.deepEqual([f.older, reference].map(path => readFileSync(path)), before);
});
