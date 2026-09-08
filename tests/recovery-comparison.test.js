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

test('equal independently captured data is not permission to reopen; all 20 tables are compared', async t => {
  const f = await fixture(t), reference = await f.capture(), report = compare(f.older, reference);
  assert.equal(report.status, 'no_stored_differences'); assert.equal(report.tables.length, 20);
  assert.equal(report.history.equalRooms, 2); assert.equal(report.history.olderHistoryIsPrefix, true);
  assert.equal(report.accessDifferences, false);
  assert.ok(report.tables.every(row => row.added + row.removed + row.changed === 0));
  const serialized = JSON.stringify(report);
  for (const value of [f.keys.owner, f.enrollmentToken, f.pending.token, f.command.data.body,
    f.nativeBody, 'recovery-target', 'Managed recovery agent', 'commons', f.older, reference]) {
    assert.equal(serialized.includes(value), false, 'report omits private row values and paths');
  }
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
