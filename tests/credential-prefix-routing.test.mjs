import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {createAgentApiKeys} from '../server/agent-api-keys.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
// A possible opaque 32-byte base64url credential, not a typed OAuth/API token.
const colliding=prefix=>{const token=prefix+'A'.repeat(39);assert.equal(Buffer.from(token,'base64url').toString('base64url'),token);return token;};
const denied=error=>error.status===401&&error.code==='unauthenticated';
function fixture(t){let clock=1800000000000;const store=new RoomStore(':memory:',{now:()=>clock});t.after(()=>store.close());store.initialize(initialRoom());const key=store.issueAccessKey('commons','owner');return{store,key,advance:()=>{clock+=8*86400000;}};}
function replaceHash(store,table,oldToken,newToken){store.transaction(()=>store.db.prepare(`UPDATE ${table} SET hash=? WHERE hash=?`).run(hash(newToken),hash(oldToken)));}
for(const prefix of ['oat_','iat_','rak_']){
 test('issued opaque access credential retains room, expiry and revocation checks despite '+prefix+' prefix',t=>{
  const {store,key,advance}=fixture(t),token=colliding(prefix);assert.equal(token.length,43);
  replaceHash(store,'credentials',key,token);
  const auth=store.authenticate(token,'commons');assert.equal(auth.kind,'access');assert.equal(auth.member.id,'owner');assert.ok(auth.account);
  store.command(token,'commons',{id:'collision-post',type:'message.posted',data:{messageId:'collision-post',body:'Synthetic issued credential still works'}});
  assert.throws(()=>store.authenticate(token,'another-room'),e=>e.status===403);
  store.transaction(()=>store.db.prepare('UPDATE credentials SET revoked=1 WHERE hash=?').run(hash(token)));
  assert.throws(()=>store.authenticate(token,'commons'),denied);
  store.transaction(()=>store.db.prepare('UPDATE credentials SET revoked=0 WHERE hash=?').run(hash(token)));advance();
  assert.throws(()=>store.authenticate(token,'commons'),denied);
 });
 test('issued opaque session retains binding and parent revocation despite '+prefix+' prefix',t=>{
  const {store,key}=fixture(t),session=store.createSession(key),token=colliding(prefix);
  replaceHash(store,'credentials',session.token,token);
  const auth=store.authenticate(token,'commons');assert.equal(auth.kind,'session');assert.ok(auth.sessionBinding);assert.ok(auth.csrf);
  assert.equal(store.authenticate(token,'commons',auth.sessionBinding).member.id,'owner');
  assert.throws(()=>store.authenticate(token,'commons','stale-binding'),e=>e.status===409&&e.code==='session_binding_changed');
  store.transaction(()=>store.db.prepare('UPDATE credentials SET revoked=1 WHERE hash=?').run(hash(key)));
  assert.throws(()=>store.authenticate(token,'commons'),denied);
 });
 test('issued account slot keeps account binding and account-session opt-out despite '+prefix+' prefix',t=>{
  const {store,key}=fixture(t),account=store.authenticate(key,'commons').account,slot=store.createAccountSessionSlot();
  store.loginAccountSessionWithMethod(slot.token,account.id,0,{method:{kind:'fixture'}});const token=colliding(prefix);
  replaceHash(store,'account_session_slots',slot.token,token);
  const auth=store.authenticate(token,'commons');assert.equal(auth.account.id,account.id);assert.equal(auth.member.id,'owner');
  assert.throws(()=>store.authenticate(token,'commons',null,{allowAccountSession:false}),denied);
  store.transaction(()=>store.db.prepare('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?').run(account.id));
  assert.throws(()=>store.authenticate(token,'commons'),denied);
 });
 test('unissued '+prefix+' lookalikes never gain legacy access',t=>{
  const {store}=fixture(t);assert.throws(()=>store.authenticate(colliding(prefix),'commons'),denied);
  assert.throws(()=>store.authenticate(prefix+'b'.repeat(43),'commons'),denied);
 });
}

test('a valid typed API credential of opaque-key length retains agent scope and revocation',t=>{
 const {store}=fixture(t),identity=store.identities.create('Synthetic short API identity');
 const {roomId}=new AgentRooms(store).create(identity.secret,{roomId:'short-api',title:'Synthetic',purpose:'Token routing control',kind:'personal',displayName:'Synthetic API agent'});
 store.agentPlugin.apiKeys=createAgentApiKeys({store:store.agentPlugin.keys,clock:()=>store.now(),random:()=> 'A'.repeat(39)});
 const issued=store.agentPlugin.issueApiKey({identityId:identity.identityId,scopes:['rooms:read','mcp:room:'+roomId]}),token='rak_'+issued.secret;
 assert.equal(token.length,43);
 const auth=store.authenticate(token,roomId);assert.equal(auth.kind,'api-key');assert.equal(auth.identityId,identity.identityId);assert.equal(auth.account,null);
 assert.throws(()=>store.authenticate(token,'commons'),e=>e.status===403);
 assert.throws(()=>store.createSession(token),e=>e.status===403);
 store.agentPlugin.revokeApiKey({identityId:identity.identityId,keyId:issued.keyId});assert.throws(()=>store.authenticate(token,roomId),denied);
});
