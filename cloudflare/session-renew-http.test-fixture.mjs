// Local-only fixture: the seed route is never part of production.
import entry,{ProjectRoom} from './room.mjs';
import {hashPassword} from '../src/password-auth.mjs';
export class SessionRenewHttpRoom extends ProjectRoom {
 async fetch(request){
  if(new URL(request.url).pathname==='/__test-aged-slot'){
   const s=this.store;s.createAccount('worker-renew-owner');
   s.accountLogins.linkPasswordMethod('worker-renew-owner',{email:'renew@example.invalid',verifier:hashPassword('synthetic-password-long')});
   const original=s.now;s.now=()=>Date.now()-29*86400000;let slot;
   try{slot=s.createAccountSessionSlot();}finally{s.now=original;}
   return Response.json({token:slot.token,revision:slot.session.sessionRevision});
  }
  return super.fetch(request);
 }
}
export default entry;
