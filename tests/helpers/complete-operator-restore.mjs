import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {operatorRestoreResponse} from '../../server/restore-ndjson.mjs';
import {restoreProgress} from '../../server/restore-admission.mjs';
// Follow the actual protocol through publication AND maintenance. Return the
// immutable publication response, not a fabricated merger of later receipts.
export async function completeOperatorRestore(initial,token,store,{onStep,maxSteps=100000}={}){
 let response=initial,publication=null;
 for(let step=0;step<maxSteps;step++){
  if(![200,202].includes(response.status))return response;
  const value=await response.clone().json();let input;
  if(value.pending===true){assert.equal(response.status,202);assert.equal(value.verified,false);input={restoreId:value.restoreId,sourceSeal:value.sourceSeal,expectedRevision:value.revision,requestId:randomUUID()};}
  else{
   assert.equal(value.verified,true);publication??=response.clone();
   if(value.cleanupComplete===false){assert.equal(value.nextCleanup?.method,'POST');assert.equal(value.nextCleanup.path,'/api/operator/restore');input=value.nextCleanup.body;}
   else{if(value.cleanupComplete===true){assert.equal(value.cleanup.remaining,0);assert.equal(value.cleanup.verifiedGuardCount,0);assert.equal(value.cleanup.scratchRemaining??0,0);assert.equal(value.nextCleanup,null);}assert.equal(restoreProgress(store.db).state,'clear');assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'restore_frozen_*'").get().n,0);return publication;}
  }
  await onStep?.({step,value,input,store});
  response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input)}),token,store);
 }
 assert.fail('restore did not complete within the explicit test continuation bound');
}
