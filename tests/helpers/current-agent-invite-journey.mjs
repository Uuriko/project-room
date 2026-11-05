import {initialRoom} from '../../server/bootstrap.mjs';
import {linkWithProof} from './link-with-proof.mjs';
export function createLegacyInviteJourney(store,{reactivate=false,demoteIssuer=false,historyVisibility=null,transferOwner=false}={}) {
 store.initialize(initialRoom('commons','owner'));store.initialize(initialRoom('friend-home','friend'));
 const owner=store.issueAccessKey('commons','owner'),friend=store.issueAccessKey('friend-home','friend');
 store.command(owner,'commons',{id:'existing-reviewer',type:'member.added',data:{memberId:'reviewer',displayName:'Existing reviewer',kind:'agent',permissions:['verify']}});
 const inviter=store.identities.create('Inviting agent'),peer=store.identities.create('Friend existing agent');
 linkWithProof(store,owner,'commons',inviter,{permissions:['invite_member'],memberId:inviter.identityId});
 linkWithProof(store,friend,'friend-home',peer,{permissions:['accept_work','complete_work'],memberId:peer.identityId});
 if(reactivate){linkWithProof(store,owner,'commons',peer,{permissions:['accept_work','complete_work'],memberId:peer.identityId});store.command(owner,'commons',{id:'remove-peer',type:'member.access_changed',data:{memberId:peer.identityId,expectedMemberRevision:0,permissions:[],active:false}});}
 const issued=store.invites.create(inviter.secret,'commons',{profile:'contribute',displayName:'Friend existing agent'});
 if(demoteIssuer)store.command(owner,'commons',{id:'demote-issuer',type:'member.access_changed',data:{memberId:inviter.identityId,expectedMemberRevision:0,permissions:[],active:true}});
 if(transferOwner){store.command(owner,'commons',{id:'add-heir',type:'member.added',data:{memberId:'heir',displayName:'New human owner',kind:'human',permissions:[]}});store.command(owner,'commons',{id:'transfer-owner',type:'ownership.transferred',data:{toMemberId:'heir',reason:'Project continuity'}});}
 if(historyVisibility)store.command(owner,'commons',{id:'history-policy',type:'room.history_visibility_set',data:{historyVisibility}});
 const rooms=['commons','friend-home'].map(roomId=>store.db.prepare('SELECT body FROM events WHERE room_id=? ORDER BY sequence').all(roomId).map(row=>JSON.parse(row.body)));
 const tables=Object.fromEntries(['accounts','member_accounts','agent_identities','identity_links','agent_invite_codes'].map(table=>[table,store.db.prepare('SELECT * FROM '+table).all()]));
 return{rooms,tables,inviter,peer,issued};
}
export function initializeCurrentInviteJourney(store,snapshot) {
 for(const events of snapshot.rooms)store.initialize(events,{representation:'normalized-current-v1'});
 // A disposable normalized snapshot of actual legacy holder-proof linking;
 // this is not a claim that the migration engine was requalified here.
 for(const [table,rows]of Object.entries(snapshot.tables))for(const row of rows){const columns=Object.keys(row);store.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>row[key]));}
 const ownerKey=store.issueAccessKey('commons','owner'),friendKey=store.issueAccessKey('friend-home','friend'),reviewerKey=store.issueAccessKey('commons','reviewer');
 return{...snapshot,ownerKey,friendKey,reviewerKey};
}
