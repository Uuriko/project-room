import { createTelegramReceiver } from './telegram-receiver.mjs';

// Trusted host wiring only. No credential/configuration input from HTTP callers.
export function createTelegramConnections({store,registry,connections,fetchImpl=fetch}) {
  const auth = session => store.authenticateAccountSession(session.token,null,session.binding);
  const binding = (session,connectionId) => {
    const current=auth(session), configured=connections.find(c=>c.accountId===current.account.id&&c.connectionId===connectionId);
    if(!configured)throw new Error('telegram_connection_unavailable');
    return {accountId:current.account.id,connectionId,authEpoch:current.account.authEpoch};
  };
  const checkRevision = (b,expectedRevision) => {
    const status=registry.status(b);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||status.revision!==expectedRevision||status.state!=='active')throw new Error('telegram_connection_changed');
    return status;
  };
  return {
    list(session) {
      const current=auth(session);
      return connections.filter(c=>c.accountId===current.account.id).map(c=>({connectionId:c.connectionId,...registry.status({accountId:current.account.id,connectionId:c.connectionId,authEpoch:current.account.authEpoch})}));
    },
    async sync(session,connectionId,expectedRevision) {
      const b=binding(session,connectionId);checkRevision(b,expectedRevision);
      const queue=connections.find(c=>c.accountId===b.accountId&&c.connectionId===connectionId).queue;
      const receiver=createTelegramReceiver({store,queue,token:session.token,sessionBinding:session.binding,
        getGrant:()=>registry.grant(b),withGrant:fn=>registry.withGrant(b,fn),fetchImpl});
      const result=await receiver.sync();auth(session);
      return {connectionId,revision:expectedRevision,imported:result.imported};
    },
    disconnect(session,connectionId,expectedRevision) {
      const b=binding(session,connectionId);checkRevision(b,expectedRevision);
      const result=registry.disconnect({...b,expectedRevision});
      return {connectionId,...result};
    }
  };
}
