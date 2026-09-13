import { createTelegramReceiver,createTelegramBackgroundReceiver } from './telegram-receiver.mjs';

// Trusted host wiring only. No credential/configuration input from HTTP callers.
export function createTelegramConnections({store,registry,connections,fetchImpl=fetch,receiveGrants=null}) {
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const validRevision=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;
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
    receivingStatus(session){
      const current=auth(session);
      if(!receiveGrants)return {enabled:false,connections:[]};
      return {enabled:true,connections:connections.filter(c=>c.accountId===current.account.id).map(c=>{
        const state=registry.status({accountId:current.account.id,connectionId:c.connectionId,authEpoch:current.account.authEpoch});
        const grant=receiveGrants.status(session,c.connectionId);
        return {...grant,provider:'telegram',expectedConnectionRevision:state.revision,canStart:state.state==='active',
          state:grant.state==='active'&&(state.state!=='active'||state.revision!==grant.connectionRevision)?'reauthorize':grant.state};
      })};
    },
    startReceiving(session,data){
      if(!receiveGrants||!exact(data,['connectionId','expectedRevision','expectedConnectionRevision'])
        ||!validRevision(data.expectedRevision)||!validRevision(data.expectedConnectionRevision)||data.expectedConnectionRevision<1)throw new Error('telegram_receiving_invalid');
      const b=binding(session,data.connectionId);
      return registry.withGrant(b,connection=>{
        if(connection.revision!==data.expectedConnectionRevision)throw new Error('telegram_connection_changed');
        const grant=receiveGrants.issue(session,{connectionId:b.connectionId,provider:'telegram',connectionRevision:connection.revision,
          expectedRevision:data.expectedRevision,expiresAt:store.now()+86400000});
        return {connectionId:grant.connectionId,revision:grant.revision,state:grant.state,expiresAt:grant.expiresAt};
      });
    },
    stopReceiving(session,data){
      if(!receiveGrants||!exact(data,['connectionId','expectedRevision']))throw new Error('telegram_receiving_invalid');
      binding(session,data.connectionId);
      const grant=receiveGrants.revoke(session,data);
      return {connectionId:grant.connectionId,revision:grant.revision,state:grant.state,expiresAt:grant.expiresAt};
    },
    // Host scheduler only; deliberately not exposed as an HTTP action.
    async syncReceiving(accountId,connectionId){
      const c=connections.find(c=>c.accountId===accountId&&c.connectionId===connectionId);
      if(!c||!receiveGrants)throw new Error('telegram_receiving_unavailable');
      const account=store.account(accountId),b={accountId,connectionId,authEpoch:account.authEpoch};
      const current=registry.withGrant(b,connection=>receiveGrants.currentBinding({accountId,connectionId,provider:'telegram',connectionRevision:connection.revision}));
      return createTelegramBackgroundReceiver({store,queue:c.queue,registry,grants:receiveGrants,binding:current,fetchImpl}).sync();
    },
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
