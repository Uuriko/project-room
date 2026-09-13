const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const revision=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));

// Reuses the Inbox client's account/session-bound request and response fencing.
export function messagingConnectionsClient(inbox) {
  return {
    receivingStatus() {
      return inbox.request('/connections/twilio/receiving',{},v=>typeof v.enabled==='boolean'&&Array.isArray(v.connections)
        &&v.connections.length<=100&&(!v.enabled?v.connections.length===0:true)
        &&v.connections.every(c=>exact(c,['connectionId','revision','state','expiresAt','connectionRevision','provider','expectedConnectionRevision','canStart'])
          &&id(c.connectionId)&&revision(c.revision)&&revision(c.expectedConnectionRevision)&&typeof c.canStart==='boolean'
          &&['sms','whatsapp'].includes(c.provider)&&['missing','active','revoked','expired','reauthorize'].includes(c.state)
          &&(c.state==='missing'?c.revision===0&&c.expiresAt===null&&c.connectionRevision===null:
            c.revision>0&&Number.isSafeInteger(c.expiresAt)&&c.expiresAt>0&&revision(c.connectionRevision)&&c.connectionRevision>0))
        &&new Set(v.connections.map(c=>c.connectionId)).size===v.connections.length);
    },
    receivingAction(action,data) {
      const fields=action==='start'?['connectionId','expectedRevision','expectedConnectionRevision']:['connectionId','expectedRevision'];
      if(!['start','stop'].includes(action)||!exact(data,fields)||!id(data.connectionId)||!revision(data.expectedRevision)
        ||action==='stop'&&data.expectedRevision<1||action==='start'&&(!revision(data.expectedConnectionRevision)||data.expectedConnectionRevision<1))
        throw new Error('invalid_messaging_action');
      const intent=Object.freeze({...data});
      return inbox.request('/connections/twilio/receiving/'+action,{method:'POST',data:intent},v=>v.connectionId===intent.connectionId
        &&v.revision===intent.expectedRevision+1&&v.state===(action==='start'?'active':'revoked')
        &&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>0);
    },
    twilioStatus() {
      return inbox.request('/connections/twilio',{},value=>typeof value.enabled==='boolean'&&Array.isArray(value.connections)
        &&value.connections.length<=100&&value.connections.every(c=>exact(c,['connectionId','provider','revision','state']))
        &&new Set(value.connections.map(c=>c.connectionId)).size===value.connections.length
        &&value.connections.every(c=>id(c.connectionId)&&revision(c.revision)&&['sms','whatsapp'].includes(c.provider)
          &&['active','disconnected','missing','reauthorize'].includes(c.state)));
    },
    twilioDisconnect(data) {
      if(!exact(data,['connectionId','expectedRevision'])||!id(data.connectionId)||!revision(data.expectedRevision)||data.expectedRevision<1)
        throw new Error('invalid_messaging_action');
      // Pin the user's intent before asynchronous transport; caller mutation must
      // never change which receipt we accept or which action is serialized.
      const intent=Object.freeze({connectionId:data.connectionId,expectedRevision:data.expectedRevision});
      return inbox.request('/connections/twilio/disconnect',{method:'POST',data:intent},value=>value.connectionId===intent.connectionId
        &&value.revision===intent.expectedRevision+1&&value.state==='disconnected');
    }
  };
}
