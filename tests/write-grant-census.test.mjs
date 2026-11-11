import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';
import {event, EVENT_TYPES as T} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';
import {writeGrantCensus} from '../server/operator-write-grant-census.mjs';

// A #5960-window proposal: granted when reduced, but its event never carried
// writeGrantPolicyVersion. Simulated by admitting a proposal today and then
// removing the stamp from the stored event body.
function windowRoom(t, representation) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const log = initialRoom();
  log.push(event({roomId: 'commons', actorId: 'owner', type: T.MEMBER_ADDED, data: {memberId: 'invitee', displayName: 'Invitee', kind: 'agent', permissions: ['steer']}}));
  s.initialize(log, representation ? {representation} : undefined);
  const owner = s.issueAccessKey('commons', 'owner');
  const propose = (id, mode = 'write') => s.command(owner, 'commons', {id, type: T.WORK_PROPOSED, data: {workItemId: id, title: id, definitionOfDone: 'D', accountableMemberId: 'invitee', mode}});
  propose('window-item');
  propose('fixed-item');
  const row = s.db.prepare("SELECT sequence, body FROM events WHERE room_id='commons' AND json_extract(body,'$.data.workItemId')='window-item' AND json_extract(body,'$.type')='work.proposed'").get();
  const body = JSON.parse(row.body); delete body.data.writeGrantPolicyVersion;
  // Normalized rooms guard the event log with triggers; lift the update guards
  // for this one tamper and restore them byte for byte.
  const guards = s.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='events' AND name LIKE '%events_update'").all();
  for (const {name} of guards) s.db.exec(`DROP TRIGGER ${name}`);
  s.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(body), row.sequence);
  for (const {sql} of guards) s.db.exec(sql);
  return {s, sequence: row.sequence};
}

for (const representation of [null, 'normalized-current-v1']) test(`census names only the unversioned granted proposal (${representation ?? 'legacy'})`, t => {
  const {s, sequence} = windowRoom(t, representation);
  assert.throws(() => auditRecovery(s), /externalWriteGrant/, 'the window item drifts on replay');
  const census = writeGrantCensus(s);
  assert.deepEqual(census.affected.map(({roomId, workItemId, sequence: seq, proposedBy, grantBy, grantFor}) => ({roomId, workItemId, seq, proposedBy, grantBy, grantFor})),
    [{roomId: 'commons', workItemId: 'window-item', seq: sequence, proposedBy: 'owner', grantBy: 'owner', grantFor: 'invitee'}]);
  assert.equal(census.unversionedProposals, 1);
  assert.deepEqual(census.unreadable, []);
  assert.equal(census.next, null);
});

test('census pages by room and sequence and refuses bad input', t => {
  const {s} = windowRoom(t, null);
  const pages = []; let after;
  do { const page = writeGrantCensus(s, {after, scan: '2'}); pages.push(page); after = page.next; } while (after);
  assert.ok(pages.length > 1);
  assert.equal(pages.flatMap(page => page.affected).length, 1);
  assert.throws(() => writeGrantCensus(s, {scan: '0'}), {code: 'invalid_scan'});
  assert.throws(() => writeGrantCensus(s, {after: 'nope'}), {code: 'invalid_cursor'});
});

test('census route is operator-only', async t => {
  const TOKEN = 'write-grant-census-token-0123456789';
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex');
  t.after(() => { delete process.env.ROOM_OPERATOR_TOKEN_SHA256; });
  const {s} = windowRoom(t, null);
  const server = createRoomServer({store: s});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/operator/write-grants/census`;
  assert.equal((await fetch(url)).status, 404);
  const ok = await fetch(url, {headers: {Authorization: `Operator ${TOKEN}`}});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).affected[0].workItemId, 'window-item');
  assert.equal((await fetch(`${url}?scan=99999`, {headers: {Authorization: `Operator ${TOKEN}`}})).status, 422);
});
