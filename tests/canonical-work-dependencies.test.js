import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readWorkItem } from '../server/work-repository.mjs';
import { textVersion } from '../server/text-results.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { availableBoardRows } from '../server/available-work.mjs';
import { replay, event, PERMISSIONS } from '../src/events.js';
import { assertDependsOnKnown } from '../server/work-claim-integrity.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'room-dependencies-'));
  const store = new RoomStore(join(dir, 'room.sqlite'));
  const identity = store.identities.create('Owen');
  // Explicit historical Board/mirror fixture: production rooms are native.
  store.initialize([event({type:'room.created',roomId:'test-room',actorId:identity.identityId,data:{roomId:'test-room',ownerId:identity.identityId,title:'Dependencies',purpose:'Historical Board'}}),
    event({type:'member.added',roomId:'test-room',actorId:identity.identityId,data:{memberId:identity.identityId,identityId:identity.identityId,displayName:'Owen',kind:'agent',permissions:[...PERMISSIONS]}})]);
  store.db.prepare('INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)').run('test-room',identity.identityId,identity.identityId,store.now());
  const server = createRoomServer({ store }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new RoomAgentClient({ origin, roomId: 'test-room', token: identity.secret });
  const command = (type, data) => client.command({ id: crypto.randomUUID(), type, data });
  const proposal = (id, dependsOn) => ({ workItemId: id, title: id, definitionOfDone: 'Verified result', accountableMemberId: identity.identityId,
    mode: 'write', independentVerificationRequired: false, ownerDecisionRequired: false, ...(dependsOn === undefined ? {} : { dependsOn }) });
  const call = async (name, args) => {
    const res = await fetch(`${origin}/room/mcp?profile=full`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.secret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'tools/call', params: { name, arguments: { roomId: 'test-room', ...args } } }) });
    return (await res.json()).result;
  };
  const state = () => store.room('test-room');
  const acquire = id => command('claim.acquired', { workItemId: id, expectedRevision: state().state.workItems[id].revision,
    repository: 'acme/test', ref: 'main', paths: [id+'.js'], expiresAt: new Date(Date.now()+3600000).toISOString() });
  const ready = async () => (await (await fetch(`${origin}/api/rooms/test-room/work-claims?queue=ready`, { headers: { Authorization: `Bearer ${identity.secret}` } })).json()).claims;
  return { store, client, command, proposal, call, state, acquire, ready };
}

test('canonical MCP proposal dependency excludes available work and atomically refuses acquire until Board completion', async t => {
  const f = await fixture(t);
  await f.client.workClaimCreate({ id: 'base', reviewPolicy: 'self_attested' });
  const proposed = await f.call('room_propose_work', { ...f.proposal('child', ['base']), requestId: 'propose-child' });
  assert.equal(proposed.isError, undefined, JSON.stringify(proposed));
  assert.equal(proposed.structuredContent.status, 'recorded');
  await f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 });
  assert.deepEqual(f.store.workClaims.get('test-room', 'child').dependsOn, ['base']);
  assert.equal(availableBoardRows(f.store.workClaims.list('test-room')).some(x => x.id === 'child'), false);
  assert.equal((await f.ready()).some(x => x.id === 'child'), false);
  const before = f.state().sequence;
  await assert.rejects(f.acquire('child'), e => e.status === 409 && e.code === 'work_claim_dependencies_unmet');
  assert.equal(f.state().sequence, before);
  assert.equal(f.state().state.workItems.child.claim, null);
  const read = (await f.call('room_read_work', { workItemId: 'child' })).structuredContent;
  assert.deepEqual(read.dependencies, [{ id: 'base', state: 'unclaimed', satisfied: false }]);
  const brief = (await f.call('room_read_work', { workItemId: 'child', brief: true })).structuredContent.brief;
  assert.match(brief, /base: unclaimed \(not satisfied\)/);
  assert.match(brief, /Do not claim or start/);
  await f.client.claimWorkItem('base');
  await f.client.updateWorkItem('base', { state: 'in_progress' });
  await f.client.updateWorkItem('base', { state: 'done' });
  assert.equal(availableBoardRows(f.store.workClaims.list('test-room')).some(x => x.id === 'child'), true);
  assert.equal((await f.ready()).some(x => x.id === 'child'), true);
  assert.equal((await f.client.workContext('child')).dependencies[0].satisfied, true);
  await f.acquire('child');
  assert.equal(f.state().state.workItems.child.claim.status, 'active');
});

