import {httpServerHandler} from 'cloudflare:node';
import {CurrentEventsRoom} from './current-events-worker.test-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from '../tests/helpers/scoped-inbox-source.mjs';

export class FormalDeliveryRoom extends CurrentEventsRoom {
  async fetch(request) {
    const url=new URL(request.url), store=this.store;
    if(url.pathname==='/__seed') {
      const f=seedScopedInbox(store);
      if(url.searchParams.get('large')==='1'){
        let now=Date.now();store.now=()=>now;
        for(let n=0;n<30;n++){now+=2001;store.command(f.owner,'commons',{id:'large-'+n,type:'message.posted',data:{messageId:'large-'+n,body:'x'.repeat(12000),toMemberId:'worker'}});}
      }
      return Response.json({credential:f.token,identityId:f.identityId});
    }
    if(url.pathname==='/__sequence') return Response.json(store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('commons'));
    store.room=()=>{throw Error('Whole-room hydration forbidden');};
    this.http??=httpServerHandler(createRoomServer({store,origin:'http://localhost',assetRoot:new URL('https://assets.invalid/'),loadAsset:async()=>{throw Error('No fixture assets');}}));
    const forwarded=new Request('http://localhost'+url.pathname+url.search,request);
    forwarded.headers.set('host','localhost');
    return this.http.fetch(forwarded);
  }
}
export default {fetch:(request,env)=>env.ROOM.getByName('formal').fetch(request)};
