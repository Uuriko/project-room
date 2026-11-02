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