test('proposal validates self, missing and bounds without saving, and acceptance rechecks deletion', async t => {
  const f = await fixture(t);
  for (const deps of [['child'], ['missing'], Array.from({ length: 17 }, (_, i) => 'x'+i), [123]]) {
    const before = f.state().sequence;
    await assert.rejects(f.command('work.proposed', f.proposal('child', deps)), e => e.status === 422);
    assert.equal(f.state().sequence, before);
    assert.equal(f.state().state.workItems.child, undefined);
    assert.equal(f.store.workClaims.get('test-room', 'child'), null);
  }
  await f.client.workClaimCreate({ id: 'base' });
  await f.command('work.proposed', f.proposal('child', ['base']));
  f.store.workClaims.delete('test-room', 'base');
  const before = f.state().sequence;
  await assert.rejects(f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 }), e => e.code === 'invalid_claim_input');
  assert.equal(f.state().sequence, before);
  assert.equal(f.state().state.workItems.child.state, 'proposed');
});

test('existing Board deletion waiver stays authoritative on canonical read and acquisition', async t => {
  const f = await fixture(t);
  await f.client.workClaimCreate({ id: 'base' });
  await f.command('work.proposed', f.proposal('child', ['base']));
  await f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 });
  f.store.workClaims.delete('test-room', 'base');
  assert.deepEqual((await f.client.workContext('child')).dependencies, []);
  await f.acquire('child');
  assert.deepEqual(f.store.workClaims.get('test-room', 'child').dependsOn, []);
  const events = f.store.db.prepare('SELECT body FROM events WHERE room_id=? ORDER BY sequence').all('test-room').map(row => JSON.parse(row.body));
  assert.deepEqual(replay(events).workItems.child.dependsOn, ['base'], 'replay preserves the declaration without consulting mutable Board/deleted targets');
});

test('shared Board admission rejects an indirect cycle and bounds graph traversal', () => {
  const reject = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
  const graph = new Map([['a', { dependsOn: ['b'] }], ['b', { dependsOn: ['self'] }]]);
  assert.throws(() => assertDependsOnKnown(reject, { dependsOn: ['a'] }, { selfId: 'self', has: id => graph.has(id), get: id => graph.get(id) }), /cycle/);
  assert.throws(() => assertDependsOnKnown(reject, { dependsOn: ['0'] }, { selfId: 'self', has: () => true,
    get: id => ({ dependsOn: [String(Number(id)+1)] }) }), /validation bound/);
});

test('read-mode start obeys dependencies and permission refusal writes nothing', async t => {
  const f = await fixture(t);
  await f.client.workClaimCreate({ id: 'base' });
  await f.command('work.proposed', { ...f.proposal('reader', ['base']), mode: 'read' });
  await f.command('work.accepted', { workItemId: 'reader', expectedRevision: 0 });
  const before = f.state().sequence;
  await assert.rejects(f.command('work.started', { workItemId: 'reader', expectedRevision: 1 }), e => e.code === 'work_claim_dependencies_unmet');
  assert.equal(f.state().sequence, before);
  assert.equal(f.state().state.workItems.reader.state, 'accepted');
  await f.command('member.added', { memberId: 'outsider', displayName: 'Alex', kind: 'agent', permissions: [] });
  const key = f.store.mintAccessKey('test-room', 'outsider');
  const seq = f.state().sequence;
  assert.throws(() => f.store.command(key, 'test-room', { id: crypto.randomUUID(), type: 'work.proposed', data: f.proposal('forbidden', ['base']) }), /lacks steer/);
  assert.equal(f.state().sequence, seq);
});

