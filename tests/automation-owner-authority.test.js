import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRule,setRuleEnabled,runAutomations,listRules} from '../server/event-automations.mjs';
import {createWork,claimWork} from '../server/work-claims.mjs';
for(const type of ['wake','open_task']) test(`automation ${type} fails closed for former owner and preserves rule`,()=>{
 const store=new RoomStore(':memory:');store.initialize(initialRoom());
 try{
 const {rule}=createRule(store.db,{roomId:'commons',name:'Synthetic',createdBy:'former-owner',trigger:{actions:['created']},action:type==='wake'?{type,member:'owner',brief:'Synthetic'}:{type,title:'Synthetic'}});
 setRuleEnabled(store.db,{roomId:'commons',ruleId:rule.ruleId,enabled:true});
 let wakes=0,events=0;const deps={createWork,claimWork,emitWorkClaimEvent:()=>{events++},enqueueClaimWake:()=>{wakes++;return{enqueued:true}}};
 const event={id:'evt',data:{action:'created'}},item={id:'source',tags:[]};
 const out=runAutomations(store,'commons',event,item,deps,{ROOM_AUTOMATIONS:'1'});
 assert.equal(out[0].result,'skipped:owner_changed');assert.equal(wakes,0);assert.equal(events,0);assert.equal(store.workClaims.list('commons').length,0);
 assert.equal(listRules(store.db,{roomId:'commons'}).length,1);assert.deepEqual(runAutomations(store,'commons',event,item,deps,{ROOM_AUTOMATIONS:'1'}),[]);
 }finally{store.close()}
});
