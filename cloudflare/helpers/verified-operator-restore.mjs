import assert from 'node:assert/strict';
// Test-only driver of the existing authorized continuation route. A 202 is
// never success. Stop at verified publication; optional guard cleanup is separate.
export async function verifiedOperatorRestore(initial,post) {
 let response=initial,body=await response.json(),steps=0;
 assert.equal(response.status,202,JSON.stringify(body));assert.equal(body.pending,true);assert.equal(body.verified,false);
 const binding={restoreId:body.restoreId,sourceSeal:body.sourceSeal},seen=new Set(),deadline=Date.now()+90000;
 assert.match(binding.restoreId,/^restore_/);assert.match(binding.sourceSeal,/^[a-f0-9]{64}$/);
 while(body.pending){
  assert.ok(Date.now()<deadline,'restore continuation exceeded this small fixture deadline');
  assert.equal(response.status,202,JSON.stringify(body));assert.equal(body.verified,false);
  assert.deepEqual({restoreId:body.restoreId,sourceSeal:body.sourceSeal},binding);
  assert.ok(Number.isSafeInteger(body.revision)&&body.revision>0);
  const progress=JSON.stringify({phase:body.phase,progress:body.progress,auditProgress:body.auditProgress});
  assert.equal(seen.has(progress),false,'restore must advance actual public phase/cursor progress');seen.add(progress);
  const revision=body.revision;
  const input={...binding,expectedRevision:revision,requestId:'fixture-restore-'+steps++};
  response=await post(input);body=await response.json();
  if(steps===1){const retry=await post(input);assert.equal(retry.status,response.status);assert.deepEqual(await retry.json(),body,'exact retry replays the durable latest response');}
  if(body.pending)assert.equal(body.revision,revision+1,'one durable revision per accepted step');
 }
 assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.ok,true);assert.equal(body.verified,true);assert.equal(body.pending,false);
 return {response,body,steps};
}
