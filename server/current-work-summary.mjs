// Read projection only: no result prose, definitions, source messages, histories,
// execution permissions or new authority. Shared selectors still decide next steps.
const pick=(value,keys)=>value==null?value:Object.fromEntries(keys.split(' ').filter(key=>Object.hasOwn(value,key)).map(key=>[key,structuredClone(value[key])]));
export function thinWorkForContext(item) {
  const out=pick(item,'id title state revision mode createdAt updatedAt accountableMemberId verifierMemberId humanDecisionMakerId proposedById externalWriteGrantBy externalWriteGrantFor independentVerificationRequired ownerDecisionRequired supersededBy status stop_requested_at heartbeat_at worker_member_id started_at attempt_count spend_cents round_count tool_calls suspended_by');
  for(const [key,fields] of Object.entries({
    blocker:'reason',
    claim:'holderId repository ref paths expiresAt status',
    receipt:'eventId evidenceVersion evidenceUrl producerId producerAttribution reportedById',
    verification:'eventId actorId verifierId result completionEventId evidenceVersion independenceConfirmed',
    decision:'eventId actorId decision completionEventId evidenceVersion',
    handoff:'open eventId at actorId triageMemberId nextAction limitReason haltAll evidenceUrl evidenceVersion'
  }))if(Object.hasOwn(item,key))out[key]=pick(item[key],fields);
  if(out.claim){const expiresAtMs=Date.parse(out.claim.expiresAt);out.claim.expiresAtMs=Number.isFinite(expiresAtMs)?expiresAtMs:null;}
  return out;
}
export const currentWorkSummary=(item,ref)=>({ref,work:thinWorkForContext(item)});
