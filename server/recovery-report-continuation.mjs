import {initialReplayHash, advanceReplayHash, finishReplayHash, encodeReplayHash, decodeReplayHash} from './replay-sha256.mjs';

// Report-1 sort/hash component. The owner must freeze its logical input inventory
// before staging here (applicationTables includes the scratch table itself).
// Input is already canonical(row), split into fixed UTF-16 chunks. Source
// canonicalization/admission and the restore checkpoint transaction remain the
// owner’s responsibility; this helper does not establish either authority.
export const REPORT_CHUNK_UNITS = 8192;
const fail = () => { throw Error('Recovery report continuation requires reconciliation'); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const key = n => { if (!integer(n)) fail(); return String(n).padStart(16, '0'); };
const get = (s, table, domain, n, part = 0) => s.get('report', table, domain, key(n), part);
const set = (s, table, domain, n, value, part = 0) => s.set('report', table, domain, key(n), value, part);
function chunk(s, table, row, part) {
  const value = get(s, table, 'fingerprint-data', row, part);
  if (!value || Object.keys(value).sort().join(',') !== 'last,text' || typeof value.text !== 'string'
    || typeof value.last !== 'boolean' || value.text.length > REPORT_CHUNK_UNITS
    || (!value.last && value.text.length !== REPORT_CHUNK_UNITS)) fail();
  return value;
}
const CONTROL_KEYS = 'carry,comparePart,end,hash,hashPart,hashRow,left,output,part,pass,right,rows,stage,start,table,version,width';
function validate(p) {
  if (!p || p.version !== 1 || !['ingest','merge','hash','complete'].includes(p.stage)
    || Object.keys(p).sort().join(',') !== (p.stage === 'complete' ? CONTROL_KEYS.replace(',stage',',sha256,stage') : CONTROL_KEYS)
    || typeof p.table !== 'string' || !/^[a-z_][a-z_0-9]*$/.test(p.table)
    || !['rows','part','width','pass','start','left','right','end','output','comparePart','hashRow','hashPart'].every(k => integer(p[k]))
    || p.width < 1 || !Number.isInteger(Math.log2(p.width)) || ![0,1].includes(p.pass)
    || typeof p.carry !== 'string' || p.carry.length > 1
    || (p.carry && !/^[\ud800-\udbff]$/.test(p.carry))
    || p.hashRow > p.rows || JSON.stringify(p).length > 4096) fail();
  const hash=decodeReplayHash(p.hash);
  if(p.stage === 'ingest') {
    if(p.width !== 1 || p.pass !== 0 || p.carry !== '' || hash.bytes !== 0
      || ['start','left','right','end','output','comparePart','hashRow','hashPart'].some(k=>p[k] !== 0)) fail();
    return;
  }
  if(p.part !== 0)fail();
  if(p.stage === 'merge') {
    const middle=Math.min(p.start+p.width,p.rows);
    if(p.rows < 2 || p.width >= p.rows || p.start > p.rows
      || (p.start !== p.rows && p.start % (2*p.width) !== 0)
      || p.left < p.start || p.left > middle || p.right < middle || p.right > p.end
      || p.end !== Math.min(p.start+2*p.width,p.rows)
      || p.output !== p.left+p.right-middle
      || (p.comparePart > 0 && (p.left === middle || p.right === p.end))
      || p.hashRow !== 0 || p.hashPart !== 0 || p.carry !== '' || hash.bytes !== 1)fail();
  } else {
    if(p.width < Math.max(1,p.rows) || p.start !== 0 || p.left !== 0
      || p.output !== 0 || p.right !== Math.min(p.width,p.rows) || p.end !== p.rows
      || p.comparePart !== 0 || (p.hashRow === p.rows && (p.hashPart !== 0 || p.carry !== '')))fail();
    if(p.stage === 'complete' && (p.hashRow !== p.rows || p.sha256 !== finishReplayHash(hash)))fail();
  }
}
export function initialRecoveryReportTable(table) {
  const p = {version:1, table, stage:'ingest', rows:0, part:0, width:1, pass:0, start:0,
    left:0, right:0, end:0, output:0, comparePart:0, hashRow:0, hashPart:0, carry:'',
    hash:encodeReplayHash(initialReplayHash())};
  validate(p); return p;
}
// One source chunk per call: no full-row allocation or full-row indexed key.
export function appendRecoveryReportChunk(scratch, current, text, last) {
  validate(current); if (current.stage !== 'ingest' || typeof text !== 'string'
    || text.length > REPORT_CHUNK_UNITS || typeof last !== 'boolean'
    || (!last && text.length !== REPORT_CHUNK_UNITS) || scratch.remaining < (last ? 2 : 1)) fail();
  const p = structuredClone(current);
  set(scratch,p.table,'fingerprint-data',p.rows,{text,last},p.part);
  if (last) { set(scratch,p.table,'fingerprint-index0',p.rows,p.rows); p.rows++; p.part=0; }
  else p.part++;
  return p;
}
export function sealRecoveryReportTable(current) {
  validate(current); if (current.stage !== 'ingest' || current.part !== 0) fail();
  const p=structuredClone(current); p.stage=p.rows>1?'merge':'hash';
  p.right=Math.min(p.width,p.rows);p.end=Math.min(2*p.width,p.rows);
  p.hash=encodeReplayHash(advanceReplayHash(initialReplayHash(),new TextEncoder().encode('[')));
  return p;
}
function ref(s,p,index) {
  const n=get(s,p.table,`fingerprint-index${p.pass}`,index);
  if(!integer(n)||n>=p.rows)fail();return n;
}
function feed(p,text,budget=null) { budget?.charge(new TextEncoder().encode(text).length);p.hash=encodeReplayHash(advanceReplayHash(decodeReplayHash(p.hash),new TextEncoder().encode(text))); }
// Fixed fan-in two. Equal-prefix comparisons resume one bounded chunk at a
// time. Both index generations contain ONLY ordinals, never sortable payloads.
export function advanceRecoveryReportTable(scratch,current,{maxUnits=16,budget=null}={}) {
  validate(current);if(!Number.isInteger(maxUnits)||maxUnits<1||maxUnits>(budget?1024:16)||current.stage==='ingest')fail();
  const p=structuredClone(current);let units=0;
  while(units<maxUnits&&p.stage!=='complete') {
    if(budget&&!budget.canSortUnit())break;
    if(p.stage==='merge') {
      if(p.start>=p.rows) {
        p.pass=1-p.pass;p.width*=2;p.start=0;p.left=0;p.right=Math.min(p.width,p.rows);p.end=Math.min(2*p.width,p.rows);p.output=0;
        if(p.width>=p.rows)p.stage='hash';continue;
      }
      const middle=Math.min(p.start+p.width,p.rows);let chosen;
      if(p.left>=middle&&p.right>=p.end) {
        p.start=p.end;p.left=p.start;p.right=Math.min(p.start+p.width,p.rows);p.end=Math.min(p.start+2*p.width,p.rows);continue;
      }
      if(scratch.remaining<1)break;
      if(p.left>=middle)chosen='right';else if(p.right>=p.end)chosen='left';
      else {
        const a=chunk(scratch,p.table,ref(scratch,p,p.left),p.comparePart);
        const b=chunk(scratch,p.table,ref(scratch,p,p.right),p.comparePart);
        if(a.text===b.text&&!a.last&&!b.last){p.comparePart++;units++;budget?.unit();continue;}
        chosen=a.text<b.text||(a.text===b.text&&(a.last||!b.last))?'left':'right';
      }
      const selected=ref(scratch,p,p[chosen]);
      set(scratch,p.table,`fingerprint-index${1-p.pass}`,p.output++,selected);
      p[chosen]++;p.comparePart=0;units++;budget?.unit();
    } else {
      if(p.hashRow===p.rows){feed(p,']',budget);p.stage='complete';p.sha256=finishReplayHash(decodeReplayHash(p.hash));break;}
      const value=chunk(scratch,p.table,ref(scratch,p,p.hashRow),p.hashPart);units++;budget?.unit();
      let text=p.carry+value.text;p.carry='';
      const finalCode=text.charCodeAt(text.length-1);
      if(!value.last&&finalCode>=0xd800&&finalCode<=0xdbff){p.carry=text.slice(-1);text=text.slice(0,-1);}
      if(p.hashPart===0)feed(p,(p.hashRow?',':'')+'"',budget);
      feed(p,JSON.stringify(text).slice(1,-1),budget);
      if(value.last){feed(p,'"',budget);p.hashRow++;p.hashPart=0;}else p.hashPart++;
    }
  }
  validate(p);return {state:p,units};
}
export function recoveryReportTableResult(p) {
  validate(p);if(p.stage!=='complete'||!/^[a-f0-9]{64}$/.test(p.sha256))fail();
  return {table:p.table,rows:p.rows,sha256:p.sha256};
}

// Feed results in the existing applicationTables order. No table reordering.
export function initialRecoveryReportDigest() {
  return encodeReplayHash(advanceReplayHash(initialReplayHash(),new TextEncoder().encode('[')));
}
export function appendRecoveryReportDigest(hash, result, first) {
  if (!result || typeof result.table !== 'string' || !integer(result.rows) || !/^[a-f0-9]{64}$/.test(result.sha256) || typeof first !== 'boolean') fail();
  const text=(first?'':',')+'{"rows":'+result.rows+',"sha256":'+JSON.stringify(result.sha256)+',"table":'+JSON.stringify(result.table)+'}';
  return encodeReplayHash(advanceReplayHash(decodeReplayHash(hash),new TextEncoder().encode(text)));
}
export function finishRecoveryReportDigest(hash) {
  return finishReplayHash(advanceReplayHash(decodeReplayHash(hash),new TextEncoder().encode(']')));
}
