import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {createRoomServer} from '../server/http.mjs';
import {operatorLifecycleArchive} from '../server/operator-lifecycle-archive.mjs';import {auditRecovery} from '../server/recovery.mjs';
const input={roomId:'muse-room',confirmRoomId:'muse-room',reason:'Explicit disposable legacy room cutover'};
function fixture(t,native=false){const dir=mkdtempSync(join(tmpdir(),'operator-lifecycle-'));const file=join(dir,'room.sqlite');const store=new RoomStore(file);store.initialize(initialRoom('muse-room').map(e=>e.type==='member.added'?{...e,data:{...e.data,kind:'agent'}}:e),native?{representation:'normalized-current-v1'}:{});store.initialize(initialRoom('target'),{representation:'normalized-current-v1'});const key=store.issueAccessKey('muse-room','owner'),target=store.issueAccessKey('target','owner'),identity=store.identities.create('Preserved identity');t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,file,key,target,identity};}
for(const native of [false,true])test(`operator archives ${native?'normalized':'legacy agent-owned'} room, preserves authority and cold receipt`,t=>{
 const f=fixture(t,native),plan=operatorLifecycleArchive(f.store,input),request={...input,requestId:'archive-exact',planHash:plan.planHash};
 const security=()=>['accounts','member_accounts','credentials','agent_identities','identity_links','agent_connections'].map(table=>[table,f.store.db.prepare(`SELECT * FROM ${table}`).all()]);const before=security();
 const result=operatorLifecycleArchive(f.store,request,true);assert.equal(result.authority,'operator_on_owner_behalf');assert.equal(result.ownerId,'owner');assert.equal(result.archived,true);assert.deepEqual(security(),before);
 assert.equal(f.store.authenticate(f.key,'muse-room').member.id,'owner');assert.equal(f.store.authenticate(f.target,'target').member.id,'owner');assert.ok(f.store.identities.resolveGlobalIdentitySecret(f.identity.secret));
 assert.throws(()=>f.store.command(f.key,'muse-room',{id:'late',type:'message.posted',data:{messageId:'late',body:'closed'}}),{code:'room_archived'});
 assert.equal(auditRecovery(f.store).rooms,2);
 assert.deepEqual(operatorLifecycleArchive(f.store,request,true),{...result,duplicate:true});
 assert.throws(()=>operatorLifecycleArchive(f.store,{...request,reason:'Changed'},true),{code:'idempotency_conflict'});
 const cold=new RoomStore(f.file);try{assert.deepEqual(operatorLifecycleArchive(cold,request,true),{...result,duplicate:true});assert.equal(auditRecovery(cold).rooms,2);}finally{cold.close();}
 assert.throws(()=>f.store.archiveQaRoomAsOperator('muse-room','wrong','wrong'),{code:'operator_retirement_scope'});
});
test('stale plan and audit save failure leave room and event history unchanged',t=>{
 const f=fixture(t),plan=operatorLifecycleArchive(f.store,input),request={...input,requestId:'fault',planHash:plan.planHash};
 f.store.command(f.key,'muse-room',{id:'arrived',type:'message.posted',data:{messageId:'arrived',body:'late arrival'}});
 assert.throws(()=>operatorLifecycleArchive(f.store,request,true),{code:'plan_changed'});
 request.planHash=operatorLifecycleArchive(f.store,input).planHash;const before=f.store.headSequence('muse-room');
 const prepare=f.store.db.prepare.bind(f.store.db);f.store.db.prepare=sql=>sql.includes('INSERT INTO operator_actions')?{run:()=>{throw Error('audit save fault');}}:prepare(sql);
 try{assert.throws(()=>operatorLifecycleArchive(f.store,request,true),/audit save fault/);}finally{f.store.db.prepare=prepare;}
 assert.equal(f.store.headSequence('muse-room'),before);assert.equal(f.store.db.prepare('SELECT archived_at FROM rooms WHERE id=?').get('muse-room').archived_at,null);
 assert.equal(f.store.room('muse-room').state.room.archivedAt,undefined);assert.equal(operatorLifecycleArchive(f.store,request,true).archived,true);
});
test('actual operator HTTP requires operator auth, exact confirmation and allowlisted room',async t=>{
 const f=fixture(t),token='synthetic-operator-'.repeat(4),prior=process.env.ROOM_OPERATOR_TOKEN_SHA256;process.env.ROOM_OPERATOR_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');t.after(()=>{if(prior===undefined)delete process.env.ROOM_OPERATOR_TOKEN_SHA256;else process.env.ROOM_OPERATOR_TOKEN_SHA256=prior;});
 const server=createRoomServer({store:f.store});t.after(()=>{server.closeAllConnections();server.close();});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=(path,data,authorization=`Operator ${token}`)=>fetch(`http://127.0.0.1:${server.address().port}/api/operator/lifecycle-archive/${path}`,{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(data)});
 const p=await call('plan',input);assert.equal(p.status,200);const plan=await p.json();
 assert.equal((await call('plan',input,'Bearer '+f.key)).status,404);
 assert.equal((await call('plan',{...input,roomId:'target',confirmRoomId:'target'})).status,403);
 assert.equal((await call('plan',{...input,confirmRoomId:'wrong'})).status,422);
 const request={...input,requestId:'http-exact',planHash:plan.planHash},res=await call('execute',request);assert.equal(res.status,200);assert.equal((await res.json()).archived,true);
 assert.equal((await (await call('execute',request)).json()).duplicate,true);
});
