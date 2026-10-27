import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
function setup(t) {
 const f=createAcceptanceFixture();t.after(()=>{f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const s=f.store;const owner=s.issueAccessKey("commons","owner");s.roomDirectory.set("commons","owner",true);
 s.createAccount("requester");const key=s.issueAccountAccessKey("requester"),slot=s.createAccountSessionSlot();
 const session=s.loginAccountSession(slot.token,key,0);
 return {s,owner,token:slot.token,binding:session.sessionBinding,input:{roomId:"commons",requestId:"humanjoin-ask-1",displayName:"New Human",note:"Hello"}};
}
test("human request approval binds real account atomically and retries do not duplicate",t=>{
 const {s,owner,token,binding,input}=setup(t);const q=s.accountJoinRequests;
 const pending=q.request(token,binding,input);assert.equal(pending.status,"pending");assert.deepEqual(q.request(token,binding,input),pending);
 assert.throws(()=>q.request(token,binding,{...input,note:"changed"}),{code:"idempotency_conflict"});
 const done=q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0});
 assert.equal(done.status,"approved");assert.equal(s.room("commons").state.members[done.memberId].kind,"human");
 assert.deepEqual(s.room("commons").state.members[done.memberId].permissions,[]);
 assert.equal(s.accountRooms(token,binding).rooms[0].id,"commons");
 assert.deepEqual(q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),done);
 assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE member_id=?").get(done.memberId).n,0);
 assert.equal(JSON.stringify(q.listOwn(token,binding)).includes('"accountId"'),false);
});
test("unlisting and cancellation prevent approval",t=>{
 const {s,owner,token,binding,input}=setup(t),q=s.accountJoinRequests;
 q.request(token,binding,input);s.roomDirectory.set("commons","owner",false);
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),{code:"join_unavailable"});
 assert.equal(q.listOwn(token,binding).requests[0].status,"unavailable");
 assert.equal(q.cancel(token,binding,input.requestId,0).status,"cancelled");
 s.roomDirectory.set("commons","owner",true);
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),{code:"join_request_changed"});
 assert.equal(s.accountRooms(token,binding).rooms.length,0);
});

test("real HTTP requires account CSRF and approval makes account room visible",async t=>{
 const {s,owner,token,binding,input}=setup(t);
 const {createRoomServer}=await import("../server/http.mjs");const server=createRoomServer({store:s});
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const auth=s.authenticateAccountSession(token,null,binding);
 const headers={Cookie:`account_session=${token}`,"X-Session-Binding":binding,"Content-Type":"application/json",Origin:origin};
 let r=await fetch(origin+"/api/account-join-requests",{method:"POST",headers,body:JSON.stringify(input)});assert.equal(r.status,403);
 r=await fetch(origin+"/api/account-join-requests",{method:"POST",headers:{...headers,"X-CSRF-Token":auth.csrf},body:JSON.stringify(input)});assert.equal(r.status,201,await r.clone().text());
 const request=await r.json();assert.equal(request.status,"pending");
 r=await fetch(origin+"/api/rooms/commons/join-requests",{headers:{Authorization:`Bearer ${owner}`}});assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).requests.length,1);
 r=await fetch(origin+`/api/rooms/commons/join-requests/${input.requestId}/decide`,{method:"POST",headers:{Authorization:`Bearer ${owner}`,"Content-Type":"application/json"},body:JSON.stringify({decision:"approve",expectedRevision:0})});assert.equal(r.status,200,await r.clone().text());
 r=await fetch(origin+"/api/account-rooms",{headers});assert.equal(r.status,200);assert.equal((await r.json()).rooms[0].id,"commons");
});