test('Board cycle hardening refuses a newly closed indirect cycle through its real HTTP endpoint', async t => {
  const f = await fixture(t);
  await f.client.workClaimCreate({ id: 'a' });
  await f.client.workClaimCreate({ id: 'b', dependsOn: ['a'] });
  const before = f.state().sequence;
  await assert.rejects(f.client.claimWorkItem('a', { dependsOn: ['b'] }), e => e.code === 'invalid_claim_input' && /cycle/.test(e.message));
  assert.equal(f.state().sequence, before);
  assert.deepEqual(f.store.workClaims.get('test-room', 'a').dependsOn, []);
});

test('encoded self ID is refused and mirror storage failure rolls acceptance back atomically', async t => {
  const f = await fixture(t);
  const { boardClaimId } = await import('../server/work-item-board.mjs');
  const before = f.state().sequence;
  await assert.rejects(f.command('work.proposed', f.proposal('child.with-dot', [boardClaimId('child.with-dot')])), e => e.code === 'invalid_claim_input');
  assert.equal(f.state().sequence, before);
  await f.client.workClaimCreate({ id: 'base' });
  await f.command('work.proposed', f.proposal('child', ['base']));
  const seq = f.state().sequence;
  const set = f.store.workClaims.set.bind(f.store.workClaims);
  f.store.workClaims.set = () => { throw new Error('injected Board storage failure'); };
  await assert.rejects(f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 }));
  f.store.workClaims.set = set;
  assert.equal(f.state().sequence, seq);
  assert.equal(f.state().state.workItems.child.state, 'proposed');
  assert.equal(f.store.workClaims.get('test-room', 'child'), null);
  await f.command('work.accepted', { workItemId: 'child', expectedRevision: 0 });
  assert.deepEqual(f.store.workClaims.get('test-room', 'child').dependsOn, ['base']);
  const snapshot = f.store.snapshot(f.store.mintAccessKey('test-room', f.state().state.room.ownerId), 'test-room');
  assert.deepEqual(snapshot.state.workItems.child.dependsOn, ['base']);
});

