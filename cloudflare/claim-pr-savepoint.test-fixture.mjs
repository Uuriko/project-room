// Local workerd-only settlement/savepoint regression; never deployed.
import { DurableObject } from 'cloudflare:workers';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createWork, claimWork, ClaimError } from '../server/work-claims.mjs';
import { applyPullRequestWebhook } from '../server/claim-pr-sync.mjs';
import { DurableDatabase, durableStorage } from './storage.mjs';
import { createHmac } from 'node:crypto';
export class ClaimSavepointProbe extends DurableObject {
  async fetch(request) {
    const kind=new URL(request.url).pathname.slice(1);
    const s=new RoomStore(null,{database:new DurableDatabase(this.ctx.storage),storagePlatform:durableStorage});
    s.initialize(initialRoom());
    const url='https://github.com/Uuriko/project-room/pull/7',now=Date.now();
    for(const id of ['target','bad-middle','good-last'])
      s.workClaims.set('commons',claimWork(createWork({id,files:['docs/'+id+'.md'],pullRequest:url},{now,agentId:'owner'}),'owner',{now}));
    const before=s.db.prepare("SELECT * FROM work_claims WHERE room_id='commons' ORDER BY claim_id").all();
    const head=s.headSequence('commons'),stamp=s.eventStamp('commons'),notifications=[],writes=[];
    s.onEventAppended(roomId=>notifications.push({roomId,inTransaction:s.db.isTransaction,head:s.headSequence(roomId)}));
    const prepare=s.db.prepare.bind(s.db);
    const fault=kind==='invalid-claim'?new ClaimError('invalid_claim_input','late invalid claim')
      :Object.assign(new Error('late settlement fault'),kind==='storage'?{code:'EIO'}:{});
    s.db.prepare=sql=>{
      const statement=prepare(sql);
      if(!sql.startsWith('INSERT INTO events VALUES'))return statement;
      const run=statement.run.bind(statement);
      statement.run=(...args)=>{
        const result=run(...args),id=JSON.parse(args[3]).data.workClaim;
        writes.push(id);if(id==='bad-middle')throw fault;return result;
      };
      return statement;
    };
    const payload={action:'closed',pull_request:{html_url:url,merged:true,state:'closed'}},rawBody=JSON.stringify(payload),fixtureSigningMaterial='synthetic-savepoint-worker';
    let out=null,error=null;
    try{out=await applyPullRequestWebhook(s,payload,{rawBody,signature256:'sha256='+createHmac('sha256',fixtureSigningMaterial).update(rawBody).digest('hex'),env: { GITHUB_PR_WEBHOOK_SECRET: fixtureSigningMaterial }});}
    catch(failure){error={code:failure.code??null,message:failure.message};}
    return Response.json({out,error,head,headDelta:s.headSequence('commons')-head,stampDelta:s.eventStamp('commons')-stamp,
      rowsEqual:JSON.stringify(before)===JSON.stringify(s.db.prepare("SELECT * FROM work_claims WHERE room_id='commons' ORDER BY claim_id").all()),
      bad:s.workClaims.get('commons','bad-middle'),notifications,writes});
  }
}
export default {fetch:(request,env)=>env.PROBE.get(env.PROBE.idFromName(new URL(request.url).pathname)).fetch(request)};
