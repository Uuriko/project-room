import { ServiceError } from './service-error.mjs';
import { textVersion } from './text-results.mjs';
import { randomUUID } from 'node:crypto';
import { fitId,validWorkFitAction,validWorkFitQuery } from '../src/work-fit-contract.js';
import { emptyWorkFit,projectWorkFit,explainWorkFit } from './agent-work-fit.mjs';
import { historyFloor,messageVisibleToViewer } from './history-visibility.mjs';
import { reportedProducer } from '../src/work-packet.js';
import { isGuestAgentMemberId } from './guest-agent-links.mjs';
import { withContentTrust } from './content-trust.mjs';
export const workFitSchema=`
CREATE TABLE IF NOT EXISTS agent_work_fit_events (
 room_id TEXT NOT NULL REFERENCES rooms(id),subject_id TEXT NOT NULL,sequence INTEGER NOT NULL,
 event_id TEXT NOT NULL UNIQUE,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,value TEXT NOT NULL,
 PRIMARY KEY(room_id,subject_id,sequence),UNIQUE(room_id,actor_id,request_id));
CREATE TABLE IF NOT EXISTS agent_work_fit_profiles (
 room_id TEXT NOT NULL REFERENCES rooms(id),subject_id TEXT NOT NULL,value TEXT NOT NULL,
 PRIMARY KEY(room_id,subject_id));`;