test("owner offline overview and durable notifications contain the human request without account identity",async t=>{
 const {s,owner,token,binding,input}=setup(t);s.accountJoinRequests.request(token,binding,input);
 const {AccessRequests}=await import("../server/access-requests.mjs");
 const {attentionReport}=await import("../server/owner-attention.mjs");
 const report=attentionReport({store:s,accessRequests:new AccessRequests(s)},owner,"commons");
 const item=report.items.find(x=>x.id===input.requestId);assert.ok(item);assert.match(item.actions[0].path,/\/join-requests\//);assert.deepEqual(item.actions[0].body,{decision:"approve",expectedRevision:0});
 const {ownerOverview}=await import("../server/owner-overview.mjs");
 const ownerAccount=s.accountForMember("commons","owner") ?? s.bindHumanAccount("commons","owner","owner-account");
 const ownerSlot=s.createAccountSessionSlot();const ownerSession=s.loginAccountSession(ownerSlot.token,s.issueAccountAccessKey(ownerAccount.id),0);
 const overview=ownerOverview({store:s,accessRequests:new AccessRequests(s)},ownerSlot.token,ownerSession.sessionBinding,s.now());
 assert.ok(JSON.stringify(overview).includes(input.requestId));
 const {deriveNotifications}=await import("../server/notifications.mjs");
 const state=s.room("commons").state;
 const events=s.db.prepare("SELECT sequence,body FROM events WHERE room_id=? ORDER BY sequence").all("commons").map(r=>({sequence:r.sequence,event:JSON.parse(r.body)}));
 const notifications=deriveNotifications({events,state,member:state.members.owner});
 assert.ok(notifications.some(x=>x.requestId===input.requestId));
 assert.equal(JSON.stringify({report,notifications}).includes('"requester"'),false);
});

test("private rooms, inactive accounts, revoked owners and cancellation fail closed",t=>{
 const {s,owner,token,binding,input}=setup(t),q=s.accountJoinRequests;
 s.roomDirectory.set("commons","owner",false);
 assert.throws(()=>q.request(token,binding,input),{code:"join_unavailable"});
 s.roomDirectory.set("commons","owner",true);q.request(token,binding,input);
 s.createAccount("other");const key=s.issueAccountAccessKey("other"),slot=s.createAccountSessionSlot(),other=s.loginAccountSession(slot.token,key,0);
 assert.throws(()=>q.cancel(slot.token,other.sessionBinding,input.requestId,0),{code:"join_request_not_found"});
 assert.deepEqual(q.listOwn(slot.token,other.sessionBinding).requests,[]);
 s.changeAccountAccess("requester",{expectedRevision:0,active:false,reason:"test"});
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),{code:"requester_unavailable"});
 assert.equal(q.list(owner,"commons",null).requests[0].status,"pending");
 s.db.prepare("UPDATE credentials SET revoked=1 WHERE member_id='owner' AND room_id='commons'").run();
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"deny",expectedRevision:0}));
});

test("new rooms list only by explicit choice, keep receipts private and retry never overwrites settings",t=>{
 const {s,token,binding}=setup(t);
 const input={roomId:"new-public",title:"A public room",purpose:"Collaborate",kind:"personal",displayName:"Founder",discoverable:true};
 s.createAccountRoom(token,binding,input);
 assert.equal(s.roomDirectory.status(input.roomId,"owner").discoverable,true);
 assert.equal(s.roomDirectory.status(input.roomId,"owner").publicReceipts,false);
 assert.equal(s.publicFace.status(input.roomId,"owner").enabled,false);
 s.roomDirectory.set(input.roomId,"owner",false);
 assert.equal(s.createAccountRoom(token,binding,input).duplicate,true);
 assert.equal(s.roomDirectory.status(input.roomId,"owner").discoverable,false);
 assert.throws(()=>s.createAccountRoom(token,binding,{...input,discoverable:false}),{code:"room_exists"});
 const privateInput={...input,roomId:"new-private",discoverable:false};s.createAccountRoom(token,binding,privateInput);
 assert.equal(s.roomDirectory.status(privateInput.roomId,"owner").discoverable,false);
});

test("v42 migration preserves rooms and fences an old writer before v43 join writes",async t=>{
 const {RoomStore}=await import("../server/store.mjs");const {DatabaseSync}=await import("node:sqlite");
 const {writerFenceDefinitions,fenceDefinitions}=await import("../server/writer-fence.mjs");
 const {mkdtempSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const dir=mkdtempSync(join(tmpdir(),"human-join-upgrade-")),file=join(dir,"room.sqlite");t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const fresh=new RoomStore(file);fresh.createAccount("kept-account");
 for(const def of writerFenceDefinitions)fresh.db.exec(`DROP TRIGGER ${def.name}`);
 fresh.db.exec("DROP TABLE account_join_requests; PRAGMA user_version=42");
 for(const def of fenceDefinitions(42))fresh.db.exec(def.sql);fresh.close();
 const old=new DatabaseSync(file);old.function("project_room_writer_v42",()=>42);
 const before=old.prepare("SELECT * FROM accounts WHERE id='kept-account'").get();old.prepare("UPDATE accounts SET revision=revision WHERE id='kept-account'").run();
 const upgraded=new RoomStore(file);
 try{assert.equal(upgraded.db.prepare("PRAGMA user_version").get().user_version,43);assert.deepEqual(upgraded.db.prepare("SELECT * FROM accounts WHERE id='kept-account'").get(),before);
 assert.throws(()=>old.prepare("UPDATE accounts SET revision=revision WHERE id='kept-account'").run(),/writer_v43|unsupported database writer/);
 assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS n FROM account_join_requests").get().n,0);
 }finally{upgraded.close();old.close();}
});

test("failed human binding rolls back member event and decision atomically",t=>{
 const {s,owner,token,binding,input}=setup(t),q=s.accountJoinRequests;q.request(token,binding,input);
 const before=s.room("commons"),members=Object.keys(before.state.members),sequence=before.sequence;
 const original=s.ensureHumanAccountBinding;s.ensureHumanAccountBinding=()=>{throw new Error("injected binding storage failure");};
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),/injected binding/);
 s.ensureHumanAccountBinding=original;
 assert.equal(s.room("commons").sequence,sequence);assert.deepEqual(Object.keys(s.room("commons").state.members),members);
 assert.equal(q.listOwn(token,binding).requests[0].status,"pending");
 assert.equal(q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}).status,"approved");
});

