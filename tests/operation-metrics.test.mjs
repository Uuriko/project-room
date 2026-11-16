import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperationMetrics} from '../client/operation-metrics.mjs';
test('opt-in operation metrics retain failures without content or identifiers', () => {
  assert.equal(createOperationMetrics().record('read_work',{ms:1,responseBytes:1,ok:true}),false);
  const recorder=createOperationMetrics({enabled:true});
  for(let i=1;i<=20;i++) recorder.record('read_work',{ms:i,responseBytes:10,ok:i!==20,body:'PRIVATE',roomId:'PRIVATE',url:'PRIVATE'});
  const view=recorder.snapshot();
  assert.deepEqual(view.operations.read_work,{n:20,failures:1,p50:10,p95:19,responseBytes:200});
  assert.equal(JSON.stringify(view).includes('PRIVATE'),false);
  assert.equal(recorder.record('PRIVATE',{ms:1,responseBytes:1,ok:true}),false);
  assert.equal(recorder.record('read_work',{ms:NaN,responseBytes:1,ok:true}),false);
  view.records[0].ms=999;assert.equal(recorder.snapshot().records[0].ms,1);
});
test('operation sample storage remains bounded and reports dropped records',()=>{
 const recorder=createOperationMetrics({enabled:true});
 for(let i=0;i<4010;i++) recorder.record('read_work',{ms:i,responseBytes:0,ok:true});
 const view=recorder.snapshot();assert.equal(view.records.length,4000);assert.equal(view.dropped,10);assert.equal(view.records[0].ms,10);
});
