const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const revision=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;

// Reuses the Inbox client's account/session-bound request and response fencing.
export function messagingConnectionsClient(inbox) {
  return {
    twilioStatus() {
      return inbox.request('/connections/twilio',{},value=>typeof value.enabled==='boolean'&&Array.isArray(value.connections)
        &&value.connections.length<=100&&value.connections.every(c=>c!==null&&typeof c==='object')
        &&new Set(value.connections.map(c=>c.connectionId)).size===value.connections.length
        &&value.connections.every(c=>id(c.connectionId)&&revision(c.revision)&&['sms','whatsapp'].includes(c.provider)
          &&['active','disconnected','missing','reauthorize'].includes(c.state)));
    },
    twilioDisconnect(data) {
      if(!id(data?.connectionId)||!revision(data.expectedRevision)||data.expectedRevision<1)
        throw new Error('invalid_messaging_action');
      return inbox.request('/connections/twilio/disconnect',{method:'POST',data},value=>value.connectionId===data.connectionId
        &&value.revision===data.expectedRevision+1&&value.state==='disconnected');
    }
  };
}
