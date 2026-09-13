// Compact connection controls. The host supplies validated API responses and
// an owner key that becomes null immediately when account authority ends.
export function installMessagingConnections({list,status,api,ownerKey}) {
  let generation=0,busy=false;
  const current=(owner,turn)=>owner!==null && owner===ownerKey() && generation===turn;
  function reset() { generation++;busy=false;list.replaceChildren();status.textContent=''; }
  function render(connections,owner,turn) {
    const doc=list.ownerDocument;
    list.replaceChildren(...connections.map(c=>{
      const row=doc.createElement('div'),label=doc.createElement('p');
      const name=c.provider==='sms'?'SMS':'WhatsApp';
      label.textContent=name+(c.state==='active'?'':c.state==='disconnected'?' · Disconnected':' · Setup needed');
      row.append(label);
      if(c.state==='active') {
        const button=doc.createElement('button');button.type='button';button.className='text-button';
        button.textContent='Disconnect';button.setAttribute('aria-label',`Disconnect ${name}`);button.disabled=busy;
        button.addEventListener('click',()=>{if(current(owner,turn))disconnect(c);});row.append(button);
      }
      return row;
    }));
  }
  async function load() {
    if(busy)return;
    const owner=ownerKey(),turn=++generation;list.replaceChildren();status.textContent='';
    if(owner===null)return;
    try {const value=await api.twilioStatus();if(current(owner,turn))render(value.connections,owner,turn);}
    catch {if(current(owner,turn))status.textContent='Messaging status unavailable.';}
  }
  async function disconnect(connection) {
    const owner=ownerKey();if(owner===null||busy)return;
    const turn=++generation;busy=true;status.textContent='Disconnecting…';
    list.querySelectorAll('button').forEach(b=>{b.disabled=true;});
    let confirmed=false;
    try {
      await api.twilioDisconnect({connectionId:connection.connectionId,expectedRevision:connection.revision});
      if(!current(owner,turn))return;
      confirmed=true;
      // Do not leave a stale active control behind if the status refresh fails.
      list.replaceChildren();
      const value=await api.twilioStatus();if(current(owner,turn))render(value.connections,owner,turn);
    }catch {
      if(!current(owner,turn))return;
    }finally {
      if(current(owner,turn)) {
        busy=false;list.querySelectorAll('button').forEach(b=>{b.disabled=false;});
        status.textContent=confirmed?'Disconnected here. Saved messages remain.':'Action unconfirmed. Refresh before trying again.';
        if(!confirmed) {
          const refresh=list.ownerDocument.createElement('button');refresh.type='button';refresh.className='text-button';refresh.textContent='Refresh';
          refresh.setAttribute('aria-label','Refresh messaging connections');
          refresh.addEventListener('click',()=>{if(current(owner,turn))load();});
          list.replaceChildren(refresh);
        }
      }
    }
  }
  return {load,reset};
}
