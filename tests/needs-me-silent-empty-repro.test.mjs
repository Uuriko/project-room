// READY-TO-RUN repro for the round-2 "needs-me silent empty" defect.
// Lane 05, FUNNEL-FIXES, pin 8c9deff7534ed549df88b730c03af2d9d3a11db8.
// Status: NOT-RUN in this lane (platform EPERM blocked all 3 checkout
// attempts; see PACK.md §6). Drop into tests/ of a clean checkout at the
// pin and run: node --test tests/needs-me-silent-empty-repro.test.mjs
//
// Fixture mirrors tests/normalized-needs-me.test.mjs (same store/room
// idiom) and reproduces the Sam fixture's load-bearing shape:
//   - 'aaa-decoy': addressed to the viewer in a role index (verifier),
//     but its next step belongs to ANOTHER member, so the needs-me work
//     filter drops it. It sorts BEFORE 'starter' in record_key order.
//   - 'starter': proposed, accountable = viewer, next step "accept"
//     with needsAttention:true (in production Sam's starter was
//     accepted/"start"; the state is not load-bearing — the ordering
//     plus the filter-after-paginate limit of 1 is).
// On the pin, the FIRST collectNeedsMe call examines only 'aaa-decoy'
// (limit:1, ascending record_key), filters it out, and returns
// items:[] with hasMore:true — starter appears only on a chained
// second call. The cure (PACK.md §5a) makes the first call contain it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { collectNeedsMe } from '../server/needs-me.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'silent-empty-'));
  const path = join(dir, 'room.sqlite');
  const s = new RoomStore(path);
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = s.identities.create('Olive');
  const peer = s.identities.create('Parker');
  const room = 'silent-empty';
  new AgentRooms(s).create(owner.secret, { roomId: room, title: 'Silent empty', purpose: 'Repro', starter: false });
  s.invites.redeem(s.invites.create(owner.secret, room, { profile: 'member' }).code,
    { identitySecret: peer.secret, displayName: 'Parker' });
  const send = (who, id, type, data) => s.command(who.secret, room, { id, type, data });
  return { s, owner, peer, room, send };
}

function seedDecoyAndStarter(f) {
  // Decoy: viewer's verifier role puts it in the viewer's addressed
  // window, but its next step (accept) belongs to the accountable peer.
  f.send(f.owner, 'propose-decoy', 'work.proposed', {
    workItemId: 'aaa-decoy', title: 'Decoy work', definitionOfDone: 'Saved',
    accountableMemberId: f.peer.identityId, verifierMemberId: f.owner.identityId, mode: 'read',
  });
  // The waiting item: next step is the viewer's, needsAttention:true.
  f.send(f.owner, 'propose-starter', 'work.proposed', {
    workItemId: 'starter', title: 'Post your plan, then close this task', definitionOfDone: 'Saved',
    accountableMemberId: f.owner.identityId, mode: 'read',
  });
}

test('first needs-me call surfaces addressed work behind a filtered candidate (FAIL on pin)', t => {
  const f = fixture(t);
  seedDecoyAndStarter(f);
  const first = collectNeedsMe(f.s, f.owner.secret);
  assert.ok(
    first.items.some(x => x.kind === 'work' && x.id === 'starter'),
    `first call must contain starter; got items=${JSON.stringify(first.items)} hasMore=${first.hasMore}`,
  );
});

test('an incomplete first page is structurally loud, never bare items:[] (FAIL on pin)', t => {
  const f = fixture(t);
  // 12 decoys exhaust any reasonable internal drain bound (cure cap: 8),
  // so the first call cannot complete: it must say so in a field a
  // consumer is required to check, with a continuation pointer.
  for (let i = 0; i < 12; i++) {
    f.send(f.owner, 'propose-decoy-' + i, 'work.proposed', {
      workItemId: 'aaa-decoy-' + String(i).padStart(2, '0'), title: 'Decoy ' + i, definitionOfDone: 'Saved',
      accountableMemberId: f.peer.identityId, verifierMemberId: f.owner.identityId, mode: 'read',
    });
  }
  f.send(f.owner, 'propose-starter', 'work.proposed', {
    workItemId: 'starter', title: 'Waiting work', definitionOfDone: 'Saved',
    accountableMemberId: f.owner.identityId, mode: 'read',
  });
  const first = collectNeedsMe(f.s, f.owner.secret);
  assert.equal(first.complete, false, 'incomplete scan must carry top-level complete:false');
  assert.equal(first.status, 'incomplete');
  assert.ok(first.nextRead, 'incomplete scan must carry a continuation nextRead');
  assert.equal(first.hasMore, true);
  // Chaining the returned cursor must eventually surface starter and
  // then complete — the item is never silently dropped.
  let page = first;
  const seen = [...page.items];
  for (let n = 0; n < 50 && page.hasMore; n++) {
    page = collectNeedsMe(f.s, f.owner.secret, { since: page.cursor });
    seen.push(...page.items);
  }
  assert.equal(page.hasMore, false);
  assert.equal(page.complete, true);
  assert.ok(seen.some(x => x.kind === 'work' && x.id === 'starter'));
});

test('genuinely empty room returns complete-empty on the first call', t => {
  const f = fixture(t);
  const first = collectNeedsMe(f.s, f.owner.secret);
  assert.deepEqual(first.items, []);
  assert.equal(first.hasMore, false);
  assert.equal(first.complete, true, 'complete-empty must be distinguishable from incomplete-empty');
  assert.equal(first.nativeCoverage[0].standingWorkAndRequests.complete, true);
  assert.equal(first.nativeCoverage[0].conversation.complete, true);
  // The permanent global flag is unchanged by the cure (omitted sources).
  assert.equal(first.nativeCoverage[0].globalAttentionComplete, false);
});

test('negative control: work addressed to another member never appears for the viewer', t => {
  const f = fixture(t);
  seedDecoyAndStarter(f);
  // Peer is accountable for the decoy (its next step IS the peer's) and
  // has no role in starter: peer must see the decoy, never starter.
  let page = collectNeedsMe(f.s, f.peer.secret);
  const seen = [...page.items];
  for (let n = 0; n < 50 && page.hasMore; n++) {
    page = collectNeedsMe(f.s, f.peer.secret, { since: page.cursor });
    seen.push(...page.items);
  }
  assert.ok(!seen.some(x => x.id === 'starter'), 'starter is addressed to the owner only');
  assert.ok(seen.some(x => x.kind === 'work' && x.id === 'aaa-decoy'), 'positive control: peer sees own addressed work');
});
