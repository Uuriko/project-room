// Host configuration only; no browser credential intake or address reassignment.
export function createTwilioConnections({store,registry,connections}) {
  const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
  if(!Array.isArray(connections)||connections.length>100||connections.some(c=>!id(c.accountId)||!id(c.connectionId)||!['sms','whatsapp'].includes(c.provider))
    ||new Set(connections.map(c=>JSON.stringify([c.accountId,c.connectionId]))).size!==connections.length)throw new Error('twilio_configuration_invalid');
  const configured=connections.map(c=>({...c}));
  const auth=session=>store.authenticateAccountSession(session.token,null,session.binding);
  return {
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
