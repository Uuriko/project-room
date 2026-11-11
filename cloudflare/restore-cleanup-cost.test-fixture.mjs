// Disposable synthetic qualification only; never a production entrypoint.
import {restoreProgress} from '../server/restore-admission.mjs';
import {messageProofMatches} from '../server/write-integrity.mjs';
import entry,{DurableCoverageRoom as Base} from './durable-coverage-native.test-fixture.mjs';
export class DurableCoverageRoom extends Base {
  constructor(ctx,env){
    const boot=[],nativeExec=ctx.storage.sql.exec.bind(ctx.storage.sql);
    ctx.storage.sql.exec=(sql,...params)=>{const cursor=nativeExec(sql,...params),r={sql,cursor,materializedBytes:0};boot.push(r);const charge=row=>{r.materializedBytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength;};return new Proxy(cursor,{get(target,key){if(key==='toArray')return()=>{const rows=target.toArray();for(const row of rows)charge(row);return rows;};if(key===Symbol.iterator)return function*(){for(const row of target){charge(row);yield row;}};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
    super(ctx,env);ctx.storage.sql.exec=nativeExec;this.constructorCost={statements:boot.length,rowsRead:0,rowsWritten:0,materializedBytes:0,unknown:0};for(const r of boot){try{const reads=r.cursor.rowsRead,writes=r.cursor.rowsWritten;if(!Number.isSafeInteger(reads)||!Number.isSafeInteger(writes))throw Error('Unknown constructor cursor counters');this.constructorCost.rowsRead+=reads;this.constructorCost.rowsWritten+=writes;}catch{this.constructorCost.unknown++;}this.constructorCost.materializedBytes+=r.materializedBytes;}this.samples=[];this.active=null;this.phase='finalization';
    const readTransaction=this.store.readTransaction.bind(this.store);
    this.store.readTransaction=operation=>{
      const previous=this.phase;
      if(new Error().stack.includes('auditRecovery'))this.phase='auditRecovery';
      try{return readTransaction(operation);}finally{this.phase=previous;}
    };
    const exec=ctx.storage.sql.exec.bind(ctx.storage.sql);
    ctx.storage.sql.exec=(sql,...params)=>{
      const cursor=exec(sql,...params),sample=this.active;
      if(!sample)return cursor;
      const record={phase:this.phase,sql:sql.replace(/\s+/g,' ').trim(),stack:new Error().stack.split('\n').slice(2,18),cursor,materializedBytes:0,materializedRows:0};
      sample.records.push(record);
      const charge=row=>{record.materializedRows++;record.materializedBytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength;};
      return new Proxy(cursor,{get(target,key){
        if(key==='toArray')return()=>{const rows=target.toArray();for(const row of rows)charge(row);return rows;};
        if(key===Symbol.iterator)return function*(){for(const row of target) {charge(row);yield row;}};
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
    };
  }
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/__constructor-cost')return Response.json(this.constructorCost);
    if(path==='/__cleanup-state')return Response.json({frozen:this.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'restore_frozen_*'").get().n,cleanup:restoreProgress(this.store.db).latest?.cleanup});
    if(path==='/__new-message-proof')return Response.json({proved:messageProofMatches(this.store.db.prepare("SELECT * FROM messages WHERE room_id='commons' AND message_id='cleanup-useful'").get())});
    if(new URL(request.url).pathname==='/__audit-cost')return Response.json(this.samples);
    if(request.headers.get('x-measure-final')!=='1')return super.fetch(request);
    const sample={records:[]},started=performance.now(),db=this.store.db,exec=db.exec.bind(db),prepare=db.prepare.bind(db),fault=request.headers.get('x-cleanup-fault');this.active=sample;
    if(fault==='drop')db.exec=sql=>{const value=exec(sql);if(sql.startsWith('DROP TRIGGER restore_frozen_'))throw Error('Native cleanup after DROP fault');return value;};
    if(fault==='checkpoint')db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);if(sql.startsWith('UPDATE current_restore_admission SET latest_receipt='))statement.run=(...args)=>{run(...args);throw Error('Native cleanup after checkpoint fault');};return statement;};
    try{return await super.fetch(request);}
    finally{
      this.active=null;db.exec=exec;db.prepare=prepare;
      const groups=new Map();let unknown=0;
      for(const record of sample.records){let rowsRead,rowsWritten;
        try{rowsRead=record.cursor.rowsRead;rowsWritten=record.cursor.rowsWritten;}catch{}
        if(!Number.isSafeInteger(rowsRead)||!Number.isSafeInteger(rowsWritten))unknown++;
        const key=JSON.stringify([record.phase,record.sql,record.stack]);const group=groups.get(key)??{phase:record.phase,sql:record.sql,stack:record.stack,statements:0,rowsRead:0,rowsWritten:0,materializedBytes:0,materializedRows:0};
        group.statements++;group.rowsRead+=rowsRead??0;group.rowsWritten+=rowsWritten??0;group.materializedBytes+=record.materializedBytes;group.materializedRows+=record.materializedRows;groups.set(key,group);
      }
      this.samples.push({observedWallMs:performance.now()-started,unknown,groups:[...groups.values()]});
    }
  }
}
export default entry;
