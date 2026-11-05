import entry,{IdentityLinkRoom} from './current-identity-link.test-fixture.mjs';
import {readCurrentRecord} from '../server/current-room-repository.mjs';
export class RequestRunRoom extends IdentityLinkRoom {
 async fetch(request){const path=new URL(request.url).pathname;if(!['/run','/run-cold','/run-hidden'].includes(path))return super.fetch(request);try{
 const s=this.store,{identity,key}=await this.ctx.storage.get('fixture');s.room=()=>{throw Error('Full request-run room hydration forbidden');};
 if(path==='/run'){
  s.command(key,'commons',{id:'native-question-event',type:'message.posted',data:{messageId:'native-question',body:'Do useful work',toMemberId:identity.identityId,requestKind:'reply'}});
  const r=readCurrentRecord(s.db,'commons','replyRequests','native-question'),input={requestMessageId:r.id,attemptId:'native-attempt',action:'claim',expectedRequestRevision:r.revision,contextEventId:r.contextEventId};
  await this.ctx.storage.put('run-input',input);
  let rolledBack=false;try{s.transaction(()=>{s.requestRuns.apply(identity.secret,'commons',input);throw Error('Native saved-run fault');});}catch(e){if(e.message!=='Native saved-run fault')throw e;rolledBack=true;}
  if(s.db.prepare('SELECT count(*) n FROM request_runs').get().n!==0)throw Error('Fault did not roll back');
  const result=s.requestRuns.apply(identity.secret,'commons',input);return Response.json({rolledBack,state:result.state});
 }
 if(path==='/run-hidden'){
  s.command(key,'commons',{id:'observer-added',type:'member.added',data:{memberId:'observer',displayName:'Observer',kind:'agent',permissions:[]}});
  const observer=s.issueAccessKey('commons','observer');
  const observe=()=>{const cost={statements:0,rowsRead:0,rowsWritten:0,unknown:0,partyStatements:0,partyRowsRead:0},old=s.db.observeStatement,oldPrepare=s.db.prepare,prepare=oldPrepare.bind(s.db);let active='';s.db.prepare=query=>new Proxy(prepare(query),{get(target,key){const fn=Reflect.get(target,key,target);if(!['get','all','run'].includes(key))return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const prior=active;active=query;try{return fn.apply(target,args);}finally{active=prior;}};}});s.db.observeStatement=()=>{const query=active;return sample=>{if(query.includes('INDEXED BY current_request_')){cost.partyStatements++;cost.partyRowsRead+=sample.rowsRead??0;}cost.statements++;cost.rowsRead+=sample.rowsRead??0;cost.rowsWritten+=sample.rowsWritten??0;if(sample.rowsRead===null||sample.rowsWritten===null)cost.unknown++;};};try{return {runs:s.requestRuns.list(observer,'commons').runs,cost};}finally{s.db.observeStatement=old;s.db.prepare=oldPrepare;}};
  const before=observe();let clock=s.now();s.now=()=>clock;
  for(let i=0;i<33;i++){clock+=3000;s.command(key,'commons',{id:'private-opening-'+i,type:'message.posted',data:{messageId:'private-question-'+i,body:'Private ask',toMemberId:identity.identityId,requestKind:'reply'}});}
  const after=observe();let recipientRefused=false;try{s.requestRuns.list(identity.secret,'commons');}catch(e){if(e.code!=='request_runs_context_unavailable')throw e;recipientRefused=true;}
  return Response.json({before,after,recipientRefused});
 }
 const input=await this.ctx.storage.get('run-input');let repeated=false;try{s.requestRuns.apply(identity.secret,'commons',input);}catch(e){if(e.code!=='request_run_owned')throw e;repeated=true;}
 s.requestRuns.apply(identity.secret,'commons',{...input,action:'needs_attention'});
 return Response.json({duplicateRefused:repeated,state:s.requestRuns.list(identity.secret,'commons').runs['native-question'].state,attempts:s.db.prepare('SELECT count(*) n FROM request_runs').get().n});
 }catch(e){return Response.json({error:{code:e.code,message:e.message}},{status:500});}}
}
export default entry;
