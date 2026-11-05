import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {createAcceptanceFixture} from '../../../scripts/acceptance-fixture.mjs';
import {createHostedRoomMcp} from '../../../server/mcp-room-profile.mjs';
import {linkWithProof} from '../../../tests/helpers/link-with-proof.mjs';
import {RoomStore} from '../../../server/store.mjs';
import {seedPostOAuth,providerFor,resource} from '../../../tests/helpers/work-linked-post-oauth.mjs';
const call=(mcp,token,args)=>mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_room_context',arguments:{roomId:'commons',view:'handoff',...args}}},{authorization:`Bearer ${token}`});
test('actual hosted packet retains the callers owned claim',async t=>{
 const f=createAcceptanceFixture(); t.after(()=>{f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const identity=f.store.identities.create('Synthetic handoff reader');linkWithProof(f.store,f.keys.owner,'commons',identity,{memberId:'reader',displayName:'Reader',permissions:[]});
 f.store.workClaims.set('commons',{id:'owned',title:'Owned real claim',state:'claimed',owner:'reader',repo:'o/r',files:['src/a.js'],leaseExpiresAt:'2026-11-05T00:00:00.000Z',history:[]});
 const r=await call(createHostedRoomMcp(f.store),identity.secret);assert.ok(r.result&&!r.result.isError,JSON.stringify(r));
 const p=r.result.structuredContent;t.diagnostic(JSON.stringify({claims:p.claims}));
 assert.deepEqual(p.claims.yours.map(c=>c.id),['owned']);
 assert.equal(p.claims.yours[0].repository,'o/r');assert.deepEqual(p.claims.yours[0].paths,['src/a.js']);
});
test('normalized packet preserves source omissions after private reads and OAuth denial',async t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const saved=seedPostOAuth(s,{scopes:['rooms:read','chat:read','work:read']});
 s.command(saved.owner,'commons',{id:'private',type:'message.posted',data:{messageId:'private',toMemberId:'observer',body:'PRIVATE-HANDOFF-SENTINEL'}});
 s.room=()=>{throw Error('UNBOUNDED-HYDRATION');};
 const mcp=createHostedRoomMcp(s,{oauthProvider:providerFor(s),oauthResource:resource});
 const r=await call(mcp,saved.identitySecret);t.diagnostic(JSON.stringify(r));
 assert.ok(r.result && !r.result.isError,'normalized filtered reads are supported');
 assert.ok(!JSON.stringify(r).includes('PRIVATE-HANDOFF-SENTINEL'));assert.ok(!JSON.stringify(r).includes('UNBOUNDED-HYDRATION'));
 const oauth=await call(mcp,saved.token);assert.ok(oauth.error);assert.match(oauth.error.data.hint,/outside the connected agent grant/);assert.ok(!JSON.stringify(oauth).includes('PRIVATE-HANDOFF-SENTINEL'));
 assert.ok(r.result.structuredContent.omitted?.includes('board_claims'),'do not report omitted Board claims as complete empty claims');
});

test('since-join floor hides earlier decisions from actual handoff',async t=>{
 const f=createAcceptanceFixture();t.after(()=>{f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const send=(type,data)=>f.store.command(f.keys.owner,'commons',{id:crypto.randomUUID(),type,data});
 send('room.history_visibility_set',{historyVisibility:'since_join'});
 send('message.posted',{messageId:'before',body:'HIDDEN-OLD-DECISION'});
 send('decision.recorded',{sourceMessageId:'before',statement:'HIDDEN-OLD-DECISION'});
 const identity=f.store.identities.create('Late synthetic reader');linkWithProof(f.store,f.keys.owner,'commons',identity,{memberId:'late',displayName:'Late',permissions:[]});
 send('message.posted',{messageId:'after',body:'VISIBLE-NEW-DECISION'});
 send('decision.recorded',{sourceMessageId:'after',statement:'VISIBLE-NEW-DECISION'});
 const r=await call(createHostedRoomMcp(f.store),identity.secret);assert.ok(r.result&&!r.result.isError);
 assert.ok(!JSON.stringify(r).includes('HIDDEN-OLD-DECISION'));assert.ok(JSON.stringify(r).includes('VISIBLE-NEW-DECISION'));
});

test('flag-off refuses the handoff view through actual hosted dispatcher',{skip:process.env.ROOM_HANDOFF_PACKET!=='0'},async t=>{
 const f=createAcceptanceFixture();t.after(()=>{f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const identity=f.store.identities.create('Synthetic off reader');linkWithProof(f.store,f.keys.owner,'commons',identity,{memberId:'reader',displayName:'Reader',permissions:[]});
 const r=await call(createHostedRoomMcp(f.store),identity.secret);assert.ok(r.error||r.result?.isError);assert.ok(!JSON.stringify(r).includes('project-room/handoff-packet'));
});
