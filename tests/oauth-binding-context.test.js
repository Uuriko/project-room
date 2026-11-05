// Account-agent binding needs only the currently linked human and agent members.
// Epoch/account/link/connection/credential/identity checks remain independently
// fresh on access, refresh and descriptor barriers. No message, work or archive
// payload is an authorization dependency. Qualified canonical metadata must have
// its existing write proof and fit scalar admission; absent proof, legacy and
// archive shapes retain the original full path. Present proof/storage failures
// must refuse rather than fall back. This is not a whole-history audit: unrelated
// missing message rows remain detectable by existing full reads/recovery; no count
// or proof may be rewritten or certified by this authorization-only context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingFixture, measureBinding } from './helpers/oauth-binding-context-fixture.mjs';
for (const retained of [1000, 10000]) test(`resource-bound account OAuth binding avoids retained history at ${retained}`, t => {
  const f = bindingFixture(t, retained);
  const measured = measureBinding(f, () => f.resolve());
  assert.equal(measured.value.memberId, 'binding-agent');
  console.log(JSON.stringify({ retained, fullRoomReads: measured.fullRoomReads,
    messageRows: measured.messageRows, messageBytes: measured.messageBytes,
    contextRows: measured.contextRows, contextBytes: measured.contextBytes }));
  assert.equal(measured.fullRoomReads, 0);
  assert.equal(measured.messageRows, 0);
  assert.equal(measured.messageBytes, 0);
  assert.ok(measured.contextRows < 100);
  assert.ok(measured.contextBytes < 131072);
});

test('access, family descriptor and refresh retain exact resource, scopes and identity continuity', t => {
  const f = bindingFixture(t);
  const expected = f.resolve();
  assert.deepEqual(measureBinding(f, () => f.resolve()).value, expected);
  const descriptor = measureBinding(f, () => f.authorize());
  assert.equal(descriptor.value.memberId, expected.memberId); assert.equal(descriptor.fullRoomReads, 0);
  assert.deepEqual(descriptor.value.scopes, ['rooms:read','chat:read']);
  assert.equal(f.resolve({ resource: 'https://other.example/mcp' }), null);
  assert.equal(f.resolve({ roomId: 'other' }), null);
  assert.equal(f.resolve({ requiredScopes: ['work:write'] }), null);
  const next = measureBinding(f, () => f.refresh());
  assert.equal(next.fullRoomReads, 0); assert.equal(next.messageRows, 0);
  const rotated = f.resolve({ token: next.value.accessToken });
  assert.equal(rotated.identityId, expected.identityId); assert.equal(rotated.memberId, expected.memberId);
  assert.equal(rotated.familyId, expected.familyId); assert.deepEqual(rotated.scopes, expected.scopes);
  f.provider.revoke(next.value.refreshToken);
  assert.equal(f.resolve({ token: next.value.accessToken }), null); assert.equal(f.authorize(), null);
});

test('bounded membership equals original full context without rewriting proofs or payloads', t => {
  const f = bindingFixture(t);
  const proof = f.store.db.prepare("SELECT * FROM integrity_room_state WHERE room_id='commons'").get();
  const rows = f.store.db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all();
  const bounded = measureBinding(f, () => f.resolve());
  f.store.db.prepare("UPDATE integrity_room_state SET metadata_hash=NULL WHERE room_id='commons'").run();
  const full = measureBinding(f, () => f.resolve());
  assert.ok(full.fullRoomReads > 0); assert.ok(full.messageRows > 0); assert.deepEqual(bounded.value, full.value);
  assert.equal(f.store.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get().metadata_hash, null);
  f.store.db.prepare("UPDATE integrity_room_state SET metadata_hash=? WHERE room_id='commons'").run(proof.metadata_hash);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM integrity_room_state WHERE room_id='commons'").get(), proof);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all(), rows);
});

for (const shape of ['legacy','message-archive','archived-room']) test(`${shape} preserves the original binding path`, t => {
  const f = bindingFixture(t, 12, { canonical: shape !== 'legacy' });
  const before = f.resolve();
  if (shape === 'message-archive') assert.equal(f.store.archiveMessages('commons', { keepNewest: 2, dryRun: false }).ok, true);
  if (shape === 'archived-room') {
    const owner = f.store.issueAccessKey('commons','owner');
    f.store.command(owner,'commons',{ id:'archive-binding-control',type:'room.archived',data:{} });
  }
  const measured = measureBinding(f, () => f.resolve());
  assert.deepEqual(measured.value, before); assert.ok(measured.fullRoomReads > 0);
});

