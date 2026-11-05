import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {parse} from 'yaml';
test('both normal deployment shell steps pass deferred60s as one argument and retain smoke grace',()=>{
 const job=parse(readFileSync(new URL('../.github/workflows/deploy-prod.yml',import.meta.url),'utf8')).jobs.deploy;
 const dir=mkdtempSync(join(tmpdir(),'adoption-argv-'));try{
 mkdirSync(join(dir,'bin'));writeFileSync(join(dir,'bin/pnpm'),`#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(process.env.ARGV_LOG,JSON.stringify(process.argv.slice(2))+'\\n');console.log('Current Version ID: 11111111-1111-4111-8111-111111111111');`,{mode:0o755});
 for(const id of ['prod','entry']) execFileSync('/bin/bash',['-c',job.steps.find(s=>s.id===id).run],{env:{PATH:join(dir,'bin')+':/usr/bin:/bin',RUNNER_TEMP:dir,GITHUB_OUTPUT:join(dir,'output'),ARGV_LOG:join(dir,'argv')},stdio:'pipe'});
 const calls=readFileSync(join(dir,'argv'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);
 for(const a of calls){assert.deepEqual(a.slice(0,3),['exec','wrangler','deploy']);assert.equal(a[a.indexOf('--durable-objects-code-update-mode')+1],'deferred 60s');assert.ok(a.includes('--keep-vars'));}
 assert.equal(calls[0][calls[0].indexOf('--env')+1],'production');assert.ok(!calls[1].includes('--env'));
 assert.match(job.steps.find(s=>s.id==='smoke').run,/--wait-ms 420000/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
