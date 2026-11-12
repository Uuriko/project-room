import { draftRecoveryScope } from './conversation.js';
// Drafts use bounded tab storage keyed by authenticated account and room scope.
// Active requests additionally belong to the exact RoomClient session.
export function installRoomDocs({ client, getState, getSession }) {
  const open = document.querySelector('#room-docs-open'), dialog = document.querySelector('#room-docs-dialog');
  const root = document.querySelector('#room-docs-root'), navigation = document.querySelector('#room-docs-navigation');
  let owner = null, generation = 0, drafts = new Map(), current = null, next = null, docs = [];
  const recoveryKey='project-room:doc-drafts:v2';
  function records() { try { const raw=sessionStorage.getItem(recoveryKey);if(!raw)return {};if(raw.length>1100000){sessionStorage.removeItem(recoveryKey);return {}}const data=JSON.parse(raw);if(!data||typeof data!=="object"||Array.isArray(data)){sessionStorage.removeItem(recoveryKey);return {}}const valid=Object.fromEntries(Object.entries(data).filter(([,v])=>v&&Number.isFinite(v.expires)&&v.expires>Date.now()&&v.expires<=Date.now()+12*60*60*1000&&Array.isArray(v.entries)).slice(-20));if(Object.keys(valid).length!==Object.keys(data).length){if(Object.keys(valid).length)sessionStorage.setItem(recoveryKey,JSON.stringify(valid));else sessionStorage.removeItem(recoveryKey)}return valid; }catch{try{sessionStorage.removeItem(recoveryKey)}catch{}return {}} }
  function persist(s) {const scope=draftRecoveryScope(s);if(!scope||drafts.size>20)return false;try{const data=records();if(drafts.size&&!Object.hasOwn(data,scope)&&Object.keys(data).length>=20)return false;if(drafts.size)data[scope]={expires:Date.now()+12*60*60*1000,entries:[...drafts]};else delete data[scope];const value=JSON.stringify(data);if(value.length>1100000)return false;sessionStorage.setItem(recoveryKey,value);return true}catch{return false}}
  function recover(s) {const scope=draftRecoveryScope(s);if(!scope)return new Map();const entries=records()[scope]?.entries||[];return new Map(entries.filter(x=>Array.isArray(x)&&typeof x[0]==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(x[0])&&x[1]&&typeof x[1].title==='string'&&x[1].title.length<=200&&typeof x[1].body==='string'&&x[1].body.length<=50000&&Number.isSafeInteger(x[1].baseRev)&&x[1].baseRev>=0).slice(-20))}
  function clearRecovery(){try{sessionStorage.removeItem(recoveryKey);sessionStorage.removeItem('project-room:doc-drafts:v1')}catch{}}
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function owns(s) { return !!s && s === owner && s === getSession() && s === client.session && getState()?.room?.id === s.roomId && client.ownsAccountSession(); }
  function path(s, id = '') { return `/api/rooms/${encodeURIComponent(s.roomId)}/docs${id ? '/'+encodeURIComponent(id) : ''}`; }
  function render() {
    const d = current, draft = d && drafts.get(d.docId);
    const shownDocs=[...docs,...[...drafts].filter(([id,entry])=>entry.baseRev===0&&!docs.some(x=>x.docId===id)).map(([docId,entry])=>({docId,title:entry.title||'Untitled draft'}))];
    root.innerHTML = `<div class="dialog-actions"><button type="button" data-new>New document</button></div><p role="status" data-status></p><nav aria-label="Documents">${shownDocs.map(x=>`<button type="button" data-doc="${esc(x.docId)}">${esc(x.title)}</button>`).join(' ')}</nav>${next ? '<button type="button" data-more>Load more documents</button>' : ''}<section data-content>${d ? `<h3>${esc(d.title)}</h3><p>Revision ${d.rev}</p><pre class="room-docs-text">${esc(d.body)}</pre><button type="button" data-edit>Edit</button><div data-editor ${draft ? '' : 'hidden'}><label>Title <input data-title maxlength="200" value="${esc(draft?.title ?? d.title)}"></label><label>Markdown <textarea data-body maxlength="50000">${esc(draft?.body ?? d.body)}</textarea></label><p>Unsaved changes are kept in this tab when draft recovery is available.</p><button type="button" data-save>Save</button><p role="status" data-save-status></p><div data-conflict></div></div>` : '<p>Select a document or create one.</p>'}</section>`;
  }
  async function list(s, after = '') {
    const ticket = generation;
    try { const page = await client.request(path(s)+`?limit=100${after ? '&after='+encodeURIComponent(after) : ''}`, {fresh:true});
      if (!owns(s) || ticket !== generation) return;
      if (!Array.isArray(page.docs) || (page.hasMore && !page.nextAfter)) throw Error('Incomplete document list');
      docs = after ? [...docs, ...page.docs] : page.docs; next = page.hasMore ? page.nextAfter : null; render();
    } catch(e) { if (owns(s) && ticket === generation) root.querySelector('[data-status]').textContent = `Could not load documents: ${e.message}`; }
  }
  async function read(s, id) {
    const ticket = ++generation;
    try { const result = await client.request(path(s,id), {fresh:true}); if (!owns(s) || ticket !== generation) return; current=result.doc; render(); }
    catch(e) { if (owns(s) && ticket === generation) root.querySelector('[data-status]').textContent = `Could not open document: ${e.message}`; }
  }
  open.addEventListener('click', () => {
    const s = getSession(); if (!s || !getState() || s !== client.session || !client.ownsAccountSession()) return;
    if (owner !== s) { owner=s; drafts=recover(s); current=null; docs=[]; next=null; }
    ++generation; render(); if (!dialog.open) dialog.showModal(); void list(s);
  });
  function reset({clear=false}={}){generation++;if(clear)clearRecovery();owner=null;drafts.clear();current=null;docs=[];next=null;root.replaceChildren();navigation.hidden=true;if(dialog.open)dialog.close();}
  async function sync(){const s=getSession(),ticket=client.generation;if(!s||s!==client.session||getState()?.room?.id!==s.roomId){navigation.hidden=true;return;}try{await client.request(path(s)+'?limit=1',{fresh:true});if(getSession()===s&&client.session===s&&client.generation===ticket)navigation.hidden=false;}catch{if(getSession()===s&&client.generation===ticket)navigation.hidden=true;}}
  document.querySelector('#room-docs-close').addEventListener('click',()=>dialog.close());
  root.addEventListener('input', e => {
    const s=owner,d=current;if(!owns(s)||!d||!e.target.matches('[data-title],[data-body]'))return;
    const old=drafts.get(d.docId);drafts.set(d.docId,{title:root.querySelector('[data-title]').value,body:root.querySelector('[data-body]').value,baseRev:old?.baseRev??d.rev});if(!persist(s))root.querySelector('[data-save-status]').textContent='Draft recovery unavailable; save before leaving.';
  });
  root.addEventListener('click', async e => {
    const s=owner;if(!owns(s))return;
    if(e.target.closest('[data-more]')) { await list(s,next); return; }
    const doc=e.target.closest('[data-doc]');if(doc){const entry=drafts.get(doc.dataset.doc);if(entry?.baseRev===0){current={docId:doc.dataset.doc,title:entry.title||'Untitled draft',body:'',rev:0};render();return;}await read(s,doc.dataset.doc);return;}
    if(e.target.closest('[data-new]')){const id='doc-'+crypto.randomUUID();current={docId:id,title:'New document',body:'',rev:0};drafts.set(id,{title:'',body:'',baseRev:0});const recovered=persist(s);render();if(!recovered)root.querySelector('[data-save-status]').textContent='Draft recovery unavailable; save before leaving.';root.querySelector('[data-title]').focus();return;}
    if(e.target.closest('[data-edit]')){root.querySelector('[data-editor]').hidden=false;root.querySelector('[data-body]').focus();return;}
    if(!e.target.closest('[data-save]')||!current)return;
    const d=current, submitted=drafts.get(d.docId)??{title:root.querySelector('[data-title]').value,body:root.querySelector('[data-body]').value,baseRev:d.rev};drafts.set(d.docId,submitted);
    const button=e.target.closest('[data-save]'), status=root.querySelector('[data-save-status]'), editor=root.querySelector('[data-editor]');button.disabled=true;for(const f of editor.querySelectorAll('input,textarea'))f.disabled=true;status.textContent='Saving…';
    try { const result=await client.request(path(s,d.docId),{method:'POST',data:submitted});if(!owns(s))return;if(drafts.get(d.docId)===submitted){drafts.delete(d.docId);persist(s);}if(!button.isConnected)return;current=result.doc;render();await list(s);if(owns(s) && current?.docId===d.docId)root.querySelector('[data-status]').textContent='Saved.'; }
    catch(error){if(!owns(s)||!button.isConnected)return;if(error.status===409){status.textContent='This document changed. Your draft is preserved; compare it with the current version before retrying.';try{const latest=(await client.request(path(s,d.docId),{fresh:true})).doc;if(!owns(s)||!button.isConnected)return;const box=root.querySelector('[data-conflict]');box.innerHTML=`<p>Current revision ${latest.rev}</p><pre class="room-docs-text">${esc(latest.body)}</pre><button type="button" data-use-latest>Use this revision as base</button>`;box.querySelector('[data-use-latest]').onclick=()=>{const old=drafts.get(d.docId);if(old){drafts.set(d.docId,{...old,baseRev:latest.rev});persist(s);status.textContent='Saving will replace the current text with your draft.';box.innerHTML='';}};}catch{status.textContent+=' Could not load the current version.';}}else status.textContent=`Could not save. Your draft is preserved. ${error.message}`;}
    finally{if(button.isConnected){button.disabled=false;for(const f of editor.querySelectorAll('input,textarea'))f.disabled=false;}}
  });
  return { reset, sync };
}
