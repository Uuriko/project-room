import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event, EVENT_TYPES as T} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';

// #5960 stamped every owner/holder proposal at reduce time, so replaying a log
// written before it produced grants its stored projection never had, and the
// replayed copy could authorize a start the stored copy refuses. The stamp now
// applies only to proposals admitted under writeGrantPolicyVersion.
const COLLABORATE = ['steer', 'accept_work', 'complete_work'];
function legacyLog() {
  const es = initialRoom();
  es.push(event({roomId: 'commons', actorId: 'owner', type: T.MEMBER_ADDED, data: {memberId: 'invitee', displayName: 'Invitee', kind: 'agent', permissions: COLLABORATE}}));
  // A proposal recorded before the policy existed: no writeGrantPolicyVersion.
  es.push(event({roomId: 'commons', actorId: 'owner', type: T.WORK_PROPOSED, data: {workItemId: 'old-write', title: 'Old', definitionOfDone: 'D', accountableMemberId: 'invitee', mode: 'write'}}));
  return es;
}

for (const representation of [null, 'normalized-current-v1']) test(`a pre-policy proposal replays without a grant and authority agrees (${representation ?? 'legacy'})`, t => {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  s.initialize(legacyLog(), representation ? {representation} : undefined);
  const stored = () => JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE work_id='old-write'").get()?.body ?? 'null') ?? s.state('commons').workItems['old-write'];
  assert.equal(stored().externalWriteGrantBy, undefined, 'stored item has no grant');
  assert.doesNotThrow(() => auditRecovery(s), 'replay matches the stored projection');
  // Both copies refuse an assignee write start without write_external.
  const invitee = s.issueAccessKey('commons', 'invitee');
  s.command(invitee, 'commons', {id: 'accept', type: T.WORK_ACCEPTED, data: {workItemId: 'old-write', expectedRevision: 0}});
  assert.throws(() => s.command(invitee, 'commons', {id: 'start', type: T.WORK_STARTED, data: {workItemId: 'old-write', expectedRevision: stored().revision}}), /write_external|claim|permission/i);
  assert.doesNotThrow(() => auditRecovery(s));
});

for (const representation of [null, 'normalized-current-v1']) test(`a proposal admitted now carries the policy, the grant, and replays to the same grant (${representation ?? 'legacy'})`, t => {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  s.initialize(legacyLog(), representation ? {representation} : undefined);
  const owner = s.issueAccessKey('commons', 'owner');
  const result = s.command(owner, 'commons', {id: 'new', type: T.WORK_PROPOSED, data: {workItemId: 'new-write', title: 'New', definitionOfDone: 'D', accountableMemberId: 'invitee', mode: 'write'}});
  assert.equal(result.event.data.writeGrantPolicyVersion, 1, 'the server stamps the policy at admission');
  const item = JSON.parse(s.db.prepare("SELECT body FROM work_entities WHERE work_id='new-write'").get()?.body ?? 'null') ?? s.state('commons').workItems['new-write'];
  assert.deepEqual([item.externalWriteGrantBy, item.externalWriteGrantFor], ['owner', 'invitee']);
  assert.doesNotThrow(() => auditRecovery(s), 'replay reproduces the same grant');
  // Callers cannot claim the policy themselves.
  assert.throws(() => s.command(owner, 'commons', {id: 'forged', type: T.WORK_PROPOSED, data: {workItemId: 'forged', title: 'F', definitionOfDone: 'D', accountableMemberId: 'invitee', mode: 'write', writeGrantPolicyVersion: 2}}));
});
