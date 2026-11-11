import entry,{DurableCoverageRoom as Base} from './durable-coverage-native.test-fixture.mjs';
export class DurableCoverageRoom extends Base {
 async fetch(request){
  const path=new URL(request.url).pathname,store=this.store;
  if(path==='/__account-seed'){
   store.createAccount('fixture-account');const key=store.issueAccountAccessKey('fixture-account');
   const slot=store.createAccountSessionSlot(),session=store.loginAccountSession(slot.token,key,0);
   return Response.json({token:slot.token,binding:session.sessionBinding});
  }
  if(path==='/__capacity-on'){this.injectCapacity=true;return Response.json({ok:true});}
  if(path==='/api/account-session'&&this.injectCapacity){
   const sql=this.ctx.storage.sql,original=sql.exec,exec=original.bind(sql);let fired=false;
   sql.exec=(text,...args)=>{if(!fired&&String(text).includes('FROM account_session_slots s')){fired=true;throw Error('SQLITE_TOOBIG');}return exec(text,...args);};
   try{return await super.fetch(request);}finally{sql.exec=original;this.injectCapacity=false;}
  }
  return super.fetch(request);
 }
}
export default entry;
