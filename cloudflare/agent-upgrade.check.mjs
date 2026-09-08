// Actual old adapter + actual new adapter, in local workerd only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createRuntimePackage } from '../scripts/runtime-package.mjs';
import { frozenRecoveryFixture, v8ConnectionBaseline, v9TextBaseline, v10CharterBaseline, v11ReplyBaseline, v12HelpBaseline, v13OfferBaseline } from '../scripts/frozen-runtime-fixture.mjs';

for (const [sourceVersion, baseline] of [[8, v8ConnectionBaseline], [9, v9TextBaseline], [10, v10CharterBaseline], [11, v11ReplyBaseline], [12, v12HelpBaseline], [13, v13OfferBaseline]]) test(`real Workers v${sourceVersion}→v14 permit replacement, rollback, old-writer refusal and restart`, { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'room-agent-worker-upgrade-')), repository = fileURLToPath(new URL('../', import.meta.url));
  const destination = join(directory, 'old'); let f, mf;
  try {
    createRuntimePackage({ repository, commit: baseline, destination });
    f = (await frozenRecoveryFixture(repository, destination, baseline))(join(directory, 'seed.sqlite'));
    const tables = f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    const rows = tables.flatMap(table => f.store.db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ table, columns: Object.keys(row), values: Object.values(row) })));
    const source = `
      import assert from 'node:assert/strict';
      import { createHash, randomBytes } from 'node:crypto';
      import { RoomStore as OldStore } from ${JSON.stringify(join(destination, 'server/store.mjs'))};
      import { DurableDatabase as OldDatabase, durableStorage as oldStorage } from ${JSON.stringify(join(destination, 'cloudflare/storage.mjs'))};
      import { RoomStore } from ${JSON.stringify(join(repository, 'server/store.mjs'))};
      import { AgentConnections } from ${JSON.stringify(join(repository, 'server/agent-connections.mjs'))};
      import { DurableDatabase, durableStorage } from ${JSON.stringify(join(repository, 'cloudflare/storage.mjs'))};
      import { auditRecovery } from ${JSON.stringify(join(repository, 'server/recovery.mjs'))};
      export class UpgradeRoom {
        constructor(ctx, env) { this.ctx=ctx; this.env=env; this.old=new OldDatabase(ctx.storage); this.cached=this.old.prepare('UPDATE accounts SET revision=revision WHERE id=?'); }
        async fetch(request) {
          const path=new URL(request.url).pathname, sql=this.ctx.storage.sql, f=JSON.parse(this.env.OWNER);
          const current=()=>new RoomStore(null,{database:new DurableDatabase(this.ctx.storage),storagePlatform:durableStorage});
          const version=()=>durableStorage.version(this.old), permit=()=>sql.exec('SELECT version FROM room_writer_permit').one().version;
          const catalog=()=>sql.exec("SELECT name,sql FROM sqlite_master WHERE name NOT GLOB '_cf_*' ORDER BY name").toArray();
          const data=()=>Object.fromEntries(JSON.parse(this.env.TABLES).map(table=>[table,sql.exec('SELECT * FROM '+table).toArray()]));
          const oldWrite=()=>this.cached.run(f.session.account.id);
          if(path==='/seed') {
            const old=new OldStore(null,{database:this.old,storagePlatform:oldStorage});
            old.transaction(()=>{for(const row of JSON.parse(this.env.ROWS))this.old.prepare('INSERT INTO '+row.table+'('+row.columns.join(',')+') VALUES('+row.columns.map(()=>'?').join(',')+')').run(...row.values);});
            assert.equal(oldWrite().changes,1); assert.equal(version(),${sourceVersion}); assert.equal(permit(),0);
            return Response.json({seeded:true});
          }
          if(path==='/rollback') {
            const before=catalog(), records=data(), verify=AgentConnections.prototype.verifyHistory;
            let observed;
            AgentConnections.prototype.verifyHistory=()=>{observed={version:version(),permit:permit()};throw new Error('synthetic failure');};
            try{assert.throws(current,{code:'connection_integrity_error'});}finally{AgentConnections.prototype.verifyHistory=verify;}
            assert.deepEqual(observed,{version:14,permit:14},'fault occurs after installing the new writer');
            assert.equal(version(),${sourceVersion});assert.equal(permit(),0);assert.deepEqual(catalog(),before);assert.deepEqual(data(),records);assert.equal(oldWrite().changes,1);
            return Response.json({rolledBack:true});
          }
          if(path==='/corrupt') {
            sql.exec('DROP TRIGGER writer_v${sourceVersion}_accounts_update'); const before=catalog();
            assert.throws(current,/reconciliation/);assert.equal(version(),${sourceVersion});assert.deepEqual(catalog(),before);assert.equal(permit(),0);
            return Response.json({rejected:true});
          }
          if(path==='/upgrade') {
            const before=data(), store=current(); assert.equal(version(),14);assert.equal(permit(),0);assert.deepEqual(data(),before);
            assert.throws(oldWrite,/reconciliation/); assert.throws(()=>new OldStore(null,{database:new OldDatabase(this.ctx.storage),storagePlatform:oldStorage}),/newer than this service/);
            assert.equal(store.readTransaction(()=>permit()),0);assert.throws(()=>store.readTransaction(()=>store.createAccount('forbidden')),/read-only/);
            assert.equal(store.db.prepare("UPDATE accounts SET revision=revision WHERE id='missing'").run().changes,0);
            const token=randomBytes(32).toString('base64url'), details={action:'create',requestId:'worker-enrollment',memberId:'worker-agent',displayName:'Worker agent',access:'chat',keyHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+3600000,expectedOwnerRevision:0};
            const result=store.agentConnections.apply(f.token,'commons',details,f.session.sessionBinding);
            assert.equal(store.authenticate(token).member.id,'worker-agent');assert.equal(store.agentConnections.apply(f.token,'commons',details,f.session.sessionBinding).duplicate,true);
            const disconnect={action:'disconnect',requestId:'worker-disconnect',memberId:'worker-agent',expectedOwnerRevision:0,expectedMemberRevision:0,expectedGeneration:1};
            store.agentConnections.apply(f.token,'commons',disconnect,f.session.sessionBinding);assert.throws(()=>store.authenticate(token));
            const charterCommand={id:'worker-charter',type:'room.charter_updated',data:{expectedRevision:store.room('commons').state.room.charter?.revision??0,purpose:'Exact Workers instructions 🪷',outputs:'A reviewed result',boundaries:'No external actions',escalation:'Ask the owner'}};
            const charterSaved=store.command(f.token,'commons',charterCommand,f.session.sessionBinding);
            assert.equal(store.charter(f.token,'commons',{expectedSessionBinding:f.session.sessionBinding}).charter.purpose,charterCommand.data.purpose);
            assert.equal(auditRecovery(store).checks.agentConnections,true);assert.equal(permit(),0);
            const cursors=store.db.prepare('SELECT * FROM cursors ORDER BY room_id,member_id').all();
            const question={id:'worker-question',type:'message.posted',data:{messageId:'worker-question-message',body:'Can you confirm the instructions?',requestKind:'reply',toMemberId:'agent'}};
            const asked=store.command(f.token,'commons',question,f.session.sessionBinding);
            const answer={id:'worker-answer',type:'message.posted',data:{messageId:'worker-answer-message',body:'Confirmed — exact answer.',
              responseToRequestId:question.data.messageId,expectedRequestRevision:0,responseOutcome:'answered',contextEventId:asked.event.id,contextSequence:asked.sequence,
              replyToId:question.data.messageId,toMemberId:'owner',workItemId:null}};
            const answered=store.command(this.env.AGENT,'commons',answer);
            assert.equal(store.room('commons').state.replyRequests[question.data.messageId].terminalActorId,'agent');
            for (const command of [
              {id:'help-work',type:'work.proposed',data:{workItemId:'help-task',title:'Agenda',definitionOfDone:'Two items',accountableMemberId:'owner'}},
              {id:'help-accept',type:'work.accepted',data:{workItemId:'help-task',expectedRevision:0}}
            ]) store.command(f.token,'commons',command,f.session.sessionBinding);
            const helpCommand={id:'help-open',type:'work.help_updated',data:{workItemId:'help-task',expectedRevision:1,expectedHelpRevision:0,status:'open',scope:'Suggest two items 🪷',expiresAt:new Date(Date.now()+3600000).toISOString()}};
            const helpSaved=store.command(f.token,'commons',helpCommand,f.session.sessionBinding);
            const offerCommand={id:'offer-open',type:'work.help_offer_opened',data:{workItemId:'help-task',offerId:'worker-offer',expectedRevision:1,expectedHelpRevision:1,helpEventId:helpSaved.event.id,plan:'Suggest two agenda items'}};
            const offerSaved=store.command(this.env.AGENT,'commons',offerCommand);
            const selectCommand={id:'offer-select',type:'work.help_offer_updated',data:{workItemId:'help-task',offerId:'worker-offer',expectedRevision:1,expectedOfferRevision:0,status:'selected',reason:'Use these suggestions',expectedHelpRevision:1,helpEventId:helpSaved.event.id}};
            const selectSaved=store.command(f.token,'commons',selectCommand,f.session.sessionBinding);
            const helpWithdraw={id:'help-withdraw',type:'work.help_updated',data:{workItemId:'help-task',expectedRevision:1,expectedHelpRevision:1,status:'withdrawn'}};
            const helpClosed=store.command(f.token,'commons',helpWithdraw,f.session.sessionBinding);
            assert.equal(store.room('commons').state.helpOffers['worker-offer'].status,'selected');
            const releaseCommand={id:'offer-release',type:'work.help_offer_updated',data:{workItemId:'help-task',offerId:'worker-offer',expectedRevision:1,expectedOfferRevision:1,status:'released',reason:'End coordination only',externalActivityUnverified:true}};
            const releaseSaved=store.command(this.env.AGENT,'commons',releaseCommand);
            assert.equal(store.room('commons').state.workItems['help-task'].revision,1);
            return Response.json({upgraded:true,details,disconnect,receipt:result.receipt,charterCommand,charterSaved,question,asked,answer,answered,helpCommand,helpSaved,helpWithdraw,helpClosed,offerCommand,offerSaved,selectCommand,selectSaved,releaseCommand,releaseSaved,cursors,audit:auditRecovery(store)});
          }
          if(path==='/restart') {
            const proof=await request.json(),store=current();assert.equal(version(),14);assert.equal(permit(),0);
            assert.deepEqual(store.agentConnections.apply(f.token,'commons',proof.details,f.session.sessionBinding).receipt,proof.receipt);
            assert.equal(store.agentConnections.apply(f.token,'commons',proof.disconnect,f.session.sessionBinding).duplicate,true);
            assert.equal(store.agentConnections.list(f.token,'commons',f.session.sessionBinding).connections.find(c=>c.memberId==='worker-agent').status,'disconnected');
            assert.equal(store.command(f.token,'commons',proof.charterCommand,f.session.sessionBinding).event.id,proof.charterSaved.event.id);
            assert.equal(store.charter(f.token,'commons',{revision:proof.charterCommand.data.expectedRevision+1,expectedSessionBinding:f.session.sessionBinding}).charter.purpose,proof.charterCommand.data.purpose);
            assert.equal(store.command(f.token,'commons',proof.question,f.session.sessionBinding).event.id,proof.asked.event.id);
            assert.equal(store.command(this.env.AGENT,'commons',proof.answer).event.id,proof.answered.event.id);
            assert.equal(store.command(f.token,'commons',proof.helpCommand,f.session.sessionBinding).event.id,proof.helpSaved.event.id);
            assert.equal(store.command(f.token,'commons',proof.helpWithdraw,f.session.sessionBinding).event.id,proof.helpClosed.event.id);
            assert.equal(store.command(this.env.AGENT,'commons',proof.offerCommand).event.id,proof.offerSaved.event.id);
            assert.equal(store.command(f.token,'commons',proof.selectCommand,f.session.sessionBinding).event.id,proof.selectSaved.event.id);
            assert.equal(store.command(this.env.AGENT,'commons',proof.releaseCommand).event.id,proof.releaseSaved.event.id);
            assert.equal(store.room('commons').state.helpOffers['worker-offer'].status,'released');
            assert.equal(store.room('commons').state.workItems['help-task'].helpWanted.status,'withdrawn');
            assert.equal(store.room('commons').state.messages.find(m=>m.id===proof.answer.data.messageId).body,proof.answer.data.body);
            assert.deepEqual(store.db.prepare('SELECT * FROM cursors ORDER BY room_id,member_id').all(),proof.cursors);
            assert.deepEqual(auditRecovery(store),proof.audit);return Response.json({recovered:true});
          }
          return new Response(null,{status:404});
        }
      }
      export default {fetch(request,env){return env.ROOM.getByName(new URL(request.url).searchParams.get('case')??'main').fetch(request);}};
    `;
    const bundled = await build({ stdin: { contents: source, resolveDir: repository }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
    const config = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { ROOM: { className: 'UpgradeRoom', useSQLite: true } }, durableObjectsPersist: join(directory, 'persistence'),
      bindings: { TABLES: JSON.stringify(tables), ROWS: JSON.stringify(rows), OWNER: JSON.stringify(f.owner), AGENT: f.keys.agent } };
    mf = new Miniflare(config);
    const call = async (path, body) => { const response = await mf.dispatchFetch('http://localhost' + path, body ? { method: 'POST', body: JSON.stringify(body) } : {}); assert.equal(response.status,200,await response.clone().text());return response.json(); };
    await call('/seed'); assert.deepEqual(await call('/rollback'), { rolledBack: true }); const upgraded = await call('/upgrade');
    await call('/seed?case=corrupt'); assert.deepEqual(await call('/corrupt?case=corrupt'), { rejected: true });
    await mf.dispose(); mf = new Miniflare(config); assert.deepEqual(await call('/restart', upgraded), { recovered: true });
  } finally { if(mf)await mf.dispose();if(f)f.store.close();rmSync(directory,{recursive:true,force:true}); }
});
