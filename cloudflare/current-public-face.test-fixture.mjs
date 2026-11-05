import {httpServerHandler} from 'cloudflare:node';
import {CurrentEventsRoom} from './current-events-worker.test-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedPublicLobby} from '../tests/helpers/public-lobby-source.mjs';
export class CurrentPublicFaceRoom extends CurrentEventsRoom{
 async fetch(request){
  const url=new URL(request.url),s=this.store;
  if(url.pathname==='/seed'){
   const saved=seedPublicLobby(s,{privateCount:Number(url.searchParams.get('privateCount'))});
   await this.ctx.storage.put('saved',saved);return Response.json({owner:saved.owner});
  }
  s.room=()=>{throw Error('Whole room hydration forbidden');};
  this.http??=httpServerHandler(createRoomServer({store:s,origin:'http://localhost',assetRoot:new URL('https://assets.invalid/'),loadAsset:async()=>{throw Error('No fixture asset');}}));
  const forwarded=new Request('http://localhost'+url.pathname+url.search,request);forwarded.headers.set('host','localhost');
  const before={...this.stats},response=await this.http.fetch(forwarded);
  const headers=new Headers(response.headers);headers.set('X-Fixture-Cost',JSON.stringify(Object.fromEntries(Object.keys(before).map(k=>[k,this.stats[k]-before[k]]))));
  return new Response(response.body,{status:response.status,headers});
 }
}
export default{fetch:(request,env)=>env.ROOM.getByName(new URL(request.url).searchParams.get('surface')??'public').fetch(request)};
