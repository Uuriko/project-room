import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RoomStore } from '../server/store.mjs';
import { seedLegacyFixture } from './helpers/legacy-session-fixture.mjs';
import { repairLegacySessionBackfill } from '../server/operator-legacy-session-repair.mjs';

test('strict-default plans and persisted old receipt fingerprints remain exact across opt-in addition',async t=>{
  const s=new RoomStore(':memory:');t.after(()=>s.close());const f=seedLegacyFixture(s);
  const repository=fileURLToPath(new URL('../',import.meta.url));
  const oldSource=execFileSync('git',['show','86bbb53547dd37e1ee43df9207fefe149929b40c:server/operator-legacy-session-repair.mjs'],{cwd:repository,encoding:'utf8'});
  const base=new URL('../server/operator-legacy-session-repair.mjs',import.meta.url);
  const connected=oldSource.replace(/from\s+(['"])(\.[^'"]+)\1/g,(_all,_quote,path)=>'from '+JSON.stringify(new URL(path,base).href));
  const original=await import('data:text/javascript;base64,'+Buffer.from(connected).toString('base64'));
  const before=original.repairLegacySessionBackfill(s,f.request),after=repairLegacySessionBackfill(s,f.request);
  assert.deepEqual(after,before,'no optional mode means identical plan hash, output and admission');
  const request={...f.request,planHash:before.planHash,requestId:'prior-strict-receipt'};
  const receipt=original.repairLegacySessionBackfill(s,request,true);
  assert.deepEqual(repairLegacySessionBackfill(s,request,true),{...receipt,duplicate:true},'old saved fingerprint is recognized without minting new evidence');
  assert.equal(receipt.replayContract,undefined,'old receipts do not gain invented prefix evidence on retry');
});