function nativeFixture(t,{persistent=false,seeds=[]}={}) {
  const dir=persistent?mkdtempSync(join(tmpdir(),'native-dependencies-')):null;
  const filename=dir?join(dir,'room.sqlite'):':memory:';
  let store = new RoomStore(filename); t.after(() => {store.close();if(dir)rmSync(dir,{recursive:true,force:true});});
  store.initialize([...initialRoom(),...seeds], {representation:'normalized-current-v1'});
  const key = store.issueAccessKey('commons','owner');
  const send = (type,data,id=crypto.randomUUID()) => store.command(key,'commons',{id,type,data});
  const item = id => readWorkItem(store.db,'commons',id);
  const propose = (id,dependsOn=[],extra={}) => send('work.proposed',{workItemId:id,title:id,definitionOfDone:'Saved result',accountableMemberId:'owner',mode:'read',dependsOn,...extra});
  const accept = id => send('work.accepted',{workItemId:id,expectedRevision:item(id).revision});
  const start = id => send('work.started',{workItemId:id,expectedRevision:item(id).revision});
  const complete = id => { const body='Exact saved result '+id; const post=send('message.posted',{messageId:'result-'+id,workItemId:id,body});
    return send('work.completed',{workItemId:id,expectedRevision:item(id).revision,evidenceKind:'room_text',evidenceMessageId:'result-'+id,evidenceMessageEventId:post.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'Saved',nextAction:'Review'}); };
  return {get store(){return store;},key,send,item,propose,accept,start,complete,reopen(){store.close();store=new RoomStore(filename);}};
}
test('native dependencies require exact canonical saved completion and never consult legacy Board',t=>{
  const f=nativeFixture(t); f.propose('base'); f.accept('base'); f.propose('child',['base']); f.accept('child');
  const before=f.store.headSequence('commons');
  assert.throws(()=>f.start('child'),e=>e.code==='work_claim_dependencies_unmet');
  assert.equal(f.store.headSequence('commons'),before);
  assert.deepEqual(f.store.workContext(f.key,'commons','child').dependencies,[{id:'base',state:'unclaimed',satisfied:false}]);
  f.start('base'); const completion=f.complete('base');
  assert.deepEqual(f.store.workContext(f.key,'commons','child').dependencies,[{id:'base',state:'done',satisfied:true}]);
  const result=f.store.workResult(f.key,'commons','base');assert.equal(result.result.receipt.eventId,completion.event.id);assert.equal(result.result.text.body,'Exact saved result base');
  f.start('child'); assert.equal(f.item('child').state,'working');
  assert.equal(f.store.workClaims.get('commons','base'),null);assert.equal(f.store.workClaims.get('commons','child'),null);
});
test('native dependency self/missing inputs and stale revisions never save; owner review remains required',t=>{
  const f=nativeFixture(t);
  for(const deps of [['self'],['missing'],Array.from({length:17},(_,i)=>'x'+i)]){const before=f.store.headSequence('commons');assert.throws(()=>f.propose('self',deps));assert.equal(f.store.headSequence('commons'),before);assert.equal(f.item('self'),null);}
  f.propose('base',[],{ownerDecisionRequired:true,humanDecisionMakerId:'owner'});f.accept('base');f.propose('child',['base']);f.accept('child');f.start('base');f.complete('base');
  assert.equal(f.store.workContext(f.key,'commons','child').dependencies[0].satisfied,false);
  assert.throws(()=>f.start('child'),e=>e.code==='work_claim_dependencies_unmet');
  const receipt=f.item('base').receipt;
  f.send('message.posted',{messageId:'rationale',body:'I reviewed the exact result'});
  f.send('owner.decision_recorded',{workItemId:'base',expectedRevision:f.item('base').revision,decision:'approved',completionEventId:receipt.eventId,evidenceVersion:receipt.evidenceVersion,reason:'Approved exact result',sourceMessageId:'rationale'});
  const before=f.store.headSequence('commons');assert.throws(()=>f.send('work.started',{workItemId:'child',expectedRevision:0}),/Stale/);assert.equal(f.store.headSequence('commons'),before);
  const request={workItemId:'child',expectedRevision:f.item('child').revision};const first=f.send('work.started',request,'exact-dependent-start');const retry=f.send('work.started',request,'exact-dependent-start');assert.equal(retry.duplicate,true);assert.equal(retry.sequence,first.sequence);
});

