import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {PUBLIC_WORK_STARTER_SEED_IDS} from '../server/public-work-claims.mjs';
import {withPublicWorkClaimWriter} from '../server/public-work-claim-fence.mjs';
const bytes=value=>value==null?0:typeof value==='string'?new TextEncoder().encode(value).length:value instanceof ArrayBuffer?value.byteLength:ArrayBuffer.isView(value)?value.byteLength:new TextEncoder().encode(String(value)).length;
export class ReseedSchedulingRoom extends ProjectRoom{
 async fetch(request){const u=new URL(request.url),store=this.store,db=store.db;
  if(u.pathname==='/seed'){
   const count=Number(u.searchParams.get('count')),anchored=u.searchParams.get('anchored')==='1';if(![0,1000,5000].includes(count))throw Error('invalid qualification size');store.initialize(initialRoom());
   const terms=JSON.stringify({kind:'task',title:'Synthetic closed work',summary:'Qualified scheduler source',acceptanceCriteria:['Save useful work'],reward:{kind:'unpaid'},approvalPolicy:{mode:'human'},repositoryUrl:'https://github.com/uuriko/project-room',deadline:'2020-01-01T00:00:00.000Z'});
   withPublicWorkClaimWriter(store,()=>store.transaction(()=>{
    const insert=id=>{db.prepare('INSERT INTO project_offers VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'commons','owner',1,1,'published',terms,'{}',1,1);db.prepare('INSERT INTO public_work_tasks VALUES(?,?,?,?,?,?,?,?,?)').run(id,'public_fixture','commons',1,'https://github.com/uuriko/project-room','main','[]',0,1);db.prepare('INSERT INTO work_claims VALUES(?,?,?,?)').run('public_fixture',id,JSON.stringify({id,state:'unclaimed',owner:null}),1);};
    for(let n=0;n<count;n++)insert('synthetic-'+n);
    if(anchored){for(const id of PUBLIC_WORK_STARTER_SEED_IDS)insert(id);db.prepare('INSERT INTO public_work_receipts VALUES(?,?,?,?,?,?,?,?,?,?)').run('synthetic-receipt',PUBLIC_WORK_STARTER_SEED_IDS[0],'public_fixture',0,'synthetic-agent','done','0'.repeat(64),4,'{}',1);}
   }));return Response.json({count,anchored});
  }
  const cost={statements:0,rowsRead:0,rowsWritten:0,unknown:0,returnedRows:0,returnedBytes:0,sqlBytes:0,bindBytes:0,candidates:0},prepare=db.prepare.bind(db),observe=db.observeStatement,record=store.projectOffers.record.bind(store.projectOffers);
  const receive=row=>{if(row!==undefined){cost.returnedRows++;for(const v of Object.values(row))cost.returnedBytes+=bytes(v);}return row;};
  db.observeStatement=()=>sample=>{cost.statements++;for(const k of ['rowsRead','rowsWritten'])if(sample[k]===null)cost.unknown++;else cost[k]+=sample[k];};
  db.prepare=sql=>{cost.sqlBytes+=bytes(sql);const statement=prepare(sql);return new Proxy(statement,{get(target,key){if(['get','all','iterate'].includes(key))return(...args)=>{cost.bindBytes+=args.reduce((n,v)=>n+bytes(v),0);const result=target[key](...args);if(key==='get')return receive(result);if(key==='all')return result.map(receive);return(function*(){for(const row of result)yield receive(row);})();};const value=target[key];return typeof value==='function'?value.bind(target):value;}});};store.projectOffers.record=row=>{cost.candidates++;return record(row);};
  let pending;try{pending=store.publicWorkClaims.starterPoolPending();}finally{db.prepare=prepare;db.observeStatement=observe;store.projectOffers.record=record;}
  return Response.json({pending,cost});
 }
}
export default{fetch(request,env){const u=new URL(request.url);return env.ROOM.getByName(u.searchParams.get('case')??'test').fetch(request);}};
