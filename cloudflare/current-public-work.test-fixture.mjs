import {httpServerHandler} from 'cloudflare:node';
import {CurrentEventsRoom} from './current-events-worker.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';

export class PublicWorkRoom extends CurrentEventsRoom {
  async fetch(request) {
    const url=new URL(request.url),store=this.store,roomId='public-work-room';
    if(url.pathname==='/__seed'){
      store.initialize(initialRoom(roomId),{representation:'normalized-current-v1'});
      const owner=store.issueAccessKey(roomId,'owner');await this.ctx.storage.put('owner',owner);
      const send=(id,type,data)=>store.command(owner,roomId,{id,type,data});
      send('page-on','room.public_page_set',{enabled:true});
      send('producer','member.added',{memberId:'producer',displayName:'Producer',kind:'agent',permissions:[]});
      for(let n=0;n<7;n++){
        send('propose-'+n,'work.proposed',{workItemId:'public-'+n,title:'Public task '+n,
          definitionOfDone:'Save a useful result for task '+n,accountableMemberId:'owner'});
        send('publish-'+n,'work.public_set',{workItemId:'public-'+n,enabled:true});
      }
      send('private','work.proposed',{workItemId:'zz-private',title:'PRIVATE-WORK-MUST-NOT-LEAK',
        definitionOfDone:'PRIVATE-INSTRUCTIONS',accountableMemberId:'owner'});
      send('formerly-public','work.public_set',{workItemId:'zz-private',enabled:true});
      send('private-context','message.posted',{messageId:'private-context',workItemId:'zz-private',toMemberId:'producer',requestKind:'reply',body:'Private work context'});
      return Response.json({ready:true});
    }
    if(url.pathname==='/__withdraw'){
      const owner=await this.ctx.storage.get('owner');
      const mode=url.searchParams.get('mode');
      store.command(owner,roomId,{id:'withdraw-'+mode,type:mode==='archive'?'room.archived':mode==='page'?'room.public_page_set':'work.public_set',
        data:mode==='archive'?{}:mode==='page'?{enabled:false}:{workItemId:'public-0',enabled:false}});
      return Response.json({recorded:true});
    }
    store.room=()=>{throw Error('Whole-room hydration forbidden');};
    this.http??=httpServerHandler(createRoomServer({store,origin:'http://localhost',assetRoot:new URL('https://assets.invalid/'),loadAsset:async()=>{throw Error('No fixture assets');}}));
    const forwarded=new Request('http://localhost'+url.pathname+url.search,request);forwarded.headers.set('host','localhost');
    return this.http.fetch(forwarded);
  }
}
export default {fetch:(request,env)=>env.ROOM.getByName('public-work').fetch(request)};
