import { createHash } from 'node:crypto';
import { receiveTelegramTick } from './telegram-receive-tick.mjs';
import { importTelegramPage, importTelegramBackgroundPage } from './telegram-inbox-import.mjs';

export function createTelegramBackgroundReceiver({store,queue,registry,grants,binding,fetchImpl=fetch}){
  const pinned=Object.freeze({...binding});
  const withAuthority=fn=>{
    const account=store.account(pinned.accountId);
    return registry.withGrant({accountId:account.id,connectionId:pinned.connectionId,authEpoch:account.authEpoch},connection=>
      grants.withGrant(pinned,lease=>{
        if(lease.provider!=='telegram'||connection.revision!==lease.connectionRevision
          ||queue.accountId!==lease.accountId||queue.connectionId!==lease.connectionId||queue.authEpoch!==lease.authEpoch)
          throw new Error('telegram_grant_unavailable');
        return fn(connection,lease);
      }));
  };
  const authorize=()=>withAuthority((connection,lease)=>({...connection,receiveRevision:lease.revision,receiveExpiresAt:lease.expiresAt}));
  authorize();
  return {async sync(){
    let imported=0;
    const result=await receiveTelegramTick({queue,authorize,fetchImpl,commitPage(page,{assertLease}){
      const receipt=withAuthority((connection,lease)=>importTelegramBackgroundPage(store,lease,connection,page,assertLease));
      imported+=receipt.imported;return {committed:true};
    }});
    return {...result,imported};
  }};
}

// getGrant MUST synchronously read trusted current connection authority, ideally
// from the same RoomStore transaction. Never supply browser request data here.
export function createTelegramReceiver({ store, queue, token, sessionBinding, getGrant, withGrant = fn => fn(), fetchImpl = fetch }) {
  const fingerprint = grant => createHash('sha256').update(JSON.stringify(grant)).digest('hex');
  const initial = getGrant();
  if (!initial || typeof initial.then === 'function') throw new Error('telegram_grant_unavailable');
  const expected = fingerprint(initial);
  const authorize = () => {
    const auth = store.authenticateAccountSession(token,null,sessionBinding), grant = getGrant();
    if (!grant || typeof grant.then === 'function' || grant.active !== true || fingerprint(grant) !== expected
      || grant.accountId !== auth.account.id || grant.authEpoch !== auth.account.authEpoch
      || grant.accountId !== queue.accountId || grant.connectionId !== queue.connectionId || grant.authEpoch !== queue.authEpoch
      || !Array.isArray(grant.chatIds) || !grant.chatIds.length) throw new Error('telegram_grant_unavailable');
    return grant;
  };
  authorize();
  return {
    async sync() {
      let imported = 0;
      const result = await receiveTelegramTick({ queue, authorize, fetchImpl, commitPage(page, { assertLease }) {
        const result = withGrant(() => importTelegramPage(store,{token},{sessionBinding},page, observation => {
          assertLease(); const grant = authorize();
          if (observation && (observation.accountId !== grant.accountId || observation.connectionId !== grant.connectionId
            || !grant.chatIds.includes(Number(observation.conversationId)))) throw new Error('telegram_chat_not_authorized');
        }));
        imported += result.imported;
        return {committed:true};
      }});
      return {...result, imported};
    }
  };
}