test('native dependency completion keeps independent verification and refuses superseded prerequisite',t=>{
  const f=nativeFixture(t);f.send('member.added',{memberId:'verifier',displayName:'Verifier',kind:'agent',permissions:['verify']});const key=f.store.issueAccessKey('commons','verifier');
  f.propose('base',[],{independentVerificationRequired:true,verifierMemberId:'verifier'});f.accept('base');f.propose('child',['base']);f.accept('child');f.start('base');const completion=f.complete('base');
  assert.throws(()=>f.start('child'),e=>e.code==='work_claim_dependencies_unmet');
  const receipt=f.item('base').receipt;
  f.store.command(key,'commons',{id:'verified',type:'verification.recorded',data:{workItemId:'base',expectedRevision:f.item('base').revision,result:'pass',completionEventId:completion.event.id,evidenceVersion:receipt.evidenceVersion,summary:'Checked exact result'}});
  assert.equal(f.store.workContext(f.key,'commons','child').dependencies[0].satisfied,true);
  f.propose('replacement');f.send('work.superseded',{workItemId:'base',expectedRevision:f.item('base').revision,supersededByWorkItemId:'replacement',reason:'Continue replacement'});
  assert.equal(f.store.workContext(f.key,'commons','child').dependencies[0].satisfied,false);assert.throws(()=>f.start('child'),e=>e.code==='work_claim_dependencies_unmet');
});
test('native dependency duplicate normalization, cycle protection and bounded proof refusal preserve source',t=>{
  const data={workItemId:'base',title:'Base',definitionOfDone:'Saved',accountableMemberId:'owner',dependsOn:['child']};
  const f=nativeFixture(t,{seeds:[event({roomId:'commons',actorId:'owner',type:'work.proposed',data})]});
  const before=f.store.headSequence('commons');assert.throws(()=>f.propose('child',['base']),/cycle/);assert.equal(f.store.headSequence('commons'),before);
  f.propose('other');f.propose('dupes',['other','other']);assert.deepEqual(f.item('dupes').dependsOn,['other']);
  const prepare=f.store.db.prepare.bind(f.store.db);f.store.db.prepare=sql=>{const st=prepare(sql);if(!sql.startsWith('SELECT revision,digest,body FROM work_entities'))return st;return new Proxy(st,{get(target,k){const fn=Reflect.get(target,k,target);if(k!=='get')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const row=fn.apply(target,args);return args[1]==='other'?{...row,body:row.body+' '}:row;};}});};
  const seq=f.store.headSequence('commons');assert.throws(()=>f.accept('dupes'),/work reference changed/);f.store.db.prepare=prepare;assert.equal(f.store.headSequence('commons'),seq);assert.equal(f.item('dupes').state,'proposed');
});
test('native dependency save fault rolls back, cold retry saves once and exact saved result stays unchanged',t=>{
  const f=nativeFixture(t,{persistent:true});f.propose('base');f.accept('base');f.start('base');f.complete('base');f.propose('child',['base']);f.accept('child');
  const exactResult=f.store.workResult(f.key,'commons','base').result,revision=f.item('child').revision,before=f.store.headSequence('commons');
  const request={workItemId:'child',expectedRevision:revision},prepare=f.store.db.prepare.bind(f.store.db);let fired=false;
  f.store.db.prepare=sql=>new Proxy(prepare(sql),{get(target,k){const fn=Reflect.get(target,k,target);if(k!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const result=fn.apply(target,args);if(/^INSERT INTO current_room_head/.test(sql.trim())){fired=true;throw Error('dependent save interrupted');}return result;};}});
  assert.throws(()=>f.send('work.started',request,'cold-dependent'),/dependent save interrupted/);f.store.db.prepare=prepare;assert.equal(fired,true);assert.equal(f.store.headSequence('commons'),before);assert.equal(f.item('child').state,'accepted');
  f.reopen();const first=f.send('work.started',request,'cold-dependent');f.reopen();const retry=f.send('work.started',request,'cold-dependent');assert.equal(retry.duplicate,true);assert.equal(retry.sequence,first.sequence);assert.deepEqual(f.store.workResult(f.key,'commons','base').result,exactResult);
});
test('native HTTP selected dependency and read start agree before and after saved result',async t=>{
  const f=nativeFixture(t);f.propose('base');f.accept('base');f.propose('reader',['base']);f.accept('reader');
  const server=createRoomServer({store:f.store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const client=new RoomAgentClient({origin:`http://127.0.0.1:${server.address().port}`,roomId:'commons',token:f.key});
  const data={workItemId:'reader',expectedRevision:f.item('reader').revision};
  const before=f.store.headSequence('commons');await assert.rejects(client.command({id:'blocked-start',type:'work.started',data}),e=>e.code==='work_claim_dependencies_unmet');assert.equal(f.store.headSequence('commons'),before);
  assert.equal((await client.workContext('reader')).dependencies[0].satisfied,false);
  f.start('base');const saved=f.complete('base');assert.deepEqual((await client.workContext('reader')).dependencies,[{id:'base',state:'done',satisfied:true}]);
  const command={id:'start-reader',type:'work.started',data};const first=await client.command(command),retry=await client.command(command);assert.equal(retry.duplicate,true);assert.equal(retry.sequence,first.sequence);assert.equal(f.item('reader').state,'working');
  assert.equal(f.store.workResult(f.key,'commons','base').result.receipt.eventId,saved.event.id);
});
