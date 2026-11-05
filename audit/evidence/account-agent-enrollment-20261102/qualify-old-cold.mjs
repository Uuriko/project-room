// Explicit local qualification; --old-root must be an original 2bf authority tree.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {RoomStore} from '../../../server/store.mjs';
import {seedAccountAgentEnrollment,enrollmentResource} from '../../../tests/helpers/account-agent-enrollment-source.mjs';
import {createAccountAgentEnrollment} from '../../../server/account-agent-enrollment.mjs';
import {auditRecovery} from '../../../server/recovery.mjs';
const oldRoot=resolve(process.argv[2]??''),base='2bf4cfb7d15265d6b6f690e0659a0c38a88ca25e';
for(const file of ['server/store.mjs','server/agent-connections.mjs','server/recovery.mjs'])assert.deepEqual(readFileSync(join(oldRoot,file)),execFileSync('git',['show',`${base}:${file}`]),'Original authority source required: '+file);
const directory=mkdtempSync(join(tmpdir(),'account-enroll-old-cold-')),filename=join(directory,'room.sqlite');let s=new RoomStore(filename);
try{
 const f=seedAccountAgentEnrollment(s),service=createAccountAgentEnrollment({store:s,resource:enrollmentResource,enabled:true});service.apply(f.slot.token,'target',f.request,f.binding);
 s.command(f.slot.token,'source',{id:'archive-source',type:'room.archived',data:{reason:'Synthetic cutover'}},f.binding);auditRecovery(s);s.close();s=null;
 const moduleUrl=pathToFileURL(join(oldRoot,'server/store.mjs')).href;
 const script=`import {RoomStore} from ${JSON.stringify(moduleUrl)};try{const s=new RoomStore(${JSON.stringify(filename)});s.close();process.exitCode=2;}catch(error){console.log(JSON.stringify({coldRefused:true,code:error.code,message:error.message}));if(error.code!=='connection_integrity_error')process.exitCode=3;}`;
 const raw=execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.match(raw,/"coldRefused":true/);console.log(raw.trim());
 s=new RoomStore(filename);auditRecovery(s);assert.equal(s.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='target'").get().n,1);
 console.log(JSON.stringify({newCold:true,newAudit:true,targetLinks:1,originalSource:base,oldOutputSha256:createHash('sha256').update(raw).digest('hex')}));
}finally{s?.close();rmSync(directory,{recursive:true,force:true});}
