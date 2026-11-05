// Explicit, synthetic staging qualification. Never targets production.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {chmodSync,existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const origin='https://project-room-stage.getdasha.workers.dev';
const directory=process.argv[2] ?? mkdtempSync(join(tmpdir(),'room-stage-agent-'));
chmodSync(directory,0o700);
const privateFile=join(directory,'private.json'),reportFile=join(directory,'report.json');
const state=existsSync(privateFile)?JSON.parse(readFileSync(privateFile,'utf8')):{
  origin,stamp:'qa'+Date.now().toString(36),password:randomBytes(24).toString('base64url'),
  identitySecret:'pri_'+randomBytes(32).toString('base64url'),responses:{},cookies:{},steps:[]
};
assert.equal(state.origin,origin);
const save=()=>{writeFileSync(privateFile,JSON.stringify(state),{mode:0o600});chmodSync(privateFile,0o600);};
save();
async function call(name,path,{method='GET',body,headers={},fresh=false}={}) {
  assert.ok(path.startsWith('/')&&!path.startsWith('//'));
  if(!fresh&&state.responses[name]?.status>=200&&state.responses[name]?.status<300)return state.responses[name];
  const started=performance.now();
  const response=await fetch(origin+path,{method,redirect:'manual',signal:AbortSignal.timeout(20000),
    headers:{origin,...(body?{'content-type':'application/json'}:{}),...headers},
    ...(body?{body:JSON.stringify(body)}:{})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch{json=null;}
  // All raw responses and cookies stay in a private file; stdout is allowlisted.
  for(const cookie of response.headers.getSetCookie()) {
    const pair=cookie.split(';',1)[0],at=pair.indexOf('=');
    state.cookies[pair.slice(0,at)]=pair.slice(at+1);
  }
  const value={status:response.status,json};state.responses[name]=value;
  state.steps.push({name,status:response.status,ms:Math.round(performance.now()-started),error:json?.error?.code??null});save();
  assert.ok(response.status>=200&&response.status<300,`${name}: HTTP ${response.status} ${json?.error?.code??'non-JSON error'}`);
  return value;
}
const cookie=()=>Object.entries(state.cookies).map(([key,value])=>`${key}=${value}`).join('; ');
const accountHeaders=()=>({cookie:cookie(),'x-csrf-token':state.csrf,'x-session-binding':state.binding,'x-project-room-auth':'account'});
const agentHeaders=()=>({authorization:'Bearer '+state.identitySecret});
let failure=null;
try {
  const version=await call('version','/api/version',{fresh:true});
  assert.equal(version.json.sourceRevision,'ff3350cb8d2be1d1c7278677211eeea3282b7c75','staging candidate must match the qualified source');
  const first=await call('anonymous-session','/api/account-session');
  const signed=await call('signup','/api/auth/password/signup',{method:'POST',body:{email:state.stamp+'@example.invalid',password:state.password,
    sessionRevision:first.json.sessionRevision,sessionToken:state.cookies['__Host-account_session']??state.cookies.account_session}});
  state.csrf=signed.json.csrf;state.binding=signed.json.sessionBinding;save();
  if(!state.csrf||!state.binding){const session=await call('signed-session','/api/account-session',{headers:{cookie:cookie()}});state.csrf=session.json.csrf;state.binding=session.json.sessionBinding;save();}
  assert.ok(state.csrf&&state.binding,'authenticated account session must be bound');
  const room=await call('create-room','/api/account-rooms',{method:'POST',headers:accountHeaders(),body:{roomId:state.stamp,title:'QA canonical coordination',purpose:'Synthetic staging-only first useful result',kind:'personal',displayName:'QA owner'}});
  state.roomId=room.json.room.id;state.ownerMemberId=room.json.room.memberId;save();
  assert.ok(state.ownerMemberId,'use actual returned owner member ID');
  const identity=await call('existing-agent','/api/agent-identities',{method:'POST',headers:agentHeaders(),body:{displayName:'QA existing agent',recoverable:true}});
  state.identityId=identity.json.identityId;save();assert.ok(state.identityId);
  const invite=await call('create-invite',`/api/rooms/${state.roomId}/agent-invites`,{method:'POST',headers:accountHeaders(),body:{profile:'contribute',expiresInMinutes:30,displayName:'QA existing agent'}});
  const redemption={code:invite.json.code,displayName:'QA existing agent',requestId:state.stamp+'-redeem'};
  const joined=await call('join-existing','/api/agent-invites/redeem',{method:'POST',headers:agentHeaders(),body:redemption});
  assert.equal(joined.json.identityId,state.identityId);assert.equal(joined.json.memberId,state.identityId);
  assert.equal(joined.json.identitySecret,undefined,'existing identity secret must not be echoed');
  const repeated=await call('join-retry','/api/agent-invites/redeem',{method:'POST',headers:agentHeaders(),body:redemption});
  assert.equal(repeated.json.identityId,state.identityId);assert.equal(repeated.json.duplicate,true);
  const token = joined.json
    .mcpToken?.credential;
  assert.ok(token, 'first redemption yields room-scoped token');
  const mcp=await call('scoped-mcp-access','/mcp',{method:'POST',headers:{authorization:'Bearer '+token},body:{jsonrpc:'2.0',id:'qa-access',method:'tools/call',params:{name:'room_check_access',arguments:{roomId:state.roomId}}}});
  assert.ok(mcp.json.result&&!mcp.json.error&&!mcp.json.result.isError,'room-scoped MCP connection accepted');
  const access=mcp.json.result.structuredContent;
  assert.equal(access.roomId,state.roomId);assert.equal(access.memberId,state.identityId);
  assert.deepEqual(access.permissions,['accept_work','complete_work']);
  const command=(name,type,data,owner=false)=>call(name,`/api/rooms/${state.roomId}/commands`,{method:'POST',headers:owner?accountHeaders():agentHeaders(),body:{id:state.stamp+'-'+name,type,data}});
  const workItemId='qa-first-task';
  await command('propose','work.proposed',{workItemId,title:'Save a useful shared result',definitionOfDone:'An invited agent saves a durable result and reads it back',accountableMemberId:state.identityId,independentVerificationRequired:false,ownerDecisionRequired:false,mode:'read'},true);
  await command('accept','work.accepted',{workItemId,expectedRevision:0});
  const resultBody='Staging QA result: an invited existing agent completed the canonical task and saved this durable result.';
  const posted=await command('save','message.posted',{messageId:'qa-saved-result',body:resultBody,workItemId});
  const evidenceVersion='sha256:'+createHash('sha256').update(resultBody).digest('hex');
  const completionData={workItemId,expectedRevision:1,evidenceKind:'room_text',evidenceMessageId:'qa-saved-result',evidenceMessageEventId:posted.json.event.id,evidenceVersion,previousCompletionEventId:null,producerId:state.identityId,summary:'Durable shared result saved',nextAction:'Read saved result'};
  const completed=await command('complete','work.completed',completionData);
  const retry=await call('complete-retry',`/api/rooms/${state.roomId}/commands`,{method:'POST',headers:agentHeaders(),body:{id:state.stamp+'-complete',type:'work.completed',data:completionData}});
  assert.equal(retry.json.event.id,completed.json.event.id);
  const result=await call('read-result',`/api/rooms/${state.roomId}/work-result?workItemId=${workItemId}`,{headers:agentHeaders()});
  const verifySaved=value=>{assert.equal(value.result.kind,'room_text');assert.equal(value.result.text.body,resultBody);assert.equal(value.result.text.evidenceVersion,evidenceVersion);assert.equal(value.result.receipt.eventId,completed.json.event.id);assert.equal(value.result.receipt.producerId,state.identityId);assert.equal(value.current.workRevision,2);};
  verifySaved(result.json);
  const fresh=await call('fresh-client-result',`/api/rooms/${state.roomId}/work-result?workItemId=${workItemId}`,{headers:agentHeaders(),fresh:true});verifySaved(fresh.json);
  const accounts=await call('fresh-owner-rooms','/api/account-rooms',{headers:accountHeaders(),fresh:true});
  assert.ok(JSON.stringify(accounts.json).includes(state.roomId),'owner account still lists the synthetic room');
  state.result={revision:version.json.sourceRevision,buildId:version.json.buildId,roomId:state.roomId,identityId:state.identityId,completionEventId:completed.json.event.id,resultResponse:fresh.json};save();
}catch(error){failure=String(error.message).replace(/pri_[A-Za-z0-9_-]+|rak_[A-Za-z0-9_-]+/g,'[redacted]');}
const report={origin,sourceRevision:'ff3350cb8d2be1d1c7278677211eeea3282b7c75',status:failure?'failed':'passed',failure,
  roomId:state.roomId??null,identityId:state.identityId??null,liveRevision:state.responses.version?.json?.sourceRevision??null,buildId:state.responses.version?.json?.buildId??null,checks:failure?null:{existingIdentityPreserved:true,scopedPermissions:['accept_work','complete_work'],invitationRetry:true,completionRetry:true,exactSavedTextAndReceipt:true,freshClientRead:true,ownerAccountRoomPreserved:true},steps:state.steps};
writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});chmodSync(reportFile,0o600);
console.log(JSON.stringify({reportFile,privateDirectory:directory,...report}));
if(failure)process.exitCode=1;
