import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {saveAgentConnection} from '../client/agent-connection.mjs';
import {readCodexHostStatus} from '../client/codex-host-status.mjs';
const cli=realpathSync('scripts/run-codex-room.mjs');
function setup(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'room-launch-failure-'))),home=join(root,'profile'),cwd=join(root,'workspace'),command=join(root,'fake-codex.cjs'),marker=join(root,'runtime-started'),config=join(root,'runtime.json'),journal=join(root,'journal.sqlite'),connection=join(root,'connection');mkdirSync(home,{mode:0o700});mkdirSync(cwd);writeFileSync(command,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected runtime start');\n`,{mode:0o700});writeFileSync(config,JSON.stringify({command,cwd,codexHome:home,policy:{approvalPolicy:'never',sandbox:'read-only'},requestTimeoutMs:1000}));saveAgentConnection(connection,{version:1,origin:'https://fixture.invalid',roomId:'room',memberId:'agent',token:'t'.repeat(43)});t.after(()=>rmSync(root,{recursive:true,force:true}));return{root,home,cwd,command,marker,config,journal,connection};}
function launch(f){return spawnSync(process.execPath,[cli,'--watch-requests',f.journal,f.config,'owner'],{stdio:['ignore','ignore','ignore'],timeout:5000,env:{PATH:'/unavailable',ROOM_AGENT_CONFIG:f.connection}});}
test('private profile lock failure remains actionable after the native-style child exits with output discarded',t=>{
 const f=setup(t),lock=join(f.home,'.room-runtime.lock');mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'identity'),'PRIVATE-LOCK-DETAIL',{mode:0o600});const before=statSync(lock).ino;
 const child=launch(f);assert.equal(child.error,undefined);const status=readCodexHostStatus(f.journal);
 assert.equal(status.phase,'stopped');assert.equal(status.protocol,'unverified');assert.equal(status.credentials,'unknown');assert.equal(status.failureCode,'profile_lock_requires_reconciliation');assert.equal(child.status,70);
 assert.equal(existsSync(f.marker),false);assert.equal(statSync(lock).ino,before);assert.equal(readFileSync(join(lock,'identity'),'utf8'),'PRIVATE-LOCK-DETAIL');assert.doesNotMatch(JSON.stringify(status),/PRIVATE-LOCK-DETAIL|runtime\.json|fake-codex/);
});
import {WatchJournal} from '../client/watch-journal.mjs';
import {createCodexStatusWriter} from '../client/codex-host-status.mjs';
import {CodexRuntimeSetupError,codexRuntimeSetupFailure,CODEX_RUNTIME_FAILURE_EXITS} from '../client/codex-stdio.mjs';
function fakeProtocol(f,{login=false,privateProtocolError=false}={}){writeFileSync(f.command,`#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;fs.appendFileSync(${JSON.stringify(f.marker)},m.method+'\\n');let result;
switch(m.method){case'initialize':result={};break;case'thread/start':result={thread:{id:'probe'}};break;case'thread/name/set':result={};break;case'thread/read':if(${privateProtocolError}){process.stdout.write(JSON.stringify({id:m.id,error:{code:'profile_lock_requires_reconciliation',message:'PRIVATE-PROVIDER-TEXT'}})+'\\n');return;}case'thread/resume':result={thread:{id:m.params.threadId,turns:[]}};break;case'account/read':result={account:${login?'null':"{type:'chatgpt',email:'PRIVATE-ACCOUNT-TEXT'}"},requiresOpenaiAuth:true};break;default:throw Error('Forbidden model method');}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`,{mode:0o700});}
test('login failure remains a safe terminal reason after output is discarded and cleanup finishes',t=>{
 const f=setup(t);fakeProtocol(f,{login:true});const child=launch(f),status=readCodexHostStatus(f.journal);assert.equal(child.error,undefined);assert.equal(child.status,71);assert.equal(status.failureCode,'login_required');assert.equal(status.phase,'stopped');assert.equal(status.credentials,'unknown');assert.doesNotMatch(JSON.stringify(status),/PRIVATE|@|planType|apiKey/);assert.doesNotMatch(readFileSync(f.marker,'utf8'),/turn\/start|account\/login/);
});
test('invalid runtime before watcher ownership has only the closed native exit code',t=>{
 const f=setup(t);writeFileSync(f.config,'{PRIVATE-CONFIG-TEXT');const child=launch(f);assert.equal(child.error,undefined);assert.equal(child.status,72);assert.equal(existsSync(f.marker),false);assert.equal(existsSync(`${f.journal}.watch`),false);
});
test('provider error text and a spoofed provider setup code never become native guidance',t=>{
 const f=setup(t);fakeProtocol(f,{privateProtocolError:true});const child=launch(f),status=readCodexHostStatus(f.journal);assert.equal(child.error,undefined);assert.equal(child.status,72);assert.equal(status.failureCode,'invalid_runtime');assert.doesNotMatch(JSON.stringify(status),/PRIVATE-PROVIDER-TEXT/);assert.doesNotMatch(readFileSync(f.marker,'utf8'),/turn\/start/);
 assert.equal(codexRuntimeSetupFailure({code:'login_required',message:'PRIVATE-ERROR'}),undefined);assert.equal(CODEX_RUNTIME_FAILURE_EXITS[codexRuntimeSetupFailure(new Error('PRIVATE-ERROR'))],undefined);assert.equal(codexRuntimeSetupFailure(new CodexRuntimeSetupError('login_required','PRIVATE-ERROR')),'login_required');
});
test('status ignores arbitrary error fields, retains safe code after stop, clears on recovery, and fences a replacement owner',t=>{
 const f=setup(t),directory=`${f.journal}.watch`;let owner=new WatchJournal(directory),writer=createCodexStatusWriter(directory,{origin:'https://fixture.invalid',roomId:'room',memberId:'agent'});
 t.after(()=>{writer.close();owner.close();});writer.event({type:'host_status',status:'recovery_pending',failureCode:'PRIVATE-ERROR',code:'login_required',message:'PRIVATE-TEXT'});assert.equal(readCodexHostStatus(f.journal).failureCode,undefined);writer.event({type:'host_status',status:'recovery_pending',failureCode:['login_required']});assert.equal(readCodexHostStatus(f.journal).failureCode,undefined);assert.throws(()=>new CodexRuntimeSetupError(['login_required'],'PRIVATE'),/Unknown runtime setup failure/);
 writer.event({type:'host_status',status:'recovery_pending',failureCode:'profile_lock_requires_reconciliation'});writer.event({type:'host_status',status:'stopped'});assert.equal(readCodexHostStatus(f.journal).failureCode,'profile_lock_requires_reconciliation');writer.close();owner.close();assert.equal(readCodexHostStatus(f.journal).failureCode,'profile_lock_requires_reconciliation');
 owner=new WatchJournal(directory);assert.equal(readCodexHostStatus(f.journal).failureCode,undefined);writer=createCodexStatusWriter(directory,{origin:'https://fixture.invalid',roomId:'room',memberId:'agent'});assert.equal(readCodexHostStatus(f.journal).failureCode,undefined);
 writer.event({type:'host_status',status:'recovery_pending',failureCode:'login_required'});writer.event({type:'host_status',status:'watching_room'});assert.equal(readCodexHostStatus(f.journal).failureCode,'login_required');writer.event({type:'host_readiness',credentials:'present'});assert.equal(readCodexHostStatus(f.journal).failureCode,undefined);assert.equal(readCodexHostStatus(f.journal).credentials,'present');assert.doesNotMatch(readFileSync(join(directory,'status.json'),'utf8'),/PRIVATE/);
});
