import { ProjectRoom } from './room.mjs';
import { DurableObject } from 'cloudflare:workers';
import { DurableDatabase } from './storage.mjs';
import { SqlCostScopes } from './sql-cost-scope.mjs';
export class SqlCostTestRoom extends DurableObject {
  async fetch() {
    const rows=[], scopes=new SqlCostScopes({emit: row=>rows.push(row)});
    const db=new DurableDatabase(this.ctx.storage,{observeStatement:scopes.observeStatement});
    // Isolate the accounting adapter from Room schema migration in this fixture.
    db.isTransaction=true;
    db.exec('CREATE TABLE IF NOT EXISTS costs(n INTEGER)');
    db.prepare('DELETE FROM costs').run();
    for(let n=0;n<100;n++)db.prepare('INSERT INTO costs VALUES(?)').run(n);
    scopes.flushUnattributed(); rows.length=0;
    await scopes.run('request','mcp',async()=>{
      db.prepare('SELECT n FROM costs WHERE n=99').get();
      await scopes.run('job','patrol',async()=>{db.prepare('SELECT n FROM costs WHERE n=0').get();});
      db.prepare('UPDATE costs SET n=101 WHERE n=99').run();
      try{db.prepare('SELECT * FROM private_missing_table').all();}catch{ /* observed failure */ }
    });
    return Response.json(rows);
  }
}
const diagnosticRows = [];
const originalInfo = console.info.bind(console);
console.info = (...args) => {
  try { const row = JSON.parse(args[0]); if (row.event === 'room.sql_cost') { diagnosticRows.push(row); return; } } catch { /* other log */ }
  originalInfo(...args);
};
export class WiredSqlCostRoom extends ProjectRoom {
  async exercise() {
    diagnosticRows.length = 0;
    const ready = this.probeStorage();
    const response = await this.fetch(new Request('https://room.example.test/api/version', {headers: {Host:'room.example.test', 'x-room-visitor-ip':'127.0.0.1'}}));
    const denied = await this.fetch(new Request('https://room.example.test/api/rooms/missing?view=work', {headers:{Host:'room.example.test', 'x-room-visitor-ip':'127.0.0.1', Authorization:'Bearer pri_'+'a'.repeat(43)}}));
    await this.runSlowJob('integrity');
    return { ready, status: response.status, deniedStatus: denied.status, rows: diagnosticRows };
  }
}
export default {fetch(request,env){
  if(new URL(request.url).pathname==='/wired') return env.WIRED.get(env.WIRED.idFromName('wired')).exercise().then(value=>Response.json(value));
  return env.ROOM.get(env.ROOM.idFromName('test')).fetch(request);
}};