for (const operation of ['access','descriptor','refresh']) test(`${operation} independently refuses present metadata storage failure without full fallback`, t => {
  const f = bindingFixture(t);
  const tokens = f.store.db.prepare('SELECT * FROM oauth_provider_access_tokens').all();
  const identities = f.store.db.prepare('SELECT * FROM agent_identities').all();
  const prepare = f.store.db.prepare;
  f.store.db.prepare = function(sql) {
    if (sql.includes('AS metadata_hash_bytes')) throw Object.assign(Error('synthetic storage failure'),{code:'EIO'});
    return prepare.call(this,sql);
  };
  try {
    const result = measureBinding(f, () => {
      if (operation === 'refresh') { assert.throws(() => f.refresh(), /connection is no longer active/); return null; }
      return operation === 'access' ? f.resolve() : f.authorize();
    });
    assert.equal(result.value,null); assert.equal(result.fullRoomReads,0); assert.equal(result.messageRows,0);
  } finally { f.store.db.prepare=prepare; }
  assert.deepEqual(f.store.db.prepare('SELECT * FROM oauth_provider_access_tokens').all(),tokens);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_identities').all(),identities);
});

for (const damage of ['metadata','proof','short-proof']) test(`${damage} corruption refuses all existing binding barriers without healing`, t => {
  const f = bindingFixture(t);
  if(damage==='metadata') f.store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.members.binding-agent.active',1) WHERE id='commons'").run();
  else f.store.db.prepare("UPDATE integrity_room_state SET metadata_hash=? WHERE room_id='commons'").run(damage==='proof'?'0'.repeat(64):'bad');
  const room = f.store.db.prepare("SELECT * FROM rooms WHERE id='commons'").get();
  const proof = f.store.db.prepare("SELECT * FROM integrity_room_state WHERE room_id='commons'").get();
  const result = measureBinding(f, () => [f.resolve(),f.authorize()]);
  assert.deepEqual(result.value,[null,null]); assert.equal(result.fullRoomReads,0);
  assert.throws(()=>f.refresh(),/connection is no longer active/);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM rooms WHERE id='commons'").get(),room);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM integrity_room_state WHERE room_id='commons'").get(),proof);
});

for (const [name, sql] of [
  ['account',"UPDATE accounts SET active=0"],
  ['human link',"DELETE FROM member_accounts WHERE member_id='owner'"],
  ['identity link',"UPDATE identity_links SET member_id='different' WHERE member_id='binding-agent'"],
  ['identity epoch',"UPDATE agent_identities SET secret_hash='rotated'"],
  ['credential',"UPDATE credentials SET revoked=1 WHERE member_id='binding-agent'"],
  ['sponsored connection',"UPDATE agent_connections SET status='disconnected' WHERE member_id='binding-agent'"],
]) test(`${name} revocation remains fresh at access, descriptor and refresh`,t=>{
  const f=bindingFixture(t); assert.ok(f.resolve()); assert.ok(f.authorize());
  f.store.db.exec(sql);
  assert.equal(f.resolve(),null); assert.equal(f.authorize(),null);
  assert.throws(()=>f.refresh(),/active/);
});

test('authorization leaves unrelated missing history detectable and never heals its count',t=>{
  const f=bindingFixture(t);
  const before=f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  const proof=f.store.db.prepare("SELECT * FROM integrity_room_state WHERE room_id='commons'").get();
  f.store.db.prepare("DELETE FROM messages WHERE room_id='commons' AND message_id='history-0'").run();
  const measured=measureBinding(f,()=>f.resolve());
  assert.equal(measured.value.memberId,'binding-agent'); assert.equal(measured.messageRows,0);
  assert.equal(f.store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection,before);
  assert.deepEqual(f.store.db.prepare("SELECT * FROM integrity_room_state WHERE room_id='commons'").get(),proof);
  f.store._dropProjectionCache(); assert.throws(()=>f.store.room('commons'),/canonical message count differs/);
});

test('binding validation remains available inside an existing read-only MCP transaction',t=>{
  const f=bindingFixture(t);
  const expected=f.resolve();
  assert.deepEqual(f.store.readTransaction(()=>f.resolve()),expected);
  assert.equal(f.store.readTransaction(()=>f.authorize()).memberId,expected.memberId);
});
