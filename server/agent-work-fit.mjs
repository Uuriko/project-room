// Deterministic projection and explanations; these never authorize work.
export const emptyWorkFit = () => ({revision:0,selfRevision:0,preferences:{prefer:[],learn:[],avoid:[]},configuration:null,configurations:[],observations:[],assessments:[]});
export function projectWorkFit(previous,event) {
  const p=structuredClone(previous), v=event.value;
  p.revision++;
  if(event.redacted)return p;
  if(event.action==='update_self') {p.selfRevision++;p.preferences=v.preferences;if(v.configuration){p.configuration=v.configuration;p.configurations.push(v.configuration);}}
  if(event.action==='record_observation') p.observations.push(v);
  if(event.action==='amend_observation') {
    const i=p.observations.findIndex(o=>o.id===v.id);if(i>=0)p.observations[i]=v;
  }
  if(event.action==='respond_observation') p.observations.find(o=>o.id===v.observationId)?.responses.push(v);
  if(event.action==='update_assessment') {
    const i=p.assessments.findIndex(a=>a.key===v.key && a.actorMemberId===v.actorMemberId);
    if(i<0)p.assessments.push(v);else p.assessments[i]=v;
  }
  return p;
}
export function explainWorkFit(profile,categories=[],role='producer') {
  const configurationId=profile.configuration?.id??null;
  const relevant=profile.assessments.filter(a=>a.role===role && categories.includes(a.category) && a.configurationId===configurationId);
  const mixed=relevant.some(a=>a.tendency==='mixed') || categories.some(c=>new Set(relevant.filter(a=>a.category===c).map(a=>a.tendency)).size>1);
  const support=relevant.some(a=>a.tendency==='needs_support');
  const good=configurationId!==null && categories.length>0 && categories.every(c=>relevant.some(a=>a.category===c && a.tendency==='good_fit'));
  const stretch=categories.some(c=>profile.preferences.learn.includes(c));
  return {advisory:true,role,status:mixed?'unknown':support?'consider_partner':good?'good_fit':stretch?'stretch':'unknown',
    reason:mixed?'Assessments disagree; inspect the cases.':support?'Consider support in the cited areas.':good?'Current-configuration assessments support these categories.':stretch?'This matches a declared learning interest; success is unassessed.':'Not enough applicable evidence or configuration information to assess this work.',
    assessments:relevant.slice(0,6),configurationId};
}