const fail=(status,code,message)=>{throw new ServiceError(status,code,message);};
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v && typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const keyOf=o=>JSON.stringify([o.category,o.role,o.configurationId]);
export class AgentWorkFit {
 constructor(store){this.store=store;}
 present(){return Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_work_fit_profiles'").get());}
 profile(roomId,subjectId){if(!this.present())return emptyWorkFit();const r=this.store.db.prepare('SELECT value FROM agent_work_fit_profiles WHERE room_id=? AND subject_id=?').get(roomId,subjectId);return r?JSON.parse(r.value):emptyWorkFit();}
 sourceContext(roomId,viewerId){
  const room=this.store.room(roomId);
  return {...room,floor:historyFloor(this.store.db,room.state,roomId,viewerId,room.sequence),messages:new Map(room.state.messages.map(m=>[m.id,m])),memo:new Map()};
 }
 source(roomId,workItemId,sourceEventId,viewerId,context=null){
  if(!fitId(sourceEventId))return null;
  context??=this.sourceContext(roomId,viewerId);
  const key=JSON.stringify([workItemId,sourceEventId]);
  if(!context.memo.has(key))context.memo.set(key,this.sourceRecord(roomId,workItemId,sourceEventId,viewerId,context));
  return context.memo.get(key);
 }
 sourceRecord(roomId,workItemId,sourceEventId,viewerId,context){
  const {state,floor}=context,work=state.workItems[workItemId];
  if(!work || work.supersededBy)return null;
  if(work.sourceMessageId){const m=context.messages.get(work.sourceMessageId);if(m?.toMemberId || !messageVisibleToViewer(m,viewerId,floor))return null;}
  const row=this.store.db.prepare('SELECT body,sequence FROM events WHERE room_id=? AND id=?').get(roomId,sourceEventId);
  if(!row || floor && row.sequence<floor.sequence)return null;
  const e=JSON.parse(row.body);
  if(e.data?.workItemId!==workItemId)return null;
  // Bound evidence to an actual role-bearing event; no title/owner inference.
  if(e.type==='work.completed'){
   const receipt=[work.receipt,...(work.receiptHistory??[])].find(r=>r?.eventId===e.id);
   if(!receipt)return null;
   if(receipt.nativeText){const m=context.messages.get(receipt.nativeText.messageId);if(m?.toMemberId || !messageVisibleToViewer(m,viewerId,floor) || textVersion(m.body)!==receipt.evidenceVersion)return null;}
   return {role:'producer',subjectMemberId:reportedProducer(e.data).producerId,reporterId:e.actorId,standing:work.receipt?.eventId===e.id?'reported':'superseded',attemptId:e.id};
  }
  if(e.type==='verification.recorded'){
   const completion=this.source(roomId,workItemId,e.data.completionEventId,viewerId,context);
   if(!completion || completion.role!=='producer')return null;
   return {role:'reviewer',subjectMemberId:e.actorId,reporterId:e.actorId,standing:work.verification?.eventId===e.id && completion.standing!=='superseded'?'reviewed':'superseded',attemptId:e.data.completionEventId};
  }
  if(['work.handoff_recorded'].includes(e.type))return {role:'coordinator',subjectMemberId:e.actorId,reporterId:e.actorId,standing:'reported',attemptId:e.id};
  return null;
 }
 visible(roomId,subjectId,viewerId){
  const p=this.profile(roomId,subjectId),context=this.sourceContext(roomId,viewerId);
  p.observations=p.observations.flatMap(o=>{
   const source=this.source(roomId,o.workItemId,o.sourceEventId,viewerId,context);
   return source && source.subjectMemberId===subjectId && source.role===o.role ? [{...o,source,standing:source.standing,disputed:o.responses.filter(r=>r.actorMemberId===subjectId).at(-1)?.stance==='dispute'}]:[];
  });
  const byId=new Map(p.observations.map(o=>[o.id,o]));
  p.assessments=p.assessments.filter(a=>a.caseIds.every(id=>byId.has(id) && byId.get(id).standing!=='superseded' && !byId.get(id).disputed && byId.get(id).revision===a.caseRevisions[id]));
  return p;
 }
 read(roomId,query,authorize){
  if(!validWorkFitQuery(query))fail(422,'invalid_work_fit','Choose a valid profile or task selection');
  return this.store.readTransaction(()=>{
   const auth=authorize(),state=this.store.room(roomId).state,subjectId=query.memberId??auth.member.id;
   if(!state.members[subjectId]?.active)fail(404,'work_fit_member_missing','Active member not found');
   const p=this.visible(roomId,subjectId,auth.member.id);
   if(query.workItemId && !state.workItems[query.workItemId])fail(404,'work_not_found','Work not found');
   const scoped=items=>items.map(a=>({...a,configurationScope:p.configurations.find(c=>c.id===a.configurationId)??null,currentConfiguration:a.configurationId!==null && a.configurationId===p.configuration?.id}));
   const result={contractVersion:1,advisory:true,roomId,memberId:subjectId,selfRevision:p.selfRevision,preferences:p.preferences,configuration:p.configuration,
    strengths:scoped(p.assessments.filter(a=>a.tendency==='good_fit').slice(0,3)),support:scoped(p.assessments.filter(a=>a.tendency!=='good_fit').slice(0,3)),
    assessmentCount:p.assessments.length,caseCount:new Set(p.observations.map(o=>o.caseKey)).size,
    nextRead:{tool:'room_read_work_fit',arguments:{memberId:subjectId,detail:'evidence'}}};
   if(query.workItemId)result.fit=explainWorkFit(p,query.categories??[],query.role);
   if(query.detail==='evidence'){
    const after=query.cursor?p.observations.findIndex(o=>o.id===query.cursor):-1;
    if(query.cursor && after<0)fail(409,'work_fit_cursor_changed','Evidence changed; restart the read');
    const observations=p.observations.slice(after+1,after+21);
    result.observations=observations;result.assessments=p.assessments;result.configurations=p.configurations;result.nextCursor=after+21<p.observations.length?observations.at(-1).id:null;
   }
   return withContentTrust(result);
  });
 }
 apply(roomId,input,authorize){
  if(!validWorkFitAction(input))fail(422,'invalid_work_fit','Choose a valid action and stable request ID');
  return this.store.transaction(()=>{
   const auth=authorize(),actor=auth.member,state=this.store.room(roomId).state;
   if(isGuestAgentMemberId(actor.id) || actor.permissions.some(p=>p.startsWith('guest:')))fail(403,'work_fit_denied','Guests cannot publish work-fit records');
   if(state.room.archivedAt)fail(409,'room_archived','Room is archived');
   const subjectId=input.action==='update_self'?actor.id:input.subjectMemberId;
   if(!state.members[subjectId]?.active)fail(404,'work_fit_member_missing','Active member not found');
   const p=this.profile(roomId,subjectId),fingerprint=canonical(input);
   const old=this.store.db.prepare('SELECT input,value FROM agent_work_fit_events WHERE room_id=? AND actor_id=? AND request_id=?').get(roomId,actor.id,input.requestId);
   if(old){if(old.input!==fingerprint)fail(409,'work_fit_retry_conflict','Retry ID records different input');
    // Receipts contain identifiers only; never replay formerly visible feedback.
    const e=JSON.parse(old.value);return {contractVersion:1,advisory:true,eventId:e.id,memberId:subjectId};}
   if(p.revision>=1000)fail(409,'work_fit_capacity','Profile journal limit reached');
   const now=new Date(this.store.now()).toISOString(),id=randomUUID();let value;
   if(input.action==='update_self'){
    if(input.expectedRevision!==p.selfRevision)fail(409,'work_fit_revision_conflict','Preferences changed; reread the profile');
    if(p.configurations.length>=50 && input.configuration)fail(409,'work_fit_capacity','Configuration history is full');
    value={preferences:{prefer:[],learn:[],avoid:[],...input.preferences},configuration:input.configuration?{id,declared:true,at:now,...input.configuration}:null};
   }else if(input.action==='record_observation'){
    if(p.observations.length>=200)fail(409,'work_fit_capacity','Profile observation limit reached');
    if(input.configurationId!==null && !p.configurations.some(c=>c.id===input.configurationId))fail(422,'work_fit_configuration_missing','Choose a recorded configuration or null');
    const source=this.source(roomId,input.workItemId,input.sourceEventId,actor.id);
    if(!source || source.subjectMemberId!==subjectId || source.role!==input.role)fail(403,'work_fit_source_denied','Choose visible task evidence attributed to this worker and role');
    const caseKey=JSON.stringify([subjectId,input.configurationId,input.workItemId,source.attemptId,input.category,input.role]);
    value={...input,id,actorMemberId:actor.id,caseKey,revision:0,at:now,responses:[],corrections:[]};delete value.action;delete value.requestId;
   }else if(input.action==='amend_observation' || input.action==='respond_observation'){
    const o=p.observations.find(o=>o.id===input.observationId);
    if(!o || !this.source(roomId,o.workItemId,o.sourceEventId,actor.id))fail(404,'work_fit_observation_missing','Visible observation not found');
    if(input.action==='amend_observation'){
     if(o.actorMemberId!==actor.id)fail(403,'work_fit_denied','Only the statement author may amend it');
     if(o.corrections.length>=50)fail(409,'work_fit_capacity','Correction history limit reached');
     if(o.revision!==input.expectedObservationRevision)fail(409,'work_fit_revision_conflict','Observation changed; reread it');
     value={...o,reportedResult:input.reportedResult,outcome:input.outcome,environmentLimit:input.environmentLimit??null,coaching:input.coaching??null,revision:o.revision+1,
      corrections:[...o.corrections,{at:now,reason:input.reason,reportedResult:o.reportedResult,outcome:o.outcome}]};
    }else{
     if(actor.id!==subjectId && actor.id!==o.actorMemberId && actor.id!==state.room.ownerId)fail(403,'work_fit_denied','Only the subject, author or room owner may respond');
     if(o.responses.length>=20)fail(409,'work_fit_capacity','Response limit reached');
     value={id,observationId:o.id,actorMemberId:actor.id,response:input.response,stance:input.stance,at:now};
    }
   }else{
    if(actor.id!==subjectId && actor.id!==state.room.ownerId && !actor.permissions.includes('manage_members'))fail(403,'work_fit_denied','Room management access required to assess another worker');
    const visible=this.visible(roomId,subjectId,actor.id);
    if(input.caseIds.some(id=>!visible.observations.some(o=>o.id===id && o.category===input.category && o.role===input.role && o.configurationId===input.configurationId && o.standing!=='superseded' && !o.disputed)))fail(403,'work_fit_source_denied','Assessment needs applicable visible cases');
    const key=keyOf(input),previous=p.assessments.find(a=>a.key===key && a.actorMemberId===actor.id);
    if(input.expectedRevision!==(previous?.revision??0))fail(409,'work_fit_revision_conflict','Assessment changed; reread evidence');
    if(!previous && p.assessments.length>=64)fail(409,'work_fit_capacity','Assessment limit reached');
    value={...input,id,key,caseRevisions:Object.fromEntries(input.caseIds.map(id=>[id,visible.observations.find(o=>o.id===id).revision])),actorMemberId:actor.id,provenance:actor.id===subjectId?'self_assessed':'room_assessed',revision:(previous?.revision??0)+1,at:now};delete value.action;delete value.requestId;delete value.expectedRevision;
   }
   const event={id,action:input.action,value,revision:p.revision+1,actorMemberId:actor.id,at:now};
   const next=projectWorkFit(p,event);
   this.store.db.prepare('INSERT INTO agent_work_fit_events(room_id,subject_id,sequence,event_id,actor_id,request_id,input,value) VALUES(?,?,?,?,?,?,?,?)').run(roomId,subjectId,next.revision,id,actor.id,input.requestId,fingerprint,JSON.stringify(event));
   this.store.db.prepare('INSERT INTO agent_work_fit_profiles(room_id,subject_id,value) VALUES(?,?,?) ON CONFLICT(room_id,subject_id) DO UPDATE SET value=excluded.value').run(roomId,subjectId,JSON.stringify(next));
   return {contractVersion:1,advisory:true,eventId:id,memberId:subjectId};
  });
 }
 purgeMember(roomId,memberId){
  if(!this.present())return 0;
  const affected=this.store.db.prepare('SELECT DISTINCT subject_id FROM agent_work_fit_events WHERE room_id=? AND actor_id=? AND subject_id<>?').all(roomId,memberId,memberId);
  let removed=this.store.db.prepare('DELETE FROM agent_work_fit_events WHERE room_id=? AND subject_id=?').run(roomId,memberId).changes;
  this.store.db.prepare('DELETE FROM agent_work_fit_profiles WHERE room_id=? AND subject_id=?').run(roomId,memberId);
  for(const subject of affected){
   for(const row of this.store.db.prepare('SELECT event_id,value FROM agent_work_fit_events WHERE room_id=? AND subject_id=? AND actor_id=?').all(roomId,subject.subject_id,memberId)){
    const e=JSON.parse(row.value);const value=JSON.stringify({id:e.id,action:e.action,revision:e.revision,at:e.at,redacted:true});
    this.store.db.prepare('UPDATE agent_work_fit_events SET input=?,value=? WHERE event_id=?').run('redacted',value,row.event_id);removed++;
   }
   let p=emptyWorkFit();for(const row of this.store.db.prepare('SELECT value FROM agent_work_fit_events WHERE room_id=? AND subject_id=? ORDER BY sequence').all(roomId,subject.subject_id))p=projectWorkFit(p,JSON.parse(row.value));
   this.store.db.prepare('UPDATE agent_work_fit_profiles SET value=? WHERE room_id=? AND subject_id=?').run(JSON.stringify(p),roomId,subject.subject_id);
  }
  return removed;
 }
 verify(){
  if(!this.present())return;
  for(const row of this.store.db.prepare('SELECT room_id,subject_id,value FROM agent_work_fit_profiles').all()){
   let p=emptyWorkFit();for(const e of this.store.db.prepare('SELECT value,sequence FROM agent_work_fit_events WHERE room_id=? AND subject_id=? ORDER BY sequence').all(row.room_id,row.subject_id)){
    if(e.sequence!==p.revision+1)fail(503,'work_fit_integrity','Work-fit journal requires reconciliation');p=projectWorkFit(p,JSON.parse(e.value));}
   if(canonical(p)!==canonical(JSON.parse(row.value)))fail(503,'work_fit_integrity','Work-fit projection requires reconciliation');
  }
  if(this.store.db.prepare('SELECT 1 FROM agent_work_fit_events e LEFT JOIN agent_work_fit_profiles p ON p.room_id=e.room_id AND p.subject_id=e.subject_id WHERE p.subject_id IS NULL LIMIT 1').get())fail(503,'work_fit_integrity','Work-fit projection missing');
 }
}
