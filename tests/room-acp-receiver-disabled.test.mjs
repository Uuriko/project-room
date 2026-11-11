import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {main} from '../room-acp/src/cli.mjs';import {parseArgs} from '../room-acp/src/args.mjs';import {run} from '../room-acp/src/run.mjs';import {saveConnection} from '../room-acp/src/credentials.mjs';
function fixture(t){const home=mkdtempSync(join(tmpdir(),'receiver-disabled-'));t.after(()=>rmSync(home,{recursive:true,force:true}));const env={ROOM_ACP_HOME:home};saveConnection({apiBase:'https://example.test',roomId:'r',memberId:'existing',credential:'synthetic-private',hostId:'existing-host'},env);return{home,env};}
function snapshot(path){return readdirSync(path).sort().flatMap(name=>{const file=join(path,name),s=statSync(file);return s.isDirectory()?snapshot(file).map(x=>[name+'/'+x[0],...x.slice(1)]):[[name,readFileSync(file).toString('base64'),s.mode&0o777]];});}
test('disabled receiver exits0 before any connection update, adapter construction, network or receipt mutation',async t=>{
 const f=fixture(t);mkdirSync(join(f.home,'chat-turns'),{mode:0o700});
 for(const phase of ['queued','started','result','posted'])writeFileSync(join(f.home,'chat-turns',phase+'.json'),JSON.stringify({phase,requestId:'original-'+phase,body:'Retained exact synthetic draft'}),{mode:0o600});
 const before=snapshot(f.home),printed=[];let network=0,bridges=0;
 const result=await run({receiverPolicy:'disabled',permissionApprover:'none'},{env:f.env,print:x=>printed.push(x),candidate:{label:'must not start'},fetchImpl:async()=>{network++;throw Error('No HTTP allowed');},onBridge:()=>{bridges++;throw Error('No adapter or receiver allowed');}});
 assert.equal(result,0);assert.equal(network,0);assert.equal(bridges,0);assert.deepEqual(snapshot(f.home),before);
 assert.match(printed.join('\n'),/receiver disabled/i);assert.match(printed.join('\n'),/not accepted|no .*accepted/i);assert.doesNotMatch(printed.join('\n'),/listening|synthetic-private|Retained exact/);
});
test('actual CLI disabled mode neither reads invalid saved state nor probes an adapter or creates a missing home',async t=>{
 const f=fixture(t);writeFileSync(join(f.home,'r.json'),'not valid JSON',{mode:0o600});const before=snapshot(f.home),messages=[];
 assert.equal(await main(['run','--receiver-policy','disabled','--agent-cmd','must-not-be-executed'],{env:f.env,print:x=>messages.push(x),fetchImpl:async()=>{throw Error('No HTTP allowed');}}),0);assert.deepEqual(snapshot(f.home),before);
 const missing=join(f.home,'not-created');assert.equal(await main(['run','--receiver-policy','disabled'],{env:{ROOM_ACP_HOME:missing},print(){}}),0);assert.ok(!readdirSync(f.home).includes('not-created'));
});
test('disabled is explicit run-only local policy; read-only mode does not imply incapable or disabled',()=>{
 assert.equal(parseArgs(['run']).receiverPolicy,'respond');assert.equal(parseArgs(['run','--mode','read-only']).receiverPolicy,'respond');assert.equal(parseArgs(['run','--receiver-policy','disabled']).receiverPolicy,'disabled');
 for(const command of ['doctor','logout','import-identity','https://example.test/join/RM-SYNTHETIC'])assert.throws(()=>parseArgs([command,'--receiver-policy','disabled']),/only.*run/i);
 assert.throws(()=>parseArgs(['run','--receiver-policy','maybe']),/respond.*disabled/);
});
test('default response-enabled path still loads the same identity and constructs the existing formal-capable bridge',async t=>{
 const f=fixture(t),before=snapshot(f.home);let bridges=0;
 assert.equal(await run({},{env:f.env,print(){},candidate:{label:'synthetic adapter'},onBridge:bridge=>{bridges++;assert.equal(bridge.connection.memberId,'existing');bridge.run=async()=> 'stopped';}}),0);assert.equal(bridges,1);assert.deepEqual(snapshot(f.home),before);
});
test('direct run rejects invalid receiver policy before accessing any saved connection',async()=>{
 await assert.rejects(run({receiverPolicy:'unknown'},{env:{ROOM_ACP_HOME:'/does-not-exist'},print(){}}),/respond.*disabled/);
});
