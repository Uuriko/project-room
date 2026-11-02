import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
function setup(t,{filename=':memory:'}={}){
 const s=new RoomStore(filename);t.after(()=>{try{s.close();}catch{}});
 s.initialize(initialRoom('commons','owner'));s.initialize(initialRoom('friend-home','friend'));
 const owner=s.issueAccessKey('commons','owner'),friend=s.issueAccessKey('friend-home','friend'),peer=s.identities.create('Friend existing agent');
 linkWithProof(s,friend,'friend-home',peer,{permissions:['accept_work','complete_work'],memberId:peer.identityId});
 const account=(room,id)=>s.db.prepare('SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?').get(room,id).account_id;
 assert.notEqual(account('commons','owner'),account('friend-home','friend'));
 return{s,owner,friend,peer,invite:()=>s.invites.create(owner,'commons',{profile:'contribute',displayName:'Friend existing agent'})};
}
const counts=s=>Object.fromEntries(['agent_identities','identity_links','events','agent_invite_redeem_receipts','operator_actions'].map(table=>[table,s.db.prepare('SELECT count(*) n FROM '+table).get().n]));
test('code plus request ID cannot take over an existing friend identity across rooms',t=>{
 const{s,peer,invite}=setup(t),issued=invite(),requestId='existing-friend-retry';
 const joined=s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId});assert.equal(joined.identityId,peer.identityId);
 const before=counts(s),secretHash=s.db.prepare('SELECT secret_hash FROM agent_identities WHERE identity_id=?').get(peer.identityId).secret_hash;
 assert.throws(()=>s.invites.redeem(issued.code,{displayName:'Friend existing agent',requestId}),e=>e.status===401&&e.code==='invite_replay_identity_required');
 assert.deepEqual(counts(s),before);assert.equal(s.db.prepare('SELECT secret_hash FROM agent_identities WHERE identity_id=?').get(peer.identityId).secret_hash,secretHash);
 assert.equal(s.authenticate(peer.secret,'friend-home').member.id,peer.identityId);
 const replay=s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId});assert.equal(replay.duplicate,true);assert.equal(replay.identitySecret,undefined);assert.equal(replay.mcpToken,null);assert.deepEqual(counts(s),before);
});
test('new identity lost-response recovery remains bound to its exact mint and returns no second room token',t=>{
 const{s,invite}=setup(t),issued=invite(),requestId='new-identity-lost-response';
 const first=s.invites.redeem(issued.code,{displayName:'New lost response agent',requestId}),before=counts(s);
 const retry=s.invites.redeem(issued.code,{displayName:'New lost response agent',requestId});
 assert.equal(retry.identityId,first.identityId);assert.equal(retry.memberId,first.memberId);assert.equal(retry.duplicate,true);assert.equal(retry.mcpToken,null);
 assert.equal(Boolean(s.identities.resolveGlobalIdentitySecret(first.identitySecret)),false);assert.equal(s.identities.resolveGlobalIdentitySecret(retry.identitySecret).identityId,first.identityId);assert.deepEqual(counts(s),before);
 const row=s.db.prepare("SELECT counts_json FROM operator_actions WHERE action='agent_invite_redemption_identity'").get();assert.equal(JSON.parse(row.counts_json).identityMinted,true);
 for(const value of [issued.code,first.identitySecret,retry.identitySecret])assert.equal(row.counts_json.includes(value),false);
 assert.throws(()=>s.db.prepare("UPDATE operator_actions SET result='reused' WHERE action='agent_invite_redemption_identity'").run(),/append-only/);
 assert.throws(()=>s.db.prepare("DELETE FROM operator_actions WHERE action='agent_invite_redemption_identity'").run(),/append-only/);
});
test('old ambiguous redemption receipt fails closed without provenance or timestamp guesses',t=>{
 const{s,peer,invite}=setup(t),issued=invite(),first=s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret});
 const row=s.db.prepare('SELECT * FROM agent_invite_codes WHERE redeemed_identity_id=?').get(peer.identityId),requestId='legacy-ambiguous-retry';
 // Historical receipt shape predating the security basis. No immutable
 // audit trigger is removed or weakened to manufacture this control.
 s.db.prepare('INSERT INTO agent_invite_redeem_receipts VALUES(?,?,?,?,?,?,?,?)').run(requestId,row.code_hash,peer.identityId,'commons',first.memberId,'Friend existing agent',row.permissions_json,row.redeemed_at);
 const before=counts(s);assert.throws(()=>s.invites.redeem(issued.code,{displayName:'Friend existing agent',requestId}),e=>e.code==='invite_replay_identity_required');assert.deepEqual(counts(s),before);
 assert.equal(s.invites.redeem(issued.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId}).duplicate,true);
 assert.equal(s.authenticate(peer.secret,'friend-home').member.id,peer.identityId);
});
for(const existing of [false,true])test(`identity basis save fault rolls back ${existing?'existing-agent admission':'new identity mint'} with code and journal`,t=>{
 const{s,peer,invite}=setup(t),issued=invite(),options={displayName:existing?'Friend existing agent':'New interrupted identity',requestId:'save-fault-'+existing,...(existing?{identitySecret:peer.secret}:{})},before=counts(s),prepare=s.db.prepare.bind(s.db);let fired=false;
 s.db.prepare=sql=>new Proxy(prepare(sql),{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const result=fn.apply(target,args);if(sql.includes('INSERT INTO operator_actions')&&args[2]==='agent_invite_redemption_identity'){fired=true;throw Error('synthetic identity basis save interrupted');}return result;};}});
 assert.throws(()=>s.invites.redeem(issued.code,options),/synthetic identity basis save interrupted/);s.db.prepare=prepare;assert.equal(fired,true);assert.deepEqual(counts(s),before);
 assert.equal(s.db.prepare('SELECT redeemed_at FROM agent_invite_codes').get().redeemed_at,null);assert.equal(s.authenticate(peer.secret,'friend-home').member.id,peer.identityId);
 const joined=s.invites.redeem(issued.code,options);assert.equal(joined.duplicate===true,false);
 assert.equal(JSON.parse(s.db.prepare("SELECT counts_json FROM operator_actions WHERE action='agent_invite_redemption_identity'").get().counts_json).identityMinted,!existing);
});
test('cold reopen preserves existing holder boundary and newly minted lost-response recovery',t=>{
 const dir=mkdtempSync(join(tmpdir(),'invite-identity-basis-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const filename=join(dir,'room.sqlite'),{s,peer,invite}=setup(t,{filename}),existing=invite(),fresh=invite();
 s.invites.redeem(existing.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'cold-existing'});
 const created=s.invites.redeem(fresh.code,{displayName:'New cold identity',requestId:'cold-new'});s.close();
 const cold=new RoomStore(filename);t.after(()=>cold.close());
 assert.throws(()=>cold.invites.redeem(existing.code,{displayName:'Friend existing agent',requestId:'cold-existing'}),e=>e.code==='invite_replay_identity_required');
 assert.equal(cold.invites.redeem(existing.code,{displayName:'Friend existing agent',identitySecret:peer.secret,requestId:'cold-existing'}).duplicate,true);
 assert.equal(cold.authenticate(peer.secret,'friend-home').member.id,peer.identityId);
 const replay=cold.invites.redeem(fresh.code,{displayName:'New cold identity',requestId:'cold-new'});assert.equal(replay.identityId,created.identityId);assert.equal(replay.mcpToken,null);assert.equal(cold.identities.resolveGlobalIdentitySecret(replay.identitySecret).identityId,created.identityId);
});
test('an identity minted by a different invitation is still existing under a second owner',t=>{
 const{s,friend,invite}=setup(t),firstInvite=invite(),first=s.invites.redeem(firstInvite.code,{displayName:'Previously minted peer',requestId:'original-mint'});
 const second=s.invites.create(friend,'friend-home',{profile:'contribute'});
 s.invites.redeem(second.code,{displayName:'Previously minted peer',identitySecret:first.identitySecret,requestId:'other-owner-reuse'});
 assert.throws(()=>s.invites.redeem(second.code,{displayName:'Previously minted peer',requestId:'other-owner-reuse'}),e=>e.code==='invite_replay_identity_required');
 assert.equal(s.identities.resolveGlobalIdentitySecret(first.identitySecret).identityId,first.identityId);
 assert.equal(s.invites.redeem(second.code,{displayName:'Previously minted peer',identitySecret:first.identitySecret,requestId:'other-owner-reuse'}).duplicate,true);
});
import {agentErrorAx} from '../src/agent-error.mjs';
test('recovery guidance requires the existing holder credential instead of changing identity',()=>{
 const recovery=agentErrorAx({httpStatus:401,code:'invite_replay_identity_required'});
 assert.equal(recovery.reason,'invite_replay_identity_required');assert.equal(recovery.status,'action_required');assert.match(recovery.hint,/saved identity secret/);assert.match(JSON.stringify(recovery.next),/Do not rotate or mint a replacement identity/);
});
