import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
import {thinWorkForContext} from '../server/current-work-summary.mjs';
import {currentResult} from '../src/work-selectors.js';
const app=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
let node;function visit(value){if(!value||typeof value!=='object')return;if(value.type==='FunctionDeclaration'&&value.id?.name==='resultRow')node=value;for(const child of Object.values(value))if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child);}
visit(parse(app,{ecmaVersion:'latest',sourceType:'module'}));
assert.ok(node);
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const render=vm.runInNewContext(app.slice(node.start,node.end)+';resultRow',{currentResult,esc,safeUrl:value=>value});
const full={id:'saved-task',title:'Useful result',state:'completed',updatedAt:'2026-11-02T00:00:00Z',independentVerificationRequired:false,ownerDecisionRequired:false,receipt:{eventId:'completion-event',evidenceVersion:'sha256:exact-result',summary:'Actual saved text',nativeText:true,evidenceUrl:null}};
test('actual compact native work receipt renders selected result control without summary or nativeText',()=>{
 const item=thinWorkForContext(full),before=structuredClone(item);assert.equal(item.receipt.summary,undefined);assert.equal(item.receipt.nativeText,undefined);assert.ok(currentResult(item));
 const html=render(item);assert.match(html,/Saved result/);assert.match(html,/data-read-result="saved-task"/);assert.doesNotMatch(html,/<a |undefined|null|External evidence/);assert.deepEqual(item,before);assert.equal(item.receipt.eventId,full.receipt.eventId);assert.equal(item.receipt.evidenceVersion,full.receipt.evidenceVersion);
});
test('full text and external receipts preserve exact display and evidence behavior',()=>{
 assert.match(render(full),/Actual saved text/);assert.match(render(full),/data-read-result="saved-task"/);
 const external={...full,receipt:{...full.receipt,nativeText:false,evidenceUrl:'https://example.test/evidence'}};assert.match(render(external),/href="https:\/\/example.test\/evidence"/);assert.match(render(external),/Actual saved text/);
 const long={...full,receipt:{...full.receipt,summary:'😀'.repeat(201)}};assert.match(render(long),new RegExp('😀'.repeat(200)+'…'));assert.doesNotMatch(render(long),new RegExp('😀'.repeat(201)));
});

test('actual thin external result preserves safe evidence anchor instead of text-reader control',()=>{const external=thinWorkForContext({...full,receipt:{...full.receipt,nativeText:undefined,evidenceUrl:'https://example.test/proof'}}),html=render(external);assert.match(html,/href="https:\/\/example.test\/proof"/);assert.match(html,/External evidence/);assert.doesNotMatch(html,/data-read-result=/);});
