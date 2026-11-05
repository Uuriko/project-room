import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createWork,claimWork,appendWorkPullRequest,claimHistoryLength} from '../server/work-claims.mjs';
import {syncClaimPullRequests,staleSweepDueAt,sweepStaleUnclaimedClaims} from '../server/claim-pr-sync.mjs';

for (const native of [false,true]) test(`archived ${native?'native':'legacy'} registry is frozen before projection access`,()=>{
 const store=new RoomStore(':memory:');
 try {
  store.initialize(initialRoom(),native?{representation:'normalized-current-v1'}:{});
  const closed={...createWork({id:'old'},{agentId:'owner'}),state:'closed'};
  store.workClaims.set('commons',closed);
  store.workClaims.configure('commons',{staleSweep:true});
  const key=store.issueAccessKey('commons','owner');
  const cmd={id:'archive-once',type:'room.archived',data:{}};
  const receipt=store.command(key,'commons',cmd);
  const before=JSON.stringify(store.workClaims.get('commons','old'));
  store.room=()=>{throw Error('must not hydrate projection');};
  for(const change of [()=>store.workClaims.set('commons',{...closed,title:'changed'}),()=>store.workClaims.delete('commons','old'),()=>store.workClaims.configure('commons',{staleSweep:false})])assert.throws(change,{code:'room_archived'});
  assert.equal(JSON.stringify(store.workClaims.get('commons','old')),before);
  assert.equal(store.workClaims.rawConfig('commons').staleSweep,true);
  // Exact committed retries retain their original receipt despite retirement.
  if(native)assert.equal(store.command(key,'commons',cmd).sequence,receipt.sequence);
 } finally {store.close();}
});

test('scheduler excludes archived PR and sweep candidates; active room still settles',async()=>{
 const store=new RoomStore(':memory:');
 try {
  store.initialize(initialRoom());
  const other=initialRoom().map(e=>({...e,roomId:'active',data:e.type==='room.created'?{...e.data,roomId:'active'}:e.data}));
  store.initialize(other);
  const now=Date.now();
  for(const roomId of ['commons','active']){
   let item=claimWork(createWork({id:'pr'},{now,agentId:'owner'}),'owner',{now,leaseHours:null});
   item=appendWorkPullRequest(item,'owner',{pullRequest:'https://github.com/Uuriko/project-room/pull/1600',expectedClaimedAt:item.claimedAt,expectedHistoryLength:claimHistoryLength(item),now});
   store.workClaims.set(roomId,item);
  }
  store.workClaims.set('commons',createWork({id:'stale'},{now:0,agentId:'owner'}));
  store.workClaims.configure('commons',{staleSweep:true});
  store.command(store.issueAccessKey('commons','owner'),'commons',{id:'archive',type:'room.archived',data:{}});
  assert.equal(staleSweepDueAt(store,now),null);
  assert.equal(sweepStaleUnclaimedClaims(store,now,{force:true}),0);
  // Real archived room reads are forbidden in this reproduction: selection
  // must retire it before fetching/hydrating the registry's event context.
  const room=store.room.bind(store);store.room=id=>{assert.notEqual(id,'commons');return room(id);};
  const out=await syncClaimPullRequests(store,{nowMs:now,token:'synthetic',fetchImpl:async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({state:'closed',merged:true,head:{sha:'a'.repeat(40)},merge_commit_sha:'b'.repeat(40)})})});
  assert.equal(out.checked,1);
  assert.equal(store.workClaims.get('commons','pr').state,'claimed');
  assert.equal(store.workClaims.get('active','pr').state,'done');
 } finally {store.close();}
});