test("decline and expiry cannot grant access",t=>{
 const {s,owner,token,binding,input}=setup(t),q=s.accountJoinRequests;q.request(token,binding,input);
 const denied=q.decide(owner,"commons",null,input.requestId,{decision:"deny",expectedRevision:0});assert.equal(denied.status,"denied");
 assert.deepEqual(q.decide(owner,"commons",null,input.requestId,{decision:"deny",expectedRevision:0}),denied);
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),{code:"join_request_changed"});
 const second={...input,requestId:"humanjoin-second"};q.request(token,binding,second);
 s.db.prepare("UPDATE account_join_requests SET expires_at=0 WHERE request_id=?").run(second.requestId);
 assert.throws(()=>q.decide(owner,"commons",null,second.requestId,{decision:"approve",expectedRevision:0}),{code:"join_request_changed"});
 assert.equal(q.listOwn(token,binding).requests.find(r=>r.requestId===second.requestId).status,"expired");
 assert.equal(q.list(owner,"commons",null).requests.length,0);
 assert.equal(s.accountRooms(token,binding).rooms.length,0);
});

test("account deletion purges the join request and prevents later approval",async t=>{
 const {s,owner,token,binding,input}=setup(t);s.accountJoinRequests.request(token,binding,input);
 const {inventoryFromStore,planAccountDeletion,executeAccountDeletion}=await import("../server/account-deletion.mjs");
 assert.equal(inventoryFromStore(s,"requester").memberships.itemCount,1);
 executeAccountDeletion(s,planAccountDeletion(s,"requester").plan);
 assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM account_join_requests WHERE account_id='requester'").get().n,0);
 assert.throws(()=>s.accountJoinRequests.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),{code:"join_request_not_found"});
});

test("membership created or removed while pending prevents duplicate or resurrected admission",t=>{
 const {s,owner,token,binding,input}=setup(t),q=s.accountJoinRequests;q.request(token,binding,input);
 s.command(owner,"commons",{id:"membership-race",type:"member.added",data:{memberId:"racing-human",displayName:"Racing human",kind:"human",permissions:[]}});
 s.ensureHumanAccountBinding("commons","racing-human","requester","fixture-race");
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),{code:"membership_exists"});
 s.command(owner,"commons",{id:"remove-requester",type:"member.access_changed",data:{memberId:"racing-human",active:false,permissions:[],expectedMemberRevision:s.room("commons").state.members["racing-human"].revision}});
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),{code:"membership_exists"});
 assert.equal(s.room("commons").state.members["racing-human"].active,false);
 assert.equal(q.listOwn(token,binding).requests[0].status,"pending");
});

test("archiving a listed room after request blocks approval",t=>{
 const {s,owner,token,binding,input}=setup(t),q=s.accountJoinRequests;q.request(token,binding,input);
 s.command(owner,"commons",{id:"archive-pending",type:"room.archived",data:{reason:"Closed"}});
 assert.throws(()=>q.decide(owner,"commons",null,input.requestId,{decision:"approve",expectedRevision:0}),{code:"join_unavailable"});
 assert.equal(s.accountRooms(token,binding).rooms.length,0);
});

test("unavailable requests can be declined and keyset pagination reaches request101",t=>{
 const {s,owner,token,binding,input}=setup(t),q=s.accountJoinRequests;q.request(token,binding,input);
 const original=s.db.prepare("SELECT * FROM account_join_requests WHERE request_id=?").get(input.requestId);
 const insert=s.db.prepare("INSERT INTO account_join_requests(request_id,room_id,account_id,fingerprint,display_name,note,status,revision,created_at,expires_at) VALUES(?,?,?,?,?,?,'pending',0,?,?)");
 for(let i=0;i<100;i++)insert.run(`humanjoin-page-${String(i).padStart(3,"0")}`,"commons","requester",`fixture-${i}`,"Paged human","",original.created_at,original.expires_at);
 const first=q.list(owner,"commons",null);assert.equal(first.requests.length,100);assert.ok(first.nextCursor);
 const second=q.list(owner,"commons",null,{after:first.nextCursor});assert.equal(second.requests.length,1);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.requests,...second.requests].map(r=>r.requestId)).size,101);
 s.roomDirectory.set("commons","owner",false);assert.equal(q.listOwn(token,binding).requests[0].status,"unavailable");
 assert.equal(q.decide(owner,"commons",null,input.requestId,{decision:"deny",expectedRevision:0}).status,"denied");
 assert.throws(()=>q.list(owner,"commons",null,{after:"not-valid"}),{code:"invalid_join_cursor"});
});
