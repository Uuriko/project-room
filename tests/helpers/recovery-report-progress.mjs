// Test-only completion bound, computed from the actual independent T0 row
// oracle. Never a production admission, benchmark or extra runtime scan.
import {applicationTables} from '../../server/writer-fence.mjs';
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const frontier=r=>JSON.stringify(r?{stage:r.stage,table:r.tableIndex,after:r.rowAfter,source:r.source?{row:r.source.rowid,column:r.source.column,phase:r.source.phase,offset:r.source.offset,blob:r.source.blobIndex,output:r.source.output.length,carry:r.source.carry}:null,sort:r.table}:null);
export function reportProgressGuard(store,assert){
 let budget=null,reportCalls=0,preReportCalls=0,publicationCalls=0,sourceUnits=0,sortUnits=0;
 return{before(state){
  const audit=state.progress?.audit,report=audit?.report;
  if(audit?.stage==='full_audit_pending'&&report===null&&budget===null){
   // A source cell type probe plus scalar fetch costs at most2 units; TEXT
   // needs one read per2048bytes, Node byte objects at most one read perbyte.
   // Every row/chunk/table transition is separately counted. Two-way merge
   // has <=n*ceil(log2(n)) comparisons/outputs, each <=maxChunks+1 units.
   for(const table of applicationTables){const rows=(typeof store==='function'?store():store).db.prepare(`SELECT * FROM "${table}"`).all(),chunks=rows.map(row=>Math.max(1,Math.ceil(canonical(row).length/8192)));let rowUnits=0;
    for(const row of rows){rowUnits+=2+2*Object.keys(row).length;for(const value of Object.values(row)){if(typeof value==='string')rowUnits+=Math.ceil(Buffer.byteLength(value)/2048);else if(value instanceof Uint8Array)rowUnits+=value.byteLength;}}
    sourceUnits+=rowUnits+chunks.reduce((a,b)=>a+b,0)+2;sortUnits+=rows.length*Math.ceil(Math.log2(Math.max(1,rows.length)))*(Math.max(1,...chunks)+1)+chunks.reduce((a,b)=>a+b,0)+2;
   }
   budget=sourceUnits+sortUnits+64;
  }
  const kind=audit?.stage==='full_audit_pending'?(report?.stage==='complete'?'publication':'report'):'pre';
  return{kind,key:frontier(report)};
 },after(mark,state){
  if(mark.kind==='pre')preReportCalls++;else if(mark.kind==='publication')publicationCalls++;else{
   reportCalls++;assert.notEqual(frontier(state.progress?.audit?.report),mark.key,'report must advance an actual source/merge/hash frontier, not only revision/counters');assert.ok(reportCalls<=budget,'report calls exceed exact T0 source/chunk/merge work bound');
  }
 },summary(){return{preReportCalls,reportCalls,publicationCalls,reportCallBudget:budget,sourceUnits,sortUnits};}};
}
