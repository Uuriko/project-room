import {ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {runLiveStoreRetention} from '../server/retention-run.mjs';
export class Profile extends ProjectRoom {
 async cursorProof() {
  this.store.initialize(initialRoom('profile'));
  const db = this.store.db;
  const insert = db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id,idempotency_key,subscription_id,agent_id,event_type,payload_json,signature,state,attempts,next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,'agent','message.posted','{}','synthetic','delivered',0,0,?,0)`);
  this.store.transaction(() => {
    for (let i=0;i<500;i++) insert.run('protected'+i,'protected'+i,'quiet'+i,0);
    for (let i=0;i<120;i++) insert.run('later'+i,'later'+i,'busy',1);
  });
  const first = (await this.planRetention()).webhookDeliveries;
  const checkpoint = await this.ctx.storage.get('retention-webhook-cursor');
  db.exec("CREATE TRIGGER retention_test_failure BEFORE DELETE ON agent_webhook_deliveries BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
  let failed = false;
  try { await this.planRetention(); } catch { failed = true; }
  const afterFailure = await this.ctx.storage.get('retention-webhook-cursor');
  db.exec('DROP TRIGGER retention_test_failure');
  this.store.agentPlugin.webhookRetentionCursor = null;
  const second = (await this.planRetention()).webhookDeliveries;
  const afterSuccess = await this.ctx.storage.get('retention-webhook-cursor');
  await this.ctx.storage.put('retention-webhook-cursor', {createdAt:'invalid'});
  const reset = (await this.planRetention()).webhookDeliveries;
  return {first, checkpoint, failed, afterFailure, second, afterSuccess, reset};
 }

 measure(n, terminal = false, spread = false) {
  this.store.initialize(initialRoom('profile'));
  const db=this.store.db;
  this.store.transaction(()=>{
   db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO web_fetch_log(request_id,room_id,member_id,host,cache_status,bytes,tags_json,created_at) SELECT 'r'||x,'profile','owner','example.invalid','hit',0,'[]',0 FROM n`).run(n);
   db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO agent_webhook_deliveries(delivery_id,idempotency_key,subscription_id,agent_id,event_type,payload_json,signature,state,attempts,next_attempt_at,created_at,updated_at) SELECT printf('d%08d',x),'i'||x,${spread ? "'sub'||x" : "'sub'"},'agent','message.posted','{}','synthetic',?,0,0,0,0 FROM n`).run(n, terminal ? 'delivered' : 'pending');
  });
  if (spread) this.store.transaction(() => {
   db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500),
     m(y) AS (VALUES(1) UNION ALL SELECT y+1 FROM m WHERE y<100)
     INSERT INTO agent_webhook_deliveries(delivery_id,idempotency_key,subscription_id,agent_id,event_type,payload_json,signature,state,attempts,next_attempt_at,created_at,updated_at)
     SELECT 'recent-'||x||'-'||y,'recent-'||x||'-'||y,'sub'||x,'agent','message.posted','{}','synthetic','pending',0,0,?,0 FROM n,m`).run(Date.now());
  });
  const plans=db.prepare('EXPLAIN QUERY PLAN SELECT request_id AS id FROM web_fetch_log WHERE created_at<? ORDER BY created_at,request_id LIMIT ?').all(Date.now(),100).map(r=>r.detail);
  let before=db.rowsRead;const retained=runLiveStoreRetention({store:this.store,env:{ROOM_RETENTION_ALLOW_DELETION:'0'},now:new Date().toISOString()});const logRowsRead=db.rowsRead-before;
  before=db.rowsRead;const pruned=this.store.agentPlugin.pruneWebhookDeliveries();const webhookRowsRead=db.rowsRead-before;
  return {seeded:n,logRowsRead,eligible:retained.categories.web_fetch_log.eligible,webhookRowsRead,webhookDeleted:pruned.deleted,examined:pruned.examined,plans};
 }
}
export default { async fetch(request, env) { const url = new URL(request.url); if (url.pathname === '/cursor') return Response.json(await env.ROOM.getByName('cursor').cursorProof()); const n = Number(url.searchParams.get('n')); const terminal = url.searchParams.get('terminal') === '1'; const spread = url.searchParams.get('spread') === '1'; return Response.json(await env.ROOM.getByName('profile'+n+terminal+spread).measure(n, terminal, spread)); } };
