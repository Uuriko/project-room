// Synthetic local qualification doors only; never production routes.
import {ProjectRoom} from './room.mjs';
export class NormalizedExportRoom extends ProjectRoom {
 async fetch(request){
  const s=this.store,path=new URL(request.url).pathname;
  if(path==='/__seed'){
   s.createAccount('export-account');const key=s.issueAccountAccessKey('export-account'),slot=s.createAccountSessionSlot(),session=s.loginAccountSession(slot.token,key,0);
   s.createAccountRoom(slot.token,session.sessionBinding,{roomId:'native-export',title:'Useful work',purpose:'Save results',kind:'personal',displayName:'Owner',start:1});
   const owner=s.issueAccessKey('native-export','owner');
   for(let i=0;i<25;i++)s.command(owner,'native-export',{id:'post-'+i,type:'message.posted',data:{messageId:'post-'+i,body:'Saved public result '+i}});
   s.command(owner,'native-export',{id:'delete-old',type:'message.deleted',data:{messageId:'post-0',expectedMessageRevision:0}});
   return Response.json({owner});
  }
  s.room=()=>{throw Error('forbidden full-room export hydration');};
  return super.fetch(request);
 }
}
export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host','room.example');headers.set('x-room-visitor-ip','192.0.2.1');return env.ROOM.getByName('exports').fetch(new Request(request,{headers}));}};
