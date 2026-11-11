import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {initialRecoveryReportRow,advanceRecoveryReportRow} from '../server/recovery-report-source.mjs';
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
function encode(db,id,max=4*1024*1024){let state=initialRecoveryReportRow(db,'input',id,max),text='',calls=0;for(;;){const result=advanceRecoveryReportRow(db,JSON.parse(JSON.stringify(state)));state=result.state;if(result.chunk!==null)text+=result.chunk;assert.ok(++calls<100000);if(result.last)return{text,calls};}}
test('streaming SQL scalar canonicalization is exact, including legal atoms, NUL, BOM, escaping and numeric formatting',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE input(z,a,n,b)');
 const cases=[['x','y',1,null],['🦉中é\u0000\ufeff\n\\"'.repeat(22000),'a',1e-7,null],['','',1e21,null],['{}','[]',-0,null]];
 for(const prefix of [2045,2046,2047])cases.push(['a'.repeat(prefix)+'🦉tail','split',1,null]);
 for(const [z,a,n,b]of cases){db.prepare('INSERT INTO input VALUES(?,?,?,?)').run(z,a,n,b);const id=db.prepare('SELECT max(rowid) n FROM input').get().n,row=db.prepare('SELECT * FROM input WHERE rowid=?').get(id);assert.equal(encode(db,id).text,canonical(row));}
});
test('Node BLOB numeric keys preserve JS lexicographic order without a full-byte indexed key',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE input(z,a,n,b)');for(const length of [0,1,9,10,11,99,100,101,256]){db.prepare('INSERT INTO input VALUES(?,?,?,?)').run('blob',null,1,Uint8Array.from({length},(_,i)=>i%256));const id=db.prepare('SELECT max(rowid) n FROM input').get().n;assert.equal(encode(db,id).text,canonical(db.prepare('SELECT * FROM input WHERE rowid=?').get(id)));}
});
test('source size, malformed continuation and missing addressed rows fail closed',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE input(z);INSERT INTO input VALUES('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')");assert.throws(()=>encode(db,1,0));let p=initialRecoveryReportRow(db,'input',1,100);assert.throws(()=>advanceRecoveryReportRow(db,{...p,extra:true}));db.exec('DELETE FROM input');assert.throws(()=>advanceRecoveryReportRow(db,p));
});
test('all signed SQLite rowids remain addressable without lossy JS integer conversion',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE input(z)');
 for(const id of ['-9223372036854775808','-9007199254740991','-1','0','9223372036854775807']){const insert=db.prepare('INSERT INTO input(rowid,z) VALUES(CAST(? AS INTEGER),?)');insert.setReadBigInts(true);insert.run(id,'value '+id);assert.equal(encode(db,id).text,canonical(db.prepare('SELECT * FROM input WHERE rowid=CAST(? AS INTEGER)').get(id)));}
});
