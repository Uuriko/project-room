import{NativeInboxProbe}from'./current-native-inbox-worker.test-fixture.mjs';import{readConversation}from'../server/conversation-sync.mjs';import{auditRecovery}from'../server/recovery.mjs';
export class CurrentDmConsentProbe extends NativeInboxProbe{
 async fetch(request){const u=new URL(request.url),s=this.store,db=this.db;try{if(u.pathname==='/prepare')return super.fetch(new Request('http://localhost/seed?count=32'));s.room=()=>{throw Error('full room hydration');};let result;
 if(u.pathname==='/request')result=s.dmConsents.request('commons','worker','other','Private useful context');
 else if(u.pathname==='/approve'){result=s.dmConsents.decide('commons','other','worker','approve');if(u.searchParams.has('lost'))return Response.json({lostAfterCommit:true},{status:503});}
 else if(u.pathname==='/state')result=s.dmConsents.list('commons','worker');
 else if(u.pathname==='/post'){const id=u.searchParams.has('new')?'new-dm':'saved-dm';result=s.command(await this.ctx.storage.get('key'),'commons',{id,type:'message.posted',data:{messageId:id,body:'Useful saved DM',toMemberId:'other'}});}
 else if(u.pathname==='/revoke')result=s.dmConsents.revoke('commons','other','worker');
 else if(u.pathname==='/history')result=readConversation(s,await this.ctx.storage.get('key'),'commons',{messageId:'saved-dm'});
 else if(u.pathname==='/fault'){const tables=['rooms','dm_consents','events','commands','current_room_head','current_room_records','current_room_record_proofs','operator_actions'],snapshot=()=>JSON.stringify(Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t).all()]))),before=snapshot(),prepare=db.prepare.bind(db);let fired=false;db.prepare=sql=>new Proxy(prepare(sql),{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const value=fn.apply(target,args);if(/^INSERT INTO current_room_head/.test(sql.trim())){fired=true;throw Error('synthetic consent persist fault');}return value;};}});try{s.dmConsents.block('commons','other','worker');throw Error('fault not reached');}catch(error){result={fired,message:error.message};}finally{db.prepare=prepare;}result.unchanged=before===snapshot();}
 else if(u.pathname==='/audit'){auditRecovery(s);result={ok:true,permit:db.prepare('SELECT enabled,room_id,receipt_id FROM current_room_writer_permit').get()};}else return super.fetch(request);
 return Response.json({result});}catch(error){return Response.json({error:{message:error.message,code:error.code,status:error.status,stack:error.stack}},{status:error.status??500});}}
}
export default{fetch(request,env){return env.ROOM.getByName('dm').fetch(request);}};
