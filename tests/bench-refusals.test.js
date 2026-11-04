import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRefusalCounter, summarizeRefusals } from '../scripts/bench/refusals.mjs';
import { qualifiedSamples } from '../scripts/bench/validity.mjs';

test('refusal evidence retains only known codes/statuses and remains bounded', () => {
  const c = createRefusalCounter();
  c.record({ code: 'pilot_limit', status: 409, message: 'private-token', headers: { Authorization: 'private-token' } });
  c.record({ code: 'private-token', status: 'private-token', stack: 'private-token' });
  c.record({ get code() { throw new Error('private-token'); } });
  assert.deepEqual(c.snapshot(), [{ code: 'pilot_limit', status: 409, count: 1 }, { code: 'unknown', status: null, count: 2 }]);
  for (const code of ['pilot_limit','rate_limited','conflict','SQLITE_BUSY']) for (const status of [400,401,403,404,409,410,413,422,429,500,502,503,504]) c.record({ code, status });
  assert.ok(c.snapshot().length <= 33); assert.equal(c.snapshot().reduce((n, r) => n + r.count, 0), 55);
  assert.equal(JSON.stringify(c.snapshot()).includes('private-token'), false);
  const changing = createRefusalCounter(); let reads = 0;
  changing.record({ get code() { return reads++ ? 'private-token' : 'pilot_limit'; }, status: 409 });
  assert.equal(reads, 1); assert.equal(JSON.stringify(changing.snapshot()).includes('private-token'), false);
});
test('arm summaries keep old uncategorized failures and leave score qualification unchanged', () => {
  const samples = [{writeFailures:2,writeRefusals:[{code:'pilot_limit',status:409,count:2}],writeP50Ms:1,coldRoomMs:4}, {writeFailures:1,writeP50Ms:2,coldRoomMs:5}];
  assert.deepEqual(summarizeRefusals(samples), [{code:'pilot_limit',status:409,count:2},{code:'unknown',status:null,count:1}]);
  assert.ok(qualifiedSamples(samples,'writeP50Ms',r=>r.writeP50Ms).every(Number.isNaN));
  assert.deepEqual(qualifiedSamples(samples,'coldRoomMs',r=>r.coldRoomMs),[4,5]);
});
test('actual benchmark child captures injected typed refusals without exception contents', {timeout:30000}, () => {
  const dir=mkdtempSync(join(tmpdir(),'bench-refusal-'));
  const json = stdout => JSON.parse(stdout.trim().split('\n').at(-1));
  try {
    const options={encoding:'utf8',stdio:['ignore','pipe','pipe']};
    execFileSync(process.execPath,['scripts/bench/fixture.mjs','--root','.','--size','20','--out',dir],options);
    const hook=join(dir,'inject.mjs');
    writeFileSync(hook,`import {RoomStore} from ${JSON.stringify(pathToFileURL(resolve('server/store.mjs')).href)};\nconst original=RoomStore.prototype.command;\nRoomStore.prototype.command=function(...args){if(/^bench-[0-2]$/.test(args[2]?.id)){throw Object.assign(new Error('private-refusal-message'),{code:'pilot_limit',status:409,headers:{Authorization:'private-refusal-token'}});}return original.apply(this,args);};\n`);
    const output=execFileSync(process.execPath,['--import',hook,'scripts/bench/room-scale.mjs','--root','.','--fixture',dir,'--writes','4'],options);
    const result=json(output); assert.equal(result.writeFailures,3); assert.equal(result.writeSuccesses,1);
    assert.deepEqual(result.writeRefusals,[{code:'pilot_limit',status:409,count:3}]);
    assert.ok(Number.isFinite(result.coldRoomMs)); assert.doesNotMatch(output,/private-refusal/);
    assert.deepEqual(summarizeRefusals([result,result]),[{code:'pilot_limit',status:409,count:6}]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
