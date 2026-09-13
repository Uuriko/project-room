// Host configuration only; no browser credential intake or address reassignment.
export function createTwilioConnections({store,registry,connections,receiveGrants=null}) {
  const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
  if(!Array.isArray(connections)||connections.length>100||connections.some(c=>!id(c.accountId)||!id(c.connectionId)||!['sms','whatsapp'].includes(c.provider))
    ||new Set(connections.map(c=>JSON.stringify([c.accountId,c.connectionId]))).size!==connections.length)throw new Error('twilio_configuration_invalid');
  const configured=connections.map(c=>({...c}));
  const auth=session=>store.authenticateAccountSession(session.token,null,session.binding);
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const rev=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;
  const selected=(session,connectionId)=>{
    const current=auth(session),c=configured.find(c=>c.accountId===current.account.id&&c.connectionId===connectionId);
    if(!receiveGrants||!c)throw new Error('receiving_unavailable');return {current,c};
  };
  return {
    receivingStatus(session){
      const current=auth(session);
      if(!receiveGrants)return {enabled:false,connections:[]};
      return {enabled:true,connections:configured.filter(c=>c.accountId===current.account.id).map(c=>{
        const connection=registry.status({accountId:current.account.id,connectionId:c.connectionId,authEpoch:current.account.authEpoch});
        const grant=receiveGrants.status(session,c.connectionId);
        return {...grant,provider:c.provider,expectedConnectionRevision:connection.revision,
          canStart:connection.state==='active',
          state:grant.state==='active'&&(connection.state!=='active'||connection.revision!==grant.connectionRevision)?'reauthorize':grant.state};
      })};
    },
    startReceiving(session,data){
      if(!exact(data,['connectionId','expectedRevision','expectedConnectionRevision'])||!id(data.connectionId)
        ||!rev(data.expectedRevision)||!rev(data.expectedConnectionRevision)||data.expectedConnectionRevision<1)throw new Error('receiving_invalid');
      const {current,c}=selected(session,data.connectionId);
      return registry.withGrant({accountId:current.account.id,authEpoch:current.account.authEpoch,
        connectionId:c.connectionId,expectedRevision:data.expectedConnectionRevision},connection=>{
        const provider=connection.addresses[0].startsWith('whatsapp:')?'whatsapp':'sms';
        if(provider!==c.provider)throw new Error('receiving_invalid');
        const grant=receiveGrants.issue(session,{connectionId:c.connectionId,provider,
          connectionRevision:data.expectedConnectionRevision,expectedRevision:data.expectedRevision,expiresAt:store.now()+86400000});
        return {connectionId:grant.connectionId,revision:grant.revision,state:grant.state,expiresAt:grant.expiresAt};
      });
    },
    stopReceiving(session,data){
      if(!exact(data,['connectionId','expectedRevision'])||!id(data.connectionId)||!rev(data.expectedRevision)||data.expectedRevision<1)throw new Error('receiving_invalid');
      selected(session,data.connectionId);
      const grant=receiveGrants.revoke(session,data);
      return {connectionId:grant.connectionId,revision:grant.revision,state:grant.state,expiresAt:grant.expiresAt};
    },
    list(session) {
      const current=auth(session);
      return configured.filter(c=>c.accountId===current.account.id).map(c=>({connectionId:c.connectionId,provider:c.provider,
        ...registry.status({accountId:current.account.id,connectionId:c.connectionId,authEpoch:current.account.authEpoch})}));
    },
    disconnect(session,connectionId,expectedRevision) {
      const current=auth(session),c=configured.find(c=>c.accountId===current.account.id&&c.connectionId===connectionId);
      if(!c)throw new Error('twilio_connection_unavailable');
      const result=registry.disconnect({accountId:current.account.id,connectionId,authEpoch:current.account.authEpoch,expectedRevision});
      return {connectionId,...result};
    }
  };
}
