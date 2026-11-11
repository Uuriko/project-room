import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {uiText} from '../src/strings.js';
const source=readFileSync(process.env.ACCOUNT_ENROLLMENT_UI_SOURCE??new URL('../src/agent-connections.js',import.meta.url),'utf8');
function body(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>0&&b>a);return source.slice(a,b);}
const render=body('  function render() {','  function reset() {'),prepare=body('  async function prepare(','  if (dialog &&'),catalog=body('  function applyCatalogChoice(','  for (const button of catalogButtons())');
function fixture(unresolved=true){
 const c=vm.createContext({uiText,Date,crypto});
 vm.runInContext(`
  const nodes=new Map();const $=selector=>{if(!nodes.has(selector))nodes.set(selector,{disabled:false,hidden:false,value:selector.includes('name')?'Original':selector.includes('access')?'collaborate':'1',textContent:''});return nodes.get(selector);};
  let existingPending=${unresolved?'Object.freeze({requestId:"original-enrollment",identityId:"existing-agent"})':'null'},pending=null,setup=null,busy=false,copying=false,rosterId=null;
  let prepared=0,submitted=0;const owner={},generation=1,flow=1,owns=()=>true,allowed=()=>true,member=()=>({revision:0});
  const existingSelect={disabled:false,value:'original-choice'},existingButton={disabled:false,textContent:''};
  const fields=[existingSelect,$('#agent-connect-name'),$('#agent-connect-access'),$('#agent-connect-expiry')],rowButton={disabled:false},catalogButton={disabled:false};
  const form={hidden:false,querySelectorAll:()=>fields},list={querySelectorAll:()=>[rowButton]},catalogButtons=()=>[catalogButton];
  const constrainAccess=()=>{},describeImport=()=>{},describeRoute=()=>{},status=()=>{},syncAgentPaths=()=>{},existingFirst=()=>false,separateAgent={open:false};
  const newToken=()=>{prepared++;return 'synthetic-target-only';},digest=async()=> 'f'.repeat(64),submit=async()=>{submitted++;};
  const catalogSelection=()=>({name:'Replacement',access:'chat',route:'other',agentType:'other'}),rosterSelection=()=>null;
  ${render}\n${prepare}\n${catalog}
  globalThis.paint=render;globalThis.prepare=prepare;globalThis.choose=applyCatalogChoice;
  globalThis.state=()=>({fields,rowButton,catalogButton,existingButton,nodes,prepared,submitted,pending,existingPending,existingSelect});
 `,c);
 return c;
}

test('unconfirmed enrollment locks every unrelated control without disabling exact enrollment retry',()=>{
 const c=fixture();c.paint();const s=c.state();
 assert.ok(s.fields.every(field=>field.disabled),'the shared form loop must not re-enable the existing identity selector');
 assert.equal(s.existingSelect.value,'original-choice');assert.equal(s.existingButton.disabled,false);assert.match(s.existingButton.textContent,/Retry original/);
 for(const id of ['#agent-create','#agent-create-later','#agent-connect-done','#agent-retry'])assert.equal(s.nodes.get(id).disabled,true,id);
 assert.equal(s.rowButton.disabled,true);assert.equal(s.catalogButton.disabled,true);
});
for(const action of ['create','rotate','disconnect'])test(`direct ${action} handler cannot mutate while enrollment is unconfirmed`,async()=>{
 const c=fixture();await c.prepare(action,{memberId:'other',generation:1,memberRevision:0});const s=c.state();
 assert.equal(s.prepared,0);assert.equal(s.submitted,0);assert.equal(s.pending,null);assert.equal(s.existingPending.requestId,'original-enrollment');
});
test('direct catalog selection cannot switch to a replacement while enrollment is unconfirmed',()=>{
 const c=fixture();c.choose('other');assert.equal(c.state().nodes.get('#agent-connect-name').value,'Original');assert.equal(c.state().nodes.get('#agent-connect-access').value,'collaborate');assert.equal(c.state().existingSelect.value,'original-choice');
});
test('ordinary creation remains available when no enrollment is unresolved',async()=>{
 const c=fixture(false);c.paint();assert.equal(c.state().nodes.get('#agent-create').disabled,false);
 await c.prepare('create');assert.equal(c.state().prepared,1);assert.equal(c.state().submitted,1);
});
