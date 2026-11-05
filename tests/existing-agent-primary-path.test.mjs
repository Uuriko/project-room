import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/agent-connections.js',import.meta.url),'utf8');
const start=source.indexOf('  const existingFirst ='),end=source.indexOf('  const enrollmentKey =',start);assert.ok(start>0&&end>start);
function fixture({choices=1,pending=false,ordinaryPending=false,setup=false}={}){
 const context=vm.createContext({choices,pendingInput:pending,ordinaryPending,setupInput:setup});
 vm.runInContext(`
  function node(){return {hidden:false,open:false,parentElement:null,previousSibling:null,focusCount:0,children:[],tabIndex:0,
   append(child){child.parentElement=this;this.children.push(child);},before(child){child.parentElement=this.parentElement;},after(child){child.parentElement=this.parentElement;child.previousSibling=this;},
   contains:()=>false,setAttribute(key,value){this[key]=value;},focus(){this.focusCount++;}};}
  const form=node(),separateAgent=node(),separateSummary=node(),existingBox=node(),existingButton=node(),existingSelect=node(),ordinaryFields=node(),accessFields=node(),managedConnections=node(),accessHome=node(),manageHome=node();
  ordinaryFields.parentElement=form;separateAgent.parentElement=form;existingBox.parentElement=form;existingButton.parentElement=existingBox;
  accessHome.parentElement=ordinaryFields;manageHome.parentElement=ordinaryFields;accessFields.parentElement=ordinaryFields;accessFields.previousSibling=accessHome;managedConnections.parentElement=ordinaryFields;managedConnections.previousSibling=manageHome;
  let existingChoices=Array(choices).fill({}),existingPending=pendingInput?{requestId:'original'}:null,pending=ordinaryPending?{}:null,setup=setupInput?{}:null,busy=false;
  const document={activeElement:null};
  ${source.slice(start,end)}
  globalThis.sync=syncAgentPaths;globalThis.state=()=>({primary:existingFirst(),separateAgent,separateSummary,existingBox,existingButton,existingSelect,ordinaryFields,accessFields,managedConnections,form,accessHome,manageHome});
  globalThis.clearChoices=()=>{existingChoices=[];};globalThis.reveal=()=>{separateAgent.open=true;};
 `,context);return context;
}
test('eligible existing agent has primary access and separate-agent disclosure; access management stays reachable',()=>{
 const f=fixture();f.sync();const s=f.state();assert.equal(s.primary,true);assert.equal(s.existingBox.hidden,false);assert.equal(s.separateAgent.hidden,false);assert.equal(s.separateAgent.open,false);
 assert.equal(s.ordinaryFields.parentElement,s.separateAgent);assert.equal(s.accessFields.parentElement,s.existingBox);assert.equal(s.managedConnections.parentElement,s.form);
 f.reveal();f.sync();assert.equal(s.separateAgent.open,true,'explicit separate-agent reveal remains available');
});
test('no eligible existing choice retains the original first-agent layout',()=>{
 const f=fixture({choices:0});f.sync();const s=f.state();assert.equal(s.primary,false);assert.equal(s.existingBox.hidden,true);assert.equal(s.separateAgent.hidden,true);assert.equal(s.ordinaryFields.parentElement,s.form);
 assert.equal(s.accessFields.previousSibling,s.accessHome);assert.equal(s.managedConnections.previousSibling,s.manageHome);
});
test('pending exact enrollment remains primary even after its source choice disappears',()=>{
 const f=fixture({choices:0,pending:true});f.reveal();f.sync();const s=f.state();assert.equal(s.primary,true);assert.equal(s.existingBox.hidden,false);assert.equal(s.separateAgent.open,false);assert.equal(s.separateSummary['aria-disabled'],'true');assert.equal(s.separateSummary.tabIndex,-1);
});
test('ordinary pending creation and existing setup preserve their original recovery path',()=>{
 for(const state of [{ordinaryPending:true},{setup:true}]){const f=fixture(state);f.sync();assert.equal(f.state().primary,false);assert.equal(f.state().ordinaryFields.parentElement,f.state().form);}
});
test('losing all choices restores the same access and management elements without duplicate controls',()=>{
 const f=fixture();f.sync();const original=f.state();f.clearChoices();f.sync();const current=f.state();assert.equal(current.accessFields,original.accessFields);assert.equal(current.managedConnections,original.managedConnections);
 assert.equal(current.accessFields.previousSibling,current.accessHome);assert.equal(current.managedConnections.previousSibling,current.manageHome);assert.equal(current.ordinaryFields.parentElement,current.form);
});
