import test from 'node:test';
import assert from 'node:assert/strict';
import {claimOverlaps} from '../src/events.js';
import {prepareClaimOverlap,matchClaimOverlap} from '../src/claim-overlap.js';
import {recoveryReplayOrderKey} from '../server/recovery-replay-order.mjs';
import {bindCurrentRecordContext} from '../src/current-record-context.js';
const at='2026-11-01T00:00:00.000Z',claim=(id,paths=['./src/**'],other={})=>({id,claim:{holderId:'owner',repository:' Mixed/Repo ',status:'active',expiresAt:'2099-01-01',paths,...other}});
test('shared overlap predicate preserves exact path grammar, repository, lease and first10/16 warning semantics',()=>{
 const items={};for(const id of ['z','4294967295','20','2','01','4294967294',...Array.from({length:15},(_,n)=>'work-'+n)])items[id]=claim(id,Array.from({length:20},(_,n)=>'src/file'+n));
 items.expired=claim('expired',['src/**'],{expiresAt:at});items.released=claim('released',['src/**'],{status:'released'});items.other=claim('other',['src/**'],{repository:'different/repo'});
 const expected=['2','20','4294967294','z','4294967295','01','work-0','work-1','work-2','work-3'];
 const full=claimOverlaps({workItems:items},'target','mixed/repo',['src/**'],at);assert.deepEqual(full.map(item=>item.workItemId),expected);assert.ok(full.every(item=>item.paths.length===16));
 const keys=Object.keys(items),ordered=keys.map((key,ordinal)=>({key,order:recoveryReplayOrderKey(key,ordinal)})).sort((a,b)=>a.order.localeCompare(b.order));assert.deepEqual(ordered.map(item=>item.key),Object.keys(items));
 const query=prepareClaimOverlap('target','mixed/repo',['./src/file3'],at);assert.deepEqual(matchClaimOverlap(query,claim('subtree')), {workItemId:'subtree',holderId:'owner',paths:['./src/**']});for(const key of ['expired','released','other'])assert.equal(matchClaimOverlap(query,items[key]),null);assert.equal(matchClaimOverlap(query,claim('target')),null);assert.equal(matchClaimOverlap(query,claim('near',['src/file30'])),null);
});
test('scoped claim dependency is internal and rejects malformed warning values',()=>{
 const state={workItems:{}},expected=[{workItemId:'work',holderId:'owner',paths:['src/**']}];let called=false;bindCurrentRecordContext(state,{replyRequestCount:0,claimOverlaps:(id,repo,paths,when)=>{called=true;assert.deepEqual([id,repo,paths,when],['target','repo',['src/file'],at]);return expected;}});assert.equal(claimOverlaps(state,'target','repo',['src/file'],at),expected);assert.equal(called,true);assert.equal(JSON.stringify(state),'{"workItems":{}}');bindCurrentRecordContext(state,{replyRequestCount:0,claimOverlaps:()=>Array(11).fill(expected[0])});assert.throws(()=>claimOverlaps(state,'target','repo',[],at),/Invalid scoped claim/);assert.throws(()=>bindCurrentRecordContext(state,{replyRequestCount:0,claimOverlaps:[]}));
});

test('ordered scratch sees pending and persisted heads, excludes parts, expires and rolls back',async t=>{
 const {RoomStore}=await import('../server/store.mjs'),{beginRestore,withRestoreTransaction,withRestoreAuditRows,checkpointRestore}=await import('../server/restore-admission.mjs'),store=new RoomStore(':memory:');t.after(()=>store.close());const id=beginRestore(store);
 withRestoreTransaction(store,()=>checkpointRestore(store.db,{restoreId:id,expectedRevision:0,phase:'audit_pending',seal:{syntheticScratchTest:true},progress:{},latest:null}));
 let retained;withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,id,scratch=>{retained=scratch;scratch.set('replay','r','workOrder','1:0000000000000000','z');scratch.set('replay','r','workOrder','0:0000000002','2');scratch.set('replay','r','other','0:0000000000','excluded');scratch.set('replay','r','workOrder','0:0000000000','part-only',1);assert.equal(scratch.nextKey('replay','r','workOrder',''),'0:0000000002');assert.equal(scratch.nextKey('replay','r','workOrder','0:0000000002'),'1:0000000000000000');}));
 assert.throws(()=>retained.nextKey('replay','r','workOrder',''),/scope expired/);
 withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,id,scratch=>{assert.equal(scratch.nextKey('replay','r','workOrder',''),'0:0000000002');scratch.set('replay','r','workOrder','0:0000000001','1');assert.equal(scratch.nextKey('replay','r','workOrder',''),'0:0000000001');}));
 assert.throws(()=>withRestoreTransaction(store,()=>{withRestoreAuditRows(store.db,id,scratch=>scratch.set('replay','r','workOrder','0:0000000000','0'));throw Error('synthetic rollback');}),/synthetic rollback/);
 withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,id,scratch=>assert.equal(scratch.nextKey('replay','r','workOrder',''),'0:0000000001')));
});
