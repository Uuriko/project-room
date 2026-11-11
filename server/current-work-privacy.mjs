import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
export const emptyWorkPrivacy=()=>({version:1,requests:0,parties:{}});
export function validateWorkPrivacy(value) {
  if(!value||value.version!==1||!Number.isSafeInteger(value.requests)||value.requests<0||!value.parties||typeof value.parties!=='object'||Array.isArray(value.parties)
    ||Object.keys(value).some(key=>!['version','requests','parties'].includes(key)))throw Error('current_room_corrupt: missing qualified work privacy');
  for(const [id,count] of Object.entries(value.parties))if(!id||!Number.isSafeInteger(count)||count<1||count>value.requests)throw Error('current_room_corrupt: private party count differs');
  if((value.requests===0)!==(Object.keys(value.parties).length===0))throw Error('current_room_corrupt: private request count differs');
  return value;
}
export function applyWorkPrivacyRequest(value,request,delta) {
  validateWorkPrivacy(value);
  const parties=new Map(Object.entries(value.parties)),requests=value.requests+delta;
  for(const id of new Set([request.requesterId,request.recipientId])) {
    if(typeof id!=='string'||!id)throw Error('current_room_corrupt: private request party missing');
    const count=(parties.get(id)??0)+delta;if(count<0)throw Error('current_room_corrupt: private party underflow');
    if(count)parties.set(id,count);else parties.delete(id);
  }
  return validateWorkPrivacy({version:1,requests,parties:Object.fromEntries([...parties].sort(([a],[b])=>a<b?-1:a>b?1:0))});
}
export const workRequestPrefix=workId=>digest(workId)+'\0';
export const workRequestKey=(workId,requestId)=>workRequestPrefix(workId)+digest(requestId);
export const workRequestValue=(workId,requestId)=>({workItemId:workId,requestId});
export function deriveWorkPrivacy(state) {
  const privacy=new Map(Object.keys(state.workItems??{}).map(id=>[id,emptyWorkPrivacy()])),links=new Map();
  for(const [requestId,request] of Object.entries(state.replyRequests??{}))if(typeof request?.workItemId==='string'&&request.workItemId) {
    const id=request.workItemId;privacy.set(id,applyWorkPrivacyRequest(privacy.get(id)??emptyWorkPrivacy(),request,1));
    links.set(workRequestKey(id,requestId),workRequestValue(id,requestId));
  }
  return {privacy,links};
}
