// Advisory vocabulary and validation shared by transports. No skill gate.
export const WORK_FIT_CATEGORIES = Object.freeze(['human_ui_ux','backend_contracts','auth_privacy_security','adversarial_review','browser_native_qa','research_writing','coordination_release','infrastructure_ci']);
export const WORK_FIT_ROLES = Object.freeze(['producer','reviewer','coordinator']);
export const WORK_FIT_ACTION_FIELDS = Object.freeze({
  update_self:['expectedRevision','preferences','configuration'],
  record_observation:['subjectMemberId','configurationId','category','role','workItemId','sourceEventId','expectedResult','reportedResult','outcome','environmentLimit','coaching'],
  amend_observation:['subjectMemberId','observationId','expectedObservationRevision','reportedResult','outcome','environmentLimit','coaching','reason'],
  respond_observation:['subjectMemberId','observationId','response','stance'],
  update_assessment:['subjectMemberId','expectedRevision','category','role','configurationId','tendency','advice','caseIds']
});
export const fitId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x) && !['constructor','prototype','__proto__'].includes(x);
const text = (x,max) => typeof x === 'string' && x.trim().length>0 && x.length<=max && x.isWellFormed();
const obj = x => x && typeof x==='object' && !Array.isArray(x);
const only = (x,keys) => obj(x) && Object.keys(x).every(k=>keys.includes(k));
const revision = x => Number.isSafeInteger(x) && x>=0;
const categories = x => Array.isArray(x) && x.length<=8 && new Set(x).size===x.length && x.every(c => WORK_FIT_CATEGORIES.includes(c));
export function validWorkFitQuery(x) {
  return only(x,['memberId','detail','cursor','workItemId','categories','role']) && (x.memberId===undefined || fitId(x.memberId))
    && (x.detail===undefined || ['summary','evidence'].includes(x.detail))
    && (x.cursor===undefined || fitId(x.cursor)) && (x.cursor===undefined || x.detail==='evidence')
    && (x.workItemId===undefined || fitId(x.workItemId))
    && (x.role===undefined || fitId(x.workItemId) && WORK_FIT_ROLES.includes(x.role))
    && (x.categories===undefined || fitId(x.workItemId) && categories(x.categories));
}
export function validWorkFitAction(x) {
  if(!obj(x) || !Object.hasOwn(WORK_FIT_ACTION_FIELDS,x.action) || !fitId(x.requestId)
    || !only(x,['action','requestId',...WORK_FIT_ACTION_FIELDS[x.action]])) return false;
  if(x.action==='update_self') return revision(x.expectedRevision)
    && only(x.preferences,['prefer','learn','avoid']) && ['prefer','learn','avoid'].every(k=>categories(x.preferences[k]??[]))
    && (x.configuration===undefined || only(x.configuration,['model','runtime','tools']) && Object.values(x.configuration).every(v=>v===null || text(v,160)));
  if(!fitId(x.subjectMemberId)) return false;
  if(x.action==='respond_observation') return fitId(x.observationId) && text(x.response,600) && ['context','dispute','resolved'].includes(x.stance);
  if(x.action==='amend_observation') return fitId(x.observationId) && revision(x.expectedObservationRevision) && text(x.reason,300)
    && text(x.reportedResult,600) && ['met_expectation','needed_repair','unresolved','not_evaluated'].includes(x.outcome)
    && ['environmentLimit','coaching'].every(k=>x[k]===undefined || x[k]===null || text(x[k],300));
  if(!WORK_FIT_CATEGORIES.includes(x.category) || !WORK_FIT_ROLES.includes(x.role)
    || x.configurationId!==null && !fitId(x.configurationId)) return false;
  if(x.action==='update_assessment') return revision(x.expectedRevision)
    && ['good_fit','needs_support','mixed','unknown'].includes(x.tendency) && text(x.advice,600)
    && Array.isArray(x.caseIds) && x.caseIds.length>0 && x.caseIds.length<=8 && new Set(x.caseIds).size===x.caseIds.length && x.caseIds.every(fitId);
  return fitId(x.workItemId) && fitId(x.sourceEventId) && text(x.expectedResult,600) && text(x.reportedResult,600)
    && ['met_expectation','needed_repair','unresolved','not_evaluated'].includes(x.outcome)
    && ['environmentLimit','coaching'].every(k=>x[k]===undefined || x[k]===null || text(x[k],300));
}
