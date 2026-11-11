import assert from 'node:assert/strict';
import{RoomStore}from'../../server/store.mjs';
import{initialRoom}from'../../server/bootstrap.mjs';
import{event}from'../../src/events.js';
import{auditRecovery}from'../../server/recovery.mjs';
import*as c from'../../server/replay-cutover.mjs';
import{isDeepStrictEqual}from'node:util';
const emit=console.log;console.log=console.warn=console.error=()=>{};const s=new RoomStore(':memory:',{maintainMessageCertification:true});let report={};
try{
 s.initialize([...initialRoom(),event({id:'gap-post',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'gap-message',body:'Original'}}),event({id:'gap-delete',roomId:'commons',actorId:'owner',type:'message.deleted',data:{messageId:'gap-message',expectedMessageRevision:0}})]);
 while(!s.backfillMessages({limit:200}).done){}s.checkMessagesParity({roomId:'commons'});
 const before=s.room('commons').state;const replayBefore=s.rebuildProjection('commons').state;
 s.db.exec(c.replayCutoverSchema());const head=s.headSequence('commons');const capture=c.captureReplayWitness(s,{roomId:'commons',requestId:'gap-capture',expectedHead:head,reason:'Synthetic catalog continuity control'});
 const target=s.db.prepare("SELECT rowid AS catalog_id FROM sqlite_master WHERE name='replay_source_update'").get();
 const tuples=s.db.prepare('SELECT rowid AS catalog_id,type,name,tbl_name,sql FROM sqlite_master WHERE rowid>=? ORDER BY rowid').all(target.catalog_id);
 for(const row of [...tuples].reverse())s.db.exec('DROP '+row.type.toUpperCase()+' '+row.name);
 s.db.prepare("UPDATE events SET body=json_set(body,'$.data.body','Corrupt!') WHERE room_id='commons' AND sequence=3").run();
 for(const row of tuples)s.db.exec(row.sql);
 const restored=s.db.prepare('SELECT rowid AS catalog_id,type,name,tbl_name,sql FROM sqlite_master WHERE rowid>=? ORDER BY rowid').all(target.catalog_id);
 report={sameCatalogTuples:isDeepStrictEqual(restored,tuples),sourceEpoch:s.db.prepare("SELECT row_version FROM message_replay_units WHERE domain='control' AND unit_key='epoch'").get().row_version,head};
 let hash={bytes:0};for(let i=0;hash.phase!=='witness_verified';i++)hash=c.advanceReplayWitness(s,{roomId:'commons',generation:capture.generation,expectedBytes:hash.bytes,requestId:'gap-hash-'+i});
 let codec={bytes:0};for(let i=0;codec.phase!=='codec_partitioned';i++)codec=c.partitionReplayWitness(s,{roomId:'commons',generation:capture.generation,expectedBytes:codec.bytes,requestId:'gap-codec-'+i});
 report.hashPhase=hash.phase;report.codecPhase=codec.phase;report.certified=codec.certified;
 report.currentServingUnchanged=isDeepStrictEqual(s.room('commons').state,before);
 report.replayedStateUnchanged=isDeepStrictEqual(s.rebuildProjection('commons').state,replayBefore);
 try{auditRecovery(s);report.existingRecoveryAccepted=true;}catch(e){report.existingRecoveryAccepted=false;report.recoveryFailure=e.message;}
}catch(e){report.stageFailure=e.message;}finally{s.close();}
emit(JSON.stringify(report));

assert.equal(report.sameCatalogTuples, true);
assert.equal(report.currentServingUnchanged, true);
assert.equal(report.replayedStateUnchanged, true);
assert.equal(report.existingRecoveryAccepted, false, 'RED: recovery must not accept an unanchored journal whose hidden historical event changed during an indistinguishable trigger gap');
