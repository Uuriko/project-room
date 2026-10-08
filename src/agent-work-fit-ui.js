import { uiText } from './strings.js';
import { WORK_FIT_CATEGORIES } from './work-fit-contract.js';
// On-demand Advanced surface. Never participates in task admission or chat.
export function installWorkFit({getState,getSession,client,openWork}){
 const $=s=>document.querySelector(s),label=c=>c.replaceAll('_',' '),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const button=document.createElement('button');button.type='button';button.id='work-fit-open';button.className='text-button';button.textContent='Work fit';$('#advanced-room-tools').append(button);
 const dialog=document.createElement('dialog');dialog.id='work-fit-dialog';dialog.setAttribute('aria-labelledby','work-fit-title');
 dialog.innerHTML=uiText('workFit.dialog',{learningChoices: WORK_FIT_CATEGORIES.map(c=>uiText('workFit.learningChoice',{category:c,label:label(c)})).join(''),categoryChoices: WORK_FIT_CATEGORIES.map(c=>uiText('workFit.categoryChoice',{category:c,label:label(c)})).join('')});
 document.body.append(dialog);
 let boundary='',view=0,profile=null,observations=[],pending=null,loading=false,selectedObservation=null,interestsDirty=false;
 const context=()=>[client.generation,getState()?.room.id,getSession()?.member.id].join('|');
 const path=()=>`/api/rooms/${encodeURIComponent(getState().room.id)}/work-fit`;
 const status=message=>$('#work-fit-status').textContent=message;
 const pendingWorker=()=>$('#work-fit-member').disabled=Boolean(pending);
 const current=(stamp,ticket)=>stamp===context() && ticket===view && dialog.open;
 function sources(){
  const subject=$('#work-fit-member').value,out=[],messages=new Map((getState().messages??[]).map(m=>[m.id,m]));
  const visible=m=>m && m.body!==null && !m.deletedAt && !m.toMemberId;
  for(const w of Object.values(getState().workItems??{})){
   if(w.supersededBy || w.sourceMessageId && !visible(messages.get(w.sourceMessageId)))continue;
   const native=w.receipt?.nativeText,available=!native || !native.withdrawnAt && native.evidence!=='removed' && visible(messages.get(native.messageId));
   if(available && w.receipt?.producerId===subject)out.push({workItemId:w.id,sourceEventId:w.receipt.eventId,role:'producer',title:w.title});
   if(available && w.verification?.verifierId===subject && w.verification.completionEventId===w.receipt?.eventId)out.push({workItemId:w.id,sourceEventId:w.verification.eventId,role:'reviewer',title:w.title});
   if(w.handoff?.actorId===subject)out.push({workItemId:w.id,sourceEventId:w.handoff.eventId,role:'coordinator',title:w.title});
  }return out;
 }
 function paint(){
  const memberId=$('#work-fit-member').value,self=memberId===getSession().member.id;
  $('#work-fit-interests').hidden=!self;
  if(self && !interestsDirty)for(const input of $('#work-fit-preferences').querySelectorAll('input'))input.checked=profile.preferences.learn.includes(input.value);
  $('#work-fit-assessment').hidden=!self && getState().room.ownerId!==getSession().member.id && !getSession().member.permissions.includes('manage_members');
  const notes=items=>items.length?items.map(a=>uiText('workFit.note',{advice:esc(a.advice),author:esc(getState().members[a.actorMemberId]?.displayName??a.actorMemberId),provenance:esc(a.provenance),at:esc(a.at),configuration:esc(a.configurationId?[a.currentConfiguration?'current configuration':'past configuration',a.configurationScope?.model??'undeclared model',a.configurationScope?.runtime??'undeclared runtime'].join(' · '):'unknown configuration')})).join(''):uiText('workFit.emptyAssessment');
  $('#work-fit-content').innerHTML=uiText('workFit.content',{strengths:notes(profile.strengths),support:notes(profile.support),interests:profile.preferences.learn.map(c=>esc(label(c))).join(', ')||'None declared',evidence:observations.map(o=>uiText('workFit.evidence',{workId:esc(o.workItemId),title:esc(getState().workItems[o.workItemId]?.title??o.workItemId),category:esc(label(o.category)),role:esc(o.role),outcome:esc(o.outcome),standing:esc(o.standing),disputed:o.disputed?' · disputed':'',result:esc(o.reportedResult),environment:o.environmentLimit?uiText('workFit.environment',{text:esc(o.environmentLimit)}):'',coaching:o.coaching?uiText('workFit.coaching',{text:esc(o.coaching)}):'',author:esc(getState().members[o.actorMemberId]?.displayName??o.actorMemberId),at:esc(o.at),configuration:o.configurationId?'configuration scoped':'unknown configuration',corrections:o.corrections.map(c=>uiText('workFit.correction',{text:esc(c.reason)})).join(''),responses:o.responses.map(r=>uiText('workFit.response',{stance:esc(r.stance),text:esc(r.response),author:esc(r.actorMemberId)})).join(''),id:esc(o.id)})).join('')||uiText('workFit.emptyEvidence')});
  const feedback=$('#work-fit-feedback'),old=feedback.elements.source.value;
  feedback.elements.source.replaceChildren(...sources().map(s=>new Option([s.title,s.role].join(' · '),s.sourceEventId)));
  if([...feedback.elements.source.options].some(o=>o.value===old))feedback.elements.source.value=old;
  else if(old){const unavailable=new Option(uiText('workFit.sourceUnavailable'),old,true,true);unavailable.disabled=true;feedback.elements.source.add(unavailable);}
  feedback.querySelector('[type=submit]').disabled=!sources().some(s=>s.sourceEventId===feedback.elements.source.value);
  const assessment=$('#work-fit-assessment form'),oldCase=assessment.elements.caseId.value;
  assessment.elements.caseId.replaceChildren(...observations.filter(o=>!o.disputed && o.standing!=='superseded').map(o=>new Option([getState().workItems[o.workItemId]?.title??o.workItemId,label(o.category)].join(' · '),o.id)));
  if([...assessment.elements.caseId.options].some(o=>o.value===oldCase))assessment.elements.caseId.value=oldCase;
  else if(oldCase){const unavailable=new Option(uiText('workFit.caseUnavailable'),oldCase,true,true);unavailable.disabled=true;assessment.elements.caseId.add(unavailable);}
  assessment.querySelector('[type=submit]').disabled=!observations.some(o=>o.id===assessment.elements.caseId.value && !o.disputed && o.standing!=='superseded');
  $('#work-fit-response').hidden=!selectedObservation;
  $('#work-fit-more').hidden=!profile.nextCursor;
 }
 async function read(more=false){
  if(loading)return;loading=true;const stamp=context(),ticket=view;
  status('Loading…');
  try{const q=new URLSearchParams({memberId:$('#work-fit-member').value,detail:'evidence'});if(more && profile?.nextCursor)q.set('cursor',profile.nextCursor);
   const next=await client.request([path(),q].join('?'));if(!current(stamp,ticket))return;
   profile=next;observations=more?[...observations,...next.observations]:next.observations;if(selectedObservation)selectedObservation=observations.find(o=>o.id===selectedObservation.id)??null;paint();status('');
  }catch(e){if(current(stamp,ticket))status(e.message);}finally{if(ticket===view)loading=false;}
 }
 async function save(input){
  if(pending && input){status(uiText('workFit.retryFirst'));return;}
  pending??=input;pendingWorker();const stamp=context(),ticket=view;
  $('#work-fit-retry').hidden=false;status('Saving…');
  try{await client.request(path(),{method:'POST',data:pending});if(!current(stamp,ticket))return;
   pending=null;pendingWorker();$('#work-fit-retry').hidden=true;view++;loading=false;await read();if(stamp===context() && dialog.open)status('Saved.');
  }catch(e){if(current(stamp,ticket)){status(e.message);if(e.status>=400 && e.status<500){pending=null;pendingWorker();$('#work-fit-retry').hidden=true;}}}
 }
 const resetView=()=>{view++;loading=false;profile=null;observations=[];selectedObservation=null;$('#work-fit-response').hidden=true;$('#work-fit-content').replaceChildren();};
 button.onclick=()=>{
  sync();const selected=$('#work-fit-member').value;
  $('#work-fit-member').replaceChildren(...Object.values(getState().members).filter(m=>m.active).map(m=>new Option(m.displayName,m.id)));
  $('#work-fit-member').value=getState().members[selected]?.active?selected:getSession().member.id;
  pendingWorker();dialog.showModal();void read();
 };
 dialog.querySelector('[data-close]').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{view++;loading=false;button.focus({preventScroll:true});});
 $('#work-fit-member').onchange=()=>{resetView();interestsDirty=false;for(const form of dialog.querySelectorAll('form'))form.reset();void read();};
 $('#work-fit-preferences').onchange=()=>{interestsDirty=true;};
 $('#work-fit-refresh').onclick=()=>{void read();};$('#work-fit-more').onclick=()=>{void read(true);};$('#work-fit-retry').onclick=()=>{void save();};
 $('#work-fit-preferences').onsubmit=e=>{e.preventDefault();if(!profile)return;void save({action:'update_self',requestId:crypto.randomUUID(),expectedRevision:profile.selfRevision,preferences:{...profile.preferences,learn:[...e.target.querySelectorAll('input:checked')].map(i=>i.value)}});};
 $('#work-fit-feedback').onsubmit=e=>{
  e.preventDefault();const f=e.target.elements,s=sources().find(s=>s.sourceEventId===f.source.value);if(!s || !profile)return;
  void save({action:'record_observation',requestId:crypto.randomUUID(),subjectMemberId:profile.memberId,configurationId:null,category:f.category.value,role:s.role,workItemId:s.workItemId,sourceEventId:s.sourceEventId,expectedResult:f.expectedResult.value,reportedResult:f.reportedResult.value,outcome:f.outcome.value,...(f.environmentLimit.value?{environmentLimit:f.environmentLimit.value}:{}),...(f.coaching.value?{coaching:f.coaching.value}:{})});
 };
 $('#work-fit-assessment form').onsubmit=e=>{
  e.preventDefault();const f=e.target.elements,o=observations.find(o=>o.id===f.caseId.value);if(!o || !profile)return;
  const a=profile.assessments.find(a=>a.category===o.category && a.role===o.role && a.configurationId===o.configurationId && a.actorMemberId===getSession().member.id);
  void save({action:'update_assessment',requestId:crypto.randomUUID(),subjectMemberId:profile.memberId,expectedRevision:a?.revision??0,category:o.category,role:o.role,configurationId:o.configurationId,tendency:f.tendency.value,advice:f.advice.value,caseIds:[o.id]});
 };
 $('#work-fit-content').onclick=e=>{
  const work=e.target.closest('[data-work]');if(work){dialog.close();openWork(work.dataset.work);return;}
  const action=e.target.closest('[data-observation]');if(!action)return;
  selectedObservation=observations.find(o=>o.id===action.dataset.observation);const f=$('#work-fit-response');
  f.hidden=false;f.elements.action.options[1].disabled=selectedObservation.actorMemberId!==getSession().member.id;f.elements.action.value='respond_observation';f.elements.text.focus();
 };
 $('#work-fit-response').onsubmit=e=>{
  e.preventDefault();const f=e.target.elements,o=selectedObservation;if(!o)return;
  const shared={action:f.action.value,requestId:crypto.randomUUID(),subjectMemberId:profile.memberId,observationId:o.id};
  void save(f.action.value==='respond_observation'?{...shared,response:f.text.value,stance:f.stance.value}:{...shared,expectedObservationRevision:o.revision,reportedResult:f.text.value,outcome:f.outcome.value,reason:f.reason.value,...(o.environmentLimit?{environmentLimit:o.environmentLimit}:{}),...(o.coaching?{coaching:o.coaching}:{})});
 };
 function sync(){
  const next=context();if(next!==boundary){boundary=next;resetView();pending=null;pendingWorker();interestsDirty=false;$('#work-fit-retry').hidden=true;for(const form of dialog.querySelectorAll('form'))form.reset();if(dialog.open)dialog.close();}
  button.disabled=!getState() || !getSession()?.member;
 }
 return {sync};
}
