// Independent source/event-path regression using a minimal DOM double.
// This is not browser/visual evidence. No network or deletion request occurs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountSettingsUI} from '../src/account-settings-ui.js';

function fixture() {
  const doc = {activeElement: null};
  function node(tag) {
    return {tagName:tag, hidden:false, disabled:false, children:[], value:'',
      focus(){doc.activeElement=this},
      closest(selector){if(selector==='[hidden]') return this.hidden || this.inForm && form.hidden ? this : null; return null},
      getClientRects(){return this.hidden || this.inForm && form.hidden ? [] : [{}]},
      append(...children){this.children.push(...children)},
      replaceChildren(...children){this.children=children},
      set textContent(text){this.text=text;this.children=[]},
      get textContent(){return this.text??this.children.map(x=>x.textContent).join('')}
    };
  }
  doc.createElement=node;
  const summary=node('div'), blocked=node('div'), input=node('input'), submit=node('button'), cancel=node('button');
  input.name='confirmEmail'; input.inForm=submit.inForm=true;
  const form={hidden:true,elements:{confirmEmail:input},querySelector:()=>submit,reset(){input.value=''}};
  const dialog={open:false, showModal(){this.open=true}, close(){this.open=false},
    querySelector(selector){return ({'[data-deletion-summary]':summary,'[data-deletion-blocked]':blocked,
      'form[data-form="delete-account"]':form,"[data-action='delete-account-cancel']":cancel})[selector]??null},
    querySelectorAll(selector){
      const disclosure=summary.children.find(x=>x.tagName==='details')?.children[0];
      const elements=[disclosure,input,submit,cancel].filter(Boolean);
      const tags=selector.split(',').map(x=>x.trim());
      return elements.filter(x=>tags.includes(x.tagName));
    }
  };
  const listeners={};
  const container={innerHTML:'', addEventListener(name,fn){listeners[name]=fn},removeEventListener(){},contains(){return true},
    querySelector(selector){if(selector==='[data-deletion-dialog]')return dialog;if(selector==='form[data-form="delete-account"]')return form;return null;}};
  const client={currentSession(){return {}},async request(path){
    if(path==='/api/auth/methods')return {methods:[{type:'password',email:'test@example.invalid'}]};
    if(path==='/api/account/deletion/plan')return {confirmationToken:'fixture-only',summary:{text:'Full inventory'},plan:{rooms:{}}};
    throw new Error('Unexpected request: '+path);
  }};
  return {doc,dialog,container,client,listeners,summary,input,cancel,form};
}

async function opened(t){
  const f=fixture(), original=globalThis.document;globalThis.document=f.doc;
  t.after(()=>{if(original===undefined)delete globalThis.document;else globalThis.document=original});
  await createAccountSettingsUI({accountClient:f.client}).mount(f.container);
  await f.listeners.click({target:{closest(){return {dataset:{action:'delete-account'}}}}});
  assert.equal(f.doc.activeElement,f.input,'loading completion focuses email');
  assert.equal(f.summary.children.at(-1).children[0].tagName,'summary','new disclosure exists');
  return f;
}

test('Shift+Tab from email permits native focus onto Full deletion plan',async t=>{
  const f=await opened(t);let prevented=false;
  f.listeners.keydown({key:'Tab',shiftKey:true,preventDefault(){prevented=true}});
  assert.equal(prevented,false,'must not wrap past the preceding disclosure');
});

test('Tab from Cancel wraps to Full deletion plan as the first interactive control',async t=>{
  const f=await opened(t);f.cancel.focus();
  f.listeners.keydown({key:'Tab',shiftKey:false,preventDefault(){}});
  assert.equal(f.doc.activeElement?.tagName,'summary');
});

test('With no confirmation form, Tab from Cancel still reaches the disclosure',async t=>{
  const f=await opened(t);f.form.hidden=true;f.cancel.focus();
  f.listeners.keydown({key:'Tab',shiftKey:false,preventDefault(){}});
  assert.equal(f.doc.activeElement?.tagName,'summary');
});
